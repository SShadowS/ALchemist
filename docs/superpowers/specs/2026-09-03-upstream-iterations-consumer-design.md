# Consuming the upstream `iterations` wire (retire-the-fork step 1)

**Status:** spec, revised after an adversarial review (GPT-5.6-sol, 2026-09-03) that read
the actual consumers. Not yet implemented.
**Depends on:** StefanMaron/BusinessCentral.AL.Runner#2475 (upstream `iterationTracking`),
shipping in the next runner minor.

## Why

ALchemist's iteration stepping, inline loop rendering, and per-iteration coverage are
built against the **fork's** `iterations[]` wire. Issue #1 upstreamed the feature so the
fork can be retired, but the upstream shape is deliberately different (and better): it
tags the flat capture/message series with `loop`/`iteration` instead of copying records
into steps, renames the levels, uses integer ids unique per response, and adds
`closedBy`, `unsegmentable`, and `unresolvedScopes`. Against the upstream runner today,
`serverExecutionEngine.ts` reads `response.iterations` (top-level) which upstream does not
emit, so every iteration feature shows nothing.

Goal: consume the upstream shape through a single normalizer, keep the fork working via
shape detection during the transition, and change the display consumers as little as
possible. The review below drove several corrections; the naive "adapt loops only"
version was not faithful.

## Scope (corrected)

- **In scope:** the non-streamed `execute` path only (scratch mode). Both upstream
  `tests[].loops` and the fork's top-level `response.iterations`.
- **Out of scope:** `runTests` iterations. Upstream does not emit iterations on the
  streaming path (no captured values there yet), and ALchemist's `runTests` handling
  converts each streaming event through `mapTestEvent` (`serverExecutionEngine.ts:50-63,
  88-119, 185-216`), which retains messages/captures but not `loops`/`unresolvedScopes`;
  `TestEvent` has no loop fields (`protocolV2Types.ts:50-66`). Adding it later means
  extending `TestEvent`/`TestResult`/`mapTestEvent` and adapting each event before the
  terminal summary. Do **not** wire loop adaptation into the `runTests` result site; it
  can never see `loops`.

## The wire delta

