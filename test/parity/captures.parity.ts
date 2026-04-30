import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TestHooks } from '../../src/extension';

const FORK = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;
const FIXTURE_DIR = path.resolve(__dirname, '../../../test/fixtures/parity-loop-fixture');

/**
 * Run the fork binary in legacy v1 (--output-json) mode and parse the result.
 */
function runV1(): Promise<any> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = cp.spawn(FORK, [
      '--output-json',
      '--capture-values',
      '--iteration-tracking',
      '--coverage',
      FIXTURE_DIR,
    ], { cwd: FIXTURE_DIR });
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', code => {
      // ExitCode 1 is fine (one or more tests failed) — we still want the JSON.
      // Anything else (e.g. compile error) means something's wrong; reject.
      if (code !== 0 && code !== 1) {
        return reject(new Error(`v1 exited ${code}: stderr=${stderr.slice(-300)} stdout=${stdout.slice(-300)}`));
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (e) {
        reject(new Error(`v1 stdout not parseable JSON. stderr=${stderr.slice(-200)} stdout=${stdout.slice(0, 200)}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Drive the v2 path through the activated extension's TestHooks.
 * Returns the ExecutionResult, already mapped from v2 NDJSON.
 */
async function runV2(hooks: TestHooks): Promise<any> {
  return await hooks.runTestsAndApply([FIXTURE_DIR]);
}

/**
 * Project both v1 and v2 outputs into a UI-relevant subset that's
 * comparable across protocols. Discards wire-format-specific fields
 * (durationMs, cached, protocolVersion, etc.) and focuses on what the
 * UI actually displays.
 *
 * v1 carries captures at top-level `capturedValues`; v2 carries them
 * per-test. The projection flattens both into a single array.
 */
function normalizeForParity(input: any): any {
  // Captures: v1 has top-level array, v2 has per-test arrays.
  const flatCaptures = (
    input.capturedValues && input.capturedValues.length > 0
      ? input.capturedValues
      : (input.tests ?? []).flatMap((t: any) => t.capturedValues ?? [])
  );

  return {
    captures: flatCaptures
      .map((cv: any) => ({
        variable: cv.variableName,
        value: String(cv.value),
        statementId: cv.statementId,
        sourceFileBasename: path.basename(cv.sourceFile ?? cv.alSourceFile ?? ''),
      }))
      .sort((a: any, b: any) =>
        a.statementId - b.statementId ||
        a.variable.localeCompare(b.variable) ||
        a.value.localeCompare(b.value)
      ),
    iterations: (input.iterations ?? []).map((loop: any) => ({
      iterationCount: loop.iterationCount,
      stepCount: loop.steps?.length ?? 0,
      sourceFileBasename: path.basename(loop.sourceFile ?? ''),
      // Plan E4: project per-step capture variable names so a v1/v2
      // mismatch where one path has populated step.capturedValues but
      // the other doesn't (the regression that motivated Plan E4)
      // surfaces as a parity diff.
      stepVarNames: (loop.steps ?? []).map((s: any) =>
        (s.capturedValues ?? []).map((cv: any) => cv.variableName).sort()
      ),
    })).sort((a: any, b: any) => a.sourceFileBasename.localeCompare(b.sourceFileBasename)),
    coverage: (() => {
      // v1 emits cobertura-shape `coverage` (filename); v2 emits flat `coverageV2` (file).
      const arr = input.coverage ?? input.coverageV2 ?? [];
      return arr.map((cov: any) => ({
        fileBasename: path.basename(cov.filename ?? cov.file ?? ''),
        hitLineCount: (cov.lines ?? []).filter((l: any) => (l.hits ?? 0) > 0).length,
      })).sort((a: any, b: any) => a.fileBasename.localeCompare(b.fileBasename));
    })(),
    testStatuses: (input.tests ?? [])
      .map((t: any) => ({
        name: t.name,
        // Normalization gap: v1 (--output-json) emits "pass"/"fail" (short form)
        // while v2 (--server NDJSON) emits "passed"/"failed" (past-tense long form)
        // after translation in ServerExecutionEngine. Both encode the same fact.
        // We normalize to the v2 canonical form so the assertion is protocol-agnostic.
        status: t.status === 'pass' ? 'passed' : t.status === 'fail' ? 'failed' : t.status,
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name)),
  };
}

suite('Parity — v1 (--output-json) and v2 (--server) produce equivalent UI state', function () {
  this.timeout(60_000);

  let originalAlRunnerPath: string | undefined;

  suiteSetup(async () => {
    const vscode = require('vscode');
    originalAlRunnerPath = vscode.workspace
      .getConfiguration('alchemist')
      .get('alRunnerPath') as string | undefined;
  });

  suiteTeardown(async () => {
    const vscode = require('vscode');
    await vscode.workspace
      .getConfiguration('alchemist')
      .update('alRunnerPath', originalAlRunnerPath, vscode.ConfigurationTarget.Global);
  });

  if (!fs.existsSync(FORK)) {
    test.skip(`fork binary missing at ${FORK}; skipping parity suite`, () => {});
    return;
  }
  if (!fs.existsSync(FIXTURE_DIR)) {
    test.skip(`fixture missing at ${FIXTURE_DIR}; skipping parity suite`, () => {});
    return;
  }

  test('captures, iterations, coverage, and test statuses match between v1 and v2', async () => {
    const vscode = require('vscode');
    await vscode.workspace
      .getConfiguration('alchemist')
      .update('alRunnerPath', FORK, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension('SShadowSdk.al-chemist');
    assert.ok(ext, 'ALchemist extension must be registered');
    const hooks = (await ext.activate()) as TestHooks | undefined;
    assert.ok(hooks, 'TestHooks must be returned (set ALCHEMIST_TEST_HOOKS=1)');
    await hooks.awaitEngineReady();

    // Run both producers
    const v1Raw = await runV1();
    const v2Raw = await runV2(hooks);

    const v1 = normalizeForParity(v1Raw);
    const v2 = normalizeForParity(v2Raw);

    // Print a normalized diff if any assertion fails — makes triage faster.
    const dump = () => `\nv1=${JSON.stringify(v1, null, 2)}\nv2=${JSON.stringify(v2, null, 2)}`;

    assert.deepStrictEqual(v2.testStatuses, v1.testStatuses,
      'test statuses must match across producers' + dump());
    assert.deepStrictEqual(v2.iterations, v1.iterations,
      'iteration data (count + step count + file basename) must match across producers' + dump());
    assert.deepStrictEqual(v2.coverage, v1.coverage,
      'coverage (file basename + hit-line count) must match across producers' + dump());
    assert.deepStrictEqual(v2.captures, v1.captures,
      'captured values (variable + value + statementId + file basename) must match across producers' + dump());
  });
});
