import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { LoopInfo } from './types';

export class IterationTablePanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private currentLoopId: string | undefined;

  constructor(
    private readonly store: IterationStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  show(loopId: string): void {
    this.currentLoopId = loopId;

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'alchemistIterationTable',
        'ALchemist: Iteration Table',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentLoopId = undefined;
      }, null, this.disposables);

      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'selectIteration') {
          this.store.setIteration(msg.loopId, msg.iteration);
        } else if (msg.type === 'drillDown') {
          this.currentLoopId = msg.loopId;
          this.updateContent();
        }
      }, null, this.disposables);

      this.disposables.push(
        this.store.onDidChange(() => {
          if (this.panel && this.currentLoopId) this.updateContent();
        })
      );
    }

    this.updateContent();
  }

  private updateContent(): void {
    if (!this.panel || !this.currentLoopId) return;

    let loop: LoopInfo;
    try {
      loop = this.store.getLoop(this.currentLoopId);
    } catch {
      return;
    }

    const rows: string[] = [];
    const firstStep = this.store.getStep(this.currentLoopId, 1);
    const varNames = Array.from(firstStep.capturedValues.keys());

    for (let i = 1; i <= loop.iterationCount; i++) {
      const step = this.store.getStep(this.currentLoopId, i);
      const isCurrent = i === loop.currentIteration;
      const isError = i === loop.errorIteration;

      // Detect changed values
      const changedVars = new Set<string>();
      if (i > 1) {
        const prev = this.store.getStep(this.currentLoopId, i - 1);
        for (const [name, value] of step.capturedValues) {
          if (prev.capturedValues.get(name) !== value) {
            changedVars.add(name);
          }
        }
      }

      // Build variable cells
      const varCells = varNames.map((name) => {
        const value = step.capturedValues.get(name) || '';
        const changed = changedVars.has(name) ? ' class="changed"' : '';
        return `<td${changed}>${escapeHtml(value)}</td>`;
      }).join('');

      const msgCell = step.messages.length > 0
        ? `<td class="message">${escapeHtml(step.messages.join(', '))}</td>`
        : '<td></td>';

      // Check for nested loops
      const nested = this.store.getNestedLoops(this.currentLoopId, i);
      const nestedCell = nested.length > 0
        ? `<td><a href="#" onclick="drillDown('${escapeHtml(nested[0].loopId)}'); return false;">\u25B6 ${nested[0].iterationCount} inner iterations</a></td>`
        : '<td></td>';

      const rowClass = [
        isCurrent ? 'current' : '',
        isError ? 'error' : '',
      ].filter(Boolean).join(' ');

      rows.push(`<tr class="${rowClass}" onclick="selectRow(${i}, '${escapeHtml(this.currentLoopId)}')">
        <td class="row-num">${isCurrent ? '\u25BA' : ''}${i}</td>
        ${varCells}
        ${msgCell}
        ${nestedCell}
      </tr>`);
    }

    // Build header
    const varHeaders = varNames
      .map((name) => `<th>${escapeHtml(name)}</th>`)
      .join('');

    // Build breadcrumb for nested loops
    let breadcrumb = '';
    if (loop.parentLoopId) {
      try {
        const parent = this.store.getLoop(loop.parentLoopId);
        breadcrumb = `<div class="breadcrumb"><a href="#" onclick="drillDown('${escapeHtml(loop.parentLoopId)}'); return false;">\u25C0 Back to outer loop (line ${parent.loopLine})</a> \u203A iteration ${loop.parentIteration}</div>`;
      } catch {
        // Parent not found, skip breadcrumb
      }
    }

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    margin: 0;
  }
  .loop-header {
    color: var(--vscode-textLink-foreground);
    font-size: 12px;
    margin-bottom: 8px;
  }
  .breadcrumb {
    font-size: 11px;
    margin-bottom: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .breadcrumb a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  .breadcrumb a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 2px solid var(--vscode-widget-border, #444);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    transition: background 0.15s ease;
  }
  tr { cursor: pointer; }
  tr:hover { background: var(--vscode-list-hoverBackground); }
  tr.current {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  tr.current td { font-weight: 600; }
  tr.error { border-left: 3px solid var(--vscode-errorForeground, #f14c4c); }
  td.changed {
    color: var(--vscode-textLink-foreground);
    font-weight: bold;
  }
  td.message {
    color: var(--vscode-debugTokenExpression-string, #6a9955);
    font-style: italic;
  }
  td.row-num {
    color: var(--vscode-descriptionForeground);
    width: 40px;
    font-variant-numeric: tabular-nums;
  }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="loop-header">for loop \u2014 line ${loop.loopLine}</div>
  ${breadcrumb}
  <table>
    <thead><tr><th>#</th>${varHeaders}<th>Message</th><th></th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>
  <script>
    const vscode = acquireVsCodeApi();
    function selectRow(iteration, loopId) {
      vscode.postMessage({ type: 'selectIteration', iteration: iteration, loopId: loopId });
    }
    function drillDown(loopId) {
      vscode.postMessage({ type: 'drillDown', loopId: loopId });
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
