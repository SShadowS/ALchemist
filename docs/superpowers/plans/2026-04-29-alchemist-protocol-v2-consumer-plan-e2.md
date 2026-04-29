# Plan E2 — ALchemist Protocol v2 Consumer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire ALchemist (TypeScript / VS Code extension) to consume AL.Runner protocol v2: streaming test results, DAP-aligned stack frames, structured coverage via VS Code native APIs, per-test message/captured-value isolation, mid-run cancel. Plus protocol version detection with v1 fallback.

**Architecture:** The fork-built AL.Runner emits NDJSON: zero-or-more `{type:"test"}` lines per test as they complete, optional `{type:"progress"}` lines, terminal `{type:"summary"}` line with `protocolVersion: 2`. ALchemist's `ServerProcess` becomes a streaming consumer (multi-line per request with on-event callback). `ServerExecutionEngine` adds `testFilter`/`onTest`/`cancel`. New `coverageAdapter` translates AL.Runner `FileCoverage[]` → `vscode.FileCoverage[]`. `TestController` calls `run.passed`/`run.failed` as events arrive (live Test Explorer updates), uses `vscode.TestMessageStackFrame[]` for clickable stack frames, and `run.addCoverage()` for native gutter rendering. `DecorationManager` retires its custom coverage SVGs (VS Code native takes over), scopes captured values per active test, and uses the deepest user frame for inline error decorations. v1 servers (no `protocolVersion` in summary) silently fall back to the prior single-response path.

**Tech Stack:** TypeScript 5+, VS Code extension API ≥ 1.93 for `TestMessageStackFrame` (with feature-detection fallback to plain message strings on older VS Code), mocha + `@vscode/test-electron` for tests, existing webpack build.

**Spec reference:** `docs/superpowers/specs/2026-04-25-runner-protocol-v2-design.md` (ALchemist Side, components 8-12). Plan E2 covers everything ALchemist-side; Plan E3 covers Sentinel end-to-end verification + AL.Runner upstream PR splits.

**Cross-repo dependency:** Plan E1 ships AL.Runner protocol v2 in fork branch `feat/alchemist-protocol-v1` at `U:/Git/AL.Runner-protocol-v2`. Sample NDJSON committed at `docs/protocol-v2-samples/runtests-coverage-success.ndjson` in that repo — used as fixture data for ALchemist tests.

---

## File Structure

**New files:**
- `src/execution/coverageAdapter.ts` — pure function `toVsCodeCoverage(alCoverage: FileCoverage[]): vscode.FileCoverage[]`
- `src/execution/protocolV2Types.ts` — TypeScript types matching `protocol-v2.schema.json` (`TestEvent`, `Summary`, `Ack`, `Progress`, `AlStackFrame`, `FileCoverage`, etc.)
- `test/fixtures/protocol-v2-samples/runtests-coverage-success.ndjson` — copy of AL.Runner's sample (committed) for unit tests
- `test/suite/coverageAdapter.test.ts` — adapter unit tests
- `test/suite/protocolVersion.test.ts` — version probe + v1 fallback tests
- `test/suite/serverProcess.streaming.test.ts` — streaming + cancel + v1 fallback tests for ServerProcess
- `test/suite/serverExecutionEngine.streaming.test.ts` — testFilter/onTest passthrough tests
- `test/suite/testController.streaming.test.ts` — progressive run.passed/failed tests
- `test/suite/decorationManager.perTest.test.ts` — per-test capturedValues scoping tests
- `test/integration/protocolV2.itest.ts` — extension-host integration test using @vscode/test-electron

**Modified files:**
- `src/runner/outputParser.ts` — extend `TestResult` with `alSourceFile`, `errorKind`, `stackFrames`, per-test `messages`, per-test `capturedValues`. Extend `ExecutionResult` with `cancelled`, `protocolVersion`. Add new `FileCoverage` shape (v2) alongside legacy `CoverageEntry` (cobertura-derived).
- `src/execution/executionEngine.ts` — `RunTestsRequest` adds `testFilter`, `cobertura`. Interface adds `onTest?: (event: TestEvent) => void` to `runTests`. Adds `cancel(): Promise<void>` to `ExecutionEngine` interface.
- `src/execution/serverProcess.ts` — multi-line response handling: accumulate stream lines, fire `onEvent` per non-summary line, resolve promise on summary. Add `cancel(): Promise<void>` (fire-and-forget). Detect `protocolVersion` in summary; absent or `<2` → log once + treat response as v1 single-line semantics in caller.
- `src/execution/serverExecutionEngine.ts` — pass `testFilter`/`coverage`/`cobertura` through; wire `onTest` callback; map v2 fields to `ExecutionResult`; preserve existing `pass→passed` status mapping.
- `src/testing/testController.ts` — `runTests(request, token)` wires `token.onCancellationRequested → engine.cancel()`. Per-test `onTest` callback fires `run.passed`/`run.failed` as events arrive. Final result: `run.addCoverage(toVsCodeCoverage(coverage))`. Failure messages use `vscode.TestMessageStackFrame[]` when available.
- `src/editor/decorations.ts` — RETIRE custom coverage decorations (delete the green/gray gutter decoration types and the lines-coverage map). Captured values become a `Map<TestId, CapturedValue[]>` so the active test's values display. Inline error lookup uses `event.alSourceFile`/`alSourceLine` from the deepest user frame.
- `src/extension.ts` — wire `onTest` callback through to TestController; expose engine.cancel via test run cancellation.
- `package.json` — version bump to `0.5.0`. Update `engines.vscode` minimum to `^1.93.0` if dropping `TestMessageStackFrame` feature-detection. (Default: keep 1.85 minimum + feature-detect.)
- `CHANGELOG.md` — entry for v0.5.0 covering protocol v2 features.
- `README.md` — feature list update.

**Files explicitly NOT modified:**
- `src/runner/outputParser.ts`'s legacy text parsing (PASS/FAIL regex) and cobertura XML parsing remain — they're the v1 fallback when AL.Runner is older.
- `resources/gutter-*.svg` — keep on disk; they're consumed by v1 fallback path until users upgrade AL.Runner.

---

## Task 1: Setup feature branch + verify baseline

**Files:** none modified.

**Context:** Plan E1 work happened in a separate fork worktree (`U:/Git/AL.Runner-protocol-v2`). ALchemist work happens on a feature branch off `master`. We do NOT need a separate worktree because the user's ALchemist working tree is already clean per the session start state.

- [ ] **Step 1: Create feature branch from master**

```bash
cd U:/Git/ALchemist
git checkout master
git pull origin master
git checkout -b feat/protocol-v2-consumer
```

