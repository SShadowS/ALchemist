import * as assert from 'assert';
import * as sinon from 'sinon';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { AlRunnerManager } from '../../src/runner/alRunnerManager';

/**
 * Behavioral coverage for `warnIfBelowMinimum`, exercised directly (it's
 * private, but TypeScript's privacy is compile-time only) to avoid the
 * fire-and-forget timing of `ensureInstalled`'s `void this.warnIfBelowMinimum(...)`
 * calls.
 *
 * `child_process.exec` is stubbed on the module fetched via a raw `require`
 * (not on the `cp` namespace import above): TS's `esModuleInterop` compiles
 * `import * as cp` into a synthetic object with getter-only accessors for
 * each top-level export, which sinon refuses to stub (non-configurable). The
 * getters read through to the real module on every access, so stubbing the
 * real module — the same singleton `alRunnerManager.js`'s own `cp.exec(...)`
 * calls resolve against — works.
 */
suite('AlRunnerManager.warnIfBelowMinimum', () => {
  let sandbox: sinon.SinonSandbox;
  let execStub: sinon.SinonStub;
  let configOverrides: Record<string, string>;

  setup(() => {
    sandbox = sinon.createSandbox();
    configOverrides = {};
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
      get: (key: string, defaultValue?: unknown) => (key in configOverrides ? configOverrides[key] : defaultValue),
    }) as unknown as vscode.WorkspaceConfiguration);
    const realCp: typeof cp = require('child_process');
    execStub = sandbox.stub(realCp, 'exec') as unknown as sinon.SinonStub;
  });

  teardown(() => {
    sandbox.restore();
  });

  function stubVersionOutput(stdout: string, err: Error | null = null) {
    execStub.withArgs(sinon.match(/--version/)).callsFake((_cmd: string, cb: (e: Error | null, out: string, errOut: string) => void) => {
      cb(err, stdout, '');
      return {} as cp.ChildProcess;
    });
  }

  test('below minimum + userConfigured=true: warns without offering an Update button', async () => {
    stubVersionOutput('2.6.9');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('C:/custom/al-runner.exe', true);

    assert.strictEqual(warn.callCount, 1);
    const [message, ...rest] = warn.firstCall.args;
    assert.ok(message.includes('2.7.0'), 'names the minimum version');
    assert.ok(message.includes('2.6.9'), 'names the found version');
    assert.strictEqual(rest.length, 0, 'no action buttons for a user-configured path — we did not install it');
  });

  test('below minimum + userConfigured=false: offers Update, and accepting it runs dotnet tool update', async () => {
    stubVersionOutput('2.6.9');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Update' as unknown as vscode.MessageItem);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    execStub.withArgs(sinon.match(/tool update -g msdyn365bc\.al\.runner/)).callsFake(
      (_cmd: string, cb: (e: Error | null, out: string, errOut: string) => void) => { cb(null, '', ''); return {} as cp.ChildProcess; },
    );

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner', false);
    // The dotnet tool update kicked off by 'Update' is fire-and-forget from
    // warnIfBelowMinimum's point of view; flush the microtask queue so its
    // callback has run before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(warn.callCount, 1);
    assert.strictEqual(warn.firstCall.args[1], 'Update', 'auto-managed path is offered the Update action');
    assert.ok(
      execStub.getCalls().some(c => /tool update -g msdyn365bc\.al\.runner/.test(c.args[0])),
      'accepting Update runs dotnet tool update',
    );
    assert.strictEqual(info.callCount, 1, 'reports success after the update completes');
  });

  test('env-var-resolved path (ALCHEMIST_RUNNER_PATH): ensureInstalled warns without an Update button', async () => {
    // Regression: a Task 6 review found ensureInstalled resolved configPath
    // from EITHER the alRunnerPath setting OR ALCHEMIST_RUNNER_PATH, but the
    // old usingCustomPath check only re-read the setting — so a runner
    // resolved through the env var (e.g. .vscode/launch.json pointing at a
    // local fork build, which this project's own maintainer uses) was
    // wrongly offered "Update", which would run dotnet tool update over a
    // runner we did not install. Covered here at the ensureInstalled level
    // (not by calling warnIfBelowMinimum directly) so the test fails if the
    // wiring between the two ever drifts again.
    const originalEnv = process.env.ALCHEMIST_RUNNER_PATH;
    process.env.ALCHEMIST_RUNNER_PATH = 'C:/forks/al-runner-fork/al-runner.exe';
    try {
      // alchemist.alRunnerPath setting is left unset (default '' from
      // configOverrides) so configPath resolves via the env var alone.
      stubVersionOutput('2.6.9');
      const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

      const manager = new AlRunnerManager();
      const resolved = await manager.ensureInstalled();
      assert.strictEqual(resolved, 'C:/forks/al-runner-fork/al-runner.exe');

      // warnIfBelowMinimum runs fire-and-forget from ensureInstalled; flush
      // the microtask queue so its (single-await) chain completes.
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(warn.callCount, 1);
      assert.strictEqual(warn.firstCall.args.length, 1, 'env-var-resolved path is user-configured — no Update button');
    } finally {
      if (originalEnv === undefined) delete process.env.ALCHEMIST_RUNNER_PATH;
      else process.env.ALCHEMIST_RUNNER_PATH = originalEnv;
    }
  });

  test('warns only once per session across repeated calls', async () => {
    stubVersionOutput('2.6.9');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    const m = manager as any;
    await m.warnIfBelowMinimum('al-runner', false);
    await m.warnIfBelowMinimum('al-runner', false);
    await m.warnIfBelowMinimum('al-runner', false);

    assert.strictEqual(warn.callCount, 1, 'second and third calls are no-ops once already warned');
  });

  test('runner already at the minimum: no warning', async () => {
    stubVersionOutput('2.7.0');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner', false);

    assert.strictEqual(warn.callCount, 0);
  });

  test('runner above the minimum: no warning', async () => {
    stubVersionOutput('3.1.4');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner', false);

    assert.strictEqual(warn.callCount, 0);
  });

  test('unparseable --version output: best-effort — no warning, and it does not throw', async () => {
    stubVersionOutput('command not found');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await assert.doesNotReject(() => (manager as any).warnIfBelowMinimum('al-runner', false));

    assert.strictEqual(warn.callCount, 0);
  });

  test('--version exec failure (e.g. missing binary): best-effort — no warning, and it does not throw', async () => {
    stubVersionOutput('', new Error('spawn failed'));
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await assert.doesNotReject(() => (manager as any).warnIfBelowMinimum('al-runner', false));

    assert.strictEqual(warn.callCount, 0);
  });
});

