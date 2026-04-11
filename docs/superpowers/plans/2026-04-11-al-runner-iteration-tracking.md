# AL.Runner Iteration Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--iteration-tracking` flag to AL.Runner that emits per-iteration data (captured values, messages, lines executed) in the JSON output, enabling ALchemist's iteration navigation feature.

**Architecture:** New `IterationTracker` static collector (mirrors `ValueCapture` and `MessageCapture` patterns). A new `IterationInjector` Roslyn rewriter (mirrors `ValueCaptureInjector`) injects `EnterLoop`/`EnterIteration`/`ExitLoop` calls around transpiled C# loop statements. Pipeline.cs wires enable/disable/reset. JSON output gains an `iterations[]` array.

**Tech Stack:** C# 8.0, .NET Core, Roslyn (Microsoft.CodeAnalysis.CSharp), xUnit for tests.

**Repo:** `U:\Git\BusinessCentral.AL.Runner\`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `AlRunner/Runtime/IterationTracker.cs` | Static collector — tracks loop entry/exit, iteration boundaries, snapshots values/messages/lines per iteration |
| `AlRunner/IterationInjector.cs` | Roslyn CSharpSyntaxRewriter — injects tracking calls around for/while/repeat loops in transpiled C# |
| `tests/20-iteration-tracking/Test.al` | Integration test AL file with loops |
| `tests/20-iteration-tracking/expected.json` | Expected JSON output |

### Modified Files

| File | Changes |
|------|---------|
| `AlRunner/Pipeline.cs` | Add `IterationTracking` option, wire enable/reset/disable, collect results, add to JSON |
| `AlRunner/Program.cs` | Add `--iteration-tracking` CLI flag, include iterations in `SerializeJsonOutput()` |

---

### Task 1: IterationTracker Static Collector

**Files:**
- Create: `AlRunner/Runtime/IterationTracker.cs`

- [ ] **Step 1: Create IterationTracker.cs**

Mirror the `ValueCapture.cs` pattern exactly. The tracker needs to handle nested loops via a stack.

```csharp
// AlRunner/Runtime/IterationTracker.cs
namespace AlRunner.Runtime;

public static class IterationTracker
{
    private static bool _enabled;
    private static readonly List<LoopRecord> _loops = new();
    private static readonly Stack<ActiveLoop> _loopStack = new();
    private static int _nextLoopId;

    public static bool Enabled => _enabled;
    public static void Enable() => _enabled = true;
    public static void Disable() => _enabled = false;

    public static void Reset()
    {
        _loops.Clear();
        _loopStack.Clear();
        _nextLoopId = 0;
    }

    /// <summary>
    /// Called at loop entry (before first iteration).
    /// Returns the loopId assigned to this loop instance.
    /// </summary>
    public static int EnterLoop(int sourceStartLine, int sourceEndLine)
    {
        if (!_enabled) return -1;

        var loopId = _nextLoopId++;
        var parentLoopId = _loopStack.Count > 0 ? _loopStack.Peek().LoopId : (int?)-1;
        var parentIteration = _loopStack.Count > 0 ? _loopStack.Peek().CurrentIteration : (int?)null;

        var record = new LoopRecord
        {
            LoopId = loopId,
            SourceStartLine = sourceStartLine,
            SourceEndLine = sourceEndLine,
            ParentLoopId = parentLoopId == -1 ? null : parentLoopId,
            ParentIteration = parentIteration,
            Steps = new List<IterationStep>(),
        };
        _loops.Add(record);

        _loopStack.Push(new ActiveLoop
        {
            LoopId = loopId,
            Record = record,
            CurrentIteration = 0,
        });

        return loopId;
    }

    /// <summary>
    /// Called at the start of each iteration (top of loop body).
    /// Snapshots the current state of ValueCapture and MessageCapture.
    /// </summary>
    public static void EnterIteration(int loopId)
    {
        if (!_enabled) return;
        if (_loopStack.Count == 0 || _loopStack.Peek().LoopId != loopId) return;

        var active = _loopStack.Peek();
        active.CurrentIteration++;

        // Snapshot current captured values and messages BEFORE this iteration runs
        active.ValueSnapshotBefore = ValueCapture.GetCaptures().Count;
        active.MessageSnapshotBefore = MessageCapture.GetMessages().Count;

        // Record which statements have been hit so far
        active.HitStatementsBefore = new HashSet<(string, int)>(AlScope.GetHitStatements());
    }

