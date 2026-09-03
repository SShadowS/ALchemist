import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { IterationStore } from '../../src/iteration/iterationStore';
import { normalizeExecuteResponse } from '../../src/execution/upstreamExecuteNormalizer';
import { ExecutionResult } from '../../src/runner/outputParser';

/**
 * End-to-end proof that the UPSTREAM iterations wire (#2056) renders in real VS Code:
 * inline messages and per-iteration stepping values both paint as decorations.
 *
 * The fixture `protocol-v2-samples/upstream-execute-loop.json` is a REAL response from
 * the upstream runner build for `upstream-iter/Loop.Codeunit.al` (a `for i := 1 to 3`
 * loop with a `Message()` per pass), with the absolute bundle path rewritten to the bare
 * filename so it is portable. The test runs it through the same `normalizeExecuteResponse`
 * the engine uses, then drives the real DecorationManager against a real opened editor.
 */
const FIX = path.resolve(__dirname, '../../../test/fixtures');
const AL_FILE = path.join(FIX, 'upstream-iter', 'Loop.Codeunit.al');
const WORKSPACE = path.join(FIX, 'upstream-iter');
const RESPONSE = path.join(FIX, 'protocol-v2-samples', 'upstream-execute-loop.json');
const APP_ROOT = path.resolve(__dirname, '../../../');

// Loop.Codeunit.al: line 8 `for i := 1 to 3 do begin`, line 10 `Message('sum=' + ...)`.
const LOOP_LINE = 8;
const MESSAGE_LINE = 10;

function wrapEditor(real: any, calls: { type: any; ranges: any[] }[]): any {
  return {
    document: real.document,
    selection: real.selection,
    visibleRanges: real.visibleRanges,
    options: real.options,
    setDecorations: (type: any, ranges: any[]) => calls.push({ type, ranges }),
  };
}

suite('Integration — the upstream iterations wire renders in real VS Code', () => {
  test('a real upstream execute response paints inline messages and per-iteration values', async () => {
    const vscode = require('vscode');
    const raw = JSON.parse(fs.readFileSync(RESPONSE, 'utf8'));

    // The engine's normalizer: upstream shape -> IterationData + aggregate projections.
    const norm = normalizeExecuteResponse(raw);
    assert.strictEqual(norm.shape, 'upstream', 'fixture must be the upstream wire');
    assert.strictEqual(norm.iterations.length, 1, 'one loop');
    assert.strictEqual(norm.iterations[0].iterationCount, 3);
    assert.deepStrictEqual(norm.messages, ['sum=1', 'sum=3', 'sum=6']);

    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);
    const calls: { type: any; ranges: any[] }[] = [];
    const editor = wrapEditor(realEditor, calls);
    const dm = new DecorationManager(APP_ROOT);

    const messageType = (dm as any).messageDecorationType;
    const captureType = (dm as any).capturedValueDecorationType;
    assert.ok(messageType && captureType, 'decoration types exist');

    // 1. INLINE MESSAGES: applyResults(scratch) distributes messages across Message() calls.
    const result: ExecutionResult = {
      mode: 'scratch',
      tests: [],
      messages: norm.messages,
      stderrOutput: [],
      summary: undefined,
      coverage: [],
      exitCode: 0,
      durationMs: 1,
      capturedValues: norm.capturedValues,
      cached: false,
      iterations: norm.iterations,
    };
    dm.applyResults(editor, result, WORKSPACE);

    const msgDecos = calls.filter(c => c.type === messageType).flatMap(c => c.ranges);
    assert.ok(msgDecos.length > 0, 'expected an inline message decoration to be painted');
    const onMsgLine = msgDecos.find(d => d.range.start.line === MESSAGE_LINE - 1);
    assert.ok(onMsgLine, `expected a message decoration on line ${MESSAGE_LINE}`);
    assert.ok(
      String(onMsgLine.renderOptions.after.contentText).includes('sum='),
      `message decoration should carry the Message() text; got "${onMsgLine.renderOptions.after.contentText}"`,
    );

    // 2. ITERATIONS: load the store from the upstream-derived iterations and step to pass 2.
    const store = new IterationStore();
    store.load(norm.iterations, WORKSPACE);
    const loopId = store.getLoops()[0].loopId;
    assert.strictEqual(store.isNavigable(loopId), true);
    const step = store.setIteration(loopId, 2);
    assert.ok(step, 'pass 2 must resolve to a step');
    assert.strictEqual(step!.capturedValues.get('i'), '2', 'i is 2 in pass 2');
    assert.strictEqual(step!.capturedValues.get('total'), '3', 'total is 3 in pass 2');

    calls.length = 0;
    dm.applyIterationView(editor, step!, store.getChangedValues(loopId, 2), 0, { start: LOOP_LINE, end: LOOP_LINE });
    const capDecos = calls.filter(c => c.type === captureType).flatMap(c => c.ranges);
    const onLoopLine = capDecos.find(d => d.range.start.line === LOOP_LINE - 1);
    assert.ok(onLoopLine, `expected a per-iteration captured-value decoration on line ${LOOP_LINE}`);
    assert.ok(
      String(onLoopLine.renderOptions.after.contentText).includes('2'),
      `loop-variable decoration should show i = 2 for pass 2; got "${onLoopLine.renderOptions.after.contentText}"`,
    );
  });
});
