import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import { AlchemistTestController } from '../../src/testing/testController';
import { ExecutionEngine, RunTestsRequest, ExecuteScratchRequest } from '../../src/execution/executionEngine';
import { ExecutionResult } from '../../src/runner/outputParser';
import { TestEvent, FileCoverage as ProtoFileCoverage } from '../../src/execution/protocolV2Types';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

/**
 * Stub engine: drives onTest synchronously through preset events, then
 * resolves with a preset summary. Captures cancel + the request payload.
 */
class StubEngine implements ExecutionEngine {
  public canceled = false;
  public lastReq: RunTestsRequest | undefined;
  public lastOnTest: ((e: TestEvent) => void) | undefined;
  public callCount = 0;
  public summaries: ExecutionResult[];
  public eventBatches: TestEvent[][];

  constructor(eventBatches: TestEvent[][] = [[]], summaries: ExecutionResult[] = [makeEmpty()]) {
    this.eventBatches = eventBatches;
    this.summaries = summaries;
  }

  async runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult> {
    const idx = this.callCount++;
    this.lastReq = req;
    this.lastOnTest = onTest;
    const events = this.eventBatches[Math.min(idx, this.eventBatches.length - 1)] ?? [];
    if (onTest) {
      for (const ev of events) { onTest(ev); }
    }
    return this.summaries[Math.min(idx, this.summaries.length - 1)] ?? makeEmpty();
  }
  async executeScratch(_req: ExecuteScratchRequest): Promise<ExecutionResult> {
    throw new Error('not used in tests');
  }
  isHealthy(): boolean { return true; }
  async cancel(): Promise<void> { this.canceled = true; }
  async dispose(): Promise<void> { /* no-op */ }
}

function makeEmpty(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
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
    ...overrides,
  };
}

/**
 * Helper: build a controller wired to the multi-app fixture so the test
 * tree is populated. Returns the controller, the model, and the (mock-
 * specific) underlying controller object so tests can drive its
 * runHandler and read `__lastTestRun`.
 */
async function makeController(
  engine: StubEngine,
): Promise<{ controller: AlchemistTestController; model: WorkspaceModel; mockController: any; }> {
  const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
  await model.scan();
  const controller = new AlchemistTestController(() => engine, model);
  await controller.refreshTestsFromModel(model);
  // Reach into the mock to retrieve the underlying controller. The mock
  // stores the most recently created controller's runProfile callback
  // and `__lastTestRun`. We need access to the controller object itself
  // — we get it via the private field on AlchemistTestController.
  const mockController = (controller as any).controller;
  return { controller, model, mockController };
}

/**
 * Drive the run-profile callback. Returns the run.
 */
