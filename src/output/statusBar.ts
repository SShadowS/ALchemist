import * as vscode from 'vscode';
import { ExecutionResult } from '../runner/outputParser';
import { ExecutionMode } from '../runner/executor';

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'alchemist.showOutput';
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.item.text = '$(beaker) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'ALchemist \u2014 Ready';
  }

  setRunning(mode: ExecutionMode): void {
    this.item.text = '$(loading~spin) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    const modeLabel = mode === 'test' ? 'tests' : 'scratch file';
    this.item.tooltip = `ALchemist \u2014 Running ${modeLabel}...`;
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
    this.item.tooltip = `ALchemist \u2014 ${result.durationMs}ms\nCoverage: ${pct}%`;
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
    this.item.tooltip = `ALchemist \u2014 Scratch (${result.durationMs}ms)`;
  }

  // --- Iteration stepper ---

  private prevItem?: vscode.StatusBarItem;
  private counterItem?: vscode.StatusBarItem;
  private nextItem?: vscode.StatusBarItem;
  private tableItem?: vscode.StatusBarItem;

  showIterationStepper(loopId: string, current: number, total: number): void {
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
    this.prevItem?.dispose();
    this.counterItem?.dispose();
    this.nextItem?.dispose();
    this.tableItem?.dispose();
  }
}
