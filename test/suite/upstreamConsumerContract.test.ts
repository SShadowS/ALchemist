import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';
import { buildCodeLenses, buildStepperText, IterationStepperDecoration } from '../../src/iteration/iterationCodeLensProvider';
import { findLoopAtCursor } from '../../src/iteration/iterationCommands';
import { pathsEqual, findEditorsForLoopSourceFile } from '../../src/iteration/iterationViewSync';
import { StatusBarManager } from '../../src/output/statusBar';

/**
 * Contract tests for EVERY consumer of iteration data against the UPSTREAM wire
 * shape (StefanMaron/BusinessCentral.AL.Runner#2056): integer-derived loop ids
 * ("0", "1"), absolute source paths, WhenWritingNull-omitted step fields, plus
 * the `closedBy` / `unsegmentable` tags. The existing per-consumer suites only
 * exercise the fork shape ("L0", relative paths, always-present arrays); this
 * file guards the seam that let the Iteration Table regress unnoticed.
 */
const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const ABS_LOOP = path.resolve(WS, 'Loop.al'); // upstream emits an absolute file path

// One dataset shaped exactly like normalizeExecuteResponse() output for a
// for-loop with a nested loop on pass 2 and a sibling unsegmentable loop.
function upstreamData(): IterationData[] {
  return [
    {
      loopId: '0', sourceFile: ABS_LOOP, loopLine: 9, loopEndLine: 12,
      parentLoopId: null, parentIteration: null, iterationCount: 3,
      closedBy: 'exit', unsegmentable: null,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'total', value: '1' }], messages: ['sum=1'], linesExecuted: [10, 11] },
        // messages + linesExecuted OMITTED — the upstream WhenWritingNull wire
        // drops empty fields; the store must coerce them to safe defaults.
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'total', value: '3' }] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'total', value: '6' }], messages: ['sum=6'], linesExecuted: [10, 11] },
      ],
    },
    {
      loopId: '1', sourceFile: ABS_LOOP, loopLine: 10, loopEndLine: 11,
      parentLoopId: '0', parentIteration: 2, iterationCount: 2,
      closedBy: null, unsegmentable: null,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'j', value: '1' }], messages: [], linesExecuted: [11] },
        { iteration: 2, capturedValues: [{ variableName: 'j', value: '2' }], messages: [], linesExecuted: [11] },
      ],
    },
    {
      // Unsegmentable loop: loaded and listed, but not navigable, and must be
      // skipped by every stepper/lens consumer without throwing.
      loopId: '2', sourceFile: ABS_LOOP, loopLine: 20, loopEndLine: 22,
      parentLoopId: null, parentIteration: null, iterationCount: 0,
      closedBy: null, unsegmentable: 'emptyBody',
      steps: [],
    },
  ] as unknown as IterationData[];
}

function loadedStore(): IterationStore {
  const store = new IterationStore();
  store.load(upstreamData(), WS);
  return store;
}

suite('Upstream consumer contract — IterationStore', () => {
  test('loads integer-derived ids; unsegmentable loop is listed but not navigable', () => {
    const store = loadedStore();
    assert.deepStrictEqual(store.getLoops().map(l => l.loopId), ['0', '1', '2']);
    assert.strictEqual(store.isNavigable('0'), true);
    assert.strictEqual(store.isNavigable('2'), false, 'zero-iteration loop is not navigable');
  });

  test('omitted step fields coerce to safe defaults (no undefined .size/.length)', () => {
    const step = loadedStore().getStep('0', 2); // messages + linesExecuted were omitted
    assert.strictEqual(step.capturedValues.get('i'), '2');
    assert.deepStrictEqual(step.messages, [], 'omitted messages -> []');
    assert.strictEqual(step.linesExecuted.size, 0, 'omitted linesExecuted -> empty Set');
  });

  test('changed-value detection across upstream iterations', () => {
    const changed = new Set(loadedStore().getChangedValues('0', 2));
    assert.ok(changed.has('i') && changed.has('total'), 'both vars changed from pass 1 to 2');
  });

  test('nested loop is attached to the correct parent iteration', () => {
    const store = loadedStore();
    assert.deepStrictEqual(store.getNestedLoops('0', 2).map(l => l.loopId), ['1']);
    assert.deepStrictEqual(store.getNestedLoops('0', 1).map(l => l.loopId), []);
  });
});

