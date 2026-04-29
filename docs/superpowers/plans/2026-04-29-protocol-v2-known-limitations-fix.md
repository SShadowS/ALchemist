# Plan E2.1 — Protocol-v2 Known Limitations Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four known limitations from Plan E2 (CHANGELOG `Known limitations` + final cross-cutting review): wire save-triggered runs through the v2 streaming pipeline, add cursor-driven active-test selection, fix the `objectName → sourceFile` lossy translation that broke inline capture-value rendering, and eliminate the multi-app `testItems` (bare-name) collision risk on the v1 fallback path.

**Architecture:** Each limitation maps to a focused, low-risk surface change. Save-streaming reuses TestController's existing run-profile callback path by exposing a public `runTestsForRequest(request, token)` and constructing programmatic `TestRunRequest`s from save-router output. Cursor-driven `setActiveTest` subscribes to `vscode.window.onDidChangeTextEditorSelection` and walks `testItemsById` ranges in the active document. The `v2ToV1Captured` translator gains an optional `alSourceFile` argument that callers thread from the test event. The bare-name `testItems` map is removed; per-iteration `currentAppId` field on the controller scopes streaming event lookups to the running app.

**Tech Stack:** TypeScript 5+, VS Code extension API ≥ 1.88 (existing minimum), mocha + `@vscode/test-electron` for tests. No new dependencies.

**Spec reference:** Plan E2 (`docs/superpowers/plans/2026-04-29-alchemist-protocol-v2-consumer-plan-e2.md`) `Known limitations`. Final cross-cutting review on commit `b2455dd` flagged Important #2 (cursor-driven), Important #5 (save-triggered streaming), Minor #7 (testItems collision), Minor #8 (lossiness).

**Branching:** Branch from `feat/protocol-v2-consumer` HEAD (`ebcf4fd`). Plan E2 hasn't merged to master yet; this is a follow-up branch that will merge alongside or after E2.

---

## File Structure

**New files:**
- `src/testing/testFinder.ts` — pure helper: given a `vscode.TextDocument` and `vscode.Position`, plus the controller's `testItemsById`, return the TestItem whose range contains the position (or undefined). Self-contained for unit testing without VS Code activation.
- `test/suite/testFinder.test.ts` — unit tests for the cursor → TestItem lookup.
- `test/suite/saveTriggeredStreaming.test.ts` — integration-style unit tests for the new `runTestsForRequest` public method.

**Modified files:**
- `src/execution/captureValueAdapter.ts` — `v2ToV1Captured` gains an optional `alSourceFile` second argument. Default behavior (no second arg) unchanged for backward compat.
- `src/execution/serverExecutionEngine.ts` — when flattening per-test capturedValues into top-level on the v2 path, pass each test's `alSourceFile` to `v2ToV1Captured`. Same when populating `result.tests[i].capturedValues` via `mapTestEvent`.
- `src/testing/testController.ts`
  - Public `runTestsForRequest(request, token)` exposes the existing private `runTests` body for programmatic save-triggered invocation.
  - `currentAppId` private field set per iteration of the multi-app loop; `handleStreamingEvent` and `applyV1Result` resolve TestItems via `testItemsById` using the current app context.
  - `testItems` (bare-name map) deleted; all readers migrate to `testItemsById`.
  - `updateFromResult` migrated similarly (was a legacy save-path entry — now also goes through compound id).
- `src/extension.ts`
  - Save-triggered runs replace direct `engine.runTests({...})` calls with `testController.runTestsForRequest(request, token)`. Affected-test resolution stays in extension.ts; the request is built from save-router output.
  - New `vscode.window.onDidChangeTextEditorSelection` subscription drives `decorationManager.setActiveTest(testItem.label)` based on cursor position.
- `src/editor/decorations.ts` — `applyInlineCapturedValues`'s file-filter gains a fallback: if `cv.sourceFile` matches the active editor, use as-is; otherwise if `cv.sourceFile` is non-empty and looks like an AL relative path (ends `.al`), accept it. The lossy-objectName case (no `.al` suffix) gets logged once per session as a debug warning instead of silently mismatching.
- `CHANGELOG.md` — v0.5.1 entry.
- `package.json` — version bump to `0.5.1`.

**Files explicitly NOT modified:**
- `src/execution/serverProcess.ts` — the streaming consumer is correct; the bug surface is downstream.
- `src/execution/protocolV2Types.ts` — schema unchanged.
- AL.Runner repo — protocol-v2 wire format unchanged. This plan is ALchemist-only.

---

## Task 1: Setup branch + verify baseline

**Files:** none modified.

- [ ] **Step 1: Branch from feat/protocol-v2-consumer**

```bash
cd U:/Git/ALchemist
git checkout feat/protocol-v2-consumer
git pull --ff-only origin feat/protocol-v2-consumer 2>/dev/null || true
git checkout -b fix/protocol-v2-known-limitations
```

If `git pull` fails (no remote tracking yet), skip — local branch is the source of truth.

- [ ] **Step 2: Confirm baseline build + tests**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

Expected: webpack compiles, 380 unit tests pass (per the bug-fix commit `ebcf4fd`).

- [ ] **Step 3: Note clean state**

```bash
git status
git log --oneline -3
```

If `git status` is unclean, stash or commit.

No commit in this task.

---

## Task 2: `v2ToV1Captured` accepts alSourceFile

**Files:**
- Modify: `src/execution/captureValueAdapter.ts`
- Modify: `src/execution/serverExecutionEngine.ts`
- Modify: `test/suite/coverageAdapter.test.ts` (only if it tests v2ToV1Captured — likely not; that lives in serverExecutionEngine tests)
- Modify: `test/suite/serverExecutionEngine.streaming.test.ts`

