import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { LoopInfo } from './types';

const DEFAULT_RENDER_LIMIT = 200;

export class IterationTablePanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private currentLoopId: string | undefined;
  private renderLimit: number = DEFAULT_RENDER_LIMIT;

  constructor(
    private readonly store: IterationStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  show(loopId: string): void {
    this.currentLoopId = loopId;
    this.renderLimit = DEFAULT_RENDER_LIMIT;

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
          this.renderLimit = DEFAULT_RENDER_LIMIT;
          this.updateContent();
        } else if (msg.type === 'showAll') {
          this.renderLimit = Infinity;
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

    const nonce = getNonce();

    if (loop.iterationCount === 0) {
      this.panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body><p>No iteration data available.</p></body></html>`;
      return;
    }

    let firstStep;
    try {
      firstStep = this.store.getStep(this.currentLoopId, 1);
    } catch {
      this.panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body><p>No iteration data available.</p></body></html>`;
      return;
    }
    const varNames = Array.from(firstStep.capturedValues.keys());

    // Determine how many rows to render
    const isTruncated = loop.iterationCount > this.renderLimit;
    const rowCount = isTruncated ? this.renderLimit : loop.iterationCount;

    const rows: string[] = [];
    for (let i = 1; i <= rowCount; i++) {
      const step = this.store.getStep(this.currentLoopId, i);
      const isCurrent = i === loop.currentIteration;

      // Detect changed values
      const changedVars = new Set(this.store.getChangedValues(this.currentLoopId!, i));

      // Build variable cells with overflow handling
      const varCells = varNames.map((name) => {
        const value = step.capturedValues.get(name) || '';
        const escaped = escapeHtml(value);
        const changed = changedVars.has(name) ? ' class="changed"' : '';
        return `<td${changed} title="${escaped}">${escaped}</td>`;
      }).join('');

      const msgCell = step.messages.length > 0
        ? `<td class="message" title="${escapeHtml(step.messages.join(', '))}">${escapeHtml(step.messages.join(', '))}</td>`
        : '<td></td>';

      // Check for nested loops
      const nested = this.store.getNestedLoops(this.currentLoopId, i);
      const nestedCell = nested.length > 0
        ? `<td><a href="#" aria-label="Drill into nested loop with ${nested[0].iterationCount} iterations" onclick="drillDown('${escapeHtml(nested[0].loopId)}'); return false;">\u25B6 ${nested[0].iterationCount} inner iterations</a></td>`
        : '<td></td>';

      const rowClass = isCurrent ? 'current' : '';
      const ariaCurrent = isCurrent ? ' aria-current="true"' : '';

      rows.push(`<tr class="${rowClass}" tabindex="0"${ariaCurrent} data-iteration="${i}" data-loop-id="${escapeHtml(this.currentLoopId)}" onclick="selectRow(${i}, '${escapeHtml(this.currentLoopId)}')">
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
        breadcrumb = `<div class="breadcrumb"><a href="#" aria-label="Navigate back to outer loop at line ${parent.loopLine}" onclick="drillDown('${escapeHtml(loop.parentLoopId)}'); return false;"><span title="Back to outer loop">\u25C0</span> Back to outer loop (line ${parent.loopLine})</a> <span title="Current context">\u203A</span> iteration ${loop.parentIteration}</div>`;
      } catch {
        // Parent not found, skip breadcrumb
      }
    }

    // Pagination footer
    let paginationHtml = '';
    if (isTruncated) {
      paginationHtml = `<div class="pagination">Showing ${this.renderLimit} of ${loop.iterationCount} iterations. <a href="#" onclick="showAll(); return false;">Show all</a></div>`;
    }

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    font-size: 14px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
  }
  .breadcrumb {
    font-size: 11px;
    margin-bottom: 12px;
    padding: 4px 8px;
    background: var(--vscode-badge-background, rgba(255,255,255,0.05));
    border-radius: 3px;
    color: var(--vscode-descriptionForeground);
  }
  .breadcrumb a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  .breadcrumb a:hover { text-decoration: underline; }
  .breadcrumb a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .table-container {
    overflow: auto;
    max-height: calc(100vh - 100px);
    position: relative;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
  }
  table, thead, tbody, tr, th, td {
    /* Reset for grid role */
    box-sizing: border-box;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
  }
  th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 2px solid var(--vscode-widget-border, #444);
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    transition: background 150ms ease;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tr {
    cursor: pointer;
    outline: none;
  }
  tr:hover { background: var(--vscode-list-hoverBackground); }
  tr.current {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  tr.current td { font-weight: 600; }
  tr.focused {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: -2px;
  }
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
    min-width: 40px;
    font-variant-numeric: tabular-nums;
    overflow: visible;
    text-overflow: clip;
    white-space: nowrap;
  }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .pagination {
    margin-top: 12px;
    padding: 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
  }
</style>
</head>
<body>
  <div class="loop-header">for loop \u2014 line ${loop.loopLine}</div>
  ${breadcrumb}
  <div class="table-container">
    <table role="grid" aria-label="Loop iterations">
      <thead><tr><th>#</th>${varHeaders}<th>Message</th><th></th></tr></thead>
      <tbody>${rows.join('\n')}</tbody>
    </table>
  </div>
  ${paginationHtml}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function selectRow(iteration, loopId) {
      vscode.postMessage({ type: 'selectIteration', iteration: iteration, loopId: loopId });
    }

    function drillDown(loopId) {
      vscode.postMessage({ type: 'drillDown', loopId: loopId });
    }

    function showAll() {
      vscode.postMessage({ type: 'showAll' });
    }

    // Keyboard navigation
    let focusedRow = -1;
    const rows = document.querySelectorAll('tbody tr');

    function focusRow(index) {
      if (index < 0 || index >= rows.length) return;
      rows.forEach(function(r) { r.classList.remove('focused'); });
      focusedRow = index;
      rows[index].classList.add('focused');
      rows[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      rows[index].focus();
    }

    document.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusRow(focusedRow + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusRow(focusedRow - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusRow(0);
          break;
        case 'End':
          e.preventDefault();
          focusRow(rows.length - 1);
          break;
        case 'Enter':
          if (focusedRow >= 0) {
            rows[focusedRow].click();
          }
          break;
      }
    });

    // Initialize: focus current iteration row
    var currentRow = document.querySelector('tr.current');
    if (currentRow) {
      var idx = Array.from(rows).indexOf(currentRow);
      if (idx >= 0) focusRow(idx);
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