    /// <summary>
    /// Called at the end of each iteration (bottom of loop body, before condition check).
    /// Captures the delta from the snapshot.
    /// </summary>
    public static void EndIteration(int loopId)
    {
        if (!_enabled) return;
        if (_loopStack.Count == 0 || _loopStack.Peek().LoopId != loopId) return;

        var active = _loopStack.Peek();

        // Capture values added during this iteration
        var allValues = ValueCapture.GetCaptures();
        var iterValues = allValues.Skip(active.ValueSnapshotBefore)
            .Select(v => new CapturedValueSnapshot { VariableName = v.VariableName, Value = v.Value ?? "" })
            .ToList();

        // Capture messages added during this iteration
        var allMessages = MessageCapture.GetMessages();
        var iterMessages = allMessages.Skip(active.MessageSnapshotBefore).ToList();

        // Capture lines executed during this iteration (delta)
        var allHit = AlScope.GetHitStatements();
        var iterLines = allHit.Except(active.HitStatementsBefore ?? new HashSet<(string, int)>())
            .Select(h => h.Id)
            .ToList();
        // Also include lines that were already hit (re-executed in this iteration)
        // For loops, all lines in the body are re-executed each iteration
        // Use the statement IDs from StmtHit calls that occurred during this iteration

        active.Record.Steps.Add(new IterationStep
        {
            Iteration = active.CurrentIteration,
            CapturedValues = iterValues,
            Messages = iterMessages,
            LinesExecuted = iterLines,
        });
    }

    /// <summary>
    /// Called after the loop exits.
    /// </summary>
    public static void ExitLoop(int loopId)
    {
        if (!_enabled) return;
        if (_loopStack.Count == 0 || _loopStack.Peek().LoopId != loopId) return;

        var active = _loopStack.Pop();
        active.Record.IterationCount = active.CurrentIteration;
    }

    public static List<LoopRecord> GetLoops() => new(_loops);

    // --- Data classes ---

    public class LoopRecord
    {
        public int LoopId { get; init; }
        public int SourceStartLine { get; init; }
        public int SourceEndLine { get; init; }
        public int? ParentLoopId { get; init; }
        public int? ParentIteration { get; init; }
        public int IterationCount { get; set; }
        public List<IterationStep> Steps { get; init; } = new();
    }

    public class IterationStep
    {
        public int Iteration { get; init; }
        public List<CapturedValueSnapshot> CapturedValues { get; init; } = new();
        public List<string> Messages { get; init; } = new();
        public List<int> LinesExecuted { get; init; } = new();
    }

    public class CapturedValueSnapshot
    {
        public string VariableName { get; init; } = "";
        public string Value { get; init; } = "";
    }

    private class ActiveLoop
    {
        public int LoopId { get; init; }
        public LoopRecord Record { get; init; } = null!;
        public int CurrentIteration { get; set; }
        public int ValueSnapshotBefore { get; set; }
        public int MessageSnapshotBefore { get; set; }
        public HashSet<(string Type, int Id)>? HitStatementsBefore { get; set; }
    }
}
```

**NOTE:** This is a draft — the exact delta tracking for values/messages/lines will need adjustment based on how `AlScope.GetHitStatements()` works. The implementer should read `AlScope.cs` to verify the API. If `GetHitStatements()` doesn't exist, it needs to be added (expose `_hitStatements` via a static method).

- [ ] **Step 2: Verify it compiles**

Run: `dotnet build AlRunner/AlRunner.csproj`
Expected: Build succeeds (may need to add `GetHitStatements()` to `AlScope.cs` first).

- [ ] **Step 3: Commit**

```bash
git add AlRunner/Runtime/IterationTracker.cs
git commit -m "feat: add IterationTracker static collector for loop iteration data"
```

---

### Task 2: Expose AlScope Hit Statements

**Files:**
- Modify: `AlRunner/Runtime/AlScope.cs`

The `_hitStatements` field is private. We need a static method to read it for IterationTracker's delta tracking.

- [ ] **Step 1: Add GetHitStatements method**

In `AlScope.cs`, add after the existing `_hitStatements` field (around line 38):

```csharp
public static HashSet<(string Type, int Id)> GetHitStatements()
    => new(_hitStatements);
