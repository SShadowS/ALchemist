import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { ExecutionResult, CapturedValue } from '../../src/runner/outputParser';
import { FileCoverage } from '../../src/execution/protocolV2Types';

const WS = path.resolve('/ws');
const FILE = path.join(WS, 'src', 'Foo.al');

interface DecorationCall { type: any; ranges: any[] }

function makeFakeEditor(fsPath: string, calls: DecorationCall[]): any {
  return {
    document: {
      uri: { fsPath },
      lineCount: 40,
      lineAt: (i: number) => ({
        text: '',
        range: { start: { line: i, character: 0 }, end: { line: i, character: 10 } },
      }),
    },
    setDecorations: (type: any, ranges: any[]) => { calls.push({ type, ranges }); },
  };
}

function v2Result(capturedValues: CapturedValue[], coverageV2: FileCoverage[]): ExecutionResult {
  return {
    mode: 'test',
    tests: [{
      name: 'T', status: 'passed', alSourceFile: 'src/Foo.al',
      capturedValues: capturedValues.map(cv => ({
        scopeName: cv.scopeName,
        alSourceFile: 'src/Foo.al',
        variableName: cv.variableName,
        value: cv.value,
        statementId: cv.statementId,
      })),
    }] as any,
    messages: [],
    stderrOutput: [],
    summary: { passed: 1, failed: 0, errors: 0, total: 1 },
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues: [],
    cached: false,
    iterations: [],
    protocolVersion: 2,
    coverageV2,
  };
}

/** Ranges painted for the decoration type whose `after` color id ends in `capturedValueForeground`. */
function capturedRanges(calls: DecorationCall[]): any[] {
  const call = calls.filter(c =>
    String(c.type?.options?.after?.color?.id ?? '').includes('capturedValueForeground'),
  ).pop();
  return call?.ranges ?? [];
}

suite('capture placement via statement table', () => {
  test('two statements on ONE line place their captures on that line (heuristic got this wrong)', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 2 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'DoWork', line: 12, column: 5, endLine: 12, endColumn: 20, hits: 1 },
        { id: 1, scope: 'DoWork', line: 12, column: 22, endLine: 12, endColumn: 40, hits: 1 },
      ],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'a', value: '1', statementId: 0 },
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'b', value: '2', statementId: 1 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    const ranges = capturedRanges(calls);
    assert.strictEqual(ranges.length, 2, 'both captures should be placed');
    // Line 12 is 1-based; the editor range is 0-based line 11.
    assert.ok(ranges.every(r => r.range.start.line === 11), 'both belong on editor line 11');
    dm.dispose();
  });

  test('placement follows the table, not covered-line ordering', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    // statementId 0 lives on line 30, statementId 1 on line 8. Ordering by
    // line number would place them the other way round.
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 8, hits: 1 }, { line: 30, hits: 1 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'DoWork', line: 30, column: 5, hits: 1 },
        { id: 1, scope: 'DoWork', line: 8, column: 5, hits: 1 },
      ],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'late', value: 'L', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    const ranges = capturedRanges(calls);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].range.start.line, 29, 'statement 0 is on 1-based line 30');
    dm.dispose();
  });

  test('capture whose (scope, id) is absent from the table is skipped, not guessed', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'DoWork', line: 12, column: 5, hits: 1 }],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'GhostScope', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(capturedRanges(calls).length, 0);
    dm.dispose();
  });

  test('scope casing difference still places the capture', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'dowork', line: 12, column: 5, hits: 1 }],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(capturedRanges(calls).length, 1);
    dm.dispose();
  });

  test('statementsAvailable is false when the runner sent no statement table', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 1 }], totalStatements: 1, hitStatements: 1,
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    const stats = dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(stats.statementsAvailable, false);
    assert.strictEqual(capturedRanges(calls).length, 0, 'no guessed placement without a table');
    dm.dispose();
  });

  test('getCoverageModel exposes the model built for the last run', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 4 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'DoWork', line: 12, column: 5, hits: 4 }],
    }];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result([], coverage), WS);

    const model = dm.getCoverageModel();
    assert.ok(model, 'a model should be retained after a run');
    assert.strictEqual(model!.forFile(FILE)?.lookup('DoWork', 0)?.hits, 4);
    dm.dispose();
  });
});
