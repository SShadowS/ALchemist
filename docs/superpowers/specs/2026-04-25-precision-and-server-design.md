# Precision-Tier Routing + AL.Runner --server Execution — Design Spec

**Date:** 2026-04-25
**Status:** Approved (brainstorming), pending implementation plan
**Builds on:** `2026-04-24-multi-app-test-discovery-design.md` (Plan A — multi-app foundation, shipped)
**Targets:** ALchemist v0.4.0

---

## Problem Statement

Plan A shipped multi-app workspace support with **fallback-tier** save routing: when a file is saved, run every test in every app that transitively depends on it. This is correct (no missed regressions) but coarse — for a workspace where one main-app file change affects 3 of 200 tests, all 200 still run.

Plan A also still uses **one-shot AL.Runner invocations**: every test run incurs process spawn (~500ms cold start), .NET JIT, Roslyn reference load, AL parse, transpile, compile. AL.Runner 1.0.12+ ships a `--server` JSON-RPC daemon with per-file rewrite cache + syntax-tree cache (~24x speedup on warm save). ALchemist doesn't yet use it.

Two missing capabilities:

1. **Precision tier** — narrow the test set to only those affected by the saved file, via cross-file symbol/reference analysis.
2. **Warm execution** — run tests against a long-lived AL.Runner daemon with persistent caches.

Both are needed for ALchemist to feel like Quokka-style live feedback on real-world AL workspaces.

---

## Goals

- Precision-tier save routing: tests run on save = `(declared in saved file) ∪ (referencing tests in other files)`.
- Confidence-aware fallback: when index is uncertain (parse errors in saved file or mid-rebuild), drop to Plan A's fallback tier; never silently miss a regression.
- Warm execution path: every AL.Runner invocation through the supervised `--server` daemon. Cache-warm runs sub-second.
- Future-swap surface: when AL.Runner ships native partial-execution (planned per its docs 08+09), our routing layer becomes a thin client; the index stays useful for hover/refs/dead-code features.
- Architectural soundness: 5-layer stack with strict unidirectional dependencies.
- Visible scope/state: status bar reflects current tier and confidence reason.
- Zero new user-facing config — defaults are correct in all tested scenarios.

## Non-Goals

- AL.Runner native partial-exec API consumption (deferred until upstream ships).
- Hover/go-to-def/find-references UI features (foundation laid via SymbolIndex; UI is future scope).
- Incremental cumulative test mode (`pytest-watch`-style — flagged as future).
- Cross-extension AL LSP integration.
- Cross-platform native tree-sitter binding (using WASM exclusively).

---

## Chosen Approach

Five-layer stack consumed by existing Plan A surface. Each layer has one responsibility, tested in isolation, depends only on layers below.

| Layer | Responsibility | Today's impl | Future swap |
|---|---|---|---|
| L1 ParseCache | tree-sitter AST per file, incremental reparse on edit | `web-tree-sitter` WASM | unchanged |
| L2 SymbolExtractor | pure AST → declared/referenced/test symbols | tags.scm queries | unchanged |
| L3 SymbolIndex | cross-file `symbol → referrers` map, mutable, watcher-driven | in-memory Maps | could be SQLite at scale |
| L4 TestRouter | `getTestsAffectedBy(file): Result<TestProcedure[]>` | TreeSitterTestRouter (uses L3) | swap to AL.Runner JSON-RPC when partial-exec lands |
| L5 ExecutionEngine | `runTests(req)` / `executeScratch(req)` | ServerExecutionEngine (supervised daemon) | unchanged when L4 swaps; could swap to native partial-exec single-RPC |

**Why tree-sitter over the alternatives:**
- vs current regex: grammar handles namespaces, multiline attributes, combined `[Test, X]` form, quoted/unquoted identifiers — closes documented Plan A gaps by construction.
- vs Microsoft AL LSP: sync in-process parsing, no IPC, no dependency on Microsoft extension being installed.
- vs writing our own grammar: `@sshadows/tree-sitter-al` is mature (21KB/ms parse, 100% on 15K production files), authored by this project's owner.

