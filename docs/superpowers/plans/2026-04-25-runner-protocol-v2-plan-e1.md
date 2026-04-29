# Plan E1 — AL.Runner Protocol v2 (Fork Branch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fork branch of AL.Runner (`feat/alchemist-protocol-v1`) implementing protocol v2: `#line` directives in transpile output, structured stack frames, error categorization, JSON coverage, per-test isolation, NDJSON streaming, cancel command, protocolVersion field. Demoable end-to-end via manual JSON-RPC against a built fork binary.

**Architecture:** Five new pure modules (StackFrameMapper, ErrorClassifier, CoverageReport.ToJson, TestFilter, JSON Schema) plus targeted edits to Pipeline/Executor/Server. `#line` directive injection is the foundational primitive; every other feature builds on standard .NET stack-trace machinery now seeing `.al` filenames natively. NDJSON streaming bumps protocol version to 2; v1 clients (no streaming) detect via summary field absence.

**Tech Stack:** C# .NET 8/9, xUnit (existing test infra), Roslyn (CSharpSyntaxTree, sequence points), JSON Schema for cross-repo protocol validation. Existing AL.Runner pipeline patterns preserved.

**Spec reference:** `docs/superpowers/specs/2026-04-25-runner-protocol-v2-design.md` (Plan E1 covers AL.Runner side; Plan E2 covers ALchemist consumption; Plan E3 covers verification + upstream PRs).

---

## File Structure

**New files:**
- `AlRunner/StackFrameMapper.cs` — pure: `Exception` → `List<AlStackFrame>`
- `AlRunner/ErrorClassifier.cs` — pure: `Exception + ctx` → `AlErrorKind`
- `AlRunner/AlStackFrame.cs` — record types `AlStackFrame`, enum `FramePresentationHint`, enum `AlErrorKind`
- `AlRunner/TestFilter.cs` — record `TestFilter(IReadOnlySet<string>?, IReadOnlySet<string>?)`
- `AlRunner.Tests/StackFrameMapperTests.cs`
- `AlRunner.Tests/ErrorClassifierTests.cs`
- `AlRunner.Tests/CoverageReportToJsonTests.cs`
- `AlRunner.Tests/LineDirectiveEmissionTests.cs`
- `AlRunner.Tests/RunTestsFilteringTests.cs`
- `AlRunner.Tests/RunTestsStreamingTests.cs`
- `AlRunner.Tests/ServerProtocolV2Tests.cs`
- `protocol-v2.schema.json` — cross-repo JSON Schema for response shape

**Modified files:**
- `AlRunner/Pipeline.cs` — transpiler emits `#line` directives; `ShowCoverage` path emits structured JSON
- `AlRunner/CoverageReport.cs` — new `ToJson()` method
- `AlRunner/Executor.cs` — `RunTests` gains `TestFilter`, `onTestComplete` callback, AsyncLocal-isolated per-test capture
- `AlRunner/Server.cs` — `ServerRequest` adds `testFilter`/`coverage`/`cobertura`/`protocolVersion`; new `cancel` command; revised `SerializeServerResponse` (field parity + DAP stackFrames + structured coverage); NDJSON streaming via callback in HandleRunTests; protocolVersion: 2 in summary
- `AlRunner.Tests/AlRunner.Tests.csproj` — add Newtonsoft.Json.Schema package for JSON schema validation in tests

**Test fixtures (existing tests directory):**
- `tests/protocol-v2-line-directives/src/Foo.al` — small AL file with traceable line numbers
- `tests/protocol-v2-line-directives/test/FooTest.Codeunit.al` — failing test that exercises stack-frame walking
- `tests/protocol-v2-coverage/src/Lib.Codeunit.al` — with multiple statements per line
- `tests/protocol-v2-coverage/test/LibTest.Codeunit.al`

---

## Task 1: Setup worktree + verify baseline

**Files:** none modified.

- [ ] **Step 1: Create worktree on feature branch**

```bash
cd U:/Git/BusinessCentral.AL.Runner
git fetch fork
git fetch origin
git worktree add U:/Git/AL.Runner-protocol-v2 -b feat/alchemist-protocol-v1 fork/main
cd U:/Git/AL.Runner-protocol-v2
```

If `fork/main` doesn't exist, use `origin/main` as base. The branch name must be `feat/alchemist-protocol-v1` to match the spec's published expectation.

- [ ] **Step 2: Restore + build baseline**

```bash
dotnet restore
dotnet build AlRunner.slnx --configuration Debug
```

Expected: build succeeds. Note any preexisting warnings — they're not from us.

- [ ] **Step 3: Run existing test suite**

```bash
dotnet test AlRunner.Tests --configuration Debug --no-restore
```

Expected: all tests pass. Record the count (likely several dozen). All future steps must keep this baseline green.

- [ ] **Step 4: Commit branch initialization marker**

No code changes; just confirm clean state:

```bash
git log --oneline -3
git status
```

