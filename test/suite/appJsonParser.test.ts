import * as assert from 'assert';
import * as path from 'path';
import { parseAppJsonFile, parseAppJsonContent } from '../../src/workspace/appJsonParser';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('AppJsonParser', () => {
  test('parses multi-app MainApp/app.json', () => {
    const result = parseAppJsonFile(path.join(FIX, 'multi-app/MainApp/app.json'));
    assert.strictEqual(result.ok, true, 'parse should succeed');
    if (!result.ok) return;
    assert.strictEqual(result.app.name, 'MainApp');
    assert.strictEqual(result.app.id, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(result.app.dependencies.length, 0);
  });

  test('parses multi-app MainApp.Test/app.json with one dependency', () => {
    const result = parseAppJsonFile(path.join(FIX, 'multi-app/MainApp.Test/app.json'));
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.app.dependencies.length, 1);
    assert.strictEqual(result.app.dependencies[0].name, 'MainApp');
  });

  test('returns error on missing file', () => {
    const result = parseAppJsonFile('/definitely/does/not/exist/app.json');
    assert.strictEqual(result.ok, false);
  });

  test('returns error on invalid JSON', () => {
    const result = parseAppJsonContent('{ not json', '/tmp/bad.json');
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(/JSON/i.test(result.error.message) || /parse/i.test(result.error.message));
  });

  test('returns error when required field id is missing', () => {
    const result = parseAppJsonContent(JSON.stringify({
      name: 'X', publisher: 'Y', version: '1.0.0.0',
    }), '/tmp/missing-id.json');
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(/id/.test(result.error.message));
  });

  test('returns error when required field name is missing', () => {
    const result = parseAppJsonContent(JSON.stringify({
      id: 'abc', publisher: 'Y', version: '1.0.0.0',
    }), '/tmp/missing-name.json');
    assert.strictEqual(result.ok, false);
  });

  test('treats missing dependencies array as empty', () => {
    const result = parseAppJsonContent(JSON.stringify({
      id: 'abc', name: 'N', publisher: 'P', version: '1.0.0.0',
    }), '/tmp/no-deps.json');
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.app.dependencies, []);
  });

  test('path on AlApp is the folder containing app.json (absolute)', () => {
    const jsonPath = path.join(FIX, 'multi-app/MainApp/app.json');
    const result = parseAppJsonFile(jsonPath);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.app.path, path.dirname(jsonPath));
  });
});
