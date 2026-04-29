import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { ExecutionResult } from '../../src/runner/outputParser';

/**
 * End-to-end headless verification for the v0.5.3 inline-render fix.
 *
 * The bug: applyResults passed an empty `result.coverage` (v1 cobertura) to
 * applyInlineCapturedValues for v2 results, so findCoverageForFile returned
 * undefined and the inline render silently no-op'd. The fix translates
 * `result.coverageV2 → CoverageEntry[]` on the fly.
 *
 * Why a real-VS-Code integration test (not just the unit lane): the unit lane
 * uses a hand-rolled `vscode` mock with a stub `setDecorations`. That mock
 * could mask a Windows-specific path bug (path.resolve / normalize edge
 * cases) or a real-API mismatch on the decoration-type identity. Driving
 * applyResults inside @vscode/test-electron exercises:
 *   - real `vscode.window.createTextEditorDecorationType`
 *   - real `editor.setDecorations` (we proxy it but the real impl runs)
 *   - real `editor.document.lineAt` (real Range objects)
 *   - real `path.resolve` against a real workspace path on the host platform
 */
const FIX = path.resolve(__dirname, '../../../test/fixtures');
const APP_ROOT = path.join(FIX, 'multi-app', 'MainApp.Test');
const AL_FILE = path.join(APP_ROOT, 'src', 'SomeTest.Codeunit.al');
const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

