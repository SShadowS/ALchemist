import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as sinon from 'sinon';
import { AlchemistTestController } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { ExecutionEngine, RunTestsRequest } from '../../src/execution/executionEngine';
import { ExecutionResult, TestResult } from '../../src/runner/outputParser';
import { TestEvent, FileCoverage } from '../../src/execution/protocolV2Types';

const FIX = path.resolve(__dirname, '../../../test/fixtures');
const SAMPLE_PATH = path.join(FIX, 'protocol-v2-samples', 'runtests-coverage-success.ndjson');

/** Load and parse the bundled NDJSON fixture into TestEvents + Summary. */
function loadSample(): { events: TestEvent[]; summary: any } {
  const raw = fs.readFileSync(SAMPLE_PATH, 'utf8');
  const lines = raw.split('\n').filter(l => l.length > 0);
  const events: TestEvent[] = [];
  let summary: any;
  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.type === 'test') {
      events.push(obj);
    } else if (obj.type === 'summary') {
      summary = obj;
    }
  }
  return { events, summary };
}

/**
 * FakeStreamingEngine that simulates the AL.Runner protocol v2 behavior:
 * - receives a RunTestsRequest and onTest callback
 * - emits test events via the callback
 * - returns an ExecutionResult with protocolVersion: 2
 */
class FakeStreamingEngine implements ExecutionEngine {
  public lastReq?: RunTestsRequest;
  public lastOnTest?: (e: TestEvent) => void;
  public canceled = false;

  constructor(
    private readonly events: TestEvent[],
    private readonly summary: any,
  ) {}

  async runTests(req: RunTestsRequest, onTest?: (e: TestEvent) => void): Promise<ExecutionResult> {
    this.lastReq = req;
    this.lastOnTest = onTest;
    if (onTest) {
      for (const ev of this.events) {
        onTest(ev);
      }
    }
    // Map fixture summary into ExecutionResult shape.
    return {
      mode: 'test',
      tests: this.events.map(e => ({
        name: e.name,
        status: e.status === 'pass' ? 'passed' : e.status === 'fail' ? 'failed' : 'errored',
        durationMs: e.durationMs,
        message: e.message,
        stackTrace: e.stackTrace,
        alSourceLine: e.alSourceLine,
        alSourceColumn: e.alSourceColumn,
        alSourceFile: e.alSourceFile,
        errorKind: e.errorKind,
        stackFrames: e.stackFrames,
        messages: e.messages,
        capturedValues: e.capturedValues as any,
      })) as TestResult[],
      messages: [],
      stderrOutput: [],
      summary: {
        passed: this.summary.passed,
        failed: this.summary.failed,
        errors: this.summary.errors,
        total: this.summary.total,
      },
      coverage: [],
      coverageV2: (this.summary.coverage as FileCoverage[] | undefined),
      exitCode: this.summary.exitCode,
      durationMs: 1,
      capturedValues: [],
      cached: this.summary.cached === true,
      cancelled: this.summary.cancelled === true,
      protocolVersion: this.summary.protocolVersion,
      iterations: [],
    };
  }

  async executeScratch(): Promise<ExecutionResult> {
    throw new Error('not used in this test');
  }

  isHealthy(): boolean {
    return true;
  }