If `git status` is clean, branch is ready. If untracked files exist (e.g., from the parent worktree's `publish-debug/`), inspect and gitignore as appropriate but don't commit yet.

---

## Task 2: protocol-v2.schema.json (foundation for cross-repo validation)

**Files:**
- Create: `protocol-v2.schema.json` (repo root)

**Context:** Single source of truth for the v2 response shape. ALchemist's tests will validate response samples against this. Living document — this task locks the initial shape; later tasks update the schema as fields are added.

- [ ] **Step 1: Create initial schema with shared types**

```bash
cat > protocol-v2.schema.json <<'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/StefanMaron/BusinessCentral.AL.Runner/schemas/protocol-v2.json",
  "title": "AL.Runner Server Protocol v2",
  "description": "Newline-delimited JSON. A `runtests` request emits zero or more `test` lines, optional `progress` lines, then exactly one `summary` line. Each line is a separate JSON document.",
  "definitions": {
    "AlStackFrame": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string" },
        "source": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "name": { "type": "string" }
          }
        },
        "line": { "type": "integer", "minimum": 1 },
        "column": { "type": "integer", "minimum": 1 },
        "presentationHint": {
          "type": "string",
          "enum": ["normal", "subtle", "deemphasize", "label"]
        }
      }
    },
    "ErrorKind": {
      "type": "string",
      "enum": ["assertion", "runtime", "compile", "setup", "timeout", "unknown"]
    },
    "TestEvent": {
      "type": "object",
      "required": ["type", "name", "status"],
      "properties": {
        "type": { "const": "test" },
        "name": { "type": "string" },
        "status": { "enum": ["pass", "fail", "error"] },
        "durationMs": { "type": "integer", "minimum": 0 },
        "message": { "type": "string" },
        "errorKind": { "$ref": "#/definitions/ErrorKind" },
        "alSourceFile": { "type": "string" },
        "alSourceLine": { "type": "integer", "minimum": 1 },
        "alSourceColumn": { "type": "integer", "minimum": 1 },
        "stackFrames": {
          "type": "array",
          "items": { "$ref": "#/definitions/AlStackFrame" }
        },
        "stackTrace": { "type": "string" },
        "messages": {
          "type": "array",
          "items": { "type": "string" }
        },
        "capturedValues": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "scopeName": { "type": "string" },
              "variableName": { "type": "string" },
              "value": {},
              "statementId": { "type": "integer" }
            }
          }
        }
      }
    },
    "FileCoverage": {
      "type": "object",
      "required": ["file", "lines", "totalStatements", "hitStatements"],
      "properties": {
        "file": { "type": "string" },
        "lines": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["line", "hits"],
            "properties": {
              "line": { "type": "integer", "minimum": 1 },
              "hits": { "type": "integer", "minimum": 0 }
            }
          }
        },
        "totalStatements": { "type": "integer", "minimum": 0 },
        "hitStatements": { "type": "integer", "minimum": 0 }
      }
    },
    "Summary": {
      "type": "object",
      "required": ["type", "exitCode", "passed", "failed", "errors", "total", "protocolVersion"],
      "properties": {
        "type": { "const": "summary" },
        "exitCode": { "type": "integer" },
        "passed": { "type": "integer", "minimum": 0 },
        "failed": { "type": "integer", "minimum": 0 },
        "errors": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 },
        "cached": { "type": "boolean" },
        "cancelled": { "type": "boolean" },
        "changedFiles": {
          "type": "array",
          "items": { "type": "string" }
        },
        "compilationErrors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "file": { "type": "string" },
              "errors": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          }
        },
        "coverage": {
          "type": "array",
          "items": { "$ref": "#/definitions/FileCoverage" }
        },
        "protocolVersion": { "const": 2 }
      }
    },
    "Ack": {
      "type": "object",
      "required": ["type", "command"],
      "properties": {
        "type": { "const": "ack" },
        "command": { "type": "string" },
        "noop": { "type": "boolean" }
      }
    },
    "Progress": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "const": "progress" },
        "completed": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 }
      }
    }
  },
  "oneOf": [
    { "$ref": "#/definitions/TestEvent" },
    { "$ref": "#/definitions/Summary" },
    { "$ref": "#/definitions/Ack" },
    { "$ref": "#/definitions/Progress" }
  ]
}
EOF
```

- [ ] **Step 2: Commit**

```bash
git add protocol-v2.schema.json
git commit -m "feat(protocol): add protocol-v2.schema.json — shared type definitions for AL.Runner ↔ ALchemist"
```

---

## Task 3: AlStackFrame, AlErrorKind, FramePresentationHint, TestFilter types

**Files:**
- Create: `AlRunner/AlStackFrame.cs`
- Create: `AlRunner/TestFilter.cs`

**Context:** Pure value types used by all later modules. Define them first so subsequent tasks have stable contract.

- [ ] **Step 1: Write `AlRunner/AlStackFrame.cs`**

```csharp
namespace AlRunner;

public enum FramePresentationHint
{
    Normal,
    Subtle,
    Deemphasize,
    Label
}

public enum AlErrorKind
{
    Assertion,
    Runtime,
    Compile,
    Setup,
    Timeout,
    Unknown
}

public record AlStackFrame(
    string? File,
    int? Line,
    int? Column,
    bool IsUserCode,
    string? Name,
    FramePresentationHint Hint
);
```

- [ ] **Step 2: Write `AlRunner/TestFilter.cs`**

```csharp
namespace AlRunner;

/// <summary>
/// Filter passed to <see cref="Executor.RunTests"/> to limit which tests execute.
/// Both fields are optional; nulls = no constraint.
/// When both are set, a test must match both filters (AND).
/// </summary>
public record TestFilter(
    IReadOnlySet<string>? CodeunitNames,
    IReadOnlySet<string>? ProcNames
);
```

- [ ] **Step 3: Build to verify compilation**

```bash
dotnet build AlRunner --configuration Debug
```

Expected: builds clean. No tests yet for these types — they're pure data; tests in following tasks exercise them indirectly.

- [ ] **Step 4: Commit**

```bash
git add AlRunner/AlStackFrame.cs AlRunner/TestFilter.cs
git commit -m "feat(types): add AlStackFrame, AlErrorKind, FramePresentationHint, TestFilter records"
```

---

## Task 4: StackFrameMapper

**Files:**
- Create: `AlRunner/StackFrameMapper.cs`
- Create: `AlRunner.Tests/StackFrameMapperTests.cs`

**Context:** Pure module: walk an `Exception.StackTrace` text, parse each frame, classify into `AlStackFrame` records. Filename ending in `.al` indicates user code (post `#line` directive injection). Type-based heuristics dim BC runtime frames.

The standard managed StackTrace format is:

```
   at Namespace.Class.Method(Args) in path/to/file.cs:line 42
   at Namespace.Class.Method(Args) in path/to/file.al:line 17
   at Namespace.Class.Method(Args)        // no source info
```

- [ ] **Step 1: Add failing tests**

Create `AlRunner.Tests/StackFrameMapperTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

public class StackFrameMapperTests
{
    [Fact]
    public void Walk_ParsesAlFilenames_AsUserCode()
    {
        var trace = "   at Foo.Bar.RunTest() in src/Foo.al:line 42\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        Assert.Single(frames);
        Assert.Equal("src/Foo.al", frames[0].File);
        Assert.Equal(42, frames[0].Line);
        Assert.True(frames[0].IsUserCode);
        Assert.Equal(FramePresentationHint.Normal, frames[0].Hint);
    }

    [Fact]
    public void Walk_DimsRuntimeFrames()
    {
        var trace = "   at AlRunner.Runtime.MockRecord.Insert() in mock.cs:line 15\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        Assert.Single(frames);
        Assert.False(frames[0].IsUserCode);
        Assert.Equal(FramePresentationHint.Subtle, frames[0].Hint);
    }

    [Fact]
    public void Walk_HandlesUnknownFrames()
    {
        var trace = "   at SomeMethod()\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        Assert.Single(frames);
        Assert.Null(frames[0].File);
        Assert.Null(frames[0].Line);
        Assert.False(frames[0].IsUserCode);
    }

    [Fact]
    public void FindDeepestUserFrame_ReturnsLastUserFrame()
    {
        var trace =
            "   at AlRunner.Runtime.MockRecord.Insert() in mock.cs:line 5\n" +
            "   at MainApp.AlertEngine.New() in src/AlertEngine.Codeunit.al:line 30\n" +
            "   at AlRunner.Runtime.MockCodeunit.Invoke() in mock2.cs:line 10\n" +
            "   at MainApp.Tests.NewReturnsTrue() in test/AlertEngineTest.al:line 17\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        var deepest = StackFrameMapper.FindDeepestUserFrame(frames);
        Assert.NotNull(deepest);
        Assert.Equal("test/AlertEngineTest.al", deepest!.File);
        Assert.Equal(17, deepest.Line);
    }

    [Fact]
    public void FindDeepestUserFrame_NoUserFrames_ReturnsNull()
    {
        var trace = "   at AlRunner.Runtime.MockRecord.Insert() in mock.cs:line 5\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        Assert.Null(StackFrameMapper.FindDeepestUserFrame(frames));
    }

    [Fact]
    public void Walk_EmptyOrNullStackTrace_ReturnsEmptyList()
    {
        var ex = new InvalidOperationException("test");
        var frames = StackFrameMapper.Walk(ex);
        // .NET fills StackTrace when exception is thrown, but a freshly-constructed
        // exception has null StackTrace. Walker should handle gracefully.
        Assert.NotNull(frames);
    }

    [Fact]
    public void Walk_QuotedPathsWithSpaces()
    {
        var trace = "   at Foo.Bar() in src/Some Folder/Customer Score.Codeunit.al:line 99\n";
        var ex = MakeExceptionWithStackTrace(trace);
        var frames = StackFrameMapper.Walk(ex);
        Assert.Single(frames);
        Assert.Equal("src/Some Folder/Customer Score.Codeunit.al", frames[0].File);
        Assert.Equal(99, frames[0].Line);
    }

    [Fact]
    public void ClassifyHint_MockTypeIsSubtle()
    {
        Assert.Equal(FramePresentationHint.Subtle,
            StackFrameMapper.ClassifyHint("mock.cs", "AlRunner.Runtime.MockRecord.Insert"));
    }

    [Fact]
    public void ClassifyHint_MicrosoftDynamicsIsSubtle()
    {
        Assert.Equal(FramePresentationHint.Subtle,
            StackFrameMapper.ClassifyHint("nav.cs", "Microsoft.Dynamics.Nav.Some.Method"));
    }

    [Fact]
    public void ClassifyHint_UserCodeIsNormal()
    {
        Assert.Equal(FramePresentationHint.Normal,
            StackFrameMapper.ClassifyHint("src/Foo.al", "MainApp.Foo.Method"));
    }

    [Fact]
    public void ClassifyHint_UnknownDeemphasize()
    {
        Assert.Equal(FramePresentationHint.Deemphasize,
            StackFrameMapper.ClassifyHint(null, null));
    }

    /// <summary>
    /// Helper: wrap a stack-trace string into an Exception whose StackTrace property returns it.
    /// We use a custom class because Exception.StackTrace is computed at throw time.
    /// </summary>
    private static Exception MakeExceptionWithStackTrace(string trace)
        => new ExceptionWithFakeStackTrace(trace);

    private sealed class ExceptionWithFakeStackTrace : Exception
    {
        private readonly string _trace;
        public ExceptionWithFakeStackTrace(string trace) : base("fake") => _trace = trace;
        public override string? StackTrace => _trace;
    }
}
```

- [ ] **Step 2: Run tests — confirm failures**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~StackFrameMapperTests" --no-restore
```

Expected: compile error referring to `StackFrameMapper` not defined.

- [ ] **Step 3: Implement `AlRunner/StackFrameMapper.cs`**

```csharp
using System.Text.RegularExpressions;

namespace AlRunner;

public static class StackFrameMapper
{
    // Matches "   at Namespace.Class.Method(args) in path/to/file.al:line 42"
    // Captures: 1=method name, 2=file path, 3=line number
    private static readonly Regex FrameWithSource = new Regex(
        @"^\s*at\s+(?<method>[^\s][^()]*)(?:\([^)]*\))?\s+in\s+(?<file>.+?):line\s+(?<line>\d+)\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    // Matches "   at Namespace.Class.Method(args)" without source info.
    private static readonly Regex FrameNoSource = new Regex(
        @"^\s*at\s+(?<method>[^\s][^()]*)(?:\([^)]*\))?\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    public static List<AlStackFrame> Walk(Exception ex)
    {
        var result = new List<AlStackFrame>();
        var trace = ex.StackTrace;
        if (string.IsNullOrEmpty(trace)) return result;

        var lines = trace.Split('\n');
        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line)) continue;

            var withSource = FrameWithSource.Match(line);
            if (withSource.Success)
            {
                var file = withSource.Groups["file"].Value.Trim();
                var lineNum = int.Parse(withSource.Groups["line"].Value);
                var method = withSource.Groups["method"].Value.Trim();
                var isUser = file.EndsWith(".al", StringComparison.OrdinalIgnoreCase);
                var hint = isUser ? FramePresentationHint.Normal : ClassifyHint(file, method);
                result.Add(new AlStackFrame(
                    File: file,
                    Line: lineNum,
                    Column: null,
                    IsUserCode: isUser,
                    Name: method,
                    Hint: hint));
                continue;
            }

            var noSource = FrameNoSource.Match(line);
            if (noSource.Success)
            {
                var method = noSource.Groups["method"].Value.Trim();
                result.Add(new AlStackFrame(
                    File: null,
                    Line: null,
                    Column: null,
                    IsUserCode: false,
                    Name: method,
                    Hint: ClassifyHint(null, method)));
            }
        }

        return result;
    }

    public static AlStackFrame? FindDeepestUserFrame(IReadOnlyList<AlStackFrame> frames)
    {
        // The .NET stack-trace order is: deepest call first → outermost caller last.
        // So the first user-code frame in the list IS the deepest user frame.
        // (Many docs talk about "last frame" because they mean "last to be added",
        // which is the same as "first in the trace string".)
        for (var i = 0; i < frames.Count; i++)
        {
            if (frames[i].IsUserCode) return frames[i];
        }
        return null;
    }

    public static FramePresentationHint ClassifyHint(string? file, string? methodName)
    {
        // User code (.al filename) is always Normal.
        if (file != null && file.EndsWith(".al", StringComparison.OrdinalIgnoreCase))
            return FramePresentationHint.Normal;

        if (methodName != null)
        {
            if (methodName.StartsWith("AlRunner.Runtime.", StringComparison.Ordinal)
                || methodName.StartsWith("AlRunner.Runtime", StringComparison.Ordinal)
                || methodName.Contains(".Mock", StringComparison.Ordinal)
                || methodName.StartsWith("Mock", StringComparison.Ordinal)
                || methodName.StartsWith("AlScope", StringComparison.Ordinal)
                || methodName.StartsWith("Microsoft.Dynamics.", StringComparison.Ordinal))
            {
                return FramePresentationHint.Subtle;
            }
        }

        return FramePresentationHint.Deemphasize;
    }
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~StackFrameMapperTests" --no-restore
```

Expected: 11 tests pass.

- [ ] **Step 5: Run full suite for regression check**

```bash
dotnet test AlRunner.Tests --no-restore
```

Expected: baseline + 11 new tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add AlRunner/StackFrameMapper.cs AlRunner.Tests/StackFrameMapperTests.cs
git commit -m "feat(runtime): add StackFrameMapper — Exception → structured AlStackFrame[]"
```

---

## Task 5: ErrorClassifier

**Files:**
- Create: `AlRunner/ErrorClassifier.cs`
- Create: `AlRunner.Tests/ErrorClassifierTests.cs`

**Context:** Pure module: classify an `Exception` into one of `AlErrorKind` based on type + execution context. Drives ALchemist's per-error-class UI.

The `TestExecutionContext` parameter signals "are we inside a test procedure?" — which distinguishes setup failures (in `[OnRun]` before any `[Test]`) from runtime failures during a test.

For now, `TestExecutionContext` carries one boolean `InsideTestProc`. Will be expanded in Task 7 when AsyncLocal isolation is added.

- [ ] **Step 1: Write failing tests**

Create `AlRunner.Tests/ErrorClassifierTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

public class ErrorClassifierTests
{
    [Fact]
    public void Classify_AssertionException_IsAssertion()
    {
        // The AlRunner.Runtime.MockAssert.AssertionException class — match on type name suffix.
        var ex = new MockAssertException("expected 1 got 2");
        var ctx = new TestExecutionContext(InsideTestProc: true);
        Assert.Equal(AlErrorKind.Assertion, ErrorClassifier.Classify(ex, ctx));
    }

    [Fact]
    public void Classify_OperationCanceled_IsTimeout()
    {
        var ex = new OperationCanceledException("test exceeded timeout");
        var ctx = new TestExecutionContext(InsideTestProc: true);
        Assert.Equal(AlErrorKind.Timeout, ErrorClassifier.Classify(ex, ctx));
    }

    [Fact]
    public void Classify_CompilationFailedException_IsCompile()
    {
        var ex = new CompilationFailedExceptionStub("compile error");
        var ctx = new TestExecutionContext(InsideTestProc: true);
        Assert.Equal(AlErrorKind.Compile, ErrorClassifier.Classify(ex, ctx));
    }

    [Fact]
    public void Classify_GenericException_DuringSetup_IsSetup()
    {
        var ex = new InvalidOperationException("setup failed");
        var ctx = new TestExecutionContext(InsideTestProc: false);
        Assert.Equal(AlErrorKind.Setup, ErrorClassifier.Classify(ex, ctx));
    }

    [Fact]
    public void Classify_GenericException_DuringTest_IsRuntime()
    {
        var ex = new InvalidOperationException("runtime error");
        var ctx = new TestExecutionContext(InsideTestProc: true);
        Assert.Equal(AlErrorKind.Runtime, ErrorClassifier.Classify(ex, ctx));
    }

    [Fact]
    public void Classify_NullException_IsUnknown()
    {
        var ctx = new TestExecutionContext(InsideTestProc: true);
        Assert.Equal(AlErrorKind.Unknown, ErrorClassifier.Classify(null!, ctx));
    }

    private sealed class MockAssertException : Exception
    {
        public MockAssertException(string m) : base(m) { }
    }

    private sealed class CompilationFailedExceptionStub : Exception
    {
        public CompilationFailedExceptionStub(string m) : base(m) { }
    }
}
```

- [ ] **Step 2: Implement `AlRunner/ErrorClassifier.cs`**

```csharp
namespace AlRunner;

public record TestExecutionContext(bool InsideTestProc);

public static class ErrorClassifier
{
    public static AlErrorKind Classify(Exception ex, TestExecutionContext ctx)
    {
        if (ex == null) return AlErrorKind.Unknown;

        // Assertion: AlRunner.Runtime.MockAssert throws subclasses with "AssertException"
        // or "AssertionException" in the type name. Match on suffix to avoid hard
        // coupling to the runtime's exact type identity.
        var typeName = ex.GetType().Name;
        if (typeName.Contains("AssertException", StringComparison.Ordinal)
            || typeName.Contains("AssertionException", StringComparison.Ordinal)
            || typeName.Contains("MockAssert", StringComparison.Ordinal))
        {
            return AlErrorKind.Assertion;
        }

        // Timeout: cancellation thrown by the cooperative timeout mechanism.
        if (ex is OperationCanceledException) return AlErrorKind.Timeout;

        // Compile errors thrown by the Roslyn pipeline are wrapped in a custom
        // CompilationFailedException type. Match on suffix again.
        if (typeName.Contains("CompilationFailed", StringComparison.Ordinal)
            || typeName.Contains("CompileError", StringComparison.Ordinal))
        {
            return AlErrorKind.Compile;
        }

        // Anything thrown before we entered a [Test] proc is a setup/init failure.
        if (!ctx.InsideTestProc) return AlErrorKind.Setup;

        return AlErrorKind.Runtime;
    }
}
```

- [ ] **Step 3: Run tests — verify pass**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~ErrorClassifierTests" --no-restore
```

Expected: 6 tests pass.

- [ ] **Step 4: Run full suite**

```bash
dotnet test AlRunner.Tests --no-restore
```

- [ ] **Step 5: Commit**

```bash
git add AlRunner/ErrorClassifier.cs AlRunner.Tests/ErrorClassifierTests.cs
git commit -m "feat(runtime): add ErrorClassifier — Exception → AlErrorKind heuristics"
```

---

## Task 6: CoverageReport.ToJson

**Files:**
- Modify: `AlRunner/CoverageReport.cs`
- Create: `AlRunner.Tests/CoverageReportToJsonTests.cs`

**Context:** Add `ToJson()` to existing `CoverageReport` class. Returns structured `List<FileCoverage>` for inline emission in the runtests response.

- [ ] **Step 1: Read current `CoverageReport.cs` to understand existing types**

```bash
grep -n "class CoverageReport\|public.*record\|public.*struct\|SourceSpan\|hitStmts\|totalStmts" AlRunner/CoverageReport.cs | head -30
```

Note the existing types (likely `SourceSpan`, internal hit-tracking dictionaries). The new `ToJson` reuses them.

- [ ] **Step 2: Write failing tests**

Create `AlRunner.Tests/CoverageReportToJsonTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

public class CoverageReportToJsonTests
{
    [Fact]
    public void ToJson_BuildsFileEntries()
    {
        var sourceSpans = new Dictionary<string, List<SourceSpan>>
        {
            ["src/Foo.al"] = new()
            {
                new SourceSpan { Line = 10, StatementId = 1 },
                new SourceSpan { Line = 11, StatementId = 2 },
            },
            ["src/Bar.al"] = new()
            {
                new SourceSpan { Line = 5, StatementId = 3 },
            },
        };
        var hit = new HashSet<int> { 1, 3 };
        var total = new HashSet<int> { 1, 2, 3 };
        var scopeToObject = new Dictionary<int, string>();

        var result = CoverageReport.ToJson(sourceSpans, hit, total, scopeToObject);

        Assert.Equal(2, result.Count);
        var foo = result.First(f => f.File == "src/Foo.al");
        Assert.Equal(2, foo.TotalStatements);
        Assert.Equal(1, foo.HitStatements);
        Assert.Equal(2, foo.Lines.Count);
        Assert.Equal(1, foo.Lines.First(l => l.Line == 10).Hits);
        Assert.Equal(0, foo.Lines.First(l => l.Line == 11).Hits);
    }

    [Fact]
    public void ToJson_LineDeduplication()
    {
        var sourceSpans = new Dictionary<string, List<SourceSpan>>
        {
            ["src/Foo.al"] = new()
            {
                new SourceSpan { Line = 10, StatementId = 1 },
                new SourceSpan { Line = 10, StatementId = 2 },  // same line
                new SourceSpan { Line = 11, StatementId = 3 },
            },
        };
        var hit = new HashSet<int> { 1, 2 };
        var total = new HashSet<int> { 1, 2, 3 };

        var result = CoverageReport.ToJson(sourceSpans, hit, total, new Dictionary<int, string>());

        var foo = result.Single();
        Assert.Equal(2, foo.Lines.Count);
        // Line 10 has hits=2 (both statements hit)
        Assert.Equal(2, foo.Lines.First(l => l.Line == 10).Hits);
        Assert.Equal(0, foo.Lines.First(l => l.Line == 11).Hits);
    }

    [Fact]
    public void ToJson_NoHits_AllLinesPresentWithZero()
    {
        var sourceSpans = new Dictionary<string, List<SourceSpan>>
        {
            ["src/Foo.al"] = new() { new SourceSpan { Line = 1, StatementId = 1 } },
        };
        var hit = new HashSet<int>();
        var total = new HashSet<int> { 1 };

        var result = CoverageReport.ToJson(sourceSpans, hit, total, new Dictionary<int, string>());

        var foo = result.Single();
        Assert.Equal(0, foo.HitStatements);
        Assert.Equal(0, foo.Lines.Single().Hits);
    }

    [Fact]
    public void ToJson_EmptyInput_EmptyOutput()
    {
        var result = CoverageReport.ToJson(
            new Dictionary<string, List<SourceSpan>>(),
            new HashSet<int>(),
            new HashSet<int>(),
            new Dictionary<int, string>());
        Assert.Empty(result);
    }
}
```

If `SourceSpan` has a different shape (constructor or property names) than the test assumes, adapt the test. Read `CoverageReport.cs` first.

- [ ] **Step 3: Add records to `CoverageReport.cs`**

At the bottom of `AlRunner/CoverageReport.cs` (or in a new region inside the existing class):

```csharp
public record FileCoverage(
    string File,
    List<LineCoverage> Lines,
    int TotalStatements,
    int HitStatements
);

public record LineCoverage(int Line, int Hits);
```

- [ ] **Step 4: Implement `ToJson()` static method on `CoverageReport`**

Add inside the existing `CoverageReport` class:

```csharp
public static List<FileCoverage> ToJson(
    IDictionary<string, List<SourceSpan>> sourceSpans,
    ISet<int> hitStmts,
    ISet<int> totalStmts,
    IDictionary<int, string> scopeToObject)
{
    var result = new List<FileCoverage>();
    foreach (var (file, spans) in sourceSpans)
    {
        // Group statements per line, sum hit counts per line.
        var perLine = new Dictionary<int, int>();
        var fileTotalStatements = 0;
        var fileHitStatements = 0;

        foreach (var span in spans)
        {
            // SourceSpan must have a Line and a StatementId.
            // If the actual property names differ, adapt here.
            if (!perLine.ContainsKey(span.Line))
            {
                perLine[span.Line] = 0;
            }
            if (totalStmts.Contains(span.StatementId))
            {
                fileTotalStatements++;
                if (hitStmts.Contains(span.StatementId))
                {
                    perLine[span.Line]++;
                    fileHitStatements++;
                }
            }
        }

        var lineList = perLine
            .OrderBy(kvp => kvp.Key)
            .Select(kvp => new LineCoverage(kvp.Key, kvp.Value))
            .ToList();

        result.Add(new FileCoverage(file, lineList, fileTotalStatements, fileHitStatements));
    }
    return result;
}
```

If `SourceSpan` has different property names (e.g., `LineNumber` instead of `Line`), adjust accordingly — the tests will catch the mismatch.

- [ ] **Step 5: Run tests — verify pass**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~CoverageReportToJsonTests" --no-restore
```

Expected: 4 tests pass. If a test fails because of `SourceSpan` shape mismatch: read the actual struct, adjust both the test data and `ToJson` body.

- [ ] **Step 6: Run full suite + commit**

```bash
dotnet test AlRunner.Tests --no-restore
git add AlRunner/CoverageReport.cs AlRunner.Tests/CoverageReportToJsonTests.cs
git commit -m "feat(coverage): add CoverageReport.ToJson — structured FileCoverage[] for inline emission"
```

---

## Task 7: `#line` directive injection in transpiler

**Files:**
- Modify: `AlRunner/Pipeline.cs` (or wherever C# emission occurs)
- Create: `AlRunner.Tests/LineDirectiveEmissionTests.cs`
- Create: `tests/protocol-v2-line-directives/` fixture directory

**Context:** This is the foundational primitive. Find the AL→C# emitter in Pipeline.cs (or RoslynRewriter.cs); inject `#line N "path"` directives before each generated C# statement so Roslyn's pdb writes `.al` filenames into IL sequence points.

- [ ] **Step 1: Locate the AL→C# emitter**

```bash
grep -rn "namespace.*Pipeline\|GenerateCSharp\|CSharpEmitter\|EmitStatement\|StringBuilder.*Append.*statement\|RoslynRewriter" AlRunner --include="*.cs" | head -20
```

Find the file responsible for converting parsed AL into C# string output. Likely in `Pipeline.cs` or a sibling class.

- [ ] **Step 2: Build a small test fixture**

```bash
mkdir -p tests/protocol-v2-line-directives/src
mkdir -p tests/protocol-v2-line-directives/test
```

`tests/protocol-v2-line-directives/src/Calc.Codeunit.al`:

```al
codeunit 50000 Calc
{
    procedure Compute(n: Integer): Integer
    begin
        if n < 0 then
            exit(0);
        exit(n * 2);
    end;
}
```

`tests/protocol-v2-line-directives/test/CalcTest.Codeunit.al`:

```al
codeunit 50100 CalcTest
{
    Subtype = Test;

    [Test]
    procedure ComputeDoubles()
    var
        Sut: Codeunit Calc;
    begin
        if Sut.Compute(3) <> 6 then Error('expected 6');
    end;

    [Test]
    procedure FailingTest()
    var
        Sut: Codeunit Calc;
    begin
        if Sut.Compute(1) <> 99 then Error('intentional failure');
    end;
}
```

- [ ] **Step 3: Write failing test**

Create `AlRunner.Tests/LineDirectiveEmissionTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

[Collection("Pipeline")]
public class LineDirectiveEmissionTests
{
    private static readonly string RepoRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));

    private static string TestPath(string sub) =>
        Path.Combine(RepoRoot, "tests", "protocol-v2-line-directives", sub);

    [Fact]
    public void Transpile_EmitsLineDirectivesWithAlPaths()
    {
        var pipeline = new AlRunnerPipeline();
        var options = new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
            EmitGeneratedCSharp = true, // new: write generated C# to disk for inspection
        };
        var result = pipeline.Run(options);

        Assert.Equal(0, result.ExitCode);

        // Locate the emitted C# files. Convention: alongside the assembly cache or in a
        // `publish-debug/` directory; the option above forces a write path we can verify.
        var generatedCSharp = result.GeneratedCSharpFiles;
        Assert.NotEmpty(generatedCSharp);

        var hasLineDirective = generatedCSharp.Any(content =>
            content.Contains("#line 1 ") &&  // any AL line
            content.Contains(".al\""));        // path quoted, ending in .al

        Assert.True(hasLineDirective,
            $"Generated C# should contain #line directives referencing .al files. Got:\n{string.Join("\n---\n", generatedCSharp)}");
    }

    [Fact]
    public void Transpile_QuotesPathsWithSpaces()
    {
        // Verify path normalization handles spaces. We rely on tests in this fixture
        // having a path with at least one segment that exercises the quoting logic.
        // (If the existing fixture has no spaces, fall back to assertion that all
        // emitted paths are properly quoted.)
        var pipeline = new AlRunnerPipeline();
        var options = new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
            EmitGeneratedCSharp = true,
        };
        var result = pipeline.Run(options);

        var allDirectives = string.Join("\n", result.GeneratedCSharpFiles)
            .Split('\n')
            .Where(line => line.TrimStart().StartsWith("#line "))
            .ToList();

        Assert.NotEmpty(allDirectives);
        // Every #line directive's filename argument must be quoted with ".
        foreach (var directive in allDirectives)
        {
            Assert.Matches(@"#line \d+ "".+\.al""", directive.Trim());
        }
    }

    [Fact]
    public void RunFailingTest_ProducesAlFileInStackTrace()
    {
        // The 'FailingTest' procedure throws via Error('intentional failure').
        // After #line directives, the stack trace should mention the .al file at the
        // line where Error() was called.
        var pipeline = new AlRunnerPipeline();
        var options = new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        };
        var result = pipeline.Run(options);

        var failed = result.Tests.First(t => t.Status == TestStatus.Fail);
        Assert.NotNull(failed.StackTrace);
        Assert.Contains(".al", failed.StackTrace, StringComparison.OrdinalIgnoreCase);
    }
}
```

`PipelineOptions` likely doesn't have an `EmitGeneratedCSharp` property yet. Add it (boolean, default false). When true, the pipeline should keep generated C# strings accessible via `PipelineResult.GeneratedCSharpFiles`. If `PipelineResult` doesn't have that property either, add it.

- [ ] **Step 4: Run test — confirm failure**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~LineDirectiveEmissionTests" --no-restore
```

Expected: compile error or assertion failure (no #line directives in generated C# yet).

- [ ] **Step 5: Add `EmitGeneratedCSharp` and `GeneratedCSharpFiles` plumbing**

In `AlRunner/Pipeline.cs` (or wherever `PipelineOptions` and `PipelineResult` live):

```csharp
public class PipelineOptions
{
    // ... existing fields ...
    public bool EmitGeneratedCSharp { get; set; } = false;
}

public class PipelineResult
{
    // ... existing fields ...
    public List<string> GeneratedCSharpFiles { get; set; } = new();
}
```

When `options.EmitGeneratedCSharp == true`, copy each generated C# string into `result.GeneratedCSharpFiles` before discard.

- [ ] **Step 6: Inject `#line` directives in the AL→C# emitter**

Locate the inner loop that emits C# statements. Before each statement, look up the AL line/file and prepend:

```csharp
private static string FormatLineDirective(int alLine, string alFile)
{
    // Normalize to forward slashes for cross-platform stack traces.
    var normalized = alFile.Replace('\\', '/');
    // Quote the path; C# allows quoted paths in #line directives.
    return $"#line {alLine} \"{normalized}\"";
}
```

Wherever statements get emitted into the StringBuilder, prepend `sb.AppendLine(FormatLineDirective(stmt.AlLine, stmt.AlFile));` before the statement's C# text. The exact insertion point depends on the emitter's design — it MUST be before each AL-derived statement (not before runtime helper methods).

For statements that span multiple AL lines (e.g., a multi-line if), emit the `#line` directive at the START of the AL statement; subsequent C# lines for that statement inherit the same source mapping.

After emitting all generated statements, restore default mapping with `#line default`:

```csharp
sb.AppendLine("#line default");
```

This prevents subsequent generated/runtime code from appearing as belonging to the last AL file.

- [ ] **Step 7: Run tests — iterate**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~LineDirectiveEmissionTests" --no-restore
```

If the third test (stack-trace contains .al) fails, the issue is likely that pdb generation is disabled in the test pipeline. Find the `CSharpCompilation.Create(...)` call in Pipeline.cs and ensure it uses `OptimizationLevel.Debug` and emits a portable pdb. The default Roslyn behavior should suffice; if not, set `EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb)`.

- [ ] **Step 8: Run full suite + commit**

```bash
dotnet test AlRunner.Tests --no-restore
git add AlRunner/Pipeline.cs tests/protocol-v2-line-directives AlRunner.Tests/LineDirectiveEmissionTests.cs
git commit -m "feat(transpile): emit #line directives so .al filenames flow into IL pdb sequence points"
```

---

## Task 8: `Executor.RunTests` revised — TestFilter + onTestComplete + AsyncLocal

**Files:**
- Modify: `AlRunner/Executor.cs` (or wherever `RunTests` lives)
- Create: `AlRunner.Tests/RunTestsFilteringTests.cs`
- Create: `AlRunner.Tests/RunTestsStreamingTests.cs`

**Context:** Three changes:
1. `TestFilter` parameter narrows which tests execute
2. `onTestComplete` callback fires per-test as it finishes (enables NDJSON streaming in Server.cs Task 10)
3. Per-test `capturedValues` and `messages` isolated via `AsyncLocal<TestExecutionContext>`

- [ ] **Step 1: Read current `Executor.RunTests`**

```bash
grep -n "public.*RunTests\|class Executor" AlRunner/Executor.cs
```

Identify signature, body, and where capturedValues/messages currently aggregate.

- [ ] **Step 2: Add `TestExecutionContext` AsyncLocal**

In `AlRunner/Executor.cs` (or alongside in `TestExecutionContext.cs` if you prefer separation):

```csharp
public static class TestExecutionScope
{
    private static readonly AsyncLocal<TestExecutionState?> _current = new();

    public static TestExecutionState? Current => _current.Value;

    public static IDisposable Begin(string testName)
    {
        var prev = _current.Value;
        var state = new TestExecutionState(testName);
        _current.Value = state;
        return new Scope(prev);
    }

    private sealed class Scope : IDisposable
    {
        private readonly TestExecutionState? _prev;
        public Scope(TestExecutionState? prev) { _prev = prev; }
        public void Dispose() { _current.Value = _prev; }
    }
}

public sealed class TestExecutionState
{
    public string TestName { get; }
    public List<string> Messages { get; } = new();
    public List<CapturedValue> CapturedValues { get; } = new();

    public TestExecutionState(string name) => TestName = name;
}
```

`CapturedValue` already exists somewhere — reuse it.

- [ ] **Step 3: Modify Mock infrastructure to record into TestExecutionScope.Current**

The existing `MockMessage` / capture-value emitters (likely `AlRunner.Runtime.MockMessage.Send(string)` or similar) currently push to a global list. Change to:

```csharp
// In MockMessage.cs (or wherever Message() captures live):
public static void Send(string text)
{
    var scope = TestExecutionScope.Current;
    if (scope != null) scope.Messages.Add(text);
    else _globalMessages.Add(text);   // fallback for runs outside tests
}
```

Same pattern for capturedValues.

- [ ] **Step 4: Add tests for filtering**

Create `AlRunner.Tests/RunTestsFilteringTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

[Collection("Pipeline")]
public class RunTestsFilteringTests
{
    private static readonly string RepoRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));

    private static string TestPath(string sub) =>
        Path.Combine(RepoRoot, "tests", "protocol-v2-line-directives", sub);

    [Fact]
    public void RunTests_WithProcFilter_RunsOnlyMatching()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });
        Assert.Equal(0, result.ExitCode);
        // Now re-run with a filter
        var assembly = result.CompiledAssembly;
        Assert.NotNull(assembly);

        var filter = new TestFilter(
            CodeunitNames: null,
            ProcNames: new HashSet<string> { "ComputeDoubles" });
        var filtered = Executor.RunTests(assembly!, filter, null, default);

        Assert.Single(filtered);
        Assert.Equal("ComputeDoubles", filtered[0].Name);
    }

    [Fact]
    public void RunTests_WithCodeunitFilter_RunsOnlyMatching()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });
        var filter = new TestFilter(
            CodeunitNames: new HashSet<string> { "CalcTest" },
            ProcNames: null);
        var filtered = Executor.RunTests(result.CompiledAssembly!, filter, null, default);

        Assert.Equal(2, filtered.Count); // both procs in CalcTest codeunit
    }

    [Fact]
    public void RunTests_FilterUnion_BothMustMatch()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });
        var filter = new TestFilter(
            CodeunitNames: new HashSet<string> { "CalcTest" },
            ProcNames: new HashSet<string> { "FailingTest" });
        var filtered = Executor.RunTests(result.CompiledAssembly!, filter, null, default);

        Assert.Single(filtered);
        Assert.Equal("FailingTest", filtered[0].Name);
    }

    [Fact]
    public void RunTests_NoFilter_RunsAll()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });
        var all = Executor.RunTests(result.CompiledAssembly!, null, null, default);
        Assert.Equal(2, all.Count);
    }
}
```

`PipelineResult.CompiledAssembly` may not be exposed yet — add it (already inside PipelineResult) so tests can drive `Executor.RunTests` directly.

- [ ] **Step 5: Add tests for streaming + per-test isolation**

Create `AlRunner.Tests/RunTestsStreamingTests.cs`:

```csharp
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

