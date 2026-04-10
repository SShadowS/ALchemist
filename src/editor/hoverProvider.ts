import * as vscode from 'vscode';
import { DecorationManager } from './decorations';

export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(private readonly decorationManager: DecorationManager) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // Convert to 1-indexed
    const lineCoverage = this.decorationManager.getLineCoverage(filePath);

    if (!lineCoverage) return undefined;

    const entry = lineCoverage.get(lineNumber);
    if (!entry) return undefined;

    const status = entry.hits > 0 ? 'Covered' : 'Not Covered';

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.appendMarkdown(`**Statement Coverage**\n\n`);
    markdown.appendMarkdown(`Status: ${status}\n\n`);
    markdown.appendMarkdown(`Hits: ${entry.hits}\n`);

    return new vscode.Hover(markdown);
  }
}
