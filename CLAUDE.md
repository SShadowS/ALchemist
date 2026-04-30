# ALchemist Development Guidelines

## Principles

- **TDD** — Write failing tests first, then implement the minimal code to pass them.
- **SOLID** (within reason) — Single responsibility, open/closed, etc. Don't over-engineer, but keep units focused and interfaces clean.
- **DRY** — Don't repeat yourself. Before writing new code, check if the codebase already solves the same problem. Copy from working patterns, then adapt.

## References

- **VS Code Extension API documentation:** https://code.visualstudio.com/api — authoritative reference for `vscode.window`, `vscode.workspace`, `vscode.tests`, decoration types, TestController, FileCoverage, TestMessageStackFrame, hover providers, CodeLens providers, status bar items, webview panels, configuration, commands, and event subscriptions. Consult before guessing API shapes or behavior (e.g. when `activeTextEditor` is undefined, what `visibleTextEditors` contains, how `setDecorations` stacks).
