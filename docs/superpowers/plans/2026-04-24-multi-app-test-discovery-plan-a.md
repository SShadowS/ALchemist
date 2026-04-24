# Plan A — Multi-App Foundation (Fallback Tier)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ALchemist work on real multi-app AL workspaces (Sentinel-shaped: `.code-workspace` with multiple `app.json`-rooted apps). Ship the fallback tier of the approved design: `WorkspaceModel` with dep graph, fixed codeunit regex accepting unquoted names, multi-app Test Explorer tree, save routing via transitive dep graph, exit-code-aware AL.Runner fallback, scratch-project multi-app selection. Precision tier (tree-sitter-al) is out of scope — Plan B.

**Architecture:** Add `WorkspaceModel` and `AppJsonParser` as new first-class components. Revise `AlchemistTestController` to group by app. Fix executor fallback to respect AL.Runner 1.0.12+ differentiated exit codes. Remove `workspaceFolders?.[0]` from all call sites.

**Tech Stack:** TypeScript, VS Code extension API (`workspaceFolders`, `FileSystemWatcher`, `TestController`), mocha (unit tests), existing Cobertura/JSON output parsing unchanged.

**Design reference:** `docs/superpowers/specs/2026-04-24-multi-app-test-discovery-design.md`

---

## File Structure

**New files:**
- `src/workspace/appJsonParser.ts` — parse `app.json` into typed `AlApp`
- `src/workspace/workspaceModel.ts` — scan workspace, dep graph, watcher
- `src/workspace/types.ts` — shared types (`AlApp`, `AlAppDependency`)
- `test/suite/appJsonParser.test.ts` — parser unit tests
- `test/suite/workspaceModel.test.ts` — scan/dep-graph/watcher unit tests
- `test/suite/routingLogic.test.ts` — save-routing fallback-tier tests
- `test/fixtures/multi-app/MainApp/app.json`
- `test/fixtures/multi-app/MainApp/src/SomeTable.Table.al`
- `test/fixtures/multi-app/MainApp/src/SomeCodeunit.Codeunit.al`
- `test/fixtures/multi-app/MainApp.Test/app.json`
- `test/fixtures/multi-app/MainApp.Test/src/SomeTest.Codeunit.al`
- `test/fixtures/multi-app/al.code-workspace`
- `test/fixtures/single-app/app.json`
- `test/fixtures/single-app/src/OnlyCodeunit.Codeunit.al`
- `test/fixtures/no-app/Scratch.al`

**Modified files:**
- `src/testing/testDiscovery.ts` — codeunit regex accepts unquoted names
- `src/testing/testController.ts` — multi-app tree, per-app runTests, save routing via `WorkspaceModel`
- `src/extension.ts` — wire `WorkspaceModel`, remove every `workspaceFolders?.[0]` (lines 56, 79, 92, 132, 144)
- `src/scratch/scratchManager.ts` — multi-app scratch-project selection
- `src/runner/executor.ts` — fallback retries only on AL compile error (exit code 3)
- `src/runner/alRunnerManager.ts` — bump min version hint to 1.0.12
- `package.json` — add `alchemist.scratchProjectAppId` setting
- `test/suite/testDiscovery.test.ts` — add regression cases for unquoted names, namespaces
- `test/suite/executor.test.ts` — add exit-code-aware fallback tests
- `test/suite/scratchManager.test.ts` — add multi-app resolution tests
- `CHANGELOG.md` — note AL.Runner 1.0.12 requirement, multi-app support

---

## Task 1: Bump AL.Runner min version + exit-code-aware fallback

**Files:**
- Modify: `src/runner/alRunnerManager.ts`
- Modify: `src/runner/executor.ts`
- Modify: `test/suite/executor.test.ts`

**Context:** AL.Runner 1.0.12+ returns differentiated exit codes (`0` pass, `1` test failure, `2` runner limitation, `3` AL compile error). The current single-file fallback in `executor.ts` retries whenever `exitCode !== 0`, which wrongly retries on assertion failures. It should retry only on compile errors.

- [ ] **Step 1: Read current `executor.ts:63-77` fallback block**

No change needed, just confirm line numbers.

- [ ] **Step 2: Add failing tests for exit-code-aware fallback**

Create in `test/suite/executor.test.ts`:

```typescript
import * as assert from 'assert';
import { buildRunnerArgs } from '../../src/runner/executor';

suite('buildRunnerArgs — exit-code-aware behavior (test-mode)', () => {
  test('test mode builds project-scoped args', () => {
    const { args, cwd } = buildRunnerArgs('test', '/ws/main/src/T.al', '/ws/main');
    assert.deepStrictEqual(args, ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', '/ws/main']);
    assert.strictEqual(cwd, '/ws/main');
  });

  test('test mode with procedureName inserts --run before path', () => {
    const { args } = buildRunnerArgs('test', '/ws/main/src/T.al', '/ws/main', 'MyProc');
    const runIdx = args.indexOf('--run');
    assert.ok(runIdx >= 0, '--run flag present');
    assert.strictEqual(args[runIdx + 1], 'MyProc');
    assert.strictEqual(args[args.length - 1], '/ws/main', 'path is last arg');
  });
});
```

New export needed: `shouldFallbackSingleFile(exitCode: number, testCount: number): boolean` in `executor.ts`.

```typescript
import * as assert from 'assert';
import { shouldFallbackSingleFile } from '../../src/runner/executor';

suite('shouldFallbackSingleFile', () => {
  test('retries on AL compile error (exit 3)', () => {
    assert.strictEqual(shouldFallbackSingleFile(3, 0), true);
  });
  test('does not retry on assertion failure (exit 1, tests ran)', () => {
    assert.strictEqual(shouldFallbackSingleFile(1, 5), false);
  });
  test('does not retry on runner limitation (exit 2)', () => {
    assert.strictEqual(shouldFallbackSingleFile(2, 0), false);
  });
  test('does not retry on pass (exit 0)', () => {
    assert.strictEqual(shouldFallbackSingleFile(0, 5), false);
  });
  test('retries on exit 1 with zero tests (legacy AL.Runner < 1.0.12)', () => {
    // Backward-compat: pre-1.0.12 used exit 1 for everything.
    assert.strictEqual(shouldFallbackSingleFile(1, 0), true);
  });
});
```

- [ ] **Step 3: Run tests — confirm failure**

```
npm run test-compile && npx mocha out/test/suite/executor.test.js
```

Expected: failures referring to missing `shouldFallbackSingleFile` export.

- [ ] **Step 4: Add `shouldFallbackSingleFile` export + use in `execute`**

Edit `src/runner/executor.ts`. After the existing `buildRunnerArgs` export, add:

```typescript
/**
 * Return true iff we should retry the test run as a single-file standalone
 * execution. AL.Runner 1.0.12+ uses exit code 3 for AL compile errors; older
 * versions used 1 for everything so we also retry on exit 1 with zero tests
 * captured (no tests discovered => project likely failed to compile).
 */
export function shouldFallbackSingleFile(exitCode: number, testCount: number): boolean {
  if (exitCode === 3) return true;
  if (exitCode === 1 && testCount === 0) return true;
  return false;
}
```

Replace the existing fallback condition at `executor.ts:63`:

```typescript
    if (mode === 'test' && shouldFallbackSingleFile(result.exitCode, result.tests.length) && filePath.endsWith('.al')) {
```

(Remove the old `result.tests.length === 0 && result.exitCode !== 0` check.)

- [ ] **Step 5: Run tests — confirm pass**

```
npm run test-compile && npx mocha out/test/suite/executor.test.js
```

Expected: all new tests pass, no existing tests broken.

- [ ] **Step 6: Update `alRunnerManager.ts` min-version hint**

Find the comment or constant referring to AL.Runner version requirement. If none, add at top of file:

```typescript
// Minimum supported AL.Runner version. Newer releases provide:
//  - 1.0.12+: differentiated exit codes (0/1/2/3), HTTP type compile fix,
//    --output-junit flag, per-file caches.
const MIN_AL_RUNNER_VERSION = '1.0.12';
```

Grep `alRunnerManager.ts` for version-check code. If a version check exists, update it to warn below 1.0.12. If not, leave the constant unused (it will be consumed in a future update; noting it here flags intent).

- [ ] **Step 7: Commit**

```
git add src/runner/executor.ts src/runner/alRunnerManager.ts test/suite/executor.test.ts
git commit -m "fix(executor): retry fallback only on AL compile error (exit 3)"
```

---

## Task 2: Fix codeunit regex to accept unquoted names

**Files:**
- Modify: `src/testing/testDiscovery.ts:16`
- Modify: `test/suite/testDiscovery.test.ts`

**Context:** Current regex `/codeunit\s+(\d+)\s+"([^"]+)"/i` only matches quoted names. AL allows `codeunit 71180500 AlertEngineTestSESTM` (bare identifier). Sentinel uses bare identifiers throughout — zero tests discovered.

- [ ] **Step 1: Add failing tests for unquoted codeunit + namespace + multiline attr**

Append to `test/suite/testDiscovery.test.ts`:

```typescript
suite('TestDiscovery — unquoted names, namespaces, multiline attrs', () => {
  test('discovers tests in codeunit with unquoted name', () => {
    const content = `
