# Statement Table + DAP Debugging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume AL.Runner 2.7.0's per-statement coverage table for exact inline-value placement and editor-visible hit counts, and add breakpoint debugging through the runner's stdio Debug Adapter.

**Architecture:** A new `CoverageModel` module becomes the single source of truth for statement positions, hit counts, and file-path matching. `DecorationManager` builds it once per run and exposes it; decorations, the hover provider, and the native coverage adapter all read from it instead of doing their own line math. Debugging is a separate `src/debug/` module: a `DebugAdapterDescriptorFactory` that launches `al-runner --dap stdio`, plus a Debug run profile on the existing `TestController`.

**Tech Stack:** TypeScript, VS Code Extension API (`^1.88.0`), Mocha (`ui: tdd` — `suite`/`test` + `assert`), webpack. Unit tests run outside the VS Code host against the mock in `test/__mocks__/vscode.js`.

**Spec:** `docs/superpowers/specs/2026-08-27-statement-table-dap-design.md`

## Global Constraints

- **Minimum AL.Runner version is `2.7.0`.** No fallback rendering path for older runners. The index-into-covered-lines placement heuristic is deleted, not kept behind a flag.
- **DAP flag is two tokens: `['--dap', 'stdio', bundleDir]`** — not `--dap-stdio`. stdout carries only DAP wire format; stderr carries logging.
- **Hit counts must render in the plain editor** after any run — never gated behind VS Code's Test or Coverage UI modes.
- **Statement ids are per-scope** and share an id-space with `CapturedValue.statementId`. Scope names are compared **case-insensitively** (AL identifiers are case-insensitive; same reasoning as the existing G8 casing fix in `decorations.ts`).
- **All positions from the runner are 1-based**; VS Code `Position`/`Range` are 0-based. Convert at the boundary, never in the model.
- Test commands: `npm run test:unit` (all unit tests), `npx mocha out/test/suite/<name>.test.js` after `npm run test-compile` (single file), `npm run test:integration`, `npm run lint`.
- Out of scope (upstream not built): per-execution captures (BusinessCentral.AL.Runner#2074) and iteration segmentation (#2056). The existing `iterations[]` / `IterationStore` feature is untouched by this plan.

---

### Task 1: Protocol types + CoverageModel

**Files:**
- Modify: `src/execution/protocolV2Types.ts:67-77` (add `StatementRecord`, extend `FileCoverage`)
- Create: `src/execution/coverageModel.ts`
- Test: `test/suite/coverageModel.test.ts`

**Interfaces:**
- Consumes: `FileCoverage` from `src/execution/protocolV2Types.ts`.
- Produces:
  - `interface StatementRecord { id: number; scope: string; line: number; column: number; endLine?: number; endColumn?: number; hits: number }`
  - `FileCoverage.statements?: StatementRecord[]`
  - `class FileStatementIndex` with `lookup(scope: string, id: number): StatementRecord | undefined`, `statementsOnLine(line: number): StatementRecord[]`, `lineRollup(): Map<number, number>`, `readonly statements: readonly StatementRecord[]`
  - `class CoverageModel` with `static fromFileCoverage(coverage: FileCoverage[], workspacePath: string): CoverageModel`, `forFile(fsPath: string): FileStatementIndex | undefined`, `readonly hasStatements: boolean`

- [ ] **Step 1: Write the failing test**

Create `test/suite/coverageModel.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import { CoverageModel } from '../../src/execution/coverageModel';
import { FileCoverage } from '../../src/execution/protocolV2Types';

const WS = path.resolve('/ws');

function fc(file: string, statements: FileCoverage['statements']): FileCoverage {
  return { file, lines: [], totalStatements: statements?.length ?? 0, hitStatements: 0, statements };
}

suite('CoverageModel', () => {
  test('lookup by (scope, id) returns the statement record', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'MyProcedure', line: 12, column: 5, endLine: 12, endColumn: 24, hits: 10 },
        { id: 1, scope: 'MyProcedure', line: 13, column: 5, hits: 1 },
      ]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'));
    assert.ok(index, 'expected an index for the file');
    const record = index!.lookup('MyProcedure', 0);
    assert.strictEqual(record?.line, 12);
    assert.strictEqual(record?.hits, 10);
  });

  test('scope lookup is case-insensitive (AL identifiers are)', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'MyProcedure', line: 7, column: 1, hits: 2 }]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    assert.strictEqual(index.lookup('myprocedure', 0)?.line, 7);
    assert.strictEqual(index.lookup('MYPROCEDURE', 0)?.line, 7);
  });

  test('unknown scope or id returns undefined, never a guess', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'MyProcedure', line: 7, column: 1, hits: 2 }]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    assert.strictEqual(index.lookup('OtherProcedure', 0), undefined);
    assert.strictEqual(index.lookup('MyProcedure', 99), undefined);
  });

  test('statementsOnLine groups multiple statements sharing one line', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'S', line: 4, column: 5, endLine: 4, endColumn: 20, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, endLine: 4, endColumn: 40, hits: 1 },
        { id: 2, scope: 'S', line: 5, column: 5, hits: 1 },
      ]),
    ], WS);

    const index = model.forFile(path.join(WS, 'src', 'Foo.al'))!;
    const onFour = index.statementsOnLine(4);
    assert.strictEqual(onFour.length, 2);
    assert.deepStrictEqual(onFour.map(s => s.column), [5, 22]);
    assert.strictEqual(index.statementsOnLine(5).length, 1);
    assert.strictEqual(index.statementsOnLine(99).length, 0);
  });

  test('lineRollup takes the max hits on a line, not the sum', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [
        { id: 0, scope: 'S', line: 4, column: 5, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, hits: 1 },
      ]),
    ], WS);

    const rollup = model.forFile(path.join(WS, 'src', 'Foo.al'))!.lineRollup();
    assert.strictEqual(rollup.get(4), 3);
  });

  test('path normalization matches all three producer shapes', () => {
    const target = path.join(WS, 'src', 'Foo.al');
    const shapes = [
      'src/Foo.al',                                    // workspace-relative, forward slashes
      path.resolve(WS, 'src/Foo.al').replace(/\\/g, '/'), // absolute, forward slashes
      path.join(WS, 'src', 'Foo.al'),                  // absolute, native slashes
    ];
    for (const shape of shapes) {
      const model = CoverageModel.fromFileCoverage([
        fc(shape, [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
      ], WS);
      assert.ok(model.forFile(target), `expected a match for producer shape ${shape}`);
    }
  });

  test('file matching is case-insensitive (Windows paths)', () => {
    const model = CoverageModel.fromFileCoverage([
      fc('src/Foo.al', [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
    ], WS);
    assert.ok(model.forFile(path.join(WS, 'SRC', 'FOO.AL')));
  });

  test('hasStatements is false when no entry carries a statement table', () => {
    const legacy: FileCoverage[] = [
      { file: 'src/Foo.al', lines: [{ line: 3, hits: 1 }], totalStatements: 1, hitStatements: 1 },
    ];
    const model = CoverageModel.fromFileCoverage(legacy, WS);
    assert.strictEqual(model.hasStatements, false);
    assert.strictEqual(model.forFile(path.join(WS, 'src', 'Foo.al')), undefined);
  });

  test('hasStatements is true when at least one entry carries a statement table', () => {
    const model = CoverageModel.fromFileCoverage([
      { file: 'src/Bare.al', lines: [], totalStatements: 0, hitStatements: 0 },
      fc('src/Foo.al', [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }]),
    ], WS);
    assert.strictEqual(model.hasStatements, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile`
Expected: FAIL — `Cannot find module '../../src/execution/coverageModel'` (TS2307).

- [ ] **Step 3: Add the protocol types**

In `src/execution/protocolV2Types.ts`, add above `FileCoverage`:

```ts
/**
 * One statement from AL.Runner 2.7.0's per-statement coverage table.
 *
 * `id` shares an id-space with `CapturedValue.statementId` for the same
 * `scope`, which is what lets a captured value be placed at an exact
 * source position instead of being inferred from line ordering.
 * All positions are 1-based.
 */
export interface StatementRecord {
  id: number;
  scope: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** True per-statement count, aggregated across the run. */
  hits: number;
}
```

Then extend `FileCoverage`:

```ts
export interface FileCoverage {
  file: string;                // relative path, forward-slash
  lines: FileCoverageLine[];
  totalStatements: number;
  hitStatements: number;
  /** AL.Runner >= 2.7.0. Absent on older runners — see MIN_AL_RUNNER_VERSION. */
  statements?: StatementRecord[];
}
```

- [ ] **Step 4: Write the CoverageModel implementation**

Create `src/execution/coverageModel.ts`:

```ts
import * as path from 'path';
import { FileCoverage, StatementRecord } from './protocolV2Types';

/**
 * Per-statement index for one source file.
 *
 * Built from AL.Runner 2.7.0's `coverage[].statements[]`. This is the single
 * place that answers "where is statement N of scope S" and "what ran on this
 * line" — before 2.7.0 those questions were answered by using a statementId
 * as an index into covered lines sorted by line number, which broke on
 * multi-statement lines and skipped statements.
 */
export class FileStatementIndex {
  private readonly byScope = new Map<string, Map<number, StatementRecord>>();
  private readonly byLine = new Map<number, StatementRecord[]>();

  constructor(public readonly statements: readonly StatementRecord[]) {
    for (const s of statements) {
      // AL identifiers are case-insensitive; the runner emits declaration
      // case while captures may carry a different case for the same scope.
      const scopeKey = s.scope.toLowerCase();
      let scoped = this.byScope.get(scopeKey);
      if (!scoped) { scoped = new Map(); this.byScope.set(scopeKey, scoped); }
      scoped.set(s.id, s);

      const online = this.byLine.get(s.line);
      if (online) { online.push(s); } else { this.byLine.set(s.line, [s]); }
    }
    for (const list of this.byLine.values()) {
      list.sort((a, b) => a.column - b.column);
    }
  }

  /** Exact position of statement `id` in `scope`, or undefined when unknown. */
  lookup(scope: string, id: number): StatementRecord | undefined {
    return this.byScope.get(scope.toLowerCase())?.get(id);
  }

  /** Statements starting on a 1-based line, ordered by column. */
  statementsOnLine(line: number): StatementRecord[] {
    return this.byLine.get(line) ?? [];
  }

  /**
   * Line-level hit counts, taking the MAX across statements on a line.
   * Max, not sum: a line with three statements each hit once ran once, and
   * summing would report it as three executions.
   */
  lineRollup(): Map<number, number> {
    const rollup = new Map<number, number>();
    for (const [line, list] of this.byLine) {
      rollup.set(line, Math.max(...list.map(s => s.hits)));
    }
    return rollup;
  }
}

/**
 * Statement indexes for every file in one run's coverage, keyed by a
 * normalized absolute path.
 *
 * Coverage entry filenames arrive in three shapes depending on producer:
 * workspace-relative with forward slashes, absolute with forward slashes,
 * and absolute with native slashes. `normalizeKey` collapses all three, so
 * consumers can look a file up by `editor.document.uri.fsPath` directly.
 */
export class CoverageModel {
  private constructor(
    private readonly byFile: Map<string, FileStatementIndex>,
    public readonly hasStatements: boolean,
  ) {}

  static fromFileCoverage(coverage: FileCoverage[], workspacePath: string): CoverageModel {
    const byFile = new Map<string, FileStatementIndex>();
    let hasStatements = false;
    for (const entry of coverage) {
      if (!entry.statements || entry.statements.length === 0) continue;
      hasStatements = true;
      byFile.set(
        CoverageModel.normalizeKey(entry.file, workspacePath),
        new FileStatementIndex(entry.statements),
      );
    }
    return new CoverageModel(byFile, hasStatements);
  }

  forFile(fsPath: string): FileStatementIndex | undefined {
    return this.byFile.get(CoverageModel.normalizeKey(fsPath, ''));
  }

  /**
   * `path.resolve` returns an absolute input unchanged and resolves a
   * relative one against the workspace, so one call covers all three
   * producer shapes. Lowercased for Windows-friendly comparison.
   */
  private static normalizeKey(file: string, workspacePath: string): string {
    const absolute = workspacePath ? path.resolve(workspacePath, file) : path.resolve(file);
    return path.normalize(absolute).toLowerCase();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/coverageModel.test.js`
Expected: PASS — 9 passing.

- [ ] **Step 6: Commit**

```bash
git add src/execution/protocolV2Types.ts src/execution/coverageModel.ts test/suite/coverageModel.test.ts
git commit -m "feat(coverage): statement table types + CoverageModel index"
```

---

### Task 2: Exact capture placement via CoverageModel

**Files:**
- Modify: `src/editor/decorations.ts` (`applyResults` ~194-282, `applyInlineCapturedValues` ~489-582, delete `findCoverageForFile` ~584-603)
- Test: `test/suite/capturePlacement.test.ts`

**Interfaces:**
- Consumes: `CoverageModel.fromFileCoverage`, `FileStatementIndex.lookup` (Task 1).
- Produces:
  - `DecorationManager.getCoverageModel(): CoverageModel | undefined` (used by Task 4's hover)
  - `RenderStats.statementsAvailable: boolean` (used by Task 6's runtime notice)
  - `applyInlineCapturedValues(editor, capturedValues, model, workspacePath)` — private; the `CoverageEntry[]` parameter is gone.

- [ ] **Step 1: Write the failing test**

Create `test/suite/capturePlacement.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { ExecutionResult, CapturedValue } from '../../src/runner/outputParser';
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

function v2Result(capturedValues: CapturedValue[], coverageV2: FileCoverage[]): ExecutionResult {
  return {
    mode: 'test',
    tests: [{
      name: 'T', status: 'passed', alSourceFile: 'src/Foo.al',
      capturedValues: capturedValues.map(cv => ({
        scopeName: cv.scopeName,
        alSourceFile: 'src/Foo.al',
        variableName: cv.variableName,
        value: cv.value,
        statementId: cv.statementId,
      })),
    }] as any,
    messages: [],
    stderrOutput: [],
    summary: { passed: 1, failed: 0, errors: 0, total: 1 },
    coverage: [],
    exitCode: 0,
    durationMs: 1,
    capturedValues: [],
    cached: false,
    iterations: [],
    protocolVersion: 2,
    coverageV2,
  };
}

/** Ranges painted for the decoration type whose `after` color id ends in `capturedValueForeground`. */
function capturedRanges(calls: DecorationCall[]): any[] {
  const call = calls.filter(c =>
    String(c.type?.options?.after?.color?.id ?? '').includes('capturedValueForeground'),
  ).pop();
  return call?.ranges ?? [];
}

suite('capture placement via statement table', () => {
  test('two statements on ONE line place their captures on that line (heuristic got this wrong)', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 2 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'DoWork', line: 12, column: 5, endLine: 12, endColumn: 20, hits: 1 },
        { id: 1, scope: 'DoWork', line: 12, column: 22, endLine: 12, endColumn: 40, hits: 1 },
      ],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'a', value: '1', statementId: 0 },
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'b', value: '2', statementId: 1 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    const ranges = capturedRanges(calls);
    assert.strictEqual(ranges.length, 2, 'both captures should be placed');
    // Line 12 is 1-based; the editor range is 0-based line 11.
    assert.ok(ranges.every(r => r.range.start.line === 11), 'both belong on editor line 11');
    dm.dispose();
  });

  test('placement follows the table, not covered-line ordering', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    // statementId 0 lives on line 30, statementId 1 on line 8. Ordering by
    // line number would place them the other way round.
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 8, hits: 1 }, { line: 30, hits: 1 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'DoWork', line: 30, column: 5, hits: 1 },
        { id: 1, scope: 'DoWork', line: 8, column: 5, hits: 1 },
      ],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'late', value: 'L', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    const ranges = capturedRanges(calls);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].range.start.line, 29, 'statement 0 is on 1-based line 30');
    dm.dispose();
  });

  test('capture whose (scope, id) is absent from the table is skipped, not guessed', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'DoWork', line: 12, column: 5, hits: 1 }],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'GhostScope', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(capturedRanges(calls).length, 0);
    dm.dispose();
  });

  test('scope casing difference still places the capture', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'dowork', line: 12, column: 5, hits: 1 }],
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(capturedRanges(calls).length, 1);
    dm.dispose();
  });

  test('statementsAvailable is false when the runner sent no statement table', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 1 }], totalStatements: 1, hitStatements: 1,
    }];
    const captures: CapturedValue[] = [
      { scopeName: 'DoWork', sourceFile: 'src/Foo.al', variableName: 'x', value: '1', statementId: 0 },
    ];

    const stats = dm.applyResults(makeFakeEditor(FILE, calls), v2Result(captures, coverage), WS);

    assert.strictEqual(stats.statementsAvailable, false);
    assert.strictEqual(capturedRanges(calls).length, 0, 'no guessed placement without a table');
    dm.dispose();
  });

  test('getCoverageModel exposes the model built for the last run', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    const coverage: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 12, hits: 4 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'DoWork', line: 12, column: 5, hits: 4 }],
    }];

    dm.applyResults(makeFakeEditor(FILE, calls), v2Result([], coverage), WS);

    const model = dm.getCoverageModel();
    assert.ok(model, 'a model should be retained after a run');
    assert.strictEqual(model!.forFile(FILE)?.lookup('DoWork', 0)?.hits, 4);
    dm.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile`
Expected: FAIL — TS2339 on `stats.statementsAvailable` and `dm.getCoverageModel`.

- [ ] **Step 3: Rewrite placement to use the model**

In `src/editor/decorations.ts`:

Add the import and a field:

```ts
import { CoverageModel } from '../execution/coverageModel';
```

```ts
  // Statement index for the most recent run. Undefined until a run with a
  // statement table lands; consumed by the hover provider via getCoverageModel().
  private coverageModel: CoverageModel | undefined;
```

Add `statementsAvailable` to `RenderStats`:

```ts
  /** True when the run's coverage carried AL.Runner >= 2.7.0 statement records. */
  statementsAvailable: boolean;
```

Initialize it in `applyResults`'s `stats` literal (`statementsAvailable: false,`).

Replace the captured-values block at the end of `applyResults` (the `coverageForFilter` translation and the `applyInlineCapturedValues` call) with:

```ts
    // AL.Runner >= 2.7.0 sends a per-statement table; it is the only source of
    // capture positions. Older runners are refused at install time
    // (MIN_AL_RUNNER_VERSION) and render no captures rather than guessed ones.
    this.coverageModel = result.coverageV2
      ? CoverageModel.fromFileCoverage(result.coverageV2, workspacePath)
      : undefined;
    stats.statementsAvailable = this.coverageModel?.hasStatements ?? false;

    this.capturedValuesByTest.set(LEGACY_SCOPE_KEY, captured);
    stats.captureCount = captured.length;
    if (captured.length > 0 && this.coverageModel !== undefined) {
      const inlineStats = this.applyInlineCapturedValues(editor, captured, this.coverageModel, workspacePath);
      stats.capturesForActiveFile = inlineStats.capturesForActiveFile;
      stats.coverageMatched = inlineStats.coverageMatched;
      stats.inlineDecorationsPainted = inlineStats.inlineDecorationsPainted;
      if (inlineStats.capturesForActiveFile === 0) {
        stats.sampleCaptureSourceFile = captured[0].sourceFile;
      }
    }
    return stats;
```

Add the accessor next to `getCapturedValues`:

```ts
  /**
   * Statement index for the most recent run, or undefined when none landed.
   * The hover provider reads positions and hit counts from here.
   */
  getCoverageModel(): CoverageModel | undefined {
    return this.coverageModel;
  }
```

Replace `applyInlineCapturedValues`'s signature and its coverage-derived placement:

```ts
  private applyInlineCapturedValues(
    editor: vscode.TextEditor,
    capturedValues: CapturedValue[],
    model: CoverageModel,
    workspacePath: string,
  ): InlineRenderStats {
    const stats: InlineRenderStats = { capturesForActiveFile: 0, coverageMatched: false, inlineDecorationsPainted: 0 };
    if (capturedValues.length === 0) return stats;

    const filePath = editor.document.uri.fsPath;
    const filePathNorm = path.normalize(filePath).toLowerCase();
    const fileValues = capturedValues.filter(cv => {
      if (!cv.sourceFile) return false;
      const resolved = path.resolve(workspacePath, cv.sourceFile);
      return path.normalize(resolved).toLowerCase() === filePathNorm;
    });
    stats.capturesForActiveFile = fileValues.length;
    if (fileValues.length === 0) return stats;

    const index = model.forFile(filePath);
    if (!index) return stats;
    stats.coverageMatched = true;

    // Group by (statementId, lowercased variable), preserving the ordered
    // series so loops render compactly via formatCaptureGroup. Grouping is
    // case-normalized because AL identifiers are case-insensitive and the
    // runner emits declaration case; display keeps the original case.
    const groupedValues = new Map<string, CapturedValue[]>();
    for (const cv of fileValues) {
      const key = `${cv.scopeName.toLowerCase()}:${cv.statementId}:${cv.variableName.toLowerCase()}`;
      const arr = groupedValues.get(key) ?? [];
      arr.push(cv);
      groupedValues.set(key, arr);
    }

    const decorations: vscode.DecorationOptions[] = [];
    for (const [, group] of groupedValues) {
      const head = group[0];
      const record = index.lookup(head.scopeName, head.statementId);
      if (!record) {
        // Fail visible-but-quiet: a capture the table does not know about is
        // dropped rather than placed by inference. One warning per miss keeps
        // a stale-run mismatch diagnosable without guessing a position.
        console.warn(
          `[ALchemist] no statement record for ${head.scopeName}#${head.statementId} in ${filePath}; capture not placed.`,
        );
        continue;
      }
      const lineIndex = record.line - 1;
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;

      const display = formatCaptureGroup(group.map(cv => cv.value));
      decorations.push({
        range: editor.document.lineAt(lineIndex).range,
        renderOptions: {
          after: { contentText: `  ${head.variableName} = ${display}` },
        },
      });
    }

    editor.setDecorations(this.capturedValueDecorationType, decorations);
    stats.inlineDecorationsPainted = decorations.length;
    return stats;
  }
