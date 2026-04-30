# Changelog

## 0.5.9 (2026-04-30)

### Restored

- **Iteration stepping now updates inline captured values.** v0.5.7 fixed which editor the stepping flow paints into; v0.5.8 fixed cross-platform path normalization in tests. Neither was enough to make stepping show per-iteration values: `step.capturedValues` was always empty in the v2 wire format because `IterationTracker.FinalizeIteration` (in AL.Runner) sampled the global `ValueCapture.GetCaptures()` aggregate (only populated when `ValueCapture.Enable()` had been called — the legacy v1 `--output-json` path) instead of the per-test scope (`TestExecutionScope.Current.CapturedValues`, which the v2 streaming path always populates). The same architectural bug also affected `step.messages` (parallel `MessageCapture.GetMessages()` aggregate). User-visible symptom: stepping to iteration N updated the indicator but the inline `j = ?` text disappeared because there was nothing to render. The runner now reads from the active scope; per-iteration captures and messages populate end-to-end on both the v1 `--output-json` and v2 `--server` paths (they share the same `IterationTracker.FinalizeIteration` code).

### Tests

- Two new `@vscode/test-electron` integration tests (no mocks, real APIs) drive the iteration-stepping flow through real VS Code APIs:
  - `iterationStepping.itest.ts` — drives `applyIterationView` against a real opened editor and asserts inline contentText.
  - `iterationStepperDecoration.itest.ts` — drives the stepper indicator through `visibleTextEditors`.
  - Every VS Code API call is annotated with its canonical documentation URL (https://code.visualstudio.com/api/...) so future engineers can validate behavior against the spec without guessing.
- Smoke test extended with per-step capture assertions so the symptom can't recur silently.
- Parity suite tightened: per-step variable names are now part of the v1↔v2 projection, so future iteration-related drops surface as parity diffs.

### Cross-repo dependency

Requires AL.Runner fork at the Plan E4 Group A cut. The runner-side fix sits in `AlRunner/Runtime/IterationTracker.cs` (FinalizeIteration reads from `TestExecutionScope.Current.CapturedValues` and `.Messages` instead of the global aggregates). Plan documents at `docs/superpowers/plans/2026-04-30-plan-e4-per-iteration-captures.md`. Companion gap-tracking doc at `Gaps.md` in the AL.Runner fork.

### Known gaps (Gaps.md tracks)

The same audit identified seven additional suspected gaps in AL.Runner that may surface as future symptoms — loop-variable single-capture, cancellation mid-iteration, nested loop attribution, zero-iteration emission, cache-hit iteration leakage, schema/emission edge cases, and variable-name casing. Documented in the AL.Runner fork's `Gaps.md` for future planning.

## 0.5.8 (2026-04-30)

### Fixes

- **`pathsEqual` cross-platform correctness.** The slash-tolerant comparison in `iterationViewSync.ts` and the duplicate one in `iterationCodeLensProvider.ts` relied on `path.normalize` to convert backslashes to forward slashes. That works on Windows (the runtime target) but fails on POSIX, where `path.normalize` treats backslashes as literal path characters. The CI test suite runs on Linux and three Windows-style fixture paths in `iterationViewSync.test.ts` failed there. Manually normalize backslashes to forward slashes BEFORE `path.normalize` so the comparison works on both platforms. Also consolidates the two `pathsEqual` definitions — `iterationCodeLensProvider.ts` now imports the canonical version from `iterationViewSync.ts` (DRY).

### Internal

- v0.5.7 was tagged but the release workflow's Linux CI test run failed on the cross-platform issue above, so v0.5.7 was never published to the Marketplace. v0.5.8 supersedes it. The v0.5.7 git tag remains as a marker of the failed attempt.

## 0.5.7 (2026-04-30, never published)

### Fixes

- **Iteration stepping now updates inline values when dispatched from the Iteration Table panel.** When the user clicked a row in the table webview, `vscode.window.activeTextEditor` was undefined or pointing at an unrelated text editor (the panel is a webview, not a text editor). `onIterationChanged` and `IterationStepperDecoration.refresh` both early-returned on the missing active editor, leaving inline values frozen at the aggregate (last) value while the status bar correctly showed the new iteration. The flow now selects the correct editor by matching `loop.sourceFile` against `vscode.window.visibleTextEditors`, so stepping works regardless of which UI surface (CodeLens, keyboard, webview) dispatched it. Stepper decoration similarly refreshes every visible editor that contains a tracked loop, including in split-pane layouts.

### Tests

- New `iterationViewSync` helper module + 8 unit tests pinning path-equality and editor-selection semantics. The helper is the single source of truth for "which editor does this loop's data belong to?" so the same selector applies everywhere.
- New `IterationStepperDecoration — refresh paints all visible editors` unit test simulates the failure mode (no active editor + 2 visible editors in different files) and asserts decoration calls land on the matching editor and clear on the non-matching one.

### Code-path audit

Every `vscode.window.activeTextEditor` read in `src/` was reviewed. The remaining usages are correct: user-initiated commands (runNow, scratch ops, runWiderScope), save handler (the saved file IS the active editor by definition), result rendering (the user's saved file). Only the iteration-stepping flow had the cross-surface invariant problem.

## 0.5.6 (2026-04-30)

### Fixes

- **`IterationTablePanel` no longer crashes on v2 iteration data with omitted fields.** Plan E3 Group C tightened the AL.Runner v2 wire format to use `WhenWritingNull` serialization — empty `messages`, `linesExecuted`, and `capturedValues` arrays are now omitted from the JSON entirely rather than emitted as `null` or `[]`. `IterationStore.load` passed those undefined values straight through to `IterationStep`, and downstream `IterationTablePanel.updateContent` then crashed reading `step.messages.length`. Coerce all three fields to safe defaults at store load time. The v1 wire format always emitted the arrays, so existing v1 paths are unaffected.

### Tests

- New unit test asserts `IterationStore.load` tolerates the sparse-step shape (only `iteration` field present, all other arrays undefined). Reproduces the exact `TypeError: Cannot read properties of undefined (reading 'map')` that crashed the table panel in user runtime.

## 0.5.5 (2026-04-29)

### Restored from v0.3.0

- **Iteration stepper / table view.** AL.Runner v2's wire format silently dropped the `iterations` summary field when Plan E1/E2 modernized the protocol — `Pipeline.cs` already collected the data for the v1 `--output-json` path, but `Server.cs` never plumbed it through. ALchemist's iteration UI quietly degraded to no-op as a result. Plan E3 Group B (`AL.Runner` upstream) emits the field on the v2 summary with the same shape v1 produced, and Plan E3 Group D (consumer) pins the contract. Iteration Codelens, navigation keybindings, and table panel work again.

- **Compact loop captured-value rendering.** Inline display of loop iterations had collapsed to the last value (`myInt = 56`). Restored the v0.3.0 `myInt = 2 ‥ 56 (×10)` distribution form. 2-3 distinct values join with pipe (`a | b | c`); 4+ use compact-form. Hover continues to expose the full series, capped at 50 captures with a `_N omitted_` suffix to keep the hover legible on real workloads.

### Fixes (cross-repo)

- **AL.Runner emits absolute paths regardless of cwd.** The fork's `Pipeline.cs` previously emitted `Path.GetRelativePath(Directory.GetCurrentDirectory(), file)` for source-file paths. When ALchemist spawned the runner from VS Code's extension host, the cwd was VS Code's install dir and the resulting paths walked up several levels (`../../../../Documents/AL/<...>`). ALchemist's `path.resolve(workspacePath, sourceFile)` then walked to the wrong absolute path and silently dropped every capture. The runner now emits `Path.GetFullPath(file).Replace('\\', '/')`. The v0.5.4 `cwd`-pin workaround in `extension.ts` is removed; `ServerProcess.cwd` remains as a defensive opt-in for diagnostics.

- **`IterationTracker.Reset()` returns the tracker to a known disabled ground state** — defensive contract change. The injection in `Pipeline.cs` is unconditional now (mirrors the established `ValueCaptureInjector` pattern); cached assemblies serve both `iterationTracking=true` and `=false` requests without recompilation.

### Schema

- `protocol-v2.schema.json` documents `coverage[].file` and `capturedValues[].alSourceFile` as absolute fwd-slash paths, defines the new `IterationLoop` type, and adds `iterations` (array, omitted when not requested) to `Summary`. New definitions added for the protocol's `Ready` / `ShutdownAck` handshake lines so AJV validation covers a real runtime session. Sample at `docs/protocol-v2-samples/runtests-iterations.ndjson` captures a known-good wire payload.

### Tests

- New cross-protocol parity suite (`npm run test:parity`) drives a single AL fixture through both v1 (`--output-json`) and v2 (`--server`) producers and asserts UI-relevant equivalence on captures, iterations, coverage, and test statuses. Future protocol changes that drop or rename fields surface here, not in the user's editor weeks later. `npm test` chains unit → integration → parity. Suite skips cleanly when the fork binary or fixture isn't present.
- Smoke test extended to assert iterations populate end-to-end (`iterationCount === 10`, `steps.length === 10` for ALProject4's `for i := 1 to 10` loop) and to assert multi-valued captures arrive at the DecorationManager so the dedup regression can't recur silently.
- Unit tests pin `formatCaptureGroup`'s 0/1/2-3/4+ branches and `applyInlineCapturedValues`'s grouping behavior with concrete content-text regex assertions.

### Why this took several releases

A modernization PR (Plan E1/E2) shipped without a feature-parity audit against the prior release. Subsequent releases (v0.5.1 through v0.5.4) chased visible symptoms — captures missing, paths mismatched, gutter not painting — without surfacing the underlying spec gap. Plan E3 names that gap and locks parity into a test suite so it can't recur silently. The implementation plan is checked in at `docs/superpowers/plans/2026-04-29-plan-e3-protocol-v2-parity.md`.

## 0.5.4 (2026-04-29)

### Fixes

- **Inline captures and gutter coverage now match against absolute paths** (the wire shape AL.Runner `--server` actually emits). `findCoverageForFile` previously matched only relative paths (`entryPath === relativePath`) or a suffix-endsWith comparison that compared backslashes against forward slashes — so absolute fwd-slash paths from `--server` (e.g. `C:/Users/.../CU1.al`) fell through both branches and the function returned undefined. Every render path that uses `findCoverageForFile` (inline captures, gutter SVGs, dim-uncovered) silently no-op'd on v2 results in the user's runtime, even though earlier layer tests passed (they used relative-path fixtures that masked the bug). The matcher now resolves both sides to absolute, normalized, lowercase paths and compares.

### Observability

- The output channel header now stamps the running extension version and protocol version on every result: `━━━ ALchemist v0.5.4 · protocol v2 ━━━━━━...`. A one-time `ALchemist v0.5.4 loaded` line also lands when the channel is created. Saves "is this build picking up my fix?" debug cycles.

### Tests

- Added unit test `v2 applyResults with ABSOLUTE-path coverage + captures (server emits absolute paths) renders inline captures` that uses absolute fwd-slash paths matching the wire shape from `scripts/drive-server.ts`.
- Added integration test through real VS Code APIs (`@vscode/test-electron`) `v2 result with ABSOLUTE-path coverage entries (real --server wire shape) renders inline captures` — same shape, real `Document.lineAt`, real path resolution.
- Added end-to-end smoke test `test/smoke/runtimeSmoke.smoke.ts` that activates the real extension against the local ALProject4 + AL.Runner fork build, drives the engine, and asserts captures + coverageV2 + decoration manager state. Runs via `npm run test:smoke`. Skips when local paths missing.
- Added test seam in `extension.activate()` (`TestHooks` returned only when `ALCHEMIST_TEST_HOOKS=1`) so smoke tests can introspect runtime state without exposing internals to production consumers.

### Why we missed this

Layer tests had been written against fixtures with relative paths (`'src/Foo.al'`). The `--server` protocol emits absolute fwd-slash paths. `findCoverageForFile`'s relative-path branch matched the fixtures; the absolute-path branch (which would have caught this) didn't exist because the test fixtures never exercised it. The new smoke test runs the real engine against the real project, so the next time the wire shape diverges from what consumers expect, it surfaces here.

## 0.5.3 (2026-04-29)

### Fixes

- **Inline captured-value decorations now actually render on v2 results.** v0.5.2 fixed the per-capture `alSourceFile` so the file-path filter in `DecorationManager.applyInlineCapturedValues` matched correctly. But the same method ALSO needed coverage line data to map each capture's `statementId` → editor line — and `applyResults` was passing `result.coverage` (the legacy v1 cobertura-shape array, which is empty for v2 results because v2 routes coverage to `result.coverageV2` instead). Empty coverage → early return → no decorations. The fix translates `coverageV2` → v1 shape on-the-fly inside `applyResults` and passes that to `applyInlineCapturedValues`.

### Tests

- Added regression test `v2 applyResults with coverageV2 + per-capture alSourceFile renders inline captures (regression for the bug we shipped)` that drives `applyResults` with realistic v2 data and asserts `setDecorations` fires on the captured-value decoration type with non-empty ranges. This closes a previously-uncovered seam between layer tests (engine flatten, captureValueAdapter, per-test scope) and end-to-end rendering.

### Why we missed this

Tests existed for each individual layer (engine output shape, capture translation, per-test scope, coverage adapter) but no test exercised the seam where `applyResults` hands a v2 result to `applyInlineCapturedValues`. The implicit assumption — "all layers correct ⇒ rendering correct" — broke at the data-routing seam where v1's `coverage` field stayed empty for v2 callers. The new regression test closes that gap.

## 0.5.2 (2026-04-29)

### Fixes

- **Inline captured-value decorations now render on save-triggered runs.** v0.5.1 threaded `alSourceFile` from the test event into `v2ToV1Captured`, but that field is set only on FAILING tests (via stack-walking). Passing tests left it undefined; the fallback substituted `objectName` (e.g. `"CU1"`) which never matched the editor's file path, so DecorationManager silently dropped every capture. Requires the AL.Runner fork branch `feat/alchemist-protocol-v1` at commit `f2d2bb3` or later — the runner now emits a per-capture `alSourceFile` resolved via `SourceFileMapper.GetFile(objectName)`. The translator prefers the capture's own `alSourceFile`, falls back to the event's, and only as a last resort uses the lossy `objectName`.

### Internal

- `protocolV2Types.CapturedValue` gains optional `alSourceFile?: string`.
- `v2ToV1Captured(v2, fallbackAlSourceFile?)` now resolves `sourceFile` in priority order: per-capture → fallback → objectName.

### Requires

- AL.Runner fork branch `feat/alchemist-protocol-v1` at `f2d2bb3` or later. Older fork builds work but lose inline captured-value rendering on passing tests; failing-test rendering continues to work via the stack-walked `alSourceFile`.

## 0.5.1 (2026-04-29)

### Fixes (closing v0.5.0 known limitations)

- **Save-triggered runs now stream.** Save-on-save and Run Wider Scope both go through `TestController.runTestsForRequest`, gaining live Test Explorer updates, native coverage rendering, and clickable stack frames previously available only on Test-Explorer-initiated runs.
- **Cursor-driven active test.** Moving the cursor into a `[Test]` proc sets that test as the active one in DecorationManager; inline captured-value decorations now show only that test's values. Replaces the v0.5.0 Option A "most-recent streaming test wins" heuristic.
- **Captured values render correctly on the v2 path.** `v2ToV1Captured` now threads each test event's `alSourceFile` into the v1 `sourceFile` slot, so DecorationManager's inline-render file filter matches the editor's AL file path. The previous lossy translation (`objectName → sourceFile`) silently dropped captures from inline rendering.
- **Multi-app `testItems` collision risk eliminated.** The bare-name `testItems` map is gone; TestItem resolution now uses compound `testItemsById` keys scoped to the running app via a transient `currentAppId` field set in the multi-app loop. Multi-app workspaces with same-named tests across apps no longer cross-fire.

### Internal

- New `src/testing/testFinder.ts` — pure helper for cursor → TestItem resolution.
- `TestController.runTestsForRequest(request, token)` — new public API for programmatic runs.
- `TestController.getTestItemsById()` / `getAppTestItem(appId)` — read-only accessors used by the cursor-driven selector and the save-router request builder.
- `v2ToV1Captured(v2, alSourceFile?)` — second arg threads the AL file path; legacy single-arg behavior preserved for backward compat.
- DecorationManager logs a one-time per-session warning when it observes lossy non-`.al` `sourceFile` values (helps diagnose future translation regressions).
- Stale `T9 will…` / `T10 will…` planning placeholders replaced with accurate post-E2.1 documentation.

### Migration

No user action required. v0.5.0 settings continue to work unchanged.

## 0.5.0 (2026-04-29)

### Features

- **AL.Runner protocol v2 streaming** — Test Explorer pass/fail marks now update **as each test completes**, not after the whole run finishes. Live progress via per-test events from a streaming NDJSON consumer (requires AL.Runner with protocol v2; older runners fall back transparently to v1 single-response mode).
- **Clickable stack frames on failures** — Test failures in Test Results now carry structured stack frames (`vscode.TestMessageStackFrame[]`). Each user-code `.al` frame is clickable and jumps directly to the failing line. BC runtime / mock frames are dimmed via DAP-style `presentationHint`.
- **Native VS Code coverage rendering** — Green/red gutter icons + Coverage View panel are now powered by `vscode.TestRun.addCoverage()`. The Run with Coverage profile lights up automatically on protocol v2.
- **Per-test captured-value scoping** — `DecorationManager` now stores values per test. The most-recent streaming test becomes the active test, so its captures are what shows in the editor at the end of a run (Option A heuristic — see Known limitations for the cursor-driven follow-up).
- **Mid-run cancellation** — Click Stop in Test Explorer mid-run; tests-in-flight finish cooperatively, remaining tests are marked skipped, and the AL.Runner daemon stays warm for the next request.
- **Per-test `testFilter`** — Right-click → Run on a single test now narrows the actual execution rather than re-running every test in the codeunit.
- **Status bar protocol version** — Hover the AL.Runner status bar item to see whether you're on protocol v1 (upgrade for live updates) or v2.

### Internal

- New `coverageAdapter` translates AL.Runner `FileCoverage[]` into `vscode.FileCoverage[]` (1-indexed → 0-indexed Position; statement detail returned via `loadDetailedCoverage` callback through a `WeakMap`).
- New `protocolV2Types.ts` with `TestEvent` / `Summary` / `Ack` / `Progress` matching the cross-repo `protocol-v2.schema.json`.
- `ServerProcess.send(payload, onEvent?)` now consumes multi-line streaming responses; the v1 fallback still works on older runners.
- `ServerProcess.cancel()` is a fire-and-forget that fires `{"command":"cancel"}\n` on stdin during in-flight runtests.
- `ServerExecutionEngine` forwards `testFilter` / `coverage` / `cobertura` request fields and surfaces `cancelled` / `protocolVersion` / `coverageV2` on `ExecutionResult`.
- `AlchemistTestController.runTests` is rewritten as a streaming consumer: progressive `run.passed` / `run.failed`, `run.addCoverage` after the final summary, multi-app loop breaks on cancellation, unreported tests marked skipped.
- VS Code engine bumped to `^1.88.0` (for `FileCoverage` / `StatementCoverage` APIs).

### Requires

- **AL.Runner with protocol v2 enabled** for streaming features (currently the fork branch `feat/alchemist-protocol-v1`; upstream PRs in flight). Older AL.Runner installations continue to work transparently in v1 mode (no live streaming, no native coverage UI, no clickable stack frames).

### Known limitations (deferred to a follow-up release)

- **Save-triggered runs use the v1 result-application path.** Live Test Explorer streaming, clickable stack frames, and native coverage UI activate on Test-Explorer-initiated runs only. Save-triggered runs continue to use the synchronous v1 result application — the test results are correct, but no live progress is reported and the inline-render filter on captured values still uses the legacy `sourceFile` path-match.
- **Per-test capturedValues active selection is heuristic.** The most-recent streaming test becomes the active test (Option A); cursor-driven selection — so the displayed captures track which `[Test]` proc your cursor is in via `onDidChangeTextEditorSelection` — lands in a follow-up release.

## 0.4.0 (2026-04-25)

### Features

- **Multi-app workspace support** — ALchemist discovers AL apps (folders with `app.json`) across every workspace folder, not just the first. Works correctly on `.code-workspace` multi-root setups.
- **Test Explorer grouped by app** — Tests appear as App → Codeunit → Procedure. Multiple apps with same-named codeunits no longer collide.
- **Dependency-aware save routing** — Saving a file in a main app runs tests in every app that transitively depends on it (via `app.json` `dependencies`). Save in a test app runs only that app's tests.
- **Scratch-project multi-app selection** — Project-aware scratch files (`//alchemist: project`) in multi-app workspaces prompt for an AL app context on first use; choice persists per scratch file. Explicit override via `alchemist.scratchProjectAppId` setting.
- **Precision-tier test routing** — Tree-sitter-al-backed cross-file symbol/reference index narrows save-triggered test runs to apps containing affected tests. Status bar shows current tier (regex / precision / fallback) and scope.
- **AL.Runner --server execution** — All AL.Runner invocations now go through a long-lived JSON-RPC daemon with per-file rewrite cache + syntax-tree cache. Warm test runs significantly faster than cold one-shot spawns.
- **Confidence-aware fallback** — When the symbol index cannot safely answer (parse errors in saved file, or files awaiting reparse), routing drops to broad-scope fallback automatically. Status bar tooltip surfaces the reason.
- **`Ctrl+Shift+A Shift+R` — Run Wider Scope** — Forces fallback-tier runs for the active file regardless of router confidence.
- **Indexing progress** — Status bar shows `regex (indexing N/M)` during initial workspace scan.

### Fixes

- **Codeunit regex accepts unquoted names** — Discovery previously failed on `codeunit 50000 Name` (bare identifier); now accepts both quoted and unquoted forms.
- **Combined `[Test, HandlerFunctions(...)]` attributes detected** — Tree-sitter grammar handles every AL attribute form by construction.
- **Fallback retry gated on AL compile error** — `executor.ts` previously retried every non-zero exit. Now retries only on exit code 3 with AL.Runner 1.0.12+, or exit 1 with zero tests captured (legacy compatibility).
- **Removed `workspaceFolders[0]` assumption** — Every call site that implicitly assumed a single workspace folder now resolves the owning AL app via `WorkspaceModel`.
- **One-shot AL.Runner spawns eliminated** — Legacy `Executor` class deleted; `ExecutionEngine` + `ServerProcess` fully supersede it.

### Architecture

- 5-layer precision stack (`ParseCache` → `SymbolExtractor` → `SymbolIndex` → `TestRouter` → `ExecutionEngine`) with strict unidirectional dependencies. L4 and L5 are interfaces — when AL.Runner ships native partial-execution, only L4's implementation needs to swap.

### Requires

- AL.Runner **1.0.12+** — required for `--server` mode and differentiated exit codes.

## 0.3.0 (2026-04-17)

### Features

- **Iteration navigation (time-travel)** — Step through loop iterations forward/backward to see how values evolved. Keybindings: `Ctrl+Shift+A →/←` (next/prev), `Home/End` (first/last), `A` (show all), `T` (table panel)
- **CodeLens iteration stepper** — Clickable stepper above every loop shows current iteration and controls
- **Clickable status bar stepper** — Status bar shows active iteration and navigates on click
- **Interactive hover navigation** — Hover loop values to step through iterations via command links
- **WebView iteration table** — Dedicated panel lists all iterations with variables; keyboard nav, sticky headers, accessibility
- **Value change flash** — Values that changed between iterations briefly highlight
- **Nested loop support** — Independent stepping per loop with cursor-aware commands
- **Theme-aware decorations** — Inline colors adapt to light/dark/high-contrast themes via customizable VS Code theme colors (`alchemist.capturedValueForeground`, `alchemist.messageForeground`, `alchemist.errorForeground`, `alchemist.changedValueBackground`)
- **Source file filtering** — Captured values and CodeLens scoped to the active document when multi-file projects run

### Fixes

- **Iteration-aware hover** — Hover shows values for the selected iteration, not aggregate
- **Decoration stepper fallback** — Scratch files without CodeLens still get inline stepper
- **Scoped loop decorations** — Inline values only render within the active loop's line range
- **Debounced decoration refresh** — Reduces flicker when editing
- **Default to show-all after run** — New runs reset iteration view instead of sticking on stale step
- **Listener and timer cleanup** — Fixes leaks on dispose
- **CSP hardening** — WebView content-security-policy tightened
- **Hover cursor and unicode arrows** — Navigation affordances render correctly across themes

### Other

- New settings: `alchemist.showIterationStepper`, `alchemist.iterationFlashDuration`, `alchemist.iterationHoverDetail`
- Integration tests for full iteration flow
- Design specs and implementation plans for iteration navigation and sourceFile tracking

## 0.2.0 (2026-04-11)

### Features

- **Structured JSON output** — Uses AL.Runner's `--output-json` for reliable parsing instead of regex
- **Per-statement variable capture** — Inline variable values via `--capture-values` in all modes
- **Column-precise error placement** — Error decorations point to the exact column, not just the line
- **Single test execution** — Run individual tests from Test Explorer via `--run`
- **Compact loop display** — Loops show `first .. last (xN)` instead of dumping all values
- **Loop hover details** — Hover on compact loop output to see all values
- **Variable hover** — Hover over any variable name to see its captured value

### Fixes

- **Fixed NuGet package name** — Auto-install now uses correct package `msdyn365bc.al.runner`
- **Fixed JSON parsing** — Handle mixed stdout (bare Message text + JSON) without crashing
- **Fixed duplicate hover values** — Show last captured value only, not one per scope
- **Non-blocking activation** — Extension commands register immediately, AL.Runner install runs in background

### Other

- 59 unit tests (up from 28)
- Extracted `buildRunnerArgs` and `distributeMessages` for testability
- Added icon, LICENSE, CHANGELOG for marketplace publishing

## 0.1.0 (2026-04-11)

Initial release.

### Features

- **Scratch pad mode** — Create standalone AL scratch files for quick experiments (`Ctrl+Shift+A N`)
- **Project-aware scratch** — Add `//alchemist: project` to access workspace objects
- **Run on save** — Automatically execute on file save
- **Inline Message output** — `Message()` results appear as ghost text next to the calling line
- **All loop values** — Loop `Message()` calls show all iteration values inline (Quokka-style)
- **Coverage gutters** — Green/gray/red dots in the gutter show execution status
- **Dimmed uncovered lines** — Lines that didn't execute are visually dimmed
- **Inline error display** — Errors appear at the exact source line and column
- **Variable values on hover** — Hover over any variable to see its captured value
- **Test Explorer integration** — Tests appear in VS Code's Test Explorer
- **Single test execution** — Run individual tests via `--run`
- **Output panel** — Formatted results with messages, errors, and coverage
- **Status bar** — Beaker icon shows idle/running/success/failure state
- **Auto-install** — AL.Runner downloaded automatically on first use

### Powered by

[BusinessCentral.AL.Runner](https://github.com/StefanMaron/BusinessCentral.AL.Runner) by Stefan Maron