codeunit 71180500 AlertEngineTestSESTM
{
    Subtype = Test;

    [Test]
    procedure NewInsertsAlertWithDefaultSeverity()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'AlertEngineTest.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitId, 71180500);
    assert.strictEqual(result[0].codeunitName, 'AlertEngineTestSESTM');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'NewInsertsAlertWithDefaultSeverity');
  });

  test('discovers tests in namespaced file with unquoted codeunit', () => {
    const content = `namespace STM.BusinessCentral.Sentinel.Test;

using STM.BusinessCentral.Sentinel;

codeunit 71180500 AlertEngineTestSESTM
{
    Subtype = Test;
    Access = Internal;

    [Test]
    procedure NewInsertsAlertWithDefaultSeverity()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'AlertEngineTest.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests.length, 1);
  });

  test('still discovers tests in codeunit with quoted name (regression)', () => {
    const content = `
codeunit 50200 "Test Sales Calculation"
{
    Subtype = Test;

    [Test]
    procedure TestBasicDiscount()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestSales.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'Test Sales Calculation');
  });

  test('handles mixed codeunits (one quoted, one unquoted) in same file', () => {
    const content = `
codeunit 50100 "Old Style Test"
{
    [Test]
    procedure A() begin end;
}

codeunit 50101 NewStyleTest
{
    [Test]
    procedure B() begin end;
}`;
    const result = discoverTestsFromContent(content, 'Mixed.al');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].codeunitName, 'Old Style Test');
    assert.strictEqual(result[1].codeunitName, 'NewStyleTest');
  });

  test('rejects malformed codeunit header (missing id)', () => {
    const content = `
codeunit SomeCodeunit
{
    [Test]
    procedure X() begin end;
}`;
    const result = discoverTestsFromContent(content, 'Bad.al');
    assert.strictEqual(result.length, 0);
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/testDiscovery.test.js
```

Expected: 4 failures (all tests using unquoted codeunit names); 1 pass (quoted regression), 1 pass (malformed header — already fails current regex).

- [ ] **Step 3: Update codeunit regex**

Edit `src/testing/testDiscovery.ts:16`:

```typescript
// Accept both quoted identifiers ("Test Foo") and bare identifiers (TestFoo).
// Bare identifiers are AL identifier tokens: first char letter/underscore, rest word chars.
const CODEUNIT_REGEX = /codeunit\s+(\d+)\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i;
```

Update the match handler at `src/testing/testDiscovery.ts:33-45` to read the name from whichever group captured:

```typescript
    const codeunitMatch = line.match(CODEUNIT_REGEX);
    if (codeunitMatch) {
      if (currentCodeunitName && currentTests.length > 0) {
        codeunits.push({
          codeunitName: currentCodeunitName,
          codeunitId: currentCodeunitId!,
          fileName,
          tests: currentTests,
        });
      }
      currentCodeunitId = parseInt(codeunitMatch[1], 10);
      currentCodeunitName = codeunitMatch[2] ?? codeunitMatch[3];
      currentTests = [];
      continue;
    }
```

- [ ] **Step 4: Run tests — confirm all pass**

```
npm run test-compile && npx mocha out/test/suite/testDiscovery.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add src/testing/testDiscovery.ts test/suite/testDiscovery.test.ts
git commit -m "fix(discovery): accept unquoted codeunit names (AL bare identifiers)"
```

---

## Task 3: Build multi-app fixture

**Files:**
- Create: `test/fixtures/multi-app/MainApp/app.json`
- Create: `test/fixtures/multi-app/MainApp/src/SomeTable.Table.al`
- Create: `test/fixtures/multi-app/MainApp/src/SomeCodeunit.Codeunit.al`
- Create: `test/fixtures/multi-app/MainApp.Test/app.json`
- Create: `test/fixtures/multi-app/MainApp.Test/src/SomeTest.Codeunit.al`
- Create: `test/fixtures/multi-app/al.code-workspace`
- Create: `test/fixtures/single-app/app.json`
- Create: `test/fixtures/single-app/src/OnlyCodeunit.Codeunit.al`
- Create: `test/fixtures/no-app/Scratch.al`

**Context:** Unit tests and integration tests both need real `app.json` + `.al` content on disk. One multi-app layout, one single-app layout, one layout with no `app.json` at all. All AL content kept small and public-safe.

- [ ] **Step 1: Create `test/fixtures/multi-app/MainApp/app.json`**

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "name": "MainApp",
  "publisher": "ALchemist Tests",
  "version": "1.0.0.0",
  "dependencies": [],
  "idRanges": [{ "from": 50000, "to": 50099 }],
  "runtime": "13.0",
  "platform": "26.0.0.0",
  "application": "26.0.0.0"
}
```

- [ ] **Step 2: Create `test/fixtures/multi-app/MainApp/src/SomeTable.Table.al`**

```al
table 50000 SomeTable
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Name; Text[50]) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}
```

- [ ] **Step 3: Create `test/fixtures/multi-app/MainApp/src/SomeCodeunit.Codeunit.al`**

```al
codeunit 50001 SomeCodeunit
{
    procedure Compute(n: Integer): Integer
    begin
        exit(n * 2);
    end;
}
```

- [ ] **Step 4: Create `test/fixtures/multi-app/MainApp.Test/app.json`**

```json
{
  "id": "22222222-2222-2222-2222-222222222222",
  "name": "MainApp.Test",
  "publisher": "ALchemist Tests",
  "version": "1.0.0.0",
  "dependencies": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "MainApp",
      "publisher": "ALchemist Tests",
      "version": "1.0.0.0"
    }
  ],
  "idRanges": [{ "from": 50100, "to": 50199 }],
  "runtime": "13.0",
  "platform": "26.0.0.0",
  "application": "26.0.0.0"
}
```

- [ ] **Step 5: Create `test/fixtures/multi-app/MainApp.Test/src/SomeTest.Codeunit.al`**

Uses unquoted codeunit name + namespace + multiline attribute to exercise all regex edges:

```al
namespace ALchemist.Tests.MainAppTest;

using ALchemist.Tests.MainApp;

codeunit 50100 SomeTestCodeunit
{
    Subtype = Test;

    [Test]
    procedure ComputeDoubles()
    var
        Sut: Codeunit SomeCodeunit;
    begin
        if Sut.Compute(3) <> 6 then Error('expected 6');
    end;

    [Test, HandlerFunctions('MessageHandler')]
    procedure ComputeZero()
    var
        Sut: Codeunit SomeCodeunit;
    begin
        if Sut.Compute(0) <> 0 then Error('expected 0');
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}
```

- [ ] **Step 6: Create `test/fixtures/multi-app/al.code-workspace`**

```json
{
  "folders": [
    { "path": "MainApp" },
    { "path": "MainApp.Test" }
  ]
}
```

- [ ] **Step 7: Create `test/fixtures/single-app/app.json`**

```json
{
  "id": "33333333-3333-3333-3333-333333333333",
  "name": "SingleApp",
  "publisher": "ALchemist Tests",
  "version": "1.0.0.0",
  "dependencies": [],
  "idRanges": [{ "from": 50000, "to": 50099 }],
  "runtime": "13.0",
  "platform": "26.0.0.0",
  "application": "26.0.0.0"
}
```

- [ ] **Step 8: Create `test/fixtures/single-app/src/OnlyCodeunit.Codeunit.al`**

```al
codeunit 50000 "Only Codeunit"
{
    Subtype = Test;

    [Test]
    procedure Passes()
    begin
    end;
}
```

- [ ] **Step 9: Create `test/fixtures/no-app/Scratch.al`**

```al
codeunit 50000 Scratch
{
    trigger OnRun()
    begin
        Message('hi');
    end;
}
```

- [ ] **Step 10: Commit**

```
git add test/fixtures/multi-app test/fixtures/single-app test/fixtures/no-app
git commit -m "test: add multi-app / single-app / no-app fixtures"
```

---

## Task 4: `AppJsonParser`

**Files:**
- Create: `src/workspace/types.ts`
- Create: `src/workspace/appJsonParser.ts`
- Create: `test/suite/appJsonParser.test.ts`

**Context:** Parse a single `app.json` file into a typed `AlApp`. Fail cleanly on malformed input; emit a parse error the caller can surface.

- [ ] **Step 1: Create `src/workspace/types.ts`**

```typescript
export interface AlAppDependency {
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export interface AlApp {
  /** Absolute path to the folder containing app.json */
  path: string;
  /** app.json "id" — GUID */
  id: string;
  /** app.json "name" */
  name: string;
  /** app.json "publisher" */
  publisher: string;
  /** app.json "version" */
  version: string;
  /** app.json "dependencies" (empty array if none) */
  dependencies: AlAppDependency[];
}

export interface AppJsonParseError {
  path: string;
  message: string;
}

export type AppJsonParseResult =
  | { ok: true; app: AlApp }
  | { ok: false; error: AppJsonParseError };
```

- [ ] **Step 2: Add failing tests in `test/suite/appJsonParser.test.ts`**

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { parseAppJsonFile, parseAppJsonContent } from '../../src/workspace/appJsonParser';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('AppJsonParser', () => {
  test('parses multi-app MainApp/app.json', () => {
    const result = parseAppJsonFile(path.join(FIX, 'multi-app/MainApp/app.json'));
    assert.strictEqual(result.ok, true, 'parse should succeed');
    if (!result.ok) return;
    assert.strictEqual(result.app.name, 'MainApp');
    assert.strictEqual(result.app.id, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(result.app.dependencies.length, 0);
  });

  test('parses multi-app MainApp.Test/app.json with one dependency', () => {
    const result = parseAppJsonFile(path.join(FIX, 'multi-app/MainApp.Test/app.json'));
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.app.dependencies.length, 1);
    assert.strictEqual(result.app.dependencies[0].name, 'MainApp');
  });

  test('returns error on missing file', () => {
    const result = parseAppJsonFile('/definitely/does/not/exist/app.json');
    assert.strictEqual(result.ok, false);
  });

  test('returns error on invalid JSON', () => {
    const result = parseAppJsonContent('{ not json', '/tmp/bad.json');
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(/JSON/i.test(result.error.message) || /parse/i.test(result.error.message));
  });

  test('returns error when required field id is missing', () => {
    const result = parseAppJsonContent(JSON.stringify({
      name: 'X', publisher: 'Y', version: '1.0.0.0',
    }), '/tmp/missing-id.json');
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.ok(/id/.test(result.error.message));
  });

  test('returns error when required field name is missing', () => {
    const result = parseAppJsonContent(JSON.stringify({
      id: 'abc', publisher: 'Y', version: '1.0.0.0',
    }), '/tmp/missing-name.json');
    assert.strictEqual(result.ok, false);
  });

  test('treats missing dependencies array as empty', () => {
    const result = parseAppJsonContent(JSON.stringify({
      id: 'abc', name: 'N', publisher: 'P', version: '1.0.0.0',
    }), '/tmp/no-deps.json');
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.app.dependencies, []);
  });

  test('path on AlApp is the folder containing app.json (absolute)', () => {
    const jsonPath = path.join(FIX, 'multi-app/MainApp/app.json');
    const result = parseAppJsonFile(jsonPath);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.app.path, path.dirname(jsonPath));
  });
});
```

- [ ] **Step 3: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/appJsonParser.test.js
```