**Why supervised --server over one-shot:**
- 24x warm-cache speedup measured by AL.Runner team.
- Loaded Roslyn references + JIT'd compiler reused across runs.
- Per-file rewrite cache eliminates rework when only one file changes.
- Single execution code path simplifies maintenance.

---

## Architecture

```
VS Code Workspace
   │ Plan A: workspaceFolders, app.json discovery
   ▼
WorkspaceModel (Plan A — unchanged)
   │ AlApp[], dep graph, watcher
   ▼
┌────────────────────────────────────────────────┐
│  Plan B + D: 5-layer precision + server stack  │
│                                                │
│  L1 ParseCache                                 │
│    web-tree-sitter WASM, AST per .al file,     │
│    incremental reparse on edit                 │
│             │                                  │
│             ▼                                  │
│  L2 SymbolExtractor (pure)                     │
│    AST → FileSymbols (declared, refs, tests)   │
│    via tags.scm queries                        │
│             │                                  │
│             ▼                                  │
│  L3 SymbolIndex                                │
│    Cross-file symbol→referrers map             │
│    Mutable, watcher-driven, FqName resolution  │
│    Last-good-state preservation on parse error │
│             │                                  │
│             ▼                                  │
│  L4 TestRouter (interface)                     │
│    getTestsAffectedBy(file): TestRoutingResult │
│    Implementation: TreeSitterTestRouter        │
│    Confidence gate (parse + resolution + idle) │
│             │                                  │
│             ▼                                  │
│  L5 ExecutionEngine (interface)                │
│    runTests(req) / executeScratch(req)         │
│    Implementation: ServerExecutionEngine       │
│    Manages supervised AL.Runner --server       │
│                                                │
└────────────────────────────────────────────────┘
   │
   ▼
Existing Plan A surface (TestController, save handler, scratch)
   │ Now consumes L4 for routing + L5 for execution
   │ Falls back to Plan A's WorkspaceModel.getDependents
   │   when L4 confidence gate trips
```

### Invariants

- **Unidirectional deps.** Each L*N* depends only on L*N-1*. No back-edges. L4 doesn't know L5 exists. L5 doesn't know L1-L4 exist.
- **Pure where possible.** L2 is pure. L4 is pure over L3 + saved-file path. L1, L3, L5 are stateful (parse cache, symbol map, server process).
- **Future-swap surface.** L4 and L5 are interfaces. When AL.Runner ships native partial-exec: replace L4 impl with `AlRunnerServerRouter`; L5 stays. SymbolIndex remains for hover/refs/dead-code.
- **Plan A integration point.** `WorkspaceModel` continues to manage app discovery + dep graph. New layers are scoped per workspace, keyed off `WorkspaceModel.getApps()`. Disposed alongside model.
- **Confidence gate.** L4 returns `{ confident: true, tests }` or `{ confident: false, reason }`. Caller falls back to Plan A's `getDependents` when not confident, surfaces reason in status bar.

---

## Components

### L1 — `ParseCache`

**Owns:** tree-sitter WASM grammar + per-file AST + incremental reparse.

```typescript
interface ParseResult {
  filePath: string;
  ast: TreeSitter.Tree;
  hasErrors: boolean;
  contentHash: string;
}

class ParseCache {
  initialize(): Promise<void>;     // load .wasm, instantiate Parser
  isAvailable(): boolean;
  parse(filePath: string, content: string): ParseResult;
  parseIncremental(filePath: string, content: string, edit: Edit): ParseResult;
  invalidate(filePath: string): void;
  getLastGood(filePath: string): ParseResult | undefined;
  dispose(): void;
}
```

**Behavior:**
- Initial parse goes through `parse()`. Subsequent edits go through `parseIncremental()` if old tree available (sub-millisecond).
- New parse with ERROR nodes → store as current, retain previous clean parse as `lastGood`.
- WASM load failure → `isAvailable() === false`. SymbolIndex never initializes; TestController stays on Plan A regex tier.

**File:** `src/symbols/parseCache.ts`.

### L2 — `SymbolExtractor`

**Owns:** AST → typed symbols. Pure function.

