import * as assert from 'assert';
import { isProjectAware, isScratchFile, resolveScratchProjectApp } from '../../src/scratch/scratchManager';
import { AlApp } from '../../src/workspace/types';

const makeApp = (overrides: Partial<AlApp> = {}): AlApp => ({
  path: '/ws/MyApp', id: 'x', name: 'MyApp', publisher: 'p',
  version: '1.0.0.0', dependencies: [], ...overrides,
});

suite('ScratchManager', () => {
  suite('isProjectAware', () => {
    test('detects project directive at first line', () => {
      assert.strictEqual(isProjectAware('//alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('detects directive with extra spaces', () => {
      assert.strictEqual(isProjectAware('// alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('returns false without directive', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch {}'), false);
    });

    test('returns false when directive is not on first line', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch\n//alchemist: project\n{}'), false);
    });
  });

  suite('isScratchFile', () => {
    test('identifies scratch file by path containing alchemist-scratch', () => {
      assert.strictEqual(isScratchFile('/tmp/alchemist-scratch/scratch1.al'), true);
    });

    test('rejects normal project file', () => {
      assert.strictEqual(isScratchFile('/workspace/src/MyCodeunit.al'), false);
    });

    test('works with Windows paths', () => {
      assert.strictEqual(isScratchFile('C:\\Users\\user\\alchemist-scratch\\scratch1.al'), true);
    });

    test('rejects paths with alchemist but not alchemist-scratch', () => {
      assert.strictEqual(isScratchFile('/workspace/alchemist/src/main.al'), false);
    });
  });

  suite('isProjectAware edge cases', () => {
    test('is case-insensitive', () => {
      assert.strictEqual(isProjectAware('//ALCHEMIST: PROJECT\ncode'), true);
      assert.strictEqual(isProjectAware('//Alchemist: Project\ncode'), true);
    });

    test('handles empty string', () => {
      assert.strictEqual(isProjectAware(''), false);
    });
  });
});

suite('ScratchManager — resolveScratchProjectApp', () => {
  test('0 apps → returns { mode: "standalone" }', () => {
    const r = resolveScratchProjectApp([], undefined, undefined);
    assert.strictEqual(r.mode, 'standalone');
  });

  test('1 app → returns that app', () => {
    const app = makeApp();
    const r = resolveScratchProjectApp([app], undefined, undefined);
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'x');
  });

  test('N apps + setting matches → uses setting', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'b', undefined);
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'b');
  });

  test('N apps + persisted choice matches → uses persisted', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], undefined, 'b');
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'b');
  });

  test('N apps + setting outranks persisted', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'a', 'b');
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'a');
  });

  test('N apps + no setting + no persisted → needs prompt', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], undefined, undefined);
    assert.strictEqual(r.mode, 'needsPrompt');
    if (r.mode !== 'needsPrompt') return;
    assert.deepStrictEqual(r.choices.map(c => c.id).sort(), ['a', 'b']);
  });

  test('N apps + stale setting (id not found) → needs prompt', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'stale', undefined);
    assert.strictEqual(r.mode, 'needsPrompt');
  });

  // Extra test: empty-string settingAppId treated as undefined (falsy)
  test('empty-string settingAppId treated as no setting → falls through to persisted', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], '', 'b');
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'b');
  });

  // Extra test: 1 app ignores stale setting and returns that single app
  test('1 app + stale setting → returns that app (not needsPrompt)', () => {
    const app = makeApp({ id: 'x', name: 'X' });
    const r = resolveScratchProjectApp([app], 'stale', undefined);
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'x');
  });

  // Extra test: N apps + stale persisted (id not found) → needs prompt
  test('N apps + stale persisted (id not found) → needs prompt', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], undefined, 'stale');
    assert.strictEqual(r.mode, 'needsPrompt');
    if (r.mode !== 'needsPrompt') return;
    assert.strictEqual(r.choices.length, 2);
  });
});
