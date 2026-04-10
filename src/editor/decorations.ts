import * as vscode from 'vscode';
import * as path from 'path';
import { ExecutionResult, CoverageEntry } from '../runner/outputParser';

export class DecorationManager {
  private readonly coveredDecorationType: vscode.TextEditorDecorationType;
  private readonly uncoveredDecorationType: vscode.TextEditorDecorationType;
  private readonly errorLineDecorationType: vscode.TextEditorDecorationType;
  private readonly dimmedDecorationType: vscode.TextEditorDecorationType;
  private readonly messageDecorationType: vscode.TextEditorDecorationType;
  private readonly errorMessageDecorationType: vscode.TextEditorDecorationType;

  // Track per-file line coverage for hover provider
  private lineCoverageMap = new Map<string, Map<number, { hits: number }>>();

  constructor(private readonly extensionPath: string) {
    this.coveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-green.svg'),
      gutterIconSize: 'contain',
    });

    this.uncoveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-gray.svg'),
      gutterIconSize: 'contain',
    });

    this.errorLineDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-red.svg'),
      gutterIconSize: 'contain',
    });

    this.dimmedDecorationType = vscode.window.createTextEditorDecorationType({
      opacity: '0.5',
    });

    this.messageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#6a9955',
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });

    this.errorMessageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#f14c4c',
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });
  }

  applyResults(editor: vscode.TextEditor, result: ExecutionResult, workspacePath: string): void {
    this.clearDecorations(editor);

    const config = vscode.workspace.getConfiguration('alchemist');
    const filePath = editor.document.uri.fsPath;

    // Apply gutter coverage
    if (config.get<boolean>('showGutterCoverage', true)) {
      this.applyCoverageGutters(editor, result.coverage, filePath, workspacePath);
    }

    // Apply dimming for uncovered lines
    if (config.get<boolean>('dimUncoveredLines', true)) {
      this.applyDimming(editor, result.coverage, filePath, workspacePath);
    }

    // Apply inline error messages from test failures
    if (config.get<boolean>('showInlineMessages', true)) {
      this.applyInlineErrors(editor, result);
    }
  }

  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.coveredDecorationType, []);
    editor.setDecorations(this.uncoveredDecorationType, []);
    editor.setDecorations(this.errorLineDecorationType, []);
    editor.setDecorations(this.dimmedDecorationType, []);
    editor.setDecorations(this.messageDecorationType, []);
    editor.setDecorations(this.errorMessageDecorationType, []);
  }

  clearAll(): void {
    this.lineCoverageMap.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearDecorations(editor);
    }
  }

  getLineCoverage(filePath: string): Map<number, { hits: number }> | undefined {
    return this.lineCoverageMap.get(filePath);
  }

  private applyCoverageGutters(editor: vscode.TextEditor, coverage: CoverageEntry[], filePath: string, workspacePath: string): void {
    const entry = this.findCoverageForFile(coverage, filePath, workspacePath);
    if (!entry) return;

    const covered: vscode.DecorationOptions[] = [];
    const uncovered: vscode.DecorationOptions[] = [];
    const fileMap = new Map<number, { hits: number }>();

    for (const line of entry.lines) {
      const lineIndex = line.number - 1; // VSCode is 0-indexed
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;
      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
      fileMap.set(line.number, { hits: line.hits });

      if (line.hits > 0) {
        covered.push({ range });
      } else {
        uncovered.push({ range });
      }
    }

    this.lineCoverageMap.set(filePath, fileMap);
    editor.setDecorations(this.coveredDecorationType, covered);
    editor.setDecorations(this.uncoveredDecorationType, uncovered);
  }

  private applyDimming(editor: vscode.TextEditor, coverage: CoverageEntry[], filePath: string, workspacePath: string): void {
    const entry = this.findCoverageForFile(coverage, filePath, workspacePath);
    if (!entry) return;

    const dimmed: vscode.DecorationOptions[] = [];
    for (const line of entry.lines) {
      if (line.hits === 0) {
        const lineIndex = line.number - 1;
        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;
        const range = editor.document.lineAt(lineIndex).range;
        dimmed.push({ range });
      }
    }
    editor.setDecorations(this.dimmedDecorationType, dimmed);
  }

  private applyInlineErrors(editor: vscode.TextEditor, result: ExecutionResult): void {
    // Parse AL line references from stderr and test failure messages
    const errorDecorations: vscode.DecorationOptions[] = [];
    const alLineRegex = /\[AL line ~?(\d+) in (\w+)\]/;

    for (const test of result.tests) {
      if (test.status === 'failed' && test.message) {
        // Try to find AL line reference in stack trace
        const fullText = [test.message, test.stackTrace || ''].join('\n');
        const match = fullText.match(alLineRegex);
        if (match) {
          const lineNumber = parseInt(match[1], 10) - 1;
          if (lineNumber >= 0 && lineNumber < editor.document.lineCount) {
            const range = editor.document.lineAt(lineNumber).range;
            errorDecorations.push({
              range,
              renderOptions: {
                after: { contentText: `  \u2717 ${test.message}` },
              },
            });

            // Also set red gutter for this line
            editor.setDecorations(this.errorLineDecorationType, [{ range: new vscode.Range(lineNumber, 0, lineNumber, 0) }]);
          }
        }
      }
    }

    editor.setDecorations(this.errorMessageDecorationType, errorDecorations);

    // Apply Message() output for scratch mode
    if (result.mode === 'scratch' && result.messages.length > 0) {
      this.applyInlineMessages(editor, result.messages);
    }
  }

  private applyInlineMessages(editor: vscode.TextEditor, messages: string[]): void {
    // Best-effort: match Message() calls in source to output by order of appearance
    const messageDecorations: vscode.DecorationOptions[] = [];
    const messageCallRegex = /\bMessage\s*\(/i;
    let messageIndex = 0;

    for (let i = 0; i < editor.document.lineCount && messageIndex < messages.length; i++) {
      const lineText = editor.document.lineAt(i).text;
      if (messageCallRegex.test(lineText)) {
        const range = editor.document.lineAt(i).range;
        messageDecorations.push({
          range,
          renderOptions: {
            after: { contentText: `  \u2192 ${messages[messageIndex]}` },
          },
        });
        messageIndex++;
      }
    }

    editor.setDecorations(this.messageDecorationType, messageDecorations);
  }

  private findCoverageForFile(coverage: CoverageEntry[], filePath: string, workspacePath: string): CoverageEntry | undefined {
    const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
    return coverage.find((e) => {
      const entryPath = e.filename.replace(/\\/g, '/');
      return entryPath === relativePath || filePath.endsWith(entryPath);
    });
  }

  dispose(): void {
    this.coveredDecorationType.dispose();
    this.uncoveredDecorationType.dispose();
    this.errorLineDecorationType.dispose();
    this.dimmedDecorationType.dispose();
    this.messageDecorationType.dispose();
    this.errorMessageDecorationType.dispose();
    this.lineCoverageMap.clear();
  }
}
