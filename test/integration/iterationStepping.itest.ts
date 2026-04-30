import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { IterationStore } from '../../src/iteration/iterationStore';
import { findEditorsForLoopSourceFile } from '../../src/iteration/iterationViewSync';
import { IterationData } from '../../src/iteration/types';

/**
 * End-to-end iteration-stepping coverage through real VS Code APIs.
 *
 * Plan E4 Task C1.
 *
 * Drives the same code path the user hits when stepping iterations:
 *   IterationStore.setIteration → onDidChange listener → onIterationChanged →
 *   findEditorsForLoopSourceFile + DecorationManager.applyIterationView →
 *   editor.setDecorations.
 *
 * We don't fire the actual command (alchemist.iterationNext) because the
 * extension's iteration-changed listener is wired in `activate(context)`
 * and we don't activate the full extension here (this test is integration
 * not smoke). Instead, we drive the same applyIterationView call directly
 * with the loop+step the store would resolve, against a real opened editor,
 * and assert the decoration outcomes.
 *
 * Fixture: parity-loop-fixture/CU1.al — chosen because it contains
 * a `:=` assignment (`for i := 1 to 5 do` on line 8) which is what
 * applyIterationView's assignRegex (`/\b(\w+)\s*:=/`) targets.
 * SomeTest.Codeunit.al only has `if`-statements without `:=` so would
 * produce zero captured-value decorations regardless of step content.
 *
 * Cited APIs (validate against https://code.visualstudio.com/api):
 * - vscode.workspace.openTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
 * - vscode.window.showTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
 * - vscode.window.visibleTextEditors (read-only):
 *   https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
 * - vscode.window.createTextEditorDecorationType (called inside
 *   DecorationManager constructor):
 *   https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
 * - TextEditor.setDecorations (the slot we proxy via wrapEditor below):
 *   https://code.visualstudio.com/api/references/vscode-api#TextEditor.setDecorations
 * - DecorationOptions.renderOptions.after.contentText (the inline-text
 *   slot we assert on):
 *   https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
 */

// CU1.al is used because line 8 (`for i := 1 to 5 do`) contains a `:=`
// assignment operator that applyIterationView's assignRegex matches.
// SomeTest.Codeunit.al (line 14: `if Sut.Compute(3) <> 6 then Error(...)`)
// has no `:=` so would produce zero captured-value decorations.
const FIX = path.resolve(__dirname, '../../../test/fixtures');
const AL_FILE = path.join(FIX, 'parity-loop-fixture', 'CU1.al');
// workspacePath for store.load — absolute sourceFile paths pass through
// path.resolve unchanged, so any directory works as the workspace arg.
const WORKSPACE_PATH = path.join(FIX, 'parity-loop-fixture');
const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

// CU1.al line 8: `    for i := 1 to 5 do`
// 1-based line 8 → applyIterationView searches 0-based index 7.
// Variable captured: `i` (matched by the for-loop's `:=` assignment).
const LOOP_LINE = 8;