[Collection("Pipeline")]
public class RunTestsStreamingTests
{
    private static readonly string RepoRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));

    private static string TestPath(string sub) =>
        Path.Combine(RepoRoot, "tests", "protocol-v2-line-directives", sub);

    [Fact]
    public void RunTests_StreamingCallback_InvokedPerTest()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });

        var seen = new List<string>();
        var all = Executor.RunTests(
            result.CompiledAssembly!,
            null,
            t => seen.Add(t.Name),
            default);

        Assert.Equal(all.Count, seen.Count);
        Assert.Equal(all.Select(t => t.Name), seen);
    }

    [Fact]
    public void RunTests_PerTestMessages_Isolated()
    {
        var pipeline = new AlRunnerPipeline();
        var result = pipeline.Run(new PipelineOptions
        {
            InputPaths = { TestPath("src"), TestPath("test") },
        });
        var all = Executor.RunTests(result.CompiledAssembly!, null, null, default);
        // Each test's Messages collection should be scoped to that test alone.
        // For the fixture, no Message() calls exist — just confirm Messages is non-null and (likely) empty.
        foreach (var t in all)
        {
            Assert.NotNull(t.Messages);
        }
    }
}
```

Note: `TestResult` will need `Messages` and `CapturedValues` fields. They may already exist; verify.

- [ ] **Step 6: Implement `Executor.RunTests` revised**

```csharp
public static List<TestResult> RunTests(
    Assembly assembly,
    TestFilter? filter = null,
    Action<TestResult>? onTestComplete = null,
    CancellationToken cancellationToken = default)
{
    var results = new List<TestResult>();
    foreach (var (codeunitName, procName, methodInfo) in DiscoverTests(assembly))
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!FilterMatches(filter, codeunitName, procName)) continue;

        TestResult result;
        using (TestExecutionScope.Begin($"{codeunitName}.{procName}"))
        {
            var ctx = new TestExecutionContext(InsideTestProc: true);
            result = ExecuteOneTest(methodInfo, codeunitName, procName, ctx);
            // Snapshot per-test messages/capturedValues from AsyncLocal scope
            var scope = TestExecutionScope.Current!;
            result.Messages = scope.Messages.ToList();
            result.CapturedValues = scope.CapturedValues.ToList();
        }
        results.Add(result);
        onTestComplete?.Invoke(result);
    }
    return results;
}

