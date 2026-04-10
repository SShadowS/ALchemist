# ALchemist

Quokka-style live execution and inline feedback for AL (Business Central).

## Features

- Run AL tests directly from gutter icons
- Inline pass/fail decorations with timing info
- Hover to see assertion messages and output
- Scratch pad mode for quick experimentation
- Test Explorer integration
- Code coverage gutter highlights
- Status bar with live run state

## Getting Started

1. Install the extension
2. Open a Business Central AL project
3. Configure `alchemist.runnerPath` to point to your AL test runner executable
4. Click gutter icons or use `Ctrl+Shift+T` to run tests

## Requirements

- VS Code ^1.115.0
- An AL test runner executable (e.g., AL.Runner)

## Extension Settings

- `alchemist.runnerPath` — Path to the AL test runner executable
- `alchemist.autoRunOnSave` — Run tests automatically on save (default: false)
- `alchemist.showCoverage` — Show code coverage gutter highlights (default: true)
- `alchemist.timeout` — Test execution timeout in milliseconds (default: 30000)