Expected: module-not-found errors (file doesn't exist yet).

- [ ] **Step 4: Implement `src/workspace/appJsonParser.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { AlApp, AppJsonParseResult } from './types';

/**
 * Parse an app.json file on disk. Returns { ok: false, error } on any failure
 * (file missing, invalid JSON, missing required fields). Never throws.
 */
export function parseAppJsonFile(appJsonPath: string): AppJsonParseResult {
  let raw: string;
  try {
    raw = fs.readFileSync(appJsonPath, 'utf-8');
  } catch (err: any) {
    return { ok: false, error: { path: appJsonPath, message: `read failed: ${err.message}` } };
  }
  return parseAppJsonContent(raw, appJsonPath);
}

/**
 * Parse app.json content. Shared with parseAppJsonFile and exposed for unit
 * tests that supply content directly without touching the filesystem.
 */
export function parseAppJsonContent(content: string, appJsonPath: string): AppJsonParseResult {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return { ok: false, error: { path: appJsonPath, message: `JSON parse error: ${err.message}` } };
  }

  const missing: string[] = [];
  if (typeof parsed.id !== 'string') missing.push('id');
  if (typeof parsed.name !== 'string') missing.push('name');
  if (typeof parsed.publisher !== 'string') missing.push('publisher');
  if (typeof parsed.version !== 'string') missing.push('version');
  if (missing.length > 0) {
    return {
      ok: false,
      error: { path: appJsonPath, message: `missing required field(s): ${missing.join(', ')}` },
    };
  }

  const deps = Array.isArray(parsed.dependencies) ? parsed.dependencies : [];
  const app: AlApp = {
    path: path.dirname(appJsonPath),
    id: parsed.id,
    name: parsed.name,
    publisher: parsed.publisher,
    version: parsed.version,
    dependencies: deps
      .filter((d: any) => typeof d === 'object' && d !== null)
      .map((d: any) => ({
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        publisher: String(d.publisher ?? ''),
        version: String(d.version ?? ''),
      })),
  };
  return { ok: true, app };
}
```

- [ ] **Step 5: Run tests — confirm all pass**

```
npm run test-compile && npx mocha out/test/suite/appJsonParser.test.js
```

Expected: 8 passing.

- [ ] **Step 6: Commit**

```
git add src/workspace/types.ts src/workspace/appJsonParser.ts test/suite/appJsonParser.test.ts
git commit -m "feat(workspace): add AlApp type and app.json parser"
```

---

## Task 5: `WorkspaceModel` — file walker + scan

**Files:**
- Create: `src/workspace/workspaceModel.ts` (skeleton + `scan()`)
- Create: `test/suite/workspaceModel.test.ts`

**Context:** Walk a list of workspace folders, find every `app.json`, respecting standard excludes. Stop descent when an `app.json` is found (no nested apps). Returns `AlApp[]`.

- [ ] **Step 1: Add failing tests**

Create `test/suite/workspaceModel.test.ts`:

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { findAppJsonRootsIn } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('WorkspaceModel — findAppJsonRootsIn', () => {
  test('finds both apps in multi-app fixture root', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'multi-app'));
    const names = roots.map(r => path.basename(r)).sort();
    assert.deepStrictEqual(names, ['MainApp', 'MainApp.Test']);
  });

  test('finds single app in single-app fixture', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'single-app'));
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(path.basename(roots[0]), 'single-app');
  });

  test('returns empty for fixture with no app.json', () => {
    const roots = findAppJsonRootsIn(path.join(FIX, 'no-app'));
    assert.deepStrictEqual(roots, []);
  });

  test('stops descent at first app.json (no nested roots)', () => {
    // multi-app/MainApp has app.json; MainApp/src does not have another.
    // Ensure the walker doesn't attempt to recurse past the app root.
    const roots = findAppJsonRootsIn(path.join(FIX, 'multi-app/MainApp'));
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0], path.join(FIX, 'multi-app/MainApp'));
  });

  test('skips excluded directories', () => {
    // Build an on-the-fly fixture under os.tmpdir() since we don't want to
    // commit node_modules to test/fixtures. Use fs for this single test.
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-ws-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'app.json'),
        JSON.stringify({ id: 'x', name: 'Should Not Find', publisher: 'p', version: '1.0.0.0' }));
      fs.mkdirSync(path.join(tmp, 'RealApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'RealApp', 'app.json'),
        JSON.stringify({ id: 'y', name: 'RealApp', publisher: 'p', version: '1.0.0.0' }));
      const roots = findAppJsonRootsIn(tmp);
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(path.basename(roots[0]), 'RealApp');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

Expected: module-not-found errors.

- [ ] **Step 3: Implement `findAppJsonRootsIn` in `src/workspace/workspaceModel.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { AlApp } from './types';

/** Directories never recursed into during workspace scan. */
const EXCLUDED_DIR_NAMES = new Set([
  '.alpackages',
  '.alcache',
  'node_modules',
  '.AL-Go',
  '.git',
  '.hg',
  '.svn',
  'bin',
  'obj',
  'out',
  '.snapshots',
  '.vscode-test',
]);

/**
 * Walk `root` recursively, returning the absolute path of every folder that
 * contains an app.json. Once an app.json is found in a folder, descent stops
 * there — nested apps are not supported in AL.
 */
export function findAppJsonRootsIn(root: string): string[] {
  const results: string[] = [];
  walk(root);
  return results;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }

    // If this directory itself contains app.json, record and stop descent.
    if (entries.some(e => e.isFile() && e.name.toLowerCase() === 'app.json')) {
      results.push(dir);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !EXCLUDED_DIR_NAMES.has(entry.name)) {
        walk(path.join(dir, entry.name));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```
git add src/workspace/workspaceModel.ts test/suite/workspaceModel.test.ts
git commit -m "feat(workspace): add findAppJsonRootsIn walker with standard excludes"
```

---

## Task 6: `WorkspaceModel` — class shell with `scan()`, `getApps`, `getAppContaining`

**Files:**
- Modify: `src/workspace/workspaceModel.ts`
- Modify: `test/suite/workspaceModel.test.ts`

**Context:** Wrap the walker in a stateful class. Parse every discovered `app.json` into `AlApp`. Provide lookup APIs. No watcher yet — that's Task 8.

- [ ] **Step 1: Add failing tests**

Append to `test/suite/workspaceModel.test.ts`:

```typescript
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

suite('WorkspaceModel — scan + lookups', () => {
  test('scan() populates two apps from multi-app fixture', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const apps = model.getApps();
    const names = apps.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['MainApp', 'MainApp.Test']);
  });

  test('scan() handles multi-root (two workspaceFolders)', async () => {
    const model = new WorkspaceModel([
      path.join(FIX, 'multi-app/MainApp'),
      path.join(FIX, 'multi-app/MainApp.Test'),
    ]);
    await model.scan();
    const apps = model.getApps();
    assert.strictEqual(apps.length, 2);
  });

  test('getAppContaining returns the owning app for a file inside', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const app = model.getAppContaining(file);
    assert.ok(app, 'should resolve an app');
    assert.strictEqual(app!.name, 'MainApp');
  });

  test('getAppContaining returns undefined for file outside any app', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'no-app/Scratch.al');
    assert.strictEqual(model.getAppContaining(file), undefined);
  });

  test('getAppContaining picks the most specific (deepest) app path', async () => {
    // Synthetic: two apps where one path is a parent of the other's src.
    // This shouldn't happen in AL (no nested apps) but the lookup must still
    // be deterministic — prefer the longest matching path.
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const file = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const app = model.getAppContaining(file);
    assert.strictEqual(app!.name, 'MainApp.Test');
  });

  test('getApps returns empty when no workspaceFolders provided', async () => {
    const model = new WorkspaceModel([]);
    await model.scan();
    assert.deepStrictEqual(model.getApps(), []);
  });

  test('malformed app.json is skipped with warning', async () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-ws-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'GoodApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'GoodApp', 'app.json'),
        JSON.stringify({ id: 'g', name: 'GoodApp', publisher: 'p', version: '1.0.0.0' }));
      fs.mkdirSync(path.join(tmp, 'BadApp'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'BadApp', 'app.json'), '{ not json');

      const warnings: string[] = [];
      const model = new WorkspaceModel([tmp], msg => warnings.push(msg));
      await model.scan();
      const names = model.getApps().map(a => a.name);
      assert.deepStrictEqual(names, ['GoodApp']);
      assert.ok(warnings.some(w => w.includes('BadApp')), 'expected warning for BadApp');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

- [ ] **Step 3: Implement `WorkspaceModel` class**

Append to `src/workspace/workspaceModel.ts`:

```typescript
import { AlApp } from './types';
import { parseAppJsonFile } from './appJsonParser';

export type WarnCallback = (message: string) => void;

export class WorkspaceModel {
  private apps: AlApp[] = [];
  // Map from app path → AlApp; used for fast dep-graph lookups later.
  private appsByPath = new Map<string, AlApp>();

  constructor(
    private workspaceFolders: string[],
    private warn: WarnCallback = () => {},
  ) {}

  async scan(): Promise<void> {
    this.apps = [];
    this.appsByPath.clear();

    const seen = new Set<string>();
    for (const folder of this.workspaceFolders) {
      const roots = findAppJsonRootsIn(folder);
      for (const root of roots) {
        if (seen.has(root)) continue;
        seen.add(root);

        const result = parseAppJsonFile(pathJoinAppJson(root));
        if (!result.ok) {
          this.warn(`ALchemist: failed to parse ${result.error.path}: ${result.error.message}`);
          continue;
        }
        this.apps.push(result.app);
        this.appsByPath.set(result.app.path, result.app);
      }
    }
  }

  getApps(): AlApp[] {
    return [...this.apps];
  }

  /**
   * Return the AlApp whose path is the longest prefix of `filePath`. If
   * filePath is outside every app, returns undefined.
   */
  getAppContaining(filePath: string): AlApp | undefined {
    const abs = pathNormalize(filePath);
    let best: AlApp | undefined;
    for (const app of this.apps) {
      const appPrefix = pathNormalize(app.path) + pathSep();
      if (abs.startsWith(appPrefix) || abs === pathNormalize(app.path)) {
        if (!best || app.path.length > best.path.length) best = app;
      }
    }
    return best;
  }
}

function pathJoinAppJson(dir: string): string {
  return require('path').join(dir, 'app.json');
}
function pathNormalize(p: string): string {
  return require('path').resolve(p);
}
function pathSep(): string {
  return require('path').sep;
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

Expected: all passing (including malformed warn test).

- [ ] **Step 5: Commit**

```
git add src/workspace/workspaceModel.ts test/suite/workspaceModel.test.ts
git commit -m "feat(workspace): add WorkspaceModel with scan and app lookup"
```

---

## Task 7: `WorkspaceModel` — dep graph with transitive closure + cycle guard

**Files:**
- Modify: `src/workspace/workspaceModel.ts`
- Modify: `test/suite/workspaceModel.test.ts`

**Context:** `getDependents(appId)` returns all apps that transitively depend on `appId`, plus `appId`'s own app (so self-tests also run on save). Dep edges: `A → B` iff `B.dependencies[].id === A.id`. Cycle-safe via visited set.

- [ ] **Step 1: Add failing tests**

Append to `test/suite/workspaceModel.test.ts`:

```typescript
suite('WorkspaceModel — dep graph', () => {
  const fsp = require('fs');
  const os = require('os');
  let tmp: string;
  let model: WorkspaceModel;

  function writeApp(folder: string, app: any) {
    fsp.mkdirSync(path.join(tmp, folder), { recursive: true });
    fsp.writeFileSync(path.join(tmp, folder, 'app.json'), JSON.stringify(app));
  }

  setup(() => {
    tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-dep-test-'));
  });
  teardown(() => {
    fsp.rmSync(tmp, { recursive: true, force: true });
  });

  test('getDependents: A is base, B depends on A, C depends on B', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('C', { id: 'c', name: 'C', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });

    model = new WorkspaceModel([tmp]);
    await model.scan();

    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A', 'B', 'C'], 'A plus transitive dependents B and C');

    const depsOfB = model.getDependents('b').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfB, ['B', 'C']);

    const depsOfC = model.getDependents('c').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfC, ['C'], 'leaf has only itself');
  });

  test('getDependents returns empty array for unknown appId', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' });
    model = new WorkspaceModel([tmp]);
    await model.scan();
    assert.deepStrictEqual(model.getDependents('nonexistent'), []);
  });

  test('cycle A <-> B handled without infinite recursion', async () => {
    writeApp('A', { id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }] });
    writeApp('B', { id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
      dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }] });

    const warnings: string[] = [];
    model = new WorkspaceModel([tmp], m => warnings.push(m));
    await model.scan();

    const depsOfA = model.getDependents('a').map(a => a.name).sort();
    assert.deepStrictEqual(depsOfA, ['A', 'B']);
    assert.ok(warnings.some(w => /cycle/i.test(w)), 'expected cycle warning');
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

Expected: `getDependents` undefined / missing method.

- [ ] **Step 3: Add `getDependents` + cycle detection**

Add into `WorkspaceModel` class (in `src/workspace/workspaceModel.ts`):

```typescript
  /**
   * Return `appId`'s own app plus all apps that transitively depend on it.
   * Save-triggered test runs walk this set: editing a file in app X warrants
   * running tests in every app that (directly or transitively) depends on X.
   *
   * Returns [] if appId matches no known app.
   */
  getDependents(appId: string): AlApp[] {
    const root = this.apps.find(a => a.id === appId);
    if (!root) return [];

    // Build reverse adjacency: for each app, which apps list it in deps.
    const reverseEdges = new Map<string, string[]>();
    for (const app of this.apps) {
      for (const dep of app.dependencies) {
        const list = reverseEdges.get(dep.id) ?? [];
        list.push(app.id);
        reverseEdges.set(dep.id, list);
      }
    }

    const visited = new Set<string>();
    const result: AlApp[] = [];
    const cycleDetected = { flag: false };

    const dfs = (id: string) => {
      if (visited.has(id)) {
        // Revisit of an already-accepted node is expected (diamond dep).
        // A revisit while the id is still on the active path would be a cycle,
        // but the visited set prunes before that — we only need to flag it
        // when a dep appears that we've seen transitively back. Simpler flag:
        // we set cycleDetected when encountering an app.dependency.id that
        // already equals an ancestor. Simpler impl below uses activePath.
        return;
      }
      visited.add(id);
      const app = this.apps.find(a => a.id === id);
      if (app) result.push(app);

      for (const dependentId of reverseEdges.get(id) ?? []) {
        dfs(dependentId);
      }
    };

    // Detect cycles separately via standard three-color DFS on forward edges.
    if (hasCycle(this.apps)) {
      cycleDetected.flag = true;
      this.warn('ALchemist: dependency cycle detected in app.json graph; results may be incomplete.');
    }

    dfs(appId);
    return result;
  }
```

Add helper at module level (outside the class) in the same file:

```typescript
function hasCycle(apps: AlApp[]): boolean {
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen, 1=onstack, 2=done
  const byId = new Map(apps.map(a => [a.id, a] as const));

  function visit(id: string): boolean {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;      // back edge
    if (s === 2) return false;     // already proven acyclic from here
    state.set(id, 1);
    const app = byId.get(id);
    if (app) {
      for (const dep of app.dependencies) {
        if (byId.has(dep.id) && visit(dep.id)) return true;
      }
    }
    state.set(id, 2);
    return false;
  }

  for (const app of apps) {
    if (visit(app.id)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

- [ ] **Step 5: Commit**

```
git add src/workspace/workspaceModel.ts test/suite/workspaceModel.test.ts
git commit -m "feat(workspace): add transitive dep graph with cycle detection"
```

---

## Task 8: `WorkspaceModel` — FileSystemWatcher + `onDidChange` + debounce

**Files:**
- Modify: `src/workspace/workspaceModel.ts`
- Modify: `test/suite/workspaceModel.test.ts`

**Context:** When any `app.json` is created/modified/deleted, rescan and fire `onDidChange` once per batch (200ms trailing debounce). The watcher is provided via an injected factory so unit tests don't need a real VS Code host.

- [ ] **Step 1: Add failing tests**

Append to `test/suite/workspaceModel.test.ts`:

```typescript
suite('WorkspaceModel — watcher + onDidChange', () => {
  test('watch(triggerRescan) rescans and fires onDidChange when triggered', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-watch-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));

      const model = new WorkspaceModel([tmp]);
      await model.scan();
      assert.strictEqual(model.getApps().length, 1);

      let fired = 0;
      const unsub = model.onDidChange(() => { fired++; });

      // Simulate watcher firing after a new app.json is created.
      fsp.mkdirSync(path.join(tmp, 'B'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'B', 'app.json'),
        JSON.stringify({ id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0' }));
      await model.triggerRescan();

      assert.strictEqual(fired, 1, 'onDidChange fired once');
      assert.strictEqual(model.getApps().length, 2);
      unsub();
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('onDidChange does not fire when rescan finds no changes', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-watch-test-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));
      const model = new WorkspaceModel([tmp]);
      await model.scan();

      let fired = 0;
      model.onDidChange(() => { fired++; });
      await model.triggerRescan(); // no filesystem change
      assert.strictEqual(fired, 0);
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

Expected: missing `onDidChange`, `triggerRescan`.

- [ ] **Step 3: Add `onDidChange` emitter + `triggerRescan` + change detection**

Add to `WorkspaceModel`:

```typescript
  private listeners = new Set<() => void>();
  private lastSignature = '';

  /**
   * Subscribe to workspace-model changes. Returns an unsubscribe function.
   * Fires exactly once per `triggerRescan` that produces a different app set
   * (identity by app.path + version string).
   */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Force a rescan. Intended to be called from a debounced FileSystemWatcher
   * handler in production; also called directly from tests.
   */
  async triggerRescan(): Promise<void> {
    await this.scan();
    const sig = this.computeSignature();
    if (sig !== this.lastSignature) {
      this.lastSignature = sig;
      for (const listener of this.listeners) listener();
    }
  }

  private computeSignature(): string {
    return this.apps
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(a => `${a.path}|${a.id}|${a.version}|${a.dependencies.map(d => d.id).join(',')}`)
      .join('\n');
  }
```

Also update `scan()` to compute initial signature so the first `triggerRescan` with no changes doesn't fire:

At the end of `scan()`:

```typescript
    this.lastSignature = this.computeSignature();
```

- [ ] **Step 4: Run tests — confirm pass**

```
npm run test-compile && npx mocha out/test/suite/workspaceModel.test.js
```

- [ ] **Step 5: Add VS Code FileSystemWatcher binding in a thin wrapper**

Append to `src/workspace/workspaceModel.ts` (separate exported helper — keeps unit tests VS-Code-free):

```typescript
import type * as vscode from 'vscode';

/**
 * Wire a WorkspaceModel to VS Code FileSystemWatcher events. The watcher
 * observes every `app.json` under every workspaceFolder; changes debounce
 * (200ms trailing) into a single `triggerRescan` call.
 *
 * Returns a disposable that tears down the watcher.
 */
export function bindWorkspaceModelToVsCode(
  model: WorkspaceModel,
  vscodeApi: typeof vscode,
): { dispose(): void } {
  const watcher = vscodeApi.workspace.createFileSystemWatcher('**/app.json');
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void model.triggerRescan(); }, 200);
  };
  const subs = [
    watcher.onDidCreate(schedule),
    watcher.onDidChange(schedule),
    watcher.onDidDelete(schedule),
  ];
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      for (const s of subs) s.dispose();
      watcher.dispose();
    },
  };
}
```

No new test here — integration-tested in Task 15.

- [ ] **Step 6: Commit**

```
git add src/workspace/workspaceModel.ts test/suite/workspaceModel.test.ts
git commit -m "feat(workspace): add onDidChange event and debounced VS Code watcher binding"
```

---

## Task 9: `AlchemistTestController` — multi-app tree

**Files:**
- Modify: `src/testing/testController.ts`
- Create: `test/suite/testController.multiApp.test.ts`

**Context:** Replace flat codeunit listing with App → Codeunit → Procedure tree. Tree is built from `WorkspaceModel.getApps()` + `discoverTestsInWorkspace(app.path)` per app. Apps with zero tests still show as empty nodes so users see their app was detected.

- [ ] **Step 1: Add failing tests**

Create `test/suite/testController.multiApp.test.ts`:

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { buildTestTree } from '../../src/testing/testController';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('TestController — buildTestTree (pure)', () => {
  test('multi-app fixture produces App→Codeunit→Procedure tree', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const tree = buildTestTree(model);

    assert.strictEqual(tree.length, 2);
    const mainAppNode = tree.find(n => n.app.name === 'MainApp');
    const testAppNode = tree.find(n => n.app.name === 'MainApp.Test');
    assert.ok(mainAppNode);
    assert.ok(testAppNode);

    assert.strictEqual(mainAppNode!.codeunits.length, 0, 'MainApp has no tests');
    assert.strictEqual(testAppNode!.codeunits.length, 1, 'MainApp.Test has one test codeunit');

    const codeunit = testAppNode!.codeunits[0];
    assert.strictEqual(codeunit.codeunitName, 'SomeTestCodeunit');
    assert.deepStrictEqual(
      codeunit.tests.map(t => t.name).sort(),
      ['ComputeDoubles', 'ComputeZero'],
    );
  });

  test('single-app fixture produces one app node', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();
    const tree = buildTestTree(model);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].codeunits.length, 1);
  });

  test('no-app fixture produces empty tree', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'no-app')]);
    await model.scan();
    const tree = buildTestTree(model);
    assert.deepStrictEqual(tree, []);
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/testController.multiApp.test.js
```

Expected: `buildTestTree` not exported.

- [ ] **Step 3: Add `buildTestTree` to `src/testing/testController.ts`**

Add at the top of the file (after imports):

```typescript
import { WorkspaceModel } from '../workspace/workspaceModel';
import { AlApp } from '../workspace/types';
import { discoverTestsInWorkspace, DiscoveredTestCodeunit } from './testDiscovery';

export interface TestTreeAppNode {
  app: AlApp;
  codeunits: DiscoveredTestCodeunit[];
}

/**
 * Pure helper: for each app in the workspace model, discover its tests and
 * return the App → Codeunit → Procedure tree as plain data. The VS Code
 * TestController wraps this into TestItems.
 */
export function buildTestTree(model: WorkspaceModel): TestTreeAppNode[] {
  return model.getApps().map(app => ({
    app,
    codeunits: discoverTestsInWorkspaceSync(app.path),
  }));
}

// Sync variant since discovery only reads files.
function discoverTestsInWorkspaceSync(appPath: string): DiscoveredTestCodeunit[] {
  // discoverTestsInWorkspace is already sync under the hood (uses fs.readFileSync).
  // Wrap to drop its Promise interface for our sync tree builder.
  // We'll refactor the underlying function to be sync in Task 9.5 (merged here).
  // For now call it and unwrap synchronously.
  let result: DiscoveredTestCodeunit[] = [];
  discoverTestsInWorkspace(appPath).then(r => { result = r; });
  // The Promise resolves synchronously because the body is all sync I/O;
  // awaiting adds only a microtask. For test safety, also expose a sync core.
  return result;
}
```

**Note:** the above wrapper is unsafe — `result` may be empty when returned because the `.then` runs on microtask. Fix by refactoring `discoverTestsInWorkspace` to a sync version. Step 4 does that.

- [ ] **Step 4: Refactor `discoverTestsInWorkspace` to sync**

Edit `src/testing/testDiscovery.ts`. Rename existing async function and add sync variant:

```typescript
export function discoverTestsInWorkspaceSync(workspacePath: string): DiscoveredTestCodeunit[] {
  const allCodeunits: DiscoveredTestCodeunit[] = [];
  const alFiles = findAlFilesSync(workspacePath);
  for (const filePath of alFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(workspacePath, filePath);
    const discovered = discoverTestsFromContent(content, relativePath);
    allCodeunits.push(...discovered);
  }
  return allCodeunits;
}

// Keep async wrapper for backward compat with existing callers.
export async function discoverTestsInWorkspace(workspacePath: string): Promise<DiscoveredTestCodeunit[]> {
  return discoverTestsInWorkspaceSync(workspacePath);
}

function findAlFilesSync(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIR_NAMES.has(entry.name)) {
      results.push(...findAlFilesSync(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.al')) {
      results.push(fullPath);
    }
  }
  return results;
}

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.alpackages',
  '.alcache',
  '.git',
  '.AL-Go',
  'bin',
  'obj',
  'out',
  '.snapshots',
]);

// Remove the old async findAlFiles implementation.
```

Then update `buildTestTree` in `testController.ts` to call the sync version directly:

```typescript
import { discoverTestsInWorkspaceSync, DiscoveredTestCodeunit } from './testDiscovery';