private static bool FilterMatches(TestFilter? filter, string codeunitName, string procName)
{
    if (filter == null) return true;
    if (filter.CodeunitNames != null && !filter.CodeunitNames.Contains(codeunitName)) return false;
    if (filter.ProcNames != null && !filter.ProcNames.Contains(procName)) return false;
    return true;
}
```

`DiscoverTests` and `ExecuteOneTest` are the existing internal helpers — adapt to whatever names exist. The key new behavior: per-test scope wraps the execution; per-test snapshots populate `result.Messages` / `result.CapturedValues`.

When the test throws, `ExecuteOneTest` catches the exception, calls `StackFrameMapper.Walk(ex)`, populates `result.StackFrames`, looks up deepest user frame for `result.AlSourceFile`/`Line`/`Column`, and classifies via `ErrorClassifier.Classify(ex, ctx)` for `result.ErrorKind`. (`TestResult` will need new `StackFrames`, `ErrorKind`, `AlSourceFile` fields.)

- [ ] **Step 7: Run tests — iterate**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~RunTestsFilteringTests|FullyQualifiedName~RunTestsStreamingTests" --no-restore
```

Iterate until green. Common issues: AsyncLocal scope not propagating into Roslyn-invoked test methods (they run on the same thread, so AsyncLocal works — verify), or filter logic mismatch.

