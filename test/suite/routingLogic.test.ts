import * as assert from 'assert';
import * as path from 'path';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { planSaveRuns, SaveRunPlan } from '../../src/testing/saveRouting';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('saveRouting.planSaveRuns (fallback tier)', () => {
  test('saving a file in MainApp triggers runs in MainApp + MainApp.Test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    const appNames = plan.map(p => p.appName).sort();
    assert.deepStrictEqual(appNames, ['MainApp', 'MainApp.Test']);
  });

  test('saving a file in MainApp.Test triggers run only in MainApp.Test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].appName, 'MainApp.Test');
  });

  test('scope=all returns every app regardless of saved file location', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'all');
    const appNames = plan.map(p => p.appName).sort();
    assert.deepStrictEqual(appNames, ['MainApp', 'MainApp.Test']);
  });

  test('scope=off returns empty', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'off');
    assert.deepStrictEqual(plan, []);
  });

  test('file outside any app returns empty plan', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'no-app/Scratch.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.deepStrictEqual(plan, []);
  });

  test('single-app workspace: save in that app runs its tests', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();

    const file = path.join(FIX, 'single-app/src/OnlyCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].appName, 'SingleApp');
  });

  // --- Extra tests (self-review: "more tests is better") ---

  test('plan entries have unique appIds (no duplicates from transitive convergence)', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    const ids = plan.map(p => p.appId);
    const uniqueIds = [...new Set(ids)];
    assert.deepStrictEqual(ids.sort(), uniqueIds.sort(), 'No duplicate appIds in plan');
  });

  test('plan entries include appPath for each returned app', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    for (const entry of plan) {
      assert.ok(entry.appPath, `appPath should be non-empty for app ${entry.appName}`);
      assert.ok(typeof entry.appPath === 'string');
    }
  });

  test('scope=all returns unique appIds (no duplicates)', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'all');
    const ids = plan.map(p => p.appId);
    const uniqueIds = [...new Set(ids)];
    assert.deepStrictEqual(ids.sort(), uniqueIds.sort(), 'No duplicate appIds in scope=all plan');
  });

  test('scope=off returns empty even for file outside any app', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'no-app/Scratch.al');
    const plan = planSaveRuns(file, model, 'off');
    assert.deepStrictEqual(plan, []);
  });

  test('scope=all with single-app workspace returns that single app', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();

    const file = path.join(FIX, 'single-app/src/OnlyCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'all');
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].appName, 'SingleApp');
  });

  test('SaveRunPlan entries carry all required fields (appId, appName, appPath)', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();

    const file = path.join(FIX, 'single-app/src/OnlyCodeunit.Codeunit.al');
    const [entry] = planSaveRuns(file, model, 'current');
    assert.ok(entry.appId, 'appId should be set');
    assert.ok(entry.appName, 'appName should be set');
    assert.ok(entry.appPath, 'appPath should be set');
    assert.strictEqual(entry.appName, 'SingleApp');
    assert.strictEqual(entry.appId, '33333333-3333-3333-3333-333333333333');
  });
});
