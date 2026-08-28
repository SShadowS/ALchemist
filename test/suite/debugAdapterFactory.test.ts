import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  AlchemistDebugAdapterFactory,
  resolveSourcePaths,
  ALCHEMIST_DEBUG_TYPE,
} from '../../src/debug/debugAdapterFactory';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('AlchemistDebugAdapterFactory', () => {
  const RUNNER = path.join('C:', 'tools', 'al-runner.exe');
  const WS = path.resolve('/ws');

  function factoryWith(runnerPath: string | Error) {
    return new AlchemistDebugAdapterFactory({
      ensureInstalled: async () => {
        if (runnerPath instanceof Error) throw runnerPath;
        return runnerPath;
      },
    });
  }

  test('spawns the runner with the two-token --dap stdio form', async () => {
    const factory = factoryWith(RUNNER);
    const session: any = { configuration: { bundleDir: path.join(WS, 'app') }, workspaceFolder: undefined };

    const descriptor: any = await factory.createDebugAdapterDescriptor(session);

    assert.strictEqual(descriptor.command, RUNNER);
    assert.deepStrictEqual(descriptor.args, ['--dap', 'stdio', path.join(WS, 'app')]);
  });

  test('the flag is never the single-token --dap-stdio spelling', async () => {
    const factory = factoryWith(RUNNER);
    const session: any = { configuration: { bundleDir: WS }, workspaceFolder: undefined };
    const descriptor: any = await factory.createDebugAdapterDescriptor(session);
    assert.ok(!descriptor.args.includes('--dap-stdio'), 'AL.Runner 2.7.0 takes two tokens');
  });

  test('an explicit sourcePaths list is passed through in full — a bundle directory is one app, not the whole picture', async () => {
    const factory = factoryWith(RUNNER);
    const mainApp = path.join(WS, 'MainApp');
    const dep = path.join(WS, 'Dep');
    const session: any = {
      configuration: { sourcePaths: [mainApp, dep] },
      workspaceFolder: undefined,
    };

    const descriptor: any = await factory.createDebugAdapterDescriptor(session);

    assert.deepStrictEqual(descriptor.args, ['--dap', 'stdio', mainApp, dep]);
  });

  test('runner resolution failure surfaces an actionable error', async () => {
    const factory = factoryWith(new Error('Could not find or install AL.Runner'));
    const session: any = { configuration: { bundleDir: WS }, workspaceFolder: undefined };

    await assert.rejects(
      () => factory.createDebugAdapterDescriptor(session),
      /AL\.Runner/,
    );
  });

  test('debug type is the one the package.json contribution declares', () => {
    assert.strictEqual(ALCHEMIST_DEBUG_TYPE, 'alchemist');
  });
});

