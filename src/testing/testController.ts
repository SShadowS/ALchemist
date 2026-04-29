import * as vscode from 'vscode';
import * as path from 'path';
import { discoverTestsInWorkspace, discoverTestsInWorkspaceSync, DiscoveredTestCodeunit } from './testDiscovery';
import { ExecutionEngine } from '../execution/executionEngine';
import { ExecutionResult } from '../runner/outputParser';
import { TestEvent } from '../execution/protocolV2Types';
import { WorkspaceModel } from '../workspace/workspaceModel';
import { AlApp } from '../workspace/types';
import { toVsCodeCoverage, getDetails } from '../execution/coverageAdapter';

export interface TestTreeAppNode {
  app: AlApp;
  codeunits: DiscoveredTestCodeunit[];
}

/**
 * Pure helper: for each app in the workspace model, discover its tests and
 * return the App → Codeunit → Procedure tree as plain data. The VS Code
 * TestController wraps this into TestItems.
 */
export function buildTestTree(model: WorkspaceModel): TestTreeAppNode[] {
  return model.getApps().map(app => ({
    app,
    codeunits: discoverTestsInWorkspaceSync(app.path),
  }));
}

/**
 * Groups TestItems by their owning app id, extracted from the compound id
 * format used by refreshTestsFromModel:
 *   app-<guid>
 *   codeunit-<guid>-<codeunitId>
 *   test-<guid>-<codeunitId>-<procName>
 *
 * App GUIDs are 8-4-4-4-12 hex chars (standard UUID format). Items whose ids
 * do not match this pattern are placed in the empty-string bucket.
 */
export function groupTestItemsByApp(items: readonly { id: string }[]): Map<string, { id: string }[]> {
  const groups = new Map<string, { id: string }[]>();
  // Match prefix (app|codeunit|test) followed by a full GUID (8-4-4-4-12 hex).
  const idPattern = /^(?:app|codeunit|test)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  for (const item of items) {
    const match = idPattern.exec(item.id);
    const appId = match ? match[1] : '';
    const list = groups.get(appId) ?? [];
    list.push(item);
    groups.set(appId, list);
  }
  return groups;
}

/**
 * Minimal interface T8 needs to expose for T10 wiring. Decoupled from
 * the concrete DecorationManager so the testing layer doesn't pull in
 * the editor-decoration module surface area.
 */
export interface TestControllerDecorationSink {
  applyResults(editor: vscode.TextEditor, result: ExecutionResult, wsPath: string): void;
}

export class AlchemistTestController {
  private readonly controller: vscode.TestController;
  private readonly testItems = new Map<string, vscode.TestItem>();
  private readonly testItemsById = new Map<string, vscode.TestItem>();
  private decorationManager?: TestControllerDecorationSink;

  constructor(
    private readonly getEngine: () => ExecutionEngine | undefined,
    private readonly model?: WorkspaceModel,
    private readonly onResult?: (result: ExecutionResult) => void,
  ) {
    this.controller = vscode.tests.createTestController('alchemist', 'ALchemist');

    const runProfile = this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true,
    );

