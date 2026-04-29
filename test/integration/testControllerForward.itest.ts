import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { AlchemistTestController } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { ExecutionEngine } from '../../src/execution/executionEngine';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

function makeFakeResult(): any {
  return {
    mode: 'test',
    tests: [],
    messages: [],
    stderrOutput: [],
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues: [],
    cached: false,
    iterations: [],
  };
}

function makeFakeEngine(stub?: sinon.SinonStub): ExecutionEngine {
  return {
    runTests: stub ?? sinon.stub().resolves(makeFakeResult()),
    executeScratch: sinon.stub(),
    isHealthy: () => true,
    dispose: sinon.stub().resolves(),
  } as any;
}

suite('Integration — TestController forwards results to callback', () => {
  test('runTests with no include calls onResult once per app (Run All)', async () => {
    const vscode = require('vscode');

    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const fakeEngine = makeFakeEngine();
    const onResult = sinon.spy();

    const controller = new AlchemistTestController(
      () => fakeEngine,
      model,
      onResult,
    );

    // TestRunRequest with no arguments = "Run All" (include === undefined)
    const request = new vscode.TestRunRequest();
    const cancelToken = new vscode.CancellationTokenSource().token;

    // Access private runTests method via casting (test-only)
    await (controller as any).runTests(request, cancelToken);

    // multi-app fixture has 2 apps → onResult should fire twice
    assert.strictEqual(
      onResult.callCount,
      2,
      `expected onResult called 2× (one per app), got ${onResult.callCount}`,
    );

    controller.dispose();
  });

  test('runTests with include calls onResult once per matched app', async () => {
    const vscode = require('vscode');

    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const fakeEngine = makeFakeEngine();
    const onResult = sinon.spy();

    const controller = new AlchemistTestController(
      () => fakeEngine,
      model,
      onResult,
    );

    // Refresh the VS Code test tree so the controller has TestItems populated
    await controller.refreshTestsFromModel(model);

    // Build a fake include item that targets MainApp.Test (app id: 22222222-...)
    // The item id format is: test-<appId>-<codeunitId>-<procName>
    // We only need the id to be parseable by groupTestItemsByApp.
    const testAppId = '22222222-2222-2222-2222-222222222222';
    const fakeItem: any = {
      id: `test-${testAppId}-50100-ComputeDoubles`,
      label: 'ComputeDoubles',
    };

    const request: any = {
      include: [fakeItem],
      exclude: undefined,
      profile: undefined,
    };
    const cancelToken = new vscode.CancellationTokenSource().token;

    await (controller as any).runTests(request, cancelToken);

    assert.ok(
      onResult.callCount >= 1,
      `onResult should fire at least once for the matched app, got ${onResult.callCount}`,
    );

    controller.dispose();
  });
});
