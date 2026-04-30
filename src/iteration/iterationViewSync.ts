import * as path from 'path';

/**
 * Match an editor's document path against a loop's source file path.
 *
 * Both sides are normalized to absolute, native-slash, lowercase before
 * comparison. Tolerates the cross-platform shapes the wire format and
 * editor.fsPath produce (forward vs backslash, drive-letter case
 * differences on Windows).
 */
export function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * Find visible editors whose document corresponds to a loop's source file.
 *
 * The iteration-stepping flow needs to paint per-step decorations into
 * every editor showing the loop's file — including when the user
 * triggered the step via a webview (Iteration Table panel) and
 * `vscode.window.activeTextEditor` is undefined or points at an
 * unrelated text editor. Filtering visibleTextEditors by sourceFile is
 * the correct selector regardless of which UI surface dispatched the
 * step.
 *
 * Pure function over the editor list so it can be unit-tested without a
 * live VS Code host.
 */
export function findEditorsForLoopSourceFile<E extends { document: { uri: { fsPath: string } } }>(
  editors: readonly E[],
  loopSourceFile: string,
): E[] {
  return editors.filter((e) => pathsEqual(e.document.uri.fsPath, loopSourceFile));
}
