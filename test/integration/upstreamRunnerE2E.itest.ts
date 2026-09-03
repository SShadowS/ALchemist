import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { IterationStore } from '../../src/iteration/iterationStore';
import { ServerProcess } from '../../src/execution/serverProcess';
import { ServerExecutionEngine } from '../../src/execution/serverExecutionEngine';

/**
 * TRUE end-to-end: spawns the real upstream AL.Runner build (#2056), runs a loop
 * scratch bundle through the same ServerProcess -> ServerExecutionEngine.executeScratch
 * path the extension uses, then drives the real DecorationManager against a real editor.
 * Proves — without any manual clicking — that the upstream wire renders inline messages
 * and per-iteration stepping values in VS Code.
 *
 * Skips when the upstream binary is absent (e.g. CI), where the canned-wire
 * `upstreamIterationsRender.itest.ts` remains the portable guard.
 */
const UPSTREAM_RUNNER = 'U:/Git/AL.Runner-issue-2056/AlRunner/bin/Release/net8.0/al-runner.exe';
const APP_ROOT = path.resolve(__dirname, '../../../');

const LOOP_AL = `codeunit 50390 LoopScratch
{
    trigger OnRun()
    var
        i: Integer;
        total: Integer;
    begin
        total := 0;
        for i := 1 to 3 do begin
            total += i;
            Message('sum=' + Format(total));
        end;
    end;
}
`;

function wrapEditor(real: any, calls: { type: any; ranges: any[] }[]): any {
  return {
    document: real.document,
    selection: real.selection,
    visibleRanges: real.visibleRanges,
    options: real.options,
    setDecorations: (type: any, ranges: any[]) => calls.push({ type, ranges }),
  };
}

function lineOf(doc: any, needle: string): number {
  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.includes(needle)) { return i; } // 0-indexed
  }
  throw new Error(`line containing "${needle}" not found`);
}

suite('Integration — the real upstream runner renders inline in VS Code', function () {
  this.timeout(60000); // spawning AL.Runner + BC artifact load is slow the first time

  let bundleDir: string;
  let alFile: string;
  let engine: ServerExecutionEngine | undefined;

  suiteSetup(function () {
    if (!fs.existsSync(UPSTREAM_RUNNER)) { this.skip(); }
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-e2e-'));
    alFile = path.join(bundleDir, 'LoopScratch.al');
    fs.writeFileSync(alFile, LOOP_AL, 'utf8');
  });

  suiteTeardown(async () => {
    if (engine) { await engine.dispose(); }
    // Best-effort: on Windows the runner/editor can still hold the bundle handle
    // for a beat after dispose, so a lingering EPERM must not fail the suite.
    // The OS reclaims the temp dir regardless.
    if (bundleDir) {
      try {
        fs.rmSync(bundleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch { /* leave it for the OS temp sweep */ }
    }
  });

  test('executeScratch through the real runner paints messages and per-iteration values', async () => {
    const vscode = require('vscode');
    engine = new ServerExecutionEngine(new ServerProcess({ runnerPath: UPSTREAM_RUNNER }));

    const result = await engine.executeScratch({
      sourcePaths: [bundleDir],
      captureValues: true,
      iterationTracking: true,
    });

    // --- Wire: the live runner produced the tagged upstream shape. ---
    assert.strictEqual(result.mode, 'scratch');
    assert.strictEqual(result.exitCode, 0, `runner failed: ${result.stderrOutput?.join('\n')}`);
    assert.deepStrictEqual(result.messages, ['sum=1', 'sum=3', 'sum=6']);
    assert.ok(result.iterations && result.iterations.length === 1, 'one loop expected');
    assert.strictEqual(result.iterations![0].iterationCount, 3);

    // --- Render: real DecorationManager against a real editor. ---
    const doc = await vscode.workspace.openTextDocument(alFile);
    const realEditor = await vscode.window.showTextDocument(doc);
    const calls: { type: any; ranges: any[] }[] = [];
    const editor = wrapEditor(realEditor, calls);
    const dm = new DecorationManager(APP_ROOT);
    const messageType = (dm as any).messageDecorationType;
    const captureType = (dm as any).capturedValueDecorationType;

    dm.applyResults(editor, result, bundleDir);

    const msgLine = lineOf(doc, "Message('sum=");
    const msgDecos = calls.filter(c => c.type === messageType).flatMap(c => c.ranges);
    const onMsgLine = msgDecos.find(d => d.range.start.line === msgLine);
    assert.ok(onMsgLine, `expected an inline message decoration on the Message() line ${msgLine + 1}`);
    assert.ok(
      String(onMsgLine.renderOptions.after.contentText).includes('sum='),
      `message decoration should carry the Message() text; got "${onMsgLine.renderOptions.after.contentText}"`,
    );

    // --- Iterations: load the store and step to pass 2. ---
    const store = new IterationStore();
    store.load(result.iterations!, bundleDir);
    const loop = store.getLoops()[0];
    assert.strictEqual(store.isNavigable(loop.loopId), true);
    const step = store.setIteration(loop.loopId, 2);
    assert.ok(step, 'pass 2 must resolve to a step');
    assert.strictEqual(step!.capturedValues.get('i'), '2', 'i is 2 in pass 2');
    assert.strictEqual(step!.capturedValues.get('total'), '3', 'total is 3 in pass 2');

    calls.length = 0;
    dm.applyIterationView(editor, step!, store.getChangedValues(loop.loopId, 2), 0, {
      start: loop.loopLine,
      end: loop.loopEndLine,
    });
    const forLine = lineOf(doc, 'for i :=');
    const capDecos = calls.filter(c => c.type === captureType).flatMap(c => c.ranges);
    const onForLine = capDecos.find(d => d.range.start.line === forLine);
    assert.ok(onForLine, `expected a per-iteration captured-value decoration on the for line ${forLine + 1}`);
    assert.ok(
      String(onForLine.renderOptions.after.contentText).includes('2'),
      `loop-variable decoration should show i = 2 for pass 2; got "${onForLine.renderOptions.after.contentText}"`,
    );
  });
});
