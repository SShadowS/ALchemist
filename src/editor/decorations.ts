import * as vscode from 'vscode';
import * as path from 'path';
import { ExecutionResult, CoverageEntry, CapturedValue } from '../runner/outputParser';

export class DecorationManager {
  private readonly coveredDecorationType: vscode.TextEditorDecorationType;
  private readonly uncoveredDecorationType: vscode.TextEditorDecorationType;
  private readonly errorLineDecorationType: vscode.TextEditorDecorationType;
  private readonly capturedValueDecorationType: vscode.TextEditorDecorationType;
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

    this.capturedValueDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#9cdcfe',
        margin: '0 0 0 16px',
        fontStyle: 'italic',
      },
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

    // Apply captured variable values
    if (result.capturedValues.length > 0) {
      this.applyInlineCapturedValues(editor, result.capturedValues, result.coverage, workspacePath);
    }
  }

  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.coveredDecorationType, []);
    editor.setDecorations(this.uncoveredDecorationType, []);
    editor.setDecorations(this.errorLineDecorationType, []);
    editor.setDecorations(this.capturedValueDecorationType, []);
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
        let lineNumber: number | undefined;

        // Prefer alSourceLine from JSON output (exact mapping)
        if (test.alSourceLine !== undefined) {
          lineNumber = test.alSourceLine - 1; // Convert to 0-based
        } else {
          // Fallback: parse from stack trace
          const fullText = [test.message, test.stackTrace || ''].join('\n');
          const match = fullText.match(alLineRegex);
          if (match) {
            lineNumber = parseInt(match[1], 10) - 1;
          }
        }

        if (lineNumber !== undefined && lineNumber >= 0 && lineNumber < editor.document.lineCount) {
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

    editor.setDecorations(this.errorMessageDecorationType, errorDecorations);

    // Apply Message() output for scratch mode
    if (result.mode === 'scratch' && result.messages.length > 0) {
      this.applyInlineMessages(editor, result.messages);
    }
  }

  private applyInlineMessages(editor: vscode.TextEditor, messages: string[]): void {
    // Find all Message() call line numbers in order
    const messageCallRegex = /\bMessage\s*\(/i;
    const callLines: number[] = [];

    for (let i = 0; i < editor.document.lineCount; i++) {
      if (messageCallRegex.test(editor.document.lineAt(i).text)) {
        callLines.push(i);
      }
    }

    if (callLines.length === 0 || messages.length === 0) return;

    // Match from both ends: first call → first output, last call → last output
    // Middle calls get the next output after the first
    const messageDecorations: vscode.DecorationOptions[] = [];
    const callToMessage = new Map<number, string>();

    if (callLines.length === 1) {
      // Single call gets first output
      callToMessage.set(callLines[0], messages[0]);
    } else {
      // First call → first output
      callToMessage.set(callLines[0], messages[0]);
      // Last call → last output
      callToMessage.set(callLines[callLines.length - 1], messages[messages.length - 1]);
      // Middle calls: divide remaining outputs (indices 1..N-2) evenly among middle calls,
      // show the LAST output from each call's batch (e.g., last loop iteration)
      const middleCalls = callLines.length - 2;
      const middleMessages = messages.length - 2; // exclude first and last
      if (middleCalls > 0 && middleMessages > 0) {
        const batchSize = Math.floor(middleMessages / middleCalls);
        for (let c = 0; c < middleCalls; c++) {
          // Each middle call gets a batch; show the last message in its batch
          const batchEnd = 1 + (c + 1) * batchSize - 1;
          const msgIdx = Math.min(batchEnd, messages.length - 2);
          callToMessage.set(callLines[c + 1], messages[msgIdx]);
        }
      }
    }

    for (const [lineIdx, msg] of callToMessage) {
      const range = editor.document.lineAt(lineIdx).range;
      messageDecorations.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2192 ${msg}` },
        },
      });
    }

    editor.setDecorations(this.messageDecorationType, messageDecorations);
  }

  private applyInlineCapturedValues(editor: vscode.TextEditor, capturedValues: CapturedValue[], coverage: CoverageEntry[], workspacePath: string): void {
    if (capturedValues.length === 0) return;

    // Group captured values by statementId, keeping only the last value per variable per statement
    const lastValues = new Map<string, CapturedValue>();
    for (const cv of capturedValues) {
      const key = `${cv.statementId}:${cv.variableName}`;
      lastValues.set(key, cv);
    }

    // Find coverage entry for this file to map statementIds to line numbers
    const filePath = editor.document.uri.fsPath;
    const entry = this.findCoverageForFile(coverage, filePath, workspacePath);
    if (!entry || entry.lines.length === 0) return;

    // statementIds are sequential per scope — map them to coverage line numbers in order
    const coveredLines = entry.lines
      .filter(l => l.hits > 0)
      .sort((a, b) => a.number - b.number);

    const decorations: vscode.DecorationOptions[] = [];

    for (const cv of lastValues.values()) {
      // Map statementId to a covered line (best effort: statementId as index into covered lines)
      if (cv.statementId >= 0 && cv.statementId < coveredLines.length) {
        const lineNumber = coveredLines[cv.statementId].number - 1;
        if (lineNumber >= 0 && lineNumber < editor.document.lineCount) {
          decorations.push({
            range: editor.document.lineAt(lineNumber).range,
            renderOptions: {
              after: { contentText: `  ${cv.variableName} = ${cv.value}` },
            },
          });
        }
      }
    }

    editor.setDecorations(this.capturedValueDecorationType, decorations);
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
    this.capturedValueDecorationType.dispose();
    this.dimmedDecorationType.dispose();
    this.messageDecorationType.dispose();
    this.errorMessageDecorationType.dispose();
    this.lineCoverageMap.clear();
  }
}