```

Delete the now-unused `findCoverageForFile` method and the `warnedLossy` field with its non-`.al` warning block (the model's `lookup` miss covers that diagnostic). Keep `applyCoverageGutters` and `applyDimming` on the legacy `CoverageEntry[]` path for now — Task 5 leaves them alone and they are still exercised by the v1 scratch fixtures.

> If `applyCoverageGutters`/`applyDimming` no longer compile after `findCoverageForFile` is removed, restore a private copy of that method used only by those two callers — do not re-point capture placement at it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/capturePlacement.test.js`
Expected: PASS — 6 passing.

- [ ] **Step 5: Run the full unit suite and fix fallout**

Run: `npm run test:unit`
Expected: PASS. `test/suite/decorationManager.perTest.test.ts` has tests that assert the old heuristic's behavior (captures placed from `coverageV2.lines`) and call the private `applyInlineCapturedValues` with a `CoverageEntry[]`. Update those tests to supply `statements[]` and the new signature; delete assertions that only described the heuristic (for example a test named for the lossy `sourceFile` warning).

- [ ] **Step 6: Commit**

```bash
git add src/editor/decorations.ts test/suite/capturePlacement.test.ts test/suite/decorationManager.perTest.test.ts
git commit -m "feat(decorations): place captures from the statement table, delete line-index heuristic"
```

