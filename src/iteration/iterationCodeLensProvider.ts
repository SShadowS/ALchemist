import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';

/**
 * Builds CodeLens items from the current IterationStore state.
 * Exported separately for unit testing (no VS Code dependency in the logic).
 */
export function buildCodeLenses(store: IterationStore): vscode.CodeLens[] {
  const loops = store.getLoops();
  const lenses: vscode.CodeLens[] = [];

  for (const loop of loops) {
    if (loop.iterationCount < 2) continue;

    const line = loop.loopLine - 1; // Convert 1-based to 0-based
    const range = new vscode.Range(line, 0, line, 0);

    if (store.isShowingAll(loop.loopId)) {
      // "All" mode — show re-entry point
      lenses.push(new vscode.CodeLens(range, {
        title: '◀',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '⟨ All ⟩',
        command: 'alchemist.iterationShowAll',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '▶',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    } else {
      lenses.push(new vscode.CodeLens(range, {
        title: '◀',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: `⟨ ${loop.currentIteration} of ${loop.iterationCount} ⟩`,
        command: '',
        arguments: [],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '▶',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    }

    lenses.push(new vscode.CodeLens(range, {
      title: 'Show All',
      command: 'alchemist.iterationShowAll',
      arguments: [loop.loopId],
    }));

    lenses.push(new vscode.CodeLens(range, {
      title: 'Table',
      command: 'alchemist.iterationTable',
      arguments: [loop.loopId],
    }));
  }

  return lenses;
}

export class IterationCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor(private readonly store: IterationStore) {
    store.onDidChange(() => this.onDidChangeEmitter.fire());
  }

  provideCodeLenses(): vscode.CodeLens[] {
    return buildCodeLenses(this.store);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
