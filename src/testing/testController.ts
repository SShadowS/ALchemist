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

export class AlchemistTestController {
  private readonly controller: vscode.TestController;
  private readonly testItems = new Map<string, vscode.TestItem>();

  constructor(private readonly executor: Executor) {
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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

    token.onCancellationRequested(() => this.executor.cancel());

    if (request.include && request.include.length > 0) {
      // Run individual tests via --run
      for (const item of request.include) {
        // Test items use the test procedure name as their label
        await this.executor.execute('test', workspaceFolder.uri.fsPath, workspaceFolder.uri.fsPath, item.label);
      }
    } else {
      // Run all tests
      await this.executor.execute('test', workspaceFolder.uri.fsPath, workspaceFolder.uri.fsPath);
    }
  }

  /** Multi-app tree refresh. Replaces refreshTests in Task 12. */
  async refreshTestsFromModel(model: WorkspaceModel): Promise<void> {
    const tree = buildTestTree(model);
    this.controller.items.replace([]);
    this.testItems.clear();
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
          this.testItems.set(test.name, testItem);
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