---

### Task 3: Editor-visible hit-count decorations

**Files:**
- Modify: `src/editor/decorations.ts` (new decoration type, `applyResults`, `clearDecorations`, `dispose`)
- Modify: `package.json` (`contributes.colors` — add `alchemist.hitCountForeground`; `contributes.configuration` — `alchemist.showHitCounts` description at line ~243)
- Test: `test/suite/hitCounts.test.ts`

**Interfaces:**
- Consumes: `DecorationManager.getCoverageModel` and `FileStatementIndex.statementsOnLine`/`lineRollup` (Tasks 1-2).
- Produces: `DecorationManager.applyHitCounts(editor, model, filePath)` — private, called from `applyResults`.

- [ ] **Step 1: Write the failing test**

Create `test/suite/hitCounts.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
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

/** Ranges painted for the hit-count decoration type. */
function hitCountRanges(calls: DecorationCall[]): any[] {
  const call = calls.filter(c =>
    String(c.type?.options?.after?.color?.id ?? '').includes('hitCountForeground'),
  ).pop();
  return call?.ranges ?? [];
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

    assert.strictEqual(hitCountRanges(calls).length, 0);
    dm.dispose();
  });

  test('uncovered statements (hits 0) get no ×N', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 0 }], totalStatements: 1, hitStatements: 0,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, hits: 0 }],
    }]), WS);

    assert.strictEqual(hitCountRanges(calls).length, 0);
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

    assert.strictEqual(hitCountRanges(calls).length, 0);
    dm.dispose();
  });

  test('a run with no statement table paints no hit counts', () => {
    const calls: DecorationCall[] = [];
    const dm = new DecorationManager(__dirname);
    dm.applyResults(makeFakeEditor(FILE, calls), resultWith([{
      file: 'src/Foo.al', lines: [{ line: 12, hits: 10 }], totalStatements: 1, hitStatements: 1,
    }]), WS);

    assert.strictEqual(hitCountRanges(calls).length, 0);
    dm.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && npx mocha out/test/suite/hitCounts.test.js`
Expected: FAIL — every assertion of a painted range fails with `0 !== 1` (no hit-count decoration type exists yet).

- [ ] **Step 3: Implement the decoration**

In `src/editor/decorations.ts`, add the field and construct it in the constructor alongside the others:

