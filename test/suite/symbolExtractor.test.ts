import * as assert from 'assert';
import * as path from 'path';
import { ParseCache } from '../../src/symbols/parseCache';
import { extractSymbols } from '../../src/symbols/symbolExtractor';

const WASM_DIR = path.resolve(__dirname, '../../../dist');

let cache: ParseCache;
suiteSetup(async () => {
  cache = new ParseCache(WASM_DIR);
  await cache.initialize();
  if (!cache.isAvailable()) throw new Error('WASM unavailable; build webpack first');
});
suiteTeardown(() => cache.dispose());

function parse(file: string, content: string) {
  const r = cache.parse(file, content);
  if (!r) throw new Error('parse failed');
  return r;
}

suite('SymbolExtractor', () => {
  test('extracts quoted codeunit declaration', () => {
    const r = parse('/T.al', 'codeunit 50000 "My Codeunit" { }');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared.length, 1);
    assert.strictEqual(f.declared[0].kind, 'codeunit');
    assert.strictEqual(f.declared[0].name, 'My Codeunit');
    assert.strictEqual(f.declared[0].id, 50000);
  });

  test('extracts unquoted codeunit declaration', () => {
    const r = parse('/T.al', 'codeunit 50000 MyCodeunit { }');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared[0].name, 'MyCodeunit');
  });

  test('extracts namespace + usings', () => {
    const r = parse('/T.al', `
namespace STM.X.Y;

using STM.X;
using A.B;

codeunit 50000 Foo { }`);
    const f = extractSymbols(r);
    assert.strictEqual(f.namespace, 'STM.X.Y');
    assert.deepStrictEqual(f.usings, ['STM.X', 'A.B']);
  });

  test('builds FqName from namespace + declared name', () => {
    const r = parse('/T.al', 'namespace STM.X; codeunit 50000 Foo { }');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared[0].fqName, 'STM.X.Foo');
  });

  test('FqName is bare when no namespace', () => {
    const r = parse('/T.al', 'codeunit 50000 Foo { }');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared[0].fqName, 'Foo');
  });

  test('extracts [Test] procedure (single attribute)', () => {
    const r = parse('/T.al', `
codeunit 50000 TestCu {
    Subtype = Test;
    [Test]
    procedure DoTest()
    begin end;
}`);
    const f = extractSymbols(r);
    assert.strictEqual(f.tests.length, 1);
    assert.strictEqual(f.tests[0].procName, 'DoTest');
    assert.strictEqual(f.tests[0].codeunitName, 'TestCu');
  });

  test('extracts [Test, HandlerFunctions(...)] combined-attribute test (closes Plan A regex gap)', () => {
    const r = parse('/T.al', `
codeunit 50000 TestCu {
    Subtype = Test;
    [Test, HandlerFunctions('H')]
    procedure DoTest()
    begin end;
}`);
    const f = extractSymbols(r);
    assert.strictEqual(f.tests.length, 1, 'combined attrs MUST be detected via tree-sitter grammar');
    assert.strictEqual(f.tests[0].procName, 'DoTest');
  });

  test('extracts stacked [Test]\\n[HandlerFunctions(...)] test', () => {
    const r = parse('/T.al', `
codeunit 50000 TestCu {
    Subtype = Test;
    [Test]
    [HandlerFunctions('H')]
    procedure DoTest()
    begin end;
}`);
    const f = extractSymbols(r);
    assert.strictEqual(f.tests.length, 1);
  });

  test('extracts Record reference', () => {
    const r = parse('/T.al', `
codeunit 50000 Foo {
    procedure Run() var c: Record Customer; begin end;
}`);
    const f = extractSymbols(r);
    const refs = f.references.filter(r => r.kind === 'table');
    assert.ok(refs.some(r => r.name === 'Customer'), 'Record reference missing');
  });

  test('extracts Codeunit type reference', () => {
    const r = parse('/T.al', `
codeunit 50000 Foo {
    procedure Run() var c: Codeunit Bar; begin end;
}`);
    const f = extractSymbols(r);
    const refs = f.references.filter(r => r.kind === 'codeunit');
    assert.ok(refs.some(r => r.name === 'Bar'));
  });

  test('comment containing [Test] does not produce false test', () => {
    const r = parse('/T.al', `
codeunit 50000 Foo {
    procedure Run()
    begin
        // [Test] this is a comment
    end;
}`);
    const f = extractSymbols(r);
    assert.strictEqual(f.tests.length, 0);
  });

  test('empty file returns empty FileSymbols', () => {
    const r = parse('/T.al', '');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared.length, 0);
    assert.strictEqual(f.references.length, 0);
    assert.strictEqual(f.tests.length, 0);
    assert.strictEqual(f.namespace, undefined);
  });

  test('table declaration extraction', () => {
    const r = parse('/T.al', 'table 50000 MyTable { fields { field(1; Id; Integer) { } } keys { key(PK; Id) { } } }');
    const f = extractSymbols(r);
    assert.strictEqual(f.declared.length, 1);
    assert.strictEqual(f.declared[0].kind, 'table');
    assert.strictEqual(f.declared[0].id, 50000);
  });

  test('multiple declarations in one file', () => {
    const r = parse('/T.al', `
codeunit 50000 A { }
codeunit 50001 B { }`);
    const f = extractSymbols(r);
    assert.strictEqual(f.declared.length, 2);
  });
});
