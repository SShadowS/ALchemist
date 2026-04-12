# Iteration Source File Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iteration CodeLens render only on the AL file where the loop actually lives, by adding `sourceFile` tracking from AL.Runner through to ALchemist.

**Architecture:** AL.Runner builds an object-name-to-file-path mapping at input-loading time via proper AL declaration parsing (`SourceFileMapper`). At JSON serialization, each loop's scope name is resolved through scope-to-object-to-file chain and emitted as `sourceFile`. ALchemist parses this field, resolves it to an absolute path at store load time, and filters CodeLens by matching against the active document.

**Tech Stack:** C# (.NET 8, xUnit) for AL.Runner; TypeScript (VS Code extension, Mocha) for ALchemist.

**Repos:**
- AL.Runner: `U:\Git\BusinessCentral.AL.Runner`
- ALchemist: `U:\Git\ALchemist`

---

## File Map

### AL.Runner (U:\Git\BusinessCentral.AL.Runner)

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `AlRunner/SourceFileMapper.cs` | Static class: register/lookup object-name-to-file mappings, AL declaration regex |
| Modify | `AlRunner/Pipeline.cs:133` | Pass `scopeToObject` to `SerializeJsonOutput` |
| Modify | `AlRunner/Pipeline.cs:148-151` | Add `scopeToObject` parameter to `SerializeJsonOutput` |
| Modify | `AlRunner/Pipeline.cs:183-186` | Emit `sourceFile` in iteration JSON |
| Modify | `AlRunner/Pipeline.cs:240-246` | Add `SourceFileMapper.Clear()` to per-run resets |
| Modify | `AlRunner/Pipeline.cs:295-324` | Register files with `SourceFileMapper` during input loading |
| Modify | `AlRunner/Pipeline.cs:521-541` | Extract `scopeToObject` build from coverage-only block; refactor coverage to use `SourceFileMapper` |
| Modify | `AlRunner/CoverageReport.cs:95-122` | Remove `MapObjectsToFiles` (replaced by `SourceFileMapper`) |
| Modify | `AlRunner/CoverageReport.cs:148-154` | Update `WriteCobertura` signature to drop `objectToFile` parameter |
| Create | `AlRunner.Tests/SourceFileMapperTests.cs` | Unit tests for SourceFileMapper |

### ALchemist (U:\Git\ALchemist)

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/iteration/types.ts:10-18` | Add `sourceFile: string` to `IterationData` |
| Modify | `src/iteration/types.ts:20-28` | Add `sourceFile: string` to `LoopInfo` |
| Modify | `src/runner/outputParser.ts:191-193` | Parse `sourceFile` from JSON |
| Modify | `src/iteration/iterationStore.ts:9-34` | Accept `workspacePath`, resolve `sourceFile` to absolute |
| Modify | `src/iteration/iterationCodeLensProvider.ts:21-81` | Add `documentPath` param, filter by `sourceFile` |
| Modify | `src/iteration/iterationCodeLensProvider.ts:96-98` | Pass `document.uri.fsPath` to `buildCodeLenses` |
| Modify | `src/iteration/iterationCodeLensProvider.ts:137-155` | Filter decorations by `sourceFile` |
| Modify | `src/extension.ts:91` | Pass `workspacePath` to `store.load()` |
| Modify | `test/suite/iterationCodeLens.test.ts` | Update fixtures + add filtering tests |
| Modify | `test/suite/iterationStore.test.ts` | Update fixtures + add path resolution tests |
| Modify | `test/suite/iterationIntegration.test.ts` | Update fixtures + integration call sites |
| Modify | `test/suite/outputParser.test.ts:299-345` | Add `sourceFile` to iteration JSON fixtures |
| Modify | `test/suite/hoverProvider.test.ts:44-56` | Add `sourceFile` to `makeLoopData()` |
| Modify | `test/suite/iterationDisplay.test.ts:22-43` | Add `sourceFile` to `makeRealLoopData()` |
| Modify | `test/fixtures/test-al-runner-output.json:88-92` | Add `sourceFile` to fixture |

---

## Task 1: SourceFileMapper — Core Class with Tests (AL.Runner)

**Files:**
- Create: `AlRunner/SourceFileMapper.cs`
- Create: `AlRunner.Tests/SourceFileMapperTests.cs`

- [ ] **Step 1: Write failing tests for Register/GetFile/Clear**

File: `AlRunner.Tests/SourceFileMapperTests.cs`

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

public class SourceFileMapperTests
{
    public SourceFileMapperTests()
    {
        SourceFileMapper.Clear();
    }

    [Fact]
    public void Register_GetFile_RoundTrip()
    {
        SourceFileMapper.Register("Loop Helper", "src/LoopHelper.al");
        Assert.Equal("src/LoopHelper.al", SourceFileMapper.GetFile("Loop Helper"));
    }

    [Fact]
    public void GetFile_UnknownObject_ReturnsNull()
    {
        Assert.Null(SourceFileMapper.GetFile("Nonexistent"));
    }

    [Fact]
    public void Clear_RemovesAllRegistrations()
    {
        SourceFileMapper.Register("Foo", "Foo.al");
        SourceFileMapper.Clear();
        Assert.Null(SourceFileMapper.GetFile("Foo"));
    }

    [Fact]
    public void MultipleObjects_SameFile()
    {
        SourceFileMapper.Register("Helper", "src/Multi.al");
        SourceFileMapper.Register("Utils", "src/Multi.al");
        Assert.Equal("src/Multi.al", SourceFileMapper.GetFile("Helper"));
        Assert.Equal("src/Multi.al", SourceFileMapper.GetFile("Utils"));
    }

    [Fact]
    public void GetFileForScope_ResolvesChain()
    {
        SourceFileMapper.Register("Loop Helper", "src/LoopHelper.al");
        var scopeToObject = new Dictionary<string, string>
        {
            ["Codeunit50020_Scope"] = "Loop Helper"
        };
        Assert.Equal("src/LoopHelper.al", SourceFileMapper.GetFileForScope("Codeunit50020_Scope", scopeToObject));
    }

    [Fact]
    public void GetFileForScope_UnknownScope_ReturnsNull()
    {
        var scopeToObject = new Dictionary<string, string>();
        Assert.Null(SourceFileMapper.GetFileForScope("Unknown_Scope", scopeToObject));
    }

    [Fact]
    public void GetFileForScope_ScopeKnownButObjectNotRegistered_ReturnsNull()
    {
        var scopeToObject = new Dictionary<string, string>
        {
            ["Codeunit50020_Scope"] = "Loop Helper"
        };
        // Not registered with SourceFileMapper
        Assert.Null(SourceFileMapper.GetFileForScope("Codeunit50020_Scope", scopeToObject));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test --filter "FullyQualifiedName~SourceFileMapperTests" --no-build 2>&1 || dotnet test --filter "FullyQualifiedName~SourceFileMapperTests"`
