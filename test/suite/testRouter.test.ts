import * as assert from 'assert';
import * as path from 'path';
import { ParseCache } from '../../src/symbols/parseCache';
import { SymbolIndex } from '../../src/symbols/symbolIndex';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { TreeSitterTestRouter } from '../../src/routing/treeSitterTestRouter';

const WASM_DIR = path.resolve(__dirname, '../../../dist');
const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('TreeSitterTestRouter', () => {
  test('returns confident result with tests when index returns non-null', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);

    const router = new TreeSitterTestRouter(index);
    const app = model.getApps().find(a => a.name === 'MainApp')!;
    const result = router.getTestsAffectedBy(
      path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al'),
      app,
    );
    assert.strictEqual(result.confident, true);
    if (!result.confident) return;
    assert.ok(result.tests.length >= 1);

    cache.dispose();
    index.dispose();
    router.dispose();
  });

  test('isAvailable mirrors index.isReady', async () => {
    const cache = new ParseCache(WASM_DIR);
    await cache.initialize();
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    const router = new TreeSitterTestRouter(index);
    assert.strictEqual(router.isAvailable(), false, 'before init');
    await index.initialize(model, cache);
    assert.strictEqual(router.isAvailable(), true, 'after init');

    cache.dispose();
    index.dispose();
    router.dispose();
  });

  test('returns not-confident with reason when index returns null', async () => {
    const fakeIndex: any = {
      isReady: () => true,
      isSettled: () => true,
      getTestsAffectedBy: () => null,
    };
    const router = new TreeSitterTestRouter(fakeIndex);
    const result = router.getTestsAffectedBy('/x.al', { id: 'a', name: 'A', publisher: 'p', version: '1', path: '/', dependencies: [] });
    assert.strictEqual(result.confident, false);
    if (result.confident) return;
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    router.dispose();
  });

  test('returns not-confident reason "symbol index not ready" before init', () => {
    const fakeIndex: any = {
      isReady: () => false,
      isSettled: () => false,
      getTestsAffectedBy: () => null,
    };
    const router = new TreeSitterTestRouter(fakeIndex);
    const result = router.getTestsAffectedBy('/x.al', { id: 'a', name: 'A', publisher: 'p', version: '1', path: '/', dependencies: [] });
    assert.strictEqual(result.confident, false);
    if (result.confident) return;
    assert.ok(/not ready/i.test(result.reason));
    router.dispose();
  });

  test('returns not-confident reason "awaiting reparse" when index unsettled', () => {
    const fakeIndex: any = {
      isReady: () => true,
      isSettled: () => false,
      getTestsAffectedBy: () => null,
    };
    const router = new TreeSitterTestRouter(fakeIndex);
    const result = router.getTestsAffectedBy('/x.al', { id: 'a', name: 'A', publisher: 'p', version: '1', path: '/', dependencies: [] });
    assert.strictEqual(result.confident, false);
    if (result.confident) return;
    assert.ok(/awaiting reparse|reparse/i.test(result.reason));
    router.dispose();
  });
});
