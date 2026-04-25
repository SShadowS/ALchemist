import * as vscode from 'vscode';
import * as path from 'path';
import { discoverTestsInWorkspace, discoverTestsInWorkspaceSync, DiscoveredTestCodeunit } from './testDiscovery';
import { Executor } from '../runner/executor';
import { ExecutionResult } from '../runner/outputParser';
import { WorkspaceModel } from '../workspace/workspaceModel';
import { AlApp } from '../workspace/types';

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

export class AlchemistTestController {
  private readonly controller: vscode.TestController;
  private readonly testItems = new Map<string, vscode.TestItem>();
  private readonly testItemsById = new Map<string, vscode.TestItem>();

  constructor(
    private readonly executor: Executor,
    private readonly model?: WorkspaceModel,
  ) {
    this.controller = vscode.tests.createTestController('alchemist', 'ALchemist');

    this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true
    );
  }

  /** @deprecated use refreshTestsFromModel — remains until Task 12 rewires extension.ts */
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
    token.onCancellationRequested(() => this.executor.cancel());

    if (!this.model) {
      // Legacy mode: fall back to single-folder behavior pre-Task-12 wiring.
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (!wsf) { return; }
      if (request.include && request.include.length > 0) {
        for (const item of request.include) {
          await this.executor.execute('test', wsf.uri.fsPath, wsf.uri.fsPath, item.label);
        }
      } else {
        await this.executor.execute('test', wsf.uri.fsPath, wsf.uri.fsPath);
      }
      return;
    }

    // Multi-app mode (Task 10+)
    if (request.include && request.include.length > 0) {
      const groups = groupTestItemsByApp(request.include);
      const apps = this.model.getApps();
      for (const [appId, items] of groups) {
        const app = apps.find(a => a.id === appId);
        if (!app) { continue; }
        // Routing semantics: only `test-` items pass --run <procName> to AL.Runner.
        // `app-*` and `codeunit-*` items fall through with procedureName=undefined,
        // which runs every test in that app. AL.Runner does not yet expose a
        // codeunit-scope flag; widening to app-level is the closest available
        // behavior for codeunit selections.
        for (const item of items) {
          const procedureName = item.id.startsWith('test-') ? (item as vscode.TestItem).label : undefined;
          await this.executor.execute('test', app.path, app.path, procedureName);
        }
      }
    } else {
      // Run All: iterate every app.
      for (const app of this.model.getApps()) {
        await this.executor.execute('test', app.path, app.path);
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
