import * as vscode from 'vscode';
import { ExecutionResult } from '../runner/outputParser';

export type RunMode = 'test' | 'scratch-standalone' | 'scratch-project';

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private tierItem: vscode.StatusBarItem;
  private currentProtocolVersion: number | undefined;
  /**
   * The non-protocol portion of the tooltip — what each setter (setIdle,
   * setRunning, setTestResult, setScratchResult) wants the tooltip to say
   * about the run state. The protocol-version line is appended on top of
   * this by `refreshTooltip` and is the ONLY place that touches
   * `this.item.tooltip` directly.
   *
   * Keeping the base separate eliminates the previous fragile
   * `tooltip.includes('protocol')` heuristic — every tooltip mutation now
   * routes through `setBaseTooltip`, which calls `refreshTooltip`, which
   * deterministically composes `${baseTooltip}\n${protocolLine}`.
   */
  private baseTooltip: string = 'ALchemist';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'alchemist.showOutput';
    this.setIdle();
    this.item.show();

    this.tierItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.tierItem.show();
    this.setTier('regex');
  }

  setIdle(): void {
    this.item.text = '$(beaker) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.setBaseTooltip('ALchemist \u2014 Ready');
  }

  setRunning(mode: RunMode): void {
    this.item.text = '$(loading~spin) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    const modeLabel = mode === 'test' ? 'tests' : 'scratch file';
    this.setBaseTooltip(`ALchemist \u2014 Running ${modeLabel}...`);
  }

  setResult(result: ExecutionResult): void {
    if (result.mode === 'test') {
      this.setTestResult(result);
    } else {
      this.setScratchResult(result);
    }
  }

  private setTestResult(result: ExecutionResult): void {
    const passed = result.summary?.passed ?? result.tests.filter((t) => t.status === 'passed').length;
    const total = result.summary?.total ?? result.tests.length;
    const hasFailures = result.tests.some((t) => t.status !== 'passed');

    if (hasFailures) {
      this.item.text = `$(error) ALchemist: ${passed}/${total} passed`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `$(check) ALchemist: ${passed}/${total} passed`;
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;

    const coverageTotal = result.coverage.reduce((s, e) => s + e.lines.length, 0);
    const coverageCovered = result.coverage.reduce((s, e) => s + e.lines.filter((l) => l.hits > 0).length, 0);
    const pct = coverageTotal > 0 ? ((coverageCovered / coverageTotal) * 100).toFixed(1) : '\u2014';
    this.setBaseTooltip(`ALchemist \u2014 ${result.durationMs}ms\nCoverage: ${pct}%`);
  }

  private setScratchResult(result: ExecutionResult): void {
    if (result.exitCode !== 0) {
      this.item.text = '$(warning) ALchemist: Error';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = '$(check) ALchemist';
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;
    this.setBaseTooltip(`ALchemist \u2014 Scratch (${result.durationMs}ms)`);
  }

  setTier(tier: 'regex' | 'precision' | 'fallback', scopeText?: string, tooltip?: string): void {
    if (tier === 'regex') {
      this.tierItem.text = '$(symbol-misc) regex';
      this.tierItem.tooltip = scopeText ? `ALchemist: ${scopeText}` : 'ALchemist: tree-sitter unavailable, using regex discovery';
    } else if (tier === 'precision') {
      this.tierItem.text = `$(check) ${scopeText ?? 'precision'}`;
      this.tierItem.tooltip = tooltip ?? 'ALchemist: precision tier — tests narrowed via tree-sitter symbol index';
    } else {
      this.tierItem.text = scopeText ? `$(circle-slash) ${scopeText}` : '$(circle-slash) fallback';
      this.tierItem.tooltip = `ALchemist: fallback tier${tooltip ? ' — ' + tooltip : ''}`;
    }
  }

  /**
   * Update the status bar tooltip to reflect the detected AL.Runner
   * protocol version. v2 → "AL.Runner protocol v2"; v1 (or undefined) →
   * "AL.Runner protocol v1 (upgrade for live updates)".
   *
   * The protocol line is composed on top of the current `baseTooltip`,
   * which is preserved verbatim — no string-search heuristic.
   */
  setProtocolVersion(version: number | undefined): void {
    this.currentProtocolVersion = version;
    this.refreshTooltip();
  }

  /**
   * Set the run-state portion of the tooltip and immediately recompose
   * the full tooltip (base + protocol line). Every state-changing setter
   * — `setIdle`, `setRunning`, `setTestResult`, `setScratchResult` —
   * routes through here so the protocol line is never lost.
   */
  private setBaseTooltip(text: string): void {
    this.baseTooltip = text;
    this.refreshTooltip();
  }

  private refreshTooltip(): void {
    const protocolLine = this.getProtocolTooltip();
    this.item.tooltip = `${this.baseTooltip}\n${protocolLine}`;
  }

  private getProtocolTooltip(): string {
    if (this.currentProtocolVersion !== undefined && this.currentProtocolVersion >= 2) {
      return `AL.Runner protocol v${this.currentProtocolVersion}`;
    }
    return 'AL.Runner protocol v1 (upgrade for live updates)';
  }

  // --- Iteration stepper ---

  private prevItem?: vscode.StatusBarItem;
  private counterItem?: vscode.StatusBarItem;
  private nextItem?: vscode.StatusBarItem;
  private tableItem?: vscode.StatusBarItem;

  showIterationStepper(current: number, total: number): void {
    if (!this.prevItem) {
      this.prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
      this.prevItem.command = 'alchemist.iterationPrev';
      this.prevItem.tooltip = 'Previous iteration (Ctrl+Shift+A Left)';

      this.counterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
      this.counterItem.command = 'alchemist.iterationShowAll';
      this.counterItem.tooltip = 'Show all iterations (Ctrl+Shift+A A)';

      this.nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
      this.nextItem.command = 'alchemist.iterationNext';
      this.nextItem.tooltip = 'Next iteration (Ctrl+Shift+A Right)';

      this.tableItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
      this.tableItem.command = 'alchemist.iterationTable';
      this.tableItem.tooltip = 'Open iteration table (Ctrl+Shift+A T)';
    }

    this.prevItem.text = '$(chevron-left)';
    this.counterItem!.text = current === 0 ? 'All' : `${current}/${total}`;
    this.nextItem!.text = '$(chevron-right)';
    this.tableItem!.text = 'Table';

    this.prevItem.show();
    this.counterItem!.show();
    this.nextItem!.show();
    this.tableItem!.show();
  }

  hideIterationStepper(): void {
    this.prevItem?.hide();
    this.counterItem?.hide();
    this.nextItem?.hide();
    this.tableItem?.hide();
  }

  dispose(): void {
    this.item.dispose();
    this.tierItem.dispose();
    this.prevItem?.dispose();
    this.counterItem?.dispose();
    this.nextItem?.dispose();
    this.tableItem?.dispose();
  }
}
