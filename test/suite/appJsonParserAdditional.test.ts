import * as assert from 'assert';
import * as path from 'path';
import { parseAppJsonContent } from '../../src/workspace/appJsonParser';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app-id',
    name: 'Test App',
    publisher: 'Publisher',
    version: '1.0.0.0',
    ...overrides,
  };
}

suite('AppJsonParser — additional content cases', () => {
  test('normalizes object dependency fields to strings', () => {
    const appJsonPath = path.resolve('workspace', 'app.json');
    const result = parseAppJsonContent(JSON.stringify(manifest({
      dependencies: [
        {
          id: 17,
          name: 'Base App',
          publisher: undefined,
          version: null,
        },
      ],
    })), appJsonPath);

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;

    assert.deepStrictEqual(result.app.dependencies, [{
      id: '17',
      name: 'Base App',
      publisher: '',
      version: '',
    }]);
    assert.strictEqual(result.app.path, path.dirname(appJsonPath));
  });

  test('filters primitive and null dependency entries', () => {
    const result = parseAppJsonContent(JSON.stringify(manifest({
      dependencies: [
        null,
        'not an object',
        42,
        {
          id: 'base-id',
          name: 'Base',
          publisher: 'Publisher',
          version: '2.0.0.0',
        },
      ],
    })), '/workspace/app.json');

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;

    assert.deepStrictEqual(result.app.dependencies, [{
      id: 'base-id',
      name: 'Base',
      publisher: 'Publisher',
      version: '2.0.0.0',
    }]);
  });

  test('treats a non-array dependencies value as empty', () => {
    const result = parseAppJsonContent(JSON.stringify(manifest({
      dependencies: {
        id: 'not-an-array',
      },
    })), '/workspace/app.json');

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.app.dependencies, []);
  });

  test('reports every required field whose value is not a string', () => {
    const result = parseAppJsonContent(JSON.stringify({
      id: null,
      name: 123,
      publisher: [],
      version: {},
    }), '/workspace/app.json');

    assert.strictEqual(result.ok, false);
    if (result.ok) return;

    assert.strictEqual(
      result.error.message,
      'missing required field(s): id, name, publisher, version',
    );
  });

  test('rejects a valid JSON array as a manifest', () => {
    const result = parseAppJsonContent('[]', '/workspace/app.json');

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.message.includes('id'));
    assert.ok(result.error.message.includes('name'));
    assert.ok(result.error.message.includes('publisher'));
    assert.ok(result.error.message.includes('version'));
  });

  test('preserves the requested path in a JSON parse error', () => {
    const appJsonPath = '/workspace/broken-app.json';
    const result = parseAppJsonContent('{"id":', appJsonPath);

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.path, appJsonPath);
    assert.ok(result.error.message.startsWith('JSON parse error:'));
  });
});