/**
 * Regression coverage for the sibling of the env-var bug fixed above:
 * `checkForUpdates` had its own independent "skip for a custom path" check
 * that, like the original `warnIfBelowMinimum`, only re-read the
 * `alRunnerPath` setting and missed `ALCHEMIST_RUNNER_PATH`. Both call sites
 * now share `resolveConfiguredPath()`, so these tests exercise
 * `checkForUpdates()` itself (not the private helper directly) — they fail
 * if that sharing is ever undone and the env-var gap reopens.
 */
suite('AlRunnerManager.checkForUpdates — custom path resolution', () => {
  let sandbox: sinon.SinonSandbox;
  let execStub: sinon.SinonStub;
  let configOverrides: Record<string, string>;

  setup(() => {
    sandbox = sinon.createSandbox();
    configOverrides = {};
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
      get: (key: string, defaultValue?: unknown) => (key in configOverrides ? configOverrides[key] : defaultValue),
    }) as unknown as vscode.WorkspaceConfiguration);
    const realCp: typeof cp = require('child_process');
    execStub = sandbox.stub(realCp, 'exec') as unknown as sinon.SinonStub;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('env-var-resolved path (ALCHEMIST_RUNNER_PATH) alone: returns early, no dotnet tool list exec', async () => {
    const originalEnv = process.env.ALCHEMIST_RUNNER_PATH;
    process.env.ALCHEMIST_RUNNER_PATH = 'C:/forks/al-runner-fork/al-runner.exe';
    try {
      // alchemist.alRunnerPath setting is left unset — only the env var says
      // this is a user-configured runner.
      const manager = new AlRunnerManager();
      await manager.checkForUpdates();

      assert.strictEqual(execStub.callCount, 0, 'no dotnet tool list — a user-configured runner should never be nagged about updates');
    } finally {
      if (originalEnv === undefined) delete process.env.ALCHEMIST_RUNNER_PATH;
      else process.env.ALCHEMIST_RUNNER_PATH = originalEnv;
    }
  });

  test('alRunnerPath setting alone: returns early, no dotnet tool list exec', async () => {
    configOverrides.alRunnerPath = 'C:/custom/al-runner.exe';

    const manager = new AlRunnerManager();
    await manager.checkForUpdates();

    assert.strictEqual(execStub.callCount, 0);
  });

  test('neither configured: proceeds to the dotnet tool list check', async () => {
    // Negative control for the two tests above — proves checkForUpdates
    // does not simply always return early (which would make those tests
    // pass vacuously).
    const manager = new AlRunnerManager();
    await manager.checkForUpdates();

    assert.ok(
      execStub.getCalls().some(c => /tool list -g/.test(c.args[0])),
      'proceeds to dotnet tool list when nothing is user-configured',
    );
  });
});
