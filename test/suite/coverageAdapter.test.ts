import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import { toVsCodeCoverage, getDetails } from '../../src/execution/coverageAdapter';
import { FileCoverage } from '../../src/execution/protocolV2Types';

suite('coverageAdapter', () => {
  test('one input file → one FileCoverage', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 10, hits: 1 }, { line: 11, hits: 0 }],
      totalStatements: 2,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1);
  });

  test('1-indexed statement position → 0-indexed Range', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 42, hits: 3 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 42, column: 1, endLine: 42, endColumn: 10, hits: 3 }],
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail.length, 1);
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 41);
    assert.strictEqual(range.start.character, 0);
    assert.strictEqual(range.end.line, 41);
    assert.strictEqual(range.end.character, 9);
  });

  test('hits count preserved verbatim (per-statement)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 1, hits: 7 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 7 }],
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail[0].executed, 7);
  });

  test('zero-hit statement preserved (executed = 0)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 5, hits: 0 }],
      totalStatements: 1,
      hitStatements: 0,
      statements: [{ id: 0, scope: 'S', line: 5, column: 1, hits: 0 }],
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail[0].executed, 0);
  });

  test('empty input → empty output', () => {
    assert.deepStrictEqual(toVsCodeCoverage([]), []);
  });

  test('empty lines array on a FileCoverage → empty detailedCoverage', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [],
      totalStatements: 5,
      hitStatements: 0,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail.length, 0);
  });

  test('multiple files preserved in input order', () => {
    const input: FileCoverage[] = [
      { file: path.resolve('/tmp/a.al'), lines: [], totalStatements: 1, hitStatements: 0 },
      { file: path.resolve('/tmp/b.al'), lines: [], totalStatements: 1, hitStatements: 1 },
    ];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 2);
    assert.ok(out[0].uri.fsPath.endsWith('a.al'));
    assert.ok(out[1].uri.fsPath.endsWith('b.al'));
  });

  test('FileCoverage statementCoverage totals come through', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [],
      totalStatements: 10,
      hitStatements: 7,
    }];
    const out = toVsCodeCoverage(input);
    const sc = out[0].statementCoverage;
    assert.strictEqual(sc.covered, 7);
    assert.strictEqual(sc.total, 10);
  });

  test('relative-path file becomes Uri.file with that path', () => {
    // AL.Runner emits forward-slash relative paths from project root.
    // The adapter should produce a Uri.file from them — VS Code resolves
    // relative-vs-absolute on the platform side. We just ensure no crash
    // and the path round-trips.
    const input: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 1, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1);
    // Uri.file('src/Foo.al') normalizes — at minimum the path string mentions Foo.al.
    assert.ok(out[0].uri.toString().includes('Foo.al'));
  });

  // --- Reviewer fixups (Plan E2 Task 7) -----------------------------------

  test('multiple statements in one file: distinct ranges, distinct executed', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      totalStatements: 3,
      hitStatements: 2,
      lines: [{ line: 5, hits: 2 }, { line: 8, hits: 0 }, { line: 12, hits: 1 }],
      statements: [
        { id: 0, scope: 'S', line: 5, column: 1, hits: 2 },
        { id: 1, scope: 'S', line: 8, column: 1, hits: 0 },
        { id: 2, scope: 'S', line: 12, column: 1, hits: 1 },
      ],
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.deepStrictEqual(
      detail.map(d => (d.location as vscode.Range).start.line),
      [4, 7, 11],
    );
    assert.deepStrictEqual(detail.map(d => d.executed), [2, 0, 1]);
  });

  test('StatementCoverage.branches is empty (no branch data emitted)', () => {
    const out = toVsCodeCoverage([{
      file: path.resolve('/tmp/a.al'),
      lines: [{ line: 1, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }],
    }]);
    const detail = getDetails(out[0])!;
    assert.deepStrictEqual(detail[0].branches, []);
  });

  test('FileCoverage branchCoverage / declarationCoverage are undefined', () => {
    const out = toVsCodeCoverage([{
      file: path.resolve('/tmp/a.al'),
      lines: [],
      totalStatements: 0,
      hitStatements: 0,
    }]);
    assert.strictEqual(out[0].branchCoverage, undefined);
    assert.strictEqual(out[0].declarationCoverage, undefined);
  });

  test('order is input-driven, not alphabetical', () => {
    const out = toVsCodeCoverage([
      { file: path.resolve('/tmp/z.al'), lines: [], totalStatements: 1, hitStatements: 0 },
      { file: path.resolve('/tmp/a.al'), lines: [], totalStatements: 1, hitStatements: 0 },
    ]);
    assert.ok(out[0].uri.fsPath.endsWith('z.al'));
    assert.ok(out[1].uri.fsPath.endsWith('a.al'));
  });

  test('large hits value passes through unmodified (no max-1 clamping)', () => {
    const out = toVsCodeCoverage([{
      file: path.resolve('/tmp/a.al'),
      totalStatements: 1,
      hitStatements: 1,
      lines: [{ line: 1, hits: 999_999 }],
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 999_999 }],
    }]);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail[0].executed, 999_999);
  });

  test('two calls produce independent instances with equal values', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/a.al'),
      totalStatements: 1,
      hitStatements: 1,
      lines: [{ line: 1, hits: 1 }],
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }],
    }];
    const a = toVsCodeCoverage(input)[0];
    const b = toVsCodeCoverage(input)[0];
    assert.notStrictEqual(a, b); // different FileCoverage instances
    assert.strictEqual(a.statementCoverage.total, b.statementCoverage.total);
    assert.strictEqual(a.statementCoverage.covered, b.statementCoverage.covered);
    // Detail arrays are also independent.
    const detailA = getDetails(a)!;
    const detailB = getDetails(b)!;
    assert.notStrictEqual(detailA, detailB);
    assert.strictEqual(detailA[0].executed, detailB[0].executed);
  });
});