suite('Upstream consumer contract — CodeLens + stepper text', () => {
  test('buildCodeLenses emits stepper+Table lenses keyed by the integer loop id', () => {
    const lenses = buildCodeLenses(loadedStore(), ABS_LOOP);
    // Outer loop 0 (line 9) and nested loop 1 (line 10) both qualify (>=2); the
    // unsegmentable loop 2 is skipped.
    const forLoop0 = lenses.filter(l => (l.command?.arguments?.[0]) === '0');
    assert.ok(forLoop0.length >= 4, 'prev, counter, next, table for loop 0');
    for (const l of forLoop0) assert.strictEqual(l.range.start.line, 8, 'loopLine 9 -> 0-based line 8');
    const table = forLoop0.find(l => l.command?.command === 'alchemist.iterationTable');
    assert.ok(table, 'a Table lens exists for loop 0');
    assert.strictEqual(table!.command!.arguments![0], '0');
    // The unsegmentable loop never produces lenses.
    assert.ok(!lenses.some(l => l.command?.arguments?.[0] === '2'), 'unsegmentable loop produces no lenses');
  });

  test('buildStepperText: show-all then stepped', () => {
    const store = loadedStore();
    assert.strictEqual(buildStepperText(store, '0'), '\u27F3 All');
    store.setIteration('0', 2);
    assert.strictEqual(buildStepperText(store, '0'), '\u27F3 2/3');
  });
});

suite('Upstream consumer contract — stepper decoration', () => {
  function fakeEditor(fsPath: string, lineCount = 40): any {
    const calls: { type: any; ranges: any[] }[] = [];
    return {
      _calls: calls,
      document: {
        uri: { fsPath },
        lineCount,
        lineAt: (i: number) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } } }),
      },
      setDecorations: (type: any, ranges: any[]) => calls.push({ type, ranges }),
    };
  }

  test('refresh paints the stepper on the editor whose path matches the absolute sourceFile', () => {
    const store = loadedStore();
    const editor = fakeEditor(ABS_LOOP);
    const origVisible = vscode.window.visibleTextEditors;
    const origOnActive = (vscode.window as any).onDidChangeActiveTextEditor;
    const origOnDoc = (vscode.workspace as any).onDidChangeTextDocument;
    try {
      (vscode.window as any).visibleTextEditors = [editor];
      (vscode.window as any).onDidChangeActiveTextEditor = () => ({ dispose() {} });
      (vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} });
      const deco = new IterationStepperDecoration(store);
      deco.refresh();
      const painted = editor._calls.flatMap((c: any) => c.ranges);
      assert.ok(painted.length >= 1, 'stepper decoration painted on the matching editor');
      const onLoopLine = painted.find((d: any) => d.range.start.line === 8); // loopLine 9 -> line 8
      assert.ok(onLoopLine, 'stepper sits on the loop line');
      assert.ok(String(onLoopLine.renderOptions.after.contentText).includes('\u27F3'), 'shows the stepper glyph');
      deco.dispose();
    } finally {
      (vscode.window as any).visibleTextEditors = origVisible;
      (vscode.window as any).onDidChangeActiveTextEditor = origOnActive;
      (vscode.workspace as any).onDidChangeTextDocument = origOnDoc;
    }
  });
});

suite('Upstream consumer contract — cursor + path matching', () => {
  test('findLoopAtCursor picks the innermost loop by integer id', () => {
    const loops = loadedStore().getLoops();
    assert.strictEqual(findLoopAtCursor(loops, 10), '1', 'line 10 is inside the nested loop');
    assert.strictEqual(findLoopAtCursor(loops, 9), '0', 'line 9 is only inside the outer loop');
  });

  test('pathsEqual tolerates slash and drive-case differences against the absolute sourceFile', () => {
    assert.ok(pathsEqual(ABS_LOOP, ABS_LOOP.replace(/[\\/]/g, '\\')), 'backslash variant matches');
    assert.ok(pathsEqual(ABS_LOOP, ABS_LOOP.replace(/[\\/]/g, '/')), 'forward-slash variant matches');
    if (process.platform === 'win32') {
      assert.ok(pathsEqual(ABS_LOOP, ABS_LOOP.replace(/^C:/, 'c:')), 'drive-letter case tolerated');
    }
  });

  test('findEditorsForLoopSourceFile selects the editor showing the loop file', () => {
    const editors = [
      { document: { uri: { fsPath: ABS_LOOP } } },
      { document: { uri: { fsPath: path.resolve(WS, 'Other.al') } } },
    ];
    const found = findEditorsForLoopSourceFile(editors, ABS_LOOP);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].document.uri.fsPath, ABS_LOOP);
  });
});

suite('Upstream consumer contract — status bar stepper', () => {
  test('showIterationStepper reflects the current/total and wires the Table command', () => {
    const bar = new StatusBarManager();
    bar.showIterationStepper(2, 3);
    assert.strictEqual((bar as any).counterItem.text, '2/3');
    assert.strictEqual((bar as any).tableItem.command, 'alchemist.iterationTable');
    bar.showIterationStepper(0, 3); // show-all
    assert.strictEqual((bar as any).counterItem.text, 'All');
    bar.hideIterationStepper();
    assert.strictEqual((bar as any).counterItem.shown, false);
    bar.dispose();
  });
});
