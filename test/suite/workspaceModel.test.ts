import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { findAppJsonRootsIn, bindWorkspaceModelToVsCode, FILE_WATCH_DEBOUNCE_MS } from '../../src/workspace/workspaceModel';
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
      assert.ok(names.includes('GoodApp'), 'GoodApp should be loaded');
      assert.strictEqual(names.length, 1, 'only one app should load');
      assert.ok(warnings.some(w => w.includes('BadApp')), 'expected warning for BadApp');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('WorkspaceModel — dep graph', () => {
  const fsp = require('fs');
  const os = require('os');
  let tmp: string;
  let model: WorkspaceModel;

  function writeApp(folder: string, app: any) {
    fsp.mkdirSync(path.join(tmp, folder), { recursive: true });
    fsp.writeFileSync(path.join(tmp, folder, 'app.json'), JSON.stringify(app));
  }

  setup(() => {
    tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-dep-test-'));
  });
  teardown(() => {
    fsp.rmSync(tmp, { recursive: true, force: true });
  });

  test('getDependents: A is base, B depends on A, C depends on B', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('C', { id: 'c', name: 'C', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });

    model = new WorkspaceModel([tmp]);
    await model.scan();

    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A', 'B', 'C'], 'A plus transitive dependents B and C');

    const depsOfB = model.getDependents('b').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfB, ['B', 'C']);

    const depsOfC = model.getDependents('c').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfC, ['C'], 'leaf has only itself');
  });

  test('getDependents returns empty array for unknown appId', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    model = new WorkspaceModel([tmp]);
    await model.scan();
    assert.deepStrictEqual(model.getDependents('nonexistent'), []);
  });

  test('cycle A <-> B handled without infinite recursion', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });

    const warnings: string[] = [];
    model = new WorkspaceModel([tmp], m => warnings.push(m));
    await model.scan();

    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A', 'B']);
    assert.ok(warnings.some(w => /cycle/i.test(w)), 'expected cycle warning');
  });

  test('cycle warning fires only once across multiple getDependents calls per scan', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });

    const warnings: string[] = [];
    model = new WorkspaceModel([tmp], m => warnings.push(m));
    await model.scan();

    model.getDependents('a');
    model.getDependents('b');
    model.getDependents('a'); // call again

    const cycleWarnings = warnings.filter(w => /cycle/i.test(w));
    assert.strictEqual(cycleWarnings.length, 1, 'cycle warning should fire exactly once per scan');
  });

  test('rescan resets cycle warning state (warning fires once after each scan)', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });

    const warnings: string[] = [];
    model = new WorkspaceModel([tmp], m => warnings.push(m));
    await model.scan();
    model.getDependents('a'); // fires warning #1

    await model.scan(); // re-scan
    model.getDependents('a'); // should fire warning #2 since cache was reset

    const cycleWarnings = warnings.filter(w => /cycle/i.test(w));
    assert.strictEqual(cycleWarnings.length, 2, 'cycle warning fires once per scan');
  });

  test('getDependents: diamond — A is base, B and C depend on A, D depends on B and C', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('C', { id: 'c', name: 'C', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('D', { id: 'd', name: 'D', publisher: 'p', version: '1.0.0.0',
      dependencies: [
        { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' },
        { id: 'c', name: 'C', publisher: 'p', version: '1.0.0.0' },
      ] });

    model = new WorkspaceModel([tmp]);
    await model.scan();

    // getDependents(A) = A itself + B + C (direct) + D (transitive via B and C)
    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A', 'B', 'C', 'D'], 'diamond: A + B + C + D, no duplicates');

    // No cycle warning should fire for a diamond
    const warnings: string[] = [];
    const model2 = new WorkspaceModel([tmp], m => warnings.push(m));
    await model2.scan();
    model2.getDependents('a');
    assert.strictEqual(warnings.length, 0, 'diamond is not a cycle — no warning expected');
  });

  test('getDependents: isolated app not reachable from queried id returns only itself', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    writeApp('X', { id: 'x', name: 'X', publisher: 'p', version: '1.0.0.0' });

    model = new WorkspaceModel([tmp]);
    await model.scan();

    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A'], 'no dependents: only itself');
  });
});

