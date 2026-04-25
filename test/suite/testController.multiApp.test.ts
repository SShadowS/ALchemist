import * as assert from 'assert';
import * as path from 'path';
import { buildTestTree } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('TestController — buildTestTree (pure)', () => {
  test('multi-app fixture produces App→Codeunit→Procedure tree', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const tree = buildTestTree(model);

    assert.strictEqual(tree.length, 2);
    const mainAppNode = tree.find(n => n.app.name === 'MainApp');
    const testAppNode = tree.find(n => n.app.name === 'MainApp.Test');
    assert.ok(mainAppNode);
    assert.ok(testAppNode);

    assert.strictEqual(mainAppNode!.codeunits.length, 0, 'MainApp has no tests');
    assert.strictEqual(testAppNode!.codeunits.length, 1, 'MainApp.Test has one test codeunit');

    const codeunit = testAppNode!.codeunits[0];
    assert.strictEqual(codeunit.codeunitName, 'SomeTestCodeunit');
    assert.deepStrictEqual(
      codeunit.tests.map(t => t.name).sort(),
      ['ComputeDoubles', 'ComputeZero'],
    );
  });

  test('single-app fixture produces one app node', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();
    const tree = buildTestTree(model);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].codeunits.length, 1);
  });

  test('no-app fixture produces empty tree', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'no-app')]);
    await model.scan();
    const tree = buildTestTree(model);
    assert.deepStrictEqual(tree, []);
  });
});
