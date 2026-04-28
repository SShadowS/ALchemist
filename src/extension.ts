import * as vscode from 'vscode';
import * as path from 'path';
import { AlRunnerManager } from './runner/alRunnerManager';
import { ServerProcess } from './execution/serverProcess';
import { ServerExecutionEngine } from './execution/serverExecutionEngine';
import { ExecutionEngine } from './execution/executionEngine';
import { DecorationManager } from './editor/decorations';
import { CoverageHoverProvider } from './editor/hoverProvider';
import { AlchemistOutputChannel } from './output/outputChannel';
import { StatusBarManager } from './output/statusBar';
import { ScratchManager, isScratchFile, isProjectAware, resolveScratchProjectApp } from './scratch/scratchManager';
import { AlchemistTestController } from './testing/testController';
import { IterationStore } from './iteration/iterationStore';
import { IterationCodeLensProvider, IterationStepperDecoration } from './iteration/iterationCodeLensProvider';
import { registerIterationCommands, findLoopAtCursor } from './iteration/iterationCommands';
import { IterationTablePanel } from './iteration/iterationTablePanel';
import { WorkspaceModel, bindWorkspaceModelToVsCode, FILE_WATCH_DEBOUNCE_MS } from './workspace/workspaceModel';
import { planSaveRuns } from './testing/saveRouting';
import { ParseCache } from './symbols/parseCache';
import { SymbolIndex, bindSymbolIndexToVsCode } from './symbols/symbolIndex';
import { TestRouter } from './routing/testRouter';
import { TreeSitterTestRouter } from './routing/treeSitterTestRouter';

let runnerManager: AlRunnerManager;
let serverProcess: ServerProcess | undefined;
let executionEngine: ExecutionEngine | undefined;
let executionEngineReady: Promise<void> = Promise.resolve();
let decorationManager: DecorationManager;
let outputChannel: AlchemistOutputChannel;
let statusBar: StatusBarManager;
let scratchManager: ScratchManager;
let testController: AlchemistTestController;
let iterationStore: IterationStore;
let iterationTablePanel: IterationTablePanel;
let lastExecutionResult: import('./runner/outputParser').ExecutionResult | undefined;
let workspaceModel: WorkspaceModel;
let modelBinding: { dispose(): void } | undefined;
let treeRefreshTimer: NodeJS.Timeout | undefined;
let modelChangeUnsub: (() => void) | undefined;
let parseCache: ParseCache | undefined;
let symbolIndex: SymbolIndex | undefined;
let testRouter: TestRouter | undefined;
let symbolWatcherBinding: { dispose(): void } | undefined;

/**
 * Await engine readiness then invoke fn. Shows an error and returns undefined
 * when the engine is not available (runner failed to install).
 */