suite('coverageAdapter — statement table', () => {
  test('statement with end position becomes a Range, not a bare Position', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 12, hits: 10 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, endLine: 12, endColumn: 24, hits: 10 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    assert.strictEqual(detail.length, 1);
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 11);
    assert.strictEqual(range.start.character, 4);
    assert.strictEqual(range.end.line, 11);
    assert.strictEqual(range.end.character, 23);
    assert.strictEqual(detail[0].executed, 10);
  });

  test('two statements on one line produce two details with distinct counts', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 4, hits: 4 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'S', line: 4, column: 5, endLine: 4, endColumn: 20, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, endLine: 4, endColumn: 40, hits: 1 },
      ],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    assert.strictEqual(detail.length, 2);
    assert.deepStrictEqual(detail.map(d => d.executed), [3, 1]);
  });

  test('statement without end position collapses to a zero-width range at its start', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 7, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 7, column: 3, hits: 1 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 6);
    assert.strictEqual(range.start.character, 2);
    assert.strictEqual(range.end.line, 6);
    assert.strictEqual(range.end.character, 2);
  });

  test('statement with only endLine (no endColumn) collapses to a zero-width range at its start', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 7, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 7, column: 3, endLine: 9, hits: 1 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 6);
    assert.strictEqual(range.start.character, 2);
    assert.strictEqual(range.end.line, 6);
    assert.strictEqual(range.end.character, 2);
  });

  test('statement with only endColumn (no endLine) collapses to a zero-width range at its start', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 7, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 7, column: 3, endColumn: 30, hits: 1 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 6);
    assert.strictEqual(range.start.character, 2);
    assert.strictEqual(range.end.line, 6);
    assert.strictEqual(range.end.character, 2);
  });

  test('runner totals still drive TestCoverageCount, not the detail array length', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [],
      totalStatements: 10,
      hitStatements: 7,
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }],
    }];
    const fc = toVsCodeCoverage(input)[0];
    assert.strictEqual(fc.statementCoverage.covered, 7);
    assert.strictEqual(fc.statementCoverage.total, 10);
  });

  test('no statement table yields no details (2.7.0 required)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 10, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1, 'the file still reports summary coverage');
    assert.deepStrictEqual(getDetails(out[0]), []);
  });
});