suite('WorkspaceModel — watcher + onDidChange', () => {
  test('watch(triggerRescan) rescans and fires onDidChange when triggered', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-watch-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));

      const model = new WorkspaceModel([tmp]);
      await model.scan();
      assert.strictEqual(model.getApps().length, 1);

      let fired = 0;
      const unsub = model.onDidChange(() => { fired++; });

      // Simulate watcher firing after a new app.json is created.
      fsp.mkdirSync(path.join(tmp, 'B'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'B', 'app.json'),
        JSON.stringify({ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }));
      await model.triggerRescan();

      assert.strictEqual(fired, 1, 'onDidChange fired once');
      assert.strictEqual(model.getApps().length, 2);
      unsub();
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('onDidChange does not fire when rescan finds no changes', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-watch-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));
      const model = new WorkspaceModel([tmp]);
      await model.scan();

      let fired = 0;
      model.onDidChange(() => { fired++; });
      await model.triggerRescan(); // no filesystem change
      assert.strictEqual(fired, 0);
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unsubscribed listener does not fire after unsub()', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-watch-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));
      const model = new WorkspaceModel([tmp]);
      await model.scan();

      let fired = 0;
      const unsub = model.onDidChange(() => { fired++; });
      // Unsubscribe before triggering a change
      unsub();
      // Calling unsub again should be safe (no throw)
      unsub();

      fsp.mkdirSync(path.join(tmp, 'B'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'B', 'app.json'),
        JSON.stringify({ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }));
      await model.triggerRescan();

      assert.strictEqual(fired, 0, 'listener must not fire after unsubscribe');
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('bindWorkspaceModelToVsCode', () => {
  let clock: sinon.SinonFakeTimers;
  setup(() => { clock = sinon.useFakeTimers(); });
  teardown(() => { clock.restore(); });

  function makeMockVsCodeApi() {
    const handlers: { [k: string]: (() => void)[] } = { create: [], change: [], delete: [] };
    const watcher = {
      onDidCreate: (h: () => void) => { handlers.create.push(h); return { dispose: () => {} }; },
      onDidChange: (h: () => void) => { handlers.change.push(h); return { dispose: () => {} }; },
      onDidDelete: (h: () => void) => { handlers.delete.push(h); return { dispose: () => {} }; },
      dispose: sinon.spy(),
    };
    const api = {
      workspace: {
        createFileSystemWatcher: sinon.stub().returns(watcher),
      },
    };
    return { api, watcher, handlers };
  }

  test('subscribes to all three watcher events', () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-bind-test-'));
    try {
      const model = new WorkspaceModel([tmp]);
      const { api, handlers } = makeMockVsCodeApi();

      const binding = bindWorkspaceModelToVsCode(model, api as any);

      assert.strictEqual(handlers.create.length, 1, 'create handler registered');
      assert.strictEqual(handlers.change.length, 1, 'change handler registered');
      assert.strictEqual(handlers.delete.length, 1, 'delete handler registered');

      binding.dispose();
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('debounces multiple events into one triggerRescan call (200ms trailing)', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-bind-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));

      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const triggerSpy = sinon.spy(model, 'triggerRescan');

      const { api, handlers } = makeMockVsCodeApi();
      const binding = bindWorkspaceModelToVsCode(model, api as any);

      // Fire 5 events in rapid succession
      handlers.create[0]();
      handlers.change[0]();
      handlers.change[0]();
      handlers.delete[0]();
      handlers.create[0]();

      assert.strictEqual(triggerSpy.callCount, 0, 'no rescan yet during debounce window');

      // Advance just before debounce ends
      clock.tick(FILE_WATCH_DEBOUNCE_MS - 1);
      assert.strictEqual(triggerSpy.callCount, 0, 'still no rescan at 199ms');

      // Advance past debounce
      clock.tick(2);
      assert.strictEqual(triggerSpy.callCount, 1, 'one rescan after 200ms');

      binding.dispose();
      triggerSpy.restore();
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('dispose() clears pending timer and disposes watcher', () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-bind-test-'));
    try {
      const model = new WorkspaceModel([tmp]);
      const triggerSpy = sinon.spy(model, 'triggerRescan');
      const { api, watcher, handlers } = makeMockVsCodeApi();
      const binding = bindWorkspaceModelToVsCode(model, api as any);

      // Fire an event, then dispose before debounce completes
      handlers.create[0]();
      binding.dispose();

      // Advance past debounce — no rescan should fire because timer was cleared
      clock.tick(500);
      assert.strictEqual(triggerSpy.callCount, 0, 'dispose() cancels pending rescan');
      assert.strictEqual((watcher.dispose as sinon.SinonSpy).callCount, 1, 'watcher.dispose called');

      triggerSpy.restore();
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
