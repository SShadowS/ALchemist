import * as assert from 'assert';
import * as path from 'path';
import { CoverageModel } from '../../src/execution/coverageModel';
import { FileCoverage } from '../../src/execution/protocolV2Types';

const WS = path.resolve('/ws');

function fc(file: string, statements: FileCoverage['statements']): FileCoverage {
  return { file, lines: [], totalStatements: statements?.length ?? 0, hitStatements: 0, statements };
}

suite('CoverageModel', () => {
  test('lookup by (scope, id) returns the statement record', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'MyProcedure', line: 12, column: 5, endLine: 12, endColumn: 24, hits: 10 },
        { id: 1, scope: 'MyProcedure', line: 13, column: 5, hits: 1 },
      ]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'));
    assert.ok(index, 'expected an index for the file');
    const record = index.lookup('MyProcedure', 0);
    assert.strictEqual(record?.line, 12);
    assert.strictEqual(record?.hits, 10);
  });

  test('scope lookup is case-insensitive (AL identifiers are)', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'MyProcedure', line: 7, column: 1, hits: 2 }]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    assert.strictEqual(index.lookup('myprocedure', 0)?.line, 7);
    assert.strictEqual(index.lookup('MYPROCEDURE', 0)?.line, 7);
  });

  test('unknown scope or id returns undefined, never a guess', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'MyProcedure', line: 7, column: 1, hits: 2 }]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    assert.strictEqual(index.lookup('OtherProcedure', 0), undefined);
    assert.strictEqual(index.lookup('MyProcedure', 99), undefined);
  });

  test('statementsOnLine groups multiple statements sharing one line', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'S', line: 4, column: 5, endLine: 4, endColumn: 20, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, endLine: 4, endColumn: 40, hits: 1 },
        { id: 2, scope: 'S', line: 5, column: 5, hits: 1 },
      ]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    const onFour = index.statementsOnLine(4);
    assert.strictEqual(onFour.length, 2);
    assert.deepStrictEqual(onFour.map(s => s.column), [5, 22]);
    assert.strictEqual(index.statementsOnLine(5).length, 1);
    assert.strictEqual(index.statementsOnLine(99).length, 0);
  });

  test('lineRollup takes the max hits on a line, not the sum', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'S', line: 4, column: 5, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, hits: 1 },
      ]),
    ], WS);

    const rollup = model.forFile(path.join(WS, 'src', 'Foo.al'))!.lineRollup();
    assert.strictEqual(rollup.get(4), 3);
  });

  test('path normalization matches all three producer shapes', () => {
    const target = path.join(WS, 'src', 'Foo.al');
    const shapes = [
      'src/Foo.al',                                    // workspace-relative, forward slashes
      path.resolve(WS, 'src/Foo.al').replace(/\\/g, '/'), // absolute, forward slashes
      path.join(WS, 'src', 'Foo.al'),                  // absolute, native slashes
    ];
    for (const shape of shapes) {
      const model = CoverageModel.fromFileCoverage([
        fc(shape, [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
      ], WS);
      assert.ok(model.forFile(target), `expected a match for producer shape ${shape}`);
    }
  });

  test('file matching is case-insensitive (Windows paths)', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
    ], WS);
    assert.ok(model.forFile(path.join(WS, 'SRC', 'FOO.AL')));
  });

  test('hasStatements is false when no entry carries a statement table', () => {
    const legacy: FileCoverage[] = [
      { file: 'src/Foo.al', lines: [{ line: 3, hits: 1 }], totalStatements: 1, hitStatements: 1 },
    ];
    const model = CoverageModel.fromFileCoverage(legacy, WS);
    assert.strictEqual(model.hasStatements, false);
    assert.strictEqual(model.forFile(path.join(WS, 'src', 'Foo.al')), undefined);
  });

  test('hasStatements is true when at least one entry carries a statement table', () => {
    const model = CoverageModel.fromFileCoverage([
      { file: 'src/Bare.al', lines: [], totalStatements: 0, hitStatements: 0 },
      fc('src/Foo.al', [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
    ], WS);
    assert.strictEqual(model.hasStatements, true);
  });
});