async function triggerRun(
  mockController: any,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<any> {
  const profile = mockController.__lastRunProfile;
  assert.ok(profile, 'run profile should have been registered by AlchemistTestController constructor');
  await profile.runHandler(request, token);
  return mockController.__lastTestRun;
}

function findTestItem(mockController: any, testName: string): vscode.TestItem | undefined {
  // mockController.items is a MockTestItemCollection of app items. Walk it.
  let found: vscode.TestItem | undefined;
  mockController.items.forEach((appItem: vscode.TestItem) => {
    appItem.children.forEach((cuItem: vscode.TestItem) => {
      cuItem.children.forEach((testItem: vscode.TestItem) => {
        if (testItem.label === testName) { found = testItem; }
      });
    });
  });
  return found;
}

suite('TestController streaming (v2)', () => {

  test('streaming events fire run.passed/failed in declared order', async () => {
    const events: TestEvent[] = [
      { type: 'test', name: 'ComputeDoubles', status: 'pass', durationMs: 12 },
      { type: 'test', name: 'ComputeZero', status: 'fail', durationMs: 7, message: 'expected 0 got 1' },
    ];
    // multi-app fixture has 2 apps; events fire only on the first call
    // and the second app summary is empty, so we count exactly one of each.
    const engine = new StubEngine([events, []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);

    const tokenSrc = new vscode.CancellationTokenSource();
    const request = new vscode.TestRunRequest();
    const run = await triggerRun(mockController, request, tokenSrc.token);

    assert.strictEqual(run.passedCalls.length, 1, 'one passed event');
    assert.strictEqual(run.passedCalls[0].duration, 12);
    assert.strictEqual(run.passedCalls[0].item.label, 'ComputeDoubles');

    assert.strictEqual(run.failedCalls.length, 1, 'one failed event');
    assert.strictEqual(run.failedCalls[0].duration, 7);
    assert.strictEqual(run.failedCalls[0].item.label, 'ComputeZero');
    assert.strictEqual((run.failedCalls[0].message as any).message, 'expected 0 got 1');

    assert.strictEqual(run.ended, true, 'run.end() must be called');
  });

  test('Run All: every app is invoked once', async () => {
    const engine = new StubEngine([[], []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    // multi-app fixture has 2 apps → 2 calls.
    assert.strictEqual(engine.callCount, 2);
  });

  test('Run with selection: only matching apps are processed', async () => {
    const engine = new StubEngine([[]], [makeEmpty()]);
    const { mockController, model } = await makeController(engine);

    // Pick the test app's items via the request.include.
    const testApp = model.getApps().find(a => a.name === 'MainApp.Test')!;
    const item = findTestItem(mockController, 'ComputeDoubles');
    assert.ok(item, 'expected ComputeDoubles test item');
    // Force the id to match the test app guid prefix.
    assert.ok(item!.id.includes(testApp.id), `item id ${item!.id} should include ${testApp.id}`);

    const request = new vscode.TestRunRequest([item!]);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, request, tokenSrc.token);
    assert.strictEqual(engine.callCount, 1, 'only one app should be invoked');
  });

  test('failing event with stackFrames builds TestMessage.stackTrace with TestMessageStackFrame entries', async () => {
    const events: TestEvent[] = [
      {
        type: 'test',
        name: 'ComputeZero',
        status: 'fail',
        durationMs: 3,
        message: 'AssertionFailed',
        stackFrames: [
          { name: 'MyTest.ComputeZero', source: { path: '/abs/Test.al' }, line: 42, column: 5 },
          { name: 'Helpers.Compute', source: { path: '/abs/Helpers.al' }, line: 100, column: 1 },
        ],
      },
    ];
    const engine = new StubEngine([events, []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);

    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    assert.strictEqual(run.failedCalls.length, 1);
    const msg: any = run.failedCalls[0].message;
    assert.ok(Array.isArray(msg.stackTrace), 'message.stackTrace should be an array');
    assert.strictEqual(msg.stackTrace.length, 2);
    assert.strictEqual(msg.stackTrace[0].label, 'MyTest.ComputeZero');
    assert.strictEqual(msg.stackTrace[0].uri.fsPath, '/abs/Test.al');
    assert.strictEqual(msg.stackTrace[0].position.line, 41); // 1-based → 0-based
    assert.strictEqual(msg.stackTrace[0].position.character, 4);
    assert.strictEqual(msg.stackTrace[1].label, 'Helpers.Compute');
    assert.strictEqual(msg.stackTrace[1].position.line, 99);
  });

  test('alSourceFile + alSourceLine on event sets TestMessage.location', async () => {
    const events: TestEvent[] = [
      {
        type: 'test',
        name: 'ComputeZero',
        status: 'fail',
        message: 'boom',
        alSourceFile: '/abs/Test.al',
        alSourceLine: 17,
        alSourceColumn: 9,
      },
    ];
    const engine = new StubEngine([events, []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    const msg: any = run.failedCalls[0].message;
    assert.ok(msg.location, 'TestMessage.location should be set');
    assert.strictEqual(msg.location.uri.fsPath, '/abs/Test.al');
    assert.strictEqual(msg.location.range.start.line, 16);
    assert.strictEqual(msg.location.range.start.character, 8);
  });

  test('coverageV2 in final result triggers run.addCoverage per file', async () => {
    const cov: ProtoFileCoverage[] = [
      { file: 'src/A.al', lines: [{ line: 1, hits: 1 }], totalStatements: 1, hitStatements: 1 },
      { file: 'src/B.al', lines: [{ line: 2, hits: 0 }], totalStatements: 1, hitStatements: 0 },
    ];
    // Use Run All so each app summary contributes coverage. Test fixture
    // has 2 apps → both summaries return same coverage shape, but each
    // call should result in addCoverage per FileCoverage emitted.
    const engine = new StubEngine(
      [[], []],
      [makeEmpty({ coverageV2: cov }), makeEmpty({ coverageV2: cov })],
    );
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    // Each app contributed two coverage entries.
    assert.strictEqual(run.coverageCalls.length, 4);
    // Each entry is a FileCoverage instance with a uri.
    for (const fc of run.coverageCalls) {
      assert.ok(fc.uri, 'each addCoverage entry should have a Uri');
    }
  });

  test('cancellation: token.cancel() invokes engine.cancel()', async () => {
    const engine = new StubEngine([[]], [makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();

    // Cancel BEFORE the run finishes. Because StubEngine resolves
    // synchronously, we wire cancel into the engine's runTests entry by
    // overriding it to fire cancel mid-flight.
    const originalRunTests = engine.runTests.bind(engine);
    engine.runTests = async (req, onTest) => {
      tokenSrc.cancel();
      return originalRunTests(req, onTest);
    };

    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    assert.strictEqual(engine.canceled, true, 'engine.cancel() should be called via token forwarding');
  });

  test('v1 fallback: protocolVersion undefined → applyV1Result populates run.passed/failed', async () => {
    // Build a v1-shape result (no protocolVersion, no streaming events).
    const v1Summary: ExecutionResult = {
      mode: 'test',
      tests: [
        { name: 'ComputeDoubles', status: 'passed', durationMs: 8, message: undefined, stackTrace: undefined, alSourceLine: undefined, alSourceColumn: undefined },
        { name: 'ComputeZero',    status: 'failed', durationMs: 3, message: 'oh no', stackTrace: undefined, alSourceLine: 42, alSourceColumn: 5 },
      ],
      messages: [],
      stderrOutput: [],
      summary: { passed: 1, failed: 1, errors: 0, total: 2 },
      coverage: [],
      exitCode: 1,
      durationMs: 11,
      capturedValues: [],
      cached: false,
      iterations: [],
      // protocolVersion intentionally omitted → v1 path.
    };
    const engine = new StubEngine([[], []], [v1Summary, v1Summary]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    // Both apps run; only the test app contributes test items in fixture,
    // but applyV1Result is called for both — the second pass simply
    // re-applies. Two passed + two failed total.
    assert.strictEqual(run.passedCalls.length, 2, 'two passes (one per app summary call)');
    assert.strictEqual(run.failedCalls.length, 2, 'two failures (one per app summary call)');

    // Verify TestMessage.location was built from alSourceLine + item.uri.
    const failMsg: any = run.failedCalls[0].message;
    assert.ok(failMsg.location, 'v1 failure should set message.location');
    assert.strictEqual(failMsg.location.range.start.line, 41);
    assert.strictEqual(failMsg.location.range.start.character, 4);
  });

  test('test item not found in map: streaming event silently dropped', async () => {
    const events: TestEvent[] = [
      { type: 'test', name: 'NotInTree', status: 'pass', durationMs: 1 },
      { type: 'test', name: 'ComputeDoubles', status: 'pass', durationMs: 5 },
    ];
    const engine = new StubEngine([events, []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    // Only the recognised test name produced a passed call.
    assert.strictEqual(run.passedCalls.length, 1);
    assert.strictEqual(run.passedCalls[0].item.label, 'ComputeDoubles');
  });

  test('error status routes to run.errored with TestMessage', async () => {
    const events: TestEvent[] = [
      { type: 'test', name: 'ComputeZero', status: 'error', durationMs: 4, message: 'compile error' },
    ];
    const engine = new StubEngine([events, []], [makeEmpty(), makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    assert.strictEqual(run.erroredCalls.length, 1);
    assert.strictEqual(run.erroredCalls[0].duration, 4);
    assert.strictEqual((run.erroredCalls[0].message as any).message, 'compile error');
    assert.strictEqual(run.passedCalls.length, 0);
    assert.strictEqual(run.failedCalls.length, 0);
  });

  test('loadDetailedCoverage callback returns details from getDetails', async () => {
    const cov: ProtoFileCoverage[] = [
      { file: 'src/A.al', lines: [{ line: 5, hits: 2 }, { line: 6, hits: 0 }], totalStatements: 2, hitStatements: 1 },
    ];
    const engine = new StubEngine([[]], [makeEmpty({ coverageV2: cov })]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;

    assert.ok(run.coverageCalls.length >= 1);
    const fc = run.coverageCalls[0];

    // Pull the loadDetailedCoverage callback off the run profile.
    const profile = mockController.__lastRunProfile;
    assert.ok(profile.loadDetailedCoverage, 'loadDetailedCoverage should be wired on the profile');

    const fakeRun: any = {};
    const fakeToken: any = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const details = await profile.loadDetailedCoverage(fakeRun, fc, fakeToken);
    assert.ok(Array.isArray(details));
    assert.strictEqual(details.length, 2);
    // Lines are 1-based on input → 0-based positions.
    assert.strictEqual((details[0].location as vscode.Position).line, 4);
    assert.strictEqual((details[1].location as vscode.Position).line, 5);
    assert.strictEqual(details[0].executed, 2);
    assert.strictEqual(details[1].executed, 0);
  });

  test('engine returns no coverageV2 → no addCoverage calls', async () => {
    const engine = new StubEngine([[]], [makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const run = mockController.__lastTestRun;
    assert.strictEqual(run.coverageCalls.length, 0);
  });

  test('captureValues + iterationTracking + coverage flags forwarded on every request', async () => {
    const engine = new StubEngine([[]], [makeEmpty()]);
    const { mockController } = await makeController(engine);
    const tokenSrc = new vscode.CancellationTokenSource();
    await triggerRun(mockController, new vscode.TestRunRequest(), tokenSrc.token);
    const req = engine.lastReq!;
    assert.strictEqual(req.captureValues, true);
    assert.strictEqual(req.iterationTracking, true);
    assert.strictEqual(req.coverage, true);
    assert.ok(Array.isArray(req.sourcePaths) && req.sourcePaths.length > 0);
  });

  test('setDecorationManager seam exists (used by T10)', async () => {
    const engine = new StubEngine([[]], [makeEmpty()]);
    const { controller } = await makeController(engine);
    // The seam need not do anything yet; it just needs to exist so T10
    // can wire DecorationManager.
    assert.strictEqual(typeof (controller as any).setDecorationManager, 'function');
    // Calling with a stub object should not throw.
    (controller as any).setDecorationManager({ applyResults: () => {} });
  });
});
