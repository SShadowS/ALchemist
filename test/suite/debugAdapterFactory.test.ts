import * as assert from 'assert';
import * as path from 'path';
import {
  AlchemistDebugAdapterFactory,
  resolveSourcePaths,
  ALCHEMIST_DEBUG_TYPE,
} from '../../src/debug/debugAdapterFactory';

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
});
