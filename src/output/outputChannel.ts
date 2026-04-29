import * as vscode from 'vscode';
import { ExecutionResult } from '../runner/outputParser';

export class AlchemistOutputChannel {
  private readonly channel: vscode.OutputChannel;
  private readonly version: string;

  constructor(version: string = 'unknown') {
    this.channel = vscode.window.createOutputChannel('ALchemist');
    this.version = version;
    // Log the running extension version once on construction so it's
    // recoverable from the channel even before any test runs. Saves
    // "is this build picking up my fix?" debugging cycles.
    this.channel.appendLine(`ALchemist v${this.version} loaded`);
  }

  displayResult(result: ExecutionResult, fileName: string): void {
    this.channel.clear();

    const protoLabel = typeof result.protocolVersion === 'number'
      ? ` \u00b7 protocol v${result.protocolVersion}`
      : '';
    const header = `\u2501\u2501\u2501 ALchemist v${this.version}${protoLabel} `;
    const padding = '\u2501'.repeat(Math.max(3, 60 - header.length));
    this.channel.appendLine(header + padding);

    const modeLabel = result.mode === 'scratch' ? 'scratch' : 'test';
    this.channel.appendLine(`  \u25B6 ${fileName} (${modeLabel})`);
    this.channel.appendLine(`  \u23F1 ${result.durationMs}ms`);
    this.channel.appendLine('');

    if (result.mode === 'test') {
      this.displayTestResults(result);
    } else {
      this.displayScratchResults(result);
    }

    // Coverage summary
    if (result.coverage.length > 0) {
      const totalLines = result.coverage.reduce((sum, e) => sum + e.lines.length, 0);
      const coveredLines = result.coverage.reduce(
        (sum, e) => sum + e.lines.filter((l) => l.hits > 0).length, 0
      );
      const pct = totalLines > 0 ? ((coveredLines / totalLines) * 100).toFixed(1) : '0.0';
      this.channel.appendLine(`  Coverage: ${coveredLines}/${totalLines} statements (${pct}%)`);
    }

    const footer = '━'.repeat(60);
    this.channel.appendLine(footer);

    // Auto-focus based on settings
    const config = vscode.workspace.getConfiguration('alchemist');
    const showOnError = config.get<string>('showOutputOnError', 'onlyOnFailure');

    if (showOnError === 'always') {
      this.channel.show(true);
    } else if (showOnError === 'onlyOnFailure') {
      const hasFailures = result.tests.some((t) => t.status !== 'passed')
        || result.stderrOutput.length > 0
        || result.exitCode !== 0;
      if (hasFailures) {
        this.channel.show(true);
      }
    }
  }

  appendLine(message: string): void {
    this.channel.appendLine(message);
  }

  show(): void {
    this.channel.show(true);
  }

  private displayTestResults(result: ExecutionResult): void {
    for (const test of result.tests) {
      if (test.status === 'passed') {
        const duration = test.durationMs !== undefined ? `${test.durationMs}ms` : '';
        this.channel.appendLine(`  \u2713 ${test.name}${duration ? '           ' + duration : ''}`);
      } else if (test.status === 'failed') {
        this.channel.appendLine(`  \u2717 ${test.name}`);
        if (test.message) {
          this.channel.appendLine(`    \u2192 ${test.message}`);
        }
        if (test.stackTrace) {
          for (const line of test.stackTrace.split('\n')) {
            if (line.trim()) {
              this.channel.appendLine(`      ${line.trim()}`);
            }
          }
        }
      } else {
        this.channel.appendLine(`  \u26A0 ${test.name}`);
        if (test.message) {
          this.channel.appendLine(`    \u2192 ${test.message}`);
        }
      }
    }

    if (result.summary) {
      this.channel.appendLine('');
      this.channel.appendLine(`  Results: ${result.summary.passed} passed, ${result.summary.failed} failed`);
    }

    this.channel.appendLine('');
  }

  private displayScratchResults(result: ExecutionResult): void {
    if (result.messages.length > 0) {
      this.channel.appendLine('  Messages:');
      for (const msg of result.messages) {
        this.channel.appendLine(`    ${msg}`);
      }
      this.channel.appendLine('');
    }

    if (result.stderrOutput.length > 0) {
      this.channel.appendLine('  Errors:');
      for (const err of result.stderrOutput) {
        this.channel.appendLine(`    ${err}`);
      }
      this.channel.appendLine('');
    }
  }

  dispose(): void {
    this.channel.dispose();
  }
}