```ts
  private readonly hitCountDecorationType: vscode.TextEditorDecorationType;
```

```ts
    this.hitCountDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('alchemist.hitCountForeground'),
        margin: '0 0 0 12px',
        fontStyle: 'italic',
      },
    });
```

Add the render method:

```ts
  /**
   * Paint `×N` after every line whose most-executed statement ran more than
   * once. Applied on every run, not only during a Coverage run, so the count
   * is visible in the plain editor.
   *
   * N is the MAX across the line's statements, not the sum: three statements
   * on one line each hit once means the line ran once.
   */
  private applyHitCounts(editor: vscode.TextEditor, model: CoverageModel, filePath: string): void {
    const index = model.forFile(filePath);
    if (!index) { editor.setDecorations(this.hitCountDecorationType, []); return; }

    const decorations: vscode.DecorationOptions[] = [];
    for (const [line, hits] of index.lineRollup()) {
      if (hits <= 1) continue;
      const lineIndex = line - 1;
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;
      decorations.push({
        range: editor.document.lineAt(lineIndex).range,
        renderOptions: { after: { contentText: `  ×${hits}` } },
      });
    }
    editor.setDecorations(this.hitCountDecorationType, decorations);
  }
```

Call it from `applyResults`, immediately after `this.coverageModel` is assigned and `stats.statementsAvailable` is set:

```ts
    if (config.get<boolean>('showHitCounts', true) && this.coverageModel !== undefined) {
      this.applyHitCounts(editor, this.coverageModel, filePath);
    }
```

Add `editor.setDecorations(this.hitCountDecorationType, []);` to `clearDecorations`, and `this.hitCountDecorationType.dispose();` to `dispose`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/hitCounts.test.js`
Expected: PASS — 6 passing.

- [ ] **Step 5: Declare the theme color and fix the setting description**

In `package.json`, add to `contributes.colors` (after the `alchemist.messageForeground` entry):

```json
      {
        "id": "alchemist.hitCountForeground",
        "description": "Color for execution counts shown inline after repeated lines.",
        "defaults": {
          "dark": "#808080",
          "light": "#8a8a8a",
          "highContrast": "#a0a0a0",
          "highContrastLight": "#6a6a6a"
        }
      }
```

And change the `alchemist.showHitCounts` description (the "Phase 2" caveat is now false):

```json
        "alchemist.showHitCounts": {
          "type": "boolean",
          "default": true,
          "description": "Show execution counts (×N) after lines that ran more than once. Requires AL.Runner 2.7.0 or newer."
        },
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/editor/decorations.ts package.json test/suite/hitCounts.test.ts
git commit -m "feat(decorations): inline ×N hit counts from the statement table"
```

---

### Task 4: Per-statement hover breakdown

**Files:**
- Modify: `src/editor/hoverProvider.ts:171-226` (`buildAggregateHover`)
- Modify: `src/editor/decorations.ts` (delete `getLineCoverage` and the `lineCoverageMap` field; `applyCoverageGutters` stops populating it)
- Test: `test/suite/hoverProvider.test.ts` (extend)

**Interfaces:**
- Consumes: `DecorationManager.getCoverageModel()` (Task 2), `FileStatementIndex.statementsOnLine` (Task 1).
- Produces: no new public API. `CoverageHoverProvider`'s constructor signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/suite/hoverProvider.test.ts` (keep the file's existing imports; add `CoverageModel` and `path` if absent):

```ts
suite('CoverageHoverProvider — statement breakdown', () => {
  const WS = path.resolve('/ws');
  const FILE = path.join(WS, 'src', 'Foo.al');

  function providerFor(statements: any[], captured: any[] = []) {
    const model = CoverageModel.fromFileCoverage([{
      file: 'src/Foo.al', lines: [], totalStatements: statements.length,
      hitStatements: statements.filter(s => s.hits > 0).length, statements,
    }], WS);
    const dm: any = {
      getCoverageModel: () => model,
      getCapturedValues: () => captured,
    };
    return new CoverageHoverProvider(dm);
  }

  function docAt(line0: number, word: string): [any, any] {
    const document: any = {
      uri: { fsPath: FILE },
      getWordRangeAtPosition: () => (word ? { start: { line: line0, character: 0 } } : undefined),
      getText: () => word,
    };
    return [document, { line: line0, character: 0 }];
  }

  function hoverText(hover: any): string {
    return (hover?.contents?.[0]?.value ?? hover?.contents?.value ?? '') as string;
  }

  test('multi-statement line lists each statement with its column span and count', () => {
    const provider = providerFor([
      { id: 0, scope: 'S', line: 4, column: 5, endLine: 4, endColumn: 20, hits: 10 },
      { id: 1, scope: 'S', line: 4, column: 22, endLine: 4, endColumn: 40, hits: 1 },
    ]);
    const [document, position] = docAt(3, '');
    const text = hoverText(provider.provideHover(document, position));

    assert.ok(text.includes('col 5–20'), `expected first span, got: ${text}`);
    assert.ok(text.includes('10×'), `expected first count, got: ${text}`);
    assert.ok(text.includes('col 22–40'), `expected second span, got: ${text}`);
  });

  test('single statement hit once renders status without a breakdown list', () => {
    const provider = providerFor([{ id: 0, scope: 'S', line: 4, column: 5, hits: 1 }]);
    const [document, position] = docAt(3, '');
    const text = hoverText(provider.provideHover(document, position));

    assert.ok(text.includes('Covered'), `expected coverage status, got: ${text}`);
    assert.ok(!text.includes('col 5'), `did not expect a breakdown, got: ${text}`);
  });

  test('uncovered statement reports Not Covered', () => {
    const provider = providerFor([{ id: 0, scope: 'S', line: 4, column: 5, hits: 0 }]);
    const [document, position] = docAt(3, '');
    const text = hoverText(provider.provideHover(document, position));

    assert.ok(text.includes('Not Covered'), `got: ${text}`);
  });

  test('line with no statements and no captures yields no hover', () => {
    const provider = providerFor([{ id: 0, scope: 'S', line: 4, column: 5, hits: 1 }]);
    const [document, position] = docAt(30, '');
    assert.strictEqual(provider.provideHover(document, position), undefined);
  });

  test('statement without end position falls back to the start column alone', () => {
    const provider = providerFor([
      { id: 0, scope: 'S', line: 4, column: 5, hits: 3 },
      { id: 1, scope: 'S', line: 4, column: 22, hits: 2 },
    ]);
    const [document, position] = docAt(3, '');
    const text = hoverText(provider.provideHover(document, position));

    assert.ok(text.includes('col 5:'), `expected bare column form, got: ${text}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && npx mocha out/test/suite/hoverProvider.test.js`
Expected: FAIL — `getCoverageModel is not a function` is not reached; instead `getLineCoverage` is called on the stub and throws, or the breakdown assertions fail.

- [ ] **Step 3: Rewrite the coverage half of buildAggregateHover**

In `src/editor/hoverProvider.ts`, replace the first two statements of `buildAggregateHover` and its coverage block.

Replace:

```ts
    const lineCoverage = this.decorationManager.getLineCoverage(filePath);
    const capturedValues = this.decorationManager.getCapturedValues();

    const coverageEntry = lineCoverage?.get(lineNumber);
```

with:

```ts
    const statements = this.decorationManager.getCoverageModel()
      ?.forFile(filePath)
      ?.statementsOnLine(lineNumber) ?? [];
    const capturedValues = this.decorationManager.getCapturedValues();
```

Replace `if (!coverageEntry && matchingValues.length === 0) return undefined;` with:

```ts
    if (statements.length === 0 && matchingValues.length === 0) return undefined;
```

Replace the trailing coverage block:

```ts
    // Show coverage info
    if (coverageEntry) {
      const status = coverageEntry.hits > 0 ? 'Covered' : 'Not Covered';
      markdown.appendMarkdown(`**Statement Coverage**\n\n`);
      markdown.appendMarkdown(`Status: ${status}\n\n`);
      markdown.appendMarkdown(`Hits: ${coverageEntry.hits}\n`);
    }
```

with:

```ts
    // Coverage, from AL.Runner's per-statement table. A line's hit count is
    // the MAX across its statements — summing would report a line with three
    // statements each hit once as three executions.
    if (statements.length > 0) {
      const lineHits = Math.max(...statements.map(s => s.hits));
      markdown.appendMarkdown(`**Statement Coverage**\n\n`);
      markdown.appendMarkdown(`Status: ${lineHits > 0 ? 'Covered' : 'Not Covered'}\n\n`);
      markdown.appendMarkdown(`Hits: ${lineHits}\n`);

      // Break the line down only when the rollup hides something: several
      // statements share the line, or one of them ran repeatedly.
      if (statements.length > 1) {
        markdown.appendMarkdown('\n');
        for (const s of statements) {
          const span = s.endColumn !== undefined && s.endLine === s.line
            ? `col ${s.column}–${s.endColumn}`
            : `col ${s.column}`;
          markdown.appendMarkdown(`- ${span}: ${s.hits}×\n`);
        }
      }
    }
```

- [ ] **Step 4: Retire the line-coverage map**

In `src/editor/decorations.ts`, delete the `lineCoverageMap` field, the `getLineCoverage` method, the `fileMap` construction inside `applyCoverageGutters` (keep the gutter painting itself), and the `this.lineCoverageMap.clear()` calls in `clearAll` and `dispose`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/hoverProvider.test.js`
Expected: PASS — the five new tests plus the file's existing ones.

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. Any test that stubbed `getLineCoverage` must be updated to stub `getCoverageModel`.

- [ ] **Step 7: Commit**

```bash
git add src/editor/hoverProvider.ts src/editor/decorations.ts test/suite/hoverProvider.test.ts
git commit -m "feat(hover): per-statement hit breakdown, retire lineCoverageMap"
```

---

### Task 5: Native coverage with real statement ranges

**Files:**
- Modify: `src/execution/coverageAdapter.ts:52-67` (`toVsCodeCoverage`)
- Test: `test/suite/coverageAdapter.test.ts` (extend)

**Interfaces:**
- Consumes: `FileCoverage.statements` (Task 1).
- Produces: `toVsCodeCoverage` and `getDetails` keep their existing signatures; details are now built from `statements[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/suite/coverageAdapter.test.ts`:

```ts
suite('coverageAdapter — statement table', () => {
  test('statement with end position becomes a Range, not a bare Position', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 12, hits: 10 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 12, column: 5, endLine: 12, endColumn: 24, hits: 10 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    assert.strictEqual(detail.length, 1);
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 11);
    assert.strictEqual(range.start.character, 4);
    assert.strictEqual(range.end.line, 11);
    assert.strictEqual(range.end.character, 23);
    assert.strictEqual(detail[0].executed, 10);
  });

  test('two statements on one line produce two details with distinct counts', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 4, hits: 4 }],
      totalStatements: 2,
      hitStatements: 2,
      statements: [
        { id: 0, scope: 'S', line: 4, column: 5, endLine: 4, endColumn: 20, hits: 3 },
        { id: 1, scope: 'S', line: 4, column: 22, endLine: 4, endColumn: 40, hits: 1 },
      ],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    assert.strictEqual(detail.length, 2);
    assert.deepStrictEqual(detail.map(d => d.executed), [3, 1]);
  });

  test('statement without end position collapses to a zero-width range at its start', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 7, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{ id: 0, scope: 'S', line: 7, column: 3, hits: 1 }],
    }];
    const detail = getDetails(toVsCodeCoverage(input)[0])!;
    const range = detail[0].location as vscode.Range;
    assert.strictEqual(range.start.line, 6);
    assert.strictEqual(range.start.character, 2);
    assert.strictEqual(range.end.line, 6);
    assert.strictEqual(range.end.character, 2);
  });

  test('runner totals still drive TestCoverageCount, not the detail array length', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [],
      totalStatements: 10,
      hitStatements: 7,
      statements: [{ id: 0, scope: 'S', line: 1, column: 1, hits: 1 }],
    }];
    const fc = toVsCodeCoverage(input)[0];
    assert.strictEqual(fc.statementCoverage.covered, 7);
    assert.strictEqual(fc.statementCoverage.total, 10);
  });

  test('no statement table yields no details (2.7.0 required)', () => {
    const input: FileCoverage[] = [{
      file: path.resolve('/tmp/Foo.al'),
      lines: [{ line: 10, hits: 1 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1, 'the file still reports summary coverage');
    assert.deepStrictEqual(getDetails(out[0]), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && npx mocha out/test/suite/coverageAdapter.test.js`
Expected: FAIL — details are still built from `lines[]`, so `location` is a `Position` and `character` is 0.

- [ ] **Step 3: Rewrite the detail construction**

In `src/execution/coverageAdapter.ts`, replace the body of the `input.map` callback:

```ts
export function toVsCodeCoverage(input: FileCoverage[]): vscode.FileCoverage[] {
  return input.map(fc => {
    const fileCoverage = new vscode.FileCoverage(
      vscode.Uri.file(fc.file),
      new vscode.TestCoverageCount(fc.hitStatements, fc.totalStatements),
    );
    // Details come from AL.Runner >= 2.7.0's statement table: a real Range per
    // statement with its own count, so several statements on one line render
    // separately instead of collapsing onto column 0 with a summed count.
    // Older runners send no table and get summary-only coverage.
    const details = (fc.statements ?? []).map(s => {
      const startLine = s.line - 1;
      const startCol = s.column - 1;
      const endLine = (s.endLine ?? s.line) - 1;
      const endCol = s.endColumn !== undefined ? s.endColumn - 1 : startCol;
      return new vscode.StatementCoverage(
        s.hits,
        new vscode.Range(
          new vscode.Position(startLine, startCol),
          new vscode.Position(endLine, endCol),
        ),
      );
    });
    detailsByFc.set(fileCoverage, details);
    return fileCoverage;
  });
}
```

Update the block comment above the function: the "hit-count semantics" paragraph now describes per-statement counts rather than AL.Runner's line-level summing, and the `FileCoverage.fromDetails` note stays as-is (the runner's own totals still win).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/coverageAdapter.test.js`
Expected: PASS. Pre-existing tests in this file that assert `Position` locations built from `lines[]` (`'1-indexed line → 0-indexed Position'`, `'hits count preserved verbatim (sum semantics)'`, `'zero-hit line preserved (executed = 0)'`) now describe deleted behavior — rewrite each to supply an equivalent `statements[]` entry and assert on the `Range`.

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/execution/coverageAdapter.ts test/suite/coverageAdapter.test.ts
git commit -m "feat(coverage): native StatementCoverage from real statement ranges"
```

