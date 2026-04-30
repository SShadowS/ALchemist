import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { IterationStore } from '../../src/iteration/iterationStore';
import { buildCodeLenses, IterationStepperDecoration } from '../../src/iteration/iterationCodeLensProvider';
import { IterationData } from '../../src/iteration/types';

const WS = '/ws';
const DOC_TEST_AL = path.resolve(WS, 'src/Test.al');

function makeSingleLoop(): IterationData[] {
  return [{
    loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 10,
    parentLoopId: null, parentIteration: null, iterationCount: 5,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [3] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [3] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [3] },
      { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }], messages: [], linesExecuted: [3] },
      { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }], messages: [], linesExecuted: [3] },
    ],
  }];
}

suite('IterationCodeLensProvider', () => {
  test('returns lenses for loop with 2+ iterations', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.ok(lenses.length >= 3); // prev, next/info, showAll, table
  });

  test('returns no lenses when store is empty', () => {
    const store = new IterationStore();
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.strictEqual(lenses.length, 0);
  });

  test('returns no lenses for single-iteration loop', () => {
    const store = new IterationStore();
    store.load([{
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 1, loopEndLine: 3,
      parentLoopId: null, parentIteration: null, iterationCount: 1,
      steps: [{ iteration: 1, capturedValues: [], messages: [], linesExecuted: [1] }],
    }], WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.strictEqual(lenses.length, 0);
  });

  test('lens line matches loopLine (0-indexed)', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    // loopLine is 3 (1-based) → Range should use line 2 (0-based)
    for (const lens of lenses) {
      assert.strictEqual(lens.range.start.line, 2);
    }
  });

  test('lens title shows current iteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    store.setIteration('L0', 3);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const iterLens = titles.find((t: string) => t.includes('3') && t.includes('5'));
    assert.ok(iterLens, `Expected a lens showing "3 of 5", got: ${titles.join(', ')}`);
  });

  test('lens shows "All" when in showAll mode', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    store.showAll('L0');
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const allLens = titles.find((t: string) => t.includes('All'));
    assert.ok(allLens, `Expected a lens with "All", got: ${titles.join(', ')}`);
  });

  test('filters lenses by document path — matching file', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.ok(lenses.length >= 3);
  });

  test('filters lenses by document path — non-matching file', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, path.resolve(WS, 'src/Other.al'));
    assert.strictEqual(lenses.length, 0);
  });

  test('multiple loops from different files — only matching rendered', () => {
    const store = new IterationStore();
    const data: IterationData[] = [
      {
        loopId: 'L0', sourceFile: 'src/FileA.al', loopLine: 3, loopEndLine: 10,
        parentLoopId: null, parentIteration: null, iterationCount: 3,
        steps: [
          { iteration: 1, capturedValues: [], messages: [], linesExecuted: [3] },
          { iteration: 2, capturedValues: [], messages: [], linesExecuted: [3] },
          { iteration: 3, capturedValues: [], messages: [], linesExecuted: [3] },
        ],
      },
      {
        loopId: 'L1', sourceFile: 'src/FileB.al', loopLine: 5, loopEndLine: 8,
        parentLoopId: null, parentIteration: null, iterationCount: 2,
        steps: [
          { iteration: 1, capturedValues: [], messages: [], linesExecuted: [5] },
          { iteration: 2, capturedValues: [], messages: [], linesExecuted: [5] },
        ],
      },
    ];
    store.load(data, WS);
    const lensesA = buildCodeLenses(store, path.resolve(WS, 'src/FileA.al'));
    const lensesB = buildCodeLenses(store, path.resolve(WS, 'src/FileB.al'));
    assert.ok(lensesA.length > 0, 'Expected lenses for FileA');
    assert.ok(lensesB.length > 0, 'Expected lenses for FileB');
    assert.strictEqual(lensesA[0].range.start.line, 2);
    assert.strictEqual(lensesB[0].range.start.line, 4);
  });
});

suite('IterationStepperDecoration — refresh paints all visible editors', () => {
  function fakeEditor(fsPath: string, lineCount = 50): any {
    const calls: { type: any; ranges: any[] }[] = [];
    return {
      _calls: calls,
      document: {
        uri: { fsPath },
        lineCount,
        lineAt: (i: number) => ({
          range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
        }),
      },
      setDecorations: (type: any, ranges: any[]) => { calls.push({ type, ranges }); },
    };
  }

  test('refresh paints stepper decoration on every visible editor whose document matches a loop sourceFile', () => {
    // Plan E3 v0.5.7 regression: when iteration changes were dispatched
    // via the Iteration Table panel webview, refresh() used
    // activeTextEditor and silently skipped (active editor was the
    // panel, not a text editor). Now refresh paints every visible
    // editor whose document corresponds to a loop's source file.
    const store = new IterationStore();
    const data: IterationData[] = [{
      loopId: 'L0', sourceFile: 'src/Test.al',
      loopLine: 3, loopEndLine: 5,
      parentLoopId: null, parentIteration: null, iterationCount: 5,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [3] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [3] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [3] },
        { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }], messages: [], linesExecuted: [3] },
        { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }], messages: [], linesExecuted: [3] },
      ],
    }];
    store.load(data, WS);

    const matching = fakeEditor(path.resolve(WS, 'src/Test.al'));
    const otherFile = fakeEditor(path.resolve(WS, 'src/Other.al'));

    const origVisible = vscode.window.visibleTextEditors;
    const origActive = vscode.window.activeTextEditor;
    const origOnDidChangeActive = (vscode.window as any).onDidChangeActiveTextEditor;
    const origOnDidChangeDoc = (vscode.workspace as any).onDidChangeTextDocument;
    try {
      // Simulate the failure mode: webview is focused, no active text
      // editor — yet two text editors are still visible in split panes.
      (vscode.window as any).visibleTextEditors = [matching, otherFile];
      (vscode.window as any).activeTextEditor = undefined;
      // The unit-test vscode mock omits these event subscriptions;
      // stub them with no-ops so the constructor doesn't crash.
      (vscode.window as any).onDidChangeActiveTextEditor = () => ({ dispose() {} });
      (vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} });

      const stepper = new IterationStepperDecoration(store);
      stepper.refresh();

      // Matching editor must receive a non-empty stepper decoration call.
      const matchingNonEmpty = matching._calls.find(
        (c: any) => Array.isArray(c.ranges) && c.ranges.length > 0,
      );
      assert.ok(
        matchingNonEmpty,
        'matching editor (src/Test.al) must receive a stepper decoration even though activeTextEditor is undefined',
      );

      // Non-matching editor must receive an empty (cleared) call so
      // stale decorations don't accumulate.
      assert.ok(
        otherFile._calls.length > 0,
        'non-matching editor must still be visited (so refresh clears stale decorations)',
      );
      const otherFileLastCall = otherFile._calls[otherFile._calls.length - 1];
      assert.strictEqual(
        otherFileLastCall.ranges.length, 0,
        'non-matching editor must have an empty ranges array (no loop in this file)',
      );

      stepper.dispose();
    } finally {
      (vscode.window as any).visibleTextEditors = origVisible;
      (vscode.window as any).activeTextEditor = origActive;
      (vscode.window as any).onDidChangeActiveTextEditor = origOnDidChangeActive;
      (vscode.workspace as any).onDidChangeTextDocument = origOnDidChangeDoc;
    }
  });
});
