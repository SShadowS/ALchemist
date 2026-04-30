import * as assert from 'assert';
import { DecorationManager, formatCaptureGroup } from '../../src/editor/decorations';
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

  test('lossy non-.al sourceFile triggers one-time console.warn', () => {
    const fakeEditor = {
      setDecorations: () => {},
      document: { uri: { fsPath: '/ws/Foo.al' } },
    } as any;
    const dm = new DecorationManager(__dirname);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
      const lossy: any[] = [{
        scopeName: 's', sourceFile: 'Codeunit Foo',
        variableName: 'x', value: '1', statementId: 0,
      }];
      // applyInlineCapturedValues is private; access via cast.
      (dm as any).applyInlineCapturedValues(fakeEditor, lossy, [], '/ws');
      (dm as any).applyInlineCapturedValues(fakeEditor, lossy, [], '/ws');
      const lossyWarnings = warnings.filter(w => w.includes('lossy v2 translation'));
      assert.strictEqual(lossyWarnings.length, 1,
        'warning fires exactly once across multiple invocations');
    } finally {
      console.warn = origWarn;
      dm.dispose();
    }
  });

  test('proper .al sourceFile does NOT trigger the warning', () => {
    const fakeEditor = {
      setDecorations: () => {},
      document: { uri: { fsPath: '/ws/Foo.al' } },
    } as any;
    const dm = new DecorationManager(__dirname);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
      const proper: any[] = [{
        scopeName: 's', sourceFile: 'src/Foo.al',
        variableName: 'x', value: '1', statementId: 0,
      }];
      (dm as any).applyInlineCapturedValues(fakeEditor, proper, [], '/ws');
      const lossyWarnings = warnings.filter(w => w.includes('lossy v2 translation'));
      assert.strictEqual(lossyWarnings.length, 0);
    } finally {
      console.warn = origWarn;
      dm.dispose();
    }
  });

  test('v2 applyResults with coverageV2 + per-capture alSourceFile renders inline captures (regression for the bug we shipped)', () => {
    // The bug: applyResults passed result.coverage (empty for v2) into
    // applyInlineCapturedValues, which uses it to map statementId→line.
    // Empty coverage → early return → no decorations. After the fix,
    // coverageV2 is translated on-the-fly so the v1 codepath inside
    // applyInlineCapturedValues sees real line data.
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          message: undefined, stackTrace: undefined,
          alSourceLine: undefined, alSourceColumn: undefined,
          alSourceFile: 'TestCU1.al',
          capturedValues: [
            // Each capture carries its own alSourceFile (the new f2d2bb3
            // shape). The translator should pick this up regardless of
            // the test event's alSourceFile.
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al', variableName: 'myint', value: '1', statementId: 0 },
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al', variableName: 'myint', value: '2', statementId: 1 },
          ],
        } as any,
      ]),
      // v2 results route coverage to coverageV2; the legacy `coverage` array stays empty.
      coverage: [],
      coverageV2: [
        {
          file: 'CU1.al',
          lines: [
            { line: 1, hits: 1 },   // statementId 0 → line 1 (within fake editor's 5 lines)
            { line: 3, hits: 1 },   // statementId 1 → line 3
          ],
          totalStatements: 2,
          hitStatements: 2,
        },
      ],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    // The captured-value decoration type should have been set with at least
    // one range. If the bug regresses, this stays empty (early return inside
    // applyInlineCapturedValues because coverage was empty).
    const captureDecorationCalls = calls.filter(c =>
      c.type && c.type.options && (c.type.options.after || c.type.options.before),
    );
    const nonEmptyCaptureCalls = captureDecorationCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmptyCaptureCalls.length > 0,
      `expected at least one captured-value decoration call with non-empty ranges; got ${captureDecorationCalls.length} call(s) total, all empty. ` +
      `If you see this, the v2 → v1 coverage translation in applyResults regressed (Plan E2.1 v0.5.3 fix).`,
    );

    dm.dispose();
  });

  test('v2 applyResults with ABSOLUTE-path coverage + captures (server emits absolute paths) renders inline captures', () => {
    // Real-world bug: AL.Runner --server emits absolute paths with forward
    // slashes for both `coverage[].file` and `capturedValues[].alSourceFile`.
    // findCoverageForFile compared `e.filename` (absolute fwd-slashes) against
    // either `relativePath` (always relative) or `filePath.endsWith(...)`
    // (Windows backslashes). Neither matched → silent no-op render.
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    // Mimic the server's actual wire shape: absolute paths, forward slashes.
    const absoluteFwdSlash = filePath.replace(/\\/g, '/');

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: absoluteFwdSlash,
          capturedValues: [
            { scopeName: 's', objectName: 'CU1', alSourceFile: absoluteFwdSlash, variableName: 'myint', value: '1', statementId: 0 },
            { scopeName: 's', objectName: 'CU1', alSourceFile: absoluteFwdSlash, variableName: 'myint', value: '2', statementId: 1 },
          ],
        } as any,
      ]),
      coverage: [],
      coverageV2: [
        {
          file: absoluteFwdSlash,
          lines: [
            { line: 1, hits: 1 },
            { line: 3, hits: 1 },
          ],
          totalStatements: 2,
          hitStatements: 2,
        },
      ],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureDecorationCalls = calls.filter(c =>
      c.type && c.type.options && (c.type.options.after || c.type.options.before),
    );
    const nonEmpty = captureDecorationCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected non-empty capture decoration with absolute-path coverage entries; got ${captureDecorationCalls.length} call(s), all empty. ` +
      `findCoverageForFile must accept absolute paths emitted by the AL.Runner --server protocol.`,
    );

    dm.dispose();
  });

  test('v2 applyResults with COMPUTED-RELATIVE sourceFile (runner spawned from a foreign cwd) renders inline captures', () => {
    // Real-world bug: AL.Runner emits source paths via
    //   `Path.GetRelativePath(Directory.GetCurrentDirectory(), file)`.
    // When the runner is spawned by VS Code's extension host, its cwd is
    // typically the VS Code install dir (deep under `C:\Users\<user>\AppData\
    // Local\Programs\Microsoft VS Code`). The AL file lives under
    // `C:\Users\<user>\Documents\AL\<project>`. The relative path that
    // results goes up several levels (e.g. `../../../../Documents/AL/<...>`).
    // The capture-filter does `path.resolve(workspacePath, sourceFile)` which
    // anchors against workspacePath, NOT the runner's cwd — so without a
    // matching cwd the resolve walks to the wrong absolute path and the
    // filter drops every capture. The runtime fix pins the runner's cwd to
    // the workspace folder; this test guards the alternative scenario where
    // the runner emits paths relative to *some* directory we know about and
    // the filter must still match when that directory equals workspacePath.
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    // Simulate the runner having been spawned with cwd = workspacePath.
    // SourceFileMapper.GetFile returns `Path.GetRelativePath(workspacePath, filePath)` = "CU1.al".
    const relativeSourceFile = 'CU1.al';

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: relativeSourceFile,
          capturedValues: [
            { scopeName: 's', objectName: 'CU1', alSourceFile: relativeSourceFile, variableName: 'myint', value: '1', statementId: 0 },
            { scopeName: 's', objectName: 'CU1', alSourceFile: relativeSourceFile, variableName: 'myint', value: '2', statementId: 1 },
          ],
        } as any,
      ]),
      coverage: [],
      coverageV2: [
        {
          file: relativeSourceFile,
          lines: [{ line: 1, hits: 1 }, { line: 3, hits: 1 }],
          totalStatements: 2,
          hitStatements: 2,
        },
      ],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureDecorationCalls = calls.filter(c =>
      c.type && c.type.options && (c.type.options.after || c.type.options.before),
    );
    const nonEmpty = captureDecorationCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected non-empty capture decoration when sourceFile is workspace-relative (runner spawned with cwd=workspace); ` +
      `got ${captureDecorationCalls.length} call(s), all empty. The capture-file filter must accept this shape.`,
    );

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

suite('applyResults — case-insensitive variable lookup (G8 fix)', () => {
  test('case-insensitive variable lookup — declaration case differs from source-text usage case', () => {
    // Plan E5 Group D (fixes G8 consumer-side): AL is case-insensitive
    // for identifiers. The runner emits captures with the variable's
    // declaration case, but source code may use a different case (e.g.,
    // declared `myint` but used as `myInt`). The inline-render lookup
    // must match regardless of case.
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    // Capture has lowercase variable name (as runner emits per declaration).
    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: 'CU1.al',
          capturedValues: [
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al',
              variableName: 'myint', value: '42', statementId: 0 },
          ],
        } as any,
      ]),
      coverage: [],
      coverageV2: [{
        file: 'CU1.al',
        lines: [{ line: 1, hits: 1 }],
        totalStatements: 1, hitStatements: 1,
      }],
    };

    // Override the fake editor's lineAt to provide source text with mixed case.
    const origLineAt = fakeEditor.document.lineAt;
    fakeEditor.document.lineAt = (i: number) => i === 0
      ? ({ text: '        myInt := 42;', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } as any)
      : origLineAt(i);

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureCalls = calls.filter(c =>
      c.type && c.type.options && c.type.options.after,
    );
    const contentTexts = captureCalls.flatMap(c =>
      (c.ranges as any[]).map(r => r.renderOptions?.after?.contentText as string)
    ).filter(Boolean);

    assert.ok(
      contentTexts.some(t => /myInt\s*=\s*42\b/.test(t) || /myint\s*=\s*42\b/.test(t)),
      `case-insensitive lookup must succeed even when declaration case (myint) differs from source-text case (myInt); got ${JSON.stringify(contentTexts)}`,
    );

    dm.dispose();
  });
});

// --- formatCaptureGroup unit tests ----------------------------------------

suite('formatCaptureGroup', () => {
  test('empty array returns empty string', () => {
    assert.strictEqual(formatCaptureGroup([]), '');
  });

  test('single value renders plain', () => {
    assert.strictEqual(formatCaptureGroup(['42']), '42');
  });

  test('two values joined by pipe', () => {
    assert.strictEqual(formatCaptureGroup(['1', '2']), '1 | 2');
  });

  test('three values joined by pipe', () => {
    assert.strictEqual(formatCaptureGroup(['a', 'b', 'c']), 'a | b | c');
  });

  test('four or more values use compact form', () => {
    const result = formatCaptureGroup(['2', '3', '4', '56']);
    assert.ok(result.includes('‥'), `expected ‥ in compact form; got ${result}`);
    assert.ok(result.includes('×4'), `expected ×4; got ${result}`);
    assert.ok(result.startsWith('2'), `expected to start with first value; got ${result}`);
    assert.ok(result.includes('56'), `expected to include last value; got ${result}`);
  });

  test('ten values use compact form with correct count', () => {
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '56'];
    const result = formatCaptureGroup(values);
    assert.strictEqual(result, '2 ‥ 56  (×10)');
  });
});

// --- compact loop rendering integration tests -------------------------------

suite('applyInlineCapturedValues — compact loop rendering', () => {
  test('multiple values per (statementId, variable) render as compact loop summary', () => {
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    // 10 captures of `myInt` at statementId 0, mimicking a `for` loop.
    // statementId 0 maps to the first covered line (line 1 in fixture below).
    const v2Captures = [];
    const computedValues: string[] = [];
    // Generate 10 arbitrary distinct values. The exact numeric sequence is
    // not asserted (the regex only checks `first ‥ last  (×10)` SHAPE), so
    // these don't need to match a real AL `for i := 1 to 10 do myInt += i`
    // sequence. The test asserts compact-form rendering, not value content.
    for (let v = 2, sum = 1; computedValues.length < 10; v++) {
      sum += v;
      computedValues.push(String(sum));
    }
    for (const value of computedValues) {
      v2Captures.push({
        scopeName: 's', objectName: 'CU1',
        alSourceFile: 'CU1.al', variableName: 'myInt',
        value, statementId: 0,
      });
    }

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: 'CU1.al',
          capturedValues: v2Captures,
        } as any,
      ]),
      coverage: [],
      coverageV2: [{
        file: 'CU1.al',
        lines: [{ line: 1, hits: 10 }, { line: 3, hits: 1 }],
        totalStatements: 2,
        hitStatements: 2,
      }],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    // Find the captured-value decoration(s) and inspect their contentText.
    const captureCalls = calls.filter(c =>
      c.type && c.type.options && c.type.options.after,
    );
    const contentTexts = captureCalls.flatMap(c =>
      (c.ranges as any[]).map(r => r.renderOptions?.after?.contentText as string)
    ).filter(Boolean);

    // Compact-form expected: "myInt = first ‥ last  (×10)"
    const compact = contentTexts.find(t => /myInt\s*=.*‥.*\(×10\)/.test(t));
    assert.ok(
      compact,
      `expected "myInt = first ‥ last  (×10)"-style decoration; got ${JSON.stringify(contentTexts)}`,
    );

    dm.dispose();
  });

  test('single value per (statementId, variable) renders plain (no compact form)', () => {
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: 'CU1.al',
          capturedValues: [{
            scopeName: 's', objectName: 'CU1',
            alSourceFile: 'CU1.al', variableName: 'myInt',
            value: '1', statementId: 0,
          }],
        } as any,
      ]),
      coverage: [],
      coverageV2: [{
        file: 'CU1.al',
        lines: [{ line: 1, hits: 1 }],
        totalStatements: 1, hitStatements: 1,
      }],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureCalls = calls.filter(c =>
      c.type && c.type.options && c.type.options.after,
    );
    const contentTexts = captureCalls.flatMap(c =>
      (c.ranges as any[]).map(r => r.renderOptions?.after?.contentText as string)
    ).filter(Boolean);

    assert.ok(
      contentTexts.some(t => /myInt\s*=\s*1\b/.test(t) && !t.includes('×')),
      `single-value capture must NOT use compact form; got ${JSON.stringify(contentTexts)}`,
    );

    dm.dispose();
  });

  test('two values render as joined-by-pipe (no compact)', () => {
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: 'CU1.al',
          capturedValues: [
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al', variableName: 'myInt', value: '2', statementId: 0 },
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al', variableName: 'myInt', value: '5', statementId: 0 },
          ],
        } as any,
      ]),
      coverage: [],
      coverageV2: [{
        file: 'CU1.al',
        lines: [{ line: 1, hits: 2 }],
        totalStatements: 1, hitStatements: 1,
      }],
    };

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureCalls = calls.filter(c =>
      c.type && c.type.options && c.type.options.after,
    );
    const contentTexts = captureCalls.flatMap(c =>
      (c.ranges as any[]).map(r => r.renderOptions?.after?.contentText as string)
    ).filter(Boolean);

    assert.ok(
      contentTexts.some(t => /myInt\s*=\s*2\s\|\s5\b/.test(t) && !t.includes('×')),
      `two values must render joined-by-pipe; got ${JSON.stringify(contentTexts)}`,
    );

    dm.dispose();
  });
});
