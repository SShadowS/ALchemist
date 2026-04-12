# Iteration Source File Tracking

**Date:** 2026-04-12
**Status:** Approved

## Problem

The iteration CodeLens (`< All > | Table`) renders on whichever AL file is open, using line numbers from the file where the loop actually exists. If the loop is in `CU1.al` but the user is viewing `TextCU.al`, the CodeLens appears at a meaningless line in the wrong file.

Root cause: neither AL.Runner nor ALchemist tracks which source file a loop belongs to.

- `IterationData` / `LoopInfo` have no file path field.
- `IterationCodeLensProvider.provideCodeLenses()` ignores the `document` parameter and returns all loops.
- `MapObjectsToFiles()` in AL.Runner uses fragile substring search (`content.Contains(...)`) that matches comments and string literals.
- The scope-to-file mapping is only built inside the `if (options.ShowCoverage)` block — iteration tracking can't use it.

## Solution

Source file tracking as a first-class pipeline concept in AL.Runner, consumed by ALchemist to filter CodeLens by document.

---

## AL.Runner Changes

### 1. SourceFileMapper — New Static Class

Location: new file `AlRunner/SourceFileMapper.cs`.

Follows the `SourceLineMapper` pattern: static class, populated during pipeline setup, queried at serialization time.

**API:**

```csharp
public static class SourceFileMapper
{
    // Called per-object during input loading
    public static void Register(string objectName, string relativeFilePath);

    // Lookup at serialization time
    public static string? GetFile(string objectName);

    // Convenience: scope class name -> object name -> file path
    public static string? GetFileForScope(
        string scopeName,
        Dictionary<string, string> scopeToObject);

    // Reset between runs
    public static void Clear();
}
```

**Populated at input-loading time** in `RunCore`, as each `.al` file is read (lines 296-316 of Pipeline.cs). For each file:

1. Read the content (already happening).
2. Parse AL object declarations via regex.
3. Call `SourceFileMapper.Register(objectName, relativePath)` for each declaration found.

This replaces the retroactive `MapObjectsToFiles()` substring search.

### 2. AL Declaration Parsing

Regex for extracting object declarations:

```
(?:codeunit|table|page|report|xmlport|query|enum|enumextension|
 tableextension|pageextension|interface|permissionset|
 permissionsetextension|reportextension|profile|controladdin)
 \s+\d+\s+(?:"([^"]+)"|(\w+))
```

- Case-insensitive.
- Handles quoted names: `codeunit 50 "Loop Helper"` -> `Loop Helper`
- Handles unquoted names: `codeunit 50 LoopHelper` -> `LoopHelper`
- Only matches actual declarations, not occurrences in comments, strings, or `Message()` calls.
- Multiple objects in one file: all registered to the same path.

### 3. MapObjectsToFiles Refactored

`CoverageReport.MapObjectsToFiles()` is replaced by `SourceFileMapper`. Coverage code calls `SourceFileMapper.GetFile(objectName)` instead of re-reading files and substring searching.

### 4. SerializeJsonOutput — sourceFile Field

`SerializeJsonOutput` accepts the `scopeToObject` dictionary as a new parameter.

For each loop in the iterations array:

```csharp
sourceFile = SourceFileMapper.GetFileForScope(loop.ScopeName, scopeToObject)
```

JSON output gains `sourceFile`:

```json
{
  "iterations": [
    {
      "loopId": "L0",
      "sourceFile": "src/LoopHelper.al",
      "loopLine": 5,
      "loopEndLine": 12,
      "iterationCount": 3,
      ...
    }
  ]
}
```

Path format: CWD-relative, forward slashes, consistent with coverage paths.

### 5. Pipeline Wiring

The `BuildScopeToObjectMap` call is extracted from the coverage-only block. Built when **either** iteration tracking **or** coverage is enabled:

```csharp
Dictionary<string, string>? scopeToObject = null;
if (options.IterationTracking || options.ShowCoverage)
{
    scopeToObject = CoverageReport.BuildScopeToObjectMap(generatedCSharpList);
}
```

