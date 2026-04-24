# Multi-App Workspace & Tree-sitter Test Discovery — Design Spec

**Date:** 2026-04-24
**Status:** Approved (brainstorming), pending implementation plan
**Problem:** ALchemist fails on real AL workspaces (e.g. BusinessCentral.Sentinel). No tests discovered, workspace mode does not work.

---

## Problem Statement

ALchemist currently has two root-cause bugs confirmed against the `StefanMaron/BusinessCentral.Sentinel` repository:

1. **Codeunit regex requires quoted names.** `src/testing/testDiscovery.ts:16` uses `/codeunit\s+(\d+)\s+"([^"]+)"/i`. AL syntax allows unquoted identifiers (`codeunit 71180500 AlertEngineTestSESTM`). Unquoted codeunits are skipped entirely during discovery, producing zero tests even when the sidebar is otherwise wired.
2. **`workspaceFolders?.[0]` used throughout.** `src/extension.ts:56,79,92,132,144` and `src/testing/testController.ts:79` only inspect the first workspace folder. In a multi-root setup (such as Sentinel's `al.code-workspace` with folders `[BusinessCentral.Sentinel, .AL-Go, .]`), the test app lives in a sibling folder that is never scanned.

Beyond the immediate fix, the broader problem is that ALchemist has no first-class model for AL apps. Real AL workspaces contain multiple `app.json`-rooted apps (main app, test app, satellite apps), and users expect test discovery, grouping, and routing to reflect that structure.

---

## Goals

- Discover every test codeunit in every AL app across every workspace folder, regardless of quoting style, namespace, or multiline attributes.
- Group tests by app in the Test Explorer tree (App → Codeunit → Procedure).
- Run only the tests that could be affected by a saved file (precise save routing via transitive dependencies; symbol-level precision when tree-sitter is loaded).
- Work correctly on `.code-workspace` multi-root workspaces, single-folder workspaces, and workspaces with no `app.json` at all (graceful degradation).
- Zero dependency on the Microsoft AL extension at runtime.
- Stay compatible with AL.Runner's existing `app.json` walk-up logic — no AL.Runner changes required.

## Non-Goals

- AL LSP integration (explicitly rejected — see Approach 4 in brainstorming).
- Codeunit-level semantic analysis via AL compiler (out of scope; tree-sitter syntax-level references are sufficient for this feature).
- Scratch file app-picker UX beyond the minimum needed to unbreak multi-app scratch-project mode.
- Changes to AL.Runner.

---

## Chosen Approach: Tree-sitter-AL Native

Three layers, one revised component, one fallback tier:

1. **`WorkspaceModel` (new)** — discovers AL apps via `app.json`, maintains dep graph.
2. **`AlSymbolIndex` (new)** — tree-sitter-al-backed AST + cross-file reference index.
3. **`AlchemistTestController` (revised)** — multi-app Test Explorer tree, precision-tier save routing.
4. **`Executor` (minor)** — callers pass the test app's folder as `workspacePath`, not `workspaceFolders[0]`.
5. **Fallback tier** — if tree-sitter-al WASM fails to load or `app.json` is absent, fall back to fixed regex + dep-graph-only routing. Status bar hover reflects active tier.

### Why tree-sitter-al over regex or AL LSP

- **vs regex:** grammar-driven AST matching handles namespaces, multiline attributes, quoted/unquoted identifiers, comments containing `[Test]`, and future AL grammar additions without string-pattern maintenance.
- **vs AL LSP:** synchronous in-process parsing (no IPC latency), no dependency on the Microsoft AL extension being installed or activated, works in headless/CI environments.
- **Maturity:** tree-sitter-al is production-viable; WASM binding (`web-tree-sitter`) ships cross-platform without per-OS native builds.

---

## Architecture

```
VS Code Workspace
  (N workspaceFolders + optional .code-workspace)
      │
      ▼
WorkspaceModel  (NEW)
  - Scans all workspaceFolders for app.json roots
  - AlApp[] (path, id, name, version, dependencies[])
  - Transitive dep graph (app → dependents)
  - FileSystemWatcher on **/app.json
      │  AlApp[]
      ▼
AlSymbolIndex  (NEW, tree-sitter-al)
  - Parses every .al via web-tree-sitter WASM
  - Per-file: test codeunits, procedures with [Test], declared types, type refs
  - Cross-file: symbol → referrer set
  - FileSystemWatcher on **/*.al (debounced, incremental)
      │  testCodeunits, refs
      ▼
AlchemistTestController  (REVISED)
  - Tree: App → Codeunit → Procedure
  - onSave: AlSymbolIndex.getTestsReferencing(file) (precision tier)
           or WorkspaceModel.getDependents(app) (fallback tier)
  - Passes the test app's folder to Executor
      │  executor.execute('test', file, appPath)
      ▼
Executor → AL.Runner
  (unchanged — AL.Runner walks up to app.json)
```

---

## Components

### `WorkspaceModel`

Owns AL-app knowledge across the workspace.

**State:**
```typescript
interface AlApp {
  path: string;              // absolute path to app folder
  id: string;                // from app.json "id"
  name: string;              // from app.json "name"
  publisher: string;
  version: string;
  dependencies: { id: string; name: string; publisher: string; version: string }[];
}
```

**API:**
- `scan(): Promise<void>` — enumerate all `workspaceFolders`, walk each (respecting excludes: `.alpackages`, `node_modules`, `.AL-Go`, `.git`, `bin`, `obj`, `out`, `.snapshots`), find `app.json` files, parse them into `AlApp`. Stop descent when an `app.json` is found — no nested apps. Build transitive dep graph (visited-set guard against cycles).
- `getApps(): AlApp[]`
- `getAppContaining(filePath: string): AlApp | undefined`
- `getDependents(appId: string): AlApp[]` — transitive closure of apps that depend on `appId`, plus `appId` itself (so saving in an app runs that app's own tests too, if any).
- `onDidChange: Event<void>` — fires when rescan alters the model.

**Watchers:** `workspace.createFileSystemWatcher('**/app.json')` — on create/change/delete, rescan. Debounced 200ms trailing edge.

### `AlSymbolIndex`

Tree-sitter-al AST store + cross-file reference index.

**State:**
```typescript
interface FileSymbols {
  filePath: string;
  namespace: string | undefined;        // from `namespace X.Y;` declaration
  usings: string[];                     // from `using A; using B;`
  testCodeunits: TestCodeunit[];
  declaredTypes: { kind: 'table'|'codeunit'|'page'|'enum'|'report'|'interface'; id: number; name: string; fqName: string; line: number }[];
  typeRefs: { fqName: string; line: number }[];
}

interface TestCodeunit {
  id: number;
  name: string;
  fqName: string;
  line: number;
  procedures: { name: string; line: number }[];
}
```

**API:**
- `initialize(): Promise<void>` — load `web-tree-sitter` WASM grammar; parse every `.al` in every app. Non-blocking on callers — fallback tier active until this resolves.
- `isAvailable(): boolean` — true iff WASM loaded and initial parse complete.
- `getTestCodeunits(appPath: string): TestCodeunit[]`
- `getTestsReferencing(filePath: string): TestCodeunit[]` — look up symbols declared in `filePath` via `FileSymbols.declaredTypes`, find all `typeRefs` to those FqNames, intersect with test codeunits.
- `onDidChange: Event<AlApp>` — fires with the owning app when a file's symbols change.

**FqName resolution:**
- When a file declares `namespace X.Y;`, every symbol declared in that file is `X.Y.SymbolName`.
- Type references resolve against (a) fully-qualified names as written, (b) local namespace + identifier, (c) each `using` clause + identifier. First match wins.
- No `namespace` declaration → global scope; identifier matches any global symbol with that name.

**Watcher:** `workspace.createFileSystemWatcher('**/*.al')` — debounced 100ms. On change: reparse file, diff old vs new `typeRefs` and `declaredTypes`, update reference index incrementally. On delete: remove all edges. On create: parse + add.

### `AlchemistTestController` (revised)

- Tree root → one `TestItem` per `AlApp` (label: `app.json` `name`). Children: codeunits. Grandchildren: procedures.
- Populate order: immediately on activation using fallback regex over `WorkspaceModel.getApps()`; when `AlSymbolIndex.isAvailable()` becomes true, replace tree with index-derived data.
- `runTests(request)`:
  - If `request.include` is set: group items by owning `AlApp`; for each app, run either a single `--run <proc>` per item or a batched single-app run.
  - If not set (Run All): iterate all apps; one AL.Runner invocation per app with that app's path.
- `onDidSaveTextDocument(doc)`:
  - Resolve `AlApp` via `WorkspaceModel.getAppContaining(doc.fsPath)`. If none, skip.
  - If `AlSymbolIndex.isAvailable()`: `getTestsReferencing(doc.fsPath)` → run those tests.
  - Else: `WorkspaceModel.getDependents(app.id)` → run all tests in each dependent app.
  - Respect `alchemist.testRunOnSave` setting (`current` | `all` | `off`) with tier-aware semantics:
    - `current`:
      - Precision tier → only tests whose codeunits reference symbols declared in the saved file (via `AlSymbolIndex.getTestsReferencing`).
      - Fallback tier → tests in all apps transitively dependent on the saved file's app (via `WorkspaceModel.getDependents`).
    - `all` → every test in every AL app across the workspace, regardless of tier.
    - `off` → no save-triggered run.

### `Executor` (minor)

No structural change. Internal note: every `executor.execute('test', file, appPath)` call site must pass the owning app's path, not `workspaceFolders[0].uri.fsPath`. Test-mode fallback (single-file retry at `executor.ts:63`) stays as-is.

### Fallback tier

Surface which tier is active:
- Precision tier (tree-sitter available): status bar tooltip shows "ALchemist: precision tier".
- Fallback tier: tooltip shows "ALchemist: fallback tier — tree-sitter-al unavailable (see output)" with details logged once to the output channel.

---

## Data Flow

### Activation

```
extension.activate()
  ├─ WorkspaceModel.scan()                [sync, ms]
  ├─ TestController.populate(fallback)    [tests visible immediately]
  ├─ AlSymbolIndex.initialize()           [async background]
  │    └─ on ready → TestController.populate(index)
  └─ register FileSystemWatchers
```

User sees test tree within milliseconds; precision upgrade arrives silently when index is ready.

### On file save

```
onDidSaveTextDocument(doc)
  ├─ isScratchFile? → existing scratch flow (below)
  ├─ WorkspaceModel.getAppContaining(doc.fsPath) → app
  │    └─ if undefined, skip run
  ├─ if AlSymbolIndex.isAvailable():
  │    └─ getTestsReferencing(doc.fsPath) → TestCodeunit[]
  │        └─ group by app; Executor.execute('test', doc, app.path) with --run per proc
  └─ else:
       └─ WorkspaceModel.getDependents(app.id) → AlApp[]
           └─ Executor.execute('test', doc, each depApp.path)
```

### On Test Explorer "Run All"

```
runTests(request with no include)
  └─ for each AlApp in WorkspaceModel.getApps():
      └─ Executor.execute('test', app.path, app.path)
```

### On `app.json` change

```
watcher fires (debounced 200ms)
  └─ WorkspaceModel.scan()
      ├─ rebuild dep graph
      └─ TestController.refreshTree() (regroup if apps added/removed)
```

### On `.al` change (create/edit/delete)

```
watcher fires (debounced 100ms)
  └─ AlSymbolIndex.reparse(file)
      ├─ update FileSymbols entry
      ├─ diff declaredTypes + typeRefs, update edges
      └─ TestController.refreshApp(owningApp)
```

### Scratch file save (bug fix for multi-app)

```
isProjectAware(content) + isScratchFile
  └─ WorkspaceModel.getApps()
      ├─ 0 apps → scratch-standalone
      ├─ 1 app  → scratch-project with that app's path
      └─ N apps → new config alchemist.scratchProjectAppId picks by app.json "id" (GUID);
                  if unset or id not found, show Quick Pick on first use listing all apps,
                  persist choice in ext global state keyed by scratch file absolute path
```

---

## Error Handling

| Scenario | Handling |
|---|---|
| Tree-sitter WASM load fails | Catch in `initialize()`, set `isAvailable = false` for session, log once to output channel, status bar hover reflects fallback tier. No retry — user reloads window. |
| Malformed `app.json` | Skip that app, emit one-time warning with path + parse error, continue with others. On next watcher fire (file fixed), app is picked up. |
| Tree-sitter parse error in `.al` (user mid-edit) | Use best-effort AST with `ERROR` nodes — extract what we can, no log (noisy). Next clean parse replaces stale data. |
| Circular `app.json` deps | Visited-set in transitive closure; detect cycle, log warning once, truncate at cycle point. |
| `.al` file outside any app | `getAppContaining` returns `undefined`; save routing skips run (debug log only). Not an error. |
| AL.Runner compile failure on test run | Existing single-file fallback (`executor.ts:63`) — unchanged. |
| Watcher thrash (build/git checkout) | Debounce reparse 100ms trailing; batch tree updates per tick. |
| Run test while reindex in progress | `TestItem` stores path + proc name at creation; execution unaffected by index state. |
| Microsoft AL extension disabled | No impact — Approach 5 never calls AL LSP. |

---

## Testing

### Unit tests (mocha, no VS Code)

**`WorkspaceModel`**
- Scans fixture with 1, 2, N `app.json` files.
- Respects excludes: fixture with `node_modules/app.json` — ignored.
- Nested `app.json` guard: fixture with inner app — inner ignored.
- Transitive dep graph: `A→B→C`; `getDependents(C)` returns `{A, B, C}`.
- Cycle detection: `A↔B` — warns, no infinite loop, dep graph stays usable.
- Malformed `app.json`: app skipped, others present, one warning emitted.
- `getAppContaining()`: file inside → app; file outside → undefined.
- Watcher triggers rescan; `onDidChange` fires.

**`AlSymbolIndex`**
- Test codeunit with `Subtype = Test` + `[Test]` procs → correct count, names, lines.
- Namespaced file (`namespace STM.X.Y;`) → FqName `STM.X.Y.Name`.
- Multiline attributes `[Test, HandlerFunctions('H')]` — detected.
- Unquoted codeunit name (`codeunit 50100 MyTest`) — detected.
- Quoted codeunit name (`codeunit 50100 "My Test"`) — detected.
- Comment containing `[Test]` inside proc body — NOT picked up.
- `using` clause resolution: `using B.Y; var x: Record OtherRec;` → resolves to `B.Y.OtherRec` when declared there.
- Reference index: file A uses `Record B` → `getTestsReferencing(tableB_file)` includes A iff A is a test codeunit.
- Incremental reparse: edit file, reparse, old edges removed + new edges added.
- `isAvailable() === false` when WASM fails (inject failing loader).
- Delete file: all its edges removed.
- Create file: symbols + edges added without full rescan.

**Fallback regex (when index unavailable)**
- Existing tests expanded: unquoted codeunit names.
- Existing tests remain passing.

**Routing logic**
- Save file in test app → tests in that file's codeunit only (precision tier).
- Save file in main app with dependent test app → all tests in dependent apps (fallback tier).
- Save file in main app with dependent test app → only tests referencing that file's symbols (precision tier).
- Save file outside any app → empty result, debug log.
- `testRunOnSave = 'off'` → skip before any resolution.

### Integration tests (VS Code host)

- Open multi-app fixture workspace (Sentinel-shaped: `MainApp/` + `MainApp.Test/` + `.code-workspace`).
- Assert Test Explorer tree: two app nodes, test codeunits nested under the test app only, procedures nested under codeunits.
- Simulate save on `MainApp/*.al` → assert tests in `MainApp.Test` run (both tiers exercised in separate test runs).
- "Run All" from Test Explorer → AL.Runner invoked with each app's path.
- File watcher: add a new `.al` with `[Test]` → appears without reload.
- Remove `app.json` from test app → test app node disappears.
- `testRunOnSave = 'off'` → save does not trigger run.

### Fixture corpus

Add `test/fixtures/multi-app/` mirroring Sentinel structure (small, public-safe AL):
- `MainApp/app.json` + `MainApp/src/SomeTable.Table.al` + `MainApp/src/SomeCodeunit.Codeunit.al`
- `MainApp.Test/app.json` (depends on MainApp) + `MainApp.Test/src/SomeTest.Codeunit.al` (with unquoted codeunit name + namespace + multiline attr variants)
- `al.code-workspace` at fixture root listing both folders

Reused by both unit and integration tests. Add a second fixture `test/fixtures/single-app/` for regression of single-folder flow, and `test/fixtures/no-app/` for plain AL files without `app.json`.

### Regression

- Add explicit regression test per bug found: codeunit regex unquoted name, multi-root `workspaceFolders[0]` ignored, `.code-workspace` handling.
- Every future bug fix adds a test first (TDD per `CLAUDE.md`).

### Manual verification checklist

- [ ] Open Sentinel repo → tests in sidebar grouped by app.
- [ ] Save `BusinessCentral.Sentinel/*.al` → `BusinessCentral.Sentinel.Test` runs.
- [ ] Save test file → that codeunit's tests run.
- [ ] Disable tree-sitter (rename WASM) → fallback tier active, tests still discovered, status bar hover reflects tier.
- [ ] `app.json` edit (bump version) → tree refreshes.
- [ ] Add new `.al` with `[Test]` → appears without reload.
- [ ] Workspace with no `app.json` at all (plain scratch folder) → scratch-standalone still works.

---

## Implementation Sequence (preview)

The writing-plans skill will decompose. High-level order:

1. Tree-sitter-al WASM plumbing + `AlSymbolIndex` skeleton (unit-tested in isolation).
2. `WorkspaceModel` with `app.json` scanner and dep graph (unit-tested).
3. Fix codeunit regex in `testDiscovery.ts` (trivial, but gate with tests first).
4. Wire `WorkspaceModel` into `AlchemistTestController`; multi-app tree.
5. Wire `AlSymbolIndex` into save routing; fallback tier switch.
6. Scratch-project multi-app resolution (bonus fix).
7. Integration tests against fixture corpus.
8. Manual verification on Sentinel.

---

## Open Questions / Risks

- `alchemist.testRunOnSave` semantics change — document migration in CHANGELOG. Default remains `current`.
- Tree-sitter-al grammar coverage for AL-5 namespace syntax — spike during step 1 to confirm; if gaps exist, raise upstream or pin to last-good revision.
- WASM file size / load time — measure on large workspaces (100+ `.al` files); if cold start is slow, parallelize parse across workers.
- Symbol FqName ambiguity when `using` clauses overlap — document resolution order (local → usings in declared order → global). Unit test with conflicting usings.