Expected: Compilation error — `SourceFileMapper` does not exist

- [ ] **Step 3: Implement SourceFileMapper**

File: `AlRunner/SourceFileMapper.cs`

```csharp
namespace AlRunner;

/// <summary>
/// Maps AL object names to their source file paths.
/// Populated at input-loading time, queried at JSON serialization.
/// Follows the SourceLineMapper pattern: static, built during pipeline setup.
/// </summary>
public static class SourceFileMapper
{
    private static readonly Dictionary<string, string> _objectToFile = new();

    /// <summary>
    /// Register an AL object name to its source file path.
    /// Called during input loading as each .al file is read.
    /// </summary>
    public static void Register(string objectName, string relativeFilePath)
    {
        _objectToFile[objectName] = relativeFilePath.Replace('\\', '/');
    }

    /// <summary>
    /// Look up the source file for an AL object name.
    /// </summary>
    public static string? GetFile(string objectName)
    {
        return _objectToFile.TryGetValue(objectName, out var file) ? file : null;
    }

    /// <summary>
    /// Resolve a C# scope class name to its AL source file path
    /// via the scope-to-object-to-file chain.
    /// </summary>
    public static string? GetFileForScope(
        string scopeName,
        Dictionary<string, string> scopeToObject)
    {
        if (!scopeToObject.TryGetValue(scopeName, out var objectName))
            return null;
        return GetFile(objectName);
    }

    /// <summary>
    /// Reset between runs.
    /// </summary>
    public static void Clear()
    {
        _objectToFile.Clear();
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test --filter "FullyQualifiedName~SourceFileMapperTests"`
Expected: All 7 tests pass