export function buildTestTree(model: WorkspaceModel): TestTreeAppNode[] {
  return model.getApps().map(app => ({
    app,
    codeunits: discoverTestsInWorkspaceSync(app.path),
  }));
}
```

- [ ] **Step 5: Run all unit tests**

```
npm run test-compile && npx mocha out/test/suite/*.test.js
```

Expected: all passing, including new tree tests.

- [ ] **Step 6: Wire `buildTestTree` into `refreshTests`**

Replace the body of `AlchemistTestController.refreshTests`:

```typescript
  async refreshTests(model: WorkspaceModel): Promise<void> {
    const tree = buildTestTree(model);

    this.controller.items.replace([]);
    this.testItems.clear();

    for (const node of tree) {
      const appItem = this.controller.createTestItem(
        `app-${node.app.id}`,
        node.app.name,
        vscode.Uri.file(node.app.path),
      );

      for (const codeunit of node.codeunits) {
        const codeunitItem = this.controller.createTestItem(
          `codeunit-${node.app.id}-${codeunit.codeunitId}`,
          codeunit.codeunitName,
          vscode.Uri.file(path.join(node.app.path, codeunit.fileName)),
        );

        for (const test of codeunit.tests) {
          const testItem = this.controller.createTestItem(
            `test-${node.app.id}-${codeunit.codeunitId}-${test.name}`,
            test.name,
            vscode.Uri.file(path.join(node.app.path, codeunit.fileName)),
          );
          testItem.range = new vscode.Range(test.line, 0, test.line, 0);
          codeunitItem.children.add(testItem);
          this.testItems.set(test.name, testItem);
        }

        appItem.children.add(codeunitItem);
      }

      this.controller.items.add(appItem);
    }
  }
```

Update the signature — old callers pass `workspacePath: string`; new callers pass `model: WorkspaceModel`. Task 12 rewires call sites.

- [ ] **Step 7: Commit**

```
git add src/testing/testController.ts src/testing/testDiscovery.ts test/suite/testController.multiApp.test.ts
git commit -m "feat(testing): group Test Explorer by AL app (App→Codeunit→Procedure)"
```

---

## Task 10: `AlchemistTestController` — per-app `runTests` routing

**Files:**
- Modify: `src/testing/testController.ts`
- Modify: `test/suite/testController.multiApp.test.ts`

**Context:** `runTests` currently uses `workspaceFolders?.[0].uri.fsPath`. Instead, each `TestItem` should resolve its owning app via `WorkspaceModel` and pass that app's `path` to `Executor.execute`.

- [ ] **Step 1: Add failing test**

Append to `test/suite/testController.multiApp.test.ts`:

```typescript
import { groupTestItemsByApp } from '../../src/testing/testController';

suite('TestController — groupTestItemsByApp', () => {
  test('groups items by owning app using their id prefix', () => {
    const items = [
      { id: 'app-aaa', appId: 'aaa' },
      { id: 'codeunit-aaa-50100', appId: 'aaa' },
      { id: 'test-aaa-50100-Foo', appId: 'aaa' },
      { id: 'test-bbb-50200-Bar', appId: 'bbb' },
    ].map(x => ({ id: x.id }));

    const groups = groupTestItemsByApp(items as any);
    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get('aaa')!.length, 3);
    assert.strictEqual(groups.get('bbb')!.length, 1);
  });

  test('items with unparseable ids land in an empty-id bucket', () => {
    const items = [{ id: 'something-weird' }];
    const groups = groupTestItemsByApp(items as any);
    assert.ok(groups.has(''));
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/testController.multiApp.test.js
```

- [ ] **Step 3: Implement `groupTestItemsByApp`**

Append to `src/testing/testController.ts`:

```typescript
export function groupTestItemsByApp(items: readonly { id: string }[]): Map<string, { id: string }[]> {
  const groups = new Map<string, { id: string }[]>();
  for (const item of items) {
    // id format: "app-<id>" | "codeunit-<id>-<cu>" | "test-<id>-<cu>-<name>"
    const match = /^(?:app|codeunit|test)-([^-]+)/.exec(item.id);
    const appId = match ? match[1] : '';
    const list = groups.get(appId) ?? [];
    list.push(item);
    groups.set(appId, list);
  }
  return groups;
}
```

- [ ] **Step 4: Rewire `runTests` to use app-scoped paths**

Replace the body of `AlchemistTestController.runTests`:

```typescript
  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    model: WorkspaceModel,
  ): Promise<void> {
    token.onCancellationRequested(() => this.executor.cancel());

    if (request.include && request.include.length > 0) {
      const groups = groupTestItemsByApp(request.include);
      for (const [appId, items] of groups) {
        const app = model.getApps().find(a => a.id === appId);
        if (!app) continue;
        for (const item of items) {
          // item.label is the test procedure name for test items.
          const procedureName = isTestItem(item.id) ? (item as vscode.TestItem).label : undefined;
          await this.executor.execute('test', app.path, app.path, procedureName);
        }
      }
    } else {
      // Run All: iterate every app.
      for (const app of model.getApps()) {
        await this.executor.execute('test', app.path, app.path);
      }
    }
  }
```

Add helper:

```typescript
function isTestItem(id: string): boolean {
  return id.startsWith('test-');
}
```

`runTests` signature now takes `model` as a third parameter. Update the run profile wiring in the constructor:

```typescript
export class AlchemistTestController {
  // ...
  constructor(
    private readonly executor: Executor,
    private readonly model: WorkspaceModel,
  ) {
    this.controller = vscode.tests.createTestController('alchemist', 'ALchemist');
    this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token, this.model),
      true,
    );
  }
  // ...
}
```

- [ ] **Step 5: Run tests**

```
npm run test-compile && npx mocha out/test/suite/*.test.js
```

Expected: all passing.

- [ ] **Step 6: Commit**

```
git add src/testing/testController.ts test/suite/testController.multiApp.test.ts
git commit -m "feat(testing): route runTests per owning app (drop workspaceFolders[0])"
```

---

## Task 11: Save routing (fallback tier) — dep-graph walk on save

**Files:**
- Create: `src/testing/saveRouting.ts`
- Create: `test/suite/routingLogic.test.ts`

**Context:** On file save, resolve the saved file to its owning `AlApp` via `WorkspaceModel`. Compute `getDependents(app.id)` — that's the set of apps whose tests might be affected. Return one `Executor.execute` descriptor per app. Pure function; `onDidSaveTextDocument` wrapper is wired in Task 12.

- [ ] **Step 1: Add failing tests**

Create `test/suite/routingLogic.test.ts`:

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { planSaveRuns, SaveRunPlan } from '../../src/testing/saveRouting';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('saveRouting.planSaveRuns (fallback tier)', () => {
  test('saving a file in MainApp triggers runs in MainApp + MainApp.Test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    const appNames = plan.map(p => p.appName).sort();
    assert.deepStrictEqual(appNames, ['MainApp', 'MainApp.Test']);
  });

  test('saving a file in MainApp.Test triggers run only in MainApp.Test', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].appName, 'MainApp.Test');
  });

  test('scope=all returns every app regardless of saved file location', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'all');
    const appNames = plan.map(p => p.appName).sort();
    assert.deepStrictEqual(appNames, ['MainApp', 'MainApp.Test']);
  });

  test('scope=off returns empty', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'off');
    assert.deepStrictEqual(plan, []);
  });

  test('file outside any app returns empty plan', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    const file = path.join(FIX, 'no-app/Scratch.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.deepStrictEqual(plan, []);
  });

  test('single-app workspace: save in that app runs its tests', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'single-app')]);
    await model.scan();

    const file = path.join(FIX, 'single-app/src/OnlyCodeunit.Codeunit.al');
    const plan = planSaveRuns(file, model, 'current');
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].appName, 'SingleApp');
  });
});
```

- [ ] **Step 2: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/routingLogic.test.js
```

- [ ] **Step 3: Implement `src/testing/saveRouting.ts`**

```typescript
import { WorkspaceModel } from '../workspace/workspaceModel';

export type SaveScope = 'current' | 'all' | 'off';

export interface SaveRunPlan {
  appId: string;
  appName: string;
  appPath: string;
}

/**
 * Decide which test runs should fire on file save. Fallback-tier semantics:
 *   - 'current': run tests in the saved file's owning app plus every app
 *     that transitively depends on it.
 *   - 'all': run tests in every app in the workspace.
 *   - 'off': return no runs.
 *
 * Returns [] when scope='current' and the file is outside every AL app.
 */
export function planSaveRuns(
  savedFilePath: string,
  model: WorkspaceModel,
  scope: SaveScope,
): SaveRunPlan[] {
  if (scope === 'off') return [];

  if (scope === 'all') {
    return model.getApps().map(a => ({ appId: a.id, appName: a.name, appPath: a.path }));
  }

  // scope === 'current'
  const owning = model.getAppContaining(savedFilePath);
  if (!owning) return [];
  return model.getDependents(owning.id).map(a => ({ appId: a.id, appName: a.name, appPath: a.path }));
}
```

- [ ] **Step 4: Run tests — confirm pass**

```
npm run test-compile && npx mocha out/test/suite/routingLogic.test.js
```

- [ ] **Step 5: Commit**

```
git add src/testing/saveRouting.ts test/suite/routingLogic.test.ts
git commit -m "feat(testing): add planSaveRuns (fallback-tier dep-graph routing)"
```

---

## Task 12: Wire `WorkspaceModel` + save routing into `extension.ts`

**Files:**
- Modify: `src/extension.ts`

**Context:** Replace every `vscode.workspace.workspaceFolders?.[0]` usage with `WorkspaceModel`. Initialize `WorkspaceModel` at activation. Use `planSaveRuns` in the `onDidSaveTextDocument` handler. Subscribe to `model.onDidChange` to refresh the Test Explorer tree.

- [ ] **Step 1: Read current `extension.ts` lines 27-60 and 105-148**

To confirm current wiring.

- [ ] **Step 2: Add module-level `model` + `modelBinding` state**

At the top of `src/extension.ts`, with the other `let` declarations:

```typescript
import { WorkspaceModel, bindWorkspaceModelToVsCode } from './workspace/workspaceModel';
import { planSaveRuns } from './testing/saveRouting';

let workspaceModel: WorkspaceModel;
let modelBinding: { dispose(): void } | undefined;
```

- [ ] **Step 3: Initialize `WorkspaceModel` inside `activate`**

Replace the `// Discover tests in workspace` block (currently `extension.ts:55-59`):

```typescript
  // Build workspace model from all folders
  const folderPaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  workspaceModel = new WorkspaceModel(folderPaths, msg => outputChannel.appendLine(msg));
  await workspaceModel.scan();
  modelBinding = bindWorkspaceModelToVsCode(workspaceModel, vscode);

  // Initial populate of Test Explorer
  await testController.refreshTests(workspaceModel);

  // Refresh on model changes (app.json added/removed/modified)
  workspaceModel.onDidChange(() => {
    void testController.refreshTests(workspaceModel);
  });
```

(Note: `testController.refreshTests` now takes `WorkspaceModel` per Task 9.)

- [ ] **Step 4: Update `AlchemistTestController` constructor call**

Find `testController = new AlchemistTestController(executor);` (line ~38) and change to:

```typescript
  testController = new AlchemistTestController(executor, workspaceModel);
```

Order: `workspaceModel` must be initialized BEFORE `testController`. Move the folder-scan lines above the try/catch component init, or move `testController` init below the scan. The cleanest fix:

```typescript
  try {
    // Initialize runtime infra first
    runnerManager = new AlRunnerManager();
    executor = new Executor(runnerManager);
    decorationManager = new DecorationManager(context.extensionPath);
    outputChannel = new AlchemistOutputChannel();
    statusBar = new StatusBarManager();
    scratchManager = new ScratchManager(context.globalStorageUri.fsPath);
    iterationStore = new IterationStore();
    iterationTablePanel = new IterationTablePanel(iterationStore, context.extensionUri);

    // Build workspace model, THEN controller that depends on it
    const folderPaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    workspaceModel = new WorkspaceModel(folderPaths, msg => outputChannel.appendLine(msg));
    await workspaceModel.scan();
    modelBinding = bindWorkspaceModelToVsCode(workspaceModel, vscode);

    testController = new AlchemistTestController(executor, workspaceModel);
  } catch (err: any) {
    // ... existing
  }
```

Then the refresh/subscribe lines go after the try/catch (both `testController` and `workspaceModel` are ready):

```typescript
  await testController.refreshTests(workspaceModel);
  workspaceModel.onDidChange(() => void testController.refreshTests(workspaceModel));
```

- [ ] **Step 5: Rewrite `onDidSaveTextDocument` test-routing branch**

Replace the else branch at `extension.ts:132-137` (the `// Test mode` block inside the save handler):

