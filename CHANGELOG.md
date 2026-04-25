# Changelog

## [Unreleased]

### Features

- **Multi-app workspace support** — ALchemist now discovers AL apps (folders with `app.json`) across every workspace folder, not just the first. Works correctly on `.code-workspace` multi-root setups.
- **Test Explorer grouped by app** — Tests appear as App → Codeunit → Procedure. Multiple apps with same-named codeunits no longer collide.
- **Dependency-aware save routing** — Saving a file in a main app runs tests in every app that transitively depends on it (via `app.json` `dependencies`). Save in a test app runs only that app's tests.
- **Scratch-project multi-app selection** — Project-aware scratch files (`//alchemist: project`) in multi-app workspaces prompt for an AL app context on first use; choice persists per scratch file. Explicit override via `alchemist.scratchProjectAppId` setting.

### Fixes

- **Codeunit regex accepts unquoted names** — Discovery previously failed on `codeunit 50000 Name` (bare identifier); now accepts both quoted and unquoted forms. Unblocks real-world repos like BusinessCentral.Sentinel.
- **Fallback retry gated on AL compile error** — `executor.ts` previously retried every non-zero exit. Now retries only on exit code 3 (AL compile error) with AL.Runner 1.0.12+, or exit 1 with zero tests captured (legacy compatibility). Assertion failures and runner limitations no longer trigger spurious single-file retries.
- **Removed `workspaceFolders[0]` assumption** — Every call site that implicitly assumed a single workspace folder now resolves the owning AL app via `WorkspaceModel`.

### Requires

- AL.Runner **1.0.12+** for differentiated exit codes and HTTP type compile fix. Older runners still work but fall back to legacy exit-code handling.

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