    // VS Code 1.88+ supports loadDetailedCoverage on run profiles. We
    // feature-detect via property assignability rather than a typeof
    // check on the prototype because the @types/vscode declaration may
    // not yet expose it.
    if (runProfile && 'loadDetailedCoverage' in runProfile) {
      (runProfile as unknown as {
        loadDetailedCoverage?: (
          testRun: vscode.TestRun,
          fc: vscode.FileCoverage,
          token: vscode.CancellationToken,
        ) => Promise<vscode.StatementCoverage[]>;
      }).loadDetailedCoverage = async (_testRun, fc, _token) => {
        return getDetails(fc) ?? [];
      };
    }
  }

  /**
   * Seam used by T10 so the on-save DecorationManager can be invoked
   * with the same `ExecutionResult` the streaming run produces. Held in
   * a private field; stays unused inside this class for now.
   */
  setDecorationManager(dm: TestControllerDecorationSink): void {
    this.decorationManager = dm;
  }

  /** @deprecated use refreshTestsFromModel; legacy path retained for backward compat. Will be removed once all callers migrate. */
  async refreshTests(workspacePath: string): Promise<void> {
    const codeunits = await discoverTestsInWorkspace(workspacePath);

    // Clear existing items
    this.controller.items.replace([]);
    this.testItems.clear();

    for (const codeunit of codeunits) {
      const codeunitItem = this.controller.createTestItem(
        `codeunit-${codeunit.codeunitId}`,
        codeunit.codeunitName,
        vscode.Uri.file(path.join(workspacePath, codeunit.fileName))
      );

      for (const test of codeunit.tests) {
        const testItem = this.controller.createTestItem(
          `test-${codeunit.codeunitId}-${test.name}`,
          test.name,
          vscode.Uri.file(path.join(workspacePath, codeunit.fileName))
        );
        testItem.range = new vscode.Range(test.line, 0, test.line, 0);
        codeunitItem.children.add(testItem);
        this.testItems.set(test.name, testItem);
      }

      this.controller.items.add(codeunitItem);
    }
  }

  /**
   * Legacy entry: retained for save-triggered runs that go through
   * `extension.ts:handleResult`. Streaming runs (Test Explorer) populate
   * the run via `runTests` directly and never invoke this method.
   *
   * Deliberately unchanged in T8: T10 will revisit once the on-save path
   * is wired through the same protocol-v2 streaming pipe.
   */
  updateFromResult(result: ExecutionResult): void {
    if (result.mode !== 'test') { return; }

    const run = this.controller.createTestRun(new vscode.TestRunRequest());

    for (const testResult of result.tests) {
      const item = this.testItems.get(testResult.name);
      if (!item) { continue; }

      if (testResult.status === 'passed') {
        run.passed(item, testResult.durationMs);
      } else if (testResult.status === 'failed') {
        const message = new vscode.TestMessage(testResult.message || 'Test failed');
        if (testResult.alSourceLine && item.uri) {
          const col = testResult.alSourceColumn ? testResult.alSourceColumn - 1 : 0;
          message.location = new vscode.Location(item.uri, new vscode.Position(testResult.alSourceLine - 1, col));
        }
        run.failed(item, message, testResult.durationMs);
      } else {
        const message = new vscode.TestMessage(testResult.message || 'Test errored');
        run.errored(item, message, testResult.durationMs);
      }
    }

    run.end();
  }

  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const engine = this.getEngine();
    if (!engine) {
      vscode.window.showErrorMessage('ALchemist: AL.Runner not yet ready');
      return;
    }

    const run = this.controller.createTestRun(request);

    // Cancel forwarding: any token cancellation triggers engine.cancel().
    // The engine implementation is fire-and-forget; mid-stream events
    // already received remain on the run, and the final summary still
    // arrives (with `cancelled: true` in v2).
    const cancelSub = token.onCancellationRequested(() => {
      void engine.cancel();
    });

    try {
      if (!this.model) {
        // Legacy single-folder fallback: invoked when the controller is
        // constructed without a WorkspaceModel (older code paths).
        const wsf = vscode.workspace.workspaceFolders?.[0];
        if (!wsf) { return; }
        const result = await engine.runTests(
          { sourcePaths: [wsf.uri.fsPath], captureValues: true, iterationTracking: true, coverage: true },
          (event) => this.handleStreamingEvent(run, event),
        );
        this.applyFinalResult(run, result);
        this.onResult?.(result);
        return;
      }

      // Multi-app mode (T8+): each app is a separate runtests invocation
      // with the dependency closure as the source-paths list. Selection
      // narrows the set of apps; Run All iterates every app.
      const appsToRun = this.resolveAppsForRequest(request);
      for (const app of appsToRun) {
        const depPaths = this.model.getDependencies(app.id).map(a => a.path);
        const sourcePaths = depPaths.length > 0 ? depPaths : [app.path];
        const result = await engine.runTests(
          { sourcePaths, captureValues: true, iterationTracking: true, coverage: true },
          (event) => this.handleStreamingEvent(run, event),
        );
        this.applyFinalResult(run, result);
        this.onResult?.(result);
      }
    } finally {
      cancelSub.dispose();
      run.end();
    }
  }

  /**
   * Resolves which apps to invoke given a TestRunRequest. With no
   * include selection we run every app in the model; otherwise we group
   * the selected items by app guid and intersect with the model's apps.
   */
  private resolveAppsForRequest(request: vscode.TestRunRequest): AlApp[] {
    if (!this.model) { return []; }
    const apps = this.model.getApps();
    if (!request.include || request.include.length === 0) {
      return apps;
    }
    const groups = groupTestItemsByApp(request.include);
    const result: AlApp[] = [];
    for (const [appId] of groups) {
      const app = apps.find(a => a.id === appId);
      if (app) { result.push(app); }
    }
    return result;
  }

  /**
   * Translates one v2 TestEvent into the appropriate run.passed/failed/
   * errored call. Items not present in `testItems` are silently dropped
   * — this typically means the discovered tree is stale; the next
   * refresh will re-include them.
   */
  private handleStreamingEvent(run: vscode.TestRun, event: TestEvent): void {
    if (event.type !== 'test') { return; }
    const item = this.testItems.get(event.name);
    if (!item) { return; }
    if (event.status === 'pass') {
      run.passed(item, event.durationMs);
    } else if (event.status === 'fail') {
      run.failed(item, this.buildTestMessage(event), event.durationMs);
    } else {
      // 'error' — runtime/compile/setup categories all collapse to the
      // run.errored channel, which VS Code renders distinctly from
      // failed assertions.
      run.errored(item, this.buildTestMessage(event), event.durationMs);
    }
  }

  /**
   * Builds a TestMessage from a v2 TestEvent, including:
   * - clickable structured stack frames (VS Code 1.93+, feature-detected)
   * - failure location pinned to the deepest user frame
   * Both are optional; absence is fine.
   */
  private buildTestMessage(event: TestEvent): vscode.TestMessage {
    const message = new vscode.TestMessage(event.message ?? 'Test failed');

    // VS Code 1.93+ supports TestMessageStackFrame for clickable failure
    // frames. We feature-detect via the namespace export; @types/vscode
    // 1.88 doesn't declare it, hence the casts.
    const StackFrameCtor = (vscode as unknown as { TestMessageStackFrame?: new (label: string, uri?: vscode.Uri, position?: vscode.Position) => unknown }).TestMessageStackFrame;
    if (StackFrameCtor && event.stackFrames && event.stackFrames.length > 0) {
      (message as unknown as { stackTrace?: unknown[] }).stackTrace = event.stackFrames.map(f => new StackFrameCtor(
        f.name ?? '',
        f.source?.path ? vscode.Uri.file(f.source.path) : undefined,
        f.line !== undefined
          ? new vscode.Position(f.line - 1, Math.max(0, (f.column ?? 1) - 1))
          : undefined,
      ));
    }

    if (event.alSourceFile && event.alSourceLine !== undefined) {
      message.location = new vscode.Location(
        vscode.Uri.file(event.alSourceFile),
        new vscode.Position(event.alSourceLine - 1, Math.max(0, (event.alSourceColumn ?? 1) - 1)),
      );
    }

    return message;
  }

  /**
   * Applies the per-app summary's residual data to the run:
   * - emits `addCoverage` per FileCoverage when v2 coverage is present
   * - falls back to v1-shape per-test rendering when streaming events
   *   weren't carried (i.e. v1 server, or future v2 protocol regression)
   */
  private applyFinalResult(run: vscode.TestRun, result: ExecutionResult): void {
    // VS Code native coverage rendering: only when result has v2
    // coverage and the TestRun supports addCoverage.
    if (result.coverageV2 && typeof (run as unknown as { addCoverage?: (fc: vscode.FileCoverage) => void }).addCoverage === 'function') {
      const fcs = toVsCodeCoverage(result.coverageV2);
      for (const fc of fcs) {
        run.addCoverage(fc);
      }
    }

    // If no streaming events were received (v1 or no protocol detected),
    // apply the v1-style summary to populate the run. We detect via
    // protocolVersion; v2 results have it set, v1 doesn't.
    if (result.protocolVersion !== 2) {
      this.applyV1Result(run, result);
    }
  }

  private applyV1Result(run: vscode.TestRun, result: ExecutionResult): void {
    for (const t of result.tests) {
      const item = this.testItems.get(t.name);
      if (!item) { continue; }
      if (t.status === 'passed') {
        run.passed(item, t.durationMs);
      } else if (t.status === 'failed') {
        const msg = new vscode.TestMessage(t.message ?? 'Test failed');
        if (t.alSourceLine && item.uri) {
          msg.location = new vscode.Location(
            item.uri,
            new vscode.Position(t.alSourceLine - 1, Math.max(0, (t.alSourceColumn ?? 1) - 1)),
          );
        }
        run.failed(item, msg, t.durationMs);
      } else {
        run.errored(item, new vscode.TestMessage(t.message ?? 'Test errored'), t.durationMs);
      }
    }
  }

  /**
   * Multi-app tree refresh. Replaces refreshTests in Task 12.
   *
   * INVARIANT: the `model` passed here must be the same instance stored in
   * `this.model` at construction time. The tree's TestItem ids embed app
   * GUIDs from `model.getApps()`, and `runTests` routes selections back via
   * `this.model.getApps()`. If they diverge, `runTests` silently drops items
   * because `apps.find(a => a.id === appId)` returns undefined.
   */
  async refreshTestsFromModel(model: WorkspaceModel): Promise<void> {
    const tree = buildTestTree(model);
    this.controller.items.replace([]);
    this.testItems.clear();
    this.testItemsById.clear();
    for (const node of tree) {
      const appItem = this.controller.createTestItem(
        `app-${node.app.id}`,
        node.app.name,
        vscode.Uri.file(node.app.path),
      );
      for (const codeunit of node.codeunits) {
        const codeunitItem = this.controller.createTestItem(
          `codeunit-${node.app.id}-${codeunit.codeunitId}`,
          codeunit.codeunitName,
          vscode.Uri.file(path.join(node.app.path, codeunit.fileName)),
        );
        for (const test of codeunit.tests) {
          const testItem = this.controller.createTestItem(
            `test-${node.app.id}-${codeunit.codeunitId}-${test.name}`,
            test.name,
            vscode.Uri.file(path.join(node.app.path, codeunit.fileName)),
          );
          testItem.range = new vscode.Range(test.line, 0, test.line, 0);
          codeunitItem.children.add(testItem);
          // Maintain two indices:
          // - testItems (bare name): used by legacy updateFromResult; will be removed
          //   once execution paths carry app context (Task 10+).
          // - testItemsById (compound id): canonical key, no cross-app collision.
          this.testItems.set(test.name, testItem);
          this.testItemsById.set(`test-${node.app.id}-${codeunit.codeunitId}-${test.name}`, testItem);
        }
        appItem.children.add(codeunitItem);
      }
      this.controller.items.add(appItem);
    }
  }

  dispose(): void {
    this.controller.dispose();
  }
}