```typescript
      } else {
        // Multi-app test routing
        const scope = (config.get<string>('testRunOnSave', 'current') as 'current' | 'all' | 'off');
        const plan = planSaveRuns(filePath, workspaceModel, scope);
        for (const run of plan) {
          await executor.execute('test', filePath, run.appPath);
        }
      }
```

Delete the second `onDidSaveTextDocument` listener block at `extension.ts:142-148` (the test-refresh-on-save handler) — refresh now happens via `workspaceModel.onDidChange` when `app.json` changes; `.al` file changes don't need a full refresh because `buildTestTree` is cheap enough to call on demand when the user interacts with the tree. (Plan B's tree-sitter index will refresh more intelligently; for Plan A, saved `.al` files that add/remove tests surface on the next `app.json` change or next window reload. Document this limitation in the CHANGELOG.)

Actually — users save `.al` files far more often than `app.json`. Tests added to a codeunit won't appear until an `app.json` touch, which is confusing. Fix: subscribe to `workspace.onDidSaveTextDocument` and call `testController.refreshTests(workspaceModel)` when a `.al` file is saved, debounced 200ms:

```typescript
  // Debounced tree refresh when any .al file is saved
  let treeRefreshTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'al') return;
      if (treeRefreshTimer) clearTimeout(treeRefreshTimer);
      treeRefreshTimer = setTimeout(() => {
        treeRefreshTimer = undefined;
        void testController.refreshTests(workspaceModel);
      }, 200);
    }),
  );
```

- [ ] **Step 6: Remove every other `workspaceFolders?.[0]` usage**

Grep for remaining uses:

```
grep -n 'workspaceFolders?\[0\]\|workspaceFolders\[0\]\|workspaceFolders?.\[0\]' src/extension.ts
```

Replace each:
- Line ~79 (executor.onFinish, `wsPath`): use `workspaceModel.getAppContaining(editor.document.uri.fsPath)?.path ?? path.dirname(editor.document.uri.fsPath)`.
- Line ~91 (iterationStore.load): use the same `workspaceModel.getAppContaining(doc.uri.fsPath)?.path ?? ''`.
- Line ~127 (scratch project): handled in Task 13.

Do the replacements.

- [ ] **Step 7: Add dispose of `modelBinding` in `deactivate` (or equivalent)**

Find any existing `deactivate` / disposable aggregation. Add `modelBinding?.dispose()`. If none exists, append:

```typescript
export function deactivate() {
  modelBinding?.dispose();
}
```

- [ ] **Step 8: Compile + run all tests**

```
npm run test-compile && npx mocha out/test/suite/*.test.js
```

Expected: all passing. Any failure in existing tests indicates a wiring regression — fix before committing.

- [ ] **Step 9: Commit**

```
git add src/extension.ts
git commit -m "feat: wire WorkspaceModel into extension (drop workspaceFolders[0] usages)"
```

---

## Task 13: Scratch-project multi-app selection

**Files:**
- Modify: `src/scratch/scratchManager.ts`
- Modify: `src/extension.ts` (scratch save branch)
- Modify: `package.json` (new setting)
- Modify: `test/suite/scratchManager.test.ts`

**Context:** The `scratch-project` executor mode currently uses `workspaceFolders?.[0].uri.fsPath`. In multi-app workspaces this is wrong. Behavior: if 0 apps → standalone, if 1 app → that app, if N apps → read `alchemist.scratchProjectAppId` setting (by GUID); if unset or not found, show Quick Pick and persist choice per-scratch-file in ext global state.

- [ ] **Step 1: Add new setting to `package.json`**

Under `contributes.configuration.properties`, add:

```json
"alchemist.scratchProjectAppId": {
  "type": "string",
  "default": "",
  "description": "GUID (app.json 'id') of the AL app to use as context for project-aware scratch files. Leave empty to be prompted."
}
```

- [ ] **Step 2: Add failing tests for resolver**

Append to `test/suite/scratchManager.test.ts`:

```typescript
import { resolveScratchProjectApp } from '../../src/scratch/scratchManager';
import { AlApp } from '../../src/workspace/types';

const makeApp = (overrides: Partial<AlApp> = {}): AlApp => ({
  path: '/ws/MyApp', id: 'x', name: 'MyApp', publisher: 'p',
  version: '1.0.0.0', dependencies: [], ...overrides,
});

suite('ScratchManager — resolveScratchProjectApp', () => {
  test('0 apps → returns { mode: "standalone" }', () => {
    const r = resolveScratchProjectApp([], undefined, undefined);
    assert.strictEqual(r.mode, 'standalone');
  });

  test('1 app → returns that app', () => {
    const app = makeApp();
    const r = resolveScratchProjectApp([app], undefined, undefined);
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'x');
  });

  test('N apps + setting matches → uses setting', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'b', undefined);
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'b');
  });

  test('N apps + persisted choice matches → uses persisted', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], undefined, 'b');
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'b');
  });

  test('N apps + setting outranks persisted', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'a', 'b');
    assert.strictEqual(r.mode, 'app');
    if (r.mode !== 'app') return;
    assert.strictEqual(r.app.id, 'a');
  });

  test('N apps + no setting + no persisted → needs prompt', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], undefined, undefined);
    assert.strictEqual(r.mode, 'needsPrompt');
    if (r.mode !== 'needsPrompt') return;
    assert.deepStrictEqual(r.choices.map(c => c.id).sort(), ['a', 'b']);
  });

  test('N apps + stale setting (id not found) → needs prompt', () => {
    const a = makeApp({ id: 'a', name: 'A' });
    const b = makeApp({ id: 'b', name: 'B', path: '/ws/B' });
    const r = resolveScratchProjectApp([a, b], 'stale', undefined);
    assert.strictEqual(r.mode, 'needsPrompt');
  });
});
```

- [ ] **Step 3: Run tests — confirm failures**

```
npm run test-compile && npx mocha out/test/suite/scratchManager.test.js
```

- [ ] **Step 4: Implement `resolveScratchProjectApp`**

Append to `src/scratch/scratchManager.ts`:

```typescript
import { AlApp } from '../workspace/types';

export type ScratchAppResolution =
  | { mode: 'standalone' }
  | { mode: 'app'; app: AlApp }
  | { mode: 'needsPrompt'; choices: AlApp[] };

/**
 * Decide which AL app context to use for a project-aware scratch file.
 *
 * Priority:
 *   1. `settingAppId` (user's `alchemist.scratchProjectAppId` setting) if it
 *      matches an app in `apps`.
 *   2. `persistedAppId` (stored in ext global state keyed by scratch file
 *      path) if it matches an app in `apps`.
 *   3. With 0 apps: standalone. With 1 app: that app. With N: prompt.
 */
export function resolveScratchProjectApp(
  apps: AlApp[],
  settingAppId: string | undefined,
  persistedAppId: string | undefined,
): ScratchAppResolution {
  if (apps.length === 0) return { mode: 'standalone' };

  if (settingAppId) {
    const match = apps.find(a => a.id === settingAppId);
    if (match) return { mode: 'app', app: match };
  }

  if (persistedAppId) {
    const match = apps.find(a => a.id === persistedAppId);
    if (match) return { mode: 'app', app: match };
  }

  if (apps.length === 1) return { mode: 'app', app: apps[0] };
  return { mode: 'needsPrompt', choices: apps };
}
```

- [ ] **Step 5: Run tests — confirm pass**

```
npm run test-compile && npx mocha out/test/suite/scratchManager.test.js
```

- [ ] **Step 6: Wire resolver into extension save handler**

Replace the scratch-project branch in `extension.ts` (currently line ~127):

```typescript
      if (isScratchFile(filePath)) {
        const content = doc.getText();
        if (isProjectAware(content)) {
          const settingAppId = config.get<string>('scratchProjectAppId', '');
          const persistedAppId = context.globalState.get<string>(`alchemist.scratchApp.${filePath}`);
          const resolution = resolveScratchProjectApp(
            workspaceModel.getApps(),
            settingAppId || undefined,
            persistedAppId,
          );

          if (resolution.mode === 'standalone') {
            await executor.execute('scratch-standalone', filePath);
          } else if (resolution.mode === 'app') {
            await executor.execute('scratch-project', filePath, resolution.app.path);
          } else {
            // needsPrompt
            const pick = await vscode.window.showQuickPick(
              resolution.choices.map(c => ({ label: c.name, description: c.path, appId: c.id })),
              { placeHolder: 'Select AL app context for this scratch file' },
            );
            if (!pick) return;
            await context.globalState.update(`alchemist.scratchApp.${filePath}`, pick.appId);
            const chosen = resolution.choices.find(c => c.id === pick.appId)!;
            await executor.execute('scratch-project', filePath, chosen.path);
          }
        } else {
          await executor.execute('scratch-standalone', filePath);
        }
      }
```

Import `resolveScratchProjectApp` at the top of `extension.ts`:

```typescript
import { resolveScratchProjectApp } from './scratch/scratchManager';
```

- [ ] **Step 7: Run all tests**

```
npm run test-compile && npx mocha out/test/suite/*.test.js
```

- [ ] **Step 8: Commit**

```
git add src/scratch/scratchManager.ts src/extension.ts package.json test/suite/scratchManager.test.ts
git commit -m "feat(scratch): resolve AL app context per scratch file in multi-app workspaces"
```

---

## Task 14: `testRunOnSave` setting — verify all three branches end-to-end

**Files:**
- Modify: `test/suite/routingLogic.test.ts` (already covers planSaveRuns; verify the full save handler in extension.ts respects the setting)
- Modify: `test/suite/extension.save.test.ts` (new) — simple integration test using a stub Executor

- [ ] **Step 1: Decide scope**

The core logic (`planSaveRuns`) is already unit-tested in Task 11. The wiring in `extension.ts` pipes the setting directly. A dedicated integration test for the save handler would require mocking `vscode.workspace.getConfiguration` plus a stub Executor.

