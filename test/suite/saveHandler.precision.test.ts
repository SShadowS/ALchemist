import * as assert from 'assert';
import * as path from 'path';
import { routeSave } from '../../src/extension';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { TestRouter, TestRoutingResult } from '../../src/routing/testRouter';
import { AlApp } from '../../src/workspace/types';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

class FakeRouter implements TestRouter {
  constructor(private result: TestRoutingResult, private available = true) {}
  isAvailable() { return this.available; }
  getTestsAffectedBy(_file: string, _app: AlApp) { return this.result; }
  dispose() {}
}

suite('routeSave', () => {
  test('scope=off returns empty fallback', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const plan = routeSave('/anything.al', 'off', model, undefined);
    assert.strictEqual(plan.tier, 'fallback');
    assert.deepStrictEqual(plan.apps, []);
  });

  test('scope=all returns all apps in fallback tier', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const plan = routeSave('/anything.al', 'all', model, undefined);
    assert.strictEqual(plan.tier, 'fallback');
    assert.strictEqual(plan.apps.length, 2);
  });

  test('scope=current with confident router returns precision tier', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const router = new FakeRouter({
      confident: true,
      tests: [{ codeunitId: 50100, codeunitName: 'X', procName: 'a', line: 0 }],
    });
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = routeSave(file, 'current', model, router);
    assert.strictEqual(plan.tier, 'precision');
    assert.strictEqual(plan.affectedTests.length, 1);
  });

  test('scope=current with non-confident router returns fallback with reason', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const router = new FakeRouter({ confident: false, reason: 'parse errors' });
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = routeSave(file, 'current', model, router);
    assert.strictEqual(plan.tier, 'fallback');
    assert.strictEqual(plan.reason, 'parse errors');
  });

  test('scope=current with file outside any app returns fallback', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const plan = routeSave('/elsewhere/file.al', 'current', model, undefined);
    assert.strictEqual(plan.tier, 'fallback');
    assert.strictEqual(plan.reason, 'file outside any AL app');
  });

  test('scope=current without router returns fallback with reason "router not ready"', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = routeSave(file, 'current', model, undefined);
    assert.strictEqual(plan.tier, 'fallback');
    assert.strictEqual(plan.reason, 'router not ready');
  });
});
