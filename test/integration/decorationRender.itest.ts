import * as assert from 'assert';
import * as fs from 'fs';
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
        statements: [{ id: 0, scope: 'ComputeDoubles_Scope_1', line: 14, column: 1, hits: 1 }],
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
        statements: [{ id: 0, scope: 'ComputeDoubles_Scope_1', line: 14, column: 1, hits: 1 }],
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
      'CoverageModel must accept the absolute-fwd-slash shape emitted by AL.Runner --server.',
    );

    dm.dispose();
  });

  test('v1 result renders no captures (no statement table, no fallback)', async () => {
    // Spec requires AL.Runner >= 2.7.0 with no fallback rendering path: a
    // result with no statement table (v1 has none by construction) must
    // render zero captures rather than placing them by the old line-index
    // heuristic. This test used to assert the opposite ("v1 path stays
    // alive") — that contract was deliberately deleted by the spec, and this
    // test is rewritten (not removed) to record the replacement behavior:
    // no captures painted, and applyResults must not throw doing it.
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

    let renderStats: import('../../src/editor/decorations').RenderStats | undefined;
    assert.doesNotThrow(() => {
      renderStats = dm.applyResults(editor as any, v1Result, APP_ROOT);
    }, 'applyResults must not throw for a v1 result with no statement table');

    assert.strictEqual(renderStats!.statementsAvailable, false, 'v1 results never carry a statement table');

    const captureCalls = calls.filter(c => c.type === captureType);
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.strictEqual(
      nonEmpty.length,
      0,
      `v1 path must render no captures without a statement table; got ${nonEmpty.length} non-empty call(s)`,
    );

    dm.dispose();
  });
});

suite('statement table — end to end', () => {
  test('captures land on their exact lines and ×N appears on the repeated line', async () => {
    const vscode = require('vscode');
    const fixture = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures', 'v2-summary-statements.json'), 'utf8'),
    );
    const workspacePath = path.resolve(__dirname, '../../../test/fixtures');
    const filePath = path.join(workspacePath, 'src', 'Foo.al');

    // Must be a real file on disk, not an untitled in-memory document: the
    // capture's `sourceFile` is resolved against `workspacePath` and matched
    // against `editor.document.uri.fsPath` (see
    // DecorationManager.applyInlineCapturedValues) — an untitled document's
    // URI never equals that resolved path, so nothing would ever match.
    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document);

    const dm = new DecorationManager(path.resolve(__dirname, '../../../'));
    const result: any = {
      mode: 'test',
      tests: [{
        name: 'T', status: 'passed', alSourceFile: 'src/Foo.al',
        capturedValues: [
          { scopeName: 'DoWork', alSourceFile: 'src/Foo.al', variableName: 'total', value: '55', statementId: 2 },
        ],
      }],
      messages: [], stderrOutput: [],
      summary: { passed: 1, failed: 0, errors: 0, total: 1 },
      coverage: [], exitCode: 0, durationMs: 5, capturedValues: [], cached: false,
      iterations: [], protocolVersion: 2, coverageV2: fixture.coverage,
    };

    const stats = dm.applyResults(editor, result, workspacePath);

    assert.strictEqual(stats.statementsAvailable, true);
    // Statement 2 lives on 1-based line 13 — the capture must land there, and
    // ordering by covered line would have put it on line 12.
    assert.strictEqual(stats.inlineDecorationsPainted, 1);
    assert.strictEqual(dm.getCoverageModel()!.forFile(filePath)!.lookup('DoWork', 2)!.line, 13);
    dm.dispose();
  });

  test('a v2 run with no statement table renders nothing and does not throw', async () => {
    const vscode = require('vscode');
    const document = await vscode.workspace.openTextDocument({ language: 'al', content: '// one line\n' });
    const editor = await vscode.window.showTextDocument(document);

    const dm = new DecorationManager(path.resolve(__dirname, '../../../'));
    const result: any = {
      mode: 'test',
      tests: [{
        name: 'T', status: 'passed', alSourceFile: 'src/Foo.al',
        capturedValues: [
          { scopeName: 'DoWork', alSourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
        ],
      }],
      messages: [], stderrOutput: [],
      summary: { passed: 1, failed: 0, errors: 0, total: 1 },
      coverage: [], exitCode: 0, durationMs: 5, capturedValues: [], cached: false,
      iterations: [], protocolVersion: 2,
      coverageV2: [{ file: 'src/Foo.al', lines: [{ line: 1, hits: 1 }], totalStatements: 1, hitStatements: 1 }],
    };

    const stats = dm.applyResults(editor, result, path.resolve('/ws'));

    assert.strictEqual(stats.statementsAvailable, false);
    assert.strictEqual(stats.inlineDecorationsPainted, 0);
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