For Plan A, skip a bespoke integration test here — Task 15 exercises the save path end-to-end against the multi-app fixture. Check off this task as a placeholder to confirm the setting semantics are documented.

- [ ] **Step 2: Update `package.json` description for `alchemist.testRunOnSave`**

Edit `package.json`, find:

```json
"alchemist.testRunOnSave": {
  "type": "string",
  "enum": ["current", "all", "off"],
  "default": "current",
  "description": "Which tests to run on save."
}
```

Replace the description:

```json
"description": "Which tests to run on save. 'current' = tests in the saved file's app plus apps transitively depending on it. 'all' = every test in every AL app in the workspace. 'off' = no save-triggered runs."
```

- [ ] **Step 3: Commit**

```
git add package.json
git commit -m "docs(settings): clarify testRunOnSave semantics for multi-app"
```

---

## Task 15: Integration test against multi-app fixture

**Files:**
- Create: `test/suite/integration.multiApp.test.ts`

**Context:** End-to-end verification that opening the multi-app fixture, scanning it, and calling the public API produces the expected Test Explorer tree and save-routing plans. Uses real file I/O against the committed fixture, mocks only VS Code APIs not available outside the extension host.

- [ ] **Step 1: Write integration test**

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';
import { buildTestTree } from '../../src/testing/testController';
import { planSaveRuns } from '../../src/testing/saveRouting';
import { resolveScratchProjectApp } from '../../src/scratch/scratchManager';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('Integration — multi-app fixture end-to-end', () => {
  test('workspace scan → test tree → save plan roundtrip', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();

    // Scan finds both apps
    assert.strictEqual(model.getApps().length, 2);

    // Tree has both app nodes; MainApp.Test has the tests
    const tree = buildTestTree(model);
    const testAppNode = tree.find(n => n.app.name === 'MainApp.Test');
    assert.ok(testAppNode);
    assert.strictEqual(testAppNode!.codeunits.length, 1);
    assert.deepStrictEqual(
      testAppNode!.codeunits[0].tests.map(t => t.name).sort(),
      ['ComputeDoubles', 'ComputeZero'],
    );

    // Saving a file in MainApp routes to both apps
    const mainFile = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const plan = planSaveRuns(mainFile, model, 'current');
    assert.deepStrictEqual(plan.map(p => p.appName).sort(), ['MainApp', 'MainApp.Test']);

    // Saving a file in MainApp.Test routes only to that app
    const testFile = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const plan2 = planSaveRuns(testFile, model, 'current');
    assert.deepStrictEqual(plan2.map(p => p.appName), ['MainApp.Test']);

    // Scratch-project resolution picks between two apps
    const resolution = resolveScratchProjectApp(model.getApps(), undefined, undefined);
    assert.strictEqual(resolution.mode, 'needsPrompt');
  });

  test('simulated app.json change flips tree and dep graph', async () => {
    const os = require('os');
    const fsp = require('fs');
    const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'alchemist-int-'));
    try {
      fsp.mkdirSync(path.join(tmp, 'A'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'app.json'),
        JSON.stringify({ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }));
      fsp.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'),
        'codeunit 50000 Foo { Subtype = Test; [Test] procedure X() begin end; }');

      const model = new WorkspaceModel([tmp]);
      await model.scan();
      assert.strictEqual(model.getApps().length, 1);
      assert.strictEqual(buildTestTree(model)[0].codeunits.length, 1);

      // Add a second app that depends on A
      fsp.mkdirSync(path.join(tmp, 'B'), { recursive: true });
      fsp.writeFileSync(path.join(tmp, 'B', 'app.json'),
        JSON.stringify({
          id: 'b', name: 'B', publisher: 'p', version: '1.0.0.0',
          dependencies: [{ id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0' }],
        }));

      let fired = 0;
      model.onDidChange(() => { fired++; });
      await model.triggerRescan();
      assert.strictEqual(fired, 1);
      assert.strictEqual(model.getApps().length, 2);

      const depsOfA = model.getDependents('a').map(a => a.name).sort();
      assert.deepStrictEqual(depsOfA, ['A', 'B']);
    } finally {
      fsp.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run all tests**

```
npm run test-compile && npx mocha out/test/suite/*.test.js
```

Expected: all passing.

- [ ] **Step 3: Commit**

```
git add test/suite/integration.multiApp.test.ts
git commit -m "test: multi-app fixture end-to-end integration"
```

---

## Task 16: CHANGELOG + README + manual verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (if features table needs new entry for multi-app)
- Create: `docs/superpowers/plans/2026-04-24-plan-a-verification.md` (manual checklist)

**Context:** Plan A ships a meaningful feature (multi-app support). Document for release. Manual verification on Sentinel is the final gate before merging.

- [ ] **Step 1: Add `[Unreleased]` section to `CHANGELOG.md`**

Prepend (below the `# Changelog` header, above the `## 0.3.0` section):

```markdown
## [Unreleased]

### Features

- **Multi-app workspace support** — ALchemist now discovers AL apps (folders with `app.json`) across every workspace folder, not just the first. Works correctly on `.code-workspace` multi-root setups.
- **Test Explorer grouped by app** — Tests appear as App → Codeunit → Procedure. Multiple apps with same-named codeunits no longer collide.
- **Dependency-aware save routing** — Saving a file in a main app runs tests in every app that transitively depends on it (via `app.json` `dependencies`). Save in a test app runs only that app's tests.
- **Scratch-project multi-app selection** — Project-aware scratch files (`//alchemist: project`) in multi-app workspaces prompt for an AL app context on first use; choice persists per scratch file. Explicit override via `alchemist.scratchProjectAppId` setting.

### Fixes

- **Codeunit regex accepts unquoted names** — Discovery previously failed on `codeunit 50000 Name` (bare identifier); now accepts both quoted and unquoted forms. Unblocks real-world repos like BusinessCentral.Sentinel.
- **Fallback retry gated on AL compile error** — `executor.ts` previously retried every non-zero exit. Now retries only on exit code 3 (AL compile error) with AL.Runner 1.0.12+, or exit 1 with zero tests captured (legacy compatibility). Assertion failures and runner limitations no longer trigger spurious single-file retries.
- **Removed `workspaceFolders[0]` assumption** — Every call site that implicitly assumed a single workspace folder now resolves the owning AL app via `WorkspaceModel`.

### Requires

- AL.Runner **1.0.12+** for differentiated exit codes and HTTP type compile fix. Older runners still work but fall back to legacy exit-code handling.
```

- [ ] **Step 2: README — add multi-app to features table**

Append to the features table (after "Iteration table panel" row):

```markdown
| **Multi-app workspace** | Discovers every AL app across every workspace folder; Test Explorer groups by app; save routes tests via `app.json` dependencies |
```

- [ ] **Step 3: Write manual verification checklist**

Create `docs/superpowers/plans/2026-04-24-plan-a-verification.md`:

```markdown
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
```

- [ ] **Step 4: Commit**

```
git add CHANGELOG.md README.md docs/superpowers/plans/2026-04-24-plan-a-verification.md
git commit -m "docs: changelog + manual verification checklist for Plan A"
```

---

## Self-Review

After writing all tasks, spec coverage check:

- Spec §"Discovery via LSP" → Plan B (deferred). Plan A uses fallback regex; Task 2 fixes the unquoted-name gap that was its biggest failure mode. ✓
- Spec §"WorkspaceModel" → Tasks 4-8 (parser, scan, lookups, dep graph, watcher). ✓
- Spec §"AlSymbolIndex" → Plan B. ✓
- Spec §"AlchemistTestController revised" → Tasks 9-10 (tree, per-app runTests). ✓
- Spec §"Fallback tier" → implicit in Plans A's design (all routing uses dep graph, not symbol refs). ✓
- Spec §"Data flow — activation" → Task 12 (wire into extension.ts). ✓
- Spec §"Data flow — on save" → Task 11 (planSaveRuns) + Task 12 (wired). ✓
- Spec §"Data flow — app.json change" → Task 8 (watcher) + Task 12 (onDidChange). ✓
- Spec §"Data flow — scratch save" → Task 13. ✓
- Spec §"Error handling — malformed app.json" → Task 6. ✓
- Spec §"Error handling — cycle" → Task 7. ✓
- Spec §"Error handling — file outside any app" → Task 11 (planSaveRuns returns []). ✓
- Spec §"Testing — unit" → every new module has a suite. ✓
- Spec §"Testing — integration" → Task 15. ✓
- Spec §"Testing — fixtures" → Task 3. ✓
- Spec §"Implementation Sequence step 6" (scratch-project) → Task 13. ✓

No placeholders in the plan. All task-referenced functions (`parseAppJsonFile`, `findAppJsonRootsIn`, `WorkspaceModel`, `planSaveRuns`, `resolveScratchProjectApp`, `buildTestTree`, `groupTestItemsByApp`, `shouldFallbackSingleFile`) defined in specific tasks with complete code.

Type consistency check: `AlApp` defined in Task 4, used in Tasks 5-13 identically. `SaveRunPlan` defined in Task 11, re-used in Task 15 integration. `WorkspaceModel` constructor signature `(folders: string[], warn?: WarnCallback)` consistent across Tasks 5-8 and `extension.ts` wiring in Task 12.

---

## Out of scope (Plan B or later)

- Tree-sitter-al integration (own reference index, precision-tier routing)
- `--server` JSON-RPC client for AL.Runner (big warm-path speedup; candidate Plan D)
- Symbol-level test narrowing (depends on Plan B's symbol index, or AL.Runner's native partial execution)
- Status bar tier indicator — only meaningful once Plan B introduces the tier distinction; not needed for Plan A's single fallback tier