suite('resolveSourcePaths', () => {
  const WS = path.resolve('/ws');

  test('explicit sourcePaths wins over bundleDir entirely', () => {
    const mainApp = path.join(WS, 'MainApp');
    const dep = path.join(WS, 'Dep');
    assert.deepStrictEqual(
      resolveSourcePaths({ bundleDir: path.join(WS, 'ignored'), sourcePaths: [mainApp, dep] }, WS),
      [mainApp, dep],
    );
  });

  test('relative entries in an explicit sourcePaths list resolve against the workspace folder', () => {
    assert.deepStrictEqual(
      resolveSourcePaths({ sourcePaths: ['MainApp', 'Dep'] }, WS),
      [path.join(WS, 'MainApp'), path.join(WS, 'Dep')],
    );
  });

  test('an empty sourcePaths array falls back to bundleDir, not an empty --dap invocation', () => {
    assert.deepStrictEqual(
      resolveSourcePaths({ bundleDir: path.join(WS, 'out'), sourcePaths: [] }, WS),
      [path.join(WS, 'out')],
    );
  });

  test('explicit bundleDir wins when no sourcePaths given', () => {
    assert.deepStrictEqual(resolveSourcePaths({ bundleDir: path.join(WS, 'out') }, WS), [path.join(WS, 'out')]);
  });

  test('a relative bundleDir resolves against the workspace folder', () => {
    assert.deepStrictEqual(resolveSourcePaths({ bundleDir: 'app' }, WS), [path.join(WS, 'app')]);
  });

  test('falls back to the program directory when bundleDir is absent', () => {
    assert.deepStrictEqual(
      resolveSourcePaths({ program: path.join(WS, 'app', 'Foo.al') }, WS),
      [path.join(WS, 'app')],
    );
  });

  test('falls back to the workspace folder when nothing else is given', () => {
    assert.deepStrictEqual(resolveSourcePaths({}, WS), [WS]);
  });

  test('throws when nothing can be resolved', () => {
    assert.throws(() => resolveSourcePaths({}, undefined), /bundleDir/);
  });

  // AL.Runner 2.7.0 requires every sourcePaths entry to be an *existing
  // directory* — a `.al` file path is rejected with "bundle directory not
  // found" (the bug that shipped in scratch mode). The runner also accepts
  // relative paths, but resolves them against its own cwd rather than the
  // workspace, so a relative entry would silently point at the wrong place.
  // These tests pin both requirements against real on-disk fixtures.
  suite('resolveSourcePaths — directory + absoluteness contract', () => {
    test('program fallback resolves to the containing directory, not the file itself', () => {
      const programFile = path.join(FIX, 'multi-app', 'MainApp', 'src', 'SomeCodeunit.Codeunit.al');
      const resolved = resolveSourcePaths({ program: programFile }, FIX);

      assert.strictEqual(resolved.length, 1);
      assert.ok(path.isAbsolute(resolved[0]), `expected an absolute path, got ${resolved[0]}`);
      assert.ok(!resolved[0].endsWith('.al'), `sourcePaths entry must be a directory, not a file: ${resolved[0]}`);
      assert.ok(fs.statSync(resolved[0]).isDirectory(), `expected an existing directory, got ${resolved[0]}`);
    });

    test('an explicit absolute sourcePaths list resolves to existing directories', () => {
      const mainApp = path.join(FIX, 'multi-app', 'MainApp');
      const testApp = path.join(FIX, 'multi-app', 'MainApp.Test');
      const resolved = resolveSourcePaths({ sourcePaths: [mainApp, testApp] }, FIX);

      for (const p of resolved) {
        assert.ok(path.isAbsolute(p), `expected an absolute path, got ${p}`);
        assert.ok(fs.statSync(p).isDirectory(), `expected an existing directory, got ${p}`);
      }
    });

    test('a relative sourcePaths entry resolves against the workspace folder to a real existing directory', () => {
      // The runner itself would accept 'multi-app/MainApp' as-is and
      // resolve it against ITS OWN cwd — silently wrong for us. This
      // proves ALchemist resolves it against the workspace folder instead,
      // landing on the real fixture directory rather than a path relative
      // to wherever the test process happens to run from.
      const resolved = resolveSourcePaths({ sourcePaths: ['multi-app/MainApp', 'multi-app/MainApp.Test'] }, FIX);

      for (const p of resolved) {
        assert.ok(path.isAbsolute(p), `expected an absolute path, got ${p}`);
        assert.ok(fs.statSync(p).isDirectory(), `expected an existing directory, got ${p}`);
      }
      assert.deepStrictEqual(
        resolved.sort(),
        [path.join(FIX, 'multi-app', 'MainApp'), path.join(FIX, 'multi-app', 'MainApp.Test')].sort(),
      );
    });

    test('a relative bundleDir fallback also resolves to a real existing directory', () => {
      const resolved = resolveSourcePaths({ bundleDir: path.join('multi-app', 'MainApp') }, FIX);
      assert.strictEqual(resolved.length, 1);
      assert.ok(path.isAbsolute(resolved[0]));
      assert.ok(fs.statSync(resolved[0]).isDirectory());
    });
  });
});
