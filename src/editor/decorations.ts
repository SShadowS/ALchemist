import * as vscode from 'vscode';
import * as path from 'path';
import { ExecutionResult, CoverageEntry, CapturedValue } from '../runner/outputParser';

/**
 * Distributes messages across call sites and formats them for display.
 * Returns a map from call index (0-based) to its display string and optional allValues for hover.
 */
export function distributeMessages(callCount: number, messages: string[]): Map<number, { display: string; allValues?: string[] }> {
  const result = new Map<number, { display: string; allValues?: string[] }>();
  if (callCount <= 0 || messages.length === 0) return result;

  const callToMessages = new Map<number, string[]>();

  if (callCount === 1) {
    callToMessages.set(0, messages);
  } else {
    // First call gets first message, last call gets last message
    callToMessages.set(0, [messages[0]]);
    callToMessages.set(callCount - 1, [messages[messages.length - 1]]);

    const middleCalls = callCount - 2;
    const middleMessages = messages.length - 2;

    if (middleCalls > 0 && middleMessages > 0) {
      const batchSize = Math.ceil(middleMessages / middleCalls);
      for (let c = 0; c < middleCalls; c++) {
        const start = 1 + c * batchSize;
        const end = Math.min(start + batchSize, messages.length - 1);
        callToMessages.set(c + 1, messages.slice(start, end));
      }
    }
  }

  for (const [callIdx, msgs] of callToMessages) {
    let display: string;
    let allValues: string[] | undefined;

    if (msgs.length === 1) {
      display = msgs[0];
    } else if (msgs.length <= 3) {
      display = msgs.join(' | ');
    } else {
      // Show first .. last (x count) for loops
      display = `${msgs[0]} \u2025 ${msgs[msgs.length - 1]}  (\u00D7${msgs.length})`;
      allValues = msgs;
    }

    result.set(callIdx, { display, allValues });
  }

  return result;
}

export class DecorationManager {
  private readonly coveredDecorationType: vscode.TextEditorDecorationType;
  private readonly uncoveredDecorationType: vscode.TextEditorDecorationType;
  private readonly errorLineDecorationType: vscode.TextEditorDecorationType;
  private readonly capturedValueDecorationType: vscode.TextEditorDecorationType;
  private readonly dimmedDecorationType: vscode.TextEditorDecorationType;
  private readonly messageDecorationType: vscode.TextEditorDecorationType;
  private readonly errorMessageDecorationType: vscode.TextEditorDecorationType;
  private readonly changedValueFlashDecorationType: vscode.TextEditorDecorationType;
  private flashTimeout: ReturnType<typeof setTimeout> | undefined;

  // Track per-file line coverage for hover provider
  private lineCoverageMap = new Map<string, Map<number, { hits: number }>>();
  // Track captured variable values for hover provider
  private capturedValuesStore: CapturedValue[] = [];

