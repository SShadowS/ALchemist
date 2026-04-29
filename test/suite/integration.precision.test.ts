import * as assert from 'assert';
import * as path from 'path';
import { ParseCache } from '../../src/symbols/parseCache';
import { SymbolIndex } from '../../src/symbols/symbolIndex';
import { TreeSitterTestRouter } from '../../src/routing/treeSitterTestRouter';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { routeSave } from '../../src/extension';

const WASM_DIR = path.resolve(__dirname, '../../../dist');
const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('Integration — precision routing', () => {
  let cache: ParseCache;
  suiteSetup(async () => {
    cache = new ParseCache(WASM_DIR);
    await cache.initialize();
  });
  suiteTeardown(() => cache.dispose());

  test('symbol-index fixture: save table file → precision tier with one test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'symbol-index')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const router = new TreeSitterTestRouter(index);

    const file = path.join(FIX, 'symbol-index/MainApp/src/AlertSESTM.Table.al');
    const plan = routeSave(file, 'current', model, router);
    assert.strictEqual(plan.tier, 'precision');
    assert.ok(plan.affectedTests.length >= 1);

    index.dispose();
    router.dispose();
  });

  test('symbol-index fixture: save test codeunit → precision tier with that test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'symbol-index')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const router = new TreeSitterTestRouter(index);

    const file = path.join(FIX, 'symbol-index/MainApp.Test/src/AlertEngine.Test.Codeunit.al');
    const plan = routeSave(file, 'current', model, router);
    assert.strictEqual(plan.tier, 'precision');
    assert.ok(plan.affectedTests.some(t => t.procName === 'NewReturnsTrue'));

    index.dispose();
    router.dispose();
  });

  test('multi-app fixture: save MainApp/src/SomeCodeunit.Codeunit.al → precision finds ComputeDoubles + ComputeZero', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const router = new TreeSitterTestRouter(index);

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = routeSave(file, 'current', model, router);
    assert.strictEqual(plan.tier, 'precision');
    const procNames = plan.affectedTests.map(t => t.procName).sort();
    assert.deepStrictEqual(procNames, ['ComputeDoubles', 'ComputeZero']);

    index.dispose();
    router.dispose();
  });

  test('file outside any AL app → fallback with reason', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const router = new TreeSitterTestRouter(index);

    const plan = routeSave('/elsewhere/x.al', 'current', model, router);
    assert.strictEqual(plan.tier, 'fallback');
    assert.strictEqual(plan.reason, 'file outside any AL app');

    index.dispose();
    router.dispose();
  });
});
