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

  dispose(): void {
    this.item.dispose();
  }
}
