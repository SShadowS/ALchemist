import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isProjectAware,
  isScratchFile,
  resolveScratchProjectApp,
  ScratchManager,
  getScratchBundleDir,
} from '../../src/scratch/scratchManager';
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

    test('recognizes a scratch file nested in its own bundle directory', () => {
      assert.strictEqual(isScratchFile('/tmp/alchemist-scratch/scratch1/scratch1.al'), true);
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

// AL.Runner 2.7.0's `execute` command requires `sourcePaths` entries to be
// bundle directories, not individual .al files (passing the scratch file
// itself fails with "bundle directory not found"). Each scratch file must
// therefore live in its own same-named subdirectory of alchemist-scratch/.
suite('ScratchManager — bundle directories', () => {
  let tmpRoot: string;

  setup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-scratch-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('getScratchBundleDir returns the directory containing the scratch file', () => {
    const filePath = path.join(tmpRoot, 'alchemist-scratch', 'scratch3', 'scratch3.al');
    assert.strictEqual(
      getScratchBundleDir(filePath),
      path.join(tmpRoot, 'alchemist-scratch', 'scratch3'),
    );
  });

  // AL.Runner 2.7.0 rejects a `.al` file path in sourcePaths with "bundle
  // directory not found" — the exact bug that shipped. This asserts the
  // contract against a real on-disk fixture, not just string equality:
  // the result must be an absolute path to an *existing directory*, never
  // the scratch file itself.
  test('getScratchBundleDir returns an absolute, existing directory — not the file itself', () => {
    const bundleDir = path.join(tmpRoot, 'alchemist-scratch', 'scratch5');
    fs.mkdirSync(bundleDir, { recursive: true });
    const filePath = path.join(bundleDir, 'scratch5.al');
    fs.writeFileSync(filePath, 'codeunit 50000 Scratch {}');

    const result = getScratchBundleDir(filePath);

    assert.ok(path.isAbsolute(result), `expected an absolute path, got ${result}`);
    assert.ok(!result.endsWith('.al'), `sourcePaths entry must be a directory, not a file: ${result}`);
    assert.ok(fs.statSync(result).isDirectory(), `expected an existing directory, got ${result}`);
    assert.strictEqual(result, bundleDir);
  });

  test('newScratchFile creates the file inside its own same-named subdirectory', async () => {
    const manager = new ScratchManager(tmpRoot);
    await manager.newScratchFile(tmpRoot);

    const scratchDir = manager.getScratchDir();
    assert.ok(
      fs.existsSync(path.join(scratchDir, 'scratch1', 'scratch1.al')),
      'expected alchemist-scratch/scratch1/scratch1.al to exist',
    );
    const looseAlFiles = fs.readdirSync(scratchDir).filter((f) => f.endsWith('.al'));
    assert.deepStrictEqual(looseAlFiles, [], 'no .al file should be loose directly in alchemist-scratch/');
  });

  test('migration moves a loose .al file into its own subdirectory', () => {
    const scratchDir = path.join(tmpRoot, 'alchemist-scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, 'scratch1.al'), 'codeunit 50000 Scratch {}');

    new ScratchManager(tmpRoot); // constructor performs migration

    assert.ok(!fs.existsSync(path.join(scratchDir, 'scratch1.al')), 'loose file should have moved out of alchemist-scratch/');
    assert.strictEqual(
      fs.readFileSync(path.join(scratchDir, 'scratch1', 'scratch1.al'), 'utf-8'),
      'codeunit 50000 Scratch {}',
      'migrated file should keep its original content',
    );
  });

  test('migration is idempotent — constructing twice does not nest or break', () => {
    const scratchDir = path.join(tmpRoot, 'alchemist-scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, 'scratch1.al'), 'codeunit 50000 Scratch {}');

    new ScratchManager(tmpRoot);
    new ScratchManager(tmpRoot); // running again must be a no-op for already-migrated files

    const bundleDir = path.join(scratchDir, 'scratch1');
    assert.deepStrictEqual(
      fs.readdirSync(bundleDir),
      ['scratch1.al'],
      'bundle dir must contain exactly the one file — no re-nesting',
    );
  });

  test('migration does not overwrite an existing target', () => {
    const scratchDir = path.join(tmpRoot, 'alchemist-scratch');
    const bundleDir = path.join(scratchDir, 'scratch1');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'scratch1.al'), 'ORIGINAL BUNDLED CONTENT');
    // A stray loose file at top level shares the bundled file's name.
    fs.writeFileSync(path.join(scratchDir, 'scratch1.al'), 'STRAY LOOSE CONTENT');

    new ScratchManager(tmpRoot);

    assert.strictEqual(
      fs.readFileSync(path.join(bundleDir, 'scratch1.al'), 'utf-8'),
      'ORIGINAL BUNDLED CONTENT',
      'existing bundled file must not be clobbered',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(scratchDir, 'scratch1.al'), 'utf-8'),
      'STRAY LOOSE CONTENT',
      'stray loose file is left alone rather than overwriting the target',
    );
  });

  test('counter continues correctly after migration (no collision with existing scratch dirs)', async () => {
    const scratchDir = path.join(tmpRoot, 'alchemist-scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    // A gap: scratch2 is missing, scratch3 already exists.
    fs.writeFileSync(path.join(scratchDir, 'scratch1.al'), 'codeunit 50000 Scratch {}');
    fs.writeFileSync(path.join(scratchDir, 'scratch3.al'), 'codeunit 50000 Scratch {}');

    const manager = new ScratchManager(tmpRoot);
    await manager.newScratchFile(tmpRoot);

    assert.ok(
      fs.existsSync(path.join(scratchDir, 'scratch4', 'scratch4.al')),
      'next file must continue after the highest existing index (scratch4), not collide with scratch2 or scratch1',
    );
  });

  test('deleteScratchFile removes the now-empty bundle directory', async () => {
    const manager = new ScratchManager(tmpRoot);
    await manager.newScratchFile(tmpRoot);
    const bundleDir = path.join(manager.getScratchDir(), 'scratch1');
    const filePath = path.join(bundleDir, 'scratch1.al');
    assert.ok(fs.existsSync(filePath));

    const origActive = vscode.window.activeTextEditor;
    try {
      (vscode.window as any).activeTextEditor = {
        document: { uri: { fsPath: filePath }, getText: () => '' },
      };
      await manager.deleteScratchFile();
    } finally {
      (vscode.window as any).activeTextEditor = origActive;
    }

    assert.ok(!fs.existsSync(filePath), 'scratch file should be deleted');
    assert.ok(!fs.existsSync(bundleDir), 'now-empty bundle directory should be removed');
  });

  test('deleteScratchFile never removes a non-empty bundle directory', async () => {
    const manager = new ScratchManager(tmpRoot);
    await manager.newScratchFile(tmpRoot);
    const bundleDir = path.join(manager.getScratchDir(), 'scratch1');
    const filePath = path.join(bundleDir, 'scratch1.al');
    // Something else lives alongside the scratch file in its bundle dir.
    fs.writeFileSync(path.join(bundleDir, 'notes.txt'), 'keep me');

    const origActive = vscode.window.activeTextEditor;
    try {
      (vscode.window as any).activeTextEditor = {
        document: { uri: { fsPath: filePath }, getText: () => '' },
      };
      await manager.deleteScratchFile();
    } finally {
      (vscode.window as any).activeTextEditor = origActive;
    }

    assert.ok(!fs.existsSync(filePath), 'scratch file should still be deleted');
    assert.ok(fs.existsSync(bundleDir), 'non-empty bundle directory must survive');
    assert.ok(fs.existsSync(path.join(bundleDir, 'notes.txt')), 'unrelated file in the bundle dir must survive');
  });
});
