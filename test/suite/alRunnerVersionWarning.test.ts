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

  test('below minimum + user-configured path: warns without offering an Update button', async () => {
    configOverrides.alRunnerPath = 'C:/custom/al-runner.exe';
    stubVersionOutput('2.6.9');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('C:/custom/al-runner.exe');

    assert.strictEqual(warn.callCount, 1);
    const [message, ...rest] = warn.firstCall.args;
    assert.ok(message.includes('2.7.0'), 'names the minimum version');
    assert.ok(message.includes('2.6.9'), 'names the found version');
    assert.strictEqual(rest.length, 0, 'no action buttons for a user-configured path — we did not install it');
  });

  test('below minimum + auto-managed path: offers Update, and accepting it runs dotnet tool update', async () => {
    stubVersionOutput('2.6.9'); // alRunnerPath left unset -> auto-managed
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Update' as unknown as vscode.MessageItem);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    execStub.withArgs(sinon.match(/tool update -g msdyn365bc\.al\.runner/)).callsFake(
      (_cmd: string, cb: (e: Error | null, out: string, errOut: string) => void) => { cb(null, '', ''); return {} as cp.ChildProcess; },
    );

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner');
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

  test('warns only once per session across repeated calls', async () => {
    stubVersionOutput('2.6.9');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    const m = manager as any;
    await m.warnIfBelowMinimum('al-runner');
    await m.warnIfBelowMinimum('al-runner');
    await m.warnIfBelowMinimum('al-runner');

    assert.strictEqual(warn.callCount, 1, 'second and third calls are no-ops once already warned');
  });

  test('runner already at the minimum: no warning', async () => {
    stubVersionOutput('2.7.0');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner');

    assert.strictEqual(warn.callCount, 0);
  });

  test('runner above the minimum: no warning', async () => {
    stubVersionOutput('3.1.4');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await (manager as any).warnIfBelowMinimum('al-runner');

    assert.strictEqual(warn.callCount, 0);
  });

  test('unparseable --version output: best-effort — no warning, and it does not throw', async () => {
    stubVersionOutput('command not found');
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await assert.doesNotReject(() => (manager as any).warnIfBelowMinimum('al-runner'));

    assert.strictEqual(warn.callCount, 0);
  });

  test('--version exec failure (e.g. missing binary): best-effort — no warning, and it does not throw', async () => {
    stubVersionOutput('', new Error('spawn failed'));
    const warn = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    const manager = new AlRunnerManager();
    await assert.doesNotReject(() => (manager as any).warnIfBelowMinimum('al-runner'));

    assert.strictEqual(warn.callCount, 0);
  });
});
