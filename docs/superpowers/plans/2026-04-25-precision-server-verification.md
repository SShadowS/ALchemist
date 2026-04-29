# Precision Tier + --server Manual Verification

## Setup

1. Clone `https://github.com/StefanMaron/BusinessCentral.Sentinel`.
2. Open the repo via `al.code-workspace`.
3. Verify AL.Runner 1.0.12+ via `dotnet tool list -g`.
4. Build + install ALchemist 0.4.0 VSIX:
   ```
   npx webpack --mode production && npx @vscode/vsce package --no-dependencies
   code --install-extension al-chemist-0.4.0.vsix --force
   ```
   Reload VS Code window.

## Tier transitions

- [ ] On window reload, status bar shows "regex (indexing N/M)" briefly, then "precision" within seconds.
- [ ] Status bar tooltip on "precision" reads: "ALchemist: precision tier — tests narrowed via tree-sitter symbol index".

## Save-triggered routing

- [ ] Save `BusinessCentral.Sentinel/src/Alert.Table.al`. Status bar: "precision (N tests / 1-2 apps)" — N small. Output panel shows test results.
- [ ] Save a test codeunit. Only that codeunit's tests run.
- [ ] Introduce a syntax error in saved file. Status bar: "fallback — file Foo.al has parse errors". Wider test set runs.
- [ ] Set `alchemist.testRunOnSave` to "off". Save a file. No tests run.
- [ ] Set to "all". Save any file. Status bar: "fallback". All apps' tests run.

## Server warm-cache

- [ ] First test run after activation: measure latency.
- [ ] Tenth run: measure latency. Should be noticeably faster.
- [ ] Kill `al-runner` process via Task Manager. Next save → supervisor respawns transparently.

## Run-wider-scope

- [ ] Hit `Ctrl+Shift+A Shift+R`. Status bar: "fallback — wider scope (N apps)". Broader test set runs.

## Edge cases

- [ ] Edit `app.json` (bump version). Tree refreshes. Index re-initializes.
- [ ] Add a new `*.Test.Codeunit.al`. Save it. Tests appear in Test Explorer within ~200ms.
- [ ] Save 50 files in rapid succession. Index converges; only one final precision-tier run fires.
- [ ] Save during initial index build. Status bar: "fallback — index awaiting reparse".

## Combined attribute detection

- [ ] Sentinel test files using `[Test, HandlerFunctions(...)]` — confirm they appear in Test Explorer (was missing in v0.3.0).

## Known limitations

- AL.Runner --server protocol does not currently expose per-test filter; precision = app-set narrowing + display narrowing, not execution narrowing.
- Workspaces with no `app.json` anywhere fall through to scratch-standalone only.
