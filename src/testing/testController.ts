import * as vscode from 'vscode';
import * as path from 'path';
import { discoverTestsInWorkspace, discoverTestsInWorkspaceSync, DiscoveredTestCodeunit } from './testDiscovery';
import { ExecutionEngine } from '../execution/executionEngine';
import { ExecutionResult, CapturedValue } from '../runner/outputParser';
import { TestEvent } from '../execution/protocolV2Types';
import { WorkspaceModel } from '../workspace/workspaceModel';
import { AlApp } from '../workspace/types';
import { toVsCodeCoverage, getDetails } from '../execution/coverageAdapter';
import { v2ToV1Captured } from '../execution/captureValueAdapter';

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
 *
 * `setActiveTest` is used by `handleStreamingEvent` (Option A heuristic):
 * the most-recent streaming test becomes the active test, so its captures
 * win at the end of a run. Cursor-driven selection (Option B in the
 * design notes) is a future polish — it would subscribe to
 * `vscode.window.onDidChangeActiveTextEditor` /
 * `onDidChangeTextEditorSelection` and pick the `[Test]` proc the
 * cursor is in.
 */
export interface TestControllerDecorationSink {
  applyResults(editor: vscode.TextEditor, result: ExecutionResult, wsPath: string): void;
  setCapturedValuesForTest(testName: string, values: CapturedValue[]): void;
  clearCapturedValueScopes(): void;
  setActiveTest(testName: string | undefined): void;
}

export class AlchemistTestController {
  private readonly controller: vscode.TestController;
  private readonly testItemsById = new Map<string, vscode.TestItem>();
  private decorationManager?: TestControllerDecorationSink;

  /**
   * Owning-app guid for the test currently being processed. Set in
   * `runTests`'s per-app loop and (transiently) in `updateFromResult`.
   * Used by `resolveTestItemByName` to disambiguate between same-named
   * tests living in different apps. Undefined outside a run; the
   * resolver then falls back to a first-match search across all items.
   */
  private currentAppId: string | undefined;

  /**
   * Item ids reported (passed/failed/errored) during the current run.
   * Cleared at the start of each `runTests` invocation. Used by the
   * cancel-cleanup path to mark unreported items as `skipped` per
   * spec §471. Tracked inside `handleStreamingEvent` (v2) and
   * `applyV1Result` (v1 fallback).
   */
  private reportedItemIds = new Set<string>();

  /**
   * Resolve a TestItem by procedure name in the context of the currently
   * running app. Used by `handleStreamingEvent`, `applyV1Result`, and
   * `updateFromResult` to map a v2 TestEvent (which carries only the
   * procedure name, no app context) back to the compound-id TestItem.
   *
   * For multi-app workspaces with same-named tests across apps, the
   * appId scope avoids collisions. When no run is active
   * (`currentAppId` undefined), the lookup walks `testItemsById` and
   * returns the first test with a matching label — preserving the
   * single-app behaviour at the cost of the documented collision risk
   * in legacy save paths.
   */
  private resolveTestItemByName(testName: string): vscode.TestItem | undefined {
    if (this.currentAppId) {
      const prefix = `test-${this.currentAppId}-`;
      for (const [id, item] of this.testItemsById) {
        if (id.startsWith(prefix) && item.label === testName) {
          return item;
        }
      }
      return undefined;
    }
    // Fallback: any app, first match.
    for (const item of this.testItemsById.values()) {
      if (item.id.startsWith('test-') && item.label === testName) {
        return item;
      }
    }
    return undefined;
  }

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
        // Empty array signals "no per-statement detail available" — VS Code
        // then degrades to file-level summary, which is the desired fallback
        // for FileCoverage instances created outside this adapter (e.g.
        // synthetic FCs minted by tests, or non-streaming code paths that
        // didn't register details with the adapter cache).
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

  /**
   * Read-only access to the compound-id TestItem map. Used by the cursor-driven
   * active-test selector (extension.ts). The map updates on
   * `refreshTestsFromModel`; the returned reference reflects the current state
   * but is not stable across refreshes.
   */
  getTestItemsById(): ReadonlyMap<string, vscode.TestItem> {
    return this.testItemsById;
  }