async function withEngine<T>(fn: (engine: ExecutionEngine) => Promise<T>): Promise<T | undefined> {
  await executionEngineReady;
  if (!executionEngine) {
    vscode.window.showErrorMessage('ALchemist: AL.Runner not available');
    return undefined;
  }
  return fn(executionEngine);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('ALchemist: activating...');

  try {
    // Initialize runtime infra first
    runnerManager = new AlRunnerManager();
    decorationManager = new DecorationManager(context.extensionPath);
    outputChannel = new AlchemistOutputChannel();
    statusBar = new StatusBarManager();
    scratchManager = new ScratchManager(context.globalStorageUri.fsPath);
    iterationStore = new IterationStore();
    iterationTablePanel = new IterationTablePanel(iterationStore, context.extensionUri);

    // Build workspace model from all folders, THEN test controller that depends on it
    const folderPaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    workspaceModel = new WorkspaceModel(folderPaths, msg => outputChannel.appendLine(msg));
    await workspaceModel.scan();
    modelBinding = bindWorkspaceModelToVsCode(workspaceModel, vscode);

    // L1-L4: tree-sitter precision stack (async, non-blocking)
    parseCache = new ParseCache(path.join(context.extensionPath, 'dist'));
    void (async () => {
      await parseCache!.initialize();
      if (!parseCache!.isAvailable()) {
        outputChannel.appendLine('ALchemist: tree-sitter WASM unavailable; staying on regex tier');
        return;
      }
      symbolIndex = new SymbolIndex();
      await symbolIndex.initialize(workspaceModel, parseCache!);
      if (symbolIndex.isReady()) {
        testRouter = new TreeSitterTestRouter(symbolIndex);
        symbolWatcherBinding = bindSymbolIndexToVsCode(symbolIndex, vscode);
      }
    })();

    // testController uses a lazy getter so it can be constructed before the engine is ready
    testController = new AlchemistTestController(() => executionEngine, workspaceModel);
  } catch (err: any) {
    console.error('ALchemist: failed to initialize components:', err);
    vscode.window.showErrorMessage(`ALchemist failed to initialize: ${err.message}`);
    return;
  }

  // Ensure AL.Runner is available (non-blocking — don't delay command registration).
  // Chain ServerProcess + engine construction once the runner path is known.
  executionEngineReady = runnerManager.ensureInstalled()
    .then((runnerPath) => {
      serverProcess = new ServerProcess({ runnerPath });
      executionEngine = new ServerExecutionEngine(serverProcess);
    })
    .catch((err) => {
      console.error('ALchemist: failed to ensure AL.Runner:', err);
      // Will show error when user tries to run via withEngine()
    });

  // Check for updates (non-blocking)
  runnerManager.checkForUpdates();

  // Initial populate of Test Explorer
  await testController.refreshTestsFromModel(workspaceModel);

  // Refresh on app.json changes
  modelChangeUnsub = workspaceModel.onDidChange(() => {
    void testController.refreshTestsFromModel(workspaceModel);
  });

  // --- Result handler (shared between on-save and runNow) ---

  function handleResult(result: import('./runner/outputParser').ExecutionResult): void {
    statusBar.setResult(result);

    const activeFile = vscode.window.activeTextEditor?.document.fileName || 'unknown';
    outputChannel.displayResult(result, path.basename(activeFile));

    lastExecutionResult = result;

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const wsPath = workspaceModel.getAppContaining(editor.document.uri.fsPath)?.path ?? path.dirname(editor.document.uri.fsPath);
      decorationManager.applyResults(editor, result, wsPath);
    }

    testController.updateFromResult(result);

    if (result.iterations && result.iterations.length > 0) {
      const editorFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      const wsPath = (editorFile && workspaceModel.getAppContaining(editorFile)?.path) ?? '';
      iterationStore.load(result.iterations, wsPath);
      vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', true);
      const loops = iterationStore.getLoops().filter(l => l.iterationCount >= 2);
      if (loops.length > 0) {
        statusBar.showIterationStepper(0, loops[0].iterationCount);
      }
    } else if (result.exitCode === 0) {
      iterationStore.clear();
      vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      statusBar.hideIterationStepper();
    }
  }

  // --- On-save handler ---

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId !== 'al') return;

      const config = vscode.workspace.getConfiguration('alchemist');
      if (!config.get<boolean>('runOnSave', true)) return;

      const filePath = doc.uri.fsPath;

      if (isScratchFile(filePath)) {
        // Scratch mode
        const content = doc.getText();
        if (isProjectAware(content)) {
          const settingAppId = config.get<string>('scratchProjectAppId', '');
          const persistedAppId = context.globalState.get<string>(`alchemist.scratchApp.${filePath}`);
          const resolution = resolveScratchProjectApp(
            workspaceModel.getApps(),
            settingAppId || undefined,
            persistedAppId,
          );

          if (resolution.mode === 'standalone') {
            statusBar.setRunning('scratch-standalone');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          } else if (resolution.mode === 'app') {
            statusBar.setRunning('scratch-project');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [resolution.app.path, filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          } else {
            // needsPrompt
            const pick = await vscode.window.showQuickPick(
              resolution.choices.map(c => ({ label: c.name, description: c.path, appId: c.id, appPath: c.path })),
              { placeHolder: 'Select AL app context for this scratch file' },
            );
            if (!pick) return;
            await context.globalState.update(`alchemist.scratchApp.${filePath}`, pick.appId);
            statusBar.setRunning('scratch-project');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [pick.appPath, filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          }
        } else {
          statusBar.setRunning('scratch-standalone');
          const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [filePath], captureValues: true, iterationTracking: true }));
          if (result) handleResult(result);
        }
      } else {
        // Multi-app test routing
        const scope = config.get<'current' | 'all' | 'off'>('testRunOnSave', 'current');
        const plan = planSaveRuns(filePath, workspaceModel, scope);
        for (const run of plan) {
          const depPaths = workspaceModel.getDependencies(run.appId).map(a => a.path);
          const sourcePaths = depPaths.length > 0 ? depPaths : [run.appPath];
          statusBar.setRunning('test');
          const result = await withEngine(eng => eng.runTests({ sourcePaths, captureValues: true, iterationTracking: true, coverage: true }));
          if (result) handleResult(result);
        }
      }
    })
  );

  // Debounced tree refresh when any .al file is saved (catches new test procs added)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'al') return;
      if (treeRefreshTimer) clearTimeout(treeRefreshTimer);
      treeRefreshTimer = setTimeout(() => {
        treeRefreshTimer = undefined;
        void testController.refreshTestsFromModel(workspaceModel);
      }, FILE_WATCH_DEBOUNCE_MS);
    }),
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

      const filePath = editor.document.uri.fsPath;

      if (isScratchFile(filePath)) {
        const content = editor.document.getText();
        if (isProjectAware(content)) {
          const runNowConfig = vscode.workspace.getConfiguration('alchemist');
          const settingAppId = runNowConfig.get<string>('scratchProjectAppId', '');
          const persistedAppId = context.globalState.get<string>(`alchemist.scratchApp.${filePath}`);
          const resolution = resolveScratchProjectApp(
            workspaceModel.getApps(),
            settingAppId || undefined,
            persistedAppId,
          );

          if (resolution.mode === 'standalone') {
            statusBar.setRunning('scratch-standalone');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          } else if (resolution.mode === 'app') {
            statusBar.setRunning('scratch-project');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [resolution.app.path, filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          } else {
            // needsPrompt
            const pick = await vscode.window.showQuickPick(
              resolution.choices.map(c => ({ label: c.name, description: c.path, appId: c.id, appPath: c.path })),
              { placeHolder: 'Select AL app context for this scratch file' },
            );
            if (!pick) return;
            await context.globalState.update(`alchemist.scratchApp.${filePath}`, pick.appId);
            statusBar.setRunning('scratch-project');
            const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [pick.appPath, filePath], captureValues: true, iterationTracking: true }));
            if (result) handleResult(result);
          }
        } else {
          statusBar.setRunning('scratch-standalone');
          const result = await withEngine(eng => eng.executeScratch({ sourcePaths: [filePath], captureValues: true, iterationTracking: true }));
          if (result) handleResult(result);
        }
      } else {
        const owningApp = workspaceModel.getAppContaining(filePath);
        if (owningApp) {
          const depPaths = workspaceModel.getDependencies(owningApp.id).map(a => a.path);
          const sourcePaths = depPaths.length > 0 ? depPaths : [owningApp.path];
          statusBar.setRunning('test');
          const result = await withEngine(eng => eng.runTests({ sourcePaths, captureValues: true, iterationTracking: true, coverage: true }));
          if (result) handleResult(result);
        }
      }
    }),
    vscode.commands.registerCommand('alchemist.stopRun', async () => {
      await executionEngine?.dispose();
      // Rebuild engine after stop so future runs work
      if (serverProcess) {
        serverProcess = new ServerProcess({ runnerPath: runnerManager.getPath()! });
        executionEngine = new ServerExecutionEngine(serverProcess);
      }
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.clearDecorations', () => {
      decorationManager.clearAll();
      iterationStore.clear();
      vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      statusBar.hideIterationStepper();
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
        if (lastExecutionResult) {
          const wsPath = workspaceModel.getAppContaining(editor.document.uri.fsPath)?.path ?? path.dirname(editor.document.uri.fsPath);
          decorationManager.applyResults(editor, lastExecutionResult, wsPath);
        }
        const allLoop = iterationStore.getLoop(loopId);
        statusBar.showIterationStepper(0, allLoop.iterationCount);
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
      statusBar.showIterationStepper(loop.currentIteration, loop.iterationCount);
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
    decorationManager,
    outputChannel,
    statusBar,
    testController,
    iterationTablePanel
  );
}

export async function deactivate(): Promise<void> {
  modelBinding?.dispose();
  symbolWatcherBinding?.dispose();
  if (treeRefreshTimer) {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = undefined;
  }
  modelChangeUnsub?.();
  testRouter?.dispose();
  symbolIndex?.dispose();
  parseCache?.dispose();
  await executionEngine?.dispose();
}
