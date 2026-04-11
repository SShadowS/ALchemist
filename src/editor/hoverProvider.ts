import * as vscode from 'vscode';
import { DecorationManager } from './decorations';

export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(private readonly decorationManager: DecorationManager) {}

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
    const lineCoverage = this.decorationManager.getLineCoverage(filePath);
    const capturedValues = this.decorationManager.getCapturedValues();

    // Check if we have anything to show for this line
    const coverageEntry = lineCoverage?.get(lineNumber);
    const lineValues = capturedValues.filter((cv) => cv.statementId === position.line);

    // Also check if the hovered word matches a captured variable name
    const wordRange = document.getWordRangeAtPosition(position);
    const hoveredWord = wordRange ? document.getText(wordRange) : '';
    const matchingValues = capturedValues.filter(
      (cv) => cv.variableName.toLowerCase() === hoveredWord.toLowerCase()
    );

    if (!coverageEntry && matchingValues.length === 0) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // Show captured variable values
    if (matchingValues.length > 0) {
      markdown.appendMarkdown(`**ALchemist: ${hoveredWord}**\n\n`);
      // Group by scope, show last value per scope
      const byScope = new Map<string, string>();
      for (const cv of matchingValues) {
        byScope.set(cv.scopeName, cv.value);
      }
      for (const [scope, value] of byScope) {
        markdown.appendCodeblock(`${hoveredWord} = ${value}`, 'al');
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