- [ ] **Step 8: Run full suite — keep baseline green**

```bash
dotnet test AlRunner.Tests --no-restore
```

- [ ] **Step 9: Commit**

```bash
git add AlRunner/Executor.cs AlRunner/TestExecutionState.cs AlRunner.Tests/RunTestsFilteringTests.cs AlRunner.Tests/RunTestsStreamingTests.cs
git commit -m "feat(executor): RunTests gains TestFilter + onTestComplete + AsyncLocal per-test isolation"
```

---

## Task 9: Server.cs — `cancel` command

**Files:**
- Modify: `AlRunner/Server.cs`
- Create: `AlRunner.Tests/ServerCancelTests.cs`

**Context:** Add a new `cancel` command. The server holds a `CancellationTokenSource` for the currently-running request. Cancel writes `{"type":"ack","command":"cancel","noop":<bool>}` and trips the token. Active `Executor.RunTests` observes the token and breaks the test loop after the current test completes.

- [ ] **Step 1: Add failing test**

Create `AlRunner.Tests/ServerCancelTests.cs`:

```csharp
using System.Text.Json;
using Xunit;

namespace AlRunner.Tests;

public class ServerCancelTests
{
    [Fact]
    public async Task Cancel_NoActiveRequest_AcksAsNoop()
    {
        await using var server = await CliServer.Start();
        var response = await server.SendRequest("{\"command\":\"cancel\"}");
        var doc = JsonDocument.Parse(response);
        Assert.Equal("ack", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("cancel", doc.RootElement.GetProperty("command").GetString());
        Assert.True(doc.RootElement.GetProperty("noop").GetBoolean());
    }
}
```