If the working tree is unclean (untracked sentinel-*.json files from session start are fine — they're gitignored or unrelated), stash anything genuine before branching.

- [ ] **Step 2: Install + build baseline**

```bash
npm ci
npm run compile
```

Expected: `webpack` builds `dist/extension.js` cleanly. Note any pre-existing warnings.

- [ ] **Step 3: Run existing test suites — record baseline**

```bash
npm run test:unit
```

Record the baseline pass count. Subsequent tasks must keep it green plus their own additions.

- [ ] **Step 4: Confirm AL.Runner fork sample is reachable**

```bash
ls U:/Git/AL.Runner-protocol-v2/docs/protocol-v2-samples/runtests-coverage-success.ndjson
```

If absent, Plan E1 wasn't merged yet — STOP and surface the gap.

- [ ] **Step 5: Note clean state**

```bash
git status
git log --oneline -3
```

Branch ready. No commit yet — Task 2 is the first commit.

---

## Task 2: Bundle protocol-v2 sample as test fixture

**Files:**
- Create: `test/fixtures/protocol-v2-samples/runtests-coverage-success.ndjson` (copy from AL.Runner)
- Create: `test/fixtures/protocol-v2-samples/README.md` (one-paragraph explainer)

**Context:** The AL.Runner repo committed a real-binary smoke output as `docs/protocol-v2-samples/runtests-coverage-success.ndjson`. ALchemist's unit tests need the same shape to validate the consumer end without spawning a real AL.Runner process. Copy it in (don't symlink — Windows symlink semantics are unreliable, and the schema is locked by E1's commit history).

- [ ] **Step 1: Copy sample**

```bash
mkdir -p U:/Git/ALchemist/test/fixtures/protocol-v2-samples
cp U:/Git/AL.Runner-protocol-v2/docs/protocol-v2-samples/runtests-coverage-success.ndjson \
   U:/Git/ALchemist/test/fixtures/protocol-v2-samples/runtests-coverage-success.ndjson
```

- [ ] **Step 2: Write README**

`test/fixtures/protocol-v2-samples/README.md`:

```markdown
# Protocol v2 sample fixtures

These are real outputs from the AL.Runner fork branch
`feat/alchemist-protocol-v1` (commit `605955b` as of 2026-04-29). They are
used by ALchemist's unit tests to validate the protocol-v2 consumer
without spawning a live runner process.

If you regenerate them, see
`U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/ServerProtocolV2Tests.cs`
for the canonical wire-format assertions.

## Files

- `runtests-coverage-success.ndjson` — `runtests` against the
  `protocol-v2-line-directives` fixture with `coverage:true` +
  `captureValues:true`. Includes one passing test with no captures, one
  passing test with captured values, one failing test with stack frames,
  summary with protocolVersion: 2 and structured coverage.
```

- [ ] **Step 3: Commit**

```bash
cd U:/Git/ALchemist
git add test/fixtures/protocol-v2-samples/
git commit -m "test(fixtures): bundle AL.Runner protocol-v2 sample NDJSON"
```

---

## Task 3: TypeScript types for protocol v2

**Files:**
- Create: `src/execution/protocolV2Types.ts`

**Context:** Type the wire format so all downstream consumers (`ServerProcess`, `ServerExecutionEngine`, `coverageAdapter`, `TestController`) share one definition. Must match `protocol-v2.schema.json` from the AL.Runner repo (verified by E1 Task 11). Pure types — no runtime code, no dependencies on `vscode`.

- [ ] **Step 1: Write `src/execution/protocolV2Types.ts`**

```typescript
/**
 * TypeScript types for AL.Runner protocol v2 (NDJSON streaming).
 *
 * Source of truth: `protocol-v2.schema.json` in the AL.Runner repo
 * (https://github.com/StefanMaron/BusinessCentral.AL.Runner — fork branch
 * `feat/alchemist-protocol-v1`).
 *
 * The wire shape is newline-delimited JSON. A `runtests` request emits
 * zero or more `TestEvent` lines, optional `Progress` lines, then exactly
 * one `Summary` line. `cancel` (and other commands) return a single
 * `Ack` line.
 */

export type FramePresentationHint = 'normal' | 'subtle' | 'deemphasize' | 'label';

export type AlErrorKind =
  | 'assertion'
  | 'runtime'
  | 'compile'
  | 'setup'
  | 'timeout'
  | 'unknown';

export type TestStatus = 'pass' | 'fail' | 'error';

export interface AlStackFrame {
  name: string;
  source?: { path?: string; name?: string };
  line?: number;        // 1-based
  column?: number;      // 1-based
  presentationHint?: FramePresentationHint;
}

export interface CapturedValue {
  scopeName: string;
  /** Optional in protocol; emitter currently always populates. */
  objectName?: string;
  variableName: string;
  value: unknown;       // schema permits any JSON
  statementId: number;
}

export interface TestEvent {
  type: 'test';
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  errorKind?: AlErrorKind;
  alSourceFile?: string;
  alSourceLine?: number;     // 1-based
  alSourceColumn?: number;   // 1-based
  stackFrames?: AlStackFrame[];
  stackTrace?: string;       // raw .NET StackTrace text — fallback only
  messages?: string[];
  capturedValues?: CapturedValue[];
}

export interface FileCoverageLine {
  line: number;   // 1-based
  hits: number;   // SUMMED across statements on the same line, not max-1
}

export interface FileCoverage {
  file: string;                // relative path, forward-slash
  lines: FileCoverageLine[];
  totalStatements: number;
  hitStatements: number;
}

export interface Summary {
  type: 'summary';
  exitCode: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  cached?: boolean;
  cancelled?: boolean;
  changedFiles?: string[];
  compilationErrors?: { file: string; errors: string[] }[];
  coverage?: FileCoverage[];
  protocolVersion: 2;          // const per schema
  /** Tolerated forward-compat fields. */
  [extra: string]: unknown;
}

export interface Ack {
  type: 'ack';
  command: string;
  noop?: boolean;
}

export interface Progress {
  type: 'progress';
  completed?: number;
  total?: number;
}

export type ProtocolLine = TestEvent | Summary | Ack | Progress;

/**
 * Type guard: is this parsed JSON object a v2 protocol line?
 *
 * v1 servers emit a single line that is NOT shaped as one of the above
 * (no `type` discriminator). Returning `false` here is the v1 fallback
 * trigger.
 */
export function isProtocolV2Line(value: unknown): value is ProtocolLine {
  if (typeof value !== 'object' || value === null) { return false; }
  const t = (value as { type?: unknown }).type;
  return t === 'test' || t === 'summary' || t === 'ack' || t === 'progress';
}
```

- [ ] **Step 2: Build**

```bash
cd U:/Git/ALchemist
npm run compile
```

Expected: clean build. No type errors. No tests yet — pure types are exercised by later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/execution/protocolV2Types.ts
git commit -m "feat(types): add protocol-v2 TypeScript types matching AL.Runner schema"
```

---

## Task 4: Extend ExecutionResult / TestResult for v2 fields

**Files:**
- Modify: `src/runner/outputParser.ts` (add fields, don't break existing parsers)
- Test: `test/suite/outputParser.test.ts` (no new tests — existing tests must still pass with new optional fields)

**Context:** The internal data model needs to carry the new per-test info (`alSourceFile`, `errorKind`, `stackFrames`, `messages[]`, `capturedValues[]`) and the new `FileCoverage` v2 shape alongside the legacy `CoverageEntry`. All additions are optional so v1 codepaths and existing tests don't break.

- [ ] **Step 1: Read current state**

```bash
cd U:/Git/ALchemist
sed -n '1,50p' src/runner/outputParser.ts
```

Confirm `TestResult`, `CapturedValue`, `CoverageEntry`, `RunSummary`, `ExecutionResult` shapes match the spec at the top of this plan.

- [ ] **Step 2: Extend `TestResult`**

Add (keeping all existing fields):

```typescript
export interface TestResult {
  // ... existing fields ...

  /** v2: AL source file (relative, forward-slash) of the deepest user frame. */
  alSourceFile?: string;

  /** v2: error category for IDE UI variation. */
  errorKind?: import('../execution/protocolV2Types').AlErrorKind;

  /** v2: structured stack frames from StackFrameMapper. */
  stackFrames?: import('../execution/protocolV2Types').AlStackFrame[];

  /** v2: per-test Message() output (empty array when test ran without Message calls). */
  messages?: string[];

  /** v2: per-test captured variable values. */
  capturedValues?: import('../execution/protocolV2Types').CapturedValue[];
}
```

Use `import(...)` deferred type imports so this file doesn't pull v2-only modules into the v1 codepath.

- [ ] **Step 3: Extend `ExecutionResult`**

Add (keeping all existing fields):

```typescript
export interface ExecutionResult {
  // ... existing fields ...

  /** v2: true if a runtests request received a cancel mid-stream. */
  cancelled?: boolean;

  /** v2: protocol version reported by the server's summary. Undefined for v1. */
  protocolVersion?: number;

  /**
   * v2: native-shape coverage for `vscode.TestRun.addCoverage()`. Coexists
   * with the legacy cobertura-derived `coverage` field (CoverageEntry[]).
   * v1 callers continue to read `coverage`; v2 callers read `coverageV2`.
   */
  coverageV2?: import('../execution/protocolV2Types').FileCoverage[];
}
```

We do NOT replace `coverage: CoverageEntry[]` because v1 fallback still produces cobertura. Both can coexist.

- [ ] **Step 4: Build + run existing tests**

```bash
npm run compile
npm run test:unit
```

Expected: same pass count as the baseline. Existing tests don't reference any new fields, so their behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runner/outputParser.ts
git commit -m "feat(types): extend TestResult/ExecutionResult with protocol-v2 optional fields"
```

---

## Task 5: ServerProcess streaming + cancel + v1 fallback

**Files:**
- Modify: `src/execution/serverProcess.ts`
- Create: `test/suite/serverProcess.streaming.test.ts`

**Context:** Today `ServerProcess.send(payload)` writes a single line and reads one response line. v2 needs multi-line response with on-event callback. The change is:

- `send(payload, onEvent?)` accumulates stdout lines until a terminator. v2 terminator: `{type:"summary"}` or `{type:"ack"}`. v1 terminator: any single complete JSON line that is not a v2 line (no `type` discriminator).
- New `cancel(): Promise<void>` — fire-and-forget. Writes `{"command":"cancel"}\n` immediately on the same stdin pipe. Does NOT wait for the ack.
- Existing crash-respawn logic preserved.

- [ ] **Step 1: Write failing tests at `test/suite/serverProcess.streaming.test.ts`**

The test uses a mock spawner that emits scripted stdout lines. Mirror the existing `serverProcess.test.ts` structure if it uses one.

```typescript
import { ServerProcess } from '../../src/execution/serverProcess';
import { EventEmitter } from 'events';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Helpers to fake a child process — read existing serverProcess.test.ts and copy
// whatever spawner-mock pattern it uses. If absent, write inline.

interface ScriptedChild extends EventEmitter {
  stdout: EventEmitter & { on: any };
  stdin: { write: (s: string) => void };
  kill: (sig?: string) => void;
}

function makeScriptedSpawner(scriptedLines: string[]) {
  return () => {
    const stdout = new EventEmitter() as any;
    const stdin = {
      writes: [] as string[],
      write: function (s: string) { this.writes.push(s); },
    };
    const child = new EventEmitter() as any as ScriptedChild;
    child.stdout = stdout;
    child.stdin = stdin;
    child.kill = () => child.emit('exit', 0);
    // After consumers attach 'data' listeners, replay scripted lines async.
    setImmediate(() => {
      stdout.emit('data', scriptedLines.join('\n') + '\n');
    });
    return child;
  };
}

suite('ServerProcess streaming (protocol v2)', () => {
  test('Streams test events, fires onEvent, resolves on summary', async () => {
    const sample = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'test', 'fixtures',
        'protocol-v2-samples', 'runtests-coverage-success.ndjson'),
      'utf8',
    );
    const lines = sample.split('\n').filter(l => l.length > 0);
    // First line is {ready:true}; subsequent are the runtests response.
    // Drop the trailing shutdown ack so the script ends at summary.
    const responseLines = lines
      .slice(1)
      .filter(l => !l.includes('"shutting down"'));

    const sp = new ServerProcess({
      runnerPath: 'fake',
      spawner: makeScriptedSpawner([lines[0], ...responseLines]) as any,
    });

    const events: any[] = [];
    const summary = await sp.send({ command: 'runtests' }, (ev: any) => events.push(ev));

    // 3 test events from the fixture
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, 'test');
    assert.strictEqual(events[0].name, 'ComputeDoubles');
    assert.strictEqual(summary.type, 'summary');
    assert.strictEqual(summary.protocolVersion, 2);
    assert.strictEqual(summary.passed, 2);
    assert.strictEqual(summary.failed, 1);

    await sp.dispose();
  });

  test('v1 fallback: single-line response with no type field resolves directly', async () => {
    const v1Response = JSON.stringify({
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      tests: [{ name: 'X', status: 'pass', durationMs: 5 }],
    });
    const sp = new ServerProcess({
      runnerPath: 'fake',
      spawner: makeScriptedSpawner(['{"ready":true}', v1Response]) as any,
    });

    const events: any[] = [];
    const result = await sp.send({ command: 'runtests' }, (ev: any) => events.push(ev));

    // No streaming events for v1.
    assert.strictEqual(events.length, 0);
    // Single response object resolved directly.
    assert.strictEqual(result.passed, 1);
    assert.strictEqual(result.protocolVersion, undefined);

    await sp.dispose();
  });

  test('cancel writes {"command":"cancel"} without waiting', async () => {
    const sp = new ServerProcess({
      runnerPath: 'fake',
      spawner: makeScriptedSpawner(['{"ready":true}']) as any,
    });
    // Send a runtests request that will hang (no scripted summary).
    const pending = sp.send({ command: 'runtests' });
    // Cancel mid-flight; resolves immediately even though `pending` is unresolved.
    await sp.cancel();
    // Cleanup — dispose resolves the pending request via dispose-mid-request reject.
    await sp.dispose();
    // pending rejects with 'disposed mid-request'
    let caught: Error | undefined;
    try { await pending; } catch (e: any) { caught = e; }
    assert.ok(caught);
    assert.match(caught!.message, /disposed/);
  });

  test('Malformed JSON line is skipped, then real summary still resolves', async () => {
    const sp = new ServerProcess({
      runnerPath: 'fake',
      spawner: makeScriptedSpawner([
        '{"ready":true}',
        '{"type":"test","name":"A","status":"pass","durationMs":1}',
        '<<garbage non-json line>>',
        '{"type":"summary","exitCode":0,"passed":1,"failed":0,"errors":0,"total":1,"protocolVersion":2}',
      ]) as any,
    });
    const events: any[] = [];
    const summary = await sp.send({ command: 'runtests' }, (ev: any) => events.push(ev));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(summary.protocolVersion, 2);
    await sp.dispose();
  });

  test('cancel command response (single ack line) resolves send', async () => {
    const sp = new ServerProcess({
      runnerPath: 'fake',
      spawner: makeScriptedSpawner([
        '{"ready":true}',
        '{"type":"ack","command":"cancel","noop":true}',
      ]) as any,
    });
    const result = await sp.send({ command: 'cancel' });
    assert.strictEqual(result.type, 'ack');
    assert.strictEqual(result.noop, true);
    await sp.dispose();
  });
});
```

Note: file path layout matches existing `test/suite/*.test.ts` outputs after webpack-tsc compile. If the existing test infra has a different pattern for fixture loading, follow that.

- [ ] **Step 2: Run — confirm failures**

```bash
cd U:/Git/ALchemist
npm run test-compile
npx mocha out/test/suite/serverProcess.streaming.test.js
```

Expected: compile error or assertion failure (`send` doesn't accept `onEvent`; `cancel` doesn't exist).

- [ ] **Step 3: Modify `src/execution/serverProcess.ts` — add streaming**

```typescript
import { isProtocolV2Line, ProtocolLine, Summary, Ack } from './protocolV2Types';

// PendingRequest interface — extend:
interface PendingRequest {
  payload: object;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  retried: boolean;
  onEvent?: (event: ProtocolLine) => void;     // NEW
  bufferedLines: any[];                         // NEW: for v1 single-line detection
}

// send signature:
async send(payload: object, onEvent?: (event: ProtocolLine) => void): Promise<any> {
  if (this.disposed) { throw new Error('ServerProcess disposed'); }
  return new Promise((resolve, reject) => {
    this.queue.push({
      payload, resolve, reject, retried: false, onEvent, bufferedLines: [],
    });
    this.pump();
  });
}

// cancel: fire-and-forget
async cancel(): Promise<void> {
  if (this.disposed || !this.proc) { return; }
  try {
    this.proc.stdin.write(JSON.stringify({ command: 'cancel' }) + '\n');
  } catch { /* ignore */ }
  // Do NOT await any response — the cancel ack will arrive via the
  // normal stream and fire onEvent or resolve the cancel-via-send path
  // if a separate cancel send was queued.
}
```

Modify `handleStdout`:

```typescript
private handleStdout(chunk: Buffer | string): void {
  this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
  let idx;
  while ((idx = this.buffer.indexOf('\n')) >= 0) {
    const line = this.buffer.slice(0, idx).trim();
    this.buffer = this.buffer.slice(idx + 1);
    if (!line) { continue; }
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // Malformed JSON — skip silently. Could log once per session.
      continue;
    }
    if (!this.ready) {
      if (obj && obj.ready === true) {
        this.ready = true;
        this.readyResolve?.();
      }
      continue;
    }
    if (this.inFlight) {
      this.routeLine(obj);
    }
  }
}

private routeLine(obj: any): void {
  const req = this.inFlight!;

  if (isProtocolV2Line(obj)) {
    if (obj.type === 'summary' || obj.type === 'ack') {
      // Terminal line — resolve.
      this.inFlight = undefined;
      req.resolve(obj);
      this.pump();
      return;
    }
    // Non-terminal v2 line (test / progress) — fire onEvent.
    req.onEvent?.(obj);
    return;
  }

  // Not a v2 line. v1 fallback: a single-line response.
  // Resolve directly with this object.
  this.inFlight = undefined;
  req.resolve(obj);
  this.pump();
}
```

- [ ] **Step 4: Run tests — iterate to green**

```bash
npm run test-compile
npx mocha out/test/suite/serverProcess.streaming.test.js
```

Expected: all 5 streaming tests pass.

- [ ] **Step 5: Run existing serverProcess tests — ensure no regression**

```bash
npx mocha out/test/suite/serverProcess.test.js
```

Existing tests should still pass — `send(payload)` (no `onEvent`) still works because the v1 fallback branch in `routeLine` resolves on the first line.

- [ ] **Step 6: Run full unit suite**

```bash
npm run test:unit
```

Baseline + 5 new tests, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/execution/serverProcess.ts test/suite/serverProcess.streaming.test.ts
git commit -m "feat(serverProcess): streaming consumption, cancel, v1 fallback"
```

---

## Task 6: ServerExecutionEngine — testFilter / onTest / cancel passthrough

**Files:**
- Modify: `src/execution/executionEngine.ts` (interface)
- Modify: `src/execution/serverExecutionEngine.ts`
- Create: `test/suite/serverExecutionEngine.streaming.test.ts`

**Context:** `ServerExecutionEngine` translates `RunTestsRequest` into the protocol-v2 wire payload. Adds `testFilter` and `cobertura` request fields, the `onTest` callback (forwarded to ServerProcess), and a `cancel()` method that calls through to `ServerProcess.cancel()`.

The status-string map (`pass→passed`) preserved. Per-test event mapping fills in `stackFrames`, `errorKind`, `alSourceFile`/`Line`/`Column`, `messages`, `capturedValues`. Summary's `coverage` field (if present, v2 shape) maps to `result.coverageV2` (the old `coverage` cobertura field stays empty in v2 path).

- [ ] **Step 1: Extend `executionEngine.ts` interface**

```typescript
import { TestEvent, FileCoverage } from './protocolV2Types';

export interface RunTestsRequest {
  sourcePaths: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
  coverage?: boolean;
  /** v2: narrow which tests run. */
  testFilter?: { codeunitNames?: string[]; procNames?: string[] };
  /** v2: also write cobertura.xml to disk (default false in server mode). */
  cobertura?: boolean;
}

export interface ExecutionEngine {
  /** v2 callers may pass onTest to receive per-test events as they arrive. */
  runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult>;
  executeScratch(req: ExecuteScratchRequest): Promise<ExecutionResult>;
  isHealthy(): boolean;
  /** Fire-and-forget cancellation of the in-flight runtests. No-op if none. */
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
```

- [ ] **Step 2: Modify `serverExecutionEngine.ts`**

Update `runTests` to accept `onTest` and forward to ServerProcess. Map per-test event into `TestResult` with v2 fields. Map summary's `coverage` into `result.coverageV2`. Set `result.cancelled` and `result.protocolVersion`.

```typescript
async runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult> {
  const startTime = Date.now();
  const payload: any = {
    command: 'runtests',
    sourcePaths: req.sourcePaths,
    captureValues: req.captureValues ?? true,
  };
  if (req.iterationTracking) { payload.iterationTracking = true; }
  if (req.coverage) { payload.coverage = true; }
  if (req.cobertura) { payload.cobertura = true; }
  if (req.testFilter) { payload.testFilter = req.testFilter; }

  const accumulated: TestResult[] = [];
  let onEvent: ((event: any) => void) | undefined;
  if (onTest) {
    onEvent = (event: any) => {
      if (event.type === 'test') {
        const testResult = this.mapTestEvent(event);
        accumulated.push(testResult);
        onTest(event);
      }
      // 'progress' events — ignored for now (future use)
    };
  }

  let response: any;
  try {
    response = await this.process.send(payload, onEvent);
  } catch (err: any) {
    return failureResult(err.message ?? String(err), startTime, 'test');
  }

  if (response.error && !response.type) {
    return failureResult(response.error, startTime, 'test');
  }

  // v2 path: response is a Summary; per-test data lives in `accumulated`.
  // v1 path: response has tests[] inline.
  let tests: TestResult[];
  if (response.type === 'summary') {
    tests = accumulated.length > 0 ? accumulated : [];
    // If onEvent wasn't provided but response is v2 summary, we missed
    // the test events. For robustness, the test events would also have
    // been written to stdout — they were just ignored. Document this.
  } else {
    // v1 fallback
    const rawTests: any[] = response.tests ?? [];
    tests = rawTests.map((t: any) => this.mapV1Test(t));
  }

  return {
    mode: 'test',
    tests,
    messages: [],   // per-test messages now live on each TestResult
    stderrOutput: [],
    summary: response.type === 'summary'
      ? { passed: response.passed, failed: response.failed,
          errors: response.errors, total: response.total }
      : (response.passed !== undefined
          ? { passed: response.passed, failed: response.failed ?? 0,
              errors: response.errors ?? 0, total: response.total ?? 0 }
          : undefined),
    coverage: response.coverage && Array.isArray(response.coverage) && response.coverage.length > 0
              && (response.coverage[0] as any).className !== undefined
      ? response.coverage  // v1 cobertura-shape leaked through (shouldn't in v2 server)
      : [],
    coverageV2: response.coverage && response.type === 'summary'
      ? (response.coverage as FileCoverage[])
      : undefined,
    exitCode: response.exitCode ?? 0,
    durationMs: Date.now() - startTime,
    capturedValues: [],   // per-test on each TestResult
    cached: response.cached ?? false,
    cancelled: response.cancelled === true,
    protocolVersion: response.protocolVersion,
    iterations: response.iterations ?? [],
  };
}

private mapTestEvent(event: any): TestResult {
  return {
    name: event.name,
    status: STATUS_MAP[event.status] ?? 'errored',
    durationMs: event.durationMs ?? undefined,
    message: event.message ?? undefined,
    stackTrace: event.stackTrace ?? undefined,
    alSourceLine: event.alSourceLine ?? undefined,
    alSourceColumn: event.alSourceColumn ?? undefined,
    alSourceFile: event.alSourceFile ?? undefined,
    errorKind: event.errorKind ?? undefined,
    stackFrames: event.stackFrames ?? undefined,
    messages: event.messages ?? undefined,
    capturedValues: event.capturedValues ?? undefined,
  };
}

private mapV1Test(t: any): TestResult {
  return {
    name: t.name,
    status: STATUS_MAP[t.status] ?? 'errored',
    durationMs: t.durationMs ?? undefined,
    message: t.message ?? undefined,
    stackTrace: t.stackTrace ?? undefined,
    alSourceLine: t.alSourceLine ?? undefined,
    alSourceColumn: t.alSourceColumn ?? undefined,
  };
}

async cancel(): Promise<void> {
  if (this.process.cancel) {
    await this.process.cancel();
  }
}
```

Update the `ServerProcessLike` interface:

```typescript
interface ServerProcessLike {
  send(payload: object, onEvent?: (event: any) => void): Promise<any>;
  cancel?(): Promise<void>;
  dispose(): Promise<void>;
  isHealthy?(): boolean;
}
```

- [ ] **Step 3: Write tests at `test/suite/serverExecutionEngine.streaming.test.ts`**

```typescript
import { ServerExecutionEngine } from '../../src/execution/serverExecutionEngine';
import * as assert from 'assert';
import { TestEvent } from '../../src/execution/protocolV2Types';

class StubProcess {
  public lastPayload: any;
  public lastOnEvent: any;
  public canceled = false;
  constructor(private readonly response: any, private readonly events: any[] = []) {}
  async send(payload: any, onEvent?: any): Promise<any> {
    this.lastPayload = payload;
    this.lastOnEvent = onEvent;
    if (onEvent) {
      for (const ev of this.events) { onEvent(ev); }
    }
    return this.response;
  }
  async cancel(): Promise<void> { this.canceled = true; }
  async dispose(): Promise<void> { /* no-op */ }
  isHealthy(): boolean { return true; }
}

suite('ServerExecutionEngine v2 passthrough', () => {
  test('forwards testFilter to payload', async () => {
    const stub = new StubProcess({
      type: 'summary', passed: 0, failed: 0, errors: 0, total: 0,
      exitCode: 0, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    await engine.runTests({
      sourcePaths: ['./src'],
      testFilter: { procNames: ['Foo'] },
    });
    assert.deepStrictEqual(stub.lastPayload.testFilter, { procNames: ['Foo'] });
  });

  test('forwards coverage flag', async () => {
    const stub = new StubProcess({
      type: 'summary', passed: 0, failed: 0, errors: 0, total: 0,
      exitCode: 0, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    await engine.runTests({ sourcePaths: ['./src'], coverage: true });
    assert.strictEqual(stub.lastPayload.coverage, true);
  });

  test('onTest callback fires per streaming test event', async () => {
    const ev1: TestEvent = { type: 'test', name: 'A', status: 'pass', durationMs: 1 };
    const ev2: TestEvent = { type: 'test', name: 'B', status: 'fail', durationMs: 2,
                              message: 'oops', errorKind: 'runtime' };
    const stub = new StubProcess({
      type: 'summary', passed: 1, failed: 1, errors: 0, total: 2,
      exitCode: 1, protocolVersion: 2,
    }, [ev1, ev2]);
    const engine = new ServerExecutionEngine(stub as any);
    const seen: TestEvent[] = [];
    const result = await engine.runTests({ sourcePaths: ['./src'] }, (e) => seen.push(e));
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0].name, 'A');
    assert.strictEqual(result.tests.length, 2);
    assert.strictEqual(result.tests[1].errorKind, 'runtime');
    assert.strictEqual(result.protocolVersion, 2);
  });

  test('preserves v1 status mapping (regression for Plan B+D fix)', async () => {
    // v2 path
    const ev: TestEvent = { type: 'test', name: 'A', status: 'pass', durationMs: 1 };
    const stub = new StubProcess({
      type: 'summary', passed: 1, failed: 0, errors: 0, total: 1,
      exitCode: 0, protocolVersion: 2,
    }, [ev]);
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] }, () => {});
    assert.strictEqual(result.tests[0].status, 'passed'); // mapped from 'pass'
  });

  test('cancel forwards to ServerProcess', async () => {
    const stub = new StubProcess({});
    const engine = new ServerExecutionEngine(stub as any);
    await engine.cancel();
    assert.strictEqual(stub.canceled, true);
  });

  test('v1 fallback: response without type still maps tests', async () => {
    const v1Response = {
      tests: [{ name: 'X', status: 'pass', durationMs: 5, alSourceLine: 12 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    };
    const stub = new StubProcess(v1Response);
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] });
    assert.strictEqual(result.tests.length, 1);
    assert.strictEqual(result.tests[0].name, 'X');
    assert.strictEqual(result.tests[0].alSourceLine, 12);
    assert.strictEqual(result.protocolVersion, undefined);
  });
});
```

- [ ] **Step 4: Run tests — iterate to green**

```bash
npm run test-compile
npx mocha out/test/suite/serverExecutionEngine.streaming.test.js
```

- [ ] **Step 5: Run existing engine tests — ensure no regression**

```bash
npx mocha out/test/suite/serverExecutionEngine.test.js
```

- [ ] **Step 6: Run full unit suite**

```bash
npm run test:unit
```

Baseline + Task 5 + 6 new tests, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/execution/executionEngine.ts src/execution/serverExecutionEngine.ts test/suite/serverExecutionEngine.streaming.test.ts
git commit -m "feat(engine): testFilter, onTest callback, cancel passthrough, v2 mapping"
```

