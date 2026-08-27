# Statement Table + DAP — Known Follow-Ups

Deferred items found while implementing `docs/superpowers/plans/2026-08-27-statement-table-dap.md`.
Each was reviewed and judged non-blocking for that branch. None is a known user-facing bug.

## Behavioural / correctness

- **The v1 gutter and dimming path is production-dead.** `applyCoverageGutters` and
  `applyDimming` in `src/editor/decorations.ts` still consume the legacy cobertura
  `CoverageEntry[]`, which no runner at or above the 2.7.0 floor produces. Either delete
  them, or re-point gutters and dimming at `CoverageModel.lineRollup()`. `findCoverageForFile`
  exists solely to serve these two callers and goes with them.
- **Scratch-mode inline values are unverified against a real 2.7.0 run.** `executeScratch`
  never requests coverage, so a scratch run carries no statement table and therefore paints
  no inline values under the no-fallback rule. Confirm against a live runner and decide
  whether scratch should request coverage.
- **The runtime "no statement table" notice narrows the spec.** `src/extension.ts` does not
  name the runner version in the message, and stays silent when a run produces zero captures
  — so a pre-2.7.0 runner with no captures gets only the install-time warning. Accepted
  narrowing; revisit if users report confusion.
- **`resolveSourcePaths` with a relative path and no workspace folder** silently resolves
  against `process.cwd()` instead of throwing (`src/debug/debugAdapterFactory.ts`). Cannot
  arise in practice today, since a launch configuration implies a workspace folder.

## Upstream dependencies

- **Per-test debug selection (`testFilter`) is unverified.** ALchemist emits it; no one has
  confirmed AL.Runner 2.7.0 accepts it. The launch-configuration schema and the README both
  say so. Verify against a real 2.7.0 runner and either confirm the property name or drop it.
- **Stepping is not implemented upstream.** `next`/`stepIn`/`stepOut` behave like `continue`.
  Remove the one-per-session caveat toast in `AlchemistTestController` once upstream ships
  real stepping.
- **Per-execution captures and iteration segmentation** (upstream
  StefanMaron/BusinessCentral.AL.Runner#2074 and #2056) are not built yet. Until they land,
  the iteration-stepping feature continues to run on the fork's `iterations[]` output.

## Test and fixture hygiene

- `test/fixtures/test-al-runner-output.json` carries a `coverage[]` block with a v2
  `FileCoverage` shape inside an otherwise-v1 fixture, and **no test code reads the file at
  all**. Either wire it into a real v1-path regression test or delete the block.
- `test/fixtures/src/` breaks the one-folder-per-scenario convention used by every sibling
  fixture directory.
- The `showHitCounts` gate test passes both when the gate is respected and when the feature
  is entirely dead — it only ever expects one `setDecorations` call.
- That same test hand-rolls a `getConfiguration` stub with `try/finally`, while `sinon` is a
  devDependency used for stubbing elsewhere in the suite.
- `test/integration/decorationRender.itest.ts` re-derives fixture paths inline instead of
  reusing the `FIX` and `EXTENSION_ROOT` constants already defined at the top of the file.
- `registeredFactories` in `test/__mocks__/vscode.js` is written and never read; the debug
  adapter registration in `extension.ts` has no assertion.
- No test asserts `FileStatementIndex.statements`; `byLine` ordering is undefined when two
  statements share both a line and a column.

## Repository hygiene

- ~~**`npm run lint` cannot run.**~~ **Resolved.** ESLint 10 with a type-aware flat config
  (`eslint.config.mjs`) was added afterwards; `npm run lint` now covers `src` and `test` and
  exits clean. What remains is the 319 warnings it reports: the `no-unsafe-*` family, firing
  wherever `any` propagates out of `JSON.parse` and untyped VS Code surfaces. They are
  deliberately not gated on. Typing the protocol-parsing boundary would retire most of them
  and is the single highest-value cleanup left in this file.