`CliServer.SendRequest` is the existing helper. The test starts the server, sends a single `cancel` request, asserts the ack response.

- [ ] **Step 2: Run — confirm failure**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~ServerCancelTests" --no-restore
```

Expected: server returns `Unknown command: cancel` (current behavior).

- [ ] **Step 3: Implement cancel handling in `Server.cs`**

Add field and handler:

```csharp
private CancellationTokenSource? _activeRequestCts;

// In the command dispatcher switch:
"cancel" => HandleCancel(),

private string HandleCancel()
{
    var cts = _activeRequestCts;
    if (cts == null || cts.IsCancellationRequested)
    {
        return JsonSerializer.Serialize(new { type = "ack", command = "cancel", noop = true });
    }
    cts.Cancel();
    return JsonSerializer.Serialize(new { type = "ack", command = "cancel", noop = false });
}
```

In `HandleRunTests` (and `HandleExecute`), wrap the work in:

```csharp
_activeRequestCts = new CancellationTokenSource();
try
{
    // ... existing code, plus pass _activeRequestCts.Token down to Executor.RunTests ...
}
finally
{
    _activeRequestCts.Dispose();
    _activeRequestCts = null;
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~ServerCancelTests" --no-restore
```

- [ ] **Step 5: Commit**

```bash
git add AlRunner/Server.cs AlRunner.Tests/ServerCancelTests.cs
git commit -m "feat(server): add cancel command — sets active CancellationTokenSource for current request"
```

---

## Task 10: Server.cs — NDJSON streaming + revised SerializeServerResponse + protocolVersion 2

**Files:**
- Modify: `AlRunner/Server.cs`
- Create: `AlRunner.Tests/ServerProtocolV2Tests.cs`

**Context:** This is the largest task. Three concurrent changes:
1. `SerializeServerResponse` rewritten to include all fields the spec requires (alSourceLine, alSourceColumn, errorKind, stackFrames DAP-aligned, messages, capturedValues per test).
2. `HandleRunTests` writes per-test JSON lines as the executor reports them (via `onTestComplete` callback from Task 8); writes terminal summary line at the end.
3. Summary line includes `"type":"summary"` and `"protocolVersion":2`. All other lines have `"type":"test"|"ack"|"progress"`.

- [ ] **Step 1: Add request fields**

In `Server.cs`, extend `ServerRequest` class:

```csharp
public class ServerRequest
{
    // ... existing ...

    [JsonPropertyName("testFilter")]
    public TestFilterDto? TestFilter { get; set; }

    [JsonPropertyName("coverage")]
    public bool? Coverage { get; set; }

    [JsonPropertyName("cobertura")]
    public bool? Cobertura { get; set; }

    [JsonPropertyName("protocolVersion")]
    public int? ProtocolVersion { get; set; }
}

public class TestFilterDto
{
    [JsonPropertyName("codeunitNames")]
    public List<string>? CodeunitNames { get; set; }

    [JsonPropertyName("procNames")]
    public List<string>? ProcNames { get; set; }
}
```

- [ ] **Step 2: Write failing tests**

Create `AlRunner.Tests/ServerProtocolV2Tests.cs`:

```csharp
using System.Text.Json;
using Xunit;

namespace AlRunner.Tests;

public class ServerProtocolV2Tests
{
    private static readonly string RepoRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));

    private static string Fixture(string sub) =>
        Path.Combine(RepoRoot, "tests", "protocol-v2-line-directives", sub);

    [Fact]
    public async Task RunTests_StreamsTestLinesThenSummary()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") },
            captureValues = true
        });

        var lines = await server.SendRequestStreaming(request);

        // Parse all lines as JSON
        var parsed = lines.Select(l => JsonDocument.Parse(l).RootElement).ToList();
        var typeOf = (JsonElement e) => e.GetProperty("type").GetString();

        // First lines are "test", last line is "summary"
        Assert.True(parsed.Count >= 2, $"expected >=2 lines, got {parsed.Count}");
        Assert.Equal("summary", typeOf(parsed.Last()));
        for (var i = 0; i < parsed.Count - 1; i++)
        {
            var t = typeOf(parsed[i]);
            Assert.True(t == "test" || t == "progress", $"non-final line type was '{t}'");
        }
    }

    [Fact]
    public async Task RunTests_SummaryHasProtocolVersion2()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") }
        });
        var lines = await server.SendRequestStreaming(request);
        var summary = JsonDocument.Parse(lines.Last()).RootElement;
        Assert.Equal(2, summary.GetProperty("protocolVersion").GetInt32());
    }

    [Fact]
    public async Task RunTests_FailingTestLineHasAlSourceLine()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") }
        });
        var lines = await server.SendRequestStreaming(request);
        var failing = lines
            .Select(l => JsonDocument.Parse(l).RootElement)
            .First(e => e.GetProperty("type").GetString() == "test"
                     && e.GetProperty("status").GetString() == "fail");

        // alSourceLine must be present and >0 (the line where Error() was called).
        Assert.True(failing.TryGetProperty("alSourceLine", out var line));
        Assert.True(line.GetInt32() > 0);
        // alSourceFile present, ends with .al
        Assert.True(failing.TryGetProperty("alSourceFile", out var file));
        Assert.EndsWith(".al", file.GetString(), StringComparison.OrdinalIgnoreCase);
        // errorKind present
        Assert.True(failing.TryGetProperty("errorKind", out _));
    }

    [Fact]
    public async Task RunTests_TestFilterApplied()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") },
            testFilter = new { procNames = new[] { "ComputeDoubles" } }
        });
        var lines = await server.SendRequestStreaming(request);
        var testLines = lines
            .Select(l => JsonDocument.Parse(l).RootElement)
            .Where(e => e.GetProperty("type").GetString() == "test")
            .ToList();
        Assert.Single(testLines);
        Assert.Equal("ComputeDoubles", testLines[0].GetProperty("name").GetString());
    }

    [Fact]
    public async Task RunTests_CoverageInSummaryWhenFlagSet()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") },
            coverage = true
        });
        var lines = await server.SendRequestStreaming(request);
        var summary = JsonDocument.Parse(lines.Last()).RootElement;
        Assert.True(summary.TryGetProperty("coverage", out var cov));
        Assert.True(cov.GetArrayLength() > 0);
    }

    [Fact]
    public async Task RunTests_NoCoverageInSummaryWhenFlagAbsent()
    {
        await using var server = await CliServer.Start();
        var request = JsonSerializer.Serialize(new
        {
            command = "runtests",
            sourcePaths = new[] { Fixture("src"), Fixture("test") }
        });
        var lines = await server.SendRequestStreaming(request);
        var summary = JsonDocument.Parse(lines.Last()).RootElement;
        Assert.False(summary.TryGetProperty("coverage", out _));
    }
}
```

`CliServer.SendRequestStreaming(request)` is a NEW helper — accumulates all stdout lines until the line whose `type` is `"summary"` arrives, returns the list. Add it to `CliServer.cs`:

```csharp
public async Task<List<string>> SendRequestStreaming(string requestJson)
{
    await _process.StandardInput.WriteLineAsync(requestJson);
    await _process.StandardInput.FlushAsync();
    var lines = new List<string>();
    while (true)
    {
        var line = await _process.StandardOutput.ReadLineAsync();
        if (line == null) throw new InvalidOperationException("stdout closed before summary");
        lines.Add(line);
        // Try to parse and check type
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.TryGetProperty("type", out var t)
                && t.GetString() == "summary")
            {
                return lines;
            }
        }
        catch (JsonException) { /* ignore non-JSON lines */ }
    }
}
```

- [ ] **Step 3: Implement revised `HandleRunTests` with streaming**

Replace existing `HandleRunTests` body:

```csharp
private void HandleRunTests(ServerRequest request, Task<List<MetadataReference>> refsTask, TextWriter output)
{
    if (request.SourcePaths == null || request.SourcePaths.Length == 0)
    {
        output.WriteLine(JsonSerializer.Serialize(new { type = "summary", error = "sourcePaths is required", protocolVersion = 2 }));
        return;
    }

    _activeRequestCts = new CancellationTokenSource();
    var ct = _activeRequestCts.Token;
    try
    {
        var fingerprint = _cache.ComputeFingerprint(request.SourcePaths);
        var cacheHit = _cache.TryGet(fingerprint);
        Assembly assembly;
        Dictionary<string, List<string>>? compErrors = null;
        bool cached;

        if (cacheHit != null)
        {
            assembly = cacheHit.Value.Assembly;
            compErrors = cacheHit.Value.CompilationErrors;
            cached = true;
        }
        else
        {
            var changedFiles = _cache.DiffAgainstClosest();
            var pipelineOptions = new PipelineOptions
            {
                OutputJson = true,
                ShowCoverage = request.Coverage == true,
            };
            pipelineOptions.InputPaths.AddRange(request.SourcePaths);
            if (request.PackagePaths != null) pipelineOptions.PackagePaths.AddRange(request.PackagePaths);
            if (request.StubPaths != null) pipelineOptions.StubPaths.AddRange(request.StubPaths);

            var pipeline = new AlRunnerPipeline { /* caches assigned */ };
            var pipelineResult = pipeline.Run(pipelineOptions);
            if (pipelineResult.CompiledAssembly == null)
            {
                output.WriteLine(JsonSerializer.Serialize(new
                {
                    type = "summary",
                    exitCode = pipelineResult.ExitCode,
                    compilationErrors = pipelineResult.CompilationErrors,
                    cached = false,
                    protocolVersion = 2,
                    passed = 0, failed = 0, errors = 0, total = 0
                }));
                return;
            }
            assembly = pipelineResult.CompiledAssembly;
            compErrors = pipelineResult.CompilationErrors;
            cached = false;
        }

        var filter = ConvertFilter(request.TestFilter);
        var allResults = new List<TestResult>();
        Executor.RunTests(assembly, filter, t =>
        {
            allResults.Add(t);
            output.WriteLine(SerializeTestEvent(t));
        }, ct);

        // Write summary
        var coverageJson = (request.Coverage == true)
            ? CoverageReport.ToJson(/* args from runtime state */)
            : null;
        if (request.Cobertura == true)
        {
            CoverageReport.WriteCobertura("cobertura.xml", /* args */);
        }

        output.WriteLine(SerializeSummary(allResults, /* exitCode */ Executor.ExitCode(allResults), cached, /* changedFiles */ null, compErrors, coverageJson, ct.IsCancellationRequested));
    }
    finally
    {
        _activeRequestCts?.Dispose();
        _activeRequestCts = null;
    }
}