**Context:** The existing translator puts `objectName` into `sourceFile`, which mismatches the inline-render filter that compares against editor file paths. The fix is to accept an optional `alSourceFile` (which the test event already carries) and prefer it when present.

- [ ] **Step 1: Read current adapter**

```bash
cat U:/Git/ALchemist/src/execution/captureValueAdapter.ts
```

- [ ] **Step 2: Update the translator signature + body**

Edit `U:/Git/ALchemist/src/execution/captureValueAdapter.ts`:

```typescript
import { CapturedValue as V1CapturedValue } from '../runner/outputParser';
import { CapturedValue as V2CapturedValue } from './protocolV2Types';

/**
 * Translate a v2 `CapturedValue` into the legacy v1 shape used by
 * `DecorationManager.applyInlineCapturedValues` and the OutputChannel.
 *
 * v2 emits `objectName` (the AL codeunit/page name); v1 expects
 * `sourceFile` (a relative AL file path, e.g. `src/Calc.Codeunit.al`).
 * The two are different concepts. To make the inline-render file filter
 * work, callers should pass the test event's `alSourceFile` as the
 * second argument; the translator uses it for `sourceFile` when present.
 *
 * If `alSourceFile` is omitted (legacy callers, defensive default),
 * `objectName` falls back into `sourceFile` — preserving the previous
 * lossy behavior so existing tests still pass and old call sites don't
 * silently break. The DecorationManager filter logs a debug warning
 * when it sees a `sourceFile` that doesn't end in `.al` (Plan E2.1
 * task 7), making the lossy case observable.
 */
export function v2ToV1Captured(
  v2: V2CapturedValue,
  alSourceFile?: string,
): V1CapturedValue {
  return {
    scopeName: v2.scopeName,
    sourceFile: alSourceFile ?? v2.objectName ?? '',
    variableName: v2.variableName,
    value: typeof v2.value === 'string' ? v2.value : JSON.stringify(v2.value),
    statementId: v2.statementId,
  };
}
```

- [ ] **Step 3: Thread alSourceFile in serverExecutionEngine**

Edit `U:/Git/ALchemist/src/execution/serverExecutionEngine.ts`. Find the v2 flatten in `runTests` (around the `tests.flatMap(t => (t.capturedValues ?? []).map(v2ToV1Captured))` line) and the per-test mapping in `mapTestEvent`.

Replace the flatten call:

```typescript
capturedValues: isV2Summary
  ? tests.flatMap(t =>
      (t.capturedValues ?? []).map(cv => v2ToV1Captured(cv, t.alSourceFile)))
  : (response.capturedValues ?? []),
```

In `mapTestEvent` (the per-test translator), the result's `capturedValues` field is currently the v2 wire shape (TS-compatible because `TestResult.capturedValues?: V2CapturedValue[]` per T4). The v2 shape stays — `mapTestEvent` doesn't translate. So no change here.

But `applyResults`-style v2 flatten in DecorationManager (`decorations.ts:applyResults`) calls `v2ToV1Captured` too. Update that call site as well:

```typescript
// In decorations.ts applyResults, the v2 flatten branch:
captured = result.tests.flatMap(t =>
  (t.capturedValues ?? []).map(cv => v2ToV1Captured(cv as V2CapturedValue, t.alSourceFile))
);
```

Verify by grepping:

```bash
grep -rn "v2ToV1Captured" U:/Git/ALchemist/src
```

Every call site should pass `alSourceFile` as the second argument. Two call sites expected: `serverExecutionEngine.ts` and `decorations.ts`.

- [ ] **Step 4: Update existing test that depends on the lossy behavior**

In `U:/Git/ALchemist/test/suite/serverExecutionEngine.streaming.test.ts`, the test added in commit `ebcf4fd` (`v2 flattens per-test capturedValues into top-level result.capturedValues (v1 shape)`) asserts `result.capturedValues[0].sourceFile === 'CodeunitFoo'`. After this task, the assertion changes:

The test event now needs `alSourceFile` set so `sourceFile` reflects the AL file path:

```typescript
test('v2 flattens per-test capturedValues into top-level result.capturedValues (v1 shape)', async () => {
  const ev: any = {
    type: 'test', name: 'A', status: 'pass', durationMs: 1,
    alSourceFile: 'src/Calc.Codeunit.al',
    capturedValues: [
      { scopeName: 's1', objectName: 'CodeunitFoo', variableName: 'x', value: '1', statementId: 0 },
      { scopeName: 's2', objectName: 'CodeunitFoo', variableName: 'y', value: 42, statementId: 1 },
    ],
  };
  const stub = new StubProcess({
    type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2,
  }, [ev]);
  const engine = new ServerExecutionEngine(stub as any);
  const result = await engine.runTests({ sourcePaths: ['./src'] });
  assert.strictEqual(result.capturedValues.length, 2);
  // After Plan E2.1 task 2: sourceFile is the AL file path, not the object name.
  assert.strictEqual(result.capturedValues[0].sourceFile, 'src/Calc.Codeunit.al');
  assert.strictEqual(result.capturedValues[0].variableName, 'x');
  assert.strictEqual(result.capturedValues[0].value, '1');
  assert.strictEqual(result.capturedValues[1].value, '42');
});
```

- [ ] **Step 5: Add a test for the legacy fallback (no alSourceFile)**

Append to the same test file:

```typescript
test('v2ToV1Captured without alSourceFile falls back to objectName (legacy behavior)', () => {
  // Direct unit test of the translator — bypass engine.
  const { v2ToV1Captured } = require('../../src/execution/captureValueAdapter');
  const v2: any = { scopeName: 's', objectName: 'Codeunit Foo', variableName: 'x', value: '1', statementId: 0 };
  const v1 = v2ToV1Captured(v2);
  assert.strictEqual(v1.sourceFile, 'Codeunit Foo');  // legacy lossy fallback
});

test('v2ToV1Captured with alSourceFile prefers it over objectName', () => {
  const { v2ToV1Captured } = require('../../src/execution/captureValueAdapter');
  const v2: any = { scopeName: 's', objectName: 'Codeunit Foo', variableName: 'x', value: '1', statementId: 0 };
  const v1 = v2ToV1Captured(v2, 'src/Foo.al');
  assert.strictEqual(v1.sourceFile, 'src/Foo.al');
});
```

- [ ] **Step 6: Build + run focused tests**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test-compile
npx mocha out/test/suite/serverExecutionEngine.streaming.test.js
```

Expected: 18 + 1 + 1 = 20 tests pass (16 existing in that file + the modified flatten test + 2 new translator unit tests). Adjust the count as needed if other file tests are picked up.

- [ ] **Step 7: Run full suite**

```bash
npm run test:unit
```

Expected: 380 + 2 = 382 passing.

- [ ] **Step 8: Commit**

```bash
git add src/execution/captureValueAdapter.ts \
        src/execution/serverExecutionEngine.ts \
        src/editor/decorations.ts \
        test/suite/serverExecutionEngine.streaming.test.ts
git commit -m "$(cat <<'EOF'
fix(captures): thread alSourceFile through v2ToV1Captured

The lossy translator put v2's objectName ("Codeunit Foo") into v1's
sourceFile slot, breaking the inline-render file filter in
DecorationManager (which compares against editor.uri.fsPath, an AL
file path). After this change, callers pass the test event's
alSourceFile so sourceFile reflects an actual AL file path. The
fallback (no second arg) preserves legacy lossy behavior for any
caller that doesn't have an alSourceFile available.

Closes Plan E2 final-review concern #8 (formerly only documented).
EOF
)"
```

---

## Task 3: Cursor-driven setActiveTest — testFinder helper

**Files:**
- Create: `src/testing/testFinder.ts`
- Create: `test/suite/testFinder.test.ts`

**Context:** Pure helper that given a document URI + cursor position + the controller's `testItemsById` map, returns the TestItem whose range covers the position (or undefined). Self-contained so the cursor-driven wiring in extension.ts (Task 4) is clean.

- [ ] **Step 1: Write failing tests at `test/suite/testFinder.test.ts`**

```typescript
import * as vscode from 'vscode';
import * as assert from 'assert';
import { findTestItemAtPosition } from '../../src/testing/testFinder';

function makeItem(id: string, label: string, uri: vscode.Uri, range: vscode.Range): vscode.TestItem {
  return { id, label, uri, range, children: { add: () => {}, replace: () => {}, get: () => undefined, forEach: () => {}, size: 0 } } as any;
}

suite('findTestItemAtPosition', () => {
  test('returns the TestItem whose range covers the position', () => {
    const uri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(12, 4));
    assert.strictEqual(result?.label, 'Foo');
  });

  test('returns undefined when no test item matches', () => {
    const uri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(20, 0));
    assert.strictEqual(result, undefined);
  });

  test('returns undefined when document URI does not match', () => {
    const itemUri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const otherUri = vscode.Uri.file('/fake/Other.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', itemUri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, otherUri, new vscode.Position(12, 0));
    assert.strictEqual(result, undefined);
  });

  test('multiple matches → returns the smallest enclosing range', () => {
    // Codeunit "FooTest" range covers procedures Foo and Bar. The match should
    // be the inner procedure, not the outer codeunit.
    const uri = vscode.Uri.file('/fake/FooTest.al');
    const codeunit = makeItem('codeunit-1-1', 'FooTest', uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(50, 0)));
    const fooProc = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(codeunit.id, codeunit);
    items.set(fooProc.id, fooProc);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(12, 0));
    assert.strictEqual(result?.label, 'Foo');
  });

  test('only test-prefixed ids considered (codeunit/app items skipped)', () => {
    // The map stores app/codeunit/test items; cursor-driven selection is
    // for tests only. App/codeunit ids should not be returned even if their
    // range covers the position.
    const uri = vscode.Uri.file('/fake/FooTest.al');
    const codeunit = makeItem('codeunit-1-1', 'FooTest', uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(50, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(codeunit.id, codeunit);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(5, 0));
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for empty map', () => {
    const items = new Map<string, vscode.TestItem>();
    const uri = vscode.Uri.file('/fake/x.al');
    const result = findTestItemAtPosition(items, uri, new vscode.Position(0, 0));
    assert.strictEqual(result, undefined);
  });
});
```

- [ ] **Step 2: Run — confirm failure (module missing)**

```bash
cd U:/Git/ALchemist && npm run test-compile && npx mocha out/test/suite/testFinder.test.js
```

Expected: cannot find module `testFinder`.

- [ ] **Step 3: Implement `src/testing/testFinder.ts`**

```typescript
import * as vscode from 'vscode';

/**
 * Find the TestItem whose range covers the given position in the given document.
 * Only items with id starting `test-` are considered (app/codeunit aggregates
 * are excluded). When multiple test items overlap, the smallest enclosing
 * range wins (most specific).
 *
 * Used by extension.ts to drive `DecorationManager.setActiveTest` from
 * `vscode.window.onDidChangeTextEditorSelection`, so the captures shown
 * in the editor track which `[Test]` proc the cursor is in.
 */