---

### Task 6: Version gate — require AL.Runner 2.7.0

**Files:**
- Modify: `src/runner/alRunnerManager.ts:4-39` (constant, `ensureInstalled`)
- Modify: `src/extension.ts:303-321` (runtime notice next to the existing render-stats logging)
- Test: `test/suite/alRunnerVersion.test.ts`

**Interfaces:**
- Consumes: `RenderStats.statementsAvailable` (Task 2).
- Produces:
  - `export function compareSemver(a: string, b: string): number` from `src/runner/alRunnerManager.ts` — negative when `a < b`, 0 when equal, positive when `a > b`. Pre-release suffixes (`-alpha.1`) are ignored for ordering.
  - `export function parseRunnerVersion(stdout: string): string | undefined` — extracts the first `major.minor.patch` from `al-runner --version` output.
  - `export const MIN_AL_RUNNER_VERSION = '2.7.0'`

- [ ] **Step 1: Write the failing test**

Create `test/suite/alRunnerVersion.test.ts`:

```ts
import * as assert from 'assert';
import { compareSemver, parseRunnerVersion, MIN_AL_RUNNER_VERSION } from '../../src/runner/alRunnerManager';

suite('AL.Runner version gate', () => {
  test('minimum is 2.7.0 — the release that ships the statement table and --dap stdio', () => {
    assert.strictEqual(MIN_AL_RUNNER_VERSION, '2.7.0');
  });

  test('compareSemver orders by major, then minor, then patch', () => {
    assert.ok(compareSemver('2.6.9', '2.7.0') < 0);
    assert.ok(compareSemver('2.7.0', '2.7.0') === 0);
    assert.ok(compareSemver('2.7.1', '2.7.0') > 0);
    assert.ok(compareSemver('3.0.0', '2.7.0') > 0);
    assert.ok(compareSemver('10.0.0', '9.9.9') > 0, 'numeric compare, not lexical');
  });

  test('compareSemver ignores a pre-release suffix', () => {
    assert.strictEqual(compareSemver('2.7.0-alpha.1', '2.7.0'), 0);
  });

  test('parseRunnerVersion pulls the version out of --version output', () => {
    assert.strictEqual(parseRunnerVersion('2.7.0'), '2.7.0');
    assert.strictEqual(parseRunnerVersion('al-runner 2.7.0\n'), '2.7.0');
    assert.strictEqual(parseRunnerVersion('AL.Runner version 2.7.1 (build 42)'), '2.7.1');
  });

  test('parseRunnerVersion returns undefined when no version is present', () => {
    assert.strictEqual(parseRunnerVersion(''), undefined);
    assert.strictEqual(parseRunnerVersion('command not found'), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile`
