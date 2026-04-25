import * as assert from 'assert';
import * as path from 'path';
import { buildTestTree, groupTestItemsByApp } from '../../src/testing/testController';
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

suite('TestController — multi-app id uniqueness', () => {
  test('compound ids differ for same-named procs across two apps', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-collision-test-'));
    try {
      // App A with codeunit containing test "Setup"
      fsp.mkdirSync(path.join(tmp, 'AppA/src'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'AppA/app.json'),
        JSON.stringify({ id: 'aaa', name: 'AppA', publisher: 'p', version: '1.0.0.0' }));
      fsp.writeFileSync(path.join(tmp, 'AppA/src/T.al'),
        'codeunit 50000 ATest\n{\n  Subtype = Test;\n  [Test]\n  procedure Setup()\n  begin\n  end;\n}');

      // App B with codeunit containing test "Setup" too
      fsp.mkdirSync(path.join(tmp, 'AppB/src'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'AppB/app.json'),
        JSON.stringify({ id: 'bbb', name: 'AppB', publisher: 'p', version: '1.0.0.0' }));
      fsp.writeFileSync(path.join(tmp, 'AppB/src/T.al'),
        'codeunit 50100 BTest\n{\n  Subtype = Test;\n  [Test]\n  procedure Setup()\n  begin\n  end;\n}');

      const model = new WorkspaceModel([tmp]);
      await model.scan();

      const tree = buildTestTree(model);
      assert.strictEqual(tree.length, 2);

      // For each app's tree, build the compound id the same way refreshTestsFromModel does.
      const ids: string[] = [];
      for (const node of tree) {
        for (const cu of node.codeunits) {
          for (const t of cu.tests) {
            ids.push(`test-${node.app.id}-${cu.codeunitId}-${t.name}`);
          }
        }
      }
      assert.strictEqual(ids.length, 2, 'two test items expected');
      assert.notStrictEqual(ids[0], ids[1], 'compound ids must differ even when bare names collide');
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('TestController — groupTestItemsByApp', () => {
  test('groups items by owning app using their id prefix', () => {
    const aaa = '11111111-1111-1111-1111-111111111111';
    const bbb = '22222222-2222-2222-2222-222222222222';
    const items = [
      { id: `app-${aaa}` },
      { id: `codeunit-${aaa}-50100` },
      { id: `test-${aaa}-50100-Foo` },
      { id: `test-${bbb}-50200-Bar` },
    ];
    const groups = groupTestItemsByApp(items as any);
    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get(aaa)!.length, 3);
    assert.strictEqual(groups.get(bbb)!.length, 1);
  });

  test('items with unparseable ids land in an empty-id bucket', () => {
    const items = [{ id: 'something-weird' }];
    const groups = groupTestItemsByApp(items as any);
    assert.ok(groups.has(''));
  });

  test('non-GUID app id lands in the empty bucket (defensive)', () => {
    // Apps with non-standard ids should not crash the grouper.
    const items = [{ id: 'app-not-a-guid' }];
    const groups = groupTestItemsByApp(items as any);
    assert.ok(groups.has(''));
    assert.strictEqual(groups.get('')!.length, 1);
  });
});
