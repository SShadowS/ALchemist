import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecorationManager } from '../../src/editor/decorations';
import { ExecutionResult } from '../../src/runner/outputParser';
import { FileCoverage } from '../../src/execution/protocolV2Types';

const WS = path.resolve('/ws');
const FILE = path.join(WS, 'src', 'Foo.al');

interface DecorationCall { type: any; ranges: any[] }

function makeFakeEditor(fsPath: string, calls: DecorationCall[]): any {
  return {
    document: {
      uri: { fsPath },
      lineCount: 40,
      lineAt: (i: number) => ({
        text: '',
        range: { start: { line: i, character: 0 }, end: { line: i, character: 10 } },
      }),
    },
    setDecorations: (type: any, ranges: any[]) => { calls.push({ type, ranges }); },
  };
}

function resultWith(coverageV2: FileCoverage[]): ExecutionResult {
  return {
    mode: 'test', tests: [], messages: [], stderrOutput: [],
    summary: { passed: 1, failed: 0, errors: 0, total: 1 },
    coverage: [], exitCode: 0, durationMs: 1, capturedValues: [], cached: false,
    iterations: [], protocolVersion: 2, coverageV2,
  };
}

/**
 * Every `setDecorations` call made against the hit-count decoration type, in
 * order. `clearDecorations` (unconditional, top of `applyResults`) always
 * contributes one call; `applyHitCounts`, when it runs at all, contributes a
 * second. Asserting on this list's length — not just the last call's ranges —
 * is what distinguishes "ran and painted nothing" from "never ran": both
 * produce the same empty ranges, but only the former makes two calls.
 */
function hitCountCalls(calls: DecorationCall[]): DecorationCall[] {
  return calls.filter(c =>
    String(c.type?.options?.after?.color?.id ?? '').includes('hitCountForeground'),
  );
}

/** Ranges from the last call against the hit-count decoration type. */
function hitCountRanges(calls: DecorationCall[]): any[] {
  const matches = hitCountCalls(calls);
  return matches[matches.length - 1]?.ranges ?? [];
}

suite('hit-count decorations', () => {
  test('renders ×N on a line whose statement ran more than once', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 10 }], totalStatements: 1, hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, hits: 10 }],
    }]), WS);

    const ranges = hitCountRanges(calls);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].range.start.line, 11);
    assert.strictEqual(ranges[0].renderOptions.after.contentText.trim(), '×10');
    dm.dispose();
  });

  test('single-execution lines get no ×N (noise control)', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 1 }], totalStatements: 1, hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, hits: 1 }],
    }]), WS);

    // Two calls (clearDecorations, then applyHitCounts painting nothing)
    // proves the feature engaged and decided; one call would mean it never ran.
    const matches = hitCountCalls(calls);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[1].ranges.length, 0);
    dm.dispose();
  });

  test('uncovered statements (hits 0) get no ×N', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 0 }], totalStatements: 1, hitStatements: 0,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, hits: 0 }],
    }]), WS);

    const matches = hitCountCalls(calls);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[1].ranges.length, 0);
    dm.dispose();
  });

  test('multi-statement line shows the MAX count, never the sum', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 4, hits: 4 }], totalStatements: 2, hitStatements: 2,
      statements: [
        { id: 0, scope: 'S', line: 4, column: 5, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, hits: 1 },
      ],
    }]), WS);

    const ranges = hitCountRanges(calls);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].renderOptions.after.contentText.trim(), '×3');
    dm.dispose();
  });

  test('lines past the end of the document are skipped', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [], totalStatements: 1, hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 9999, column: 5, hits: 7 }],
    }]), WS);

    const matches = hitCountCalls(calls);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[1].ranges.length, 0);
    dm.dispose();
  });

  test('a run with no statement table paints no hit counts', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 10 }], totalStatements: 1, hitStatements: 1,
    }]), WS);

    const matches = hitCountCalls(calls);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[1].ranges.length, 0);
    dm.dispose();
  });

  test('showHitCounts=false gates the feature off (clear only, no repaint)', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    (vscode.workspace as any).getConfiguration = (section?: string) => {
      if (section === 'alchemist') {
        return { get: (key: string, defaultValue: any) => (key === 'showHitCounts' ? false : defaultValue) };
      }
      return originalGetConfiguration(section);
    };

    try {
      dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
        file: 'src/Foo.al', lines: [{ line: 12, hits: 10 }], totalStatements: 1, hitStatements: 1,
        statements: [{ id: 0, scope: 'S', line: 12, column: 5, hits: 10 }],
      }]), WS);

      // Only clearDecorations' call should land — applyHitCounts must never
      // be invoked when the setting is off, so there is exactly one call.
      const matches = hitCountCalls(calls);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].ranges.length, 0);
    } finally {
      (vscode.workspace as any).getConfiguration = originalGetConfiguration;
      dm.dispose();
    }
  });
});