```typescript
type SymbolKind = 'table' | 'codeunit' | 'page' | 'enum' | 'report' | 'interface' | 'query' | 'xmlport';

interface FileSymbols {
  filePath: string;
  namespace: string | undefined;
  usings: string[];
  declared: DeclaredSymbol[];
  references: ReferencedSymbol[];
  tests: TestProcedure[];
}

interface DeclaredSymbol { kind: SymbolKind; id: number; name: string; line: number; }
interface ReferencedSymbol { kind: SymbolKind; name: string; line: number; }
interface TestProcedure { codeunitId: number; codeunitName: string; procName: string; line: number; }

function extractSymbols(parseResult: ParseResult): FileSymbols;
```

**Behavior:**
- Single pure function. Input: `ParseResult`. Output: `FileSymbols`.
- Walks AST using tree-sitter-al `tags.scm` queries (`@definition.class`, `@definition.method`, `@reference.type`, `@test.definition`, `@test.name`).
- Handles namespace + using clauses. Quoted vs bare identifiers handled by grammar.

**File:** `src/symbols/symbolExtractor.ts`.

### L3 — `SymbolIndex`

**Owns:** cross-file `FqName → Set<filePath>` for declarations + references; FqName resolution; settled-state tracking.

```typescript
class SymbolIndex {
  initialize(model: WorkspaceModel, parseCache: ParseCache): Promise<void>;
  isReady(): boolean;
  isSettled(): boolean;             // pending reparse queue empty + last refresh succeeded

  getDeclarer(fqName: string): string | undefined;
  getReferencers(fqName: string): Set<string>;
  getTestsInFile(filePath: string): TestProcedure[];
  getAllTests(): Map<string /* appId */, TestProcedure[]>;

  // Routing primitive (used by L4)
  getTestsAffectedBy(filePath: string): TestProcedure[] | null;  // null = low confidence

  onDidChange: Event<void>;          // fires after each settled refresh
  dispose(): void;
}
```

**Behavior:**
- On init: parse all .al files in all `AlApp.path`, extract, build FqName maps.
- FileSystemWatcher on `**/*.al` → debounced 100ms reparse → re-extract → update edges.
- Pending-reparse queue tracked; `isSettled()` false while queue non-empty.
- On extract failure (parse errors): keep last-good edges; mark file's confidence as low.
- `getTestsAffectedBy(file)`: union of `(a)` tests declared in file `(b)` tests in OTHER files that reference symbols declared in file. Returns `null` when:
  1. Saved file has parse errors (any ERROR node), or
  2. Index not settled (pending reparse queue non-empty).

**On unresolved references (clarification):** routing operates on the saved file's *declared* symbols, not its *referenced* symbols. The query "which tests reference what I declare here?" is well-defined regardless of whether THIS file references external libraries (`Codeunit Assert`, etc.) we can't resolve. Unresolved refs in the saved file therefore do NOT trip the confidence gate. Test files routinely reference external test-runtime symbols (`Codeunit Assert`); those are expected and harmless to routing accuracy.

**On stale references (when symbols disappear):** if a previously-declared symbol is removed in the current save, callers that reference it become orphaned. The reverse-edge map captures this: `getReferencers(deletedSymbol.fqName)` still returns tests that reference it; routing them is correct (they may now fail, which IS what we want to know). No gate needed — the index naturally handles it.

**FqName resolution rules:**
- File declares `namespace X.Y;` → its own declared symbols are `X.Y.Name`.
- Type reference `Codeunit Foo` resolves against:
  1. Local namespace + identifier (`X.Y.Foo`),
  2. Each `using A.B;` clause + identifier in declaration order (`A.B.Foo`),
  3. Global scope (bare `Foo`).
- First match wins.

**File:** `src/symbols/symbolIndex.ts`.

### L4 — `TestRouter` (interface + impl)

**Owns:** "which tests should run on save."

```typescript
interface TestRouter {
  getTestsAffectedBy(filePath: string, app: AlApp): TestRoutingResult;
  isAvailable(): boolean;
  dispose(): void;
}

type TestRoutingResult =
  | { confident: true; tests: TestProcedure[] }
  | { confident: false; reason: string };

class TreeSitterTestRouter implements TestRouter {
  constructor(private index: SymbolIndex) {}
  // getTestsAffectedBy delegates to index; gates on confidence
}
```

