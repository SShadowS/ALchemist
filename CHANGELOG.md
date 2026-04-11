# Changelog

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
