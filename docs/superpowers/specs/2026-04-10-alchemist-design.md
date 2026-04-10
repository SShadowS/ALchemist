# ALchemist — Design Specification

**Date:** 2026-04-10
**Status:** Approved
**Approach:** Progressive (CLI wrapper → sidecar → upstream API)

## Overview

ALchemist is a VSCode extension that brings Quokka.js-style live execution and inline feedback to the AL language (Microsoft Dynamics 365 Business Central). It uses [BusinessCentral.AL.Runner](https://github.com/StefanMaron/BusinessCentral.AL.Runner) as its execution engine — a CLI tool that transpiles AL to C#, mocks the BC runtime, and runs tests in-memory without Docker, SQL Server, or BC service tier.

**Two modes:**
- **Scratch pad** — Quick AL experiments with instant feedback
- **Test runner** — Run project tests with inline results and coverage

**Core experience:** Save a file → see results inline in the editor within milliseconds.

## Architecture

### Progressive Phases

**Phase 1 (v1): CLI Wrapper**
Invoke `al-runner` as a child process on each save. Parse stdout and Cobertura XML coverage output. Map results to VSCode editor decorations, gutter indicators, and Test Explorer items.

**Phase 2: Long-running Sidecar**
Keep AL.Runner warm as a persistent process to eliminate cold-start cost. Communicate over stdin/stdout or JSON-RPC. Enables faster re-execution and richer data exchange.

**Phase 3: Upstream Collaboration**
Work with Stefan Maron to add structured output formats and API modes to AL.Runner itself, benefiting the broader AL ecosystem.

### Extension Structure

```
alchemist/
├── src/
│   ├── extension.ts              # Activation, command registration
│   ├── runner/
│   │   ├── alRunnerManager.ts    # Download, locate, version-check AL.Runner
│   │   ├── executor.ts           # Spawn al-runner CLI, collect output
│   │   └── outputParser.ts       # Parse stdout + Cobertura XML into structured results
│   ├── editor/
│   │   ├── decorations.ts        # Inline ghost text, gutter icons
│   │   ├── gutterProvider.ts     # Coverage gutter indicators
│   │   └── hoverProvider.ts      # Hit count tooltips on hover
│   ├── scratch/
│   │   ├── scratchManager.ts     # Create/manage scratch files
│   │   └── scratchDetector.ts    # Detect scratch vs project file, parse directives
│   ├── testing/
│   │   ├── testDiscovery.ts      # Find test codeunits in workspace
│   │   ├── testController.ts     # VSCode Test Explorer integration
│   │   └── testResultMapper.ts   # Map al-runner output to TestItem results
│   └── output/
│       └── outputChannel.ts      # ALchemist output panel formatting
├── resources/
│   ├── icons/                    # Gutter icons (green, red, gray dots)
│   └── scratch-template.al      # Default scratch file template
├── package.json                  # Extension manifest, commands, settings, activation events
└── tsconfig.json
```

**Activation:** `onLanguage:al` — activates when any `.al` file is opened.

**Lifecycle per execution:**
1. User saves an `.al` file
2. `executor` determines mode (scratch vs test) based on file context
3. `executor` spawns `al-runner` with appropriate flags
4. `outputParser` parses stdout (messages, errors, assertions) + Cobertura XML (coverage)
5. Results dispatched to `decorations`, `gutterProvider`, and `outputChannel`
6. If test mode, results also flow to `testController` for Test Explorer updates

## AL.Runner Management

**Auto-download:** On first activation, if `al-runner` is not found on PATH or at a configured custom path, install via `dotnet tool install -g BusinessCentral.AL.Runner`. Requires .NET 8 SDK as prerequisite — show actionable notification with install link if missing.

**Version management:** Check for newer NuGet versions on activation (at most once per day, non-blocking). Show non-intrusive notification when update is available. Update runs `dotnet tool update -g BusinessCentral.AL.Runner`.

**Custom path:** Setting `alchemist.alRunnerPath` overrides auto-download. When set, skip auto-download and version checks. Useful for contributors or version pinning.

**Error handling:**
- Missing .NET SDK → notification with download link
- Download failure → error with manual install instructions
- Incompatible version → warn, suggest update

## Scratch Pad Mode

**Creating scratch files:**
- Command: `ALchemist: New Scratch File` (`Ctrl+Shift+A N`)
- Creates a temporary `.al` file from template:

```al
codeunit 50000 Scratch
{
    procedure Run()
    var

    begin
        Message('Hello from ALchemist');
    end;
}
```

- Created in temp directory managed by the extension (extension global storage), not the user's workspace
- Distinctive editor tab label (e.g., "Scratch 1 (ALchemist)")
- Scratch files persist across editor restarts

**Standalone vs project-aware:**
- Default: standalone — only built-in AL types available
- Project-aware: add `//alchemist: project` as the first line
- When project-aware, executor passes workspace source path to `al-runner` alongside the scratch file
- Also available as toggle command: `ALchemist: Toggle Project Context`

**Execution:**
- On save, executor runs:
  - Standalone: `al-runner -e <scratch-file-content>`
  - Project-aware: `al-runner <workspace-src> <scratch-file>`

**Additional commands:**
- `ALchemist: Delete Scratch File` — remove scratch file
- `ALchemist: Save Scratch As...` — promote scratch to a real workspace file

## Test Runner Mode

**Test discovery:**
- On workspace open and file save, scan `.al` files for codeunits with `[Test]` procedure attributes
- Register with VSCode Test Controller API
- Tests appear in Test Explorer sidebar: Workspace → Test Codeunit → Test Procedure

**Running tests:**
- From Test Explorer: run individual tests, codeunits, or all (standard VSCode UX)
- From editor: codelens "Run Test | Run All Tests" above test procedures and codeunits
- On save: auto-run affected tests (configurable)
- Executor: `al-runner --coverage <source-paths> <test-paths>`

**On-save scope** (`alchemist.testRunOnSave`):
- `"current"` (default) — when test file saved, run that codeunit; when source file saved, run all tests
- `"all"` — always run all tests
- `"off"` — manual only

**Result mapping:**
- Parse stdout for per-test pass/fail, assertion messages, `Message()` output, `Error()` text
- Map to VSCode `TestRunResult`: passed, failed (with message + location), errored
- Failed tests link to failing line in editor

## Inline Decorations & Gutter Indicators

### Gutter Icons

Three SVG icon variants shipped with the extension:
- **Green filled dot** (●) — line executed successfully
- **Red filled dot** (●) — line threw an error
- **Gray hollow dot** (○) — line not reached

Sized for clear visibility without overwhelming line numbers.

### Inline Decorations

Using VSCode `DecorationRenderOptions` with `after` pseudo-elements:
- **Green text** (`→ Total: 15`) — `Message()` output, displayed after the calling line
- **Red text** (`✗ Division by zero`) — `Error()` output
- **Gray italic** (`// ×5`) — hit count for looped/repeated lines
- **Dimmed lines** (reduced opacity) — lines not reached during execution

### Hover Tooltips

Hover provider on gutter regions shows:
- Statement hit count
- Coverage status (Covered / Not Covered / Error)

All decorations are cleared and fully redrawn on each execution cycle.

## Output Panel

Registered as VSCode output channel: `ALchemist`.

**Scratch run format:**

```
━━━ ALchemist ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▶ scratch1.al (scratch, standalone)
  ⏱ 320ms

  Messages:
    Line 10: Total: 15

  Errors:
    Line 12: Division by zero

  Coverage: 11/13 statements (84.6%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Test run format:**

```
━━━ ALchemist ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ▶ TestSalesCalculation (codeunit 50200)
  ⏱ 145ms

  ✓ TestBasicDiscount           12ms
  ✓ TestVolumeDiscount          8ms
  ✗ TestNegativeQuantity        3ms
    → Expected error 'Quantity must be positive'
      but got 'Division by zero'
      at line 45 in SalesCalculation.al

  Results: 2 passed, 1 failed
  Coverage: 28/35 statements (80.0%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Behavior:**
- Cleared and rewritten on each run (not appended)
- Clickable file:line references for quick navigation
- Auto-focus controlled by `alchemist.showOutputOnError` setting

## Status Bar

Persistent status bar item showing ALchemist state:

| State | Display | Color |
|---|---|---|
| Idle | `$(beaker) ALchemist` | Neutral |
| Running | `$(loading~spin) ALchemist` | Neutral |
| Success | `$(check) ALchemist: 3/3 passed` | Green |
| Failure | `$(error) ALchemist: 2/3 passed` | Red |
| Error | `$(warning) ALchemist: Runner error` | Yellow |

**Click:** Opens ALchemist output panel.
**Tooltip:** Last run details — mode, execution time, coverage percentage.

## Configuration

### Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `alchemist.alRunnerPath` | string | `""` | Custom path to `al-runner`. Empty = auto-managed. |
| `alchemist.dotnetPath` | string | `""` | Custom path to `dotnet` SDK. |
| `alchemist.runOnSave` | boolean | `true` | Execute on file save. |
| `alchemist.testRunOnSave` | enum | `"current"` | Test scope on save: `"current"`, `"all"`, `"off"`. |
| `alchemist.showOutputOnError` | enum | `"onlyOnFailure"` | Auto-focus output: `"always"`, `"never"`, `"onlyOnFailure"`. |
| `alchemist.showInlineMessages` | boolean | `true` | Show Message()/Error() inline. |
| `alchemist.showGutterCoverage` | boolean | `true` | Show coverage gutter indicators. |
| `alchemist.showHitCounts` | boolean | `true` | Show hit counts on repeated lines. |
| `alchemist.dimUncoveredLines` | boolean | `true` | Reduce opacity of unreached lines. |

### Commands

| Command | Title | Keybinding |
|---|---|---|
| `alchemist.newScratchFile` | ALchemist: New Scratch File | `Ctrl+Shift+A N` |
| `alchemist.toggleProjectContext` | ALchemist: Toggle Project Context | — |
| `alchemist.deleteScratchFile` | ALchemist: Delete Scratch File | — |
| `alchemist.saveScratchAs` | ALchemist: Save Scratch As... | — |
| `alchemist.runNow` | ALchemist: Run Now | `Ctrl+Shift+A R` |
| `alchemist.stopRun` | ALchemist: Stop Run | — |
| `alchemist.clearDecorations` | ALchemist: Clear Results | `Ctrl+Shift+A C` |
| `alchemist.showOutput` | ALchemist: Show Output | — |

## Future AL.Runner API Wishlist

Requirements for moving beyond CLI invocation to Phase 2/3 deep integration. Not part of v1 — reference for future upstream collaboration with Stefan Maron.

### Structured Output Format
- `--output-json` flag producing machine-readable results instead of human-readable stdout
- Per-line execution data: line number, hit count, status (executed/error/skipped), associated output
- Per-test structured results: test name, status, duration, assertion details, error location
- Eliminates fragile stdout parsing in the extension

### Long-Running Server Mode
- `--server` or `--daemon` mode keeping AL.Runner warm (transpiler loaded, dependencies cached)
- Communication over stdin/stdout JSON-RPC or local socket
- Commands: `execute`, `runTests`, `getSymbols`, `shutdown`
- Eliminates cold-start cost (~200-500ms per invocation)

### Incremental Re-execution
- Re-run only changed codeunits rather than full recompilation
- Dependency graph awareness: "codeunit X changed, re-run tests Y and Z"
- Near-instant on-save execution for large projects

### Variable Value Capture
- Emit variable values at each statement (or at marker points)
- Enables Quokka-style inline variable display without `Message()` calls
- Opt-in via `--capture-values` flag to avoid performance overhead

### Single-Procedure Execution
- Run a single procedure from a codeunit, not the entire thing
- Supports "Run this procedure" codelens in scratch mode

### Error Line Mapping
- Reliable AL source line mapping for all error types
- Column-level precision for inline decoration positioning

## Distribution

- Open source on GitHub (MIT license)
- Published on VS Code Marketplace
- Free, community-driven
