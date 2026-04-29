import * as assert from 'assert';
import { DecorationManager } from '../../src/editor/decorations';
import { CapturedValue } from '../../src/runner/outputParser';
import { ExecutionResult } from '../../src/runner/outputParser';

/**
 * Tests for the per-test captured-values scope and v2-coverage retirement
 * gating introduced in Plan E2 / T9.
 *
 * The DecorationManager constructor calls vscode.window.createTextEditorDecorationType
 * for each decoration kind. The unit-test vscode mock returns spy objects
 * (MockTextEditorDecorationType) so we can match decoration types by reference
 * identity and inspect setDecorations calls without a live VS Code host.
 */
suite('DecorationManager — per-test capturedValues', () => {
  function v1(scopeName: string, sourceFile: string, variableName: string, value: string, statementId: number): CapturedValue {
    return { scopeName, sourceFile, variableName, value, statementId };
  }

  test('setCapturedValuesForTest stores per-test', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setCapturedValuesForTest('TestB', [v1('s', 'b.al', 'y', '2', 0)]);
    dm.setActiveTest('TestA');

    const active = dm.getCapturedValues();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].variableName, 'x');
    assert.strictEqual(active[0].value, '1');

    dm.dispose();
  });

  test('setActiveTest(undefined) returns union across tests', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setCapturedValuesForTest('TestB', [v1('s', 'a.al', 'y', '2', 0)]);
    dm.setActiveTest(undefined);

    const all = dm.getCapturedValues();
    assert.strictEqual(all.length, 2);
    const names = all.map(cv => cv.variableName).sort();
    assert.deepStrictEqual(names, ['x', 'y']);

    dm.dispose();
  });

  test('clearCapturedValueScopes wipes both maps', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setActiveTest('TestA');

    dm.clearCapturedValueScopes();
    assert.strictEqual(dm.getCapturedValues().length, 0);
    // After clearing, setting an unknown active test stays empty too.
    dm.setActiveTest('TestA');
    assert.strictEqual(dm.getCapturedValues().length, 0);

    dm.dispose();
  });

  test('setActiveTest naming a non-existent test returns empty', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setActiveTest('TestC');

    assert.deepStrictEqual(dm.getCapturedValues(), []);

    dm.dispose();
  });

  test('switching active test alternates which set is returned', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setCapturedValuesForTest('TestB', [v1('s', 'b.al', 'y', '2', 0)]);

    dm.setActiveTest('TestA');
    assert.strictEqual(dm.getCapturedValues()[0].variableName, 'x');

    dm.setActiveTest('TestB');
    assert.strictEqual(dm.getCapturedValues()[0].variableName, 'y');

    dm.setActiveTest(undefined);
    assert.strictEqual(dm.getCapturedValues().length, 2);

    dm.dispose();
  });

  test('setCapturedValuesForTest replaces a previous bucket for the same test', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'x', '1', 0)]);
    dm.setCapturedValuesForTest('TestA', [v1('s', 'a.al', 'z', '99', 0)]);
    dm.setActiveTest('TestA');

    const captured = dm.getCapturedValues();
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].variableName, 'z');
    assert.strictEqual(captured[0].value, '99');

    dm.dispose();
  });

  test('legacy applyResults populates union (v1 path) — getCapturedValues sees them', () => {
    const dm = new DecorationManager(__dirname);
    const fakeEditor = makeFakeEditor('/some/workspace/Foo.al');

    const v1Result = makeV1Result([
      v1('s', 'Foo.al', 'a', '11', 0),
      v1('s', 'Foo.al', 'b', '22', 1),
    ]);
    dm.applyResults(fakeEditor, v1Result, '/some/workspace');

    const all = dm.getCapturedValues();
    assert.strictEqual(all.length, 2);
    const names = all.map(cv => cv.variableName).sort();
    assert.deepStrictEqual(names, ['a', 'b']);

    dm.dispose();
  });

  test('v2 applyResults flattens per-test capturedValues into union (legacy bucket)', () => {
    const dm = new DecorationManager(__dirname);
    const fakeEditor = makeFakeEditor('/some/workspace/Foo.al');

    const v2Result = makeV2Result([
      {
        name: 'T1', status: 'passed', durationMs: 1, message: undefined,
        stackTrace: undefined, alSourceLine: undefined, alSourceColumn: undefined,
        capturedValues: [
          { scopeName: 's', objectName: 'Codeunit Foo', variableName: 'x', value: 42, statementId: 0 },
        ],
      },
      {
        name: 'T2', status: 'passed', durationMs: 1, message: undefined,
        stackTrace: undefined, alSourceLine: undefined, alSourceColumn: undefined,
        capturedValues: [
          { scopeName: 's', objectName: 'Codeunit Foo', variableName: 'y', value: 'hello', statementId: 0 },
        ],
      },
    ]);

    dm.applyResults(fakeEditor, v2Result, '/some/workspace');

    const all = dm.getCapturedValues();
    assert.strictEqual(all.length, 2, 'union should contain both flattened captures');
    const byName = new Map(all.map(cv => [cv.variableName, cv]));
    // Numeric value gets JSON-stringified; string stays as-is.
    assert.strictEqual(byName.get('x')!.value, '42');
    assert.strictEqual(byName.get('y')!.value, 'hello');
    // sourceFile fell back from objectName (lossy translation).
    assert.strictEqual(byName.get('x')!.sourceFile, 'Codeunit Foo');

    dm.dispose();
  });

  test('clearCapturedValueScopes after applyResults wipes the legacy bucket too', () => {
    const dm = new DecorationManager(__dirname);
    const fakeEditor = makeFakeEditor('/some/workspace/Foo.al');
    const v1Result = makeV1Result([v1('s', 'Foo.al', 'a', '1', 0)]);
    dm.applyResults(fakeEditor, v1Result, '/some/workspace');

    assert.strictEqual(dm.getCapturedValues().length, 1);
    dm.clearCapturedValueScopes();
    assert.strictEqual(dm.getCapturedValues().length, 0);

    dm.dispose();
  });
});

