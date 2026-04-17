# ALchemist

Live execution and inline feedback for AL (Business Central) — like [Quokka.js](https://quokkajs.com/) but for AL.

[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-^1.85.0-blue)](https://code.visualstudio.com/)

| Metric | Value |
|--------|-------|
| Engine | [AL.Runner](https://github.com/StefanMaron/BusinessCentral.AL.Runner) (transpiles AL to C#, runs in-memory) |
| Runtime | .NET 8 SDK |
| Infrastructure needed | None (no Docker, no BC service tier, no SQL Server) |
| Execution time | Milliseconds |

## Features

| Feature | Description |
|---------|-------------|
| **Scratch pad** | Create standalone AL scratch files for quick experiments (`Ctrl+Shift+A N`) |
| **Project-aware scratch** | Add `//alchemist: project` to access workspace tables, codeunits, and enums |
| **Run on save** | Automatically execute on save with results in milliseconds |
| **Inline Message output** | `Message()` results appear as green ghost text next to the calling line |
| **All loop values** | Loop `Message()` calls show all iteration values inline (Quokka-style) |
| **Coverage gutters** | Green/gray/red dots in the gutter show which lines executed |
| **Dimmed uncovered lines** | Lines that didn't execute are visually dimmed |
| **Inline error display** | Failed assertions and errors appear as red text at the exact source line and column |
| **Variable values on hover** | Hover over any variable to see its captured value |
| **Test Explorer** | Tests appear in VS Code's Test Explorer with pass/fail/error states |
| **Single test execution** | Run individual tests from Test Explorer instead of the full suite |
| **Coverage hover tooltips** | Hover over gutter dots to see coverage status |
| **Output panel** | Formatted ALchemist output with messages, errors, and coverage summary |
| **Status bar** | Beaker icon shows idle/running/success/failure state at a glance |
| **Iteration navigation** | Time-travel through loop iterations with CodeLens stepper, hover links, and keyboard shortcuts |
| **Iteration table panel** | Dedicated WebView listing every iteration with its variable snapshot |
| **Value change flash** | Inline values briefly highlight when they change between iterations |
| **Theme-aware colors** | Inline decoration colors adapt to light/dark/high-contrast themes and are user-customizable |
| **Auto-install** | AL.Runner is downloaded automatically on first use |

## Prerequisites

- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (AL.Runner is installed automatically)
- VS Code 1.85.0 or later

## Installation

**From VSIX (beta):**

```
code --install-extension alchemist-0.3.0.vsix
```

Or in VS Code: `Ctrl+Shift+P` > "Extensions: Install from VSIX..."

On first activation, ALchemist will prompt to install AL.Runner via `dotnet tool install -g msdyn365bc.al.runner`.

## Quick Start

1. Open any folder in VS Code
2. Run `ALchemist: New Scratch File` (`Ctrl+Shift+A N`)
3. Write AL code in the scratch file
4. Save (`Ctrl+S`) — results appear inline

```al
codeunit 50000 Scratch
{
    trigger OnRun()
    var
        i: Integer;
        total: Integer;
    begin
        for i := 1 to 10 do
            total += i;
        Message('Total: %1', total);   // --> Total: 55
    end;
}
```

For project-aware scratch files, add `//alchemist: project` as the first line to access workspace objects.

## Architecture

```
  Save .al file
       |
       v
  ALchemist Extension (TypeScript)
       |
       |  spawn al-runner --output-json --capture-values [--coverage] <path>
       v
  AL.Runner (.NET CLI)
       |
       |  1. Transpile AL --> C#
       |  2. Rewrite BC types --> in-memory mocks
       |  3. Compile with Roslyn
       |  4. Execute + capture values
       |
       v
  JSON result (tests, messages, capturedValues, coverage)
       |
       v
  ALchemist renders:
    - Inline decorations (messages, errors, values)
    - Gutter icons (coverage)
    - Output panel
    - Status bar
    - Test Explorer items
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `alchemist.alRunnerPath` | `""` | Custom path to `al-runner` binary. Leave empty for auto-managed. |
| `alchemist.dotnetPath` | `""` | Custom path to `dotnet` SDK. |
| `alchemist.runOnSave` | `true` | Execute automatically on file save. |
| `alchemist.testRunOnSave` | `"current"` | Which tests to run on save: `current`, `all`, or `off`. |
| `alchemist.showOutputOnError` | `"onlyOnFailure"` | When to auto-focus the output panel: `always`, `never`, `onlyOnFailure`. |
| `alchemist.showInlineMessages` | `true` | Show `Message()`/`Error()` output inline in the editor. |
| `alchemist.showGutterCoverage` | `true` | Show coverage gutter indicators. |
| `alchemist.showCapturedValues` | `true` | Show captured variable values inline. |
| `alchemist.dimUncoveredLines` | `true` | Reduce opacity of lines not reached. |
| `alchemist.showIterationStepper` | `true` | Show CodeLens iteration stepper above loops (requires reload). |
| `alchemist.iterationFlashDuration` | `600` | Duration in ms for value-change flash when stepping (0 disables). |
| `alchemist.iterationHoverDetail` | `"rich"` | Iteration hover detail: `minimal`, `values`, or `rich`. |

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| ALchemist: New Scratch File | `Ctrl+Shift+A N` | Create a new AL scratch file |
| ALchemist: Run Now | `Ctrl+Shift+A R` | Execute the current file immediately |
| ALchemist: Clear Results | `Ctrl+Shift+A C` | Clear all inline decorations |
| ALchemist: Toggle Project Context | | Toggle `//alchemist: project` directive |
| ALchemist: Delete Scratch File | | Delete the active scratch file |
| ALchemist: Save Scratch As... | | Save scratch file to workspace |
| ALchemist: Stop Run | | Cancel a running execution |
| ALchemist: Show Output | | Focus the ALchemist output panel |
| ALchemist: Next Iteration | `Ctrl+Shift+A →` | Step to next loop iteration |
| ALchemist: Previous Iteration | `Ctrl+Shift+A ←` | Step to previous loop iteration |
| ALchemist: First Iteration | `Ctrl+Shift+A Home` | Jump to first iteration |
| ALchemist: Last Iteration | `Ctrl+Shift+A End` | Jump to last iteration |
| ALchemist: Show All Iterations | `Ctrl+Shift+A A` | Show aggregate view of all iterations |
| ALchemist: Open Iteration Table | `Ctrl+Shift+A T` | Open the iteration table panel |

## Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Extension entry point, wires all components |
| `src/runner/executor.ts` | Spawns AL.Runner, collects JSON results |
| `src/runner/outputParser.ts` | Parses `--output-json` output and Cobertura XML |
| `src/runner/alRunnerManager.ts` | Auto-download, version check, path resolution |
| `src/editor/decorations.ts` | Inline text, gutter icons, dimming, captured values |
| `src/editor/hoverProvider.ts` | Coverage and variable value hover tooltips |
| `src/scratch/scratchManager.ts` | Scratch file lifecycle and project-aware detection |
| `src/testing/testDiscovery.ts` | Scans `.al` files for `[Test]` procedures |
| `src/testing/testController.ts` | VS Code Test Explorer integration |
| `src/output/outputChannel.ts` | Formatted output panel |
| `src/output/statusBar.ts` | Status bar indicator |

---

**Author**: SShadowS
**License**: MIT
