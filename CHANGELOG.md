# Changelog

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
