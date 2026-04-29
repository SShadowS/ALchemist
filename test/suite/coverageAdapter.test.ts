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

  test('1-indexed line → 0-indexed Position', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 42, hits: 3 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail.length, 1);
    const pos = detail[0].location as vscode.Position;
    assert.strictEqual(pos.line, 41);
    assert.strictEqual(pos.character, 0);
  });

  test('hits count preserved verbatim (sum semantics)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 1, hits: 7 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.strictEqual(detail[0].executed, 7);
  });

  test('zero-hit line preserved (executed = 0)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 5, hits: 0 }],
      totalStatements: 1,
      hitStatements: 0,
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

  test('multiple lines in one file: distinct positions, distinct executed', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      totalStatements: 3,
      hitStatements: 2,
      lines: [{ line: 5, hits: 2 }, { line: 8, hits: 0 }, { line: 12, hits: 1 }],
    }];
    const out = toVsCodeCoverage(input);
    const detail = getDetails(out[0])!;
    assert.deepStrictEqual(
      detail.map(d => (d.location as vscode.Position).line),
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

  test('large hits value passes through unmodified (sum, not max-1)', () => {
    const out = toVsCodeCoverage([{
      file: path.resolve('/tmp/a.al'),
      totalStatements: 1,
      hitStatements: 1,
      lines: [{ line: 1, hits: 999_999 }],
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