Expected: FAIL — TS2305, `compareSemver` and `parseRunnerVersion` are not exported.

- [ ] **Step 3: Implement the gate**

In `src/runner/alRunnerManager.ts`, replace the constant and its stale TODO:

```ts
/**
 * Minimum supported AL.Runner version.
 *
 * 2.7.0 is the floor because two features depend on it and have no fallback:
 * the per-statement coverage table (exact inline-value placement and hit
 * counts) and the `--dap stdio` transport used by the debug adapter.
 */
export const MIN_AL_RUNNER_VERSION = '2.7.0';

/** Negative when a < b, 0 when equal, positive when a > b. Pre-release suffixes are ignored. */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [aMajor, aMinor, aPatch] = parts(a);
  const [bMajor, bMinor, bPatch] = parts(b);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

/** First `major.minor.patch` in `al-runner --version` output, or undefined. */
export function parseRunnerVersion(stdout: string): string | undefined {
  const match = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return match ? match[1] : undefined;
}
```

Add a private method and a `warnedVersion` field to the class:

```ts
  private warnedVersion = false;
```

```ts
  /**
   * Warn once per session when the resolved runner predates the minimum.
   * Best-effort: an unreadable `--version` is not treated as a failure,
   * because the runtime notice in extension.ts still catches a missing
   * statement table.
   */
  private async warnIfBelowMinimum(runnerPath: string): Promise<void> {
    if (this.warnedVersion) return;
    const stdout = await new Promise<string>((resolve) => {
      cp.exec(`"${runnerPath}" --version`, (err, out) => resolve(err ? '' : out));
    });
    const version = parseRunnerVersion(stdout);
    if (!version || compareSemver(version, MIN_AL_RUNNER_VERSION) >= 0) return;

    this.warnedVersion = true;
    const usingCustomPath = !!vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '');
    const message =
      `ALchemist requires AL.Runner ${MIN_AL_RUNNER_VERSION} or newer (found ${version}). ` +
      'Inline values, hit counts, and debugging are unavailable until it is updated.';
    if (usingCustomPath) {
      vscode.window.showWarningMessage(message);
      return;
    }
    const action = await vscode.window.showWarningMessage(message, 'Update');
    if (action !== 'Update') return;
    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';
    cp.exec(`${dotnetPath} tool update -g msdyn365bc.al.runner`, (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Update failed: ${err.message}`);
      } else {
        vscode.window.showInformationMessage('AL.Runner updated successfully.');
        this.tryFindOnPath().then((p) => { this.resolvedPath = p; });
      }
    });
  }
