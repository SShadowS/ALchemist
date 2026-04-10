import * as vscode from 'vscode';
import * as path from 'path';
import { AlRunnerManager } from './runner/alRunnerManager';
import { Executor } from './runner/executor';
import { DecorationManager } from './editor/decorations';
import { CoverageHoverProvider } from './editor/hoverProvider';
import { AlchemistOutputChannel } from './output/outputChannel';
import { StatusBarManager } from './output/statusBar';
import { ScratchManager, isScratchFile, isProjectAware } from './scratch/scratchManager';
import { AlchemistTestController } from './testing/testController';

let runnerManager: AlRunnerManager;
let executor: Executor;
let decorationManager: DecorationManager;
let outputChannel: AlchemistOutputChannel;
let statusBar: StatusBarManager;
let scratchManager: ScratchManager;
let testController: AlchemistTestController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize components
  runnerManager = new AlRunnerManager();
  executor = new Executor(runnerManager);
  decorationManager = new DecorationManager(context.extensionPath);
  outputChannel = new AlchemistOutputChannel();
  statusBar = new StatusBarManager();
  scratchManager = new ScratchManager(context.globalStorageUri.fsPath);
  testController = new AlchemistTestController(executor);

  // Ensure AL.Runner is available
  try {
    await runnerManager.ensureInstalled();
  } catch {
    // Will show error when user tries to run
  }

  // Check for updates (non-blocking)
  runnerManager.checkForUpdates();

  // Discover tests in workspace
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    testController.refreshTests(workspaceFolder.uri.fsPath);
  }

  // --- Event handlers ---

  // Executor events
  context.subscriptions.push(
    executor.onStart((mode) => {
      statusBar.setRunning(mode);
    }),
    executor.onFinish((result) => {
      statusBar.setResult(result);

      // Get the active editor's file name for the output channel
      const activeFile = vscode.window.activeTextEditor?.document.fileName || 'unknown';
      outputChannel.displayResult(result, path.basename(activeFile));

      // Apply decorations to active editor
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const wsPath = workspaceFolder?.uri.fsPath || path.dirname(editor.document.uri.fsPath);
        decorationManager.applyResults(editor, result, wsPath);
      }

      // Update Test Explorer
      testController.updateFromResult(result);
    })
  );

  // On-save handler
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId !== 'al') return;

      const config = vscode.workspace.getConfiguration('alchemist');
      if (!config.get<boolean>('runOnSave', true)) return;

      if (!runnerManager.getPath()) {
        try {
          await runnerManager.ensureInstalled();
        } catch {
          return;
        }
      }

      const filePath = doc.uri.fsPath;

      if (isScratchFile(filePath)) {
        // Scratch mode
        const content = doc.getText();
        const wsPath = workspaceFolder?.uri.fsPath;
        if (isProjectAware(content) && wsPath) {
          await executor.execute('scratch-project', filePath, wsPath);
        } else {
          await executor.execute('scratch-standalone', filePath);
        }
      } else if (workspaceFolder) {
        // Test mode
        const testRunScope = config.get<string>('testRunOnSave', 'current');
        if (testRunScope === 'off') return;
        await executor.execute('test', filePath, workspaceFolder.uri.fsPath);
      }
    })
  );

  // Refresh tests on file changes
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'al' && workspaceFolder && !isScratchFile(doc.uri.fsPath)) {
        testController.refreshTests(workspaceFolder.uri.fsPath);
      }
    })
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.newScratchFile', () =>
      scratchManager.newScratchFile(context.extensionPath)
    ),
    vscode.commands.registerCommand('alchemist.toggleProjectContext', () =>
      scratchManager.toggleProjectContext()
    ),
    vscode.commands.registerCommand('alchemist.deleteScratchFile', () =>
      scratchManager.deleteScratchFile()
    ),
    vscode.commands.registerCommand('alchemist.saveScratchAs', () =>
      scratchManager.saveScratchAs()
    ),
    vscode.commands.registerCommand('alchemist.runNow', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'al') {
        vscode.window.showWarningMessage('Open an AL file to run ALchemist.');
        return;
      }

      if (!runnerManager.getPath()) {
        try {
          await runnerManager.ensureInstalled();
        } catch {
          return;
        }
      }

      const filePath = editor.document.uri.fsPath;
      const wsPath = workspaceFolder?.uri.fsPath;

      if (isScratchFile(filePath)) {
        const content = editor.document.getText();
        if (isProjectAware(content) && wsPath) {
          await executor.execute('scratch-project', filePath, wsPath);
        } else {
          await executor.execute('scratch-standalone', filePath);
        }
      } else if (wsPath) {
        await executor.execute('test', filePath, wsPath);
      }
    }),
    vscode.commands.registerCommand('alchemist.stopRun', () => {
      executor.cancel();
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.clearDecorations', () => {
      decorationManager.clearAll();
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.showOutput', () => {
      outputChannel.show();
    })
  );

  // --- Hover provider ---

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('al', new CoverageHoverProvider(decorationManager))
  );

  // Push all disposables
  context.subscriptions.push(
    executor,
    decorationManager,
    outputChannel,
    statusBar,
    testController
  );
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}