**Behavior:**
- Query L3, format result, gate on confidence (parse errors / unsettled).
- `reason` strings standardized for status bar display:
  - `"file <name> has parse errors"`
  - `"<N> files awaiting reparse"`

**Future:** `AlRunnerServerTestRouter implements TestRouter` (calls `--server` dep-graph query when AL.Runner ships partial-exec).

**Files:** `src/routing/testRouter.ts` (interface), `src/routing/treeSitterTestRouter.ts` (impl).

### L5 — `ExecutionEngine` (interface + impl)

**Owns:** AL.Runner --server lifecycle + RPC + protocol mapping.

```typescript
interface ExecutionEngine {
  runTests(req: RunTestsRequest): Promise<ExecutionResult>;
  executeScratch(req: ExecuteScratchRequest): Promise<ExecutionResult>;
  isHealthy(): boolean;
  dispose(): Promise<void>;          // graceful shutdown
}

interface RunTestsRequest {
  sourcePaths: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
  coverage?: boolean;
  // Note: AL.Runner's current --server protocol runs every test in the
  // compiled assembly per request; no per-test filter field exists.
  // Test narrowing for precision tier happens at the APP level
  // (only call runTests for apps containing affected tests) and at
  // DISPLAY level (filter shown results to the affected set).
  // When AL.Runner ships per-test filtering / native partial-exec
  // (docs 08+09), add `testFilter?: { ... }` here and forward it.
}

interface ExecuteScratchRequest {
  filePath?: string;             // for scratch-project (with sourcePaths)
  inlineCode?: string;           // for scratch-standalone (server's `code` field)
  sourcePaths?: string[];        // for scratch-project
  captureValues?: boolean;
  iterationTracking?: boolean;
}
```

**Supervisor pattern:**
- Lazy spawn on first request (most sessions never run tests).
- Health check on each request: process alive + stdin writable + response within timeout.
- On detected failure: kill (if necessary), respawn, retry the in-flight request once. Surface error if respawn or retry fails.
- Graceful shutdown on `dispose()`: send `{"command":"shutdown"}`, wait 2s for daemon exit, force-kill if still alive.
- Single daemon per workspace. AL.Runner's internal 8-slot LRU handles dep-set variety across requests.
- No user-facing setting; supervisor pattern is the contract.

**Protocol mapping:**

```
runTests({ sourcePaths, captureValues, ... })
  →  { command: "runtests", sourcePaths, captureValues: true }
     (server runs ALL tests in compiled assembly; no per-test filter today)

executeScratch({ inlineCode: "...", captureValues, ... })
  →  { command: "execute", code: "...", captureValues: true }

executeScratch({ filePath, sourcePaths: [main, scratch], ... })
  →  { command: "execute", sourcePaths: [main, scratch], captureValues: true }
```

**Server response → ExecutionResult mapping:**
The server returns a JSON object with `tests`, `messages`, `capturedValues`, `iterations`, `cached`, `exitCode`, `compilationErrors`. ALchemist's existing `parseJsonOutput` already handles this shape (Plan A). Pass server response stdout-equivalent through the existing parser.

**Files:** `src/execution/executionEngine.ts` (interface), `src/execution/serverExecutionEngine.ts` (impl), `src/execution/serverProcess.ts` (process supervisor).

---

## Data Flow

### Activation

```
extension.activate()
  ├─ WorkspaceModel.scan()                           [Plan A — unchanged]
  ├─ TestController init (Plan A regex tier active)  [tests visible immediately]
  │
  ├─ ParseCache.initialize()                         [async — load WASM]
  │     │
  │     └─ on ready → SymbolIndex.initialize(model, cache)
  │           │
  │           └─ on settled → TestController upgrade to L4-routed
  │
  ├─ ExecutionEngine = new ServerExecutionEngine()   [no spawn yet — lazy]
  │
  └─ Status bar: "ALchemist: regex tier" → "precision tier" when index settles
```

User sees tests within ms via Plan A regex. Precision tier upgrade arrives silently.

### On file save (test routing)

