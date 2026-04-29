import * as vscode from 'vscode';
import { DecorationManager } from './decorations';
import { IterationStore } from '../iteration/iterationStore';

function cmdUri(command: string, loopId: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([loopId]))}`;
}

export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly decorationManager: DecorationManager,
    private readonly iterationStore?: IterationStore,
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    try {
      return this.buildHover(document, position);
    } catch (err: any) {
      console.error('ALchemist hover error:', err);
      return undefined;
    }
  }

  private buildHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // Convert to 1-indexed

    // Check if we're in per-iteration stepping mode
    const steppingLoop = this.getActiveSteppingLoop(lineNumber);

    // Get the hovered word for variable matching
    const wordRange = document.getWordRangeAtPosition(position);
    const hoveredWord = wordRange ? document.getText(wordRange) : '';

    if (steppingLoop) {
      return this.buildIterationHover(hoveredWord, lineNumber, steppingLoop);
    }

    // Show-all mode: if hovering on a loop line, show nav-only hover
    const loopLineHover = this.buildLoopLineHover(lineNumber);
    if (loopLineHover) return loopLineHover;

    return this.buildAggregateHover(filePath, hoveredWord, lineNumber);
  }

  /**
   * Find a loop that's actively being stepped (not in "show all" mode).
   * Prefers the innermost loop containing the given line number.
   */
  private getActiveSteppingLoop(lineNumber: number): { loopId: string; iteration: number } | undefined {
    if (!this.iterationStore) return undefined;
    const loops = this.iterationStore.getLoops();
    // Find the innermost loop containing this line that is being stepped
    const stepping = loops
      .filter(l => !this.iterationStore!.isShowingAll(l.loopId) && l.currentIteration > 0)
      .filter(l => lineNumber >= l.loopLine && lineNumber <= l.loopEndLine)
      .sort((a, b) => (a.loopEndLine - a.loopLine) - (b.loopEndLine - b.loopLine));
    if (stepping.length > 0) {
      return { loopId: stepping[0].loopId, iteration: stepping[0].currentIteration };
    }
    // Fallback: any loop being stepped (for lines outside all loops)
    for (const loop of loops) {
      if (!this.iterationStore!.isShowingAll(loop.loopId) && loop.currentIteration > 0) {
        return { loopId: loop.loopId, iteration: loop.currentIteration };
      }
    }
    return undefined;
  }

  private buildIterationNavMarkdown(loopId: string, loop: { currentIteration: number; iterationCount: number }): string {
    if (this.iterationStore!.isShowingAll(loopId)) {
      return `[\u25C0 Step in](${cmdUri('alchemist.iterationPrev', loopId)}) | ` +
        `[Step in \u25B6](${cmdUri('alchemist.iterationNext', loopId)}) | ` +
        `[Table](${cmdUri('alchemist.iterationTable', loopId)})`;
    }
    return `[\u25C0 Prev](${cmdUri('alchemist.iterationPrev', loopId)}) | ` +
      `[Next \u25B6](${cmdUri('alchemist.iterationNext', loopId)}) | ` +
      `[Show All](${cmdUri('alchemist.iterationShowAll', loopId)}) | ` +
      `[Table](${cmdUri('alchemist.iterationTable', loopId)})`;
  }

  /**
   * Hover in per-iteration mode — shows values and coverage for the current iteration.
   */
  private buildIterationHover(
    hoveredWord: string,
    lineNumber: number,
    stepping: { loopId: string; iteration: number },
  ): vscode.Hover | undefined {
    const step = this.iterationStore!.getStep(stepping.loopId, stepping.iteration);
    const loop = this.iterationStore!.getLoop(stepping.loopId);

    const hoveredLower = hoveredWord.toLowerCase();
    const matchingKey = hoveredWord ? Array.from(step.capturedValues.keys()).find(k => k.toLowerCase() === hoveredLower) : undefined;
    const hasMatchingVar = !!matchingKey;
    const lineExecuted = step.linesExecuted.has(lineNumber);

    if (!hasMatchingVar && !lineExecuted) return undefined;

    const detail = vscode.workspace.getConfiguration('alchemist').get<string>('iterationHoverDetail', 'rich');
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // Header
    markdown.appendMarkdown(`**Iteration ${stepping.iteration} of ${loop.iterationCount}**\n\n`);

    // Navigation links
    markdown.appendMarkdown(this.buildIterationNavMarkdown(stepping.loopId, loop));
    markdown.appendMarkdown('\n\n');

    // Per-iteration variable value (for hovered word)
    if (hasMatchingVar) {
      const value = step.capturedValues.get(matchingKey!)!;
      markdown.appendCodeblock(`${matchingKey} = ${value}`, 'al');
    }

    // Values table (values + rich modes)
    if (detail !== 'minimal' && step.capturedValues.size > 0) {
      const changedVars = this.iterationStore!.getChangedValues(stepping.loopId, stepping.iteration);
      const prevStep = stepping.iteration > 1 ? this.iterationStore!.getStep(stepping.loopId, stepping.iteration - 1) : null;

      markdown.appendMarkdown('\n| Variable | Value |\n|----------|-------|\n');
      for (const [name, value] of step.capturedValues) {
        const changed = changedVars.includes(name);
        const prevValue = prevStep?.capturedValues.get(name);
        const changeNote = changed && prevValue !== undefined ? ` *(was ${prevValue})*` : '';
        markdown.appendMarkdown(`| ${name} | \`${value}\`${changeNote} |\n`);
      }
    }

    // Messages (rich mode only)
    if (detail === 'rich' && step.messages.length > 0) {
      markdown.appendMarkdown(`\nMessages: ${step.messages.map(m => `\`${m}\``).join(', ')}\n`);
    }

    return new vscode.Hover(markdown);
  }

  /**
   * Show navigation hover when hovering on a loop line in show-all mode.
   */
  private buildLoopLineHover(lineNumber: number): vscode.Hover | undefined {
    if (!this.iterationStore) return undefined;
    const loops = this.iterationStore.getLoops();
    const loop = loops.find(l => l.loopLine === lineNumber && l.iterationCount >= 2);
    if (!loop) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    if (this.iterationStore.isShowingAll(loop.loopId)) {
      markdown.appendMarkdown(`**All iterations** (${loop.iterationCount} total)\n\n`);
    } else {
      markdown.appendMarkdown(`**Iteration ${loop.currentIteration} of ${loop.iterationCount}**\n\n`);
    }
    markdown.appendMarkdown(this.buildIterationNavMarkdown(loop.loopId, loop));
    markdown.appendMarkdown('\n');

    return new vscode.Hover(markdown);
  }

  /**
   * Hover in aggregate mode (show-all or no iteration data) — existing behavior.
   */
  private buildAggregateHover(
    filePath: string,
    hoveredWord: string,
    lineNumber: number,
  ): vscode.Hover | undefined {
    const lineCoverage = this.decorationManager.getLineCoverage(filePath);
    const capturedValues = this.decorationManager.getCapturedValues();

    const coverageEntry = lineCoverage?.get(lineNumber);
    const matchingValues = hoveredWord
      ? capturedValues.filter((cv) => cv.variableName.toLowerCase() === hoveredWord.toLowerCase())
      : [];

    if (!coverageEntry && matchingValues.length === 0) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // Show captured variable values. v0.3.0 hovers exposed the full series
    // for loops (every iteration's value); v0.5.0 collapsed to the last
    // value, losing information. Restore the full series — single-value
    // hovers still render plain.
    if (matchingValues.length > 0) {
      markdown.appendMarkdown(`**ALchemist: ${hoveredWord}**\n\n`);
      if (matchingValues.length === 1) {
        markdown.appendCodeblock(`${hoveredWord} = ${matchingValues[0].value}`, 'al');
      } else {
        // Full series, one assignment per line
        const block = matchingValues
          .map((cv, i) => `${hoveredWord} = ${cv.value}  // capture #${i + 1}`)
          .join('\n');
        markdown.appendCodeblock(block, 'al');
        markdown.appendMarkdown(`\n_${matchingValues.length} captures total_\n`);
      }
      markdown.appendMarkdown('\n');
    }

    // Show coverage info
    if (coverageEntry) {
      const status = coverageEntry.hits > 0 ? 'Covered' : 'Not Covered';
      markdown.appendMarkdown(`**Statement Coverage**\n\n`);
      markdown.appendMarkdown(`Status: ${status}\n\n`);
      markdown.appendMarkdown(`Hits: ${coverageEntry.hits}\n`);
    }

    return new vscode.Hover(markdown);
  }
}
