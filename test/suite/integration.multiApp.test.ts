import * as assert from 'assert';
import * as path from 'path';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { buildTestTree } from '../../src/testing/testController';
import { planSaveRuns } from '../../src/testing/saveRouting';
import { resolveScratchProjectApp } from '../../src/scratch/scratchManager';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('Integration — multi-app fixture end-to-end', () => {
  test('workspace scan → test tree → save plan roundtrip', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    // Scan finds both apps
    assert.strictEqual(model.getApps().length, 2);

    // Tree has both app nodes; MainApp.Test has the tests
    const tree = buildTestTree(model);
    const testAppNode = tree.find(n => n.app.name === 'MainApp.Test');
    assert.ok(testAppNode);
    assert.strictEqual(testAppNode!.codeunits.length, 1);
    assert.deepStrictEqual(
      testAppNode!.codeunits[0].tests.map(t => t.name).sort(),
      ['ComputeDoubles', 'ComputeZero'],
    );

    // Saving a file in MainApp routes to both apps
    const mainFile = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(mainFile, model, 'current');
    assert.deepStrictEqual(plan.map(p => p.appName).sort(), ['MainApp', 'MainApp.Test']);

    // Saving a file in MainApp.Test routes only to that app
    const testFile = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const plan2 = planSaveRuns(testFile, model, 'current');
    assert.deepStrictEqual(plan2.map(p => p.appName), ['MainApp.Test']);

    // Scratch-project resolution picks between two apps
    const resolution = resolveScratchProjectApp(model.getApps(), undefined, undefined);
    assert.strictEqual(resolution.mode, 'needsPrompt');
  });

  test('simulated app.json change flips tree and dep graph', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-int-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));
      fsp.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'),
        `codeunit 50000 Foo
{
    Subtype = Test;

    [Test]
    procedure X()
    begin
    end;
}`);

      const model = new WorkspaceModel([tmp]);
      await model.scan();
      assert.strictEqual(model.getApps().length, 1);
      assert.strictEqual(buildTestTree(model)[0].codeunits.length, 1);

      // Add a second app that depends on A
      fsp.mkdirSync(path.join(tmp, 'B'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'B', 'app.json'),
        JSON.stringify({
          id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
          dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }],
        }));

      let fired = 0;
      model.onDidChange(() => { fired++; });
      await model.triggerRescan();
      assert.strictEqual(fired, 1);
      assert.strictEqual(model.getApps().length, 2);

      const depsOfA = model.getDependents('a').map(a => a.name).sort();
      assert.deepStrictEqual(depsOfA, ['A', 'B']);
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Extra test 1: multi-folder workspace (separate workspaceFolders pointing at each app)
  test('multi-folder workspace (two separate workspaceFolders) scans both apps', async () => {
    const model = new WorkspaceModel([
      path.join(FIX, 'multi-app/MainApp'),
      path.join(FIX, 'multi-app/MainApp.Test'),
    ]);
    await model.scan();

    assert.strictEqual(model.getApps().length, 2);

    const tree = buildTestTree(model);
    const mainNode = tree.find(n => n.app.name === 'MainApp');
    const testNode = tree.find(n => n.app.name === 'MainApp.Test');

    assert.ok(mainNode, 'MainApp node present');
    assert.ok(testNode, 'MainApp.Test node present');
    assert.strictEqual(mainNode!.codeunits.length, 0, 'MainApp has no test codeunits');
    assert.strictEqual(testNode!.codeunits.length, 1, 'MainApp.Test has one test codeunit');

    // Save routing still works when workspace roots are separate folders
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.deepStrictEqual(plan.map(p => p.appName).sort(), ['MainApp', 'MainApp.Test']);
  });

  // Extra test 2: save in scratch/no-app file returns empty plan
  test('save in a file outside every app returns empty plan', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    // Use a path that is not under any known app
    const outsideFile = path.join(FIX, 'no-app', 'Scratch.al');
    const plan = planSaveRuns(outsideFile, model, 'current');
    assert.deepStrictEqual(plan, [], 'file outside any app produces empty save plan');
  });

  // Extra test 3: "Run All" simulation — every AlApp has a unique id
  test('Run All: every app in model.getApps() has a unique id', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const apps = model.getApps();
    const ids = apps.map(a => a.id);
    const uniqueIds = [...new Set(ids)];
    assert.deepStrictEqual(
      ids.sort(),
      uniqueIds.sort(),
      'all apps must have distinct ids to avoid run-all collisions',
    );
  });

  // Extra test 4: scratch resolution with single app returns mode='app', with 0 returns mode='standalone'
  test('resolveScratchProjectApp: single app → app mode; no apps → standalone mode', async () => {
    const singleAppModel = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await singleAppModel.scan();
    const single = resolveScratchProjectApp(singleAppModel.getApps(), undefined, undefined);
    assert.strictEqual(single.mode, 'app');

    const emptyModel = new WorkspaceModel([]);
    await emptyModel.scan();
    const empty = resolveScratchProjectApp(emptyModel.getApps(), undefined, undefined);
    assert.strictEqual(empty.mode, 'standalone');
  });
});

suite('Integration — sourcePaths include forward dependencies', () => {
  test('test mode sourcePaths include test app + main app paths', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const testApp = model.getApps().find(a => a.name === 'MainApp.Test')!;
    const depPaths = model.getDependencies(testApp.id).map(a => a.path);

    // Simulate the sourcePaths construction used by the save handler / runTests
    const sourcePaths = depPaths.length > 0 ? depPaths : [testApp.path];

    // Both app source folders should appear in sourcePaths
    const mainAppPath = model.getApps().find(a => a.name === 'MainApp')!.path;
    assert.ok(sourcePaths.includes(testApp.path), 'test app path included in sourcePaths');
    assert.ok(sourcePaths.includes(mainAppPath), 'main app path included as forward dep in sourcePaths');
  });
});