```
onDidSaveTextDocument(doc)
  │
  ├─ scratch file? → existing scratch path (also through ExecutionEngine)
  │
  ├─ workspaceModel.getAppContaining(file) → app
  │     └─ undefined → skip, status bar "no AL app for this file"
  │
  ├─ scope = config 'testRunOnSave'
  │     └─ 'off' → return
  │
  ├─ if scope === 'all':
  │     for each app: ExecutionEngine.runTests({ paths: app + forwardDeps, no filter })
  │
  └─ else (scope === 'current'):
        ├─ if router.isAvailable() && (result = router.getTestsAffectedBy(file, app)).confident:
        │     status bar: "precision (3 tests / 2 codeunits / 1 app)"
        │     // App narrowing: identify the subset of dep apps that own affected tests
        │     affectedApps = unique apps owning result.tests
        │     for each affected app: ExecutionEngine.runTests({ paths: app.path + forwardDeps })
        │     // Display narrowing: filter output to result.tests; hide unaffected results from output panel
        │
        └─ else (router unavailable or low-confidence):
              status bar: "fallback — <reason from router>"
              plan = WorkspaceModel.getDependents(app.id)              [Plan A behavior]
              for each dep app: ExecutionEngine.runTests({ paths: dep+forwardDeps })
```

### On `.al` file save (index update)

```
FileSystemWatcher fires (debounced 100ms)
  │
  ├─ ParseCache.parseIncremental(file, content, edit)
  │     │
  │     └─ if hasErrors: keep lastGood entry; mark confidence-low for this file
  │     └─ else: replace tree, lastGood = this
  │
  ├─ SymbolIndex.refresh(file):
  │     extract symbols from new parse
  │     diff old vs new declared/referenced edges
  │     update FqName→files maps
  │     queue position decremented; settled? fires onDidChange
  │
  └─ TestController.refreshTreeFromIndex()         [debounced 200ms, batched]
```

### On Test Explorer "Run All"

```
runTests(no include)
  │
  └─ for each app in WorkspaceModel.getApps():
        ExecutionEngine.runTests({ paths: app.path + forwardDeps, no filter })
```

### On `app.json` change

```
Plan A watcher fires → WorkspaceModel.triggerRescan()
  │
  ├─ if apps changed: SymbolIndex re-initializes for added/removed apps
  └─ TestController.refreshTreeFromIndex()
```

### On extension deactivate

```
deactivate()
  ├─ ExecutionEngine.dispose()
  │     send {"command":"shutdown"}
  │     wait 2s for daemon exit
  │     force-kill if still alive
  │
  ├─ SymbolIndex.dispose()
  ├─ ParseCache.dispose()
  ├─ WorkspaceModel binding.dispose()
  └─ tree refresh timer cleared
```

### Override keybinding `Ctrl+Shift+A Shift+R` ("run wider scope")

```
User invokes alchemist.runWiderScope while focus on .al file
  │
  ├─ filePath = active editor
  ├─ owningApp = workspaceModel.getAppContaining(filePath)
  ├─ plan = WorkspaceModel.getDependents(owningApp.id)   [bypass L4 — explicit broader scope]
  └─ for each dep: ExecutionEngine.runTests(...)
```

---

## Error Handling

