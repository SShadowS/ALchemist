import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import { toVsCodeCoverage } from '../../src/execution/coverageAdapter';
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
    const detail = (out[0] as unknown as { detailedCoverage: vscode.StatementCoverage[] }).detailedCoverage;
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
    const detail = (out[0] as unknown as { detailedCoverage: vscode.StatementCoverage[] }).detailedCoverage;
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
    const detail = (out[0] as unknown as { detailedCoverage: vscode.StatementCoverage[] }).detailedCoverage;
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
    const detail = (out[0] as unknown as { detailedCoverage: vscode.StatementCoverage[] }).detailedCoverage;
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
});