```

- [ ] **Step 2: Verify it compiles**

Run: `dotnet build AlRunner/AlRunner.csproj`

- [ ] **Step 3: Commit**

```bash
git add AlRunner/Runtime/AlScope.cs
git commit -m "feat: expose GetHitStatements() for iteration tracking"
```

---

### Task 3: IterationInjector Roslyn Rewriter

**Files:**
- Create: `AlRunner/IterationInjector.cs`

This mirrors `ValueCaptureInjector.cs`. It's a `CSharpSyntaxRewriter` that wraps `for`, `while`, and `do-while` loops with tracking calls.

- [ ] **Step 1: Create IterationInjector.cs**

```csharp
// AlRunner/IterationInjector.cs
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AlRunner;

/// <summary>
/// Second-pass Roslyn rewriter that injects IterationTracker calls around loops.
/// Mirrors the ValueCaptureInjector pattern.
/// </summary>
public class IterationInjector : CSharpSyntaxRewriter
{
    private string? _currentScopeClass;
    private int _nextLoopIdHint;

    public static SyntaxNode Inject(SyntaxNode root)
    {
        var injector = new IterationInjector();
        return injector.Visit(root);
    }

    public override SyntaxNode? VisitClassDeclaration(ClassDeclarationSyntax node)
    {
        var name = node.Identifier.Text;
        var prev = _currentScopeClass;
        _currentScopeClass = name.Contains("_Scope") ? name : null;
        var result = base.VisitClassDeclaration(node);
        _currentScopeClass = prev;
        return result;
    }

    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    {
        if (_currentScopeClass == null) return base.VisitForStatement(node);
        return WrapLoop(node, node.Statement, (n, body) => n.WithStatement(body));
    }

    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    {
        if (_currentScopeClass == null) return base.VisitWhileStatement(node);
        return WrapLoop(node, node.Statement, (n, body) => n.WithStatement(body));
    }

    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    {
        if (_currentScopeClass == null) return base.VisitDoStatement(node);
        return WrapLoop(node, node.Statement, (n, body) => n.WithStatement(body));
    }

    /// <summary>
    /// Wraps a loop with EnterLoop/ExitLoop and injects EnterIteration/EndIteration in the body.
    /// </summary>
    private SyntaxNode WrapLoop<TLoop>(
        TLoop loopNode,
        StatementSyntax body,
        Func<TLoop, StatementSyntax, TLoop> withBody) where TLoop : StatementSyntax
    {
        // Visit children first (handles nested loops)
        loopNode = (TLoop)base.Visit(loopNode)!;
        body = GetBody(loopNode);

        var loopIdVar = $"__alr_loopId_{_nextLoopIdHint++}";

        // Extract source line hints from StmtHit calls in the loop body (approximate)
        var (startLine, endLine) = ExtractLineHints(loopNode);

        // Build: var __alr_loopId_N = AlRunner.Runtime.IterationTracker.EnterLoop(startLine, endLine);
        var enterLoop = SyntaxFactory.ParseStatement(
            $"var {loopIdVar} = AlRunner.Runtime.IterationTracker.EnterLoop({startLine}, {endLine});\n");

        // Build: AlRunner.Runtime.IterationTracker.EnterIteration(__alr_loopId_N);
        var enterIteration = SyntaxFactory.ParseStatement(
            $"AlRunner.Runtime.IterationTracker.EnterIteration({loopIdVar});\n");

        // Build: AlRunner.Runtime.IterationTracker.EndIteration(__alr_loopId_N);
        var endIteration = SyntaxFactory.ParseStatement(
            $"AlRunner.Runtime.IterationTracker.EndIteration({loopIdVar});\n");

        // Build: AlRunner.Runtime.IterationTracker.ExitLoop(__alr_loopId_N);
        var exitLoop = SyntaxFactory.ParseStatement(
            $"AlRunner.Runtime.IterationTracker.ExitLoop({loopIdVar});\n");

        // Inject enter/end iteration into the loop body
        var bodyBlock = body is BlockSyntax block
            ? block
            : SyntaxFactory.Block(body);

        var newStatements = new List<StatementSyntax>();
        newStatements.Add(enterIteration);
        newStatements.AddRange(bodyBlock.Statements);
        newStatements.Add(endIteration);

        var newBody = SyntaxFactory.Block(newStatements);
        var wrappedLoop = withBody(loopNode, newBody);

        // Wrap the entire loop in: enterLoop; try { loop } finally { exitLoop; }
        var tryFinally = SyntaxFactory.TryStatement(
            SyntaxFactory.Block(SyntaxFactory.SingletonList<StatementSyntax>(wrappedLoop)),
            SyntaxFactory.List<CatchClauseSyntax>(),
            SyntaxFactory.FinallyClause(SyntaxFactory.Block(exitLoop)));

        // Return block: { enterLoop; try { loop } finally { exitLoop; } }
        return SyntaxFactory.Block(enterLoop, tryFinally);
    }