private static TestFilter? ConvertFilter(TestFilterDto? dto)
{
    if (dto == null) return null;
    return new TestFilter(
        dto.CodeunitNames != null ? new HashSet<string>(dto.CodeunitNames) : null,
        dto.ProcNames != null ? new HashSet<string>(dto.ProcNames) : null);
}

private static string SerializeTestEvent(TestResult t)
{
    var statusStr = t.Status.ToString().ToLowerInvariant();
    return JsonSerializer.Serialize(new
    {
        type = "test",
        name = t.Name,
        status = statusStr,
        durationMs = t.DurationMs,
        message = t.Message,
        errorKind = t.ErrorKind.ToString().ToLowerInvariant(),
        alSourceFile = t.AlSourceFile,
        alSourceLine = t.AlSourceLine,
        alSourceColumn = t.AlSourceColumn,
        stackFrames = t.StackFrames?.Select(f => new
        {
            name = f.Name,
            source = f.File != null ? new { path = f.File } : null,
            line = f.Line,
            column = f.Column,
            presentationHint = f.Hint.ToString().ToLowerInvariant(),
        }),
        stackTrace = t.StackTrace,
        messages = t.Messages?.Count > 0 ? t.Messages : null,
        capturedValues = t.CapturedValues?.Count > 0
            ? t.CapturedValues.Select(c => new { c.ScopeName, c.VariableName, c.Value, c.StatementId })
            : null,
    }, new JsonSerializerOptions
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    });
}

