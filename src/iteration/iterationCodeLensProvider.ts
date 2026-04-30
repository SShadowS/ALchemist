import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { pathsEqual } from './iterationViewSync';

/**
 * Builds stepper display text for a loop.
 * Exported for unit testing.
 */
export function buildStepperText(store: IterationStore, loopId: string): string {
  const loop = store.getLoop(loopId);
  if (store.isShowingAll(loopId)) {
    return '\u27F3 All';
  }
  return `\u27F3 ${loop.currentIteration}/${loop.iterationCount}`;
}

/**
 * Builds CodeLens items from the current IterationStore state.
 * Exported separately for unit testing.
 */
export function buildCodeLenses(store: IterationStore, documentPath: string): vscode.CodeLens[] {
  const loops = store.getLoops();
  const lenses: vscode.CodeLens[] = [];

  for (const loop of loops) {
    if (loop.iterationCount < 2) continue;
    if (!pathsEqual(loop.sourceFile, documentPath)) continue;

    const line = loop.loopLine - 1; // Convert 1-based to 0-based
    const range = new vscode.Range(line, 0, line, 0);

    if (store.isShowingAll(loop.loopId)) {
      lenses.push(new vscode.CodeLens(range, {
        title: '\u25C0',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '\u27E8 All \u27E9',
        command: 'alchemist.iterationShowAll',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '\u25B6',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    } else {
      lenses.push(new vscode.CodeLens(range, {
        title: '\u25C0',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: `\u27E8 ${loop.currentIteration} of ${loop.iterationCount} \u27E9`,
        command: 'alchemist.iterationFirst',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '\u25B6',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    }

    if (!store.isShowingAll(loop.loopId)) {
      lenses.push(new vscode.CodeLens(range, {
        title: 'Show All',
        command: 'alchemist.iterationShowAll',
        arguments: [loop.loopId],
      }));
    }

    lenses.push(new vscode.CodeLens(range, {
      title: 'Table',
      command: 'alchemist.iterationTable',
      arguments: [loop.loopId],
    }));
  }

  return lenses;
}

/**
 * CodeLens provider for iteration steppers — works in project files
 * where VS Code fully activates language features.
 */
export class IterationCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;
  private readonly storeSubscription: { dispose(): void };

  constructor(private readonly store: IterationStore) {
    this.storeSubscription = store.onDidChange(() => this.onDidChangeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return buildCodeLenses(this.store, document.uri.fsPath);
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * Decoration-based iteration stepper — renders inline after the loop line.
 * Works on all files (project and scratch) since CodeLens only renders
 * on files with TestItems registered in VS Code's test controller.
 */
export class IterationStepperDecoration {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly storeSubscription: { dispose(): void };
  private readonly editorSubscription: vscode.Disposable;
  private readonly documentSubscription: vscode.Disposable;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: IterationStore) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });

    this.storeSubscription = store.onDidChange(() => this.refresh());
    this.editorSubscription = vscode.window.onDidChangeActiveTextEditor(() => this.refresh());
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      // Refresh when ANY visible editor's document changes, debounced.
      // The previous filter on `activeTextEditor?.document` missed updates
      // from edits in split panes and from webview-driven flows where
      // activeTextEditor is undefined.
      if (vscode.window.visibleTextEditors.some(ed => ed.document === e.document)) {
        this.debouncedRefresh();
      }
    });
  }

  private debouncedRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 100);
  }

  /**
   * Refresh the stepper indicator on every visible editor.
   *
   * Previously this only painted the active editor; the stepper
   * decoration silently disappeared when the user steered iterations
   * via the Iteration Table webview (activeTextEditor is undefined or
   * unrelated). Iterating visibleTextEditors makes the indicator
   * resilient to the dispatching surface.
   */
  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyTo(editor);
    }
  }

  applyTo(editor: vscode.TextEditor): void {
    const loops = this.store.getLoops();
    const decorations: vscode.DecorationOptions[] = [];
    const editorPath = editor.document.uri.fsPath;

    for (const loop of loops) {
      if (loop.iterationCount < 2) continue;
      if (!pathsEqual(loop.sourceFile, editorPath)) continue;

      const line = loop.loopLine - 1;
      if (line < 0 || line >= editor.document.lineCount) continue;

      const text = buildStepperText(this.store, loop.loopId);
      const range = editor.document.lineAt(line).range;
      decorations.push({
        range,
        renderOptions: {
          after: { contentText: `  ${text}` },
        },
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.storeSubscription.dispose();
    this.editorSubscription.dispose();
    this.documentSubscription.dispose();
    this.decorationType.dispose();
  }
}