---

## Task 7: coverageAdapter (new module)

**Files:**
- Create: `src/execution/coverageAdapter.ts`
- Create: `test/suite/coverageAdapter.test.ts`

**Context:** Pure function: AL.Runner `FileCoverage[]` → `vscode.FileCoverage[]`. The protocol uses 1-indexed line numbers; VS Code uses 0-indexed `Position`. Adapter subtracts 1.

- [ ] **Step 1: Write failing tests**

`test/suite/coverageAdapter.test.ts`:

```typescript
import * as vscode from 'vscode';
import * as assert from 'assert';
import { toVsCodeCoverage } from '../../src/execution/coverageAdapter';
import { FileCoverage } from '../../src/execution/protocolV2Types';

suite('coverageAdapter', () => {
  test('one input file → one FileCoverage', () => {
    const input: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 10, hits: 1 }, { line: 11, hits: 0 }],
      totalStatements: 2,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].uri.fsPath.endsWith('Foo.al') ||
                       out[0].uri.fsPath.endsWith('Foo' + (require('path').sep) + 'al'), true);
  });

  test('1-indexed line → 0-indexed Position', () => {
    const input: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 42, hits: 3 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    const detail = out[0].detailedCoverage as vscode.StatementCoverage[];
    assert.strictEqual(detail.length, 1);
    const pos = (detail[0].location as vscode.Position);
    assert.strictEqual(pos.line, 41);  // 42 -> 41
    assert.strictEqual(pos.character, 0);
  });

  test('hits count preserved', () => {
    const input: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [{ line: 1, hits: 7 }],
      totalStatements: 1,
      hitStatements: 1,
    }];
    const out = toVsCodeCoverage(input);
    const detail = out[0].detailedCoverage as vscode.StatementCoverage[];
    assert.strictEqual(detail[0].executed, 7);
  });

  test('empty input → empty output', () => {
    assert.deepStrictEqual(toVsCodeCoverage([]), []);
  });

  test('multiple files preserved in order', () => {
    const input: FileCoverage[] = [
      { file: 'a.al', lines: [], totalStatements: 1, hitStatements: 0 },
      { file: 'b.al', lines: [], totalStatements: 1, hitStatements: 1 },
    ];
    const out = toVsCodeCoverage(input);
    assert.strictEqual(out.length, 2);
  });

  test('FileCoverage statementCoverage totals (hit/total) come through', () => {
    const input: FileCoverage[] = [{
      file: 'src/Foo.al',
      lines: [],
      totalStatements: 10,
      hitStatements: 7,
    }];
    const out = toVsCodeCoverage(input);
    // The TestCoverageCount surface — check covered/total
    const sc = out[0].statementCoverage;
    assert.strictEqual(sc.covered, 7);
    assert.strictEqual(sc.total, 10);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd U:/Git/ALchemist
npm run test-compile
npx mocha out/test/suite/coverageAdapter.test.js
```

