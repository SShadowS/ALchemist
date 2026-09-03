import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { IterationStore } from '../../src/iteration/iterationStore';
import { CoverageHoverProvider } from '../../src/editor/hoverProvider';
import { IterationData } from '../../src/iteration/types';

/**
 * Consumer coverage for the iteration-aware hover against UPSTREAM-shaped data
 * (loop id "0"). In per-iteration (stepping) mode the hover must report the
 * value for the CURRENT pass, not the aggregate last value.
 */
const APP_ROOT = path.resolve(__dirname, '../../../');

const SRC = [
  'codeunit 50390 LoopScratch',              // line 1
  '{',                                        // 2
  '    trigger OnRun()',                      // 3
  '    var',                                  // 4
  '        i: Integer;',                      // 5
  '        total: Integer;',                  // 6
  '    begin',                                // 7
  '        total := 0;',                      // 8
  '        for i := 1 to 3 do begin',         // 9  <- loopLine
  '            total += i;',                  // 10
  "            Message(Format(total));",      // 11
  '        end;',                             // 12 <- loopEndLine
  '    end;',                                 // 13
  '}',                                        // 14
].join('\n');

function upstreamStore(sourceFile: string): IterationStore {
  const data: IterationData[] = [{
    loopId: '0', sourceFile, loopLine: 9, loopEndLine: 12,
    parentLoopId: null, parentIteration: null, iterationCount: 3,
    closedBy: 'exit', unsegmentable: null,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'total', value: '1' }], messages: [], linesExecuted: [9, 10, 11] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'total', value: '3' }], messages: [], linesExecuted: [9, 10, 11] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'total', value: '6' }], messages: [], linesExecuted: [9, 10, 11] },
    ],
  } as unknown as IterationData];
  const store = new IterationStore();
  store.load(data, APP_ROOT);
  return store;
}

suite('Integration — iteration hover reflects the current pass (upstream shape)', () => {
  const vscode = require('vscode');

  test('hovering the loop variable while stepping shows the current-pass value', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'al', content: SRC });
    const store = upstreamStore(doc.uri.fsPath);
    store.setIteration('0', 2); // step to pass 2

    const dm = new DecorationManager(APP_ROOT);
    const provider = new CoverageHoverProvider(dm, store);

    // Position on the loop-variable 'i' in the `for i := ...` line (index 8).
    const forLineIdx = 8;
    const text = doc.lineAt(forLineIdx).text;
    const ch = text.indexOf('i', text.indexOf('for'));
    const hover = provider.provideHover(doc, new vscode.Position(forLineIdx, ch));

    assert.ok(hover, 'expected a hover in stepping mode');
    const md = (hover.contents as any[]).map(c => (typeof c === 'string' ? c : c.value)).join('\n');
    assert.ok(md.includes('i = 2'), `hover should show the per-iteration value i = 2; got:\n${md}`);
    assert.ok(/Iteration 2 of 3/.test(md), `header should show the current pass; got:\n${md}`);
  });

  test('hovering a loop line in show-all mode offers the Table navigation link', () => {
    const store = upstreamStore(path.resolve(APP_ROOT, 'Loop.al'));
    // show-all is the default after load; no stepping.
    const dm = new DecorationManager(APP_ROOT);
    const provider = new CoverageHoverProvider(dm, store);
    const vscodeApi = require('vscode');
    // A synthetic document positioned on the loop line (line 9 -> index 8).
    const doc: any = {
      uri: { fsPath: path.resolve(APP_ROOT, 'Loop.al') },
      lineAt: (i: number) => ({ text: '        for i := 1 to 3 do begin', range: {} }),
      getWordRangeAtPosition: () => undefined,
      lineCount: 14,
    };
    const hover = provider.provideHover(doc, new vscodeApi.Position(8, 0));
    assert.ok(hover, 'loop-line hover should render in show-all mode');
    const md = (hover.contents as any[]).map((c: any) => (typeof c === 'string' ? c : c.value)).join('\n');
    assert.ok(/alchemist\.iterationTable/.test(md), 'nav hover links to the iteration table');
  });
});