| Concept | Fork (today) | Upstream (#2475) |
|---|---|---|
| Loops container | top-level `iterations[]` | per-test `tests[].loops[]` |
| Loop id | `loopId` string `"L0"` | `id` integer `0`, unique per response |
| Loop source | `sourceFile`, `loopLine`, `loopEndLine` | `file`, `line`, `column`, `endLine`, `endColumn` |
| Parent | `parentLoopId` string, `parentIteration` | `parentLoop` int (omitted if root), `parentIteration` (omitted before 1st pass) |
| Count | `iterationCount` always present | `iterationCount` omitted when `unsegmentable` code present |
| End | — | `closedBy`: `exit` \| `scopeExit` \| `unfinished` |
| Iteration level | `steps[]` | `iterations[]` |
| Per-iteration values | `steps[].capturedValues[]` (copied) | tags on flat `capturedValues[]`: `loop`, `iteration` |
| Per-iteration messages | `steps[].messages` (`string[]`, copied) | tags on top-level `messages[]` objects |
| Per-iteration lines | `steps[].linesExecuted` | `iterations[].lines` |
| Per-iteration statements | — | `iterations[].statements` (statement-table id-space) |
| Messages shape | `string[]` | `{text, scopeName, statementId, loop?, iteration?}` |
| Capture value | string | `number \| boolean \| string \| null`, optional `captureError`, `loop?`, `iteration?` |
| Unresolved scopes | — | `tests[].unresolvedScopes[]` |

## Design: one response normalizer, not per-site adapters

Do the whole translation in **one** function that runs on the raw execute response
**before** `mapV1Test` discards per-test fields (`serverExecutionEngine.ts:153-180`). It
must produce every projection the existing consumers read, not just the loops, because a
scratch execute has no `protocolVersion === 2` and decorations therefore read the
**legacy top-level** `capturedValues`/`messages` in show-all mode
(`decorations.ts:249-269`).

```ts
// src/execution/upstreamExecuteNormalizer.ts (new)
interface NormalizedExecute {
  iterations: IterationData[];            // adapted, fed to IterationStore.load
  capturedValues: CapturedValue[];        // aggregate legacy projection (show-all/hover)
  messages: string[];                     // aggregate legacy text projection (OutputChannel, inline)
  structuredMessages: UpstreamMessage[];  // retained for exact placement (statementId)
  unresolvedScopes: string[];             // surfaced in the OutputChannel
  // coverage passes through unchanged into coverageV2 (see Coverage below)
}
```

Detection and precedence (against the **raw** tests, not the mapped `TestResult[]`):

- **Upstream** if any test has an array-valued `loops`. Then, per test, `flatMap` that
  test's `loops` through the loop adapter using **that same test's** `capturedValues`
  (capture indices/statement-id domains are per test) and the **response-level**
  `messages` (loop ids are response-unique, so top-level message filtering is safe).
- **Fork** if there is no `tests[].loops` but a top-level `response.iterations`.
- **Both present** (a transition/debug artifact): prefer upstream deterministically, log a
  protocol-conflict diagnostic, and never merge (merging can collide ids and duplicate
  data).
- **Neither, and `tests` non-empty:** normal when `iterationTracking` was not requested.
  Only warn about a missing-capability runner when the request set `iterationTracking`
  and the response otherwise completed.
- Distinguish a malformed `loops` value from an absent one.

### The loop adapter

```ts
function adaptLoop(l: UpstreamLoop, caps: UpstreamCapture[], msgs: UpstreamMessage[]): IterationData {
  return {
    loopId: String(l.id),                             // ids are response-unique; "0" is truthy
    sourceFile: l.file,                               // resolved later against execution context
    loopLine: l.line,
    loopEndLine: l.endLine,
    parentLoopId: l.parentLoop != null ? String(l.parentLoop) : null,
    parentIteration: l.parentIteration ?? null,
    iterationCount: l.iterationCount ?? 0,            // unsegmentable -> 0, and see "Navigation"
    unsegmentable: l.unsegmentable ?? null,           // preserved, drives non-navigability
    closedBy: l.closedBy ?? null,                     // preserved; "unfinished" -> last pass partial
    steps: l.iterations.map(it => ({
      iteration: it.index,                            // upstream indexes are 1-based, contiguous
      captures: caps                                  // full-fidelity: keep scope + statementId + order + dups
        .filter(cv => cv.loop === l.id && cv.iteration === it.index)
        .map(cv => ({ scopeName: cv.scopeName, variableName: cv.variableName,
                      value: toDisplay(cv), statementId: cv.statementId })),
      messages: msgs.filter(m => m.loop === l.id && m.iteration === it.index),  // structured, keep statementId
      linesExecuted: it.lines,
      statementsExecuted: it.statements,
    })),
  };
}
```

Filtering by exact `(loop, iteration)` is faithful: `Array.filter` preserves source order
and duplicates, and a nested loop's records carry the nested id so they never leak into a
parent step. **Do not** add a `scopeName === loop.scope` filter: a capture from a
procedure executed during the pass legitimately carries that procedure's scope name and a
matching tag, and must be kept.

## Corrections the review forced

1. **Aggregate captures/messages must be rebuilt (design flaw #2).** The normalizer emits
   the legacy top-level `capturedValues` (flattened across tests, via the existing
   `v2ToV1Captured` shape) and the legacy `messages: string[]` so show-all hover, inline
   capture rendering (`decorations.ts:249-269`), and OutputChannel keep working. Do not
   populate only per-test fields.

2. **Navigation must not throw on zero-count/unsegmentable loops (design flaw #5 — a real
   bug).** `IterationStore.setIteration` clamps `0` to `1` (`Math.max(1, Math.min(n,0))`)
   and then `getStep(loopId, 1)` throws `No step 1`; every nav method reaches it
   (`iterationStore.ts:50-101`), and commands do not catch (`iterationCommands.ts:25-68`).
   Fixes, all of:
   - preserve `unsegmentable`/`iterationCount`-absent rather than only mapping to 0;
   - `setIteration` returns `undefined` (or a no-op) for a non-navigable loop instead of
     firing a change and calling `getStep`;
   - `iterationCommands` excludes zero-count/unsegmentable loops from implicit targeting;
   - `extension.ts` sets `alchemist.hasIterationData` only when at least one loop has a
     valid step, not merely when a loop record exists (`extension.ts:361-373`).
   - validate segmentable loops on load: 1-based, contiguous indexes agreeing with
     `iterationCount`.

3. **Preserve capture identity (design flaw #3).** `IterationStepData` gains `scopeName`
   and `statementId`; `IterationStore` may keep its `Map<name,value>` last-write-wins
   projection for the current UI, but the adapter output must retain order, duplicates,
   scope, and statement id so a same-named local from a callee is not silently rendered
   against the caller's assignment (`decorations.ts:678-716`). Test the raw adapter, not
   only the store.

4. **Canonical value conversion (design flaw #4).** One `toDisplay(cv)`:
   string unchanged; number/boolean `String(v)`; genuine null (no `captureError`) a chosen
   null marker; object/array `JSON.stringify` with a string fallback; a record with
   `captureError` renders an explicit error marker, never the same blank as a real null
   (upstream's loud-failure contract). Add `captureError?`, `loop?`, `iteration?` to the
   capture type (`protocolV2Types.ts:35-49`).

5. **Keep structured messages (design flaw #8).** The `string[]` projection prevents
   `[object Object]` in OutputChannel and inline rendering (`outputChannel.ts:104-112`,
   `decorations.ts:450-496`), but retain `structuredMessages` so exact placement via the
   statement table can replace the current first-N-call heuristic
   (`decorations.ts:721-744`) later. Do not discard `statementId` at normalization.

6. **Path resolution against execution context, not the active editor (design flaw #9).**
   `IterationStore.load` resolves `sourceFile` against a workspace path currently derived
   from the active editor (`extension.ts:361-366`). Upstream `loop.file` may be absolute
   or bundle-relative and can belong to a different app than the open file. Resolve
   absolute paths as-is; resolve relative paths against the bundle/source path that owned
   the test; in multi-source runs use a per-source resolver, not one global root. The same
   applies to a capture's `sourceFile`, which upstream per-test records may not carry;
   derive it from the matching loop or the `(scopeName, statementId)` coverage record.

7. **Coverage stays independent, and `unresolvedScopes` is surfaced (design flaw #10).**
   Iteration detection must not be coupled to coverage detection. An upstream execute
   response carrying the statement table must land in `coverageV2` (the shape
   `decorations.ts:270-286` builds its statement model from), not the legacy `coverage`
   field. Surface `unresolvedScopes` in the OutputChannel so partial tracking does not look
   like "nothing looped". Keep `closedBy`/`unsegmentable` even if the UI treatment is
   deferred; `closedBy: unfinished` means the last pass is partial.

8. **Version floor (design flaw #11 — the original spec had this backwards).** The global
   `MIN_AL_RUNNER_VERSION` is already `2.7.0` for the statement table and DAP
   (`alRunnerManager.ts:4-11`) and is a soft async warning, not a gate
   (`alRunnerManager.ts:50-82`). Do **not** lower it. Drive parsing purely by response
   shape. If a version diagnostic is wanted, expose the resolved runner version to the
   engine and keep a separate `MIN_ITERATION_RUNNER_VERSION`, raised only when the fork is
   intentionally retired. Editing repo `.vscode/settings.json` is not a user rollout
   mechanism (the managed NuGet/PATH runner is already the default unless a user sets a
   path).

## What stays unchanged

- `IterationStore` keying by string `loopId`, stepping semantics, show-all mode — apart
  from the non-navigable-loop guard in correction #2.
- `DecorationManager` inline value/message rendering, `HoverProvider`,
  `IterationTablePanel`, `IterationCodeLensProvider`. Loop ids stay opaque
  extension-internal strings and are never sent back to the runner
  (`iterationCodeLensProvider.ts:9-70`, `hoverProvider.ts:70-92`,
  `iterationTablePanel.ts:35-51`).
- The `alchemist.showHitCounts` / statement-table path.

## Testing (layered — store-parity alone is insufficient)

Store-parity tests cannot see lost order or duplicates because the store collapses to a
`Map`, and the upstream flat series itself changed (same-value writes, per-scope state,
leading loop variables), so "same AL, identical store output under both runners" is not a
valid invariant. Test in layers:

1. **Raw adapter:** order, duplicates, same variable name across two scopes, nested ids,
   a capture whose scope differs from the loop's scope, `value:null`, `captureError`,
   objects, booleans, numbers.
2. **Store projection:** assert the chosen last-write-wins behavior explicitly.
3. **Detection:** `loops` absent vs `[]`, mixed tests (one empty, one populated), both
   shapes present, malformed `loops`, `iterationTracking` off, zero tests.
4. **Navigation:** unsegmentable/zero-count loops never throw through any command.
5. **Multi-bundle:** repeated iteration indexes and statement ids across tests,
   response-global loop ids, top-level message filtering.
6. **Paths:** absolute, relative, scratch (no workspace), dependency app, multiple bundles.
7. **Result assembly:** per-test captures become both per-test and aggregate legacy
   projections.
8. **Coverage:** iteration adaptation leaves legacy `coverage`/`coverageV2` unchanged.
9. **Compatibility:** string and object messages both tolerated, no `[object Object]`.

Fixtures: real `#2475` execute responses beside the existing fork sample, under
`test/fixtures/protocol-v2-samples/`.

## Rollout

1. Land the normalizer + detection + the navigation guard. Both runners work; nothing
   changes for fork users.
2. Keep the global runner floor as-is; gate the iteration-capability warning on
   `iterationTracking` having been requested.
3. Retire the fork build when the upstream runner is the default and its captured-value
   behavior (already merged) is the one ALchemist relies on.

## Out of scope

- `runTests` (streaming) iterations — see Scope.
- Exact per-statement message/value placement via `iterations[].statements` and
  `structuredMessages` — additive; the metadata is preserved now, the UI later.
- `closedBy` / `unsegmentable` UI affordances beyond not-navigable and a diagnostic line.
- The by-ref parameter value rendering (StefanMaron/BusinessCentral.AL.Runner#2488): a
  runner-side fix; ALchemist displays whatever value the runner sends.