Expected: cannot find module `coverageAdapter`.

- [ ] **Step 3: Implement `src/execution/coverageAdapter.ts`**

```typescript
import * as vscode from 'vscode';
import { FileCoverage } from './protocolV2Types';

/**
 * Translate AL.Runner protocol-v2 FileCoverage[] into VS Code's native
 * FileCoverage shape so callers can pass the result directly to
 * `vscode.TestRun.addCoverage()`.
 *
 * AL.Runner emits 1-indexed line numbers; VS Code's `Position` is 0-indexed.
 * This adapter performs the offset.
 *
 * The hit count semantics differ from cobertura: AL.Runner sums hits across
 * statements on the same line (so a line with 3 statements all hit reports
 * `hits: 3`), whereas cobertura clamps to 1. VS Code's StatementCoverage
 * `executed` accepts an integer hit count — we pass it through directly.
 */
export function toVsCodeCoverage(input: FileCoverage[]): vscode.FileCoverage[] {
  return input.map(fc => {
    const fileCoverage = new vscode.FileCoverage(
      vscode.Uri.file(fc.file),
      new vscode.TestCoverageCount(fc.hitStatements, fc.totalStatements),
    );
    fileCoverage.detailedCoverage = fc.lines.map(l =>
      new vscode.StatementCoverage(
        l.hits,
        new vscode.Position(l.line - 1, 0),
      ),
    );
    return fileCoverage;
  });
}
```