```

Call it from `ensureInstalled` on each of the three success paths, before returning — for example:

```ts
    if (configPath) {
      this.resolvedPath = configPath;
      void this.warnIfBelowMinimum(configPath);
      return configPath;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/alRunnerVersion.test.js`
Expected: PASS — 5 passing.

- [ ] **Step 5: Add the runtime notice**

In `src/extension.ts`, inside the block that already logs `renderStats` (around line 310), add:

```ts
      if (!renderStats.statementsAvailable && renderStats.captureCount > 0) {
        outputChannel.appendLine(
          `  AL.Runner sent no statement table — inline values and hit counts require ${MIN_AL_RUNNER_VERSION} or newer.`,
        );
      }
```

Import the constant at the top: `import { AlRunnerManager, MIN_AL_RUNNER_VERSION } from './runner/alRunnerManager';`

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runner/alRunnerManager.ts src/extension.ts test/suite/alRunnerVersion.test.ts
git commit -m "feat(runner): require AL.Runner 2.7.0, warn on older installs"
```

---

### Task 7: Debug adapter factory + package.json contributions

**Files:**
- Create: `src/debug/debugAdapterFactory.ts`
- Modify: `src/extension.ts` (register the factory in `activate`)
- Modify: `package.json` (`contributes.debuggers`, `contributes.breakpoints`, `activationEvents`)
- Modify: `test/__mocks__/vscode.js` (add `DebugAdapterExecutable`, `debug` namespace)
- Test: `test/suite/debugAdapterFactory.test.ts`

**Interfaces:**
- Consumes: `AlRunnerManager.ensureInstalled(): Promise<string>`.
- Produces:
  - `export const ALCHEMIST_DEBUG_TYPE = 'alchemist'`
  - `export class AlchemistDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory` with `constructor(runnerManager: { ensureInstalled(): Promise<string> })` and `createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor>`
  - `export function resolveBundleDir(config: { bundleDir?: string; program?: string }, workspaceFolder: string | undefined): string`

**Before writing code — resolve the launch schema:** read AL.Runner 2.7.0's own handling of `--dap` to confirm what the third argument is (compiled bundle directory vs. project directory) and whether a single test method can be selected. Sources, in order: `U:\Git\BusinessCentral.AL.Runner\docs`, then `grep -rn "dap" U:\Git\BusinessCentral.AL.Runner\AlRunner\Program.cs`, then the [2.7.0 release notes](https://github.com/StefanMaron/BusinessCentral.AL.Runner/releases). If single-test selection is unsupported, keep `resolveBundleDir` as specified, note the gap in the commit message, and file it upstream — Task 8 then launches whole-session debugging and lets breakpoints do the filtering.

- [ ] **Step 1: Extend the vscode mock**

In `test/__mocks__/vscode.js`, add to `module.exports`:

```js
  DebugAdapterExecutable: class DebugAdapterExecutable {
    constructor(command, args, options) {
      this.command = command;
      this.args = args;
      this.options = options;
    }
  },
  debug: {
    registeredFactories: [],
    startDebuggingCalls: [],
    registerDebugAdapterDescriptorFactory(type, factory) {
      module.exports.debug.registeredFactories.push({ type, factory });
      return { dispose() {} };
    },
    async startDebugging(folder, config) {
      module.exports.debug.startDebuggingCalls.push({ folder, config });
      return true;
    },
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/suite/debugAdapterFactory.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import {
  AlchemistDebugAdapterFactory,
  resolveBundleDir,
  ALCHEMIST_DEBUG_TYPE,
} from '../../src/debug/debugAdapterFactory';

suite('AlchemistDebugAdapterFactory', () => {
  const RUNNER = path.join('C:', 'tools', 'al-runner.exe');
  const WS = path.resolve('/ws');

  function factoryWith(runnerPath: string | Error) {
    return new AlchemistDebugAdapterFactory({
      ensureInstalled: async () => {
        if (runnerPath instanceof Error) throw runnerPath;
        return runnerPath;
      },
    });
  }

  test('spawns the runner with the two-token --dap stdio form', async () => {
    const factory = factoryWith(RUNNER);
    const session: any = { configuration: { bundleDir: path.join(WS, 'app') }, workspaceFolder: undefined };

    const descriptor: any = await factory.createDebugAdapterDescriptor(session);

    assert.strictEqual(descriptor.command, RUNNER);
    assert.deepStrictEqual(descriptor.args, ['--dap', 'stdio', path.join(WS, 'app')]);
  });

  test('the flag is never the single-token --dap-stdio spelling', async () => {
    const factory = factoryWith(RUNNER);
    const session: any = { configuration: { bundleDir: WS }, workspaceFolder: undefined };
    const descriptor: any = await factory.createDebugAdapterDescriptor(session);
    assert.ok(!descriptor.args.includes('--dap-stdio'), 'AL.Runner 2.7.0 takes two tokens');
  });

  test('runner resolution failure surfaces an actionable error', async () => {
    const factory = factoryWith(new Error('Could not find or install AL.Runner'));
    const session: any = { configuration: { bundleDir: WS }, workspaceFolder: undefined };

    await assert.rejects(
      () => factory.createDebugAdapterDescriptor(session),
      /AL\.Runner/,
    );
  });

  test('debug type is the one the package.json contribution declares', () => {
    assert.strictEqual(ALCHEMIST_DEBUG_TYPE, 'alchemist');
  });
});

suite('resolveBundleDir', () => {
  const WS = path.resolve('/ws');

  test('explicit bundleDir wins', () => {
    assert.strictEqual(resolveBundleDir({ bundleDir: path.join(WS, 'out') }, WS), path.join(WS, 'out'));
  });

  test('a relative bundleDir resolves against the workspace folder', () => {
    assert.strictEqual(resolveBundleDir({ bundleDir: 'app' }, WS), path.join(WS, 'app'));
  });

  test('falls back to the program directory when bundleDir is absent', () => {
    assert.strictEqual(resolveBundleDir({ program: path.join(WS, 'app', 'Foo.al') }, WS), path.join(WS, 'app'));
  });

  test('falls back to the workspace folder when neither is given', () => {
    assert.strictEqual(resolveBundleDir({}, WS), WS);
  });

  test('throws when nothing can be resolved', () => {
    assert.throws(() => resolveBundleDir({}, undefined), /bundleDir/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test-compile`
Expected: FAIL — `Cannot find module '../../src/debug/debugAdapterFactory'`.

- [ ] **Step 4: Implement the factory**

Create `src/debug/debugAdapterFactory.ts`:

```ts
import * as vscode from 'vscode';
import * as path from 'path';

/** Debug type id — must match `contributes.debuggers[].type` in package.json. */
export const ALCHEMIST_DEBUG_TYPE = 'alchemist';

/** The subset of AlRunnerManager this factory needs, so tests can supply a stub. */
interface RunnerResolver {
  ensureInstalled(): Promise<string>;
}

/**
 * Directory AL.Runner debugs. Explicit `bundleDir` wins; otherwise the
 * directory holding `program`; otherwise the workspace folder.
 */
export function resolveBundleDir(
  config: { bundleDir?: string; program?: string },
  workspaceFolder: string | undefined,
): string {
  if (config.bundleDir) {
    return path.isAbsolute(config.bundleDir)
      ? config.bundleDir
      : path.resolve(workspaceFolder ?? '', config.bundleDir);
  }
  if (config.program) return path.dirname(config.program);
  if (workspaceFolder) return workspaceFolder;
  throw new Error('ALchemist debug: set `bundleDir` in the launch configuration — no workspace folder to fall back to.');
}

/**
 * Launches `al-runner --dap stdio <bundleDir>` and speaks DAP over its
 * stdio pipes.
 *
 * Two tokens, `--dap` and `stdio`: AL.Runner 2.7.0 takes the transport as a
 * separate argument. `--dap [PORT]` still selects TCP, which ALchemist does
 * not use — TCP would mean spawning the process ourselves, detecting when it
 * is listening, and handling port collisions between sessions.
 *
 * In stdio mode the runner's stdout carries only the DAP wire format; all of
 * its logging goes to stderr.
 */
export class AlchemistDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly runnerManager: RunnerResolver) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor> {
    let runnerPath: string;
    try {
      runnerPath = await this.runnerManager.ensureInstalled();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`ALchemist debug: AL.Runner is required to debug AL tests — ${detail}`);
    }

    const bundleDir = resolveBundleDir(
      session.configuration as { bundleDir?: string; program?: string },
      session.workspaceFolder?.uri.fsPath,
    );

    return new vscode.DebugAdapterExecutable(runnerPath, ['--dap', 'stdio', bundleDir]);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/debugAdapterFactory.test.js`
Expected: PASS — 9 passing.

- [ ] **Step 6: Register the factory and declare the contributions**

In `src/extension.ts`, import and register inside `activate` (near the hover-provider registration around line 712):

```ts
import { AlchemistDebugAdapterFactory, ALCHEMIST_DEBUG_TYPE } from './debug/debugAdapterFactory';
```

```ts
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      ALCHEMIST_DEBUG_TYPE,
      new AlchemistDebugAdapterFactory(runnerManager),
    ),
  );
```

In `package.json`, add to `contributes`:

```json
    "breakpoints": [
      { "language": "al" }
    ],
    "debuggers": [
      {
        "type": "alchemist",
        "label": "ALchemist (AL.Runner)",
        "languages": ["al"],
        "configurationAttributes": {
          "launch": {
            "properties": {
              "bundleDir": {
                "type": "string",
                "description": "Directory AL.Runner debugs. Defaults to the workspace folder.",
                "default": "${workspaceFolder}"
              },
              "testFilter": {
                "type": "string",
                "description": "Optional test name to run under the debugger. Omit to debug the whole suite."
              }
            }
          }
        },
        "initialConfigurations": [
          {
            "type": "alchemist",
            "request": "launch",
            "name": "ALchemist: Debug AL Tests",
            "bundleDir": "${workspaceFolder}"
          }
        ],
        "configurationSnippets": [
          {
            "label": "ALchemist: Debug AL Tests",
            "description": "Debug AL tests with AL.Runner (no container required).",
            "body": {
              "type": "alchemist",
              "request": "launch",
              "name": "ALchemist: Debug AL Tests",
              "bundleDir": "^\"\\${workspaceFolder}\""
            }
          }
        ]
      }
    ],
```

Add `"onDebugResolve:alchemist"` to `activationEvents`.

- [ ] **Step 7: Run the full unit suite**

Run: `npm run test:unit && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/debug/debugAdapterFactory.ts src/extension.ts package.json test/__mocks__/vscode.js test/suite/debugAdapterFactory.test.ts
git commit -m "feat(debug): DAP adapter over al-runner --dap stdio"
```

---

### Task 8: Debug run profile on the Test Explorer

**Files:**
- Modify: `src/testing/testController.ts:124-157` (constructor — add the Debug profile)
- Create: `src/debug/debugLaunch.ts`
- Test: `test/suite/debugLaunch.test.ts`

**Interfaces:**
- Consumes: `ALCHEMIST_DEBUG_TYPE` (Task 7).
- Produces:
  - `export function buildDebugConfiguration(opts: { bundleDir: string; testName?: string }): vscode.DebugConfiguration`
  - `export function shouldWarnAboutStepping(alreadyWarned: boolean): boolean`
  - `TestController` registers a second profile with `vscode.TestRunProfileKind.Debug`.

- [ ] **Step 1: Write the failing test**

Create `test/suite/debugLaunch.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import { buildDebugConfiguration, shouldWarnAboutStepping } from '../../src/debug/debugLaunch';

suite('buildDebugConfiguration', () => {
  const WS = path.resolve('/ws');

  test('names the alchemist debug type and a launch request', () => {
    const config = buildDebugConfiguration({ bundleDir: WS });
    assert.strictEqual(config.type, 'alchemist');
    assert.strictEqual(config.request, 'launch');
    assert.strictEqual(config.bundleDir, WS);
  });

  test('a selected test becomes testFilter and names the session', () => {
    const config = buildDebugConfiguration({ bundleDir: WS, testName: 'TestCustomerInsert' });
    assert.strictEqual(config.testFilter, 'TestCustomerInsert');
    assert.ok(String(config.name).includes('TestCustomerInsert'));
  });

  test('no selected test omits testFilter entirely', () => {
    const config = buildDebugConfiguration({ bundleDir: WS });
    assert.ok(!('testFilter' in config), 'an absent filter must not be sent as undefined');
  });
});

suite('shouldWarnAboutStepping', () => {
  test('warns the first time only', () => {
    assert.strictEqual(shouldWarnAboutStepping(false), true);
    assert.strictEqual(shouldWarnAboutStepping(true), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile`
Expected: FAIL — `Cannot find module '../../src/debug/debugLaunch'`.

- [ ] **Step 3: Implement the launch helpers**

Create `src/debug/debugLaunch.ts`:

```ts
import * as vscode from 'vscode';
import { ALCHEMIST_DEBUG_TYPE } from './debugAdapterFactory';

/**
 * Launch configuration for a debug session started from the Test Explorer.
 *
 * `testFilter` is omitted rather than set to undefined when no single test is
 * selected: an explicit undefined would be serialized into the configuration
 * and read by the adapter as a filter matching nothing.
 */
export function buildDebugConfiguration(opts: { bundleDir: string; testName?: string }): vscode.DebugConfiguration {
  const name = opts.testName
    ? `ALchemist: Debug ${opts.testName}`
    : 'ALchemist: Debug AL Tests';
  return {
    type: ALCHEMIST_DEBUG_TYPE,
    request: 'launch',
    name,
    bundleDir: opts.bundleDir,
    ...(opts.testName ? { testFilter: opts.testName } : {}),
  };
}

/**
 * Whether to show the one-per-session stepping caveat.
 *
 * AL.Runner 2.7.0's adapter implements breakpoints, pause, stack, and
 * variables, but `next`/`stepIn`/`stepOut` currently behave like `continue`.
 * Saying so once beats letting a user conclude the debugger is broken.
 */
export function shouldWarnAboutStepping(alreadyWarned: boolean): boolean {
  return !alreadyWarned;
}

export const STEPPING_CAVEAT =
  'AL.Runner 2.7.0: stepping acts as continue. Breakpoints, pause, call stack, and variables are fully functional.';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/debugLaunch.test.js`
Expected: PASS — 4 passing.

- [ ] **Step 5: Register the Debug run profile**

In `src/testing/testController.ts`, add imports:

```ts
import { buildDebugConfiguration, shouldWarnAboutStepping, STEPPING_CAVEAT } from '../debug/debugLaunch';
```

Add a field:

```ts
  private warnedAboutStepping = false;
```

In the constructor, after the existing `runProfile` block:

```ts
    // Debug profile: the Debug gutter action on any test starts a DAP session
    // against the same runner the Run profile uses. Breakpoints do the work;
    // see STEPPING_CAVEAT for what 2.7.0's adapter does not implement yet.
    this.controller.createRunProfile(
      'Debug Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.debugTests(request, token),
      false,
    );
```

Add the handler:

```ts
  /**
   * Start a debug session for the selected test (or the whole suite when the
   * request carries no specific item).
   */
  private async debugTests(
    request: vscode.TestRunRequest,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('ALchemist: open a workspace folder before debugging AL tests.');
      return;
    }

    if (shouldWarnAboutStepping(this.warnedAboutStepping)) {
      this.warnedAboutStepping = true;
      vscode.window.showInformationMessage(STEPPING_CAVEAT);
    }

    const selected = request.include?.[0];
    const config = buildDebugConfiguration({
      bundleDir: folder.uri.fsPath,
      testName: selected?.label,
    });
    await vscode.debug.startDebugging(folder, config);
  }
```

- [ ] **Step 6: Write the profile registration test**

Append to `test/suite/debugLaunch.test.ts`:

```ts
import * as vscode from 'vscode';
import { TestController } from '../../src/testing/testController';

suite('TestController — Debug profile', () => {
  test('registers a Debug-kind run profile alongside Run', () => {
    const controller = new TestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ label: string; kind: number }>;

    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug);
    assert.ok(debugProfile, 'expected a Debug profile');
    assert.strictEqual(debugProfile!.label, 'Debug Tests');

    const runProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Run);
    assert.ok(runProfile, 'the Run profile must survive');
  });

  test('debug handler starts a session carrying the selected test name', async () => {
    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('/ws') }, name: 'ws', index: 0 }];
    (vscode as any).debug.startDebuggingCalls.length = 0;

    const controller = new TestController(() => undefined);
    const profiles = (controller as any).controller.__runProfiles as Array<{ kind: number; runHandler: Function }>;
    const debugProfile = profiles.find(p => p.kind === vscode.TestRunProfileKind.Debug)!;

    await debugProfile.runHandler({ include: [{ label: 'TestCustomerInsert' }] }, {});

    const calls = (vscode as any).debug.startDebuggingCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].config.testFilter, 'TestCustomerInsert');
    assert.strictEqual(calls[0].config.type, 'alchemist');

    (vscode as any).workspace.workspaceFolders = [];
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/debugLaunch.test.js`
Expected: PASS — 6 passing. If `TestController`'s constructor requires more arguments than `getEngine`, pass the same stubs the existing `test/suite/testController.streaming.test.ts` uses.

- [ ] **Step 8: Run the full unit suite**

Run: `npm run test:unit && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/debug/debugLaunch.ts src/testing/testController.ts test/suite/debugLaunch.test.ts
git commit -m "feat(testing): Debug run profile launching a DAP session per test"
```

---

### Task 9: Fixtures, integration coverage, and docs

**Files:**
- Modify: `test/fixtures/test-al-runner-output.json` (add `statements[]` to its coverage)
- Create: `test/fixtures/v2-summary-statements.json`
- Modify: `test/integration/decorationRender.itest.ts`
- Modify: `README.md` (requirements + debugging section)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: no new source API.

- [ ] **Step 1: Write the failing integration test**

Create `test/fixtures/v2-summary-statements.json`:

```json
{
  "type": "summary",
  "exitCode": 0,
  "passed": 1,
  "failed": 0,
  "errors": 0,
  "total": 1,
  "protocolVersion": 2,
  "coverage": [
    {
      "file": "src/Foo.al",
      "lines": [{ "line": 12, "hits": 10 }, { "line": 13, "hits": 1 }],
      "totalStatements": 3,
      "hitStatements": 3,
      "statements": [
        { "id": 0, "scope": "DoWork", "line": 12, "column": 5, "endLine": 12, "endColumn": 24, "hits": 10 },
        { "id": 1, "scope": "DoWork", "line": 12, "column": 26, "endLine": 12, "endColumn": 40, "hits": 10 },
        { "id": 2, "scope": "DoWork", "line": 13, "column": 5, "endLine": 13, "endColumn": 30, "hits": 1 }
      ]
    }
  ]
}
```

Append to `test/integration/decorationRender.itest.ts` a suite that loads the fixture, runs it through `DecorationManager.applyResults` against a real `TextDocument`, and asserts:

```ts
suite('statement table — end to end', () => {
  test('captures land on their exact lines and ×N appears on the repeated line', async () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'v2-summary-statements.json'), 'utf8'),
    );
    const workspacePath = path.resolve(__dirname, '..', 'fixtures');
    const filePath = path.join(workspacePath, 'src', 'Foo.al');

    const document = await vscode.workspace.openTextDocument({
      language: 'al',
      content: Array.from({ length: 20 }, (_, i) => `    // line ${i + 1}`).join('\n'),
    });
    const editor = await vscode.window.showTextDocument(document);

    const dm = new DecorationManager(path.resolve(__dirname, '..', '..'));
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
    const document = await vscode.workspace.openTextDocument({ language: 'al', content: '// one line\n' });
    const editor = await vscode.window.showTextDocument(document);

    const dm = new DecorationManager(path.resolve(__dirname, '..', '..'));
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
```

- [ ] **Step 2: Run the integration suite to verify the new tests fail or pass honestly**

Run: `npm run test:integration`
Expected: the two new tests PASS if Tasks 1-3 are complete. If either fails, fix the source — not the assertion.

- [ ] **Step 3: Update the shared fixture**

In `test/fixtures/test-al-runner-output.json`, add a `statements` array to its coverage entry covering the same scopes and statement ids its `capturedValues` reference, so parity tests exercise the new placement path. Keep every existing field — other suites read them.

- [ ] **Step 4: Run every suite**

Run: `npm run test:unit && npm run test:integration && npm run test:parity`
Expected: PASS. Parity failures mean a capture's `(scope, id)` has no matching statement record in the fixture — add the missing record.

- [ ] **Step 5: Update user-facing docs**

In `README.md`: state that AL.Runner **2.7.0 or newer** is required, describe the `×N` hit counts, and add a short "Debugging" section covering the Test Explorer's Debug action, the `ALchemist: Debug AL Tests` launch configuration, and the stepping caveat.

In `CHANGELOG.md`, add an entry under a new unreleased heading:

```markdown
## [Unreleased]

