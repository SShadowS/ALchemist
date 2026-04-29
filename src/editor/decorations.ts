import * as vscode from 'vscode';
import * as path from 'path';
import { ExecutionResult, CoverageEntry, CapturedValue } from '../runner/outputParser';
import { v2ToV1Captured } from '../execution/captureValueAdapter';

// Re-export so legacy importers (`import { v2ToV1Captured } from '../editor/decorations'`)
// keep compiling. New code should import from `../execution/captureValueAdapter`
// directly — that's the canonical location and carries the full lossiness JSDoc.
export { v2ToV1Captured };

/** Internal sentinel for the union bucket populated by v1 applyResults. */
const LEGACY_SCOPE_KEY = '__legacy__';

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
  // Track captured variable values per test (v2 streaming wires via setCapturedValuesForTest;
  // v1 applyResults dumps into the LEGACY_SCOPE_KEY bucket).
  private capturedValuesByTest = new Map<string, CapturedValue[]>();
  private activeTestName?: string;
  private warnedLossy = false;

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

    // v2 callers receive native gutter coverage via TestRun.addCoverage(). When
    // result.coverageV2 is populated we suppress the custom SVG gutter to avoid
    // double-painting; legacy v1 callers continue to use applyCoverageGutters.
    const v2CoverageActive = !!(result.coverageV2 && result.coverageV2.length > 0);

    // Apply gutter coverage (legacy/v1 path only)
    if (config.get<boolean>('showGutterCoverage', true) && !v2CoverageActive) {
      this.applyCoverageGutters(editor, result.coverage, filePath, workspacePath);
    } else if (v2CoverageActive) {
      // Clear any leftover custom gutter decorations from a prior v1 run so
      // the editor doesn't render both custom SVGs and VS Code-native gutter.
      editor.setDecorations(this.coveredDecorationType, []);
      editor.setDecorations(this.uncoveredDecorationType, []);
    }

    // Apply dimming for uncovered lines (still keyed off legacy CoverageEntry)
    if (config.get<boolean>('dimUncoveredLines', true) && !v2CoverageActive) {
      this.applyDimming(editor, result.coverage, filePath, workspacePath);
    }

    // Apply inline error messages from test failures. Inline error decoration
    // continues to land at result.tests[i].alSourceLine, which T6 populated
    // from the deepest user-frame in the v2 stack — so v2 gets correct
    // positions without changes here.
    if (config.get<boolean>('showInlineMessages', true)) {
      this.applyInlineErrors(editor, result);
    }

    // Captured variable values:
    // - v1 (no protocolVersion / undefined): top-level result.capturedValues holds the union.
    // - v2 (protocolVersion === 2): per-test arrays live on result.tests[i].capturedValues
    //   and use the v2 shape (objectName instead of sourceFile, value: unknown).
    //   We flatten + translate to v1 shape so applyInlineCapturedValues and the
    //   hover union path stay backward-compatible.
    //
    // STATUS: T10 wired per-test scoping (`setCapturedValuesForTest` +
    // `setActiveTest`), but this LEGACY_SCOPE_KEY union path is still the
    // active code on the save-triggered handler in `extension.ts:handleResult`,
    // which calls `applyResults` directly without driving streaming events.
    // The Test-Explorer-initiated path now bypasses this branch via
    // `TestController.handleStreamingEvent`. The save-triggered path is
    // deferred to a follow-up — see CHANGELOG known limitations
    // ("Save-triggered runs use the v1 result-application path").
    let captured: CapturedValue[];
    if (result.protocolVersion === 2) {
      captured = result.tests.flatMap(t =>
        (t.capturedValues ?? []).map(cv => v2ToV1Captured(cv, t.alSourceFile))
      );
    } else {
      captured = result.capturedValues;
    }

    this.capturedValuesByTest.set(LEGACY_SCOPE_KEY, captured);
    if (captured.length > 0) {
      this.applyInlineCapturedValues(editor, captured, result.coverage, workspacePath);
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

  /**
   * Returns captured values for hover/inline display.
   *
   * - When an active test is set (T10 wires this from TestController selection),
   *   returns ONLY that test's captures.
   * - When no active test, returns the union across all tests (preserves
   *   pre-v2 "show all captures" behaviour).
   * - The v1 `applyResults` path stores into the union via the LEGACY_SCOPE_KEY
   *   bucket; v2 streaming clients use `setCapturedValuesForTest(testName, ...)`
   *   directly.
   */
  getCapturedValues(): CapturedValue[] {
    if (this.activeTestName !== undefined) {
      return this.capturedValuesByTest.get(this.activeTestName) ?? [];
    }
    const all: CapturedValue[] = [];
    for (const arr of this.capturedValuesByTest.values()) {
      for (const cv of arr) { all.push(cv); }
    }
    return all;
  }

  /**
   * Record per-test captured values from a v2 streaming TestEvent.
   * Called by TestController.handleStreamingEvent (T10 wiring).
   */
  setCapturedValuesForTest(testName: string, values: CapturedValue[]): void {
    this.capturedValuesByTest.set(testName, values);
  }

  /**
   * Set which test's captured values to display in editor decorations.
   * Pass `undefined` to fall back to the union (show-all) view.
   * Caller is responsible for re-triggering applyResults / applyInlineCapturedValues
   * to refresh visible decorations.
   */
  setActiveTest(testName: string | undefined): void {
    this.activeTestName = testName;
  }

  /** Clear all per-test scope (e.g. when starting a new test run). */
  clearCapturedValueScopes(): void {
    this.capturedValuesByTest.clear();
    this.activeTestName = undefined;
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

    // Detect lossy v2-translated values once per session: a sourceFile that
    // doesn't end .al likely came from objectName fallback in v2ToV1Captured.
    if (!this.warnedLossy && capturedValues.some(cv => cv.sourceFile && !cv.sourceFile.toLowerCase().endsWith('.al'))) {
      console.warn(
        '[ALchemist] Captured values arrived with non-.al sourceFile (likely lossy v2 translation).',
        'Inline render filter may drop them. See Plan E2.1 task 2 for details.',
      );
      this.warnedLossy = true;
    }

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
