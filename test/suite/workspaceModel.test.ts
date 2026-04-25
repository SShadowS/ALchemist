import * as assert from 'assert';
import * as path from 'path';
import { findAppJsonRootsIn } from '../../src/workspace/workspaceModel';

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
