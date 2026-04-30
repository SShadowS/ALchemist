import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { TestHooks } from '../../src/extension';
import type { ExecutionResult } from '../../src/runner/outputParser';

/**
 * End-to-end runtime smoke test.
 *
 * Drives the REAL extension through @vscode/test-electron against the user's
 * actual ALProject4 workspace + the local AL.Runner protocol-v2 fork build.
 *
 * Why we need this: every other test stops short of the full activation +
 * save-handler + engine-spawn + result-render path. The path-matcher bug fixed
 * earlier (findCoverageForFile dropping absolute fwd-slash paths) was invisible
 * to layer-tests because they used relative paths in fixtures. This test runs
 * the entire flow with the same wire-format the runtime sees, so the next
 * regression at any layer surfaces here.
 *
 * The test uses fixed absolute paths to the user's local project + fork
 * binary. On any other machine without those paths, it skips.
 */
const ALPROJECT4 = String.raw`C:\Users\SShadowS\Documents\AL\ALProject4`;
const CU1_PATH = path.join(ALPROJECT4, 'CU1.al');
const FORK_BINARY = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;

suite('Runtime smoke — full extension activation against real ALProject4', function () {
  // First runtests call compiles AL → can take 10-15s; allow generous slack.
  this.timeout(60_000);

  const haveProject = fs.existsSync(CU1_PATH);
  const haveFork = fs.existsSync(FORK_BINARY);

  if (!haveProject || !haveFork) {
    test.skip(`skipping runtime smoke: missing ${!haveProject ? CU1_PATH : ''} ${!haveFork ? FORK_BINARY : ''}`, () => {});
    return;
  }

  test('runNow → captures arrive with alSourceFile + coverageV2 + decorations populated', async () => {
    const vscode = require('vscode');

    // 1. Pin runner path BEFORE the extension activates so the engine spawns
    //    the fork binary, not the user's globally-installed v0.5.3 build.
    await vscode.workspace
      .getConfiguration('alchemist')
      .update('alRunnerPath', FORK_BINARY, vscode.ConfigurationTarget.Global);

    // 2. Activate the extension and pull the test seam.
    const ext = vscode.extensions.getExtension('SShadowSdk.al-chemist');
    assert.ok(ext, 'ALchemist extension must be registered (check publisher.name in package.json)');
    const hooks = (await ext.activate()) as TestHooks | undefined;
    assert.ok(hooks, 'activate() must return TestHooks (set ALCHEMIST_TEST_HOOKS=1 in runIntegrationTests.ts)');

    // 3. Wait for the AL.Runner engine to spawn. With alRunnerPath pinned
    //    above this resolves promptly (no NuGet install).
    await hooks.awaitEngineReady();

    // 4. Open CU1.al so `vscode.window.activeTextEditor` is set inside
    //    handleResult — without it, applyResults is skipped and the
    //    DecorationManager never receives captures.
    const doc = await vscode.workspace.openTextDocument(CU1_PATH);
    await vscode.window.showTextDocument(doc);

    // 5. Drive the engine directly. This skips the runNow / routeSave / save
    //    paths (which need a workspace folder mount and would force us into a
    //    dual-extension-host launchArgs setup). What we're verifying is the
    //    seam from runtests-result → handleResult → applyResults — the path
    //    where every prior bug stage lived.
    const result = await hooks.runTestsAndApply([ALPROJECT4]);

    // 7. Inspect the runtime data — this is where every prior bug stage lived.
    assert.strictEqual(result.exitCode, 0, `runner exited with non-zero (${result.exitCode})`);
    assert.ok(result.tests.length > 0, 'tests array must be non-empty');
    assert.strictEqual(result.tests[0].status, 'passed', 'TestProc must pass');

    const firstTest = result.tests[0] as { capturedValues?: { alSourceFile?: string; variableName: string; value: unknown }[] };
    const captures = firstTest.capturedValues ?? [];
    assert.ok(captures.length > 0, 'tests[0].capturedValues must be non-empty (E2.1 stage 1 regression check)');
    for (const cv of captures) {
      assert.ok(cv.alSourceFile, `every capture must carry alSourceFile (E2.1 stage 2 regression check); got ${JSON.stringify(cv)}`);
    }

    // 8. coverageV2 must include CU1.al with recorded hits.
    const coverageV2 = (result as ExecutionResult & { coverageV2?: { file: string; lines: { line: number; hits: number }[] }[] }).coverageV2 ?? [];
    assert.ok(coverageV2.length > 0, 'coverageV2 must be present from --server protocol v2');
    const cu1Coverage = coverageV2.find(fc => fc.file.toLowerCase().endsWith('cu1.al'));
    assert.ok(cu1Coverage, 'coverageV2 must include CU1.al');
    assert.ok(cu1Coverage.lines.some(l => l.hits > 0), 'CU1.al must have at least one covered line');

    // Plan E3 Group D: v2 summary must carry iteration data when
    // iterationTracking is requested. Without this, iterationStore
    // stays empty and the CodeLens stepper / table view silently
    // degrade — exactly the regression that v2 introduced in
    // Plan E1/E2. The fork binary at FORK_BINARY must be from a
    // checkout including AL.Runner Plan E3 Group B (always-inject
    // + Reset/Enable around Executor.RunTests + iterations field on
    // SerializeSummary).
    assert.ok(
      result.iterations.length > 0,
      'result.iterations must be non-empty for ALProject4/CU1.al ' +
      "which contains `for i := 1 to 10 do begin ... end`. " +
      'If empty, AL.Runner v2 isn\'t plumbing iterations into the summary ' +
      '(see Plan E3 Group B in AL.Runner repo).',
    );
    const cu1Loop = result.iterations.find(loop =>
      loop.sourceFile.toLowerCase().endsWith('cu1.al'));
    assert.ok(cu1Loop, `iterations must include a loop in CU1.al; got ${JSON.stringify(result.iterations.map(l => l.sourceFile))}`);
    assert.strictEqual(cu1Loop!.iterationCount, 10, 'CU1.al for-loop iterates 10 times');
    assert.strictEqual(cu1Loop!.steps.length, 10, 'all 10 steps recorded');

    // Plan E4: per-iteration captures must populate now that the runner's
    // FinalizeIteration reads from TestExecutionScope.Current.CapturedValues.
    // Without this, the iteration stepper updates the indicator but the
    // inline values stay blank (Plan E4 user report).
    const stepsWithCaptures = cu1Loop!.steps.filter(s => s.capturedValues.length > 0);
    assert.ok(
      stepsWithCaptures.length > 0,
      `expected per-iteration captures populated for at least one step in CU1.al; ` +
      `got ${stepsWithCaptures.length} of ${cu1Loop!.steps.length} steps with captures. ` +
      `If 0, AL.Runner's IterationTracker.FinalizeIteration regressed (Plan E4).`,
    );
    // CU1.al's `for i := 1 to 10 do myInt += i;` should yield captures
    // for `myInt` on each iteration. Pin a specific iteration for clarity.
    const step3Captures = cu1Loop!.steps[2].capturedValues;
    assert.ok(
      step3Captures.some(cv => cv.variableName.toLowerCase() === 'myint'),
      `step[3].capturedValues must include myInt; got ${JSON.stringify(step3Captures.map(cv => cv.variableName))}`,
    );

    // Plan E5 Group B (G2 fix): the runner now also captures the loop
    // variable per iteration. CU1.al's `for i := 1 to 10 do` should
    // yield captures for both `i` AND `myInt` on each iteration.
    assert.ok(
      step3Captures.some(cv => cv.variableName.toLowerCase() === 'i'),
      `step[3].capturedValues must include the loop variable 'i' (Plan E5 Group B fix); got ${JSON.stringify(step3Captures.map(cv => cv.variableName))}`,
    );
    // Pin the value: at iteration 3, `i` should be 3.
    const stepIvalue = step3Captures.find(cv => cv.variableName.toLowerCase() === 'i')?.value;
    assert.strictEqual(
      stepIvalue, '3',
      `step[3] loop variable 'i' must equal '3'; got ${stepIvalue}`,
    );

    // 9. The DecorationManager must hold captures (proves applyResults ran the
    //    inline-render branch — the v0.5.3+ path-matcher fix). If
    //    findCoverageForFile fails to match the v2 absolute path, captures
    //    would be tracked here but never reach setDecorations; that's
    //    diagnosed by the layer-tests, but the END-state we care about is
    //    that the decoration manager owns the captures.
    const dm = hooks.getDecorationManager();
    const dmCaptures = dm.getCapturedValues();
    assert.ok(
      dmCaptures.length > 0,
      'DecorationManager must have captures after applyResults (proves v2 → v1 capture translation reached the manager)',
    );
    assert.ok(
      dmCaptures.some(cv => cv.sourceFile && cv.sourceFile.toLowerCase().includes('cu1')),
      'at least one capture must reference CU1 (the file under test)',
    );

    // Plan E3 Group E: captures must be grouped, not dedup'd. With 10
    // iterations of `myInt += i` in CU1.al, we expect 10 distinct values
    // for myInt at the same statementId. If dmCaptures collapsed them
    // to 1, the dedup-to-last regression returned.
    const myIntCaptures = dmCaptures.filter(cv => cv.variableName.toLowerCase() === 'myint');
    // CU1.al has `myInt := 1` (line 9) then `for i := 1 to 10 do myInt += i` (line 13).
    // That's 11 captures total: 1 from the init, then 10 from loop iterations.
    // Pin the count so a partial dedup regression (e.g. collapsing 11 → 3) also fails.
    assert.strictEqual(
      myIntCaptures.length,
      11,
      `expected exactly 11 myInt captures (1 init + 10 loop iterations); ` +
      `got ${myIntCaptures.length}. ` +
      `If <11, applyInlineCapturedValues regressed back to a dedup form.`,
    );

    console.log(`[runtime smoke] ${captures.length} captures, ${coverageV2.length} coverage files, ${dmCaptures.length} dm captures — all green`);
  });
});

/**
 * Poll a producer until it returns a truthy value or the timeout elapses.
 * Returns the value (typed). Throws with the supplied label on timeout.
 */
async function waitFor<T>(
  produce: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await produce();
    if (v) return v as NonNullable<T>;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}