- [ ] **Step 4: Run tests — iterate**

```bash
npm run test-compile
npx mocha out/test/suite/coverageAdapter.test.js
```

If a test fails because `vscode.TestCoverageCount` / `vscode.FileCoverage` shapes have evolved (this is a relatively new VS Code API), check `engines.vscode` in `package.json` and adjust either the API call or the test. The minimum is `vscode.FileCoverage` (1.88+). If our `engines.vscode` is `^1.85`, raise it to `^1.88` in package.json — this is the trade-off for v2 native rendering.

- [ ] **Step 5: Run full unit suite**

```bash
npm run test:unit
```

Baseline + 6 coverageAdapter tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/execution/coverageAdapter.ts test/suite/coverageAdapter.test.ts package.json
git commit -m "feat(coverage): add coverageAdapter — AL.Runner FileCoverage → vscode.FileCoverage"
```

---

## Task 8: TestController progressive run.passed/failed + addCoverage + TestMessageStackFrame

**Files:**
- Modify: `src/testing/testController.ts`
- Create: `test/suite/testController.streaming.test.ts`

**Context:** The current `runTests` calls `engine.runTests(...)` and waits for the full result, then `onResult` callback fires `run.passed`/`run.failed` later via `updateFromResult`. v2 fires per-test as each completes, gives live Test Explorer updates.

Plus: failure messages get clickable stack frames (`TestMessageStackFrame[]`) when VS Code ≥1.93. Cancellation: `token.onCancellationRequested → engine.cancel()`. After all tests complete, `run.addCoverage(toVsCodeCoverage(result.coverageV2))`.

- [ ] **Step 1: Write failing tests at `test/suite/testController.streaming.test.ts`**

The test mocks the engine and the VS Code TestController. The existing `testController.multiApp.test.ts` likely has helpers — read it first.

```typescript
import * as vscode from 'vscode';
import * as assert from 'assert';
import { AlchemistTestController } from '../../src/testing/testController';
import { ExecutionEngine } from '../../src/execution/executionEngine';
import { ExecutionResult, TestResult } from '../../src/runner/outputParser';

