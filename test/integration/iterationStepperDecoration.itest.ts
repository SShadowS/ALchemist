import * as assert from 'assert';
import * as path from 'path';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationStepperDecoration } from '../../src/iteration/iterationCodeLensProvider';
import { IterationData } from '../../src/iteration/types';

/**
 * End-to-end coverage for IterationStepperDecoration through real VS Code
 * APIs. Plan E4 Task C2.
 *
 * Validates that the stepper indicator (`⟳ All`) paints on the matched
 * editor when `refresh()` is invoked, even though the decoration class
 * was constructed with the real vscode.window event subscriptions.
 *
 * Fixture: parity-loop-fixture/CU1.al — same as iterationStepping.itest.ts.
 * Line 8 (`for i := 1 to 5 do`) is within the 12-line document so
 * `lineAt(7)` succeeds; the stepper only requires a valid line, not `:=`.
 *
 * Cited APIs (validate against https://code.visualstudio.com/api):
 * - vscode.workspace.openTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
 * - vscode.window.showTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
 * - vscode.window.visibleTextEditors:
 *   https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
 * - vscode.window.onDidChangeActiveTextEditor:
 *   https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeActiveTextEditor
 * - vscode.workspace.onDidChangeTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument
 * - vscode.window.createTextEditorDecorationType:
 *   https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
 */

const FIX = path.resolve(__dirname, '../../../test/fixtures');
const AL_FILE = path.join(FIX, 'parity-loop-fixture', 'CU1.al');
const WORKSPACE_PATH = path.join(FIX, 'parity-loop-fixture');

// CU1.al line 8: `    for i := 1 to 5 do` — valid line, within 12-line file.
const LOOP_LINE = 8;

suite('Integration — IterationStepperDecoration paints across visible editors', () => {
  test('refresh paints stepper text on a real editor whose document matches a loop sourceFile', async () => {
    const vscode = require('vscode');

    // 1. Open the AL fixture so visibleTextEditors includes it.
    //    https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
    //    https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    await vscode.window.showTextDocument(doc);

    // 2. Build a store with one loop pointing at this file.
    //    iterationCount >= 2 is required — IterationStepperDecoration.applyTo
    //    skips loops with fewer than 2 iterations.
    const loop: IterationData = {
      loopId: 'L0',
      sourceFile: AL_FILE,     // absolute path → path.resolve passes through unchanged
      loopLine: LOOP_LINE,
      loopEndLine: LOOP_LINE,
      parentLoopId: null,
      parentIteration: null,
      iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [], messages: [], linesExecuted: [LOOP_LINE] },
        { iteration: 2, capturedValues: [], messages: [], linesExecuted: [LOOP_LINE] },
        { iteration: 3, capturedValues: [], messages: [], linesExecuted: [LOOP_LINE] },
      ],
    };
    const store = new IterationStore();
    store.load([loop], WORKSPACE_PATH);

    // 3. Build wrapped stand-ins for all currently visible editors so we
    //    can intercept setDecorations calls. The wrapped editor holds the
    //    REAL document so applyTo's lineAt() call succeeds.
    //    TextEditor.setDecorations is a non-writable, non-configurable slot
    //    on the real editor — wrapping via a plain object is the established
    //    pattern (see decorationRender.itest.ts and iterationStepping.itest.ts).
    type Call = { editorPath: string; type: any; ranges: any[] };
    const calls: Call[] = [];
    const origVisible: readonly any[] = vscode.window.visibleTextEditors;
    const wrappedVisible = origVisible.map((e: any) => ({
      document: e.document,
      selection: e.selection,
      visibleRanges: e.visibleRanges,
      options: e.options,
      setDecorations: (type: any, ranges: any[]) => {
        calls.push({ editorPath: e.document.uri.fsPath, type, ranges });
      },
    }));

    // 4. Patch vscode.window.visibleTextEditors so IterationStepperDecoration
    //    .refresh() sees our wrapped stand-ins instead of the real editors.
    //    IterationStepperDecoration reads `vscode.window.visibleTextEditors`
    //    from the same `vscode` module object that the test imports, so
    //    patching here is visible to the class.
    //
    //    Strategy: try Object.defineProperty first (correct, non-destructive).
    //    If the property descriptor is non-configurable at runtime, fall back
    //    to direct assignment ((vscode.window as any).visibleTextEditors = …)
    //    — this matches the workaround used in iterationCodeLens.test.ts after
    //    Plan E3 v0.5.7.
    //
    //    https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
    let patchedViaDefineProperty = false;
    try {
      Object.defineProperty(vscode.window, 'visibleTextEditors', {
        value: wrappedVisible,
        configurable: true,
      });
      patchedViaDefineProperty = true;
    } catch {
      (vscode.window as any).visibleTextEditors = wrappedVisible;
    }

    let stepperDispose: { dispose(): void } | undefined;
    try {
      // 5. Construct the stepper decoration. Subscribes to
      //    onDidChangeActiveTextEditor + onDidChangeTextDocument internally.
      //    https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeActiveTextEditor
      //    https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument
      const stepper = new IterationStepperDecoration(store);
      stepperDispose = stepper;

      // 6. Trigger a manual refresh and assert decoration call landed on
      //    the matched editor with non-empty contentText.
      //    Store is in "show all" mode (currentIteration = 0) by default,
      //    so buildStepperText returns `⟳ All`.
      stepper.refresh();

      const matchingCalls = calls.filter(
        c => c.editorPath.toLowerCase() === AL_FILE.toLowerCase() &&
             c.ranges.length > 0,
      );
      assert.ok(
        matchingCalls.length >= 1,
        `expected at least one stepper decoration on ${AL_FILE} after refresh(); ` +
        `got ${calls.length} total call(s) across ${wrappedVisible.length} visible editor(s). ` +
        `(Object.defineProperty succeeded: ${patchedViaDefineProperty})`,
      );

      // 7. The decoration's contentText must be the stepper indicator.
      //    currentIteration = 0 ("show all" mode) → buildStepperText returns `⟳ All`.
      //    https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
      const stepperContent = matchingCalls[0].ranges[0]?.renderOptions?.after?.contentText;
      assert.ok(
        stepperContent && (stepperContent.includes('⟳') || stepperContent.includes('All')),
        `stepper contentText must include the stepper indicator (⟳ or 'All'); got ${JSON.stringify(stepperContent)}`,
      );
    } finally {
      stepperDispose?.dispose();

      // Restore vscode.window.visibleTextEditors to its original value.
      if (patchedViaDefineProperty) {
        try {
          Object.defineProperty(vscode.window, 'visibleTextEditors', {
            value: origVisible,
            configurable: true,
          });
        } catch {
          (vscode.window as any).visibleTextEditors = origVisible;
        }
      } else {
        (vscode.window as any).visibleTextEditors = origVisible;
      }
    }
  });
});
