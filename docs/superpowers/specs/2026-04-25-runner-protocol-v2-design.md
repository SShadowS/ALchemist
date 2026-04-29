# AL.Runner Protocol v2 + ALchemist Native VS Code APIs — Design Spec

**Date:** 2026-04-25
**Status:** Approved (brainstorming), pending implementation plan
**Targets:** AL.Runner fork branch `feat/alchemist-protocol-v1`; ALchemist v0.5.0
**Builds on:** Plan A + Plan B+D (multi-app + precision-tier + --server execution, shipped)

---

## Problem Statement

ALchemist v0.4.0 ships a 5-layer precision stack and supervised AL.Runner `--server` daemon. Sentinel verification surfaced two correctness gaps and several UX shortfalls rooted in the AL.Runner `--server` protocol's `runtests` response shape:

1. **Inline error decoration at wrong line.** AL.Runner's `runtests` response strips `alSourceLine`/`alSourceColumn` even though they exist on the underlying `TestResult`. Plus, for runtime errors (not assertions) the deepest user frame is buried in a text `stackTrace` blob — there is no structured way to surface "the .al line where the error actually happened."
2. **Coverage gutter icons missing.** The `runtests` response has no coverage data. AL.Runner's `--coverage` writes `cobertura.xml` to disk in CLI mode; server mode skips coverage entirely. ALchemist's gutter icons depend on coverage data that never arrives.

Beyond these two reported bugs, the `runtests` response is meaningfully sparser than the sibling `execute` response. Several rich data already produced by AL.Runner's pipeline is silently dropped during serialization.

Several UX features ALchemist could deliver are blocked by protocol gaps:
- Per-test execution narrowing (server runs all tests in compiled assembly)
- Live Test Explorer updates as tests stream
- Cancel-mid-run that preserves the warm cache
- Per-test `Message()` and capturedValues grouping
- VS Code native coverage UI (`TestRun.addCoverage`, `FileCoverage`, gutter rendering, Coverage View, Run-with-Coverage profile)
- VS Code native stack-frame UI (`TestMessageStackFrame` — clickable, dim runtime frames automatically, navigate to .al sources)

The single most impactful primitive is **`#line` directives in transpile output**. Once Roslyn writes `.al` filenames into IL pdb sequence points, every other feature falls into place: stack traces show .al frames natively, coverage maps via existing pdb tooling, future "debug AL test" lights up automatically.

---

## Goals

- AL.Runner emits `.al` lines in stack traces via standard `.NET` machinery (no custom attributes, no runtime walking).
- `runtests` response has feature parity with `execute` (alSourceLine/Column, messages, capturedValues, iterations) plus new fields (DAP-aligned `stackFrames`, `errorKind`, structured `coverage`).
- Per-test `runtests` filtering (`testFilter` field).
- Streaming results: per-test events as they complete, terminal summary.
- Cancel command preserves the warm cache.
- ALchemist consumes via VS Code native APIs (`TestRun.addCoverage`, `TestMessageStackFrame`, progressive `passed`/`failed` calls).
- Forward-/backward-compatible protocol versioning.
- Fork-first development: full feature in fork branch, end-to-end Sentinel verification, then upstream PRs split for review velocity.

## Non-Goals

- AL Debug Adapter Protocol implementation (drops in cleanly on `#line` foundation; planned as future work, out of v1 scope)
- Per-test compilation-result caching (AL.Runner roadmap doc 08; design ownership remains upstream)
- Partial-compile / best-effort run (significant runtime work, separate effort)
- Setup/cleanup categorization beyond what `errorKind` captures
- AL LSP integration

---

## Chosen Approach: A2 (transpile + protocol)

| Repo | Layer | Change |
|---|---|---|
| AL.Runner | Transpiler | Inject `#line N "src/Foo.al"` directives before each generated C# statement |
| AL.Runner | Runtime | New `StackFrameMapper`, `ErrorClassifier`, structured `CoverageReport.ToJson` |
| AL.Runner | Executor | `TestFilter` parameter, `onTestComplete` callback for streaming |
| AL.Runner | Server | Revised `SerializeServerResponse` (field parity + new fields), NDJSON streaming, `cancel` command, `protocolVersion: 2` |
| ALchemist | ServerProcess | Tagged-line streaming consumption, `cancel()` method, v1 fallback |
| ALchemist | ServerExecutionEngine | `testFilter` passthrough, `onTest` callback wiring |
| ALchemist | TestController | Per-test `run.passed/failed`, VS Code coverage API, `TestMessageStackFrame[]` |
| ALchemist | DecorationManager | Retire custom coverage gutters (VS Code renders natively) |
| ALchemist | coverageAdapter | New module: AL.Runner JSON → `vscode.FileCoverage[]` |

**Why `#line` is the primitive:**
- Standard .NET stack-trace machinery (`StackFrame.GetFileName/GetFileLineNumber`) returns `.al` filenames natively
- Coverage tools read pdb sequence points natively
- Future debugger work uses same sequence points
- One source of truth, zero custom runtime walking

