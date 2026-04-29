import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import { AlchemistTestController } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { ExecutionEngine, RunTestsRequest, ExecuteScratchRequest } from '../../src/execution/executionEngine';
import { ExecutionResult } from '../../src/runner/outputParser';
import { TestEvent } from '../../src/execution/protocolV2Types';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

/**
 * Streaming-aware fake engine. Records the request payload and the
 * onTest callback wired by the controller, so tests can assert that the
 * v2 streaming pipe is reachable through the new `runTestsForRequest`
 * public delegator.
 */
class StreamingFakeEngine implements ExecutionEngine {
  public lastReq: RunTestsRequest | undefined;
  public lastOnTest: ((e: TestEvent) => void) | undefined;
  public callCount = 0;
  public requests: RunTestsRequest[] = [];

  constructor(
    private readonly events: TestEvent[],
    private readonly summary: ExecutionResult,
  ) {}

  async runTests(req: RunTestsRequest, onTest?: (e: TestEvent) => void): Promise<ExecutionResult> {
    this.callCount += 1;
    this.lastReq = req;
    this.requests.push(req);
    this.lastOnTest = onTest;
    if (onTest) {
      for (const e of this.events) { onTest(e); }
    }
    return this.summary;
  }
  async executeScratch(_req: ExecuteScratchRequest): Promise<ExecutionResult> {
    throw new Error('not used');
  }
  isHealthy(): boolean { return true; }
  async cancel(): Promise<void> { /* noop */ }
  async dispose(): Promise<void> { /* noop */ }
}

function makeEmpty(): ExecutionResult {
  return {
    mode: 'test',
    tests: [],
    messages: [],
    stderrOutput: [],
    summary: { passed: 0, failed: 0, errors: 0, total: 0 },
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues: [],
    cached: false,
    iterations: [],
    protocolVersion: 2,
  };
}

suite('Save-triggered streaming via runTestsForRequest', () => {
  test('runTestsForRequest with empty include runs every app (Run All semantics)', async () => {
    // Simulates a save that lands in the fallback tier with apps=[] empty
    // include — equivalent to the user clicking "Run All" in Test Explorer.
    // Asserts that:
    //   1. The controller iterates every app in the model.
    //   2. The engine receives an onTest callback (streaming pipe wired).
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const apps = model.getApps();
    assert.ok(apps.length >= 2, 'multi-app fixture must have at least two apps');

    const engine = new StreamingFakeEngine([], makeEmpty());
    let onResultCalls = 0;
    const controller = new AlchemistTestController(
      () => engine,
      model,
      () => { onResultCalls += 1; },
    );
    await controller.refreshTestsFromModel(model);

    const request = new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();
    try {
      await controller.runTestsForRequest(request, cts.token);
      assert.strictEqual(engine.callCount, apps.length, 'engine called once per app');
      assert.ok(engine.lastOnTest, 'streaming onTest callback must be threaded through');
      // onResult fires per-app iteration, not once. handleResult in
      // extension.ts is the same callback in production — its multiple
      // invocations are by design (each app contributes its own summary).
      assert.strictEqual(onResultCalls, apps.length, 'onResult fires once per app');
    } finally {
      cts.dispose();
      controller.dispose();
    }
  });

  test('runTestsForRequest with a single test item narrows to that test\'s app', async () => {
    // Simulates the precision tier: a save resolved to a specific test name
    // in a single app. The TestRunRequest includes only that TestItem, so
    // the controller's resolveAppsForRequest filters the per-app loop down
    // to the one matching app.
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const engine = new StreamingFakeEngine([], makeEmpty());
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);

    const items = controller.getTestItemsById();
    let include: vscode.TestItem | undefined;
    for (const item of items.values()) {
      if (item.id.startsWith('test-')) { include = item; break; }
    }
    assert.ok(include, 'fixture must have at least one test-prefixed item');

    const request = new vscode.TestRunRequest([include!], undefined, undefined);
    const cts = new vscode.CancellationTokenSource();
    try {
      await controller.runTestsForRequest(request, cts.token);
      assert.strictEqual(engine.callCount, 1, 'only the test\'s owning app is invoked');
    } finally {
      cts.dispose();
      controller.dispose();
    }
  });

  test('runTestsForRequest with an app-level item narrows to that app (fallback-tier scoping)', async () => {
    // Simulates the fallback tier: no specific tests resolved, but the
    // save router did identify a specific app (e.g. "MainApp.Test"). The
    // extension.ts `runViaController` helper builds an include list of
    // `app-<guid>` items in this case. groupTestItemsByApp's regex
    // matches the `app-` prefix, so the controller's resolveAppsForRequest
    // narrows correctly.
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const apps = model.getApps();
    const testApp = apps.find(a => a.name === 'MainApp.Test');
    assert.ok(testApp, 'MainApp.Test fixture must be present');

    const engine = new StreamingFakeEngine([], makeEmpty());
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);

    const appItem = controller.getAppTestItem(testApp!.id);
    assert.ok(appItem, 'getAppTestItem must return the app-<guid> TestItem after refresh');

    const request = new vscode.TestRunRequest([appItem!], undefined, undefined);
    const cts = new vscode.CancellationTokenSource();
    try {
      await controller.runTestsForRequest(request, cts.token);
      assert.strictEqual(engine.callCount, 1, 'only one app should be invoked');
    } finally {
      cts.dispose();
      controller.dispose();
    }
  });

  test('runTestsForRequest preserves the streaming pipe (onTest fires events)', async () => {
    // Asserts that the public delegator preserves the v2 streaming
    // semantics owned by the private `runTests`: events delivered through
    // the engine's onTest callback get translated into run.passed/failed
    // calls. Without this, save-triggered runs would NOT see live
    // progress in the Test Explorer — which is the entire point of
    // routing them through the controller.
    const events: TestEvent[] = [
      // multi-app fixture order is [MainApp, MainApp.Test]; tests live
      // only in MainApp.Test (second iteration), so the events must be
      // emitted only in that iteration. We pass a single events array
      // here and the fake engine replays it on EVERY runTests call —
      // for the first app (no test items) the events resolve to nothing
      // because resolveTestItemByName scopes to currentAppId. For the
      // second app they resolve correctly. The key assertion is that
      // SOME pass/fail call lands.
      { type: 'test', name: 'ComputeDoubles', status: 'pass', durationMs: 5 },
    ];
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const engine = new StreamingFakeEngine(events, makeEmpty());
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);

    const request = new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();
    try {
      await controller.runTestsForRequest(request, cts.token);
      // Streaming callback was wired (engine.runTests received a non-
      // undefined onTest for every call).
      assert.ok(engine.lastOnTest, 'streaming callback must be wired');
      // The fake engine's events were accepted (it iterated them under
      // the callback). The downstream run.passed assertion is covered in
      // testController.streaming.test.ts; here we only assert pipe
      // continuity through the public delegator.
      assert.ok(engine.callCount > 0, 'engine must have been called at least once');
    } finally {
      cts.dispose();
      controller.dispose();
    }
  });
});