- [ ] **Step 5: Commit**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git add AlRunner/SourceFileMapper.cs AlRunner.Tests/SourceFileMapperTests.cs
git commit -m "Add SourceFileMapper for object-name-to-file mapping"
```

---

## Task 2: AL Declaration Parsing with Tests (AL.Runner)

**Files:**
- Modify: `AlRunner/SourceFileMapper.cs`
- Modify: `AlRunner.Tests/SourceFileMapperTests.cs`

- [ ] **Step 1: Write failing tests for ParseObjectDeclarations**

Append to `AlRunner.Tests/SourceFileMapperTests.cs`:

```csharp
public class AlDeclarationParsingTests
{
    [Fact]
    public void QuotedCodeunitName()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("codeunit 50 \"Loop Helper\"\n{\n}");
        Assert.Single(names);
        Assert.Equal("Loop Helper", names[0]);
    }

    [Fact]
    public void UnquotedCodeunitName()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("codeunit 50 LoopHelper\n{\n}");
        Assert.Single(names);
        Assert.Equal("LoopHelper", names[0]);
    }

    [Fact]
    public void TableDeclaration()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("table 100 \"My Table\"\n{\n}");
        Assert.Single(names);
        Assert.Equal("My Table", names[0]);
    }

    [Fact]
    public void EnumExtensionDeclaration()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("enumextension 50100 \"Status Ext\" extends Status\n{\n}");
        Assert.Single(names);
        Assert.Equal("Status Ext", names[0]);
    }

    [Fact]
    public void CaseInsensitiveKeyword()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("CODEUNIT 50 \"Foo\"\n{\n}");
        Assert.Single(names);
        Assert.Equal("Foo", names[0]);
    }

    [Fact]
    public void MultipleObjectsInOneFile()
    {
        var source = "codeunit 50 \"Helper\"\n{\n}\ntable 100 \"Data\"\n{\n}";
        var names = SourceFileMapper.ParseObjectDeclarations(source);
        Assert.Equal(2, names.Count);
        Assert.Contains("Helper", names);
        Assert.Contains("Data", names);
    }

    [Fact]
    public void NameInComment_NotMatched()
    {
        var source = "// codeunit 50 \"Fake\"\ncodeunit 51 \"Real\"\n{\n}";
        var names = SourceFileMapper.ParseObjectDeclarations(source);
        Assert.Single(names);
        Assert.Equal("Real", names[0]);
    }

    [Fact]
    public void NameInMessageCall_NotMatched()
    {
        var source = "codeunit 50 \"Real\"\n{\n  trigger OnRun() begin Message('codeunit 99 \"Fake\"'); end;\n}";
        var names = SourceFileMapper.ParseObjectDeclarations(source);
        Assert.Single(names);
        Assert.Equal("Real", names[0]);
    }

    [Fact]
    public void PageExtensionDeclaration()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("pageextension 50100 \"My Page Ext\" extends \"Customer Card\"\n{\n}");
        Assert.Single(names);
        Assert.Equal("My Page Ext", names[0]);
    }

    [Fact]
    public void EmptySource_ReturnsEmpty()
    {
        var names = SourceFileMapper.ParseObjectDeclarations("");
        Assert.Empty(names);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test --filter "FullyQualifiedName~AlDeclarationParsingTests" --no-build 2>&1 || dotnet test --filter "FullyQualifiedName~AlDeclarationParsingTests"`
Expected: Compilation error — `ParseObjectDeclarations` does not exist

- [ ] **Step 3: Implement ParseObjectDeclarations**

Add to `AlRunner/SourceFileMapper.cs`, inside the `SourceFileMapper` class:

```csharp
    private static readonly Regex ObjectDeclPattern = new(
        @"^(?:codeunit|table|page|report|xmlport|query|enum|enumextension|tableextension|pageextension|interface|permissionset|permissionsetextension|reportextension|profile|controladdin)\s+\d+\s+(?:""([^""]+)""|(\w+))",
        RegexOptions.IgnoreCase | RegexOptions.Multiline);

    /// <summary>
    /// Parse AL object declarations from source content.
    /// Returns the list of object names found.
    /// Only matches declarations at the start of a line (not in comments or strings).
    /// </summary>
    public static List<string> ParseObjectDeclarations(string content)
    {
        var names = new List<string>();
        foreach (Match m in ObjectDeclPattern.Matches(content))
        {
            var name = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
            names.Add(name);
        }
        return names;
    }
```

Add the `using System.Text.RegularExpressions;` at the top of the file.

The `^` anchor with `RegexOptions.Multiline` ensures we only match declarations at the start of a line, which excludes names in comments (`// codeunit ...`) and string literals (which are indented inside procedures).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test --filter "FullyQualifiedName~AlDeclarationParsingTests"`
Expected: All 10 tests pass

- [ ] **Step 5: Commit**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git add AlRunner/SourceFileMapper.cs AlRunner.Tests/SourceFileMapperTests.cs
git commit -m "Add AL declaration parsing to SourceFileMapper"
```

---

## Task 3: Wire SourceFileMapper into Pipeline Input Loading (AL.Runner)

**Files:**
- Modify: `AlRunner/Pipeline.cs:240-246, 272-324`

- [ ] **Step 1: Add SourceFileMapper.Clear() to per-run resets**

In `AlRunner/Pipeline.cs`, at line 246 (after `Runtime.MockNumberSequence.Reset();`), add:

```csharp
        SourceFileMapper.Clear();
```

- [ ] **Step 2: Register files during directory input loading**

In `AlRunner/Pipeline.cs`, replace lines 295-316 (the `else if (Directory.Exists(path))` block) with:

```csharp
            else if (Directory.Exists(path))
            {
                var alFiles = Directory.GetFiles(path, "*.al", SearchOption.AllDirectories)
                    .OrderBy(f => f).ToList();
                if (alFiles.Count == 0)
                {
                    stderr.WriteLine($"Error: no .al files found in directory {path}");
                    return 1;
                }
                Log.Info($"Loading {alFiles.Count} AL files from {path}");
                var groupSources = new List<string>();
                foreach (var f in alFiles)
                {
                    Log.Info($"  {Path.GetFileName(f)}");
                    var src = File.ReadAllText(f);
                    alSources.Add(src);
                    groupSources.Add(src);

                    var relativePath = Path.GetRelativePath(Directory.GetCurrentDirectory(), f);
                    foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                        SourceFileMapper.Register(objName, relativePath);
                }
                var fullPath = Path.GetFullPath(path);
                inputPaths.Add(fullPath);
                inputGroups.Add((fullPath, groupSources));
            }
```

- [ ] **Step 3: Register files during single-file input loading**

In `AlRunner/Pipeline.cs`, replace lines 317-324 (the `else if (File.Exists(path))` block) with:

```csharp
            else if (File.Exists(path))
            {
                var src = File.ReadAllText(path);
                alSources.Add(src);
                var fullPath = Path.GetFullPath(Path.GetDirectoryName(path)!);
                inputPaths.Add(fullPath);
                inputGroups.Add((fullPath, new List<string> { src }));

                var relativePath = Path.GetRelativePath(Directory.GetCurrentDirectory(), path);
                foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                    SourceFileMapper.Register(objName, relativePath);
            }
```

- [ ] **Step 4: Run existing tests to verify nothing is broken**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test`
Expected: All existing tests pass

- [ ] **Step 5: Commit**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git add AlRunner/Pipeline.cs
git commit -m "Wire SourceFileMapper into pipeline input loading"
```

---

## Task 4: Emit sourceFile in Iteration JSON + Refactor Coverage (AL.Runner)

**Files:**
- Modify: `AlRunner/Pipeline.cs:131-134, 148-151, 183-186, 521-541`
- Modify: `AlRunner/CoverageReport.cs:95-122, 148-154`

- [ ] **Step 1: Extract scopeToObject build from coverage-only block**

In `AlRunner/Pipeline.cs`, the `scopeToObject` build currently lives inside the `if (options.ShowCoverage)` block at line 538. Move it to be computed after test execution when either feature needs it.

Replace lines 516-541:

```csharp
            if (options.CaptureValues)
                Runtime.ValueCapture.Disable();
            if (options.IterationTracking)
                Runtime.IterationTracker.Disable();
            Runtime.MessageCapture.Disable();

            Dictionary<string, string>? scopeToObject = null;
            if (options.IterationTracking || options.ShowCoverage)
            {
                scopeToObject = CoverageReport.BuildScopeToObjectMap(generatedCSharpList!);
            }

            if (options.ShowCoverage)
            {
                Executor.PrintCoverageReport();

                var sourceSpans = CoverageReport.ParseSourceSpans(generatedCSharpList!);
                var (hitStmts, totalStmts) = Runtime.AlScope.GetCoverageSets();

                CoverageReport.WriteCobertura("cobertura.xml", sourceSpans, hitStmts, totalStmts, scopeToObject!);
                Log.Info("Coverage report: cobertura.xml");
            }
```

- [ ] **Step 2: Refactor WriteCobertura to use SourceFileMapper instead of objectToFile**

In `AlRunner/CoverageReport.cs`, update `WriteCobertura` signature at lines 148-154. Remove the `objectToFile` parameter and use `SourceFileMapper.GetFile()` instead:

Replace the signature:

```csharp
    public static void WriteCobertura(
        string outputPath,
        Dictionary<(string Scope, int StmtIndex), int> sourceSpans,
        HashSet<(string Type, int Id)> hitStatements,
        HashSet<(string Type, int Id)> totalStatements,
        Dictionary<string, string>? scopeToObject = null)
```

Replace lines 168-185 (the scope→file resolution logic inside WriteCobertura) with:

```csharp
            // Find which file this scope belongs to using SourceFileMapper
            string? filePath = null;
            if (scopeToObject != null && scopeToObject.TryGetValue(scope, out var objectName))
            {
                filePath = SourceFileMapper.GetFile(objectName);
            }
            // If scope doesn't match any user file, skip it entirely.
            // This prevents library/stub scopes (Assert, etc.) from
            // bleeding into the user's coverage report.
            if (filePath == null) continue;
```

- [ ] **Step 3: Delete MapObjectsToFiles**

In `AlRunner/CoverageReport.cs`, delete the `MapObjectsToFiles` method (lines 90-122). It is now fully replaced by `SourceFileMapper`.

- [ ] **Step 4: Add scopeToObject parameter to SerializeJsonOutput and emit sourceFile**

In `AlRunner/Pipeline.cs`, update `SerializeJsonOutput` signature at line 148-151:

```csharp
    public static string SerializeJsonOutput(
        List<TestResult> tests, int exitCode, bool indented = true,
        List<CapturedValue>? capturedValues = null, List<string>? messages = null,
        List<Runtime.IterationTracker.LoopRecord>? iterations = null,
        Dictionary<string, string>? scopeToObject = null)
```

In the iterations serialization block (lines 183-186), add `sourceFile`:

```csharp
            iterations = iterations?.Count > 0
                ? iterations.Select(loop => new
                {
                    loopId = $"L{loop.LoopId}",
                    sourceFile = scopeToObject != null
                        ? SourceFileMapper.GetFileForScope(loop.ScopeName, scopeToObject)
                        : null,
                    loopLine = SourceLineMapper.GetAlLineFromStatement(loop.ScopeName, loop.SourceStartLine) ?? loop.SourceStartLine,
                    loopEndLine = SourceLineMapper.GetAlLineFromStatement(loop.ScopeName, loop.SourceEndLine) ?? loop.SourceEndLine,
```

- [ ] **Step 5: Pass scopeToObject at the call site**

In `AlRunner/Pipeline.cs`, the `RunCore` method needs to return `scopeToObject` so the `Run` method can pass it to `SerializeJsonOutput`. Add a private field to `AlRunnerPipeline`:

```csharp
    private Dictionary<string, string>? _scopeToObject;
```

In `RunCore`, after computing `scopeToObject` (from step 1), store it:

```csharp
            _scopeToObject = scopeToObject;
```

In `Run` at line 133, pass it:

```csharp
            stdoutStr = SerializeJsonOutput(testResults, exitCode, capturedValues: capturedValues, messages: messages, iterations: iterationLoops, scopeToObject: _scopeToObject);
```

- [ ] **Step 6: Run all tests to verify nothing is broken**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git add AlRunner/Pipeline.cs AlRunner/CoverageReport.cs
git commit -m "Emit sourceFile in iteration JSON, refactor coverage to use SourceFileMapper"
```

---

## Task 5: Integration Test for sourceFile in Iteration JSON (AL.Runner)

**Files:**
- Modify: `AlRunner.Tests/PipelineTests.cs`

- [ ] **Step 1: Write integration test**

Append to `AlRunner.Tests/PipelineTests.cs`:

```csharp
    [Fact]
    public void IterationTracking_EmitsSourceFile()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("67-iteration-tracking", "src"), TestPath("67-iteration-tracking", "test") },
            OutputJson = true,
            IterationTracking = true,
        });

        Assert.Equal(0, result.ExitCode);
        Assert.NotNull(result.Iterations);
        Assert.True(result.Iterations!.Count > 0, "Expected at least one loop");

        // Parse the JSON output to verify sourceFile is present
        using var doc = System.Text.Json.JsonDocument.Parse(result.StdOut);
        var iterations = doc.RootElement.GetProperty("iterations");
        foreach (var iter in iterations.EnumerateArray())
        {
            Assert.True(iter.TryGetProperty("sourceFile", out var sf), "Expected sourceFile property on iteration");
            var sourceFile = sf.GetString()!;
            Assert.EndsWith(".al", sourceFile);
            // Loops are in src/LoopHelper.al, not test/LoopTest.al
            Assert.Contains("LoopHelper", sourceFile);
        }
    }
```

- [ ] **Step 2: Run the test**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test --filter "FullyQualifiedName~IterationTracking_EmitsSourceFile"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git add AlRunner.Tests/PipelineTests.cs
git commit -m "Add integration test: iteration JSON includes sourceFile"
```

---

## Task 6: Add sourceFile to ALchemist Types and Parser

**Files:**
- Modify: `src/iteration/types.ts:10-18, 20-28`
- Modify: `src/runner/outputParser.ts:191-193`

- [ ] **Step 1: Add sourceFile to IterationData interface**

In `src/iteration/types.ts`, add `sourceFile` after `loopId` in `IterationData` (line 11):

```typescript
export interface IterationData {
  loopId: string;
  sourceFile: string;
  loopLine: number;
```

- [ ] **Step 2: Add sourceFile to LoopInfo interface**

In `src/iteration/types.ts`, add `sourceFile` after `loopId` in `LoopInfo` (line 21):

```typescript
export interface LoopInfo {
  loopId: string;
  sourceFile: string;
  loopLine: number;
```

- [ ] **Step 3: Parse sourceFile in outputParser**

In `src/runner/outputParser.ts`, add `sourceFile` to the iteration mapping at line 192:

```typescript
  const iterations: IterationData[] = (data.iterations || []).map((iter: any) => ({
    loopId: iter.loopId,
    sourceFile: iter.sourceFile ?? '',
    loopLine: iter.loopLine,
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd U:/Git/ALchemist && npx tsc --noEmit`
Expected: Compilation errors in test files (they don't include `sourceFile` yet). The source files should compile. This is expected — we fix tests in Tasks 8 and 9.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/ALchemist
git add src/iteration/types.ts src/runner/outputParser.ts
git commit -m "Add sourceFile to IterationData and LoopInfo types, parse from runner JSON"
```

---

## Task 7: IterationStore Path Resolution + CodeLens Filtering

**Files:**
- Modify: `src/iteration/iterationStore.ts:1, 9-34`
- Modify: `src/iteration/iterationCodeLensProvider.ts:1-2, 21-29, 96-98, 137-155`
- Modify: `src/extension.ts:91`

- [ ] **Step 1: Update IterationStore.load() to accept workspacePath and resolve paths**

In `src/iteration/iterationStore.ts`, add path import at line 1:

```typescript
import * as path from 'path';
import { IterationData, IterationStep, LoopInfo, LoopChangeEvent } from './types';
```

Update the `load` method signature and body (lines 9-34). Change `load(iterations: IterationData[])` to:

```typescript
  load(iterations: IterationData[], workspacePath: string): void {
    this.loops.clear();
    for (const iter of iterations) {
      const steps: IterationStep[] = iter.steps.map((s) => ({
        iteration: s.iteration,
        capturedValues: new Map(s.capturedValues.map((cv) => [cv.variableName, cv.value])),
        messages: s.messages,
        linesExecuted: new Set(s.linesExecuted),
      }));

      const info: LoopInfo = {
        loopId: iter.loopId,
        sourceFile: path.resolve(workspacePath, iter.sourceFile),
        loopLine: iter.loopLine,
        loopEndLine: iter.loopEndLine,
        parentLoopId: iter.parentLoopId,
        parentIteration: iter.parentIteration,
        iterationCount: iter.iterationCount,
        currentIteration: 0,
      };

      this.loops.set(iter.loopId, { info, steps });
    }
    this.fire({ loopId: '', kind: 'loaded' });
  }
```

- [ ] **Step 2: Add path comparison helper and update buildCodeLenses**

In `src/iteration/iterationCodeLensProvider.ts`, add path import at line 1:

```typescript
import * as path from 'path';
import * as vscode from 'vscode';
```

Add the path comparison helper after the imports:

```typescript
function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}
```

Update `buildCodeLenses` signature (line 21) and add filtering (line 28):

```typescript
export function buildCodeLenses(store: IterationStore, documentPath: string): vscode.CodeLens[] {
  const loops = store.getLoops();
  const lenses: vscode.CodeLens[] = [];

  for (const loop of loops) {
    if (loop.iterationCount < 2) continue;
    if (!pathsEqual(loop.sourceFile, documentPath)) continue;

    const line = loop.loopLine - 1;
```

- [ ] **Step 3: Update provideCodeLenses to pass document path**

In `src/iteration/iterationCodeLensProvider.ts`, update `provideCodeLenses` (line 96):

```typescript
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return buildCodeLenses(this.store, document.uri.fsPath);
  }
```

- [ ] **Step 4: Update IterationStepperDecoration to filter by file**

In `src/iteration/iterationCodeLensProvider.ts`, update `applyTo` (starting at line 137):

```typescript
  applyTo(editor: vscode.TextEditor): void {
    const loops = this.store.getLoops();
    const decorations: vscode.DecorationOptions[] = [];
    const editorPath = editor.document.uri.fsPath;

    for (const loop of loops) {
      if (loop.iterationCount < 2) continue;
      if (!pathsEqual(loop.sourceFile, editorPath)) continue;

      const line = loop.loopLine - 1;
      if (line < 0 || line >= editor.document.lineCount) continue;

      const text = buildStepperText(this.store, loop.loopId);
      const range = editor.document.lineAt(line).range;
      decorations.push({
        range,
        renderOptions: {
          after: { contentText: `  ${text}` },
        },
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }
```

- [ ] **Step 5: Update extension.ts call site**

In `src/extension.ts`, update line 91 where `iterationStore.load` is called:

```typescript
        iterationStore.load(result.iterations, workspaceFolder?.uri.fsPath ?? '');
```

- [ ] **Step 6: Verify TypeScript compiles (ignoring test errors)**

Run: `cd U:/Git/ALchemist && npx tsc --noEmit 2>&1 | grep -v "test/"`
Expected: No errors from `src/` files

- [ ] **Step 7: Commit**

```bash
cd U:/Git/ALchemist
git add src/iteration/iterationStore.ts src/iteration/iterationCodeLensProvider.ts src/extension.ts
git commit -m "Filter CodeLens by document, resolve sourceFile at store load time"
```

---

## Task 8: Update ALchemist Test Fixtures

All existing test fixtures need `sourceFile` added to `IterationData` objects to compile.

**Files:**
- Modify: `test/suite/iterationStore.test.ts`
- Modify: `test/suite/iterationCodeLens.test.ts`
- Modify: `test/suite/iterationIntegration.test.ts`
- Modify: `test/suite/outputParser.test.ts`
- Modify: `test/suite/hoverProvider.test.ts`
- Modify: `test/suite/iterationDisplay.test.ts`
- Modify: `test/fixtures/test-al-runner-output.json`

- [ ] **Step 1: Update iterationStore.test.ts**

Add `sourceFile` to all `IterationData` objects.

In `makeSingleLoop()` (line 8), add `sourceFile`:

```typescript
    loopId: 'L0',
    sourceFile: 'src/Test.al',
    loopLine: 3,
```

In `makeNestedLoops()` — all three loop entries (lines 163, 172, 180):

```typescript
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 12,
```
```typescript
      loopId: 'L1-i1', sourceFile: 'src/Test.al', loopLine: 5, loopEndLine: 9,
```
```typescript
      loopId: 'L1-i2', sourceFile: 'src/Test.al', loopLine: 5, loopEndLine: 9,
```

In `getChangedValues detects unchanged variables` (line 234):

```typescript
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 1, loopEndLine: 5,
```

Update all `store.load(...)` calls to pass a workspace path:

Replace `store.load(makeSingleLoop())` with `store.load(makeSingleLoop(), '/ws')` (7 occurrences in the basic suite, 2 in events suite).

Replace `store.load(makeNestedLoops())` with `store.load(makeNestedLoops(), '/ws')` (3 occurrences).

Replace `store.load(data)` with `store.load(data, '/ws')` (1 occurrence in changed values).

- [ ] **Step 2: Update iterationCodeLens.test.ts**

In `makeSingleLoop()` (line 8), add `sourceFile`:

```typescript
    loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 10,
```

In the single-iteration loop test (line 37), add `sourceFile`:

```typescript
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 1, loopEndLine: 3,
```

Update all `store.load(...)` calls to pass `'/ws'`.

Update all `buildCodeLenses(store)` calls to pass a document path. Since `sourceFile` is `'src/Test.al'` and workspace is `'/ws'`, the resolved absolute path is `'/ws/src/Test.al'`:

Replace `buildCodeLenses(store)` with `buildCodeLenses(store, '/ws/src/Test.al')` (all occurrences).

- [ ] **Step 3: Update iterationIntegration.test.ts**

In the JSON fixture (line 15), add `sourceFile`:

```typescript
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 10,
```

Update `store.load(parsed.iterations)` at line 32 to `store.load(parsed.iterations, '/ws')`.

Update `buildCodeLenses(store)` calls at lines 53 and 61 to `buildCodeLenses(store, '/ws/src/Test.al')`.

In the backward-compatible test (line 79), update `store.load(parsed.iterations)` to `store.load(parsed.iterations, '/ws')`.

Update `buildCodeLenses(store)` at line 82 to `buildCodeLenses(store, '/ws/src/Test.al')`.

- [ ] **Step 4: Update outputParser.test.ts**

In the iterations test fixtures (lines 305, 336, 337), add `sourceFile`:

```typescript
        loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 10,
```
```typescript
        { loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 12, parentLoopId: null, parentIteration: null, iterationCount: 2, steps: [] },
        { loopId: 'L1', sourceFile: 'src/Test.al', loopLine: 5, loopEndLine: 9, parentLoopId: 'L0', parentIteration: 1, iterationCount: 4, steps: [] },
```

Add a sourceFile assertion at line 316:

```typescript
    assert.strictEqual(result.iterations[0].sourceFile, 'src/Test.al');
```

- [ ] **Step 5: Update hoverProvider.test.ts**

In `makeLoopData()` (line 46), add `sourceFile`:

```typescript
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 10, loopEndLine: 11,
```

Update all `store.load(makeLoopData())` calls to `store.load(makeLoopData(), '/ws')`.

- [ ] **Step 6: Update iterationDisplay.test.ts**

In `makeRealLoopData()` (line 24), add `sourceFile`:

```typescript
    loopId: 'L0',
    sourceFile: 'src/Test.al',
    loopLine: 10,
```

Update all `store.load(makeRealLoopData())` calls to `store.load(makeRealLoopData(), '/ws')`.

- [ ] **Step 7: Update test fixture JSON**

In `test/fixtures/test-al-runner-output.json`, add `sourceFile` after `loopId` (line 90):

```json
      "loopId": "L0",
      "sourceFile": "src/Test.al",
      "loopLine": 11,
```

- [ ] **Step 8: Run all tests**

Run: `cd U:/Git/ALchemist && npm test`
Expected: All existing tests pass

- [ ] **Step 9: Commit**

```bash
cd U:/Git/ALchemist
git add test/suite/iterationStore.test.ts test/suite/iterationCodeLens.test.ts test/suite/iterationIntegration.test.ts test/suite/outputParser.test.ts test/suite/hoverProvider.test.ts test/suite/iterationDisplay.test.ts test/fixtures/test-al-runner-output.json
git commit -m "Update all test fixtures with sourceFile field"
```

---

## Task 9: New ALchemist Tests for Filtering and Path Resolution

**Files:**
- Modify: `test/suite/iterationCodeLens.test.ts`
- Modify: `test/suite/iterationStore.test.ts`

- [ ] **Step 1: Write CodeLens filtering tests**

Append to `test/suite/iterationCodeLens.test.ts`, inside the existing suite:

```typescript
  test('filters lenses by document path — matching file', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), '/ws');
    const lenses = buildCodeLenses(store, '/ws/src/Test.al');
    assert.ok(lenses.length >= 3);
  });

  test('filters lenses by document path — non-matching file', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), '/ws');
    const lenses = buildCodeLenses(store, '/ws/src/Other.al');
    assert.strictEqual(lenses.length, 0);
  });

  test('multiple loops from different files — only matching rendered', () => {
    const store = new IterationStore();
    const data: IterationData[] = [
      {
        loopId: 'L0', sourceFile: 'src/FileA.al', loopLine: 3, loopEndLine: 10,
        parentLoopId: null, parentIteration: null, iterationCount: 3,
        steps: [
          { iteration: 1, capturedValues: [], messages: [], linesExecuted: [3] },
          { iteration: 2, capturedValues: [], messages: [], linesExecuted: [3] },
          { iteration: 3, capturedValues: [], messages: [], linesExecuted: [3] },
        ],
      },
      {
        loopId: 'L1', sourceFile: 'src/FileB.al', loopLine: 5, loopEndLine: 8,
        parentLoopId: null, parentIteration: null, iterationCount: 2,
        steps: [
          { iteration: 1, capturedValues: [], messages: [], linesExecuted: [5] },
          { iteration: 2, capturedValues: [], messages: [], linesExecuted: [5] },
        ],
      },
    ];
    store.load(data, '/ws');
    const lensesA = buildCodeLenses(store, '/ws/src/FileA.al');
    const lensesB = buildCodeLenses(store, '/ws/src/FileB.al');
    assert.ok(lensesA.length > 0, 'Expected lenses for FileA');
    assert.ok(lensesB.length > 0, 'Expected lenses for FileB');
    // Verify they point to different lines
    assert.strictEqual(lensesA[0].range.start.line, 2); // loopLine 3 → 0-indexed 2
    assert.strictEqual(lensesB[0].range.start.line, 4); // loopLine 5 → 0-indexed 4
  });
```

- [ ] **Step 2: Write store path resolution tests**

Append to `test/suite/iterationStore.test.ts`, inside the main `IterationStore` suite:

```typescript
  test('load resolves sourceFile to absolute path', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), '/workspace');
    const loop = store.getLoop('L0');
    // path.resolve('/workspace', 'src/Test.al') produces an absolute path
    assert.ok(loop.sourceFile.includes('Test.al'));
    assert.ok(require('path').isAbsolute(loop.sourceFile));
  });

  test('getLoops returns resolved absolute sourceFile', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), '/workspace');
    const loops = store.getLoops();
    assert.ok(require('path').isAbsolute(loops[0].sourceFile));
  });
```

- [ ] **Step 3: Run all tests**

Run: `cd U:/Git/ALchemist && npm test`
Expected: All tests pass including new filtering tests

- [ ] **Step 4: Commit**

```bash
cd U:/Git/ALchemist
git add test/suite/iterationCodeLens.test.ts test/suite/iterationStore.test.ts
git commit -m "Add tests for CodeLens document filtering and store path resolution"
```

---

## Task 10: End-to-End Verification

- [ ] **Step 1: Run full AL.Runner test suite**

Run: `cd U:\Git\BusinessCentral.AL.Runner && dotnet test`
Expected: All tests pass

- [ ] **Step 2: Run full ALchemist test suite**

Run: `cd U:/Git/ALchemist && npm test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test**

1. Open a multi-file AL project in VS Code with ALchemist
2. Run a test where the loop is in a helper codeunit (not the test file)
3. Verify: CodeLens appears on the helper file at the loop line, NOT on the test file
4. Open the test file — verify no CodeLens appears there
