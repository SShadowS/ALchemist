import * as assert from 'assert';
import * as path from 'path';
import { findAppJsonRootsIn } from '../../src/workspace/workspaceModel';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('WorkspaceModel — findAppJsonRootsIn', () => {
  test('finds both apps in multi-app fixture root', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'multi-app'));
    const names = roots.map(r => path.basename(r)).sort();
    assert.deepStrictEqual(names, ['MainApp', 'MainApp.Test']);
  });

  test('finds single app in single-app fixture', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'single-app'));
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(path.basename(roots[0]), 'single-app');
  });

  test('returns empty for fixture with no app.json', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'no-app'));
    assert.deepStrictEqual(roots, []);
  });

  test('stops descent at first app.json (no nested roots)', () => {
    // multi-app/MainApp has app.json; MainApp/src does not have another.
    // Ensure the walker doesn't attempt to recurse past the app root.
    const roots = findAppJsonRootsIn(path.join(FIX, 'multi-app/MainApp'));
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0], path.join(FIX, 'multi-app/MainApp'));
  });

  test('skips excluded directories', () => {
    // Build an on-the-fly fixture under os.tmpdir() since we don't want to
    // commit node_modules to test/fixtures. Use fs for this single test.
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-ws-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'app.json'),
        JSON.stringify({ id: 'x', name: 'Should Not Find', publisher: 'p', version: '1.0.0.0' }));
      fs.mkdirSync(path.join(tmp, 'RealApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'RealApp', 'app.json'),
        JSON.stringify({ id: 'y', name: 'RealApp', publisher: 'p', version: '1.0.0.0' }));
      const roots = findAppJsonRootsIn(tmp);
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(path.basename(roots[0]), 'RealApp');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('WorkspaceModel — scan + lookups', () => {
  test('scan() populates two apps from multi-app fixture', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const apps = model.getApps();
    const names = apps.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['MainApp', 'MainApp.Test']);
  });

  test('scan() handles multi-root (two workspaceFolders)', async () => {
    const model = new WorkspaceModel([
      path.join(FIX, 'multi-app/MainApp'),
      path.join(FIX, 'multi-app/MainApp.Test'),
    ]);
    await model.scan();
    const apps = model.getApps();
    assert.strictEqual(apps.length, 2);
  });

  test('getAppContaining returns the owning app for a file inside', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const app = model.getAppContaining(file);
    assert.ok(app, 'should resolve an app');
    assert.strictEqual(app!.name, 'MainApp');
  });

  test('getAppContaining returns undefined for file outside any app', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'no-app/Scratch.al');
    assert.strictEqual(model.getAppContaining(file), undefined);
  });

  test('getAppContaining picks the most specific (deepest) app path', async () => {
    // Synthetic: two apps where one path is a parent of the other's src.
    // This shouldn't happen in AL (no nested apps) but the lookup must still
    // be deterministic — prefer the longest matching path.
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const app = model.getAppContaining(file);
    assert.strictEqual(app!.name, 'MainApp.Test');
  });

  test('getApps returns empty when no workspaceFolders provided', async () => {
    const model = new WorkspaceModel([]);
    await model.scan();
    assert.deepStrictEqual(model.getApps(), []);
  });

  test('malformed app.json is skipped with warning', async () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-ws-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'GoodApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'GoodApp', 'app.json'),
        JSON.stringify({ id: 'g', name: 'GoodApp', publisher: 'p', version: '1.0.0.0' }));
      fs.mkdirSync(path.join(tmp, 'BadApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'BadApp', 'app.json'), '{ not json');

      const warnings: string[] = [];
      const model = new WorkspaceModel([tmp], msg => warnings.push(msg));
      await model.scan();
      const names = model.getApps().map(a => a.name);
      assert.deepStrictEqual(names, ['GoodApp']);
      assert.ok(warnings.some(w => w.includes('BadApp')), 'expected warning for BadApp');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