    private static StatementSyntax GetBody<TLoop>(TLoop node) where TLoop : StatementSyntax
    {
        return node switch
        {
            ForStatementSyntax f => f.Statement,
            WhileStatementSyntax w => w.Statement,
            DoStatementSyntax d => d.Statement,
            _ => throw new InvalidOperationException($"Unexpected loop type: {node.GetType()}")
        };
    }

    /// <summary>
    /// Try to extract AL source line hints from StmtHit calls near the loop.
    /// Falls back to 0 if not found.
    /// </summary>
    private static (int startLine, int endLine) ExtractLineHints(SyntaxNode node)
    {
        // Look for StmtHit(N) calls in descendants — use min and max as line range hints
        var stmtHitIds = new List<int>();
        foreach (var invocation in node.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is IdentifierNameSyntax id &&
                (id.Identifier.Text == "StmtHit" || id.Identifier.Text == "CStmtHit") &&
                invocation.ArgumentList.Arguments.Count == 1 &&
                invocation.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax literal &&
                literal.Token.Value is int stmtId)
            {
                stmtHitIds.Add(stmtId);
            }
        }

        if (stmtHitIds.Count == 0) return (0, 0);
        return (stmtHitIds.Min(), stmtHitIds.Max());
    }
}
```

**NOTE:** The `ExtractLineHints` method uses StmtHit IDs as a proxy for source lines. The actual AL source line mapping depends on the statement map maintained by the transpiler. The implementer should verify this approach works by checking a transpiled loop's StmtHit IDs. If StmtHit IDs don't correlate to AL source lines, an alternative approach will be needed (e.g., using the Roslyn syntax tree's line numbers from the original AL source mapping).

- [ ] **Step 2: Verify it compiles**

Run: `dotnet build AlRunner/AlRunner.csproj`

- [ ] **Step 3: Commit**

```bash
git add AlRunner/IterationInjector.cs
git commit -m "feat: add IterationInjector Roslyn rewriter for loop tracking"
```

---

### Task 4: Wire into Pipeline.cs

**Files:**
- Modify: `AlRunner/Pipeline.cs`

- [ ] **Step 1: Add IterationTracking to PipelineOptions**

In `PipelineOptions` class (around line 9), add:

```csharp
public bool IterationTracking { get; set; }
```

- [ ] **Step 2: Add IterationInjector pass to rewriting pipeline**

In the `Parallel.For` block that does rewriting (around line 385), add the IterationInjector as a third pass after ValueCaptureInjector:

```csharp
    var tree = RoslynRewriter.RewriteToTree(code);
    var injectedRoot = ValueCaptureInjector.Inject(tree.GetRoot());
    if (options.IterationTracking)
    {
        injectedRoot = IterationInjector.Inject(injectedRoot);
    }
    tree = CSharpSyntaxTree.Create((CSharpSyntaxNode)injectedRoot);
```

- [ ] **Step 3: Add IterationTracker enable/reset/disable**

In the execution section (around lines 452-471), add alongside ValueCapture and MessageCapture:

```csharp
if (options.IterationTracking)
{
    Runtime.IterationTracker.Reset();
    Runtime.IterationTracker.Enable();
}
```

And after execution:

```csharp
if (options.IterationTracking)
    Runtime.IterationTracker.Disable();
```

- [ ] **Step 4: Collect iteration results**

After collecting capturedValues (around line 104-115), add:

```csharp
List<Runtime.IterationTracker.LoopRecord>? iterationLoops = null;
if (options.IterationTracking)
{
    iterationLoops = Runtime.IterationTracker.GetLoops();
}
```

- [ ] **Step 5: Add iterations to SerializeJsonOutput**

Update the `SerializeJsonOutput` method signature to accept iterations:

```csharp
public static string SerializeJsonOutput(
    List<TestResult> tests, int exitCode,
    bool indented = true,
    List<CapturedValue>? capturedValues = null,
    List<string>? messages = null,
    List<Runtime.IterationTracker.LoopRecord>? iterations = null)
