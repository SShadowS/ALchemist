import * as assert from 'assert';
import * as path from 'path';
import { findEditorsForLoopSourceFile, pathsEqual } from '../../src/iteration/iterationViewSync';

function fakeEditor(fsPath: string): { document: { uri: { fsPath: string } } } {
  return { document: { uri: { fsPath } } };
}

suite('iterationViewSync', () => {
  suite('pathsEqual', () => {
    test('exact match', () => {
      const p = path.resolve('/foo/bar/CU1.al');
      assert.strictEqual(pathsEqual(p, p), true);
    });

    test('case-insensitive on Windows-style paths', () => {
      assert.strictEqual(
        pathsEqual('C:/Users/X/CU1.al', 'c:\\users\\x\\cu1.al'),
        true,
      );
    });

    test('forward vs backward slashes are normalized', () => {
      assert.strictEqual(
        pathsEqual('C:/Users/X/CU1.al', 'C:\\Users\\X\\CU1.al'),
        true,
      );
    });

    test('different files do not match', () => {
      assert.strictEqual(
        pathsEqual('C:/Users/X/A.al', 'C:/Users/X/B.al'),
        false,
      );
    });
  });

  suite('findEditorsForLoopSourceFile', () => {
    test('returns the editor whose document matches the loop sourceFile', () => {
      // Plan E3 v0.5.7 regression: when the user steps via the Iteration
      // Table panel webview, activeTextEditor is undefined or wrong.
      // The iteration-change handler must use the loop's sourceFile to
      // find the right editor among visible editors instead.
      const a = fakeEditor('C:/proj/A.al');
      const b = fakeEditor('C:/proj/B.al');
      const c = fakeEditor('C:/proj/C.al');
      const matches = findEditorsForLoopSourceFile([a, b, c], 'C:/proj/B.al');
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0], b, 'reference identity preserved');
    });

    test('returns the editor when the loop sourceFile uses different slash style than the editor', () => {
      const editor = fakeEditor('C:\\Users\\SShadowS\\Documents\\AL\\ALProject4\\TextCU.al');
      const matches = findEditorsForLoopSourceFile(
        [editor],
        'C:/Users/SShadowS/Documents/AL/ALProject4/TextCU.al',
      );
      assert.strictEqual(matches.length, 1, 'fwd-slash loop path must match backslash editor path');
    });

    test('returns empty when no editor matches', () => {
      const a = fakeEditor('C:/proj/A.al');
      const matches = findEditorsForLoopSourceFile([a], 'C:/proj/X.al');
      assert.deepStrictEqual(matches, []);
    });

    test('returns multiple editors when the same file is open in split panes', () => {
      const left = fakeEditor('C:/proj/A.al');
      const right = fakeEditor('C:/proj/A.al');
      const other = fakeEditor('C:/proj/B.al');
      const matches = findEditorsForLoopSourceFile([left, right, other], 'C:/proj/A.al');
      assert.strictEqual(matches.length, 2);
      assert.ok(matches.includes(left));
      assert.ok(matches.includes(right));
    });

    test('returns empty when editor list is empty', () => {
      assert.deepStrictEqual(
        findEditorsForLoopSourceFile([], 'C:/proj/A.al'),
        [],
      );
    });
  });
});