**Roadmap (out of scope for v1, foundation enabled):**
- Full Debug Adapter Protocol (A3) — VS Code attaches Roslyn debugger, steps through .al files, breakpoints work natively
- Per-test caching with state-isolation invariants (AL.Runner doc 08)

---

## Architecture

```
┌──────────────────────────────── AL.Runner (fork: feat/alchemist-protocol-v1) ────────────────────────────────┐
│                                                                                                              │
│  AL Source (.al)                                                                                             │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  Transpiler (NEW: #line directives)                                                                          │
│    emits: #line N "src/Foo.al" before each generated C# statement                                            │
│    Roslyn writes .al filename + line into IL pdb sequence points                                             │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  Compiled assembly with .al pdb maps  ┐                                                                      │
│       │                                │                                                                     │
│       ▼                                ▼                                                                     │
│  Executor.RunTests (REVISED)    CoverageReport (REVISED)                                                     │
│    - testFilter filters tests     - ToJson() structured per-statement                                        │
│    - onTestComplete callback      - ALSO emits cobertura.xml (existing)                                      │
│    - per-test capturedValues/                                                                                │
│      messages via AsyncLocal                                                                                 │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  StackFrameMapper (NEW)          ErrorClassifier (NEW)                                                       │
│    - Walk(Exception)               - Classify → AlErrorKind                                                  │
│    - FindDeepestUserFrame                                                                                    │
│    - ClassifyHint                                                                                            │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  Server.SerializeServerResponse (REVISED)                                                                    │
│    - field parity with execute response                                                                      │
│    - DAP-aligned stackFrames per test                                                                        │
│    - structured coverage[] per file                                                                          │
│    - emits NDJSON: per-test lines + terminal summary                                                         │
│    - new "cancel" command                                                                                    │
│    - protocolVersion: 2 in summary                                                                           │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  stdout NDJSON stream                                                                                        │
└──────────┬───────────────────────────────────────────────────────────────────────────────────────────────────┘
           │ JSON-RPC newline-delimited
           ▼
┌──────────┴────────────────────────── ALchemist v0.5.0 (master) ──────────────────────────────────────────────┐
│                                                                                                              │
│  ServerProcess (REVISED)                                                                                     │
│    - reads multi-line responses with type discriminator                                                      │
│    - 'test' lines → onEvent callback                                                                         │
│    - 'summary' line → resolves request promise                                                               │
│    - cancel(): fire-and-forget shutdown signal                                                               │
│    - detects protocolVersion; falls back to v1 single-response if absent                                     │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  ServerExecutionEngine (REVISED)                                                                             │
│    - testFilter / coverage passthrough                                                                       │
│    - response → ExecutionResult mapping (richer)                                                             │
│    - cancel() forwards to ServerProcess                                                                      │
│    - onTest callback fires per streaming line                                                                │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  TestController (REVISED)                                                                                    │
│    - per-test progress: TestRun.passed/failed AS EACH ARRIVES                                                │
│    - failure: vscode.TestMessage with TestMessageStackFrame[]                                                │
│    - errorKind drives UI variation (assertion → diff, runtime → stack, etc.)                                 │
│    - coverage → TestRun.addCoverage(FileCoverage[]) (VS Code native rendering)                               │
│    - capturedValues per-test-id → editor decorations scoped per active test                                  │
│    - cancel button (existing Test Explorer cancel) → engine.cancel()                                         │
│       │                                                                                                      │
│       ▼                                                                                                      │
│  coverageAdapter (NEW)                                                                                       │
│    - AL.Runner FileCoverage[] → vscode.FileCoverage[]                                                        │
│                                                                                                              │
│  DecorationManager (REVISED)                                                                                 │
│    - Custom coverage decorations RETIRED (VS Code renders natively)                                          │
│    - Inline errors use deepest-user-frame from stackFrames                                                   │
│    - Per-test capturedValues scoped to active test                                                           │
│                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Architectural invariants

1. **`#line` directives are the primitive.** Every other feature builds on them. Implement first.
2. **NDJSON streaming.** `runtests` request → multiple response lines (`{"type":"test",...}` per test, terminal `{"type":"summary",...}`).
3. **Protocol versioning.** Summary includes `{"protocolVersion": 2}`. ServerProcess detects and adapts. v1 servers → ALchemist falls back to non-streaming consumption.
4. **VS Code native APIs.** Coverage → `TestRun.addCoverage()`. Stack frames → `TestMessageStackFrame[]`. Custom decorations retired.
5. **Fork-first development.** Branch `feat/alchemist-protocol-v1` in AL.Runner fork. End-to-end Sentinel verification before any upstream PR.

---

## Components

### AL.Runner Side

#### 1. Transpiler — `#line` directive injection

**Owns:** AL → C# code generation. Emits `#line` directives before each statement so Roslyn's pdb maps IL back to `.al` source.

**Where:** existing AL→C# emitter (likely in `AlRunner/Pipeline.cs` or sibling — locate via `grep -rn "namespace.*Pipeline\|GenerateCSharp\|CSharpEmitter"`).

