# Changelog

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