export function findTestItemAtPosition(
  testItemsById: ReadonlyMap<string, vscode.TestItem>,
  documentUri: vscode.Uri,
  position: vscode.Position,
): vscode.TestItem | undefined {
  let best: vscode.TestItem | undefined;
  let bestSize = Number.POSITIVE_INFINITY;

  for (const item of testItemsById.values()) {
    if (!item.id.startsWith('test-')) { continue; }
    if (!item.uri || item.uri.fsPath !== documentUri.fsPath) { continue; }
    if (!item.range || !item.range.contains(position)) { continue; }

    const size = (item.range.end.line - item.range.start.line) * 10000
      + (item.range.end.character - item.range.start.character);
    if (size < bestSize) {
      best = item;
      bestSize = size;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run focused tests — verify pass**

```bash
cd U:/Git/ALchemist && npm run test-compile && npx mocha out/test/suite/testFinder.test.js
```

Expected: 6/6 pass.

- [ ] **Step 5: Run full suite**

```bash
npm run test:unit
```

Expected: 382 + 6 = 388 passing.

- [ ] **Step 6: Commit**

```bash
git add src/testing/testFinder.ts test/suite/testFinder.test.ts
git commit -m "feat(testFinder): pure helper for cursor → TestItem resolution"
```

---

## Task 4: Cursor-driven setActiveTest — extension wiring

**Files:**
- Modify: `src/testing/testController.ts` — expose `getTestItemsById()` accessor.
- Modify: `src/extension.ts` — subscribe to `onDidChangeTextEditorSelection`.

- [ ] **Step 1: Add `getTestItemsById` accessor on TestController**

Edit `U:/Git/ALchemist/src/testing/testController.ts`. Find the class declaration and add a public method near the constructor:

```typescript
/**
 * Read-only access to the compound-id TestItem map. Used by the cursor-driven
 * active-test selector (extension.ts). The map updates on
 * `refreshTestsFromModel`; the returned reference reflects the current state
 * but is not stable across refreshes.
 */
getTestItemsById(): ReadonlyMap<string, vscode.TestItem> {
  return this.testItemsById;
}
```

- [ ] **Step 2: Subscribe to onDidChangeTextEditorSelection in extension.ts**

Edit `U:/Git/ALchemist/src/extension.ts`. Find the section where other subscriptions are registered (near the bottom of `activate`, after `testController` is constructed). Add:

```typescript
import { findTestItemAtPosition } from './testing/testFinder';

// (later, in activate() body, after testController is constructed:)
context.subscriptions.push(
  vscode.window.onDidChangeTextEditorSelection((e) => {
    if (!testController || !decorationManager) { return; }
    const editor = e.textEditor;
    if (editor.document.languageId !== 'al') { return; }
    const items = testController.getTestItemsById();
    const item = findTestItemAtPosition(items, editor.document.uri, editor.selection.active);
    decorationManager.setActiveTest(item?.label);
    // Re-apply decorations to reflect the new active test's captures.
    if (lastExecutionResult) {
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (wsf) {
        decorationManager.applyResults(editor, lastExecutionResult, wsf.uri.fsPath);
      }
    }
  })
);
```

The `lastExecutionResult` and `decorationManager.applyResults` references already exist in `extension.ts`; reuse them. If the variable name differs in the actual source, adapt.

- [ ] **Step 3: Add an integration-style test**

Append to `U:/Git/ALchemist/test/integration/protocolV2.itest.ts`:

```typescript
test('cursor-driven setActiveTest fires when cursor moves into a [Test] proc', async () => {
  const vscode = require('vscode');
  // Build a minimal controller + workspace.
  const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
  await model.scan();
  const engine = new FakeStreamingEngine([], { type: 'summary', exitCode: 0,
    passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2 });
  const controller = new AlchemistTestController(() => engine, model, () => {});
  await controller.refreshTestsFromModel(model);

  const items = controller.getTestItemsById();
  assert.ok(items.size > 0, 'controller must populate testItemsById from fixture');

  // Stub a fake document + position that overlaps a known TestItem.
  // Walk testItemsById to find one with a uri + range.
  let target: vscode.TestItem | undefined;
  for (const item of items.values()) {
    if (item.id.startsWith('test-') && item.uri && item.range) {
      target = item;
      break;
    }
  }
  assert.ok(target, 'fixture must have at least one test item with uri + range');

  const { findTestItemAtPosition } = require('../../src/testing/testFinder');
  const found = findTestItemAtPosition(items, target!.uri!, target!.range!.start);
  assert.strictEqual(found?.label, target!.label);

  controller.dispose();
});
```

- [ ] **Step 4: Build + run**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

Expected: 388 unit tests pass.

```bash
npm run test:integration
```

Expected: 6 + 1 = 7 integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/testController.ts src/extension.ts test/integration/protocolV2.itest.ts
git commit -m "$(cat <<'EOF'
feat(active-test): cursor-driven selection via onDidChangeTextEditorSelection

The active-test selection was the Option A heuristic in Plan E2 (most-recent
streaming test wins). This wires Option B: when the user moves the cursor
into a [Test] proc, that test becomes active and DecorationManager re-applies
inline decorations to show only that test's captures.

Closes Plan E2 final-review concern #2 (formerly only Option A wired).
EOF
)"
```

---

## Task 5: Eliminate `testItems` (bare-name) collision risk

**Files:**
- Modify: `src/testing/testController.ts`

**Context:** The bare-name `testItems` map collides in multi-app workspaces with same-named tests. The `testItemsById` map (compound id `test-<appId>-<codeunitId>-<name>`) doesn't collide. To migrate, every reader of `testItems` needs app context. The multi-app loop iterates per app and already knows the appId; carry it via a private `currentAppId` field set during the loop.

- [ ] **Step 1: Add `currentAppId` field and a lookup helper**

Edit `U:/Git/ALchemist/src/testing/testController.ts`:

```typescript
private currentAppId: string | undefined;

/**
 * Resolve a TestItem by procedure name in the context of the currently-running
 * app. Used by handleStreamingEvent and applyV1Result to map a v2 TestEvent
 * (which carries only the procedure name, no app context) back to the
 * compound-id TestItem.
 *
 * For multi-app workspaces with same-named tests across apps, the appId
 * scope avoids collisions. When no run is active (currentAppId undefined),
 * the lookup falls back to walking testItemsById and returning any test
 * with a matching label — preserves single-app behavior at the cost of
 * the documented collision risk in legacy save paths.
 */
private resolveTestItemByName(testName: string): vscode.TestItem | undefined {
  if (this.currentAppId) {
    // Compound-id format: test-<appId>-<codeunitId>-<name>
    // We don't know codeunitId at the call site, so iterate items in this app.
    const prefix = `test-${this.currentAppId}-`;
    for (const [id, item] of this.testItemsById) {
      if (id.startsWith(prefix) && item.label === testName) {
        return item;
      }
    }
    return undefined;
  }
  // Fallback: any app, first match.
  for (const item of this.testItemsById.values()) {
    if (item.id.startsWith('test-') && item.label === testName) {
      return item;
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Wire `currentAppId` in the multi-app loop**

In `runTests` (the public/private method that drives the streaming loop), the multi-app loop iterates `appsToRun`. Set `currentAppId` at the top of each iteration; clear in the `finally` (or before the next iteration):

```typescript
try {
  for (const app of appsToRun) {
    if (token.isCancellationRequested) { break; }
    this.currentAppId = app.id;
    // ... existing per-app body ...
  }
} finally {
  this.currentAppId = undefined;
  // ... existing cleanup (cancelSub.dispose, run.skipped, run.end) ...
}
```

Single-app fallback (legacy mode without `this.model`): set `currentAppId = undefined` (already the default) so the fallback path in `resolveTestItemByName` runs.

- [ ] **Step 3: Replace every `this.testItems.get(...)` with `this.resolveTestItemByName(...)`**

Use Edit to replace these specific call sites:

- Line ~181 in `updateFromResult`: `const item = this.testItems.get(testResult.name);` → `const item = this.resolveTestItemByName(testResult.name);`
- Line ~322 in `handleStreamingEvent`: `const item = this.testItems.get(event.name);` → `const item = this.resolveTestItemByName(event.name);`
- Line ~436 in `applyV1Result`: `const item = this.testItems.get(t.name);` → `const item = this.resolveTestItemByName(t.name);`

The `set` and `clear` call sites at lines ~139, ~156, ~470, ~496 — delete them entirely. The bare-name map is no longer maintained.

Also: delete the `testItems` field declaration. The `testItemsById` map stays.

- [ ] **Step 4: Update `updateFromResult`'s currentAppId concern**

`updateFromResult` is the legacy save-triggered entry point. It runs OUTSIDE the multi-app loop, so `currentAppId` is undefined when it executes. The fallback in `resolveTestItemByName` walks all items — same behavior as before for single-app, but for multi-app it returns the first match.

To make this safe in multi-app, `updateFromResult` should accept an `appId` argument (or be deprecated entirely after Task 6's save-streaming refactor — see plan note). For now, add the parameter:

```typescript
updateFromResult(result: ExecutionResult, appId?: string): void {
  if (result.mode !== 'test') { return; }
  const prevAppId = this.currentAppId;
  this.currentAppId = appId ?? prevAppId;
  try {
    // ... existing body using resolveTestItemByName ...
  } finally {
    this.currentAppId = prevAppId;
  }
}
```

Update callers in `extension.ts` to pass the app id when known. Save-router output already carries the app context. If a caller doesn't have app context, leave the second arg undefined — the fallback path handles it.

- [ ] **Step 5: Update tests that reference `testItems`**

Grep for tests accessing the bare-name map:

```bash
grep -rn "testItems\b" U:/Git/ALchemist/test
```

Tests that asserted controller-internal state via `controller.testItems` need to migrate to `getTestItemsById`. If a test is expected to fail because it asserts on the bare-name map, document and remove the assertion (since the underlying behavior — TestItem lookup — is preserved via the resolver).

The streaming tests in `testController.streaming.test.ts` may construct expectations like "controller has TestItem for `MyTest`". Migrate to "controller has TestItem with label `MyTest` resolvable via the by-id map".

- [ ] **Step 6: Build + run**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

Expected: 388 (or whatever the post-Task-3+4 baseline is) — no regression. If a test breaks because it asserted bare-name lookup, update or remove.

- [ ] **Step 7: Commit**

```bash
git add src/testing/testController.ts \
        src/extension.ts \
        test/suite/testController.streaming.test.ts \
        test/suite/testController.multiApp.test.ts
git commit -m "$(cat <<'EOF'
refactor(testController): drop bare-name testItems map, scope by currentAppId

Multi-app workspaces with same-named tests across apps could collide on
the bare-name testItems lookup. Resolution now goes through
testItemsById, scoped to the currently-running app via a transient
currentAppId field set in the multi-app loop. updateFromResult
(legacy save-triggered entry) accepts an optional appId; the fallback
path preserves single-app behavior.

Closes Plan E2 final-review concern #7.
EOF
)"
```

---

## Task 6: Save-triggered runs through the streaming pipeline

**Files:**
- Modify: `src/testing/testController.ts` — add public `runTestsForRequest(request, token)`.
- Modify: `src/extension.ts` — save handlers construct a TestRunRequest and call the public method.
- Create: `test/suite/saveTriggeredStreaming.test.ts`

**Context:** Save-triggered runs in `extension.ts` currently call `engine.runTests({...})` directly, bypassing the TestController's run-profile callback. Result: no TestRun is created, so `run.passed/failed`, `run.addCoverage`, and clickable stack frames don't fire on save. To fix, route save runs through `runTestsForRequest`.

- [ ] **Step 1: Expose `runTestsForRequest`**

In `testController.ts`, the existing private `runTests(request, token)` is the run-profile callback. Add a public method that delegates to it:

```typescript
/**
 * Programmatically execute a TestRun, equivalent to the user clicking Run
 * in Test Explorer. Used by save-triggered runs (extension.ts) so they get
 * the same v2 streaming features (progressive run.passed/failed, addCoverage,
 * clickable stack frames) as Test-Explorer-initiated runs.
 *
 * The request.include should contain TestItems (from getTestItemsById)
 * for the affected tests; if empty, the run iterates every app like
 * "Run All" does.
 */
async runTestsForRequest(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  await this.runTests(request, token);
}
```

If the existing `runTests` is private, change to `private` body wrapped by the public delegator (above). If already public, this is a thin alias for clarity.

- [ ] **Step 2: Refactor save handlers in extension.ts**

Find the save-triggered run sites in `extension.ts` (per `git grep handleResult` and the runNow/save handlers around lines 220-280, 340-380). Each call currently looks like:

```typescript
const result = await engine.runTests({ sourcePaths, captureValues: true, iterationTracking: true, coverage: true });
handleResult(result);
```

Replace with TestController routing. Build a TestRunRequest with the affected test items:

```typescript
import * as vscode from 'vscode';

async function runViaController(
  affectedAppIds: string[],
  affectedTestNames: string[] | undefined,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!testController) { return; }
  let include: vscode.TestItem[] | undefined;
  if (affectedTestNames && affectedTestNames.length > 0) {
    const items = testController.getTestItemsById();
    include = [];
    for (const appId of affectedAppIds) {
      for (const [id, item] of items) {
        if (!id.startsWith(`test-${appId}-`)) { continue; }
        if (affectedTestNames.includes(item.label)) {
          include.push(item);
        }
      }
    }
  }
  const request = new vscode.TestRunRequest(include, undefined, undefined);
  await testController.runTestsForRequest(request, token);
}
```

Replace each `engine.runTests({...}); handleResult(...)` block with a call to `runViaController(...)`. The `handleResult` callback fires from within `runTestsForRequest` because TestController already invokes `onResult` per app iteration; the cb in `extension.ts` receives the result and runs DecorationManager apply etc.

Save-router output: `affectedAppIds` and `affectedTestNames` come from the existing routing logic. Don't change that — just thread its output into `runViaController`.

If a save handler doesn't have affected-test names (e.g. force-fallback / Run Wider Scope), pass `undefined` so the request runs all tests in the affected apps.

- [ ] **Step 3: Cancellation token for save runs**

Save handlers don't currently get a cancellation token. Create one per save:

```typescript
const cts = new vscode.CancellationTokenSource();
try {
  await runViaController(affectedAppIds, affectedTestNames, cts.token);
} finally {
  cts.dispose();
}
```

Optional: tie the token to a global "save run in progress" cancel command if Plan E2 already exposes one. If not, leave the per-save CTS as a future hook.

- [ ] **Step 4: Test at `test/suite/saveTriggeredStreaming.test.ts`**

```typescript
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import { AlchemistTestController } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { ExecutionEngine, RunTestsRequest } from '../../src/execution/executionEngine';
import { ExecutionResult } from '../../src/runner/outputParser';
import { TestEvent } from '../../src/execution/protocolV2Types';

class StreamingFakeEngine implements ExecutionEngine {
  public lastReq?: RunTestsRequest;
  public lastOnTest?: (e: TestEvent) => void;
  constructor(private readonly events: TestEvent[], private readonly summary: ExecutionResult) {}
  async runTests(req: RunTestsRequest, onTest?: (e: TestEvent) => void): Promise<ExecutionResult> {
    this.lastReq = req;
    this.lastOnTest = onTest;
    if (onTest) for (const e of this.events) { onTest(e); }
    return this.summary;
  }
  async executeScratch(): Promise<ExecutionResult> { throw new Error(); }
  isHealthy(): boolean { return true; }
  async cancel(): Promise<void> { /* */ }
  async dispose(): Promise<void> { /* */ }
}

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('Save-triggered streaming via runTestsForRequest', () => {
  test('runTestsForRequest with empty include runs all apps (like Run All)', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const engine = new StreamingFakeEngine([], {
      mode: 'test', tests: [], messages: [], stderrOutput: [],
      summary: { passed: 0, failed: 0, errors: 0, total: 0 },
      coverage: [], exitCode: 0, durationMs: 1, capturedValues: [],
      cached: false, iterations: [], protocolVersion: 2,
    });
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);
    const request = new vscode.TestRunRequest();
    const cts = new vscode.CancellationTokenSource();
    await controller.runTestsForRequest(request, cts.token);
    assert.ok(engine.lastOnTest, 'engine.runTests must receive onTest callback');
    controller.dispose();
    cts.dispose();
  });

  test('runTestsForRequest with include narrows to those test items', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const engine = new StreamingFakeEngine([], {
      mode: 'test', tests: [], messages: [], stderrOutput: [],
      summary: { passed: 0, failed: 0, errors: 0, total: 0 },
      coverage: [], exitCode: 0, durationMs: 1, capturedValues: [],
      cached: false, iterations: [], protocolVersion: 2,
    });
    const controller = new AlchemistTestController(() => engine, model, () => {});
    await controller.refreshTestsFromModel(model);
    const items = controller.getTestItemsById();
    // Pick the first test-prefixed item.
    let include: vscode.TestItem | undefined;
    for (const item of items.values()) {
      if (item.id.startsWith('test-')) { include = item; break; }
    }
    assert.ok(include);
    const request = new vscode.TestRunRequest([include!]);
    const cts = new vscode.CancellationTokenSource();
    await controller.runTestsForRequest(request, cts.token);
    assert.ok(engine.lastReq, 'engine.runTests must have been called');
    controller.dispose();
    cts.dispose();
  });
});
```

- [ ] **Step 5: Build + run**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

Expected: 388 + 2 = 390 passing (or N + 2 for whatever the actual baseline is by this point).

- [ ] **Step 6: Manual smoke (optional, recommend)**

In an Extension Development Host:
1. Open a multi-app fixture.
2. Save a test file.
3. Confirm Test Explorer pass/fail marks appear progressively.
4. Confirm coverage gutters render (Run with Coverage profile).
5. Confirm clickable stack frames on failures.

If any of these don't work, the `runTestsForRequest` wiring is off. STOP and report.

- [ ] **Step 7: Commit**

```bash
git add src/testing/testController.ts \
        src/extension.ts \
        test/suite/saveTriggeredStreaming.test.ts
git commit -m "$(cat <<'EOF'
feat(save): route save-triggered runs through runTestsForRequest

Save-triggered runs in extension.ts called engine.runTests({...}) directly,
bypassing TestController's run profile. Result: no TestRun created → no
streaming run.passed/failed, no addCoverage, no clickable stack frames
on save.

This change exposes runTestsForRequest as a public API on TestController
and threads save-router output (affected app ids + test names) into a
programmatic TestRunRequest. Save runs now get the same v2 features as
Test-Explorer-initiated runs.

Closes Plan E2 known limitation #1.
EOF
)"
```

---

## Task 7: DecorationManager file-filter robustness

**Files:**
- Modify: `src/editor/decorations.ts`

**Context:** `applyInlineCapturedValues` filters captured values by `cv.sourceFile === editor.uri.fsPath`. After Task 2, the v2 path passes `alSourceFile` so the match works. But for any caller that still doesn't pass `alSourceFile`, the legacy `objectName` lossy fallback means the filter silently drops everything. Add a one-time per-session warning when the filter sees a `sourceFile` that doesn't end `.al`, so the lossy case is observable.

- [ ] **Step 1: Add a logged-once warning**

Edit `U:/Git/ALchemist/src/editor/decorations.ts`. In `applyInlineCapturedValues` near the filter:

```typescript
private warnedLossy = false;

private applyInlineCapturedValues(
  editor: vscode.TextEditor,
  capturedValues: CapturedValue[],
  coverage: CoverageEntry[],
  workspacePath: string,
): void {
  if (capturedValues.length === 0) return;

  // Detect lossy v2-translated values once per session: a sourceFile that
  // doesn't end .al likely came from objectName fallback in v2ToV1Captured.
  if (!this.warnedLossy && capturedValues.some(cv => cv.sourceFile && !cv.sourceFile.toLowerCase().endsWith('.al'))) {
    console.warn(
      '[ALchemist] Captured values arrived with non-.al sourceFile (likely lossy v2 translation).',
      'Inline render filter may drop them. See Plan E2.1 task 2 for details.',
    );
    this.warnedLossy = true;
  }

  // ... existing filter + render logic ...
}
```

- [ ] **Step 2: Add a focused unit test**

Append to `U:/Git/ALchemist/test/suite/decorationManager.perTest.test.ts`:

```typescript
test('lossy non-.al sourceFile triggers one-time console.warn', () => {
  const fakeEditor = { setDecorations: () => {}, document: { uri: { fsPath: '/ws/Foo.al' } } } as any;
  const dm = new DecorationManager(__dirname);
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  try {
    const lossy = [{ scopeName: 's', sourceFile: 'Codeunit Foo', variableName: 'x', value: '1', statementId: 0 }];
    dm['applyInlineCapturedValues'](fakeEditor, lossy as any, [], '/ws');
    dm['applyInlineCapturedValues'](fakeEditor, lossy as any, [], '/ws');
    assert.strictEqual(warnings.filter(w => w.includes('lossy v2 translation')).length, 1,
      'warning fires exactly once across multiple invocations');
  } finally {
    console.warn = origWarn;
  }
});
```

(The `dm['applyInlineCapturedValues']` cast is to bypass the `private` modifier — acceptable in test code; if the existing test file already has a pattern for accessing privates, follow it.)

- [ ] **Step 3: Build + run**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

- [ ] **Step 4: Commit**

```bash
git add src/editor/decorations.ts test/suite/decorationManager.perTest.test.ts
git commit -m "feat(decorations): warn once on lossy non-.al sourceFile (v2 translation)"
```

---

## Task 8: Sweep stale planning comments + final regression

**Files:**
- Modify: `src/editor/decorations.ts`, `src/testing/testController.ts` — comment sweeps.

- [ ] **Step 1: Find planning placeholders**

```bash
grep -rnE 'T9 will|T10 will|deferred|stopgap|TODO.*setActiveTest|TODO.*save' U:/Git/ALchemist/src
```

For each match: confirm whether the deferred work has now been done (Plan E2.1 closes most of them). Update the comment to reflect post-E2.1 reality, or delete if the comment has lost meaning.

Specific locations from the final review:
- `decorations.ts:212` — references the LEGACY_SCOPE_KEY stopgap. After Task 2 + Task 6, the v2 path correctly populates per-test scope with usable sourceFile. Update or delete the stopgap note.
- `testController.ts:158` — references "T10 will revisit" for `updateFromResult`. After Task 5 + Task 6, save-triggered runs go through `runTestsForRequest` and `updateFromResult` is no longer the primary save entry point. Update to: "Legacy save-on-save callback path used when `runTestsForRequest` cannot construct a request (e.g. router fell back). Prefer the streaming path; this fallback is here for resilience."
- `testController.ts:469` — references the bare-name `testItems` removal. After Task 5, the field is gone. Delete the comment.

- [ ] **Step 2: Final full-suite regression**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
npm run test:integration
```

Expected: every suite green. Note exact counts in the commit message.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "chore: sweep stale planning comments after E2.1 lands"
```

---

## Task 9: CHANGELOG + version bump to 0.5.1

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

Edit `U:/Git/ALchemist/package.json`:

```diff
-  "version": "0.5.0",
+  "version": "0.5.1",
```

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `U:/Git/ALchemist/CHANGELOG.md`:

```markdown
## 0.5.1 (2026-04-XX)

### Fixes (closing v0.5.0 known limitations)

- **Save-triggered runs now stream.** Save-on-save and Run Now both go through `TestController.runTestsForRequest`, gaining live Test Explorer updates, native coverage rendering, and clickable stack frames previously only available on Test-Explorer-initiated runs.
- **Cursor-driven active test.** Moving the cursor into a `[Test]` proc sets that test as active in DecorationManager, so the captured-value decorations show only that test's values. Replaces the v0.5.0 Option A "most-recent streaming test wins" heuristic.
- **Captured values render correctly on the v2 path.** `v2ToV1Captured` now threads the test event's `alSourceFile` into the v1 `sourceFile` slot. The inline-render file filter in DecorationManager matches against the editor's AL file path correctly. The previous lossy translation (objectName → sourceFile) silently dropped captures from inline rendering.
- **Multi-app `testItems` collision risk eliminated.** The bare-name `testItems` map was removed; TestItem resolution now uses compound `testItemsById` keys scoped to the running app via a transient `currentAppId` field. Multi-app workspaces with same-named tests across apps no longer cross-fire.

### Internal

- New `src/testing/testFinder.ts` — pure helper for cursor → TestItem resolution.
- `TestController.runTestsForRequest(request, token)` — new public API for programmatic runs.
- `TestController.getTestItemsById()` — read-only accessor for the cursor-driven selector.
- `v2ToV1Captured(v2, alSourceFile?)` — second arg threads the AL file path; legacy single-arg behavior preserved for backward compat.
- DecorationManager logs a one-time per-session warning when it observes lossy non-`.al` sourceFile values (helps diagnose future translation regressions).

### Migration

No user action required. v0.5.0 settings continue to work unchanged.
```

Replace `(2026-04-XX)` with the actual release date when ready.

- [ ] **Step 3: Final build + test**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to v0.5.1 — close protocol-v2 known limitations"
```

---

## Self-Review

**1. Spec coverage (against the four documented limitations + final review concerns):**

| Concern | Source | Task |
|---|---|---|
| Save-triggered runs use v1 path | E2 CHANGELOG limitation #1 + final review #5 | Task 6 ✓ |
| Per-test active-test heuristic | E2 CHANGELOG limitation #2 + final review #2 | Task 3 + Task 4 ✓ |
| `v2ToV1Captured` lossy → broken inline filter | Final review #8 + user bug report | Task 2 ✓ |
| `testItems` bare-name collision | Final review #7 | Task 5 ✓ |
| Stale planning comments | Final review #6 | Task 8 ✓ |
| Lossy translation observability | Defensive add | Task 7 ✓ |
| CHANGELOG / version | Release hygiene | Task 9 ✓ |

All known limitations mapped.

**2. Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" patterns. The smoke step in Task 6 step 6 says "if any don't work … STOP and report" — that's a real failure path, not a placeholder.

**3. Type consistency:**
- `findTestItemAtPosition(testItemsById, uri, position)` defined in Task 3, used in Task 4.
- `getTestItemsById()` defined in Task 4, used by Task 6's `runViaController`.
- `runTestsForRequest(request, token)` defined in Task 6.
- `currentAppId` field added in Task 5 with `resolveTestItemByName(name)`; consumed (transitively via the resolver) in Task 6's streaming path.
- `v2ToV1Captured(v2, alSourceFile?)` updated in Task 2; all call sites updated in the same task.

No drift across tasks.

---

## Out of scope

- Anything that requires a wire-format change in AL.Runner (e.g. emitting per-capture file path explicitly). The current consumer-side fix uses `event.alSourceFile` heuristically, which is good enough for typical "test file = file with the cursor" UX.
- Plan E3 (Sentinel verification + AL.Runner upstream PR splits).
- Per-test caching (AL.Runner roadmap doc 08).
- AL Debug Adapter Protocol.