| Scenario | Layer | Handling |
|---|---|---|
| WASM load fails | L1 | `ParseCache.isAvailable() === false`. SymbolIndex never initializes. L4 router reports `isAvailable() === false`. TestController stays on Plan A regex tier permanently for this session. Status bar: "regex tier — tree-sitter unavailable (see output)". One-time output log. No retry. |
| `.al` file unreadable (permission/locked) | L1 | `parse` throws → catch, retain `lastGood` if any, log debug, mark file confidence-low. |
| Tree-sitter parse timeout | L1 | 500ms parse timeout. On timeout: retain `lastGood`, log warning once per file. |
| Mid-edit syntax errors | L1 → L4 | Tree has ERROR nodes. `lastGood` preserved. L4 confidence gate trips → fallback tier this save. Status bar shows reason. |
| Index unsettled when save fires | L4 | Pending reparse queue non-empty → confidence false → fallback tier. Reason: `"<N> files awaiting reparse"`. |
| Server process fails to spawn | L5 | First-request spawn error caught. Surface: "ALchemist: AL.Runner --server failed to start: <err>". Set engine unhealthy. Subsequent requests fail fast. No silent one-shot fallback. |
| Server process crashes mid-session | L5 | Pipe broken / process exit detected on next request. Supervisor respawns once, retries the in-flight request. If respawn also fails, surface error. |
| Server returns malformed JSON | L5 | Parse error caught. Treat as request failure. Trigger health check; respawn if pipe broken; otherwise return error to caller. |
| Server `runtests` returns `error` field | L5 | Surface error as `ExecutionResult` with `success: false`, error message. |
| AL.Runner protocol mismatch (older runner without --server) | L5 | First request: server exits or returns unknown command. Supervisor surfaces "ALchemist requires AL.Runner 1.0.12+. Update via `dotnet tool update -g msdyn365bc.al.runner`." Don't retry. |
| Concurrent requests race (queued saves, double-clicks) | L5 | Server protocol is request-response sequential. Engine queues requests, processes FIFO. UI shows latest in flight. |
| `app.json` cycle | Plan A | Already handled by `WorkspaceModel.hasCycle` → warn once. Index initializes per-app, cycle doesn't break L3. |
| File outside any AL app | L4/L5 | `getAppContaining` returns undefined → skip routing, log debug. Already in Plan A. |
| Server idle for hours | L5 | No-op. AL.Runner's internal 8-slot LRU bounds memory. VS Code session = upper bound on lifetime. |
| User closes VS Code abruptly (no `deactivate` called) | L5 | Daemon process is child of VS Code's extension host. OS reaps when host dies. Acceptable. |
| `dispose()` while request in flight | L5 | Wait up to 2s for request to complete, then force-kill. Pending callers receive cancellation. |
| Index rebuild during save handler | L3/L4 | Save handler reads index snapshot. `isSettled()` check in confidence gate catches mid-rebuild state. |
| Workspace with hundreds of `.al` files | L1/L3 | Initial parse: ~50ms per 100KB AL @ 21KB/ms. 1000 files ≈ ~5s sequential. Use Promise.all batches of 32 files for parallelism. Show progress in status bar during init. |
| Tree-sitter version mismatch (grammar vs runtime) | L1 | Bundle both `@sshadows/tree-sitter-al` WASM + matching `web-tree-sitter` runtime in extension. Versions pinned in package.json. |

---

## Testing

### Unit tests (mocha, no VS Code, no real AL.Runner)

**`ParseCache`** (`test/suite/parseCache.test.ts`)
- WASM loads → `isAvailable() === true`
- WASM load failure (mock loader throws) → `isAvailable() === false`, no exceptions propagate
- Parse simple AL codeunit → AST node count matches expected
- Parse with syntax error → `hasErrors === true`, AST has ERROR nodes, lastGood preserved
- `parseIncremental` reuses old tree (verify via tree-sitter incremental edit)
- `invalidate(file)` removes both current AND lastGood
- Parse timeout (set 1ms timeout, parse 1MB file) → returns lastGood or throws cleanly
- `dispose()` releases parser; subsequent calls throw or no-op