suite('Integration — iteration stepping updates inline values via real VS Code APIs', () => {
  test('applyIterationView paints per-iteration captured values on the matched line', async () => {
    // 1. Open a real AL fixture file.
    //    https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
    //    https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
    const vscode = require('vscode');
    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    // 2. Wrap the real editor so we can record setDecorations calls.
    //    TextEditor.setDecorations is a non-writable, non-configurable slot
    //    — see decorationRender.itest.ts for the established pattern.
    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    // 3. Build a DecorationManager backed by real
    //    vscode.window.createTextEditorDecorationType calls.
    //    https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
    const dm = new DecorationManager(EXTENSION_ROOT);
    const captureType = (dm as unknown as { capturedValueDecorationType: unknown })
      .capturedValueDecorationType;
    assert.ok(captureType, 'DecorationManager must expose capturedValueDecorationType');

    // 4. Construct an IterationStore loaded with realistic per-iteration data.
    //    Variable `i` corresponds to the loop counter in CU1.al (`for i := 1 to 5 do`).
    //    applyIterationView finds `:=` on line 8, extracts varName `i`, then
    //    looks up `step.capturedValues.get('i')` to produce the inline text.
    const loop: IterationData = {
      loopId: 'L0',
      sourceFile: AL_FILE,           // absolute path — passes through path.resolve unchanged
      loopLine: LOOP_LINE,
      loopEndLine: LOOP_LINE,
      parentLoopId: null,
      parentIteration: null,
      iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [LOOP_LINE] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [LOOP_LINE] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [LOOP_LINE] },
      ],
    };
    const store = new IterationStore();
    store.load([loop], WORKSPACE_PATH);

    // 5. Verify findEditorsForLoopSourceFile picks up our editor.
    //    https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
    const matched = findEditorsForLoopSourceFile(
      vscode.window.visibleTextEditors,
      loop.sourceFile,
    );
    assert.ok(
      matched.length >= 1,
      `findEditorsForLoopSourceFile must include the editor whose document is ${AL_FILE}; ` +
      `got ${matched.length} match(es). visibleTextEditors paths: ` +
      `${vscode.window.visibleTextEditors.map((e: any) => e.document.uri.fsPath).join(', ')}`,
    );

    // 6. Step to iteration 2 and apply the per-iteration view through the
    //    same code path the user hits (same as src/extension.ts:onIterationChanged).
    store.setIteration(loop.loopId, 2);
    const step = store.getStep(loop.loopId, 2);
    const changedVars = store.getChangedValues(loop.loopId, 2);
    dm.applyIterationView(editor as any, step, changedVars, /*flashMs*/ 0, {
      start: loop.loopLine,
      end: loop.loopEndLine,
    });

    // 7. Assert the captured-value decoration was painted on the assignment line.
    //    applyIterationView calls setDecorations(capturedValueDecorationType, [...])
    //    for each line in [loopLine-1..loopEndLine-1] whose text matches
    //    /\b(\w+)\s*:=/ and whose varName exists in step.capturedValues.
    //    CU1.al line 8 text: `    for i := 1 to 5 do`  →  matches `i :=`  →
    //    capturedValues.get('i') = '2'  →  decoration produced.
    const captureCalls = calls.filter(c => c.type === captureType);
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected applyIterationView to paint a captured-value decoration; ` +
      `got ${captureCalls.length} call(s), all empty. ` +
      `Inline values would be blank in the editor (the user-reported Plan E4 symptom). ` +
      `Fixture line ${LOOP_LINE}: "${doc.lineAt(LOOP_LINE - 1).text}"`,
    );

    // 8. Decoration must be on the loop line and contain the iteration-2 value.
    //    https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
    const decoration = nonEmpty[0].ranges[0];
    const startLine = decoration.range?.start?.line ?? decoration.start?.line;
    assert.strictEqual(
      startLine,
      LOOP_LINE - 1, // 1-based LOOP_LINE → 0-based index
      `decoration must land on line ${LOOP_LINE} (0-based ${LOOP_LINE - 1}); got line ${startLine}`,
    );
    const contentText: string | undefined = decoration.renderOptions?.after?.contentText;
    assert.ok(
      contentText && contentText.includes('i') && contentText.includes('2'),
      `inline contentText must include the iteration-2 value 'i = 2'; got ${JSON.stringify(contentText)}`,
    );

    dm.dispose();
  });
});

/**
 * Build a stand-in editor that holds the real document but records
 * setDecorations calls. Cannot proxy the real editor because
 * TextEditor.setDecorations is a non-writable, non-configurable slot
 * (verified at runtime in commit 5b4e9d2). The stand-in still exercises
 * real Document.lineAt + real path resolution; only the painting
 * side-effect is stubbed.
 *
 * https://code.visualstudio.com/api/references/vscode-api#TextEditor
 */
function wrapEditor(real: any, calls: { type: any; ranges: any[] }[]): any {
  return {
    document: real.document,
    selection: real.selection,
    visibleRanges: real.visibleRanges,
    options: real.options,
    setDecorations: (type: any, ranges: any[]) => {
      calls.push({ type, ranges });
    },
  };
}