  /** @deprecated use refreshTestsFromModel; legacy path retained for backward compat. Will be removed once all callers migrate. */
  async refreshTests(workspacePath: string): Promise<void> {
    const codeunits = await discoverTestsInWorkspace(workspacePath);

    // Clear existing items
    this.controller.items.replace([]);
    this.testItemsById.clear();

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
        // Legacy single-folder path predates compound app-scoped ids.
        // testItemsById is keyed by the legacy `test-<codeunitId>-<name>`
        // shape here; the resolver's app-scoped prefix won't match these
        // entries (no app guid in the id), so this path effectively only
        // works when currentAppId is undefined and the fallback walk
        // matches by label.
        this.testItemsById.set(`test-${codeunit.codeunitId}-${test.name}`, testItem);
      }

      this.controller.items.add(codeunitItem);
    }
  }

  /**
   * Legacy entry: retained for save-triggered runs that go through
   * `extension.ts:handleResult`. Streaming runs (Test Explorer) populate
   * the run via `runTests` directly and never invoke this method.
   *
   * STATUS: deferred. The save-triggered path still uses the
   * v1-result-application semantics (a synthetic TestRun is created here,
   * passed/failed are emitted in one batch). Threading the save path
   * through the streaming pipe — so it picks up clickable stack frames,
   * native coverage, and Test-Explorer integration — is tracked as a
   * follow-up; see CHANGELOG known limitations.
   */
  updateFromResult(result: ExecutionResult, appId?: string): void {
    if (result.mode !== 'test') { return; }

    // Scope test-name resolution to the caller-supplied app for the
    // duration of this method. If the caller doesn't have app context
    // (single-folder workspace, scratch path, etc.), `currentAppId`
    // stays whatever it was — typically undefined — and the resolver
    // falls back to a label-only search across all known items.
    const prevAppId = this.currentAppId;
    this.currentAppId = appId ?? prevAppId;
    try {
      const run = this.controller.createTestRun(new vscode.TestRunRequest());

      for (const testResult of result.tests) {
        const item = this.resolveTestItemByName(testResult.name);
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
    } finally {
      this.currentAppId = prevAppId;
    }
  }

  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const engine = this.getEngine();
    if (!engine) {
      vscode.window.showErrorMessage('ALchemist: AL.Runner not yet ready');
      return;
    }

    const run = this.controller.createTestRun(request);

    // Clear captured value scopes at the start of each run (T10 wiring).
    this.decorationManager?.clearCapturedValueScopes();

    // Reset per-run reporting bookkeeping. C1: required so the cancel
    // cleanup path can compute the set of *unreported* items.
    this.reportedItemIds.clear();

    // Cancel forwarding: any token cancellation triggers engine.cancel().
    // C2: a `runDone` flag turns the listener into a no-op once the run
    // finishes, preventing a late cancel (e.g. user clicks cancel just
    // after the final summary lands) from racing with the next run.
    // I1: rejection from engine.cancel() is logged rather than left as
    // an unhandled promise rejection — the engine implementation is
    // fire-and-forget, but we don't want silent failures.
    let runDone = false;
    const cancelSub = token.onCancellationRequested(() => {
      if (runDone) { return; }
      engine.cancel().catch(err => {
        console.error('[ALchemist] engine.cancel() failed during user cancellation', err);
      });
    });

    try {
      if (!this.model) {
        // Legacy single-folder fallback: invoked when the controller is
        // constructed without a WorkspaceModel (older code paths).
        const wsf = vscode.workspace.workspaceFolders?.[0];
        if (!wsf) { return; }
        if (token.isCancellationRequested) { return; }
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
      //
      // C1: cancellation must short-circuit the loop so we don't keep
      // launching new runtests invocations after the user clicked
      // cancel. The current iteration's await may still be in flight,
      // but no new app is started.
      //
      // currentAppId is set per-iteration so handleStreamingEvent and
      // applyV1Result can scope name lookups to the running app — same
      // bare procedure name across two apps must resolve to the right
      // TestItem.
      const appsToRun = this.resolveAppsForRequest(request);
      for (const app of appsToRun) {
        if (token.isCancellationRequested) { break; }
        this.currentAppId = app.id;
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
      // Order is load-bearing: clear currentAppId, flip runDone so any
      // cancel listener that fires between here and dispose() becomes a
      // no-op. Then dispose, then mark unreported items as skipped
      // (which only matters when cancellation actually happened), then
      // end the run.
      this.currentAppId = undefined;
      runDone = true;
      cancelSub.dispose();
      if (token.isCancellationRequested) {
        // C1: per spec §471, items that didn't get a passed/failed/
        // errored event during a cancelled run should be reported as
        // `skipped` so VS Code shows them in a neutral state instead of
        // leaving them stuck in the running spinner.
        const candidateItems: vscode.TestItem[] = request.include && request.include.length > 0
          ? Array.from(request.include)
          : Array.from(this.testItemsById.values());
        for (const item of candidateItems) {
          if (!this.reportedItemIds.has(item.id)) {
            run.skipped(item);
          }
        }
      }
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
   * errored call. Items unresolvable by the current name+app context
   * are silently dropped — this typically means the discovered tree is
   * stale; the next refresh will re-include them.
   */
  private handleStreamingEvent(run: vscode.TestRun, event: TestEvent): void {
    if (event.type !== 'test') { return; }
    const item = this.resolveTestItemByName(event.name);
    if (!item) { return; }
    // Track the item id BEFORE dispatching so the cancel-cleanup path
    // (C1) doesn't double-report a still-running event as skipped.
    this.reportedItemIds.add(item.id);
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

    // Route per-test capturedValues to DecorationManager when set (T10 wiring).
    if (this.decorationManager) {
      if (event.capturedValues && event.capturedValues.length > 0) {
        // Translate v2 CapturedValue → v1 CapturedValue shape via the adapter.
        const translated = event.capturedValues.map(cv => v2ToV1Captured(cv, event.alSourceFile));
        this.decorationManager.setCapturedValuesForTest(event.name, translated);
      }
      // Option A active-test heuristic: the most-recent streaming test
      // becomes the active test. After the run, the LAST test's captures
      // are what shows in the editor — usually the user's focus. We fire
      // this for every streaming `test` event regardless of whether
      // captures were attached, so the active scope tracks emission order
      // even when a test had nothing to capture.
      // Option B (cursor-driven selection — track the [Test] proc the
      // cursor is in via onDidChangeTextEditorSelection) is the eventual
      // UX; it lands in a follow-up release.
      this.decorationManager.setActiveTest(event.name);
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
      // I4: TODO — VS Code 1.93's TestMessageStackFrame constructor
      // doesn't expose a presentationHint slot. AlStackFrame's hint
      // ('normal' | 'subtle' | 'deemphasize' | 'label') is dropped here.
      // When the VS Code API gains a hint parameter, thread
      // f.presentationHint through to the constructor.
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
    // I3: v2 native coverage path. We pass each FileCoverage straight
    // through to VS Code's gutter renderer via run.addCoverage. The
    // legacy v1 path populates `result.coverage` (cobertura-derived) and
    // is still rendered by the custom DecorationManager that
    // extension.ts wires up via setDecorationManager — Task 9 retires
    // that custom path once protocol v2 is the default everywhere.
    if (result.coverageV2 && typeof (run as unknown as { addCoverage?: (fc: vscode.FileCoverage) => void }).addCoverage === 'function') {
      const fcs = toVsCodeCoverage(result.coverageV2);
      for (const fc of fcs) {
        run.addCoverage(fc);
      }
    }

    // I2: v2 streaming already populated the run via
    // handleStreamingEvent. The v1 fallback re-runs the result.tests[]
    // walk for non-v2 servers.
    //
    // applyV1Result fires once per app iteration. Resolution of a
    // result.tests[].name to a TestItem is now scoped to
    // `currentAppId` (set by the runTests loop), so a v1 summary
    // produced by app A only emits run.passed/failed for app-A test
    // items even when test names collide with app B. The previous
    // bare-name lookup duplicated emissions across apps; that
    // duplication is fixed.
    if (result.protocolVersion !== 2) {
      this.applyV1Result(run, result);
    }
  }

  private applyV1Result(run: vscode.TestRun, result: ExecutionResult): void {
    for (const t of result.tests) {
      const item = this.resolveTestItemByName(t.name);
      if (!item) { continue; }
      // C1: track this id as reported so cancel-cleanup doesn't
      // additionally mark it skipped.
      this.reportedItemIds.add(item.id);
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
          // testItemsById (compound id) is the canonical index. Name
          // resolution at run-time goes through resolveTestItemByName,
          // which scopes lookups to the currently-running app — no
          // cross-app collision.
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
