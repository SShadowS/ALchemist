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
import { IterationStore } from './iteration/iterationStore';
import { IterationCodeLensProvider, IterationStepperDecoration } from './iteration/iterationCodeLensProvider';
import { registerIterationCommands, findLoopAtCursor } from './iteration/iterationCommands';
import { IterationTablePanel } from './iteration/iterationTablePanel';

let runnerManager: AlRunnerManager;
let executor: Executor;
let decorationManager: DecorationManager;
let outputChannel: AlchemistOutputChannel;
let statusBar: StatusBarManager;
let scratchManager: ScratchManager;
let testController: AlchemistTestController;
let iterationStore: IterationStore;
let iterationTablePanel: IterationTablePanel;
let lastExecutionResult: import('./runner/outputParser').ExecutionResult | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('ALchemist: activating...');

  try {
    // Initialize components
    runnerManager = new AlRunnerManager();
    executor = new Executor(runnerManager);
    decorationManager = new DecorationManager(context.extensionPath);
    outputChannel = new AlchemistOutputChannel();
    statusBar = new StatusBarManager();
    scratchManager = new ScratchManager(context.globalStorageUri.fsPath);
    testController = new AlchemistTestController(executor);
    iterationStore = new IterationStore();
    iterationTablePanel = new IterationTablePanel(iterationStore, context.extensionUri);
  } catch (err: any) {
    console.error('ALchemist: failed to initialize components:', err);
    vscode.window.showErrorMessage(`ALchemist failed to initialize: ${err.message}`);
    return;
  }

  // Ensure AL.Runner is available (non-blocking — don't delay command registration)
  runnerManager.ensureInstalled().catch(() => {
    // Will show error when user tries to run
  });

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

      // Always capture last result regardless of editor state
      lastExecutionResult = result;

      // Apply decorations to active editor
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const wsPath = workspaceFolder?.uri.fsPath || path.dirname(editor.document.uri.fsPath);
        decorationManager.applyResults(editor, result, wsPath);
      }

      // Update Test Explorer
      testController.updateFromResult(result);

      // Load iteration data — only update on successful runs, don't let
      // failed runs (e.g. test controller auto-run with missing deps) clear good data
      if (result.iterations && result.iterations.length > 0) {
        iterationStore.load(result.iterations, workspaceFolder?.uri.fsPath ?? '');
        vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', true);
      } else if (result.exitCode === 0) {
        iterationStore.clear();
        vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      }
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
    vscode.commands.registerCommand('alchemist.newScratchFile', async () => {
      try {
        await scratchManager.newScratchFile(context.extensionPath);
      } catch (err: any) {
        console.error('ALchemist: newScratchFile failed:', err);
        vscode.window.showErrorMessage(`ALchemist: Failed to create scratch file: ${err.message}`);
      }
    }),
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
      iterationStore.clear();
      vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      statusBar.clearIterationIndicator();
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.showOutput', () => {
      outputChannel.show();
    })
  );

  // --- Iteration navigation ---

  const onIterationChanged = (loopId: string) => {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      if (iterationStore.isShowingAll(loopId)) {
        // Re-apply aggregate decorations from the last execution result
        if (lastExecutionResult) {
          const wsPath = workspaceFolder?.uri.fsPath || path.dirname(editor.document.uri.fsPath);
          decorationManager.applyResults(editor, lastExecutionResult, wsPath);
        }
        statusBar.clearIterationIndicator();
        return;
      }

      const loop = iterationStore.getLoop(loopId);
      const step = iterationStore.getStep(loopId, loop.currentIteration);
      const config = vscode.workspace.getConfiguration('alchemist');
      const flashMs = config.get<number>('iterationFlashDuration', 600);
      const changedVars = iterationStore.getChangedValues(loopId, loop.currentIteration);

      decorationManager.applyIterationView(editor, step, changedVars, flashMs, {
        start: loop.loopLine,
        end: loop.loopEndLine,
      });
      statusBar.setIterationIndicator(loopId, loop.currentIteration, loop.iterationCount);
    } catch (err: any) {
      console.error('ALchemist: iteration change error:', err);
    }
  };

  registerIterationCommands(context, iterationStore);

  // Also apply decorations when store changes from other sources (e.g., table panel clicks)
  context.subscriptions.push(
    iterationStore.onDidChange((event) => {
      if (event.kind === 'iteration-changed' || event.kind === 'show-all') {
        onIterationChanged(event.loopId);
      }
    })
  );

  // Iteration table command
  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.iterationTable', (loopId?: string) => {
      if (!loopId) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const cursorLine = editor.selection.active.line + 1;
          loopId = findLoopAtCursor(iterationStore.getLoops(), cursorLine) || undefined;
        }
      }
      const id = loopId || iterationStore.getLoops()[0]?.loopId;
      if (id) iterationTablePanel.show(id);
    })
  );

  // Iteration stepper — CodeLens for project files, decoration for scratch files
  if (vscode.workspace.getConfiguration('alchemist').get<boolean>('showIterationStepper', true)) {
    // CodeLens works in project files (inside workspace folders)
    const codeLensProvider = new IterationCodeLensProvider(iterationStore);
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ language: 'al' }, codeLensProvider),
      codeLensProvider
    );

    // Decoration-based stepper as fallback for scratch files (outside workspace)
    const stepperDecoration = new IterationStepperDecoration(iterationStore);
    context.subscriptions.push(stepperDecoration);
  }

  // --- Hover provider ---

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('al', new CoverageHoverProvider(decorationManager, iterationStore))
  );

  // Push all disposables
  context.subscriptions.push(
    executor,
    decorationManager,
    outputChannel,
    statusBar,
    testController,
    iterationTablePanel
  );
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}