**`SymbolExtractor`** (`test/suite/symbolExtractor.test.ts`)
- Quoted codeunit name → DeclaredSymbol with correct id+name
- Unquoted codeunit name → same shape
- `[Test]` proc (single attribute) → TestProcedure with proc name
- `[Test, HandlerFunctions('H')]` (combined attrs) → TestProcedure detected (closes Plan A's documented gap)
- `[Test]\n[HandlerFunctions('H')]` (stacked) → TestProcedure detected
- Namespace declaration → `namespace = 'STM.X.Y'`
- `using A.B; using C.D;` → `usings = ['A.B', 'C.D']`
- `Record "Customer Score"` → ReferencedSymbol(table, "Customer Score")
- `Codeunit 50100` → ReferencedSymbol(codeunit, "50100")
- `Codeunit SomeCodeunit` → ReferencedSymbol(codeunit, "SomeCodeunit")
- Comment `// [Test] foo` → no false positive TestProcedure
- Comment `/* Codeunit Foo */` → no false positive ReferencedSymbol
- Empty file → empty FileSymbols
- File with only namespace, no decls → empty `declared`, namespace set

**`SymbolIndex`** (`test/suite/symbolIndex.test.ts`)
- Build from multi-app fixture → declared/referenced maps populated
- `getDeclarer(fqName)` returns correct file
- `getReferencers(fqName)` returns set of all files referencing it
- FqName resolution: `using A.B; var x: Codeunit Foo;` resolves to `A.B.Foo`
- FqName resolution: `namespace X.Y; var x: Codeunit Foo;` resolves to `X.Y.Foo` (local first)
- FqName conflict: same name in two `using` clauses → first match wins (deterministic)
- `getTestsAffectedBy(file)` covers (a) tests in file (b) tests in other files referencing file's declared symbols
- `getTestsAffectedBy` returns null when file has parse errors
- `getTestsAffectedBy` returns null when reparse queue non-empty (use injectable settled flag)
- `getTestsAffectedBy` returns non-null when saved file has unresolved external refs (e.g., Codeunit Assert) — they don't gate confidence; only saved file's *declared* symbols matter for routing
- Diamond reference (test A and test B both reference Codeunit C) → saving C returns both
- Reparse on file edit updates referencer set incrementally (no full rebuild)
- File deleted → all its declared/referenced edges removed
- File created → symbols added without disturbing other files' edges

**`TestRouter`** (`test/suite/testRouter.test.ts`)
- TreeSitterTestRouter delegates to SymbolIndex correctly
- Returns `{ confident: true, tests }` when index returns non-null
- Returns `{ confident: false, reason }` with parse-error reason
- Returns `{ confident: false, reason }` with not-settled reason
- `isAvailable()` mirrors index.isReady()

**`ServerExecutionEngine`** (`test/suite/serverExecutionEngine.test.ts`)
Use a mock `ChildProcess` with injectable I/O streams.
- First request spawns process, sends ready handshake
- `runTests` sends correct JSON-RPC payload
- Multiple sequential requests reuse same process
- Server returns `{"ready":true}` first; engine doesn't send request before ready
- Server crashes (mock writes EOF on stdout) → next request triggers respawn + retry
- Respawn succeeds → original request resolves with retry result
- Respawn fails (spawn rejected) → original request rejects with surface-level error
- Server returns `{"error": "..."}` → engine resolves with success: false, error string
- Server returns malformed JSON → engine treats as failure, may respawn
- `dispose()` sends shutdown, waits, force-kills on timeout
- Concurrent `runTests` calls serialize (FIFO queue)
- Cancel-pending request → underlying server keeps running for next request
- `executeScratch` with inline code maps to `{command:"execute", code, ...}` correctly
- Protocol mismatch: server returns `Unknown command` for `runtests` → surface migration error

**`extension.ts` save handler routing** (`test/suite/saveHandler.test.ts`)
- Save in main app + L4 confident → ExecutionEngine called once per affected app (apps owning at least one affected test); display filtered to affected tests
- Save in main app + L4 low-confidence → ExecutionEngine called once per dep app (Plan A broad scope)
- Save in test app + L4 confident → ExecutionEngine called for that test app; display filtered to tests in saved file
- Save outside any app → ExecutionEngine never called
- testRunOnSave='off' → ExecutionEngine never called
- testRunOnSave='all' → ExecutionEngine called for every app, no display filter
- Run-wider-scope command bypasses L4 → broad scope used regardless of confidence

### Integration tests (real fixtures, mocked AL.Runner)

`test/suite/integration.precision.test.ts`:
- Multi-app fixture → ParseCache + SymbolIndex initialize successfully
- Edit `MainApp/src/SomeCodeunit.Codeunit.al` → SymbolIndex incremental update fires
- `getTestsAffectedBy(SomeCodeunit.al)` returns the test that uses it
- Edit unrelated file → no test routing fires
- Sentinel-shaped fixture → expected referencer counts for `AlertSESTM` table

### Manual verification checklist

`docs/superpowers/plans/<date>-precision-server-verification.md`:
- [ ] Open Sentinel via `al.code-workspace`. Status bar: "regex tier" → "precision tier" within seconds.
- [ ] Save `BusinessCentral.Sentinel/src/Alert.Table.al`. Status bar: "precision (N tests)". Expect only tests referencing AlertSESTM run.
- [ ] Save a test codeunit. Expect only tests in that codeunit run.
- [ ] Introduce syntax error in saved file. Status bar: "fallback — file has parse errors". Broader test set runs.
- [ ] Hit `Ctrl+Shift+A Shift+R`. Wider scope runs regardless of confidence.
- [ ] Save 50 files in rapid succession. Index converges; final routing reflects last save.
- [ ] Trigger a save during initial index build. Status bar: "fallback — N files awaiting reparse".
- [ ] Kill `al-runner` process via Task Manager. Next save → supervisor respawns transparently.
- [ ] Edit `app.json` (add fake dep). Tree refreshes. Index re-initializes for affected app.
- [ ] First test run latency vs Plan A baseline (cold start measurement).
- [ ] Tenth test run latency vs first (warm cache measurement). Expect ~10x faster.

### Coverage targets

Every L1-L5 module must have:
- Branch coverage on all conditionals
- Error-path coverage on all try/catch blocks
- Mock-based tests where real services involved (server process, WASM loader)

Per memory `feedback_thorough_tests.md`: more tests preferred over fewer; regression test added for every bug found.

---

## Implementation Sequence (preview for writing-plans)

1. **L1 ParseCache** — WASM loader + sync parse + incremental + lastGood preservation. Unit-tested in isolation.
2. **L2 SymbolExtractor** — pure AST→FileSymbols, all SymbolKind variants, namespace+using handling. TDD per case.
3. **L3 SymbolIndex** — initialize from WorkspaceModel, FqName resolution, watcher integration, settled tracking, last-good edges.
4. **L4 TestRouter** — interface + TreeSitterTestRouter; confidence gate logic; reason strings.
5. **L5 ServerExecutionEngine** — supervisor process management; JSON-RPC client; queue + respawn + dispose.
6. **Wire into extension.ts** — replace existing one-shot Executor call sites with ExecutionEngine; add save handler precision branch + status bar tier display; add `runWiderScope` command.
7. **Add fixtures** for SymbolIndex tests (extend Plan A's `multi-app` fixture).
8. **Manual verification** on Sentinel — close out checklist.
9. **CHANGELOG + README + version bump** to 0.4.0.

Each step ships green before next. Plan A's `Executor` class deleted only after L5 confirmed working end-to-end.

---

## Open Questions / Risks

- **Tree-sitter-al WASM bundle size:** measure during step 1. If >10MB, evaluate downloading on first activation vs bundling.
- **Initial parse latency for huge workspaces:** 1000+ AL files. Parallel-batch parser + status bar progress mitigate. May need lazy/on-demand init for cold-cache feel.
- **AL.Runner partial-exec timeline:** if upstream ships during Plan B implementation, evaluate switching L4 impl mid-flight vs completing tree-sitter index for parity. Index has standalone value (hover/refs) regardless.
- **Server protocol stability:** AL.Runner's --server protocol is documented internally but may evolve. Pin version range in extension; surface migration errors clearly.
- **Confidence-gate false negatives:** parse errors in unrelated files shouldn't trip gate. Spec says only saved file's parse + saved file's references gate confidence. Verify with test.
- **Test filter semantics:** AL.Runner's `--server` protocol does NOT currently expose a per-test filter; every `runtests` request runs all tests in the compiled assembly. Plan B's "precision" therefore manifests as (1) APP-level narrowing — skip running test apps that contain no affected tests, (2) DISPLAY-level filtering — output panel and Test Explorer reflect only affected tests. Execution-level narrowing arrives when AL.Runner ships per-test caching / partial-exec (their docs 08+09). The L5 `RunTestsRequest` interface leaves room for `testFilter?` at that point. Performance gain in v0.4.0 comes from `--server` caching (≈7x warm-cache speedup) plus app-set narrowing — not per-test filtering.
- **Status bar real estate:** "ALchemist: precision (3 tests / 2 codeunits / 1 app)" is wide. Tooltip carries full info; bar shows compact form ("✓ 3").
- **Memory ceiling on huge workspaces:** SymbolIndex maps grow with reference counts. Estimate <50MB for 10K-file workspace. Acceptable; revisit if user reports OOM.