```

Add iterations serialization to the anonymous object:

```csharp
    iterations = iterations?.Count > 0
        ? iterations.Select(loop => new
        {
            loopId = $"L{loop.LoopId}",
            loopLine = loop.SourceStartLine,
            loopEndLine = loop.SourceEndLine,
            parentLoopId = loop.ParentLoopId.HasValue ? $"L{loop.ParentLoopId}" : null,
            parentIteration = loop.ParentIteration,
            iterationCount = loop.IterationCount,
            steps = loop.Steps.Select(step => new
            {
                iteration = step.Iteration,
                capturedValues = step.CapturedValues.Select(cv => new
                {
                    variableName = cv.VariableName,
                    value = cv.Value
                }),
                messages = step.Messages,
                linesExecuted = step.LinesExecuted
            })
        })
        : null,
```

- [ ] **Step 6: Pass iterations through all SerializeJsonOutput call sites**

Find all calls to `SerializeJsonOutput` in Pipeline.cs and Program.cs and add the `iterations` parameter.

- [ ] **Step 7: Verify it compiles**

Run: `dotnet build AlRunner/AlRunner.csproj`

- [ ] **Step 8: Commit**

```bash
git add AlRunner/Pipeline.cs
git commit -m "feat: wire IterationTracker into pipeline with enable/reset/disable"
```

---

### Task 5: Add CLI Flag

**Files:**
- Modify: `AlRunner/Program.cs`

- [ ] **Step 1: Add --iteration-tracking flag**

In the CLI argument parsing switch (around line 59-130), add:

```csharp
case "--iteration-tracking":
    options.IterationTracking = true;
    argIdx++;
    break;
```

- [ ] **Step 2: Verify it compiles and runs**

Run: `dotnet build AlRunner/AlRunner.csproj`
Then: `dotnet run --project AlRunner -- --help` (if help exists, verify flag is listed)

- [ ] **Step 3: Commit**

```bash
git add AlRunner/Program.cs
git commit -m "feat: add --iteration-tracking CLI flag"
```

---

### Task 6: Integration Test

**Files:**
- Create: `tests/20-iteration-tracking/Test.al`
- Create: `tests/20-iteration-tracking/app.json` (if needed by test runner)

- [ ] **Step 1: Create test AL file with loops**

```al
codeunit 50020 "TestIterationTracking"
{
    Subtype = Test;

    [Test]
    procedure TestSimpleLoop()
    var
        i: Integer;
        Total: Integer;
    begin
        Total := 0;
        for i := 1 to 5 do begin
            Total += i;
            Message(Format(Total));
        end;
        // Total should be 15
        LibraryAssert.AreEqual(15, Total, 'Sum should be 15');
    end;

    [Test]
    procedure TestNestedLoop()
    var
        i: Integer;
        j: Integer;
        Product: Integer;
    begin
        for i := 1 to 3 do
            for j := 1 to 2 do begin
                Product := i * j;
                Message(Format(Product));
            end;
    end;

    [Test]
    procedure TestLoopWithBranch()
    var
        i: Integer;
    begin
        for i := 1 to 4 do
            if i mod 2 = 0 then
                Message('even: ' + Format(i))
            else
                Message('odd: ' + Format(i));
    end;
}
```

- [ ] **Step 2: Run with iteration tracking**

```bash
dotnet run --project AlRunner -- --output-json --capture-values --iteration-tracking --coverage tests/20-iteration-tracking
```

Verify the JSON output contains an `iterations` array with the expected structure.

- [ ] **Step 3: Verify the output**

Check that:
- Simple loop: 5 iterations, each with correct `Total` value and message
- Nested loop: outer loop with 3 iterations, inner loop entries with `parentLoopId` set
- Branch loop: different `linesExecuted` for even vs odd iterations

- [ ] **Step 4: Commit**

```bash
git add tests/20-iteration-tracking/
git commit -m "test: add integration test for iteration tracking"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | IterationTracker static collector | Create `Runtime/IterationTracker.cs` |
| 2 | Expose AlScope hit statements | Modify `Runtime/AlScope.cs` |
| 3 | IterationInjector Roslyn rewriter | Create `IterationInjector.cs` |
| 4 | Wire into Pipeline | Modify `Pipeline.cs` |
| 5 | CLI flag | Modify `Program.cs` |
| 6 | Integration test | Create `tests/20-iteration-tracking/` |

**After all tasks:** The AL.Runner accepts `--iteration-tracking` and emits `iterations[]` in the JSON output. ALchemist's extension (already built on the `feat/iteration-navigation` branch) will automatically detect and use this data when present.

**To submit upstream:** Create a PR to `StefanMaron/BusinessCentral.AL.Runner` with these changes, similar to the MessageCapture PR #2 that was previously merged.