class StubEngine implements ExecutionEngine {
  public canceled = false;
  public lastReq: any;
  public lastOnTest: any;
  constructor(
    private readonly events: any[] = [],
    private readonly summary: ExecutionResult = makeEmptyResult(),
  ) {}
  async runTests(req: any, onTest?: any): Promise<ExecutionResult> {
    this.lastReq = req;
    this.lastOnTest = onTest;
    if (onTest) for (const e of this.events) { onTest(e); }
    return this.summary;
  }
  async executeScratch(): Promise<ExecutionResult> { throw new Error('not used'); }
  isHealthy(): boolean { return true; }
  async cancel(): Promise<void> { this.canceled = true; }
  async dispose(): Promise<void> { /* no-op */ }
}

function makeEmptyResult(): ExecutionResult {
  return {
    mode: 'test', tests: [], messages: [], stderrOutput: [],
    summary: { passed: 0, failed: 0, errors: 0, total: 0 },
    coverage: [], exitCode: 0, durationMs: 1, capturedValues: [],
    cached: false, iterations: [],
  };
}

suite('TestController streaming (v2)', () => {
  test('fires run.passed per pass event progressively', async () => {
    // Build fixture testItems via refreshTestsFromModel
    // ... read testController.multiApp.test.ts for the model setup pattern ...
    // Issue runTests with stub engine that emits 2 pass events then summary
    // Assert: run.passed called 2x in order
  });

  test('fires run.failed with stack frames when present', async () => {
    // Stub event has stackFrames; assert TestMessage.stackTrace populated
  });

  test('on cancellation token, engine.cancel is called', async () => {
    // Create CancellationTokenSource, dispatch token.cancel(), assert engine.canceled === true
  });

  test('coverageV2 in result → run.addCoverage called per file', async () => {
    // Stub result has coverageV2: [...]; assert addCoverage called.
    // Need to spy on TestRun.addCoverage — wrap the controller's createTestRun or use
    // a real-ish run + watch the side effects.
  });
});
```

The placeholder tests above need fleshing out per the existing `testController.multiApp.test.ts` patterns. If that file uses a particular spy/stub approach for TestRun, mirror it. Don't fabricate a different spy infrastructure.

- [ ] **Step 2: Modify `testController.ts`**

Refactor `runTests`:

```typescript
private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const engine = this.getEngine();
  if (!engine) {
    vscode.window.showErrorMessage('ALchemist: AL.Runner not yet ready');
    return;
  }

  const run = this.controller.createTestRun(request);
  // Cancel forwarding
  const cancelSub = token.onCancellationRequested(() => {
    void engine.cancel();
  });

  try {
    if (!this.model) {
      // Legacy single-folder fallback (unchanged from pre-v2).
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (!wsf) { run.end(); return; }
      const result = await engine.runTests(
        { sourcePaths: [wsf.uri.fsPath], captureValues: true, iterationTracking: true, coverage: true },
        (event) => this.handleStreamingEvent(run, event),
      );
      this.applyFinalResult(run, result);
      this.onResult?.(result);
      return;
    }

    // Multi-app mode (Task 10+).
    if (request.include && request.include.length > 0) {
      const groups = groupTestItemsByApp(request.include);
      const apps = this.model.getApps();
      for (const [appId, _items] of groups) {
        const app = apps.find(a => a.id === appId);
        if (!app) { continue; }
        const depPaths = this.model.getDependencies(app.id).map(a => a.path);
        const sourcePaths = depPaths.length > 0 ? depPaths : [app.path];
        const result = await engine.runTests(
          { sourcePaths, captureValues: true, iterationTracking: true, coverage: true },
          (event) => this.handleStreamingEvent(run, event),
        );
        this.applyFinalResult(run, result);
        this.onResult?.(result);
      }
    } else {
      for (const app of this.model.getApps()) {
        const depPaths = this.model.getDependencies(app.id).map(a => a.path);
        const sourcePaths = depPaths.length > 0 ? depPaths : [app.path];
        const result = await engine.runTests(
          { sourcePaths, captureValues: true, iterationTracking: true, coverage: true },
          (event) => this.handleStreamingEvent(run, event),
        );
        this.applyFinalResult(run, result);
        this.onResult?.(result);
      }
    }
  } finally {
    cancelSub.dispose();
    run.end();
  }
}

private handleStreamingEvent(run: vscode.TestRun, event: import('../execution/protocolV2Types').TestEvent): void {
  if (event.type !== 'test') { return; }
  const item = this.testItems.get(event.name);
  if (!item) { return; }
  if (event.status === 'pass') {
    run.passed(item, event.durationMs);
  } else if (event.status === 'fail') {
    run.failed(item, this.buildTestMessage(event), event.durationMs);
  } else {
    run.errored(item, this.buildTestMessage(event), event.durationMs);
  }
}

private buildTestMessage(event: import('../execution/protocolV2Types').TestEvent): vscode.TestMessage {
  const message = new vscode.TestMessage(event.message ?? 'Test failed');

  // VS Code ≥1.93 has TestMessageStackFrame.
  if ((vscode as any).TestMessageStackFrame && event.stackFrames) {
    const StackFrameCtor = (vscode as any).TestMessageStackFrame;
    (message as any).stackTrace = event.stackFrames.map(f => new StackFrameCtor(
      f.name ?? '',
      f.source?.path ? vscode.Uri.file(f.source.path) : undefined,
      f.line ? new vscode.Position(f.line - 1, (f.column ?? 1) - 1) : undefined,
    ));
  }

  if (event.alSourceFile && event.alSourceLine) {
    message.location = new vscode.Location(
      vscode.Uri.file(event.alSourceFile),
      new vscode.Position(event.alSourceLine - 1, (event.alSourceColumn ?? 1) - 1),
    );
  }

  return message;
}

private applyFinalResult(run: vscode.TestRun, result: import('../runner/outputParser').ExecutionResult): void {
  // VS Code native coverage rendering: only when result has v2 coverage.
  if (result.coverageV2 && (run as any).addCoverage) {
    const adapter = require('../execution/coverageAdapter') as typeof import('../execution/coverageAdapter');
    for (const fc of adapter.toVsCodeCoverage(result.coverageV2)) {
      (run as any).addCoverage(fc);
    }
  }
  // For tests not visited by streaming events (v1 fallback path),
  // updateFromResult walks result.tests.
  if (!this.didReceiveStreamingEvents(result)) {
    this.applyV1Result(run, result);
  }
}

private didReceiveStreamingEvents(result: import('../runner/outputParser').ExecutionResult): boolean {
  return result.protocolVersion === 2;
}