suite('Integration — inline captured-value rendering through real VS Code APIs', () => {
  test('v2 result with captures + coverageV2 produces non-empty captured-value decorations (v0.5.3 regression)', async () => {
    const vscode = require('vscode');

    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    const dm = new DecorationManager(EXTENSION_ROOT);
    const captureType = (dm as unknown as { capturedValueDecorationType: unknown }).capturedValueDecorationType;
    assert.ok(captureType, 'DecorationManager exposes capturedValueDecorationType');

    const v2Result: ExecutionResult = {
      mode: 'test',
      tests: [{
        name: 'ComputeDoubles',
        status: 'passed',
        durationMs: 0,
        capturedValues: [{
          scopeName: 'ComputeDoubles_Scope_1',
          objectName: 'SomeTestCodeunit',
          alSourceFile: 'src/SomeTest.Codeunit.al',
          variableName: 'Sut',
          value: 'codeunit',
          statementId: 0,
        }],
        alSourceFile: 'src/SomeTest.Codeunit.al',
      }] as any,
      messages: [],
      stderrOutput: [],
      summary: { passed: 1, failed: 0, errors: 0, total: 1 },
      coverage: [],
      coverageV2: [{
        file: 'src/SomeTest.Codeunit.al',
        lines: [{ line: 14, hits: 1 }],
        totalStatements: 1,
        hitStatements: 1,
      }],
      exitCode: 0,
      durationMs: 1,
      capturedValues: [],
      cached: false,
      iterations: [],
      protocolVersion: 2,
    };

    dm.applyResults(editor as any, v2Result, APP_ROOT);

    const captureCalls = calls.filter(c => c.type === captureType);
    assert.ok(
      captureCalls.length > 0,
      'expected at least one setDecorations call against capturedValueDecorationType',
    );
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected non-empty capture decoration via real VS Code API; got ${captureCalls.length} call(s), all empty. ` +
      'Bug surfaces when the v2 → v1 coverage translation in applyResults regresses (Plan E2.1 v0.5.3 fix).',
    );

    // Range must point at the covered line we declared (1-based 14 → 0-based 13).
    const range = nonEmpty[0].ranges[0];
    assert.ok(range, 'first non-empty call carries a range');
    const startLine = range.range?.start?.line ?? range.start?.line;
    assert.strictEqual(
      startLine,
      13,
      `decoration must land on line 14 (0-based 13); got line ${startLine}`,
    );

    dm.dispose();
  });

  test('v2 result with ABSOLUTE-path coverage entries (real --server wire shape) renders inline captures', async () => {
    // Real-world bug: AL.Runner --server emits absolute paths with forward
    // slashes for `coverage[].file` and `capturedValues[].alSourceFile`.
    // The unit test before this used relative paths which masked the
    // findCoverageForFile slash-comparison bug. This test reproduces the
    // exact wire shape we logged from `scripts/drive-server.ts` against a
    // real ALProject4-style fixture.
    const vscode = require('vscode');

    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    const dm = new DecorationManager(EXTENSION_ROOT);
    const captureType = (dm as unknown as { capturedValueDecorationType: unknown }).capturedValueDecorationType;

    // Mimic the server's wire shape exactly: absolute paths, forward slashes.
    const absoluteFwdSlash = AL_FILE.replace(/\\/g, '/');

    const v2Result: ExecutionResult = {
      mode: 'test',
      tests: [{
        name: 'ComputeDoubles',
        status: 'passed',
        durationMs: 0,
        capturedValues: [{
          scopeName: 'ComputeDoubles_Scope_1',
          objectName: 'SomeTestCodeunit',
          alSourceFile: absoluteFwdSlash,
          variableName: 'Sut',
          value: 'codeunit',
          statementId: 0,
        }],
        alSourceFile: absoluteFwdSlash,
      }] as any,
      messages: [],
      stderrOutput: [],
      summary: { passed: 1, failed: 0, errors: 0, total: 1 },
      coverage: [],
      coverageV2: [{
        file: absoluteFwdSlash,
        lines: [{ line: 14, hits: 1 }],
        totalStatements: 1,
        hitStatements: 1,
      }],
      exitCode: 0,
      durationMs: 1,
      capturedValues: [],
      cached: false,
      iterations: [],
      protocolVersion: 2,
    };

    dm.applyResults(editor as any, v2Result, APP_ROOT);

    const captureCalls = calls.filter(c => c.type === captureType);
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected non-empty capture decoration with absolute-path coverage; got ${captureCalls.length} call(s), all empty. ` +
      'findCoverageForFile must accept the absolute-fwd-slash shape emitted by AL.Runner --server.',
    );

    dm.dispose();
  });

  test('v1 result still renders captures (legacy path stays alive)', async () => {
    const vscode = require('vscode');

    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    const dm = new DecorationManager(EXTENSION_ROOT);
    const captureType = (dm as unknown as { capturedValueDecorationType: unknown }).capturedValueDecorationType;

    const v1Result: ExecutionResult = {
      mode: 'test',
      tests: [],
      messages: [],
      stderrOutput: [],
      summary: { passed: 0, failed: 0, errors: 0, total: 0 },
      coverage: [{
        className: '',
        filename: 'src/SomeTest.Codeunit.al',
        lineRate: 1,
        lines: [{ number: 14, hits: 1 }],
      }],
      exitCode: 0,
      durationMs: 1,
      capturedValues: [{
        scopeName: 'ComputeDoubles',
        sourceFile: 'src/SomeTest.Codeunit.al',
        variableName: 'Sut',
        value: 'codeunit',
        statementId: 0,
      }],
      cached: false,
      iterations: [],
    };

    dm.applyResults(editor as any, v1Result, APP_ROOT);

    const captureCalls = calls.filter(c => c.type === captureType);
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `v1 path must still render captures; got ${captureCalls.length} call(s), all empty`,
    );

    dm.dispose();
  });
});

/**
 * Build a minimal editor stand-in that holds the REAL document (so lineAt
 * returns real Range objects against a real opened text file) but routes
 * setDecorations to our recorder. We can't proxy or reassign setDecorations
 * on the real TextEditor — VS Code makes it a read-only, non-configurable
 * slot. The stand-in still exercises real `Document.lineAt`, real
 * `createTextEditorDecorationType` identity, and real `path.resolve` against
 * a real opened file URI. Only the painting side-effect is stubbed.
 */
function wrapEditor(real: any, calls: { type: any; ranges: any[] }[]): any {
  return {
    document: real.document,
    selection: real.selection,
    visibleRanges: real.visibleRanges,
    options: real.options,
    setDecorations: (type: any, ranges: any[]) => {
      calls.push({ type, ranges });
    },
  };
}