suite('DecorationManager — coverageV2 retires custom gutter', () => {
  test('v2 coverageV2 present → custom coverage decoration types cleared, not painted', () => {
    const dm = new DecorationManager(__dirname);
    const calls: Array<{ type: any; ranges: any[] }> = [];
    const fakeEditor = makeFakeEditor('/some/workspace/Foo.al', calls);

    const v2Result: ExecutionResult = {
      ...makeV2Result([]),
      coverage: [{
        className: 'Foo', filename: 'Foo.al', lineRate: 1,
        lines: [{ number: 1, hits: 1 }],
      }],
      coverageV2: [{
        file: 'Foo.al', lines: [{ line: 1, hits: 1 }],
        totalStatements: 1, hitStatements: 1,
      }],
    };

    dm.applyResults(fakeEditor, v2Result, '/some/workspace');

    // Identify the covered + uncovered decoration types — they're the first
    // two TextEditorDecorationType instances created by the constructor.
    const types = (dm as any);
    const covered = types.coveredDecorationType;
    const uncovered = types.uncoveredDecorationType;

    const coveredCalls = calls.filter(c => c.type === covered);
    const uncoveredCalls = calls.filter(c => c.type === uncovered);

    // Each type should have been called only with empty arrays (clear), never
    // with painted ranges.
    assert.ok(coveredCalls.length >= 1, 'covered decoration type was set at least once');
    assert.ok(uncoveredCalls.length >= 1, 'uncovered decoration type was set at least once');
    for (const c of coveredCalls) {
      assert.strictEqual(c.ranges.length, 0, 'covered should be cleared, not painted');
    }
    for (const c of uncoveredCalls) {
      assert.strictEqual(c.ranges.length, 0, 'uncovered should be cleared, not painted');
    }

    dm.dispose();
  });

  test('v1 (no coverageV2) → custom coverage decorations applied normally', () => {
    const dm = new DecorationManager(__dirname);
    const calls: Array<{ type: any; ranges: any[] }> = [];
    const fakeEditor = makeFakeEditor('/some/workspace/Foo.al', calls);

    const v1Result: ExecutionResult = {
      ...makeV1Result([]),
      coverage: [{
        className: 'Foo', filename: 'Foo.al', lineRate: 1,
        lines: [{ number: 1, hits: 3 }, { number: 2, hits: 0 }],
      }],
    };

    dm.applyResults(fakeEditor, v1Result, '/some/workspace');

    const types = (dm as any);
    const covered = types.coveredDecorationType;
    const uncovered = types.uncoveredDecorationType;

    // The last set call for each type should be the painted ranges (not [] from clearDecorations).
    const lastCovered = [...calls].reverse().find(c => c.type === covered);
    const lastUncovered = [...calls].reverse().find(c => c.type === uncovered);
    assert.ok(lastCovered, 'covered decoration type was set');
    assert.ok(lastUncovered, 'uncovered decoration type was set');
    assert.strictEqual(lastCovered!.ranges.length, 1, 'covered painted for line 1 (hits=3)');
    assert.strictEqual(lastUncovered!.ranges.length, 1, 'uncovered painted for line 2 (hits=0)');

    dm.dispose();
  });
});

// --- Test helpers ---------------------------------------------------------

interface DecorationCall { type: any; ranges: any[] }

function makeFakeEditor(fsPath: string, calls?: DecorationCall[]): any {
  const lineCount = 5;
  return {
    document: {
      uri: { fsPath },
      lineCount,
      lineAt: (i: number) => ({
        text: '',
        range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
      }),
    },
    setDecorations: (type: any, ranges: any[]) => {
      if (calls) { calls.push({ type, ranges }); }
    },
  };
}

function makeV1Result(capturedValues: CapturedValue[]): ExecutionResult {
  return {
    mode: 'test',
    tests: [],
    messages: [],
    stderrOutput: [],
    summary: { passed: 0, failed: 0, errors: 0, total: 0 },
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues,
    cached: false,
    iterations: [],
  };
}

function makeV2Result(tests: any[]): ExecutionResult {
  return {
    mode: 'test',
    tests,
    messages: [],
    stderrOutput: [],
    summary: { passed: tests.length, failed: 0, errors: 0, total: tests.length },
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues: [],
    cached: false,
    iterations: [],
    protocolVersion: 2,
  };
}
