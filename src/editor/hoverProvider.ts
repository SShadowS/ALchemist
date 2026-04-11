import * as vscode from 'vscode';
import { DecorationManager } from './decorations';
import { IterationStore } from '../iteration/iterationStore';

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
    const steppingLoop = this.getActiveSteppingLoop();

    // Get the hovered word for variable matching
    const wordRange = document.getWordRangeAtPosition(position);
    const hoveredWord = wordRange ? document.getText(wordRange) : '';

    if (steppingLoop) {
      return this.buildIterationHover(hoveredWord, lineNumber, steppingLoop);
    }

    return this.buildAggregateHover(filePath, hoveredWord, lineNumber);
  }

  /**
   * Find a loop that's actively being stepped (not in "show all" mode).
   */
  private getActiveSteppingLoop(): { loopId: string; iteration: number } | undefined {
    if (!this.iterationStore) return undefined;
    const loops = this.iterationStore.getLoops();
    for (const loop of loops) {
      if (!this.iterationStore.isShowingAll(loop.loopId) && loop.currentIteration > 0) {
        return { loopId: loop.loopId, iteration: loop.currentIteration };
      }
    }
    return undefined;
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

    const hasMatchingVar = hoveredWord && step.capturedValues.has(hoveredWord);
    const lineExecuted = step.linesExecuted.has(lineNumber);

    if (!hasMatchingVar && !lineExecuted && !step.linesExecuted.size) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // Show per-iteration variable value
    if (hasMatchingVar) {
      const value = step.capturedValues.get(hoveredWord)!;
      markdown.appendMarkdown(`**ALchemist: ${hoveredWord}** (iteration ${stepping.iteration} of ${loop.iterationCount})\n\n`);
      markdown.appendCodeblock(`${hoveredWord} = ${value}`, 'al');
      markdown.appendMarkdown('\n');
    }

    // Show per-iteration coverage
    if (step.linesExecuted.size > 0) {
      const status = lineExecuted ? 'Covered' : 'Not Covered';
      markdown.appendMarkdown(`**Statement Coverage** (iteration ${stepping.iteration})\n\n`);
      markdown.appendMarkdown(`Status: ${status}\n`);
    }

    return markdown.value.length > 0 ? new vscode.Hover(markdown) : undefined;
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

    // Show captured variable value (last captured wins)
    if (matchingValues.length > 0) {
      const lastValue = matchingValues[matchingValues.length - 1].value;
      markdown.appendMarkdown(`**ALchemist: ${hoveredWord}**\n\n`);
      markdown.appendCodeblock(`${hoveredWord} = ${lastValue}`, 'al');
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
