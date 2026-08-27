import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildDebugConfiguration, shouldWarnAboutStepping } from '../../src/debug/debugLaunch';
import { AlchemistTestController } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('buildDebugConfiguration', () => {
  const WS = path.resolve('/ws');

  test('names the alchemist debug type and a launch request', () => {
    const config = buildDebugConfiguration({ bundleDir: WS });
    assert.strictEqual(config.type, 'alchemist');
    assert.strictEqual(config.request, 'launch');
    assert.strictEqual(config.bundleDir, WS);
  });

  test('a selected test becomes testFilter and names the session', () => {
    const config = buildDebugConfiguration({ bundleDir: WS, testName: 'TestCustomerInsert' });
    assert.strictEqual(config.testFilter, 'TestCustomerInsert');
    assert.ok(String(config.name).includes('TestCustomerInsert'));
  });

  test('no selected test omits testFilter entirely', () => {
    const config = buildDebugConfiguration({ bundleDir: WS });
    assert.ok(!('testFilter' in config), 'an absent filter must not be sent as undefined');
  });

  test('an explicit sourcePaths list is carried onto the configuration', () => {
    const mainApp = path.join(WS, 'MainApp');
    const dep = path.join(WS, 'Dep');
    const config = buildDebugConfiguration({ bundleDir: WS, sourcePaths: [mainApp, dep] });
    assert.deepStrictEqual(config.sourcePaths, [mainApp, dep]);
    // bundleDir is kept too, for compatibility with the single-directory
    // shape upstream's own docs still show.
    assert.strictEqual(config.bundleDir, WS);
  });

  test('an empty sourcePaths list is omitted, not sent as []', () => {
    const config = buildDebugConfiguration({ bundleDir: WS, sourcePaths: [] });
    assert.ok(!('sourcePaths' in config), 'an empty list must not win over bundleDir inside resolveSourcePaths');
  });

  test('no sourcePaths given omits the property entirely', () => {
    const config = buildDebugConfiguration({ bundleDir: WS });
    assert.ok(!('sourcePaths' in config));
  });
});

suite('shouldWarnAboutStepping', () => {
  test('warns the first time only', () => {
    assert.strictEqual(shouldWarnAboutStepping(false), true);
    assert.strictEqual(shouldWarnAboutStepping(true), false);
  });
});

suite('AlchemistTestController — Debug profile', () => {
  test('registers a Debug-kind run profile alongside Run', () => {
    const controller = new AlchemistTestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ label: string; kind: number }>;

    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug);
    assert.ok(debugProfile, 'expected a Debug profile');
    assert.strictEqual(debugProfile.label, 'Debug Tests');

    const runProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Run);
    assert.ok(runProfile, 'the Run profile must survive');
  });

  test('debug handler starts a session carrying the selected test name', async () => {
    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('/ws') }, name: 'ws', index: 0 }];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    const controller = new AlchemistTestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ kind: number; runHandler: Function }>;
    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;

    await debugProfile.runHandler({ include: [{ id: 'test-x', label: 'TestCustomerInsert' }] }, {});

    const calls = (vscode as any).debug.startDebuggingCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].config.testFilter, 'TestCustomerInsert');
    assert.strictEqual(calls[0].config.type, 'alchemist');

    (vscode as any).workspace.workspaceFolders = [];
  });

  test('no workspace folder: shows an error and never starts a session', async () => {
    (vscode as any).workspace.workspaceFolders = [];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    const controller = new AlchemistTestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ kind: number; runHandler: Function }>;
    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;

    await debugProfile.runHandler({ include: undefined }, {});

    assert.strictEqual((vscode as any).debug.startDebuggingCalls.length, 0, 'no session should start without a workspace folder');
  });

  test('the stepping caveat is shown once per session, not once per launch', async () => {
    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('/ws') }, name: 'ws', index: 0 }];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    const messages: string[] = [];
    const originalShowInfo = (vscode as any).window.showInformationMessage;
    (vscode as any).window.showInformationMessage = (msg: string) => { messages.push(msg); };

    try {
      const controller = new AlchemistTestController(() => undefined);
      const profiles = (controller as any).controller.__runProfiles as Array<{ kind: number; runHandler: Function }>;
      const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;

      await debugProfile.runHandler({ include: undefined }, {});
      await debugProfile.runHandler({ include: undefined }, {});

      assert.strictEqual(messages.length, 1, 'the caveat must appear exactly once across both launches on this controller');
    } finally {
      (vscode as any).window.showInformationMessage = originalShowInfo;
      (vscode as any).workspace.workspaceFolders = [];
    }
  });

  test('selecting a test in a multi-app workspace derives sourcePaths from its app\'s dependency closure', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const controller = new AlchemistTestController(() => undefined, model);
    await controller.refreshTestsFromModel(model);

    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: path.join(FIX, 'multi-app') }, name: 'ws', index: 0 }];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    const mockController = (controller as any).controller;
    let testItem: any;
    mockController.items.forEach((appItem: any) => {
      appItem.children.forEach((cuItem: any) => {
        cuItem.children.forEach((ti: any) => {
          if (ti.label === 'ComputeDoubles') { testItem = ti; }
        });
      });
    });
    assert.ok(testItem, 'expected to find ComputeDoubles in the discovered tree');

    const profiles = mockController.__runProfiles as Array<{ kind: number; runHandler: Function }>;
    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;
    await debugProfile.runHandler({ include: [testItem] }, {});

    const calls = (vscode as any).debug.startDebuggingCalls;
    assert.strictEqual(calls.length, 1);
    // ComputeDoubles lives in MainApp.Test, which declares a dependency on
    // MainApp — the dependency closure must carry both source paths, the
    // same multi-app derivation runTests uses (testController.ts).
    const testApp = model.getApps().find(a => a.name === 'MainApp.Test')!;
    const mainApp = model.getApps().find(a => a.name === 'MainApp')!;
    assert.ok(Array.isArray(calls[0].config.sourcePaths), 'expected sourcePaths to be set');
    assert.deepStrictEqual(
      new Set(calls[0].config.sourcePaths),
      new Set([testApp.path, mainApp.path]),
    );

    (vscode as any).workspace.workspaceFolders = [];
  });

  test('debug session without a WorkspaceModel falls back to bundleDir alone (no empty sourcePaths)', async () => {
    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('/ws') }, name: 'ws', index: 0 }];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    // No model passed — legacy single-folder construction.
    const controller = new AlchemistTestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ kind: number; runHandler: Function }>;
    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;

    await debugProfile.runHandler({ include: [{ id: 'test-x', label: 'SomeTest' }] }, {});

    const calls = (vscode as any).debug.startDebuggingCalls;
    assert.strictEqual(calls.length, 1);
    assert.ok(!('sourcePaths' in calls[0].config), 'no model available — must not emit an empty/incorrect sourcePaths');
    assert.strictEqual(calls[0].config.bundleDir, path.resolve('/ws'));

    (vscode as any).workspace.workspaceFolders = [];
  });
});
