# Plan A Manual Verification

## Setup

1. Clone `https://github.com/StefanMaron/BusinessCentral.Sentinel`.
2. Open the repo in VS Code via `al.code-workspace`.
3. Ensure AL.Runner 1.0.12+ is installed (`al-runner --version`).
4. Install the locally-built ALchemist VSIX: `code --install-extension al-chemist-0.4.0.vsix`.

## Discovery

- [ ] Test Explorer shows two app nodes: `BusinessCentral.Sentinel` and `BusinessCentral.Sentinel.Test`.
- [ ] `BusinessCentral.Sentinel.Test` node expands to show every `*.Test.Codeunit.al` as a codeunit with its `[Test]` procedures.
- [ ] `BusinessCentral.Sentinel` node is empty (no test codeunits in main app).

## Save routing

- [ ] Save a file under `BusinessCentral.Sentinel/src/`. Expect AL.Runner invocations for `BusinessCentral.Sentinel.Test` (the dependent). Check output channel.
- [ ] Save a file under `BusinessCentral.Sentinel.Test/src/`. Expect invocation only for `BusinessCentral.Sentinel.Test`.
- [ ] Set `alchemist.testRunOnSave` to `off`; save a file; confirm no test run.
- [ ] Set it to `all`; save any file; confirm runs for every app.

## Test Explorer actions

- [ ] "Run All" at the top of Test Explorer runs tests in every app (check output).
- [ ] Running a single test procedure passes `--run <proc>` to AL.Runner for that app (verify in output).

## Edge cases

- [ ] Edit any `app.json` (bump version string). Test tree refreshes without window reload.
- [ ] Add a new `*.Test.Codeunit.al` file with `[Test]` procs. Save it. Tests appear in tree (debounced 200ms).
- [ ] Create a scratch file via `Ctrl+Shift+A N` with `//alchemist: project`. Expect QuickPick listing both apps. Pick one; confirm persistence by saving again (no prompt).
- [ ] Delete `BusinessCentral.Sentinel.Test/app.json`. Tree collapses to just the main app. Restore it; tree returns.

## Known limitations (document in CHANGELOG)

- Saving a `.al` that adds a new `[Test]` proc refreshes the tree after the 200ms debounce — not instant.
- `runOnSave` does not yet narrow to specific test codeunits affected by the change (runs all tests in dependent apps). Precision tier is Plan B.
- Workspaces with no `app.json` anywhere fall through to scratch-standalone only — no test discovery.
- Combined-attribute syntax `[Test, HandlerFunctions(...)]` is not detected by current regex; use stacked `[Test]\n[HandlerFunctions(...)]` form. Plan B's tree-sitter discovery will fix.