private static string SerializeSummary(
    List<TestResult> tests, int exitCode, bool cached,
    List<string>? changedFiles, Dictionary<string, List<string>>? compErrors,
    List<FileCoverage>? coverage, bool cancelled)
{
    return JsonSerializer.Serialize(new
    {
        type = "summary",
        exitCode,
        passed = tests.Count(t => t.Status == TestStatus.Pass),
        failed = tests.Count(t => t.Status == TestStatus.Fail),
        errors = tests.Count(t => t.Status == TestStatus.Error),
        total = tests.Count,
        cached,
        cancelled = cancelled ? (bool?)true : null,
        changedFiles = cached ? null : changedFiles,
        compilationErrors = compErrors != null && compErrors.Count > 0
            ? compErrors.Select(kvp => new { file = Path.GetFileName(kvp.Key), errors = kvp.Value })
            : null,
        coverage,
        protocolVersion = 2,
    }, new JsonSerializerOptions
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    });
}
```

The argument `(/* args */)` to `CoverageReport.WriteCobertura` and `CoverageReport.ToJson` requires accessing the runtime coverage state — `Runtime.AlScope.GetCoverageSets()` and the source-spans dictionary built during compile. Wire these from the existing CLI mode's coverage path (the cobertura write path in `Pipeline.cs:639` shows the call shape).

Also: the dispatch loop needs to pass the `output` writer to `HandleRunTests` (it's currently buffered into a single string return). Change the main `RunAsync` method:

```csharp
// Old:
response = HandleRunTests(request, refsTask);
await output.WriteLineAsync(response);

// New (inline write — handler streams directly):
HandleRunTests(request, refsTask, output);
await output.FlushAsync();
```

Other handlers (`HandleExecute`, `HandleShutdown`, `HandleCancel`) keep returning a string for now.

- [ ] **Step 4: Update CliServer test helper for streaming**

The `CliServer.SendRequest(string)` existing helper expects single-line responses. For streaming `runtests`, use the new `SendRequestStreaming` helper added in Step 2.

For other commands (cancel, shutdown, execute) — keep using the old `SendRequest`.

- [ ] **Step 5: Run tests — iterate**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~ServerProtocolV2Tests" --no-restore
```

Iterate. Common issues:
- Streaming output not flushed in time: ensure `output.WriteLine` followed by `output.Flush()` after each test event AND after the summary.
- Coverage data unavailable during cache hit: when serving from cache, you don't have fresh source-spans. Either skip coverage on cache hit (acceptable degradation; emit `coverage: null`) or store coverage state alongside the cache entry.

- [ ] **Step 6: Run full suite**

```bash
dotnet test AlRunner.Tests --no-restore
```

- [ ] **Step 7: Commit**

```bash
git add AlRunner/Server.cs AlRunner.Tests/ServerProtocolV2Tests.cs AlRunner.Tests/CliServer.cs
git commit -m "feat(server): protocol v2 — NDJSON streaming, DAP stackFrames, coverage, errorKind, protocolVersion: 2"
```

---

## Task 11: Update protocol-v2.schema.json after concrete shape stabilizes

**Files:**
- Modify: `protocol-v2.schema.json`

**Context:** Task 2 wrote an initial schema. After Task 10's implementation, the actual emitted shape may have minor differences. Validate emitted lines against the schema; fix either the schema or the emitter to match.

- [ ] **Step 1: Add a schema-validation test**

Append to `AlRunner.Tests/ServerProtocolV2Tests.cs`:

```csharp
[Fact]
public async Task RunTests_AllEmittedLines_ValidateAgainstSchema()
{
    var schemaPath = Path.Combine(RepoRoot, "protocol-v2.schema.json");
    var schemaJson = await File.ReadAllTextAsync(schemaPath);
    var schema = Newtonsoft.Json.Schema.JSchema.Parse(schemaJson);

    await using var server = await CliServer.Start();
    var request = JsonSerializer.Serialize(new
    {
        command = "runtests",
        sourcePaths = new[] { Fixture("src"), Fixture("test") },
        coverage = true
    });
    var lines = await server.SendRequestStreaming(request);

    foreach (var line in lines)
    {
        var token = Newtonsoft.Json.Linq.JToken.Parse(line);
        var valid = token.IsValid(schema, out IList<string> errors);
        Assert.True(valid, $"Line failed schema validation:\n{line}\nErrors:\n{string.Join("\n", errors)}");
    }
}
```

- [ ] **Step 2: Add Newtonsoft.Json.Schema package**

```bash
cd AlRunner.Tests
dotnet add package Newtonsoft.Json.Schema
cd ..
```

- [ ] **Step 3: Run — adjust schema or emitter until both agree**

```bash
dotnet test AlRunner.Tests --filter "FullyQualifiedName~ServerProtocolV2Tests.RunTests_AllEmittedLines_ValidateAgainstSchema" --no-restore
```

If the schema rejects valid output: fix the schema (likely missing or too-strict constraints).
If the emitter produces output the schema rejects: fix the emitter.

- [ ] **Step 4: Commit**

```bash
git add protocol-v2.schema.json AlRunner.Tests/ServerProtocolV2Tests.cs AlRunner.Tests/AlRunner.Tests.csproj
git commit -m "test(protocol): validate every emitted line against protocol-v2.schema.json"
```

---

## Task 12: End-to-end smoke test against built binary

**Files:** none modified.

**Context:** Confirm the end-to-end flow works against the actual built `al-runner` binary, not just the test harness. Run a manual JSON-RPC interaction.

- [ ] **Step 1: Build a fresh binary**

```bash
dotnet build AlRunner --configuration Release
```

Note the output path (likely `AlRunner/bin/Release/net8.0/AlRunner.exe` on Windows or similar).

- [ ] **Step 2: Manual JSON-RPC interaction**

Open a terminal, pipe JSON requests to the binary in `--server` mode:

```bash
cd U:/Git/AL.Runner-protocol-v2
echo '{"command":"runtests","sourcePaths":["tests/protocol-v2-line-directives/src","tests/protocol-v2-line-directives/test"],"captureValues":true,"coverage":true}' | AlRunner/bin/Release/net8.0/AlRunner.exe --server > smoke-output.log 2>&1
```

Inspect `smoke-output.log`:
- Multiple lines, each valid JSON
- Each test line has `"type":"test"`, `"alSourceLine"`, `"errorKind"`
- Failing test (FailingTest) has `"alSourceLine"` matching the `Error()` call line
- Summary line has `"type":"summary"` and `"protocolVersion":2`
- Summary has `"coverage"` array

- [ ] **Step 3: Document smoke result**

If everything looks correct, paste the smoke-output as evidence:

```bash
cat smoke-output.log | head -10
echo "---"
cat smoke-output.log | tail -3
```

Expected: ready states, test events, summary line.

- [ ] **Step 4: Optional — commit smoke-output as a fixture**

If you want to retain the sample for ALchemist's tests (Plan E2 will use it):

```bash
mkdir -p docs/protocol-v2-samples
cp smoke-output.log docs/protocol-v2-samples/runtests-coverage-success.ndjson
git add docs/protocol-v2-samples/
git commit -m "docs(protocol-samples): capture v2 runtests sample for cross-repo testing"
```

Otherwise, just `rm smoke-output.log` to clean up.

---

## Self-Review

**1. Spec coverage:**
- Spec §"#line directives" → Task 7 ✓
- Spec §"StackFrameMapper" → Task 4 ✓
- Spec §"ErrorClassifier" → Task 5 ✓
- Spec §"CoverageReport.ToJson" → Task 6 ✓
- Spec §"Executor.RunTests with TestFilter and onTestComplete" → Task 8 ✓
- Spec §"AsyncLocal per-test isolation" → Task 8 ✓
- Spec §"Server cancel command" → Task 9 ✓
- Spec §"Server NDJSON streaming + revised SerializeServerResponse" → Task 10 ✓
- Spec §"Coverage emission with explicit cobertura flag" → Task 10 ✓
- Spec §"protocolVersion: 2 in summary" → Task 10 ✓
- Spec §"protocol-v2.schema.json" → Task 2 + Task 11 ✓
- Spec §"End-to-end verification against fork build" → Task 12 ✓

All spec deliverables for the AL.Runner side mapped to tasks.

**2. Placeholder scan:** No "TBD"/"TODO"/"implement later"/"similar to Task N" patterns in plan body. Two places use `/* args from runtime state */` style — those are pointers to existing infrastructure (CoverageReport.WriteCobertura's existing call site shows the args), not placeholders for the implementer to invent. Acceptable.

**3. Type consistency:**
- `AlStackFrame`, `AlErrorKind`, `FramePresentationHint`, `TestFilter`, `TestExecutionContext`, `TestExecutionState`, `FileCoverage`, `LineCoverage` — all defined in early tasks and used identically in later tasks
- `Executor.RunTests` signature `(Assembly, TestFilter?, Action<TestResult>?, CancellationToken)` consistent across Tasks 8, 9, 10
- `SerializeTestEvent` and `SerializeSummary` field names match `protocol-v2.schema.json` (Task 2) shape

No drift.

---

## Out of scope (Plan E2 / E3 / future)

- ALchemist consumption layer (Plan E2)
- VS Code native APIs integration (`TestRun.addCoverage`, `TestMessageStackFrame`) (Plan E2)
- Sentinel end-to-end verification against combined stack (Plan E3)
- Upstream PRs split (Plan E3)
- Per-test caching (AL.Runner doc 08, separate effort)
- Debug Adapter Protocol implementation (A3 roadmap)
- Partial-compile / best-effort run (significant runtime work)