  async cancel(): Promise<void> {
    this.canceled = true;
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}

suite('Integration — Plan E2 protocol v2 streaming', () => {
  test('Fake engine emits streaming events; controller drives runTests through real VS Code APIs', async () => {
    const vscode = require('vscode');
    const { events, summary } = loadSample();

    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const engine = new FakeStreamingEngine(events, summary);
    const onResult = sinon.spy();
    const controller = new AlchemistTestController(() => engine, model, onResult);
    await controller.refreshTestsFromModel(model);

    const request = new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();
    await (controller as any).runTests(request, cts.token);

    // Engine got an onTest callback (proof of the streaming wiring).
    assert.ok(engine.lastOnTest, 'engine.runTests must receive onTest callback');

    // onResult fires once per app — multi-app fixture has 2 apps.
    assert.ok(
      onResult.callCount >= 1,
      `onResult fires at least once, got ${onResult.callCount} calls`,
    );

    // The fake engine's resolved result has protocolVersion 2.
    const lastResult = onResult.lastCall.args[0] as ExecutionResult;
    assert.strictEqual(
      lastResult.protocolVersion,
      2,
      'result.protocolVersion must be 2',
    );

    controller.dispose();
    cts.dispose();
  });

  test('Cancel forwards through controller to engine via CancellationToken', async () => {
    const vscode = require('vscode');
    const { events, summary } = loadSample();

    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const engine = new FakeStreamingEngine(events, summary);
    const controller = new AlchemistTestController(() => engine, model, sinon.spy());
    await controller.refreshTestsFromModel(model);

    const request = new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();

    // Start the run promise without awaiting it yet
    const runPromise = (controller as any).runTests(request, cts.token);
    // Immediately cancel
    cts.cancel();
    // Wait for the run to complete
    await runPromise;

    assert.strictEqual(
      engine.canceled,
      true,
      'engine.cancel must be invoked when CancellationToken fires',
    );

    controller.dispose();
    cts.dispose();
  });

  test('Per-test events have all v2 fields available for downstream consumption', async () => {
    const { events } = loadSample();

    // Verify the fixture parses to events with the expected v2 fields.
    const failing = events.find(e => e.status === 'fail');
    assert.ok(failing, 'fixture must contain a failing test event');

    assert.ok(failing!.alSourceFile, 'failing event has alSourceFile');
    assert.ok(typeof failing!.alSourceLine === 'number', 'failing event has alSourceLine');
    assert.ok(typeof failing!.alSourceColumn === 'number', 'failing event has alSourceColumn');
    assert.ok(failing!.errorKind, 'failing event has errorKind');
    assert.ok(failing!.stackFrames, 'failing event has stackFrames');
    assert.ok(
      failing!.stackFrames!.length > 0,
      'failing event stackFrames non-empty',
    );

    // At least one frame is a user frame (.al filename).
    const userFrame = failing!.stackFrames!.find(f =>
      f.source?.path?.toLowerCase().endsWith('.al'));
    assert.ok(userFrame, 'failing event has a user .al frame');
  });

  test('TestRun.addCoverage receives FileCoverage when summary has coverage', async () => {
    const vscode = require('vscode');
    const { events, summary } = loadSample();

    // Verify the fixture includes coverage data
    assert.ok(summary.coverage && summary.coverage.length > 0, 'fixture must have coverage data');

    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    // Wrap vscode.tests.createTestController to capture the TestRun instance
    const realCreate = vscode.tests.createTestController.bind(vscode.tests);
    const capturedRuns: any[] = [];
    const coverageCalls: any[] = [];

    const wrappedCreate = (id: string, label: string) => {
      const ctrl = realCreate(id, label);
      const realCreateRun = ctrl.createTestRun.bind(ctrl);
      ctrl.createTestRun = (req: any) => {
        const run = realCreateRun(req);
        capturedRuns.push(run);
        // Monkey-patch addCoverage to track calls
        const realAddCoverage = run.addCoverage.bind(run);
        run.addCoverage = (fc: any) => {
          coverageCalls.push(fc);
          return realAddCoverage(fc);
        };
        return run;
      };
      return ctrl;
    };

    vscode.tests.createTestController = wrappedCreate;

    try {
      const engine = new FakeStreamingEngine(events, summary);
      const controller = new AlchemistTestController(() => engine, model, sinon.spy());
      await controller.refreshTestsFromModel(model);

      const request = new vscode.TestRunRequest();
      const cts = new vscode.CancellationTokenSource();
      await (controller as any).runTests(request, cts.token);

      // Assert that addCoverage was called at least once
      assert.ok(
        coverageCalls.length > 0,
        `addCoverage should be called at least once, but got ${coverageCalls.length} calls`,
      );

      // Verify the coverage object has the expected shape
      const firstCoverage = coverageCalls[0];
      assert.ok(firstCoverage.uri, 'FileCoverage has uri property');
      assert.ok(firstCoverage.statementCoverage, 'FileCoverage has statementCoverage property');

      controller.dispose();
      cts.dispose();
    } finally {
      // Restore the original vscode.tests.createTestController
      vscode.tests.createTestController = realCreate;
    }
  });

  test('cursor-driven setActiveTest helper resolves a TestItem in the controller', async () => {
    const vscode = require('vscode');
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const engine = new FakeStreamingEngine([], {
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2,
    });
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);

    const items = controller.getTestItemsById();
    assert.ok(items.size > 0, 'controller must populate testItemsById from fixture');

    // Find the first test-prefixed item with a uri + range.
    let target: any;
    for (const item of items.values()) {
      if (item.id.startsWith('test-') && item.uri && item.range) {
        target = item;
        break;
      }
    }
    assert.ok(target, 'fixture must have at least one test item with uri + range');

    const { findTestItemAtPosition } = require('../../src/testing/testFinder');
    const found = findTestItemAtPosition(items, target.uri, target.range.start);
    assert.strictEqual(found?.label, target.label);

    controller.dispose();
  });
});
