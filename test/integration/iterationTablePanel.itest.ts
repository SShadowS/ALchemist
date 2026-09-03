import * as assert from 'assert';
import * as path from 'path';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationTablePanel } from '../../src/iteration/iterationTablePanel';
import { IterationData } from '../../src/iteration/types';

/**
 * Consumer coverage for the Iteration Table webview against the UPSTREAM-shaped
 * iteration data (loop id "0", integer-derived, 1-based iteration indices,
 * WhenWritingNull-omitted fields). Drives the real panel and inspects the HTML
 * it hands the webview — the seam that regressed with no test guarding it.
 */
const APP_ROOT = path.resolve(__dirname, '../../../');

function upstreamLoop(): IterationData {
  return {
    loopId: '0',
    sourceFile: 'Loop.al',
    loopLine: 9,
    loopEndLine: 12,
    parentLoopId: null,
    parentIteration: null,
    iterationCount: 3,
    unsegmentable: null,
    closedBy: 'exit',
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'total', value: '1' }], messages: ['sum=1'], linesExecuted: [10, 11], statementsExecuted: [2, 3] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'total', value: '3' }], messages: ['sum=3'], linesExecuted: [10, 11], statementsExecuted: [2, 3] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'total', value: '6' }], messages: ['sum=6'], linesExecuted: [10, 11], statementsExecuted: [2, 3] },
    ],
  } as IterationData;
}

function htmlOf(panel: IterationTablePanel): string {
  const wv = (panel as any).panel;
  return wv ? wv.webview.html : '';
}

suite('Integration — Iteration Table panel renders upstream data', () => {
  const vscode = require('vscode');

  test('renders a column per variable and a row per iteration', () => {
    const store = new IterationStore();
    store.load([upstreamLoop()], APP_ROOT);
    const panel = new IterationTablePanel(store, vscode.Uri.file(APP_ROOT));
    try {
      panel.show('0');
      const html = htmlOf(panel);
      assert.ok(html.length > 0, 'panel must set webview html');
      assert.ok(!/No iteration data available/.test(html), 'must not fall back to the empty state');
      // Column headers for both captured variables.
      assert.ok(/<th>i<\/th>/.test(html), 'expected an "i" column header');
      assert.ok(/<th>total<\/th>/.test(html), 'expected a "total" column header');
      // One row per iteration.
      const rows = (html.match(/data-iteration="\d+"/g) || []).length;
      assert.strictEqual(rows, 3, 'expected 3 iteration rows');
      // Values and messages present.
      assert.ok(html.includes('sum=6'), 'last message should appear');
      assert.ok(/>6</.test(html), 'total=6 should appear in a cell');
    } finally {
      panel.dispose();
    }
  });

  test('after stepping, the selected iteration is marked current', () => {
    const store = new IterationStore();
    store.load([upstreamLoop()], APP_ROOT);
    const panel = new IterationTablePanel(store, vscode.Uri.file(APP_ROOT));
    try {
      panel.show('0');
      store.setIteration('0', 2); // fires onDidChange -> panel re-renders
      const html = htmlOf(panel);
      const currentRow = html.match(/<tr class="current"[^>]*data-iteration="(\d+)"/);
      assert.ok(currentRow, 'a current row should be marked after stepping');
      assert.strictEqual(currentRow![1], '2', 'iteration 2 should be the current row');
    } finally {
      panel.dispose();
    }
  });

  // Regression: after a VS Code restart the table tab is restored, but the
  // content lives in the ephemeral store. Without a serializer + restore() the
  // tab came back a dead blank webview (the reported bug).
  test('a restored panel shows a placeholder (not blank) and auto-populates on the next run', () => {
    const store = new IterationStore();
    const panel = new IterationTablePanel(store, vscode.Uri.file(APP_ROOT));
    const restored = vscode.window.createWebviewPanel(
      'alchemistIterationTable', 'ALchemist: Iteration Table', vscode.ViewColumn.Beside, { enableScripts: true },
    );
    try {
      panel.restore(restored); // store empty at restore time
      let html = htmlOf(panel);
      assert.ok(html.length > 0, 'restored panel must not be a blank webview');
      assert.ok(/Run a loop to populate/.test(html), 'restored empty panel shows a placeholder');

      // A run loads the store -> onDidChange -> panel adopts loop 0 and repopulates.
      store.load([upstreamLoop()], APP_ROOT);
      html = htmlOf(panel);
      assert.ok(/<th>i<\/th>/.test(html), 'restored panel repopulates after a run');
      assert.strictEqual((html.match(/data-iteration="\d+"/g) || []).length, 3);
    } finally {
      panel.dispose();
    }
  });

  test('opening the table with an empty store shows a placeholder, not a silent blank', () => {
    const store = new IterationStore();
    const panel = new IterationTablePanel(store, vscode.Uri.file(APP_ROOT));
    try {
      // No loop to select; show() falls back to no id and must still render.
      panel.show(undefined as unknown as string);
      const html = htmlOf(panel);
      assert.ok(html.length > 0 && /Run a loop to populate/.test(html), 'placeholder rendered');
    } finally {
      panel.dispose();
    }
  });
});
