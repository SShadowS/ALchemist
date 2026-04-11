import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { LoopInfo } from './types';

/**
 * Find the innermost loop containing the cursor, or the nearest loop above.
 * cursorLine is 1-based (matches LoopInfo.loopLine).
 */
export function findLoopAtCursor(loops: LoopInfo[], cursorLine: number): string | null {
  // Find all loops containing the cursor, pick the innermost (smallest range)
  const containing = loops
    .filter((l) => cursorLine >= l.loopLine && cursorLine <= l.loopEndLine)
    .sort((a, b) => (a.loopEndLine - a.loopLine) - (b.loopEndLine - b.loopLine));

  if (containing.length > 0) return containing[0].loopId;

  // No containing loop — find nearest loop above cursor (highest loopEndLine that is still below cursor)
  const above = loops
    .filter((l) => l.loopEndLine < cursorLine)
    .sort((a, b) => b.loopEndLine - a.loopEndLine);

  return above.length > 0 ? above[0].loopId : null;
}

function getTargetLoopId(store: IterationStore, explicitLoopId?: string): string | null {
  if (explicitLoopId) return explicitLoopId;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const cursorLine = editor.selection.active.line + 1; // Convert 0-based to 1-based
  return findLoopAtCursor(store.getLoops(), cursorLine);
}

export function registerIterationCommands(
  context: vscode.ExtensionContext,
  store: IterationStore,
  onIterationChanged: (loopId: string) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.iterationNext', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.nextIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationPrev', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.prevIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationFirst', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.firstIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationLast', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.lastIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationShowAll', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.showAll(id);
      onIterationChanged(id);
    }),
  );
}
