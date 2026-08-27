# Statement Table Consumption + DAP Debugging — Design

**Date:** 2026-08-27
**Status:** Approved (design review in chat, all sections)
**Context:** AL.Runner 2.7.0 (upstream, nuget.org `msdyn365bc.al.runner`) shipped two things ALchemist asked for in [issue #1](https://github.com/SShadowS/ALchemist/issues/1):

1. A per-statement coverage table — `coverage[].statements[]` in the protocol-v2 `Summary`, shaped exactly as ALchemist specified: stable per-scope statement ids in the same id-space as `capturedValues[].statementId`, 1-based positions with columns, true per-statement hit counts.
2. A Debug Adapter Protocol server with a stdio transport: `al-runner --dap stdio <bundleDir>` (two tokens, not `--dap-stdio`). stdout carries only DAP wire format; logging goes to stderr. Breakpoints, pause, stack, and locals work; stepping (`next`/`stepIn`/`stepOut`) currently behaves like `continue` upstream.

Not in scope (upstream not built yet): per-execution captures (StefanMaron/BusinessCentral.AL.Runner#2074) and iteration segmentation (#2056). ALchemist's iteration feature continues to run on the fork's `iterations[]` output until those land.

## Decisions made during design review

- **Delete the placement heuristic, require 2.7.0.** No fallback path for runners without `statements[]`. `MIN_AL_RUNNER_VERSION` becomes `2.7.0` and the (previously TODO) version warning gets wired. The fork loses inline capture placement until it rebases; iteration stepping is unaffected (separate `iterations[]` data).
- **Hit counts must be visible in the plain editor.** Not gated behind VS Code's Test/Coverage UI modes. Custom decorations carry the feature; the native coverage API is fed as a bonus for users who use coverage runs.
- **Debug entry: both.** A Debug run profile on the TestController (Debug-click a test → breakpoints hit) and a `debuggers` contribution with launch.json support.
- **Model approach: dedicated CoverageModel module** (approach B), not minimal splicing. `decorations.ts` (749 lines) currently owns placement math it shouldn't; a single statement-index module becomes the source of truth for placement, hit counts, hover detail, and native coverage.

## §1 Protocol + model

`src/execution/protocolV2Types.ts`:

```ts
export interface StatementRecord {
  id: number;          // per-scope statement id; same id-space as CapturedValue.statementId
  scope: string;       // same value as CapturedValue.scopeName
  line: number;        // 1-based statement start
  column: number;      // 1-based
  endLine?: number;
  endColumn?: number;
  hits: number;        // true per-statement count, aggregated across the run
}

export interface FileCoverage {
  // ...existing fields...
  statements?: StatementRecord[];   // absent on runners < 2.7.0
}
```

New module `src/execution/coverageModel.ts`:

- Constructed once per run from `Summary.coverage[]`.
- Per-file indexes:
  - `byScope: Map<scopeKey, Map<id, StatementRecord>>` — capture placement lookup. Scope keys are compared case-insensitively (AL identifiers are case-insensitive; see the G8 casing fix precedent).
  - `byLine: Map<line, StatementRecord[]>` — hit-count decorations and hover breakdown.
- Owns file-path normalization: the three producer shapes (workspace-relative forward-slash, absolute forward-slash, absolute native) normalized to one lookup key. The logic currently in `DecorationManager.findCoverageForFile` moves here; decorations call the model instead.
- Public surface (approximate): `forFile(fsPath): FileStatementIndex | undefined`, `FileStatementIndex.lookup(scope, id): StatementRecord | undefined`, `FileStatementIndex.statementsOnLine(line): StatementRecord[]`, `FileStatementIndex.lineRollup(): Map<line, hits>`.

## §2 Capture placement

- Delete the index-into-covered-lines heuristic (`decorations.ts` ~550–567: `statementId` used as an index into covered lines sorted by line number).
- Placement becomes: `model.forFile(file).lookup(cv.scopeName, cv.statementId)` → decorate at `record.line`.
- A capture whose `(scope, id)` is missing from the table is **skipped**, never guessed: one `console.warn` diagnostic naming the scope/id/file (mirrors the existing lossy-translation warning pattern), no decoration.
- Grouping/ordering semantics of captures (execution-ordered series per `(statementId, variable)`, `formatCaptureGroup` rendering) are unchanged — only the line lookup changes.

## §3 Hit counts (the visible feature)

- New `hitCountDecorationType` in `DecorationManager`: subtle after-text `×N`, themed via a new `alchemist.hitCountForeground` theme color (default dimmed, italic, same margin conventions as captured-value decorations).
- Rendered for every line where `max(statement.hits on that line) > 1`. `N` = that max (a line's most-executed statement, not the sum — the sum double-counts multi-statement lines).
- Always applied on `applyResults` after any test run — visible in the plain editor, no Test/Coverage mode required. Gated by existing `alchemist.showHitCounts` (default true); its `package.json` description drops the "requires AL.Runner API — Phase 2" suffix.
- Hover (`CoverageHoverProvider`): on a covered line, per-statement breakdown when the line has >1 statement or any statement has hits > 1: `col 5–24: 10×`, `col 26–40: 1×`. The provider's `lineCoverageMap` source is replaced by CoverageModel lookups; the map itself is deleted from `DecorationManager`.
- Ordering with captured-value decorations on the same line: hit-count text renders after the capture text (two decoration types stack in registration order; verify against the VS Code decoration API and pin with an integration test).

## §4 Native coverage (bonus path)

`src/execution/coverageAdapter.ts`:

- When `statements[]` present: build one `vscode.StatementCoverage` per statement with a real `Range(line-1, column-1, (endLine ?? line)-1, (endColumn ?? column)-1)` and the true per-statement count. `TestCoverageCount` keeps using the runner's `hitStatements`/`totalStatements`.
- The legacy `lines[]`-based detail construction is deleted (2.7.0 required). `lines[]` remains in the protocol type for the summary totals but is no longer the detail source; line rollups anywhere in ALchemist derive from CoverageModel.

## §5 Version gate

- `MIN_AL_RUNNER_VERSION = '2.7.0'` in `alRunnerManager.ts`.
- `ensureInstalled` resolves the runner, then runs `<runner> --version`, parses semver, and warns once per session when below minimum: warning message names the found version and the minimum, offers "Update" (existing `dotnet tool update` path) for tool-managed installs; custom-path installs get the message without the button.
- Runtime defense: a v2 `Summary` whose coverage entries lack `statements[]` → hit counts and inline captures are absent for that run; one output-channel line: "AL.Runner <version?> did not send statement records — inline values and hit counts require ≥ 2.7.0." No fallback rendering.

## §6 DAP integration

New `src/debug/` module:

- `debugAdapterFactory.ts`: `vscode.DebugAdapterDescriptorFactory` registered for debug type `alchemist`. `createDebugAdapterDescriptor` resolves the runner via the existing `AlRunnerManager` (`ensureInstalled`) and returns `new vscode.DebugAdapterExecutable(runnerPath, ['--dap', 'stdio', bundleDir])`. stderr from the adapter process is surfaced to the ALchemist output channel.
- `package.json` contributions:
  - `debuggers`: type `alchemist`, label "ALchemist (AL.Runner)", `languages: ["al"]`, `configurationAttributes` for the launch schema, `initialConfigurations`, and a `configurationSnippets` entry.
  - `breakpoints`: `[{ "language": "al" }]`.
- TestController: add a second run profile, `kind: vscode.TestRunProfileKind.Debug`. Debug-click on a test → build a launch config for that test → `vscode.debug.startDebugging(folder, config)`.
- **Resolved during implementation, not guessed:** the exact launch-config schema 2.7.0 expects — what `bundleDir` is (compiled bundle vs. project dir), and whether/how a single test method can be selected for the debug session. First implementation step reads upstream docs / `--dap` handling in the 2.7.0 source. If single-test selection is unsupported upstream, the Debug profile launches the full session (breakpoints do the filtering) and an upstream issue is filed.
- Stepping caveat: first debug session per VS Code session shows one info toast — "AL.Runner 2.7.0: stepping acts as continue; breakpoints, pause, stack, and variables are fully functional."

## §7 Testing (TDD throughout)

Unit:

- CoverageModel: construction from fixture `Summary`, per-scope lookup (case-insensitive scope keys), `byLine` grouping, path normalization across all three producer shapes, absent-`statements[]` handling.
- Capture placement: exact placement on multi-statement lines and around uncovered statements — the two cases the deleted heuristic got wrong; missing `(scope, id)` → skipped with warning.
- Hit-count rendering: `×N` on max>1 lines only; N = max not sum; setting off → none.
- Version gate: semver comparison, warn-once, custom-path variant.
- coverageAdapter: Range construction with/without end positions, per-statement counts.

Integration:

- Fixture with `statements[]` through the full decorations pipeline (extend `test-al-runner-output.json` + a new v2 fixture; parity tests updated).
- Decoration stacking order (capture text + hit-count text on one line).
- DAP factory: descriptor args exactly `['--dap', 'stdio', <bundleDir>]`; runner resolution failure surfaces an actionable error.
- Debug run profile: launch-config generation for a selected test.

Regression:

- v2 fixture without `statements[]` → no captures rendered, no hit counts, no crash, output-channel notice present.
- Old v1 path (`parseJsonOutput`) untouched: iteration fixtures still drive the stepping feature.
