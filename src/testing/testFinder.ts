import * as vscode from 'vscode';

/**
 * Find the TestItem whose range covers the given position in the given document.
 * Only items with id starting `test-` are considered (app/codeunit aggregates
 * are excluded). When multiple test items overlap, the smallest enclosing
 * range wins (most specific).
 *
 * Used by extension.ts to drive `DecorationManager.setActiveTest` from
 * `vscode.window.onDidChangeTextEditorSelection`, so the captures shown
 * in the editor track which `[Test]` proc the cursor is in.
 */
export function findTestItemAtPosition(
  testItemsById: ReadonlyMap<string, vscode.TestItem>,
  documentUri: vscode.Uri,
  position: vscode.Position,
): vscode.TestItem | undefined {
  let best: vscode.TestItem | undefined;
  let bestSize = Number.POSITIVE_INFINITY;

  for (const item of testItemsById.values()) {
    if (!item.id.startsWith('test-')) { continue; }
    if (!item.uri || item.uri.fsPath !== documentUri.fsPath) { continue; }
    if (!item.range) { continue; }

    // Check if position is contained in the range
    const positionAfterStart = position.line > item.range.start.line ||
      (position.line === item.range.start.line && position.character >= item.range.start.character);
    const positionBeforeEnd = position.line < item.range.end.line ||
      (position.line === item.range.end.line && position.character <= item.range.end.character);

    if (!positionAfterStart || !positionBeforeEnd) { continue; }

    const size = (item.range.end.line - item.range.start.line) * 10000
      + (item.range.end.character - item.range.start.character);
    if (size < bestSize) {
      best = item;
      bestSize = size;
    }
  }

  return best;
}
