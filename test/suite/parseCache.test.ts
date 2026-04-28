import * as assert from 'assert';
import * as path from 'path';
import { ParseCache } from '../../src/symbols/parseCache';

const WASM_DIR = path.resolve(__dirname, '../../../dist');

suite('ParseCache', () => {
  test('initialize() loads WASM successfully', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    assert.strictEqual(cache.isAvailable(), true);
    cache.dispose();
  });

  test('isAvailable() === false when WASM directory missing', async () => {
    const cache = new ParseCache('/path/that/does/not/exist');
    await cache.initialize();
    assert.strictEqual(cache.isAvailable(), false);
    cache.dispose();
  });

  test('parse() returns AST without errors for valid AL', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    const result = cache.parse('/fake/Foo.al', 'codeunit 50000 Foo { trigger OnRun() begin end; }');
    assert.ok(result, 'parse returned undefined');
    assert.strictEqual(result!.hasErrors, false);
    assert.ok(result!.ast.rootNode, 'AST root node missing');
    cache.dispose();
  });

  test('parse() of file with syntax error has hasErrors=true and preserves lastGood', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();

    const good = cache.parse('/fake/Foo.al', 'codeunit 50000 Foo { trigger OnRun() begin end; }');
    assert.ok(good && !good.hasErrors);

    const bad = cache.parse('/fake/Foo.al', 'codeunit 50000 Foo { trigger Onun() begin');
    assert.ok(bad);
    assert.strictEqual(bad!.hasErrors, true);

    const lastGood = cache.getLastGood('/fake/Foo.al');
    assert.ok(lastGood && !lastGood.hasErrors);
    cache.dispose();
  });

  test('parseIncremental() reuses prior tree (smoke check)', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    const initial = cache.parse('/fake/Foo.al', 'codeunit 50000 Foo { trigger OnRun() begin end; }');
    assert.ok(initial);
    const newContent = 'codeunit 50000 Foo { trigger OnRun() begin end; } // edit';
    const updated = cache.parseIncremental('/fake/Foo.al', newContent, {
      startIndex: initial!.ast.rootNode.endIndex,
      oldEndIndex: initial!.ast.rootNode.endIndex,
      newEndIndex: newContent.length,
      startPosition: { row: 0, column: initial!.ast.rootNode.endIndex },
      oldEndPosition: { row: 0, column: initial!.ast.rootNode.endIndex },
      newEndPosition: { row: 0, column: newContent.length },
    });
    assert.ok(updated);
    assert.strictEqual(updated!.hasErrors, false);
    cache.dispose();
  });

  test('invalidate() removes both current and lastGood', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    cache.parse('/fake/Foo.al', 'codeunit 50000 Foo { trigger OnRun() begin end; }');
    cache.invalidate('/fake/Foo.al');
    assert.strictEqual(cache.getLastGood('/fake/Foo.al'), undefined);
    cache.dispose();
  });

  test('parse() with timeout returns undefined or error-result for runaway input', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    cache.setParseTimeoutMs(1);
    const huge = 'codeunit 1 X{'.repeat(100_000);
    const result = cache.parse('/fake/huge.al', huge);
    // Either returns undefined (timeout) or returns a result with hasErrors=true.
    assert.ok(result === undefined || result.hasErrors === true);
    cache.dispose();
  });

  test('dispose() prevents further parsing', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    cache.dispose();
    assert.throws(() => cache.parse('/fake/Foo.al', 'codeunit 1 X{}'),
      /disposed|after dispose/i);
  });
});