**Change:** before emitting each statement's C# equivalent, write `#line {alLine} "{relPath}/{fileName}.al"` followed by the C# statement. The transpiler already tracks AL line numbers (visible in `t.AlSourceLine` on `TestResult`).

**Path normalization:** always emit forward-slash relative paths from AL project root. Quote paths containing spaces or special characters per C# `#line` directive grammar.

**Verification:** post-compile, inspect emitted `.cs` files (write to `publish-debug/` flag in dev) — they contain `#line` directives. Stack-trace dump shows `.al` filenames.

#### 2. Source-mapped frame walker — `StackFrameMapper`

**File:** `AlRunner/StackFrameMapper.cs` (new).

```csharp
public record AlStackFrame(
  string? File, int? Line, int? Column,
  bool IsUserCode, string? Name, FramePresentationHint Hint);

public enum FramePresentationHint { Normal, Subtle, Deemphasize, Label }

public static class StackFrameMapper {
  public static List<AlStackFrame> Walk(Exception ex);
  public static AlStackFrame? FindDeepestUserFrame(IReadOnlyList<AlStackFrame> frames);
  public static FramePresentationHint ClassifyHint(string? file, string? methodName);
}
```

`Walk(ex)` parses `ex.StackTrace` lines (Roslyn's pdb-aware StackTrace formatter does this when source maps load). For each frame: if filename ends with `.al` → `IsUserCode: true, Hint: Normal`. If type matches `Mock*`, `AlScope`, `Microsoft.Dynamics.*` → `Hint: Subtle`. Else → `Hint: Deemphasize`.

`FindDeepestUserFrame(frames)` returns the last user-code frame in the walk order (the frame closest to the throw point that's user code).

#### 3. Error classifier — `ErrorClassifier`

**File:** `AlRunner/ErrorClassifier.cs` (new).

```csharp
public enum AlErrorKind { Assertion, Runtime, Compile, Setup, Timeout, Unknown }

public static class ErrorClassifier {
  public static AlErrorKind Classify(Exception ex, TestExecutionContext ctx);
}
```

Heuristics:
- `MockAssert.AssertionException` → `Assertion`
- `OperationCanceledException` (test timeout) → `Timeout`
- `CompilationFailedException` → `Compile`
- Exception during `Subtype = Test` codeunit's `[OnRun]` (before any `[Test]` proc) → `Setup`
- `null` exception → `Unknown`
- Default → `Runtime`

#### 4. Coverage data — `CoverageReport.ToJson`

**File:** extend existing `AlRunner/CoverageReport.cs`.

```csharp
public record FileCoverage(string File, List<LineCoverage> Lines, int TotalStatements, int HitStatements);
public record LineCoverage(int Line, int Hits);

public static List<FileCoverage> ToJson(
  IDictionary<string, List<SourceSpan>> sourceSpans,
  ISet<int> hitStmts,
  ISet<int> totalStmts,
  IDictionary<int, string> scopeToObject);
```

ALSO keeps existing `WriteCobertura` for external tools — only emits when explicit `cobertura: true` flag set in server request (default off in server mode).

Multiple statements on same line aggregate into single `LineCoverage` with summed hits (cobertura behavior).

#### 5. Test execution — `Executor.RunTests` revised

**Owns:** runs tests in compiled assembly, applies filter, streams per-test results.

```csharp
public record TestFilter(IReadOnlySet<string>? CodeunitNames, IReadOnlySet<string>? ProcNames);

public static List<TestResult> RunTests(Assembly assembly,
  TestFilter? filter = null,
  Action<TestResult>? onTestComplete = null,
  CancellationToken cancellationToken = default);
```

Filter combines codeunit AND proc name (both must match if both provided). Per-test `capturedValues` and `messages` tracked via `AsyncLocal<TestExecutionContext>` so values are scoped to the running test.

Cancellation: token observed at the top of each test loop iteration. Cooperative — current test runs to completion before cancel takes effect.

#### 6. Server protocol — `Server.cs` revised

**Owns:** JSON-RPC dispatch + NDJSON streaming + new commands.

`ServerRequest` adds:
- `testFilter` (object): `{ codeunitNames?: string[], procNames?: string[] }`
- `coverage` (bool, default false)
- `cobertura` (bool, default false): when true also emits cobertura.xml file
- `protocolVersion` (int): client-declared version (server echoes its actual version in summary)

New command: `cancel`. Sets a shared `CancellationTokenSource` consumed by current request. Returns `{type: "ack", noop: false}` or `{type: "ack", noop: true}` if no active request.

`HandleRunTests` writes per-test lines to stdout as they arrive (via `Executor.RunTests`'s `onTestComplete` callback), then terminal summary line. All lines tagged with `type` field (`test`, `summary`, `progress`, `error`, `ack`).

Summary line includes `protocolVersion: 2`.

#### 7. Coverage emission

**Owns:** wire coverage flag through Pipeline + emission paths.

`PipelineOptions.ShowCoverage` already exists. New path: when `request.coverage === true`, set `ShowCoverage`; on completion, call `CoverageReport.ToJson(...)` and include in summary line. ALSO call `WriteCobertura(...)` if `request.cobertura === true` (default off in server mode).

### ALchemist Side

#### 8. `ServerProcess` revised

**File:** `src/execution/serverProcess.ts`.

```typescript
async send(payload: object, onEvent?: (event: any) => void): Promise<any>;
async cancel(): Promise<void>;          // fire-and-forget; doesn't await response
```

Behavior:
- Reads stdout lines until `{type: "summary"}` arrives → resolves promise with full result
- Intermediate lines (`type: "test"`, `type: "progress"`) fire `onEvent` callback if provided
- `cancel()` writes `{"command":"cancel"}` line without awaiting — server processes async
- Detects `protocolVersion` in summary; if absent or `<2`, falls back to v1 single-response handling (no streaming, no per-test events)
- Malformed JSON line skipped (logged once per session)
- Handles existing crash → respawn → retry pattern (Plan B+D infra)

#### 9. `ServerExecutionEngine` revised

**File:** `src/execution/serverExecutionEngine.ts`.

```typescript
interface RunTestsRequest {
  sourcePaths: string[];
  testFilter?: { codeunitNames?: string[]; procNames?: string[] };
  coverage?: boolean;
  captureValues?: boolean;
  iterationTracking?: boolean;
  cobertura?: boolean;
}

async runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult>;
async cancel(): Promise<void>;
```

Forwards `testFilter` and `coverage` to JSON payload. `onTest` fires per streaming `test` event. `cancel()` forwards to ServerProcess.

The status-string map (`pass→passed`, `fail→failed`) preserved from Plan B+D bug fix; re-applied per test event.

#### 10. `TestController` revised

**File:** `src/testing/testController.ts`.

```typescript
private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = this.controller.createTestRun(request);
  token.onCancellationRequested(() => this.engine?.cancel());

  const result = await this.engine!.runTests({...}, (event) => {
    const item = this.testItems.get(event.name);
    if (!item) return;
    if (event.status === 'passed') run.passed(item, event.durationMs);
    else if (event.status === 'failed') run.failed(item, this.buildTestMessage(event));
    else run.errored(item, this.buildTestMessage(event));
  });

  // Final pass: VS Code native coverage
  if (result.coverage && 'addCoverage' in run) {
    for (const fc of toVsCodeCoverage(result.coverage)) {
      run.addCoverage(fc);
    }
  }

  run.end();
}

private buildTestMessage(event: TestEvent): vscode.TestMessage {
  const message = new vscode.TestMessage(event.message ?? 'Test failed');
  if ('TestMessageStackFrame' in vscode && event.stackFrames) {
    message.stackTrace = event.stackFrames.map(f => new vscode.TestMessageStackFrame(
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
```

#### 11. `DecorationManager` revised

**Coverage decorations RETIRED** — VS Code's `addCoverage` API renders gutter icons natively. Custom green/gray/red SVGs deleted from `resources/`. Settings `alchemist.showGutterCoverage` and `alchemist.dimUncoveredLines` repurposed: now control VS Code's coverage display preferences via `vscode.workspace.getConfiguration('testing')` proxies, or removed if redundant.

**Captured values** — now scoped per-test-id. Stored as `Map<TestId, CapturedValue[]>`. When user selects a test in Test Explorer (or after a save-triggered run), display values from active test. Multi-test displays remain compatible.

**Inline error** — uses deepest-user-frame from `event.stackFrames` (or fallback `alSourceLine`). Position-accurate in `.al` source.

#### 12. `coverageAdapter` (new)

**File:** `src/execution/coverageAdapter.ts`.

```typescript
import * as vscode from 'vscode';
import { FileCoverage } from './executionEngine';

export function toVsCodeCoverage(alCoverage: FileCoverage[]): vscode.FileCoverage[] {
  return alCoverage.map(f => {
    const fc = new vscode.FileCoverage(
      vscode.Uri.file(f.file),
      new vscode.TestCoverageCount(f.hitStatements, f.totalStatements),
    );
    fc.detailedCoverage = f.lines.map(l =>
      new vscode.StatementCoverage(l.hits, new vscode.Position(l.line - 1, 0))
    );
    return fc;
  });
}
```

---

## Data Flow

### Test run (full lifecycle)

```
User clicks "Run" on test in Test Explorer
   │
   ▼
TestController.runTests(request, token)
   │ token.onCancellationRequested → engine.cancel()
   ▼
ExecutionEngine.runTests({sourcePaths, testFilter, coverage: true},
                         onTest: (event) => …)
   │
   ▼
ServerProcess.send(payload, onEvent)
   │ stdin: JSON line + \n
   │
   │   AL.Runner --server reads line → HandleRunTests
   │     1. Compute fingerprint, check cache
   │     2. If miss: compile via Pipeline (with #line directives)
   │     3. Filter assembly tests via testFilter
   │     4. Executor.RunTests with onTestComplete callback
   │
   │   (per test as it completes)
   │     stdout writes:
   │       {"type":"test","name":"BarTest","status":"pass",
   │        "durationMs":42,"alSourceFile":"src/Foo.al","alSourceLine":15,
   │        "stackFrames":[...],"messages":[...],"capturedValues":[...]}
   │
   │   (after all tests)
   │     stdout writes:
   │       {"type":"summary","passed":3,"failed":1,"errors":0,"total":4,
   │        "exitCode":1,"cached":false,"changedFiles":[...],
   │        "coverage":[{"file":"src/Foo.al","lines":[{"line":15,"hits":1}],
   │                     "totalStatements":42,"hitStatements":31}],
   │        "protocolVersion":2}
   │
   ▼ ServerProcess reads stdout lines
   │
   │   For each line:
   │     parse JSON, check `type`
   │     - "test" → invoke onEvent({test: line})
   │     - "summary" → resolve promise with accumulated result
   │     - "ack" / "progress" → log, continue
   │
   ▼
ExecutionEngine resolves runTests() with ExecutionResult
   │ (already fired onTest events progressively during streaming)
   ▼
TestController received per-test events:
   for each test event:
     vscode.TestRun.passed(item, durationMs) | failed(item, message) | errored(item)
     // Live update — Test Explorer green/red marks appear in real time

   on final result:
     for each FileCoverage in coverage:
       vscode.FileCoverage → run.addCoverage(...)
     // VS Code natively renders gutter icons + Coverage View

   run.end()
   │
   ▼
Editor decorations applied:
   - Inline error at deepest user frame (from event.alSourceLine)
   - capturedValues for currently-active test
   - VS Code coverage gutter rendered automatically
```

### Cancel flow

```
User clicks "Stop" in Test Explorer (or Ctrl+Shift+A C)
   │
   ▼
token.onCancellationRequested fires
   │
   ▼
engine.cancel()
   │
   ▼
ServerProcess.cancel()
   stdin write: {"command":"cancel"}\n  (fire-and-forget)
   │
   │   AL.Runner --server:
   │   ┌─ Cancel command sets shared CancellationTokenSource
   │   │  Currently-running Executor.RunTests sees token, breaks loop after current test
   │   │  Writes terminal summary line: {"type":"summary","cancelled":true,...}
   │
   ▼ ServerProcess receives summary, resolves pending request promise
   │
   ▼
TestController:
   - Tests not yet reported are marked skipped via run.skipped(item)
   - run.end()
   - Server stays alive — next runtests reuses warm cache
```

### Activation flow (unchanged from Plan B+D)

```
extension.activate()
  ├─ WorkspaceModel.scan()
  ├─ ParseCache.initialize() (async)
  ├─ SymbolIndex.initialize() (async, on parseCache ready)
  ├─ TestRouter constructed (on index ready)
  ├─ runnerManager.ensureInstalled()
  │    └─ ServerProcess constructed (lazy spawn on first request)
  │    └─ ServerExecutionEngine wraps ServerProcess
  └─ TestController constructed with onResult + onTest callbacks
```

### Protocol version detection

First `runtests` request returns summary with `protocolVersion: 2` if AL.Runner ≥ new version. ServerProcess records the version. If `protocolVersion` absent or `< 2`:
- Fallback to v1 consumption (no streaming, no per-test events)
- ALchemist still works but loses live Test Explorer updates
- Status bar tooltip: "AL.Runner protocol v1 (upgrade for live updates)"

### Coverage rendering (VS Code native flow)

```
TestRun.addCoverage(fileCoverage[]) called by TestController
   │
   ▼
VS Code TestCoverage UI:
   - Editor gutter icons (✓ green for hit, ✗ red for miss, ▽ partial)
   - Coverage View panel (Test Explorer sidebar): tree of files with %
   - Hover a line → tooltip "Hit N times"
   - "Run with Coverage" becomes a separate run profile in Test Explorer
   (All native — no custom rendering code in ALchemist)
```

### `#line` → stack-frame round trip

```
AL source:
   // src/Foo.al, line 42
   Customer.Insert();

Transpiler emits:
   #line 42 "src/Foo.al"
   _customer.Insert();

Roslyn compile → IL with sequence point IL_0042 at "src/Foo.al":42

Runtime:
   _customer.Insert() throws → exception captures StackFrame
   StackFrame.GetFileName() == "src/Foo.al"
   StackFrame.GetFileLineNumber() == 42

StackFrameMapper.Walk(ex):
   yields AlStackFrame { File: "src/Foo.al", Line: 42, IsUserCode: true, Hint: Normal }

Server emits in test response:
   "stackFrames": [{"name":"...","source":{"path":"src/Foo.al"},"line":42,
                    "presentationHint":"normal"}]

ALchemist:
   vscode.TestMessageStackFrame { uri, position, label } pushed to TestMessage.stackTrace
   → user clicks frame → editor opens at exact line
```

---

## Error Handling

| Scenario | Where | Handling |
|---|---|---|
| `#line` directive maps to wrong file (transpiler bug) | AL.Runner StackFrameMapper | Frame's `File` exists but doesn't match any workspace `.al` — emitted as user-code frame anyway. ALchemist's frame click fails to open file. Fail-loud at frame-click time. |
| `#line` directive missing for some statement (transpiler gap) | AL.Runner Pipeline | Generated C# has no sequence point for that statement → exception's frame.GetFileName returns the C# file path. Mapper marks `IsUserCode: false, Hint: Deemphasize`. Frame still shown, just dimmed. No data lost. |
| Roslyn pdb load failure at runtime | AL.Runner Executor | StackFrame.GetFileName returns null. Mapper yields `{File: null, IsUserCode: false}`. Falls back to method name only. |
| `testFilter` matches no tests | AL.Runner Server | Returns `{type: "summary", passed: 0, failed: 0, total: 0, exitCode: 0}`. ALchemist Test Explorer shows no progress, no error. |
| `testFilter` references unknown codeunit/proc names | AL.Runner Server | Filter intersects with discovered tests; missing names just don't match. No error. |
| Cancel arrives while no run in flight | AL.Runner Server | No-op. Returns `{type: "ack", noop: true}`. |
| Cancel arrives between tests during streaming | AL.Runner Executor | Token observed at top of next test loop iteration → break. Tests already streamed remain. Summary emitted with `{cancelled: true}`. ALchemist marks remaining tests as `skipped`. |
| Cancel arrives mid-test (during user code) | AL.Runner Executor | Cooperative cancellation — current test runs to completion, then cancel observed. Document: cancel doesn't interrupt arbitrary user code. |
| Streaming line corruption (partial JSON in pipe) | ALchemist ServerProcess | Existing buffer logic concats split lines until newline. Malformed JSON line skipped (logged once). If summary line never arrives → 30s default timeout → reject promise. |
| Server crashes during streaming | ALchemist ServerProcess | Existing crash handler triggers. In-flight request retried once. Document: streaming events are advisory; final result is authoritative. |
| Coverage data too large (>1MB JSON) for huge workspace | AL.Runner Server | Coverage is per-file with per-line hits. For 1000 .al files × 100 lines avg → ~5MB JSON. Acceptable for stdin/stdout (no protocol limit). Add `coverage: { detail: 'summary'|'full' }` flag if needed (out of v1). |
| AL.Runner version < new protocol (no protocolVersion field) | ALchemist ServerProcess | Detects absence of `protocolVersion` in summary → falls back to v1 consumption. Status bar tooltip: "AL.Runner protocol v1 — upgrade for live updates". |
| ALchemist reads `protocolVersion: 3` (future) | ALchemist ServerProcess | Treat as v2 (forward-compat). New fields in lines simply unused. Don't reject. |
| `errorKind` is unknown enum value | ALchemist TestController | Default to 'unknown', UI treats same as 'runtime'. Don't reject. |
| `presentationHint` is unknown value | ALchemist | Default to 'normal'. Don't reject. |
| VS Code version < 1.93 (no `TestMessageStackFrame`) | ALchemist | Detect at activation via `'TestMessageStackFrame' in vscode`. If absent: build inline message string from frames. Lose clickable-frame UI on old VS Code; everything else works. |
| VS Code version < 1.88 (no `TestRun.addCoverage`) | ALchemist | Detect via feature presence. If absent: fall back to current cobertura.xml + custom decoration rendering (Plan A behavior). Lose VS Code native coverage UI; gutter icons still appear via custom. |
| Per-test `capturedValues` empty when test passed without captures | AL.Runner | Empty array. ALchemist shows nothing. Normal. |
| Mixed-format response (some lines tagged with `type`, some not) | ALchemist | Parser handles each line independently; untagged lines skipped or treated as v1 summary. Robust. |
| `#line` directive in user-supplied AL | AL.Runner Transpiler | `#line` is C# syntax, not AL. AL parser would reject as syntax error before transpile. Not a concern. |
| `cancel` race with pending request resolution | ALchemist ServerProcess | Cancel sent → server processes, emits summary with `cancelled: true`. Pending promise resolves normally. No hang. |
| AL.Runner server emits `error` line mid-stream | ALchemist ServerProcess | Treat as terminal — resolves request with success: false, surfaces error. Subsequent lines ignored. |
| Transpiler `#line` with directory traversal (`../../foo.al`) | AL.Runner Transpiler | Always emit normalized relative paths from project root. Document: trusted input from filesystem. |
| Multiple AL apps with same file name | AL.Runner StackFrameMapper | Frame's path is workspace-relative (e.g., `MainApp/src/Foo.al` vs `MainApp.Test/src/Foo.al`) — distinct paths, no collision. |
| Coverage line numbers off-by-one (sequence-point vs editor) | ALchemist coverageAdapter | VS Code uses 0-indexed Position; AL.Runner emits 1-indexed line. Adapter subtracts 1. Test fixture validates. |

---

## Testing

### AL.Runner side (xUnit / mstest — match existing infra)

**Transpiler `#line` directive emission** (`tests/transpiler-line-directives/`)
- Every emitted statement preceded by `#line N "<file>"`
- Paths emitted as forward-slash relative
- Paths containing spaces correctly quoted
- Multiple statements on same AL line emit single `#line`
- Comments don't shift line numbers

**`StackFrameMapper`**
- `Walk_ParsesAlFilenames` — exception with .al frames yields `IsUserCode: true, Hint: Normal`
- `Walk_ClassifiesRuntimeFrames` — Mock*, AlScope, Microsoft.Dynamics.* → Hint: Subtle
- `Walk_HandlesUnknownFrames` — frame with no source info → IsUserCode: false, Hint: Deemphasize
- `FindDeepestUserFrame_ReturnsLastUserFrame` — stack [Mock, Mock, User1, Mock, User2] → returns User2
- `FindDeepestUserFrame_NoUserFrames` — all-runtime stack → returns null
- `Walk_HandlesAsyncStateMachine` — async exception correctly attributed via #line

**`ErrorClassifier`**
- `Classify_AssertionException` → Assertion
- `Classify_OperationCanceledException` → Timeout
- `Classify_CompilationFailedException` → Compile
- `Classify_GenericExceptionDuringTestSetup` → Setup
- `Classify_GenericExceptionDuringTest` → Runtime
- `Classify_NullException` → Unknown

**`CoverageReport.ToJson`**
- `ToJson_BuildsFileEntries` — fixture w/ 3 hits in 2 files → 2 FileCoverage entries
- `ToJson_LineDeduplication` — multiple statements on same line → single LineCoverage with summed hits
- `ToJson_TotalsCorrect` — totalStatements/hitStatements match per-line aggregation
- `ToJson_NoHits` — no execution → all lines 0 hits, but all present

**`Executor.RunTests` revised**
- `RunTests_WithCodeunitFilter_RunsOnlyMatching`
- `RunTests_WithProcFilter` — only proc named BarTest
- `RunTests_FilterUnion` — both fields → AND-combined
- `RunTests_StreamingCallbackInvokedPerTest` — onTestComplete called once per test in declaration order
- `RunTests_PerTestCapturedValues` — values from testA isolated from testB
- `RunTests_PerTestMessages` — messages from testA absent from testB's array

**`Server.cs` HandleRunTests revised**
- `HandleRunTests_StreamsTestLines` — fixture w/ 3 tests → stdout has 3 `{type:"test"}` + 1 `{type:"summary"}`
- `HandleRunTests_TerminalSummaryAlwaysLast`
- `HandleRunTests_ProtocolVersion2InSummary`
- `HandleRunTests_AppliesCoverage` — `coverage: true` → summary includes coverage array
- `HandleRunTests_NoCoverageByDefault` — `coverage` absent → summary omits
- `HandleRunTests_AppliesTestFilter`
- `HandleRunTests_PerTestStackFrames` — failing test → test line includes structured stackFrames
- `HandleCancel_NoActiveRequest` → `{type:"ack", noop:true}`
- `HandleCancel_DuringActiveRequest` → cancellation token tripped, current request finishes early with `cancelled:true`

### ALchemist side (mocha — existing infra)

**`ServerProcess` streaming**
- `Send_ReadsTaggedLines` — mock stdout emits 2 test + 1 summary → onEvent called 2x, promise resolves with summary
- `Send_OldServerSingleResponse_v1Fallback` — response without `protocolVersion` → no onEvent, single resolve
- `Send_MalformedLineIgnored`
- `Send_ResolveOnSummary` — only when summary arrives
- `Cancel_DoesNotWaitForResponse`
- `Cancel_DuringSend_DoesNotHang` — pending send resolves with cancelled:true summary
- `Send_ServerCrashMidStream_RetriesOnce`

**`ServerExecutionEngine`**
- `RunTests_ForwardsTestFilter`
- `RunTests_ForwardsCoverage`
- `RunTests_OnTestCallback` — fires per streaming line
- `RunTests_StatusMapPreservedFromV1Fix` — pass→passed mapping (regression)
- `Cancel_ForwardsToProcess`

**`coverageAdapter`**
- `ToVsCodeCoverage_PerFile` — input 2 files → output 2 FileCoverage
- `ToVsCodeCoverage_OneIndexedToZeroIndexed` — line 42 → Position(41, 0)
- `ToVsCodeCoverage_HitsPreserved`
- `ToVsCodeCoverage_TotalsMatch`
- `ToVsCodeCoverage_EmptyInput`

**`TestController` streaming**
- `RunTests_FiresPassedPerTestEvent` — stub engine streams 3 pass events → run.passed called 3x progressively
- `RunTests_FiresFailedWithStackFrames` — fail event with stackFrames → vscode.TestMessage has stackFrames
- `RunTests_AddsCoverageOnFinalResult` — coverage on summary → run.addCoverage called per file
- `RunTests_CancelTokenForwardsToEngine`

### Integration (extension-host, `@vscode/test-electron`)
- `MultiAppFixture_TestRunWithFilter`
- `MultiAppFixture_CoverageRendered` — after run, `vscode.tests.activeTestCoverage` exists for affected files
- `MultiAppFixture_StackFramesClickable` — failing test's TestMessage stackFrames have valid file URIs
- `MultiAppFixture_CancelDuringRun_PartialResults`

### End-to-end verification on Sentinel

Manual verification doc (`docs/superpowers/plans/<date>-protocol-v2-verification.md`):

- [ ] Open Sentinel via `al.code-workspace`
- [ ] Run All tests → status bar streams "running test 1/49 → 49/49"
- [ ] Failed test "FullRerunClearsAndRecreatesAlerts" → inline error decoration at `Company.Insert();` line (not `[Test]` header)
- [ ] Click failing test in Test Results panel → stack frames visible, `Dispatcher.FullRerun` frame clickable, opens Dispatcher.Codeunit.al at correct line
- [ ] BC runtime frames (MockRecord, AlScope) shown but dimmed
- [ ] Coverage gutter icons visible (VS Code native: ✓ green, ✗ red, ▽ partial)
- [ ] Hover gutter icon → tooltip "Hit N times"
- [ ] Coverage View panel shows files with % covered
- [ ] "Run with Coverage" run profile works distinctly from regular Run
- [ ] Right-click single test → Run → only that test executes (testFilter)
- [ ] Click Stop mid-run → tests-in-flight finish, remaining marked skipped, daemon stays warm
- [ ] Re-run after cancel → cache hit (`cached:true`), instant
- [ ] AL.Runner downgraded → status bar "v1 protocol", no streaming, but tests still run
- [ ] Per-test `Message()` output appears inline only on lines within that test's procedure
- [ ] Per-test capturedValues display correctly when test selected in Test Explorer

### Coverage tracking targets

Both repos:
- Branch coverage on all new conditionals
- Error-path coverage for every try/catch
- Mock-based tests where the runtime/process boundary is brittle
- Regression test for every bug found during Sentinel verification

Per memory: more tests preferred over fewer; never skimp.

### Test discipline

- Fixture-driven where possible — small AL projects committed, exercised via real parse/compile/execute
- Single source of truth for protocol shape: `protocol-v2.schema.json` (JSON Schema) committed in AL.Runner repo. ALchemist's tests validate response samples against it. Catches drift.
- Snapshot tests for stack-frame walking and coverage emission — golden files in `tests/golden/`

---

## Implementation Sequence (preview for writing-plans)

The writing-plans skill will decompose. High-level order:

1. **AL.Runner: `#line` directive injection** — foundation. Verify pdb sequence points show .al filenames in test stack traces.
2. **AL.Runner: `StackFrameMapper` + `ErrorClassifier`** — pure modules, unit-tested in isolation.
3. **AL.Runner: `CoverageReport.ToJson`** — pure function, fixture-tested.
4. **AL.Runner: `Executor.RunTests` revised** — testFilter + onTestComplete + per-test isolation via AsyncLocal.
5. **AL.Runner: Server protocol v2** — revised SerializeServerResponse, NDJSON streaming, cancel command, protocolVersion.
6. **AL.Runner: Schema definition** — `protocol-v2.schema.json` for cross-repo validation.
7. **ALchemist: ServerProcess streaming + cancel + v1 fallback**.
8. **ALchemist: ServerExecutionEngine** — testFilter passthrough, onTest callback, cancel forward.
9. **ALchemist: coverageAdapter** — pure function, fixture-tested.
10. **ALchemist: TestController revised** — progressive run.passed/failed, addCoverage, TestMessageStackFrame, cancel wiring.
11. **ALchemist: DecorationManager retiring custom coverage** — replace with VS Code native; per-test capturedValues scoping.
12. **End-to-end Sentinel verification** — close out manual checklist.
13. **Upstream PRs** — split AL.Runner branch into 5-6 reviewable PRs.
14. **CHANGELOG + README + version bump** to ALchemist v0.5.0.

Each step ships green before next.

---

## Open Questions / Risks

- **AL.Runner upstream review velocity** — PRs may take time. Fork keeps full feature; ALchemist consumes from fork. Acceptable.
- **`#line` directive emission gaps** — AL constructs the transpiler may not yet handle (e.g., expressions in middle of statement, nested triggers). Spike during step 1; document gaps; iterate.
- **Coverage detail at scale** — 1000-file workspaces may produce large JSON. Monitor; add `coverage.detail` flag in v3 if needed.
- **VS Code coverage API stability** — `addCoverage`, `FileCoverage`, `StatementCoverage` shipped 1.88+. `TestMessageStackFrame` shipped 1.93+. Detection paths in place.
- **Cooperative cancellation** — current test runs to completion before cancel takes effect. Document; don't try to interrupt user code mid-execution (would require unwinding the transpiled C# at arbitrary points; high complexity).
- **Mock state isolation** — per-test `capturedValues`/`messages` via AsyncLocal works for sequential test execution. Future per-test caching (AL.Runner doc 08) may need stronger isolation. Out of scope.
- **Status string preservation** — Plan B+D's `pass→passed` map must be reapplied per streaming event. Regression test in ServerExecutionEngine suite.
- **External tools using cobertura.xml** — preserve via opt-in `cobertura: true` flag in server request. Default off to avoid file I/O.