### Added
- Inline execution counts (`×N`) on lines that ran more than once, from AL.Runner 2.7.0's per-statement coverage table.
- Per-statement hover breakdown showing each statement's column span and its own hit count.
- Breakpoint debugging of AL tests via AL.Runner's Debug Adapter (`--dap stdio`) — Debug from the Test Explorer or the `ALchemist: Debug AL Tests` launch configuration. Stepping is not yet implemented upstream and behaves like continue.

### Changed
- Captured values are now placed at exact statement positions from the coverage table. The previous heuristic (statement id as an index into covered lines) is gone; it mis-placed values on multi-statement lines.
- Native coverage details now carry real statement ranges and per-statement counts instead of column-0 positions with line-summed hits.
- AL.Runner 2.7.0 is now the minimum supported version.
```

- [ ] **Step 6: Commit**

```bash
git add test/fixtures README.md CHANGELOG.md test/integration/decorationRender.itest.ts
git commit -m "test: statement-table fixtures and end-to-end coverage; docs for hit counts and debugging"
```

---

## Self-Review

**Spec coverage:** §1 → Task 1. §2 → Task 2. §3 → Tasks 3 (decorations) and 4 (hover). §4 → Task 5. §5 → Task 6. §6 → Tasks 7 (factory, contributions) and 8 (Debug profile, stepping caveat). §7 → tests inside every task plus Task 9's fixtures and integration coverage.

**Type consistency:** `StatementRecord` fields (`id`, `scope`, `line`, `column`, `endLine?`, `endColumn?`, `hits`) are used identically in Tasks 1-5 and 9. `CoverageModel.fromFileCoverage` / `forFile` / `hasStatements`, `FileStatementIndex.lookup` / `statementsOnLine` / `lineRollup`, `RenderStats.statementsAvailable`, `DecorationManager.getCoverageModel`, `ALCHEMIST_DEBUG_TYPE`, `buildDebugConfiguration`, and `resolveBundleDir` keep one spelling throughout.

**Known open item:** Task 7 Step 0 resolves AL.Runner 2.7.0's launch-config expectations from upstream sources before any code is written. `testFilter` is the plan's name for single-test selection; if upstream names it differently, rename it in `package.json`, `buildDebugConfiguration`, and the two tests that assert it.