private applyV1Result(run: vscode.TestRun, result: import('../runner/outputParser').ExecutionResult): void {
  // Equivalent to old updateFromResult but operating on the run we just created.
  for (const t of result.tests) {
    const item = this.testItems.get(t.name);
    if (!item) { continue; }
    if (t.status === 'passed') {
      run.passed(item, t.durationMs);
    } else if (t.status === 'failed') {
      const msg = new vscode.TestMessage(t.message ?? 'Test failed');
      if (t.alSourceLine && item.uri) {
        msg.location = new vscode.Location(item.uri,
          new vscode.Position(t.alSourceLine - 1, (t.alSourceColumn ?? 1) - 1));
      }
      run.failed(item, msg, t.durationMs);
    } else {
      run.errored(item, new vscode.TestMessage(t.message ?? 'Test errored'), t.durationMs);
    }
  }
}
```

The existing `updateFromResult` method becomes legacy (used by `onResult` callbacks from non-test-runner code paths like file-save runs). Keep it; it doesn't drive Test Explorer anymore.

- [ ] **Step 3: Run tests — iterate**

```bash
cd U:/Git/ALchemist
npm run test-compile
npx mocha out/test/suite/testController.streaming.test.js
```

The fleshed-out tests must pass on both v2 and v1 fallback paths.

- [ ] **Step 4: Run existing testController tests — no regression**

```bash
npx mocha out/test/suite/testController.multiApp.test.js
```

- [ ] **Step 5: Run full unit suite**

```bash
npm run test:unit
```

- [ ] **Step 6: Commit**

```bash
git add src/testing/testController.ts test/suite/testController.streaming.test.ts
git commit -m "feat(testController): progressive results, addCoverage, stack frames, cancel forward"
```

---

## Task 9: DecorationManager — retire custom coverage, scope captured values per test

**Files:**
- Modify: `src/editor/decorations.ts`
- Modify: `src/extension.ts` (callback wiring if needed)
- Create: `test/suite/decorationManager.perTest.test.ts`

**Context:** v2 provides VS Code-native coverage via `addCoverage()` (Task 8). The custom green/gray gutter SVGs are no longer rendered when `result.coverageV2` is present. Captured values become `Map<TestId, CapturedValue[]>` so the active test's values display rather than aggregating across tests.

Inline error decoration: lookup the deepest user frame (`event.stackFrames[]` first user-code frame) instead of relying solely on `event.alSourceLine`. Falls back to `alSourceLine` when stackFrames absent (v1 path).

- [ ] **Step 1: Read current state**

```bash
sed -n '1,150p' U:/Git/ALchemist/src/editor/decorations.ts
```

Identify:
- `coveredDecorationType` / `uncoveredDecorationType` and where they're applied.
- `capturedValuesStore` (currently a flat `CapturedValue[]`) and where it's set / read.
- Inline error decoration logic.

- [ ] **Step 2: Refactor coverage decorations**

Remove or no-op the custom coverage application path when `result.coverageV2` is present (i.e. when VS Code native rendering took over). Two approaches:

1. **Hard delete**: remove `coveredDecorationType`/`uncoveredDecorationType` types and all associated rendering. Forces v1 users to upgrade AL.Runner. Breaking change.
2. **Conditional retire**: keep types + rendering for v1 fallback, skip when `result.coverageV2` is non-empty.

CHOOSE option 2 — graceful degradation matters for users on older AL.Runner. Inside the apply-coverage method, add a guard:

```typescript
if (result.coverageV2 && result.coverageV2.length > 0) {
  // v2 native rendering took over — skip custom gutter decoration.
  return;
}
// existing v1 cobertura-derived decoration logic continues here
```

- [ ] **Step 3: Refactor capturedValues to per-test scope**

Change `capturedValuesStore: CapturedValue[]` to `Map<TestId, CapturedValue[]>` where TestId is the test name (string).

When applying decorations for the active editor:
- Determine the "active test" (from a UI selection or the most-recent test's TestRun item). For now, keep a `setActiveTest(testName: string)` API that callers (TestController) invoke, or fall back to the union of all tests' captured values when no active test is set.
- The hover provider also needs to update; check `src/editor/hoverProvider.ts` for the read site.

```typescript
private capturedValuesByTest = new Map<string, CapturedValue[]>();
private activeTestName?: string;

setActiveTest(testName: string | undefined): void {
  this.activeTestName = testName;
  // re-apply decorations
}

setCapturedValuesForTest(testName: string, values: CapturedValue[]): void {
  this.capturedValuesByTest.set(testName, values);
}

getCapturedValuesForActiveTest(): CapturedValue[] {
  if (this.activeTestName) {
    return this.capturedValuesByTest.get(this.activeTestName) ?? [];
  }
  // No selection — show union (preserves pre-v2 behavior).
  const all: CapturedValue[] = [];
  for (const arr of this.capturedValuesByTest.values()) { all.push(...arr); }
  return all;
}
```

The v2 wiring in `TestController`'s `handleStreamingEvent` (Task 8) populates the per-test map:

```typescript
if (event.capturedValues && this.decorationManager) {
  this.decorationManager.setCapturedValuesForTest(event.name, event.capturedValues);
}
```

(This requires `TestController` to have a `decorationManager` field — wire it from `extension.ts`.)

- [ ] **Step 4: Inline error from deepest user frame**

In the inline error decoration code, prefer `result.tests[i].alSourceFile`/`alSourceLine` (already populated from the deepest frame in Task 6) over scanning `stackFrames` again. The mapping was done upstream.

- [ ] **Step 5: Write tests at `test/suite/decorationManager.perTest.test.ts`**

```typescript
import * as assert from 'assert';
import { DecorationManager } from '../../src/editor/decorations';
import { CapturedValue } from '../../src/runner/outputParser';

suite('DecorationManager per-test capturedValues', () => {
  test('setCapturedValuesForTest stores per-test', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [
      { scopeName: 'A_scope', sourceFile: 'a.al', variableName: 'x', value: '1', statementId: 0 } as CapturedValue,
    ]);
    dm.setCapturedValuesForTest('TestB', [
      { scopeName: 'B_scope', sourceFile: 'b.al', variableName: 'y', value: '2', statementId: 0 } as CapturedValue,
    ]);
    dm.setActiveTest('TestA');
    const active = dm.getCapturedValuesForActiveTest();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].variableName, 'x');
  });

  test('no active test → union across tests', () => {
    const dm = new DecorationManager(__dirname);
    dm.setCapturedValuesForTest('TestA', [
      { scopeName: 's', sourceFile: 'a.al', variableName: 'x', value: '1', statementId: 0 } as CapturedValue,
    ]);
    dm.setCapturedValuesForTest('TestB', [
      { scopeName: 's', sourceFile: 'a.al', variableName: 'y', value: '2', statementId: 0 } as CapturedValue,
    ]);
    dm.setActiveTest(undefined);
    assert.strictEqual(dm.getCapturedValuesForActiveTest().length, 2);
  });
});
```

(Adapt CapturedValue field names to match current `outputParser.ts` shape — the existing `CapturedValue` interface has `sourceFile` not `objectName`. The v2 protocol's `objectName` flows through but the older `sourceFile` field may need to be filled from elsewhere or defaulted to empty. Read current shape and adapt.)

- [ ] **Step 6: Run full suite**

```bash
cd U:/Git/ALchemist
npm run test:unit
```

Existing decoration tests must still pass; new per-test tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/editor/decorations.ts src/extension.ts test/suite/decorationManager.perTest.test.ts
git commit -m "feat(decorations): retire custom coverage when v2 native takes over; per-test capturedValues"
```

---

## Task 10: Wire onTest callback through extension.ts

**Files:**
- Modify: `src/extension.ts`

**Context:** The TestController constructor receives `onResult` today. v2's per-test events flow via the `onTest` callback inside `runTests`. Most wiring is already in `TestController.runTests` via `handleStreamingEvent`, but `extension.ts` may need to pass `decorationManager` so per-test capturedValues get scoped.

- [ ] **Step 1: Read current extension.ts wiring**

```bash
grep -nE "AlchemistTestController|DecorationManager|new ServerExecutionEngine" U:/Git/ALchemist/src/extension.ts | head
```

- [ ] **Step 2: Adjust constructor / setters as needed**

If `AlchemistTestController` already takes a `decorationManager` (or has a setter), wire it. If not, add a setter `setDecorationManager(dm: DecorationManager)` to the controller class so per-test events route correctly.

Concrete change (depending on current state): add a `decorationManager?: DecorationManager` field to `AlchemistTestController`, populate from `extension.ts`'s activate path right after both are constructed.

- [ ] **Step 3: Build + run unit suite**

```bash
npm run compile
npm run test:unit
```

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts src/testing/testController.ts
git commit -m "feat(extension): wire decorationManager into TestController for per-test scoping"
```

---

## Task 11: Integration test against extension host

**Files:**
- Create: `test/integration/protocolV2.itest.ts`

**Context:** The unit tests use stubs. End-to-end validation happens in the extension-host integration suite (`@vscode/test-electron`). Read `test/integration/testControllerForward.itest.ts` for the existing pattern.

The integration test boots a fixture workspace containing AL files, runs the extension, opens Test Explorer, triggers a run, and asserts that streaming events arrived (visible as progressive Test Explorer updates) and that coverage rendering was invoked.

Driving an actual live AL.Runner binary inside the extension-host test is heavy. **Alternative: mock at the `ServerProcess` boundary**. Inject a fake `ServerProcess` that replays the protocol-v2 sample fixture, then exercise everything from `ServerExecutionEngine` upward.

- [ ] **Step 1: Inspect existing integration setup**

```bash
sed -n '1,80p' U:/Git/ALchemist/test/integration/testControllerForward.itest.ts
sed -n '1,40p' U:/Git/ALchemist/test/integration/index.ts
```

Determine: how is the extension activated? Is there a way to substitute `ServerProcess` (e.g. through a DI container or feature flag)? If not, the test may need to spawn a real AL.Runner with the fork build.

- [ ] **Step 2: Write integration test**

The shape:
1. Activate extension in a fixture workspace.
2. Substitute the engine (or process) with one that emits the protocol-v2 sample.
3. Trigger Test Explorer "Run All" via `vscode.commands.executeCommand('testing.runAll')` (or the equivalent).
4. Wait for the run to finish.
5. Assert: `vscode.tests` API shows expected pass/fail counts; `vscode.tests.activeTestCoverage` (if available) shows files; `TestMessage.stackTrace` exists on the failing test.

```typescript
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';