  constructor(private readonly extensionPath: string) {
    this.coveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      dark: {
        gutterIconPath: path.join(extensionPath, 'resources', 'gutter-green.svg'),
      },
      light: {
        gutterIconPath: path.join(extensionPath, 'resources', 'light', 'gutter-green.svg'),
      },
    });

    this.uncoveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      dark: {
        gutterIconPath: path.join(extensionPath, 'resources', 'gutter-gray.svg'),
      },
      light: {
        gutterIconPath: path.join(extensionPath, 'resources', 'light', 'gutter-gray.svg'),
      },
    });

    this.errorLineDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      dark: {
        gutterIconPath: path.join(extensionPath, 'resources', 'gutter-red.svg'),
      },
      light: {
        gutterIconPath: path.join(extensionPath, 'resources', 'light', 'gutter-red.svg'),
      },
    });

    this.capturedValueDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('alchemist.capturedValueForeground'),
        margin: '0 0 0 16px',
        fontStyle: 'italic',
      },
    });

    this.dimmedDecorationType = vscode.window.createTextEditorDecorationType({
      opacity: '0.5',
    });

    this.messageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('alchemist.messageForeground'),
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });

    this.errorMessageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('alchemist.errorForeground'),
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });

    this.changedValueFlashDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('alchemist.capturedValueForeground'),
        margin: '0 0 0 16px',
        fontStyle: 'italic',
        backgroundColor: new vscode.ThemeColor('alchemist.changedValueBackground'),
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

    // Store and apply captured variable values
    this.capturedValuesStore = result.capturedValues;
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
    editor.setDecorations(this.changedValueFlashDecorationType, []);
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

  getCapturedValues(): CapturedValue[] {
    return this.capturedValuesStore;
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
        covered.push({
          range,
          hoverMessage: new vscode.MarkdownString(`**Covered** (${line.hits} hit${line.hits > 1 ? 's' : ''})`)
        });
      } else {
        uncovered.push({
          range,
          hoverMessage: new vscode.MarkdownString('**Not covered**')
        });
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
          // Use column for precise positioning if available
          const col = test.alSourceColumn !== undefined ? test.alSourceColumn - 1 : 0;
          const startPos = new vscode.Position(lineNumber, col);
          const range = new vscode.Range(startPos, editor.document.lineAt(lineNumber).range.end);
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

    // Use extracted distribution logic
    const distributed = distributeMessages(callLines.length, messages);

    const messageDecorations: vscode.DecorationOptions[] = [];
    for (const [callIdx, entry] of distributed) {
      const lineIdx = callLines[callIdx];
      let hoverMessage: vscode.MarkdownString | undefined;

      if (entry.allValues) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**ALchemist: ${entry.allValues.length} values**\n\n`);
        md.appendCodeblock(entry.allValues.join('\n'), 'text');
        hoverMessage = md;
      }

      const range = editor.document.lineAt(lineIdx).range;
      messageDecorations.push({
        range,
        hoverMessage,
        renderOptions: {
          after: { contentText: `  \u2192 ${entry.display}` },
        },
      });
    }

    editor.setDecorations(this.messageDecorationType, messageDecorations);
  }

  private applyInlineCapturedValues(editor: vscode.TextEditor, capturedValues: CapturedValue[], coverage: CoverageEntry[], workspacePath: string): void {
    if (capturedValues.length === 0) return;

    // Filter captured values to only those belonging to this file
    const filePath = editor.document.uri.fsPath;
    const fileValues = capturedValues.filter(cv => {
      if (!cv.sourceFile) return false;
      const resolved = path.resolve(workspacePath, cv.sourceFile);
      return path.normalize(resolved).toLowerCase() === path.normalize(filePath).toLowerCase();
    });
    if (fileValues.length === 0) return;

    // Group captured values by statementId, keeping only the last value per variable per statement
    const lastValues = new Map<string, CapturedValue>();
    for (const cv of fileValues) {
      const key = `${cv.statementId}:${cv.variableName}`;
      lastValues.set(key, cv);
    }
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

  applyIterationView(
    editor: vscode.TextEditor,
    step: { capturedValues: Map<string, string>; messages: string[]; linesExecuted: Set<number> },
    changedVarNames: string[],
    flashDurationMs: number,
    loopLineRange?: { start: number; end: number },
  ): void {
    // Clear existing iteration-specific decorations
    editor.setDecorations(this.capturedValueDecorationType, []);
    editor.setDecorations(this.messageDecorationType, []);
    editor.setDecorations(this.changedValueFlashDecorationType, []);
    editor.setDecorations(this.coveredDecorationType, []);
    editor.setDecorations(this.uncoveredDecorationType, []);
    editor.setDecorations(this.dimmedDecorationType, []);

    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
      this.flashTimeout = undefined;
    }

    const config = vscode.workspace.getConfiguration('alchemist');

    // Apply per-iteration coverage gutters (scoped to loop line range)
    if (config.get<boolean>('showGutterCoverage', true)) {
      const covered: vscode.DecorationOptions[] = [];
      const uncovered: vscode.DecorationOptions[] = [];
      const covStart = loopLineRange ? loopLineRange.start - 1 : 0;
      const covEnd = loopLineRange ? loopLineRange.end - 1 : editor.document.lineCount - 1;
      for (let i = covStart; i <= covEnd && i < editor.document.lineCount; i++) {
        const lineNum = i + 1; // 1-based
        const range = new vscode.Range(i, 0, i, 0);
        if (step.linesExecuted.has(lineNum)) {
          covered.push({ range });
        } else {
          uncovered.push({ range });
        }
      }
      editor.setDecorations(this.coveredDecorationType, covered);
      editor.setDecorations(this.uncoveredDecorationType, uncovered);
    }

    // Apply dimming for uncovered lines within loop range
    if (config.get<boolean>('dimUncoveredLines', true)) {
      const dimmed: vscode.DecorationOptions[] = [];
      const dimStart = loopLineRange ? loopLineRange.start - 1 : 0;
      const dimEnd = loopLineRange ? loopLineRange.end - 1 : editor.document.lineCount - 1;
      for (let i = dimStart; i <= dimEnd && i < editor.document.lineCount; i++) {
        const lineNum = i + 1; // 1-based
        if (!step.linesExecuted.has(lineNum)) {
          dimmed.push({ range: editor.document.lineAt(i).range });
        }
      }
      editor.setDecorations(this.dimmedDecorationType, dimmed);
    }

    // Apply per-iteration captured values — only within the active loop's line range
    const valueDecorations: vscode.DecorationOptions[] = [];
    const flashDecorations: vscode.DecorationOptions[] = [];
    const changedSet = new Set(changedVarNames.map((n) => n.toLowerCase()));

    const startLine = loopLineRange ? loopLineRange.start - 1 : 0; // Convert 1-based to 0-based
    const endLine = loopLineRange ? loopLineRange.end - 1 : editor.document.lineCount - 1;

    const assignRegex = /\b(\w+)\s*:=/;
    for (let i = startLine; i <= endLine && i < editor.document.lineCount; i++) {
      const lineText = editor.document.lineAt(i).text;
      const match = lineText.match(assignRegex);
      if (match) {
        const varName = match[1];
        const value = step.capturedValues.get(varName);
        if (value !== undefined) {
          const range = editor.document.lineAt(i).range;
          const isChanged = changedSet.has(varName.toLowerCase());
          const decorations = isChanged && flashDurationMs > 0 ? flashDecorations : valueDecorations;
          decorations.push({
            range,
            renderOptions: {
              after: { contentText: `  ${varName} = ${value}` },
            },
          });
        }
      }
    }
    editor.setDecorations(this.capturedValueDecorationType, valueDecorations);

    // Apply flash to changed values
    if (flashDecorations.length > 0 && flashDurationMs > 0) {
      editor.setDecorations(this.changedValueFlashDecorationType, flashDecorations);
      this.flashTimeout = setTimeout(() => {
        editor.setDecorations(this.changedValueFlashDecorationType, []);
        editor.setDecorations(this.capturedValueDecorationType, [...valueDecorations, ...flashDecorations]);
        this.flashTimeout = undefined;
      }, flashDurationMs);
    }

    // Apply per-iteration messages
    if (step.messages.length > 0) {
      const messageCallRegex = /\bMessage\s*\(/i;
      const callLines: number[] = [];
      for (let i = 0; i < editor.document.lineCount; i++) {
        if (messageCallRegex.test(editor.document.lineAt(i).text)) {
          callLines.push(i);
        }
      }
      if (callLines.length > 0) {
        const msgDecorations: vscode.DecorationOptions[] = [];
        for (let c = 0; c < callLines.length && c < step.messages.length; c++) {
          const range = editor.document.lineAt(callLines[c]).range;
          msgDecorations.push({
            range,
            renderOptions: {
              after: { contentText: `  \u2192 ${step.messages[c]}` },
            },
          });
        }
        editor.setDecorations(this.messageDecorationType, msgDecorations);
      }
    }
  }

  dispose(): void {
    this.coveredDecorationType.dispose();
    this.uncoveredDecorationType.dispose();
    this.errorLineDecorationType.dispose();
    this.capturedValueDecorationType.dispose();
    this.dimmedDecorationType.dispose();
    this.messageDecorationType.dispose();
    this.errorMessageDecorationType.dispose();
    this.changedValueFlashDecorationType.dispose();
    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
    }
    this.lineCoverageMap.clear();
  }
}