`SourceFileMapper.Clear()` called at the start of `RunCore` (alongside other per-run resets at lines 241-246).

`SourceFileMapper.Register()` called during file loading (lines 296-316 and similar blocks).

---

## ALchemist Changes

### 6. Types

`src/iteration/types.ts`:

```typescript
export interface IterationData {
  loopId: string;
  sourceFile: string;       // relative path from runner CWD
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  steps: IterationStepData[];
}

export interface LoopInfo {
  loopId: string;
  sourceFile: string;       // absolute path, resolved at load time
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  currentIteration: number;
}
```

### 7. Parser

`src/runner/outputParser.ts`:

```typescript
sourceFile: iter.sourceFile,
```

### 8. Store — Path Resolution at Load Time

`src/iteration/iterationStore.ts`:

`load()` gains a `workspacePath: string` parameter. Resolves each `sourceFile` from CWD-relative to absolute:

```typescript
load(iterations: IterationData[], workspacePath: string): void {
    // ...
    const info: LoopInfo = {
        // ...
        sourceFile: path.resolve(workspacePath, iter.sourceFile),
    };
}
```

Call site in `extension.ts` (~line 91):

```typescript
const wsPath = workspaceFolder?.uri.fsPath ?? '';
iterationStore.load(result.iterations, wsPath);
```

### 9. CodeLens Provider — Filter by Document

`src/iteration/iterationCodeLensProvider.ts`:

`buildCodeLenses` gains a required `documentPath: string` parameter. Skips loops whose `sourceFile` doesn't match:

```typescript
export function buildCodeLenses(store: IterationStore, documentPath: string): vscode.CodeLens[] {
    const loops = store.getLoops();
    const lenses: vscode.CodeLens[] = [];

    for (const loop of loops) {
        if (loop.iterationCount < 2) continue;
        if (!pathsEqual(loop.sourceFile, documentPath)) continue;
        // ... rest unchanged
    }
    return lenses;
}
```

Path comparison helper (Windows-aware):

```typescript
function pathsEqual(a: string, b: string): boolean {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}
```

`provideCodeLenses` uses the document parameter:

```typescript
provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return buildCodeLenses(this.store, document.uri.fsPath);
}
```

`IterationStepperDecoration.applyTo(editor)` applies the same filter.

---

## Testing

### AL.Runner Tests

**SourceFileMapper unit tests:**
- `Register` + `GetFile` round-trip returns correct path.
- `GetFile` returns null for unknown object name.
- `Clear` resets all registrations.
- `GetFileForScope` resolves scope -> object -> file chain.
- Multiple objects registered to same file path.

**Declaration parsing tests:**
- Quoted name: `codeunit 50 "Loop Helper"` -> `Loop Helper`.
- Unquoted name: `codeunit 50 LoopHelper` -> `LoopHelper`.
- Name in a comment -> not matched.
- Name in a `Message()` call -> not matched.
- Multiple objects in one file -> all extracted.
- Case-insensitive object type keywords (`CODEUNIT`, `Codeunit`).
- All object types parsed (table, page, report, enum, extensions, etc.).

**Integration:**
- Extend test case 67 (multi-file iteration tracking) to assert `sourceFile` is present and correct on each loop entry in the JSON output.

### ALchemist Tests

**`buildCodeLenses` filtering:**
- Loops with matching `sourceFile` -> CodeLens rendered.
- Loops with non-matching `sourceFile` -> no CodeLens.
- Multiple loops from different files -> only matching ones rendered.

**`IterationStore.load` path resolution:**
- Relative `sourceFile` resolved to absolute using workspace path.
- `getLoops()` returns resolved absolute paths.

**Updated fixtures:**
- Add `sourceFile` field to all `IterationData` fixtures in:
  - `iterationStore.test.ts`
  - `iterationCodeLens.test.ts`
  - `iterationIntegration.test.ts`
  - `hoverProvider.test.ts`
  - `iterationDisplay.test.ts`
  - `outputParser.test.ts`
  - `test/fixtures/test-al-runner-output.json`