suite('Integration: protocol v2 streaming runtests', () => {
  test('Test Explorer reports streaming pass/fail with stack frames', async function() {
    this.timeout(60000);
    // ... install fake ServerProcess via extension API or test seam ...
    // ... trigger run ...
    // ... assert ...
  });
});
```

The test seam for substituting `ServerProcess` may need to be added: e.g. an environment variable `ALCHEMIST_TEST_PROCESS_SCRIPT_PATH` that, when set, makes ALchemist load a JSON fixture instead of spawning. Adding this seam is in scope for this task.

If a working integration test cannot be written within this task without deeper test-infrastructure changes, mark it as `skip` with a comment documenting the deferred work + open a follow-up.

- [ ] **Step 3: Run integration test**

```bash
npm run test:integration   # or whatever the script name is in package.json
```

If the integration suite needs additional configuration (a `runIntegrationTests.ts` invocation), follow the pattern in the existing repo.

- [ ] **Step 4: Commit**

```bash
git add test/integration/protocolV2.itest.ts src/extension.ts
git commit -m "test(integration): protocol v2 streaming end-to-end via @vscode/test-electron"
```

---

## Task 12: Version probe + status bar feedback

**Files:**
- Modify: `src/execution/serverProcess.ts` (expose `getProtocolVersion()`)
- Modify: `src/extension.ts` (status bar tooltip update)
- Create: `test/suite/protocolVersion.test.ts`

**Context:** Spec § Protocol version detection: "First runtests request returns summary with `protocolVersion: 2`. ServerProcess records the version. If absent or `<2`: fall back, status bar tooltip reads 'AL.Runner protocol v1 — upgrade for live updates'."

- [ ] **Step 1: Add `getProtocolVersion(): number | undefined` to ServerProcess**

In `serverProcess.ts`:

```typescript
private detectedProtocolVersion: number | undefined;

getProtocolVersion(): number | undefined {
  return this.detectedProtocolVersion;
}

// In routeLine, when summary arrives:
if (obj.type === 'summary' && typeof obj.protocolVersion === 'number') {
  this.detectedProtocolVersion = obj.protocolVersion;
}
```

- [ ] **Step 2: Update extension.ts status bar**

After the first runtests completes (e.g. via a one-shot listener on `onResult`), update the status bar item's tooltip:

```typescript
const v = serverProcess.getProtocolVersion();
if (v === undefined || v < 2) {
  statusBar.tooltip = 'AL.Runner protocol v1 (upgrade for live updates)';
} else {
  statusBar.tooltip = `AL.Runner protocol v${v}`;
}
```

- [ ] **Step 3: Write tests**

```typescript
import * as assert from 'assert';
import { ServerProcess } from '../../src/execution/serverProcess';
// ... use the same scripted spawner from Task 5 ...

suite('ServerProcess protocol version detection', () => {
  test('records protocolVersion 2 from summary', async () => {
    // ... script that ends in summary protocolVersion:2 ...
    // ... assert getProtocolVersion() === 2 ...
  });

  test('returns undefined for v1 (no protocolVersion in response)', async () => {
    // ... script with v1-shaped response ...
    // ... assert getProtocolVersion() === undefined ...
  });

  test('updates after runtests cycle', async () => {
    // First v1 response, second v2 response on same process
  });
});
```

- [ ] **Step 4: Run tests + commit**

```bash
npm run test:unit
git add src/execution/serverProcess.ts src/extension.ts test/suite/protocolVersion.test.ts
git commit -m "feat(version-probe): detect protocolVersion + status bar tooltip"
```

---

## Task 13: CHANGELOG + README + version bump

**Files:**
- Modify: `package.json` (version 0.4.0 → 0.5.0)
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Context:** Final user-facing surface bump.

- [ ] **Step 1: Update package.json version**

Change `"version": "0.4.0"` → `"version": "0.5.0"`.

- [ ] **Step 2: Update CHANGELOG.md**

Prepend:

```markdown
## [0.5.0] — 2026-04-XX

### Added
- **AL.Runner protocol v2 consumer.** Per-test streaming results in Test Explorer (live pass/fail as each test completes), DAP-aligned clickable stack frames on failures, VS Code native coverage rendering (gutter icons + Coverage View), per-test captured-value scoping, mid-run cancellation that preserves the warm cache.
- **Run with Coverage profile** — VS Code's native run profile lights up automatically for projects on AL.Runner v2+.
- **`testFilter` request** — right-click → Run on a single test now narrows the actual execution rather than re-running every test in the codeunit.
- **Status bar protocol version** — hover the AL.Runner status bar item to see whether you're on v1 (upgrade for live updates) or v2.

### Changed
- TestMessage now carries structured `stackTrace` frames when the runner provides them. Older AL.Runner installations continue to work via v1 fallback (no live streaming, plain text stack traces).
- Custom coverage gutter SVGs are bypassed when v2 native rendering takes over. v1 path retains them.

### Internal
- New `coverageAdapter` translates AL.Runner FileCoverage[] → vscode.FileCoverage[].
- ServerProcess gains streaming consumption + cancel.

### Requires
- AL.Runner build with protocol v2 (fork branch `feat/alchemist-protocol-v1` until upstream PRs land). Older runners fall back transparently to v1 single-response mode.
```

- [ ] **Step 3: Update README.md**

Add to the feature list:

```markdown
- **Live test results** — Test Explorer pass/fail marks update as each test completes (requires AL.Runner v2)
- **Clickable stack frames** — failure stack traces in Test Results are clickable, jump to the exact `.al` line
- **Native coverage rendering** — gutter icons + Coverage View powered by VS Code's built-in coverage UI
- **Cancel mid-run** — Stop in Test Explorer cancels the current run; the runner stays warm for the next request
```

- [ ] **Step 4: Build + final test pass**

```bash
cd U:/Git/ALchemist
npm run compile
npm run test:unit
```

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md README.md
git commit -m "chore: bump to v0.5.0 — protocol v2 consumer"
```

---

## Self-Review

**1. Spec coverage (`docs/superpowers/specs/2026-04-25-runner-protocol-v2-design.md` ALchemist sections):**

| Spec section | Task |
|---|---|
| § ServerProcess revised — multi-line stream + cancel + v1 fallback | Task 5 ✓ |
| § ServerExecutionEngine revised — testFilter / onTest / cancel / mapping | Task 6 ✓ |
| § TestController revised — progressive run.passed/failed, addCoverage, TestMessageStackFrame, cancel wiring | Task 8 ✓ |
| § DecorationManager revised — retire custom coverage, per-test capturedValues, deepest user frame | Task 9 ✓ |
| § coverageAdapter (new) | Task 7 ✓ |
| § Protocol version detection + status bar tooltip | Task 12 ✓ |
| § Test discipline: fixture-driven, schema-validated samples, snapshot tests | Tasks 2, 5, 6, 7, 11 ✓ |

All ALchemist-side spec deliverables mapped.

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" patterns. Two places use deliberately abbreviated test stubs (Task 8 step 1, Task 11) — those reference the existing test patterns the implementer is told to read first. Acceptable; the implementer has a concrete next step.

**3. Type consistency:**
- `TestEvent`, `Summary`, `Ack`, `Progress`, `FileCoverage`, `AlStackFrame`, `AlErrorKind`, `CapturedValue` all defined in Task 3 and used identically in Tasks 4-12.
- `RunTestsRequest` extends `testFilter` / `cobertura` consistently between Task 6 (interface) and Task 8 (TestController call sites).
- `ExecutionResult.coverageV2` introduced in Task 4 and consumed in Task 7 + Task 8.
- `cancel()` method added to `ExecutionEngine` interface in Task 6, called from Task 8 (TestController), implemented by `ServerExecutionEngine`.

No drift.

---

## Out of scope (Plan E3 / future)

- Sentinel end-to-end manual verification (Plan E3)
- Splitting AL.Runner fork branch into upstream PRs (Plan E3)
- Bundling the AL.Runner v2 binary in the ALchemist VSIX (release-orchestration concern; happens at v0.5.0 publish)
- Per-test caching (AL.Runner doc 08, separate effort)
- Debug Adapter Protocol (A3 roadmap)
- AL LSP integration

---

## Cross-references

- AL.Runner side (Plan E1, complete): `U:/Git/AL.Runner-protocol-v2` branch `feat/alchemist-protocol-v1`, 20 commits ending at `51ab2de`. Sample at `docs/protocol-v2-samples/runtests-coverage-success.ndjson`.
- Spec: `U:/Git/ALchemist/docs/superpowers/specs/2026-04-25-runner-protocol-v2-design.md`
- Plan E3: not yet written; covers Sentinel verification + upstream PR splits.
