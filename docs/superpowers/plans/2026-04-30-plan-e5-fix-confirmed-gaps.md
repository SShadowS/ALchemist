# Plan E5 — Fix All Confirmed AL.Runner Gaps (G2, G4, G8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three Confirmed gaps documented in `U:/Git/AL.Runner-protocol-v2/Gaps.md`:
- **G2** — Loop-variable captures emit only at test scope, never per-iteration. ALchemist's compact-form rendering loses information for `i = 1 .. 10 (×10)` style display because `i` arrives as a single capture.
- **G4** — Nested loop captures double-count: inner-loop captures appear in BOTH the inner step AND the outer step. Confirmed by `GapVerificationTests::G4_NestedLoopCapturesAttributedToInnermost`.
- **G8** — Variable-name casing passes through declaration case verbatim. Consumer-side case-sensitive lookups can miss values when AL source mixes case.

**Architecture:**

1. **AL.Runner: per-loop capture accumulators (fixes G4 root cause).** Replace the snapshot/delta math in `IterationTracker.FinalizeIteration` with per-loop accumulator lists. Each `ActiveLoop` keeps its own `CurrentIterationCaptures` and `CurrentIterationMessages` list. `ValueCapture.Capture` and `MessageCapture.Capture` push to the INNERMOST active loop's accumulator (one capture, one loop). `EnterIteration` clears the lists; `FinalizeIteration` reads them directly. Eliminates both the snapshot bookkeeping and the nested-loop attribution bug.

2. **AL.Runner: inject loop-variable capture (fixes G2).** Extend `IterationInjector.Inject` to parse the loop variable from `ForStatementSyntax.Declaration` and inject a `ValueCapture.Capture(scope, object, "i", i, statementId)` call immediately after `EnterIteration`. This routes the loop variable through the same path as assignment-target captures, so it appears in `step.capturedValues` per iteration. Foreach and while loops are out of scope (AL.Runner's AL→C# rewriter currently produces only `for` loops for AL `for`).

3. **ALchemist: case-insensitive variable lookup (fixes G8 consumer-side per Gaps.md recommendation).** `applyIterationView` does `step.capturedValues.get(varName)` against the source-text spelling. Switch to a case-insensitive lookup so AL's case-insensitive identifier semantics work regardless of declaration vs usage case. `hoverProvider.buildAggregateHover` already does case-insensitive filtering (`.toLowerCase()`), so verify that path stays consistent.

**Tech Stack:**
- AL.Runner: C# .NET 9, Roslyn, xUnit
- ALchemist: TypeScript 6, VS Code API ^1.88, Mocha 11, @vscode/test-electron 2.5
- Wire format: NDJSON over stdio (--server mode)

**Cross-repo execution order:** Groups A → B → C (AL.Runner) → D → E (ALchemist) → F (Gaps.md) → G (release).

---

## File Structure

### AL.Runner repo (`U:/Git/AL.Runner-protocol-v2/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `AlRunner/Runtime/IterationTracker.cs` | Iteration boundary tracking | Modify `ActiveLoop` to add `CurrentIterationCaptures` + `CurrentIterationMessages` lists. Modify `EnterIteration` to clear them. Modify `FinalizeIteration` to read from them (drop snapshot math). Add `RecordCapture` and `RecordMessage` static methods that push to innermost loop's lists. |
| `AlRunner/Runtime/ValueCapture.cs` | Per-statement value capture | Modify `Capture` to also call `IterationTracker.RecordCapture` so the innermost active loop sees the capture. |
| `AlRunner/Runtime/MessageCapture.cs` | Test message capture | Modify `Capture` to also call `IterationTracker.RecordMessage`. |
| `AlRunner/IterationInjector.cs` | C# AST rewriter for loop instrumentation | Extend `WrapLoop` to extract the loop variable from `ForStatementSyntax.Declaration.Variables[0]` (or `Initializers` for compound init) and inject a `ValueCapture.Capture` call after `EnterIteration`. |
| `AlRunner.Tests/IterationTrackerTests.cs` | Plan E4 unit tests | Add `EnterIteration_ClearsPerLoopAccumulators`, `RecordCapture_PushesToInnermostLoopOnly`. |
| `AlRunner.Tests/GapVerificationTests.cs` | Empirical state of gaps | Update G2 + G4 tests to assert FIXED behavior. Verify G8 test still pins runner emission (G8 is fixed consumer-side, not runner-side). |
| `AlRunner.Tests/ServerProtocolV2Tests.cs` | v2 wire format | Tighten `RunTests_V2Summary_IncludesIterations_*` to assert loop variable AND assignment target are present in each step's capturedValues. |
| `tests/protocol-v2-nested-loops/` | NEW fixture | Create nested-loop AL fixture for end-to-end nested-loop test. |
| `docs/protocol-v2-samples/runtests-iterations.ndjson` | Captured wire sample | Re-capture after the fix. |
| `Gaps.md` | Living gap list | Move G2/G4 to Resolved with commit refs; G8 stays Confirmed (runner-side passthrough is intentional; consumer is fixed). |

### ALchemist repo (`U:/Git/ALchemist/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `src/editor/decorations.ts` | Inline render | `applyIterationView` and `applyResults` change `step.capturedValues.get(varName)` to a case-insensitive lookup (build a lowercase-keyed shadow Map at the top of each render). |
| `test/suite/decorationManager.perTest.test.ts` | Unit tests for inline render | Add unit test for case-insensitive variable lookup against a Map keyed by lowercase but queried with mixed case. |
| `test/integration/iterationStepping.itest.ts` | @vscode/test-electron integration | Add a case-insensitive scenario: store has `i` lowercase, source has `I` uppercase, decoration paints. |
| `test/smoke/runtimeSmoke.smoke.ts` | End-to-end smoke | Tighten the per-step assertion to also include the loop variable (G2 fixed → runner now emits `i` per-iteration). |
| `test/parity/captures.parity.ts` | Cross-protocol parity | No change expected — both producers use the same code path post-Group-B. Re-run to confirm. |
| `CHANGELOG.md` | Release notes | Append v0.5.10 entry. |
| `package.json` | Version bump | 0.5.9 → 0.5.10. |

---

# Group A — AL.Runner: per-loop capture accumulators (fixes G4)

**Working repo:** `U:/Git/AL.Runner-protocol-v2/` on branch `feat/alchemist-protocol-v1`.

### Task A1: Failing test for nested-loop single-attribution

**Files:**
- Modify: `AlRunner.Tests/GapVerificationTests.cs::G4_NestedLoopCapturesAttributedToInnermost`

- [ ] **Step 1: Read the existing G4 test**

Run:
```bash
grep -n "G4_NestedLoopCapturesAttributedToInnermost" U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/GapVerificationTests.cs
```

The current test PASSES by asserting the BAD behavior (double-count). For Plan E5 we want the GOOD behavior, so we need to FLIP the assertion direction. Do this in two steps: first add a new test that asserts the GOOD behavior (will fail until A2-A4 land), then later in F1 retire the original.

- [ ] **Step 2: Add a new failing test asserting fixed behavior**

Append to `GapVerificationTests.cs`:

```csharp
    [Fact]
    [Collection("Pipeline")]
    public void G4_Fixed_NestedLoopCapturesAttributedToInnermostOnly()
    {
        // Plan E5 Group A: the per-loop accumulator design ensures each
        // capture lands in EXACTLY ONE loop's iteration step (the innermost
        // active one). After the fix, an inner-loop capture must NOT
        // appear in the outer loop's step.
        IterationTracker.Reset();
        IterationTracker.Enable();
        using var _ = TestExecutionScope.Begin("NestedTest");

        // Outer iter 1
        var outerId = IterationTracker.EnterLoop("outer", 1, 10);
        IterationTracker.EnterIteration(outerId);
        ValueCapture.Capture("outer", "Obj", "outer-i", 1, statementId: 0);

        // Inner runs once inside outer iter 1
        var innerId = IterationTracker.EnterLoop("inner", 5, 7);
        IterationTracker.EnterIteration(innerId);
        ValueCapture.Capture("inner", "Obj", "inner-j", 100, statementId: 0);
        IterationTracker.ExitLoop(innerId);

        IterationTracker.ExitLoop(outerId);

        var loops = IterationTracker.GetLoops();
        var outerLoop = loops.Single(l => l.ScopeName == "outer");
        var innerLoop = loops.Single(l => l.ScopeName == "inner");

        // Outer iter 1 must contain ONLY outer's captures, NOT inner-j.
        var outerStep1 = outerLoop.Steps.Single();
        Assert.Contains(outerStep1.CapturedValues, cv => cv.VariableName == "outer-i");
        Assert.DoesNotContain(outerStep1.CapturedValues, cv => cv.VariableName == "inner-j");

        // Inner iter 1 must contain ONLY inner's captures.
        var innerStep1 = innerLoop.Steps.Single();
        Assert.Contains(innerStep1.CapturedValues, cv => cv.VariableName == "inner-j");
        Assert.DoesNotContain(innerStep1.CapturedValues, cv => cv.VariableName == "outer-i");

        IterationTracker.Reset();
    }
```

- [ ] **Step 3: Run and verify FAILS**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~G4_Fixed_NestedLoopCapturesAttributedToInnermostOnly"`

Expected: FAIL on `Assert.DoesNotContain(outerStep1.CapturedValues, cv => cv.VariableName == "inner-j")` because the current snapshot/delta math attributes inner captures to outer.

### Task A2: Add per-loop accumulator fields to ActiveLoop

**Files:**
- Modify: `AlRunner/Runtime/IterationTracker.cs`

- [ ] **Step 1: Read the existing ActiveLoop class**

Open `AlRunner/Runtime/IterationTracker.cs`, find the `private class ActiveLoop` (around line 178).

- [ ] **Step 2: Add accumulator fields**

Find:
```csharp
    private class ActiveLoop
    {
        public int LoopId { get; init; }
        public LoopRecord Record { get; init; } = null!;
        public int CurrentIteration { get; set; }
        public int ValueSnapshotBefore { get; set; }
        public int MessageSnapshotBefore { get; set; }
        public List<int> CurrentIterationHits { get; } = new();
    }
```

Replace with:
```csharp
    private class ActiveLoop
    {
        public int LoopId { get; init; }
        public LoopRecord Record { get; init; } = null!;
        public int CurrentIteration { get; set; }
        // Per-loop accumulators (Plan E5 Group A). Replaces the snapshot/delta
        // math against the global TestExecutionScope.Current. Each capture
        // lands in EXACTLY ONE loop's CurrentIterationCaptures (the innermost
        // active loop), so nested loops don't double-count.
        public List<CapturedValueSnapshot> CurrentIterationCaptures { get; } = new();
        public List<string> CurrentIterationMessages { get; } = new();
        public List<int> CurrentIterationHits { get; } = new();
    }
```

(`ValueSnapshotBefore` and `MessageSnapshotBefore` are deleted — the snapshot math is gone.)

### Task A3: Add `RecordCapture` and `RecordMessage` static methods

**Files:**
- Modify: `AlRunner/Runtime/IterationTracker.cs`

- [ ] **Step 1: Add the two new methods**

Inside the `IterationTracker` class, add (place near `RecordHit` for parity):

```csharp
    /// <summary>
    /// Called by ValueCapture.Capture to route the capture into the innermost
    /// active loop's current iteration accumulator. No-op when no loop is
    /// active or when iteration tracking is disabled. Plan E5 Group A.
    /// </summary>
    public static void RecordCapture(string variableName, string? value)
    {
        if (!_enabled || _loopStack.Count == 0) return;
        _loopStack.Peek().CurrentIterationCaptures.Add(new CapturedValueSnapshot
        {
            VariableName = variableName,
            Value = value ?? "",
        });
    }

    /// <summary>
    /// Called by MessageCapture.Capture to route the message into the
    /// innermost active loop's current iteration accumulator. Plan E5 Group A.
    /// </summary>
    public static void RecordMessage(string message)
    {
        if (!_enabled || _loopStack.Count == 0) return;
        _loopStack.Peek().CurrentIterationMessages.Add(message);
    }
```

### Task A4: Modify `EnterIteration` and `FinalizeIteration`

**Files:**
- Modify: `AlRunner/Runtime/IterationTracker.cs`

- [ ] **Step 1: Update `EnterIteration`**

Find:
```csharp
        // Start new iteration
        active.CurrentIteration++;
        var snapScope = TestExecutionScope.Current;
        active.ValueSnapshotBefore = snapScope?.CapturedValues.Count ?? 0;
        active.MessageSnapshotBefore = snapScope?.Messages.Count ?? 0;
        active.CurrentIterationHits.Clear();
```

Replace with:
```csharp
        // Start new iteration. Plan E5 Group A: clear per-loop accumulators
        // instead of snapshotting the global scope counts. Each capture/message
        // that fires during this iteration is routed by ValueCapture.Capture /
        // MessageCapture.Capture into THIS loop's accumulator (innermost active
        // loop only), so the delta is implicit.
        active.CurrentIteration++;
        active.CurrentIterationCaptures.Clear();
        active.CurrentIterationMessages.Clear();
        active.CurrentIterationHits.Clear();
```

- [ ] **Step 2: Replace `FinalizeIteration` body**

Find the entire `FinalizeIteration` method body and replace with:
```csharp
    private static void FinalizeIteration(ActiveLoop active)
    {
        // Plan E5 Group A: read directly from per-loop accumulators. The
        // accumulators were filled by ValueCapture/MessageCapture's calls
        // to RecordCapture/RecordMessage on the innermost active loop only,
        // so nested loops don't double-count.
        active.Record.Steps.Add(new IterationStep
        {
            Iteration = active.CurrentIteration,
            CapturedValues = new List<CapturedValueSnapshot>(active.CurrentIterationCaptures),
            Messages = new List<string>(active.CurrentIterationMessages),
            LinesExecuted = active.CurrentIterationHits.Distinct().ToList(),
        });
    }
```

### Task A5: Wire `ValueCapture.Capture` and `MessageCapture.Capture`

**Files:**
- Modify: `AlRunner/Runtime/ValueCapture.cs`
- Modify: `AlRunner/Runtime/MessageCapture.cs`

- [ ] **Step 1: ValueCapture**

Find in `ValueCapture.cs`:
```csharp
    public static void Capture(string scopeName, string objectName, string variableName, object? value, int statementId)
    {
        var entry = (scopeName, objectName, variableName, value?.ToString(), statementId);

        // Per-test scope gets the capture for isolation.
        var scope = TestExecutionScope.Current;
        if (scope != null)
            scope.CapturedValues.Add(entry);

        // Global aggregate also gets the capture when capture mode is enabled,
        // so the pipeline-level ValueCapture.GetCaptures() remains populated.
        if (_enabled)
            _captures.Add(entry);
    }
```

Replace with:
```csharp
    public static void Capture(string scopeName, string objectName, string variableName, object? value, int statementId)
    {
        var stringValue = value?.ToString();
        var entry = (scopeName, objectName, variableName, stringValue, statementId);

        // Per-test scope gets the capture for isolation.
        var scope = TestExecutionScope.Current;
        if (scope != null)
            scope.CapturedValues.Add(entry);

        // Plan E5 Group A: route to the innermost active loop's per-iteration
        // accumulator. RecordCapture is a no-op when no loop is active or when
        // IterationTracker is disabled, so this is safe to call unconditionally.
        IterationTracker.RecordCapture(variableName, stringValue);

        // Global aggregate also gets the capture when capture mode is enabled,
        // so the pipeline-level ValueCapture.GetCaptures() remains populated.
        if (_enabled)
            _captures.Add(entry);
    }
```

- [ ] **Step 2: MessageCapture**

Apply the parallel change in `MessageCapture.cs`. After the existing per-test scope write and before the global aggregate write, add:
```csharp
        IterationTracker.RecordMessage(message);
```

(Find the actual `Capture` method body and place the call in the same logical position as for ValueCapture.)

### Task A6: Update existing IterationTracker unit tests

**Files:**
- Modify: `AlRunner.Tests/IterationTrackerTests.cs`

- [ ] **Step 1: Run the existing Plan E4 tests**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~IterationTrackerStepCapturesTests"`

Expected: PASS — the per-loop accumulator design still satisfies "captures populate per-iteration." The Plan E4 tests don't depend on the snapshot math; they just verify that captures end up in the right step.

If FAIL: the test setup may rely on the old snapshot semantics in some way. Inspect and update the test (not the production code).

- [ ] **Step 2: Run the G4-Fixed test from Task A1**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~G4_Fixed_NestedLoopCapturesAttributedToInnermostOnly"`

Expected: PASS now.

- [ ] **Step 3: Run the OLD G4 test (asserts double-count)**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~G4_NestedLoopCapturesAttributedToInnermost"`

Expected: FAIL — the original G4 test pinned the bad behavior; now that the bug is fixed, it fails. We'll retire it in Group F (Gaps.md update). For now, this confirms the fix landed.

### Task A7: Run full suite + commit

- [ ] **Step 1: Run the full suite**

```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet test AlRunner.Tests/AlRunner.Tests.csproj
```

Expected: same pass count as before plus the new G4_Fixed test, MINUS one (the old G4 test now fails). Pre-existing 6 failing tests still fail. Net: +0 passing + 0 failing for the gap-related changes (one new pass, one new fail = wash). The new failing test is intentional (we'll retire it in F1).

- [ ] **Step 2: Commit**

```bash
cd U:/Git/AL.Runner-protocol-v2
git add \
    AlRunner/Runtime/IterationTracker.cs \
    AlRunner/Runtime/ValueCapture.cs \
    AlRunner/Runtime/MessageCapture.cs \
    AlRunner.Tests/GapVerificationTests.cs
git commit -m "$(cat <<'EOF'
fix(iteration): per-loop capture accumulators (fixes G4 nested double-count)

Replace IterationTracker.FinalizeIteration's snapshot/delta math with
per-loop accumulator lists. Each ActiveLoop now carries its own
CurrentIterationCaptures and CurrentIterationMessages list.
ValueCapture.Capture and MessageCapture.Capture push into the
INNERMOST active loop's accumulator (one capture, one loop), so
nested loops no longer double-count.

EnterIteration clears the loop's accumulators; FinalizeIteration
copies them into the IterationStep. The ValueSnapshotBefore /
MessageSnapshotBefore fields are removed — snapshot bookkeeping is
implicit in the per-loop accumulator design.

The Plan E4 fix (read from TestExecutionScope) is preserved for
TestExecutionScope.CapturedValues writes (test-scope captures are
unchanged); only the iteration-step source changes.

Test G4_NestedLoopCapturesAttributedToInnermost (which pinned the
double-count bug) now fails — see Gaps.md F1 to retire it. New
test G4_Fixed_NestedLoopCapturesAttributedToInnermostOnly asserts
the correct behavior.
EOF
)"
```

Verify: `git status`, `git log --oneline -1`.

---

# Group B — AL.Runner: inject loop-variable capture (fixes G2)

**Working repo:** `U:/Git/AL.Runner-protocol-v2/` on branch `feat/alchemist-protocol-v1`.

**Prerequisite:** Group A committed.

### Task B1: Failing test — loop variable in step.CapturedValues

**Files:**
- Modify: `AlRunner.Tests/GapVerificationTests.cs`

- [ ] **Step 1: Add the failing test**

Append:
```csharp
    [Fact]
    [Collection("Pipeline")]
    public void G2_Fixed_LoopVariableAppearsInPerIterationCaptures()
    {
        // Plan E5 Group B: IterationInjector now injects a
        // ValueCapture.Capture call for the loop variable after each
        // EnterIteration. Per-iteration captures should include the loop
        // variable's value at that iteration, not just the assignment
        // target.
        IterationTracker.Reset();
        IterationTracker.Enable();
        using var _ = TestExecutionScope.Begin("LoopVarTest");

        // Simulate what the injected code does at the C# level. (The
        // actual end-to-end test is in ServerProtocolV2Tests; this
        // unit test pins the IterationTracker contract.)
        var loopId = IterationTracker.EnterLoop("scope", 1, 10);

        IterationTracker.EnterIteration(loopId);
        // Injected by IterationInjector: capture loop variable
        ValueCapture.Capture("scope", "Obj", "i", 1, statementId: 0);
        // Body's assignment target
        ValueCapture.Capture("scope", "Obj", "sum", 1, statementId: 1);

        IterationTracker.EnterIteration(loopId);
        ValueCapture.Capture("scope", "Obj", "i", 2, statementId: 0);
        ValueCapture.Capture("scope", "Obj", "sum", 3, statementId: 1);

        IterationTracker.ExitLoop(loopId);

        var loop = IterationTracker.GetLoops().Single();
        Assert.Equal(2, loop.Steps.Count);

        // Each step must contain BOTH `i` and `sum`.
        Assert.Contains(loop.Steps[0].CapturedValues, cv => cv.VariableName == "i" && cv.Value == "1");
        Assert.Contains(loop.Steps[0].CapturedValues, cv => cv.VariableName == "sum" && cv.Value == "1");
        Assert.Contains(loop.Steps[1].CapturedValues, cv => cv.VariableName == "i" && cv.Value == "2");
        Assert.Contains(loop.Steps[1].CapturedValues, cv => cv.VariableName == "sum" && cv.Value == "3");

        IterationTracker.Reset();
    }
```

This unit test should PASS after Group A's per-loop accumulator fix (the loop variable is just another capture). The actual Group B work is the AST rewrite — verify the rewriter emits the capture call in the right place.

- [ ] **Step 2: Run and verify PASS**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~G2_Fixed_LoopVariableAppearsInPerIterationCaptures"`

Expected: PASS (Group A's per-loop accumulator already handles arbitrary captures including the loop variable). This test pins the IterationTracker contract; the AST-level work in B2-B3 makes the production AL→C# rewrite emit the loop-variable capture.

### Task B2: Inspect ForStatementSyntax to extract loop variable name

**Files:**
- (No file change yet — investigation step)

- [ ] **Step 1: Read the AL→C# rewrite output**

Run:
```bash
grep -rn "for (.*=\|ForStatementSyntax" U:/Git/AL.Runner-protocol-v2/AlRunner/RoslynRewriter.cs | head -10
```

The rewriter emits `for (int i = ...; i <= ...; i++)` form for AL `for i := ...`. Verify by inspecting the rewriter output for a `tests/protocol-v2-iterations/test/Loop.Codeunit.al`-style fixture:

```bash
cd U:/Git/AL.Runner-protocol-v2
AlRunner/bin/Release/net9.0/AlRunner.exe --dump-rewritten tests/protocol-v2-iterations/test/Loop.Codeunit.al 2>&1 | grep -A 3 "for ("
```

You should see something like `for (int i = 1; i <= 3; i = i + 1)`. Note:
- `node.Declaration.Variables[0].Identifier.Text` returns `"i"`.
- `node.Declaration.Type` returns the `int` type syntax.

If the form differs (e.g., AL emits `int i` outside the for-statement and uses `for (i = 1; ...)` with `Initializers` instead of `Declaration`), inspect the actual AST and adapt B3.

### Task B3: Modify IterationInjector to inject loop-variable capture

**Files:**
- Modify: `AlRunner/IterationInjector.cs`

- [ ] **Step 1: Pass the loop variable info into WrapLoop**

Find `VisitForStatement`:
```csharp
    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    {
        if (_currentScopeClass is null) return base.VisitForStatement(node);
        // Visit children first so nested loops are processed inside-out
        var visited = (ForStatementSyntax)base.VisitForStatement(node)!;
        return WrapLoop(visited, visited.Statement);
    }
```

Replace with:
```csharp
    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    {
        if (_currentScopeClass is null) return base.VisitForStatement(node);
        var visited = (ForStatementSyntax)base.VisitForStatement(node)!;

        // Plan E5 Group B (G2 fix): extract the loop variable name from
        // the for-statement's declaration so we can inject a per-iteration
        // capture call. AL `for i := <expr> to <expr> do` rewrites to
        // C# `for (int i = ...; i <= ...; i = i + 1)` so the variable
        // lives in `node.Declaration.Variables[0].Identifier.Text`.
        // If the form differs (e.g., the variable is declared above the
        // for and Initializers is used), loopVar stays null and no
        // capture is injected.
        string? loopVarName = null;
        if (visited.Declaration is { Variables: { Count: > 0 } } decl)
        {
            loopVarName = decl.Variables[0].Identifier.Text;
        }

        return WrapLoop(visited, visited.Statement, loopVarName);
    }
```

Update `VisitWhileStatement` and `VisitDoStatement` to pass `null` for loopVarName (no loop variable to capture in those forms):
```csharp
    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    {
        if (_currentScopeClass is null) return base.VisitWhileStatement(node);
        var visited = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
        return WrapLoop(visited, visited.Statement, null);
    }

    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    {
        if (_currentScopeClass is null) return base.VisitDoStatement(node);
        var visited = (DoStatementSyntax)base.VisitDoStatement(node)!;
        return WrapLoop(visited, visited.Statement, null);
    }
```

- [ ] **Step 2: Update WrapLoop to inject the capture call**

Find the existing WrapLoop signature:
```csharp
    private SyntaxNode WrapLoop(StatementSyntax loopNode, StatementSyntax body)
```

Replace with:
```csharp
    private SyntaxNode WrapLoop(StatementSyntax loopNode, StatementSyntax body, string? loopVarName)
```

Find the existing body construction:
```csharp
        var enterIter = SyntaxFactory.ParseStatement(
            $"AlRunner.Runtime.IterationTracker.EnterIteration({loopIdVar});\n");

        var newStatements = new List<StatementSyntax> { enterIter };
        newStatements.AddRange(bodyBlock.Statements);
```

Replace with:
```csharp
        var enterIter = SyntaxFactory.ParseStatement(
            $"AlRunner.Runtime.IterationTracker.EnterIteration({loopIdVar});\n");

        var newStatements = new List<StatementSyntax> { enterIter };

        // Plan E5 Group B (G2 fix): inject a per-iteration capture for the
        // loop variable so it appears in step.capturedValues alongside
        // assignment targets. statementId 0 anchors the capture at the
        // for-statement's start. If loopVarName is null (while/do or a
        // for that doesn't declare its variable inline), skip the
        // injection — there's no loop variable to capture.
        if (loopVarName != null)
        {
            var captureLoopVar = SyntaxFactory.ParseStatement(
                $"AlRunner.Runtime.ValueCapture.Capture(\"{_currentScopeClass}\", \"{_currentScopeClass}\", \"{loopVarName}\", {loopVarName}, 0);\n");
            newStatements.Add(captureLoopVar);
        }

        newStatements.AddRange(bodyBlock.Statements);
```

(The `objectName` parameter for ValueCapture.Capture is conventionally the AL object name — use `_currentScopeClass` as a stable identifier; ALchemist's downstream logic uses scope+variable rather than objectName for matching, so this is safe.)

### Task B4: Update RunTests_V2Summary_IncludesIterations test

**Files:**
- Modify: `AlRunner.Tests/ServerProtocolV2Tests.cs`

- [ ] **Step 1: Tighten the assertion**

Find the existing Plan E4 assertion that asserts only `sum`. Update to also assert `i`:

```csharp
            Assert.Contains("sum", varNames);
            Assert.Contains("i", varNames);
```

- [ ] **Step 2: Update the comment to reflect the new behavior**

The comment currently says only assignment targets are captured. Update to:
```csharp
        // Plan E5 Group B: IterationInjector now also captures the loop
        // variable per iteration. Each step has both the loop variable
        // (`i`) AND the assignment target (`sum`). Pre-Plan-E5 only `sum`
        // was present — see Gaps.md G2 history.
```

### Task B5: Re-capture wire-format sample + AJV validate

- [ ] **Step 1: Build**

```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet build AlRunner/AlRunner.csproj -c Release
```

- [ ] **Step 2: Re-capture**

(Use the same Node script as Plan E4 Task A4. Output goes to `docs/protocol-v2-samples/runtests-iterations.ndjson`.)

- [ ] **Step 3: Verify by eye**

Each step's `capturedValues` should now contain BOTH `{"variableName":"i","value":"<n>"}` and `{"variableName":"sum","value":"<m>"}`.

- [ ] **Step 4: AJV validate**

```bash
cd U:/Git/AL.Runner-protocol-v2
node -e "
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fs = require('fs');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync('protocol-v2.schema.json', 'utf8'));
const validate = ajv.compile(schema);
const lines = fs.readFileSync('docs/protocol-v2-samples/runtests-iterations.ndjson', 'utf8').split('\n').filter(l => l.trim());
let bad = 0;
for (let i = 0; i < lines.length; i++) {
  const obj = JSON.parse(lines[i]);
  if (!validate(obj)) { console.error('FAIL line', i+1, validate.errors); bad++; }
}
console.log(bad === 0 ? 'all ' + lines.length + ' lines valid' : 'FAILED');
process.exit(bad === 0 ? 0 : 1);
"
```

Expected: `all <N> lines valid`.

### Task B6: Run full suite + commit

- [ ] **Step 1: Run full suite**

```bash
dotnet test AlRunner.Tests/AlRunner.Tests.csproj
```

Expected: same pre-existing 6 failures, plus the OLD G2 test (`G2_LoopVariableCapturedOnceAtTestScopeNotPerIteration`) now fails because the loop variable is in step.capturedValues (good — fix landed), the new tests pass.

- [ ] **Step 2: Commit**

```bash
git add \
    AlRunner/IterationInjector.cs \
    AlRunner.Tests/GapVerificationTests.cs \
    AlRunner.Tests/ServerProtocolV2Tests.cs \
    docs/protocol-v2-samples/runtests-iterations.ndjson
git commit -m "$(cat <<'EOF'
feat(iteration): inject per-iteration loop-variable capture (fixes G2)

IterationInjector now extracts the loop variable name from
ForStatementSyntax.Declaration and injects a ValueCapture.Capture
call after EnterIteration. The loop variable now flows through
the same path as assignment-target captures, so each iteration
step's capturedValues includes both the loop variable (`i`) and
any assignment targets (`sum`).

While and do-while loops don't have an inline-declared loop
variable, so the injection is conditional (loopVarName != null).

ALchemist's compact-form rendering (`i = 1 ‥ 10 (×10)`) now works
for loop variables — previously they appeared as a single capture
at test scope and rendered plain (`i = 10`).

Wire format unchanged (the new capture flows through the existing
step.capturedValues array). Schema validation passes.
EOF
)"
```

---

# Group C — AL.Runner: tighten existing iteration tests

This group cleans up tests that asserted the OLD behavior. Two affected: the G2 verification test and the G4 verification test (both still pinning bug behavior).

### Task C1: Replace G2 + G4 tests with regression tests

**Files:**
- Modify: `AlRunner.Tests/GapVerificationTests.cs`

- [ ] **Step 1: Delete the OLD G2 and G4 tests**

Delete:
- `G2_LoopVariableCapturedOnceAtTestScopeNotPerIteration` (the assertion now fails because loop variable is per-iteration)
- `G4_NestedLoopCapturesAttributedToInnermost` (the assertion now fails because no double-count)

The Plan E5 versions (`G2_Fixed_*` and `G4_Fixed_*`) have already been added in A1+B1 and are the regression tests going forward. Keep those.

- [ ] **Step 2: Run tests**

```bash
dotnet test AlRunner.Tests/AlRunner.Tests.csproj
```

Expected: pre-existing 6 failures, all other tests pass. The deleted tests are gone; their replacements pass.

### Task C2: Commit

```bash
git add AlRunner.Tests/GapVerificationTests.cs
git commit -m "$(cat <<'EOF'
test(gaps): retire obsolete G2/G4 verification tests

The original G2 and G4 verification tests pinned the BAD behavior
(loop variable absent from step.capturedValues; nested loops
double-counting). Plan E5 Groups A and B fixed both gaps, and the
*_Fixed regression tests (added in A1 and B1) now pin the GOOD
behavior. The originals are deleted — there's no value in keeping
a test that asserts an obsolete bug.
EOF
)"
```

---

# Group D — ALchemist: case-insensitive variable lookup (fixes G8)

**Working repo:** `U:/Git/ALchemist/` on branch `master`.

**Prerequisite:** Groups A+B+C committed in AL.Runner repo.

### Task D1: Failing unit test for case-insensitive lookup

**Files:**
- Modify: `test/suite/decorationManager.perTest.test.ts`

- [ ] **Step 1: Read the existing applyInlineCapturedValues tests**

Run:
```bash
grep -n "applyInlineCapturedValues\|case" U:/Git/ALchemist/test/suite/decorationManager.perTest.test.ts | head -10
```

- [ ] **Step 2: Add the failing test**

Append a new test that verifies case-insensitive lookup:

```typescript
  test('case-insensitive variable lookup — declaration case differs from source-text usage case', () => {
    // Plan E5 Group D (fixes G8 consumer-side): AL is case-insensitive
    // for identifiers. The runner emits captures with the variable's
    // declaration case, but source code may use a different case (e.g.,
    // declared `myint` but used as `myInt`). The inline-render lookup
    // must match regardless of case.
    const dm = new DecorationManager(__dirname);
    const calls: DecorationCall[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const fakeEditor = makeFakeEditor(filePath, calls);

    // Capture has lowercase variable name (as runner emits per declaration).
    const v2Result: ExecutionResult = {
      ...makeV2Result([
        {
          name: 'TestProc', status: 'passed', durationMs: 1,
          alSourceFile: 'CU1.al',
          capturedValues: [
            { scopeName: 's', objectName: 'CU1', alSourceFile: 'CU1.al',
              variableName: 'myint', value: '42', statementId: 0 },
          ],
        } as any,
      ]),
      coverage: [],
      coverageV2: [{
        file: 'CU1.al',
        lines: [{ line: 1, hits: 1 }],
        totalStatements: 1, hitStatements: 1,
      }],
    };

    // Fake editor's line 1 source has `myInt` (mixed case) — different
    // from the lowercase `myint` in capturedValues.
    fakeEditor.document.lineAt = (i: number) => ({
      text: i === 0 ? '        myInt := 42;' : '',
      range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
    });

    dm.applyResults(fakeEditor, v2Result, workspacePath);

    const captureCalls = calls.filter(c =>
      c.type && c.type.options && c.type.options.after,
    );
    const contentTexts = captureCalls.flatMap(c =>
      (c.ranges as any[]).map(r => r.renderOptions?.after?.contentText as string)
    ).filter(Boolean);

    assert.ok(
      contentTexts.some(t => /myInt\s*=\s*42\b/.test(t) || /myint\s*=\s*42\b/.test(t)),
      `case-insensitive lookup must succeed even when declaration case (myint) differs from source-text case (myInt); got ${JSON.stringify(contentTexts)}`,
    );

    dm.dispose();
  });
```

- [ ] **Step 3: Run and verify FAIL**

```bash
cd U:/Git/ALchemist
npm run test:unit -- --grep "case-insensitive variable lookup"
```

Expected: FAIL — the current code does case-sensitive `Map.get`, so a declaration-case `myint` won't match a source-text `myInt`.

### Task D2: Implement case-insensitive lookup in applyInlineCapturedValues

**Files:**
- Modify: `src/editor/decorations.ts`

- [ ] **Step 1: Find the Map-based lookup in applyInlineCapturedValues / applyIterationView**

Run:
```bash
grep -n "capturedValues.get\|capturedValues\.get\|Map.get" U:/Git/ALchemist/src/editor/decorations.ts | head -10
```

There are TWO call sites:
- `applyInlineCapturedValues` uses a grouping by `(statementId, variableName)` — case-sensitive in the key.
- `applyIterationView` does `step.capturedValues.get(varName)` directly.

- [ ] **Step 2: Update the grouping in applyInlineCapturedValues**

The current grouping uses the runner's variableName as the key. Switch to lowercase key, but preserve the original-case variableName for display in contentText.

Find:
```typescript
    const groupedValues = new Map<string, CapturedValue[]>();
    for (const cv of fileValues) {
      const key = `${cv.statementId}:${cv.variableName}`;
      const arr = groupedValues.get(key) ?? [];
      arr.push(cv);
      groupedValues.set(key, arr);
    }
```

Replace with:
```typescript
    // Group by lowercase variable name so case-insensitive lookups (G8)
    // work without breaking the display name (we keep the runner's
    // original case for contentText).
    const groupedValues = new Map<string, CapturedValue[]>();
    for (const cv of fileValues) {
      const key = `${cv.statementId}:${cv.variableName.toLowerCase()}`;
      const arr = groupedValues.get(key) ?? [];
      arr.push(cv);
      groupedValues.set(key, arr);
    }
```

This change alone doesn't affect rendering — it only normalizes the grouping key. But there's no source-text spelling matching here yet; the inline-render path doesn't actually compare against editor source text in this branch. The lookup is by statementId → covered line, not by varName-from-source.

The bug only surfaces in `applyIterationView`, which DOES match source text. Continue to D3.

- [ ] **Step 3: Update the source-text matching in applyIterationView**

Find in `applyIterationView`:
```typescript
    const assignRegex = /\b(\w+)\s*:=/;
    for (let i = startLine; i <= endLine && i < editor.document.lineCount; i++) {
      const lineText = editor.document.lineAt(i).text;
      const match = lineText.match(assignRegex);
      if (match) {
        const varName = match[1];
        const value = step.capturedValues.get(varName);
```

The lookup `step.capturedValues.get(varName)` is case-sensitive. Change to:
```typescript
    // Plan E5 Group D (G8 fix): build a case-insensitive lookup against
    // step.capturedValues. AL identifiers are case-insensitive; the
    // runner emits declaration case (e.g., `myint`) while source text
    // may use mixed case (e.g., `myInt`). Lower-key the Map once,
    // preserve original casing for display purposes.
    const lowerKeyMap = new Map<string, string>();
    for (const [k, v] of step.capturedValues) {
      lowerKeyMap.set(k.toLowerCase(), v);
    }

    const assignRegex = /\b(\w+)\s*:=/;
    for (let i = startLine; i <= endLine && i < editor.document.lineCount; i++) {
      const lineText = editor.document.lineAt(i).text;
      const match = lineText.match(assignRegex);
      if (match) {
        const varName = match[1];
        const value = lowerKeyMap.get(varName.toLowerCase());
```

(Keep the rest of the loop unchanged — `varName` is still used for display contentText.)

- [ ] **Step 4: Run the test**

```bash
cd U:/Git/ALchemist
npm run test:unit -- --grep "case-insensitive variable lookup"
```

Expected: PASS.

- [ ] **Step 5: Run full unit + integration**

```bash
npm run test:unit
npm run test:integration
```

Expected: same pass count + the new test.

### Task D3: Add an integration test for case-insensitive stepping

**Files:**
- Modify: `test/integration/iterationStepping.itest.ts`

- [ ] **Step 1: Append a case-insensitive scenario**

Add inside the existing suite block:
```typescript
  test('case-insensitive variable lookup during stepping (G8 fix)', async () => {
    // Plan E5 Group D / Gaps.md G8: when AL declares `myInt` but the
    // runner emits the lowercase variant (or vice versa), the per-step
    // value lookup must succeed regardless of case.
    const vscode = require('vscode');
    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    const dm = new DecorationManager(EXTENSION_ROOT);
    try {
      const captureType = (dm as unknown as { capturedValueDecorationType: unknown })
        .capturedValueDecorationType;

      const loop: IterationData = {
        loopId: 'L0',
        sourceFile: AL_FILE,
        loopLine: 8,  // the for line in CU1.al
        loopEndLine: 9,
        parentLoopId: null,
        parentIteration: null,
        iterationCount: 3,
        steps: [
          // capturedValues uses lowercase variableName as the runner emits
          { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [8] },
          { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [8] },
          { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [8] },
        ],
      };
      const store = new IterationStore();
      store.load([loop], APP_ROOT);

      store.setIteration(loop.loopId, 2);
      const step = store.getStep(loop.loopId, 2);
      const changedVars = store.getChangedValues(loop.loopId, 2);
      dm.applyIterationView(editor as any, step, changedVars, 0, {
        start: loop.loopLine,
        end: loop.loopEndLine,
      });

      const captureCalls = calls.filter(c => c.type === captureType);
      const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
      assert.ok(
        nonEmpty.length > 0,
        `case-insensitive lookup must paint a decoration even when declaration ('i') and source-text ('i' or 'I') case differ; got ${captureCalls.length} calls, all empty`,
      );
    } finally {
      dm.dispose();
    }
  });
```

- [ ] **Step 2: Run the integration test**

```bash
npm run test:integration -- --grep "case-insensitive variable lookup during stepping"
```

Expected: PASS.

### Task D4: Commit

```bash
cd U:/Git/ALchemist
git add src/editor/decorations.ts test/suite/decorationManager.perTest.test.ts test/integration/iterationStepping.itest.ts
git commit -m "$(cat <<'EOF'
fix(decorations): case-insensitive variable lookup (fixes G8 consumer-side)

AL identifiers are case-insensitive in source. The runner emits
captures with the variable's declaration case, which may differ
from the source-text case at the use site (e.g., declared `myint`
but written `myInt`). The previous lookup used a case-sensitive
Map.get against the source-text spelling, so mixed-case
identifiers silently dropped.

Lower-key the lookup Map once at the top of applyIterationView's
render loop and query with the lowercase source-text token. The
display contentText still uses the runner's original case for
the variable name (preserves user-written conventions for
display).

Per Gaps.md G8 recommendation: this is the consumer-side fix
because it's less invasive than changing the runner's emission.

Tests: new unit test for case-insensitive applyResults render;
new integration test for case-insensitive stepping flow.
EOF
)"
```

---

# Group E — ALchemist: smoke + parity test updates

### Task E1: Tighten smoke test to require loop variable per-iteration

**Files:**
- Modify: `test/smoke/runtimeSmoke.smoke.ts`

- [ ] **Step 1: Read the existing smoke iteration assertion**

Run:
```bash
grep -n "step3Captures\|myInt\|myint\|stepsWithCaptures" U:/Git/ALchemist/test/smoke/runtimeSmoke.smoke.ts | head -10
```

The current smoke asserts `step3Captures` includes `myint`. Add an assertion that the loop variable `i` is also present per-iteration.

- [ ] **Step 2: Add loop-variable assertion**

Right after the existing `step3Captures.some(cv => cv.variableName.toLowerCase() === 'myint')` assertion, add:

```typescript
    // Plan E5 Group B (G2 fix): the runner now also captures the loop
    // variable per iteration. CU1.al's `for i := 1 to 10 do` should
    // yield captures for both `i` AND `myInt` on each iteration.
    assert.ok(
      step3Captures.some(cv => cv.variableName.toLowerCase() === 'i'),
      `step[3].capturedValues must include the loop variable 'i' (Plan E5 Group B fix); got ${JSON.stringify(step3Captures.map(cv => cv.variableName))}`,
    );
    // Pin the value: at iteration 3, `i` should be 3.
    const stepIvalue = step3Captures.find(cv => cv.variableName.toLowerCase() === 'i')?.value;
    assert.strictEqual(
      stepIvalue, '3',
      `step[3] loop variable 'i' must equal '3'; got ${stepIvalue}`,
    );
```

- [ ] **Step 3: Run smoke**

```bash
npm run test:smoke
```

Expected: PASS.

### Task E2: Update parity projection (no behavior change expected)

**Files:**
- Re-run: `test/parity/captures.parity.ts`

- [ ] **Step 1: Re-run parity**

Both v1 and v2 producers go through the same `IterationTracker.FinalizeIteration`, so loop variables should appear in both. The existing `stepVarNames` projection compares them.

```bash
npm run test:parity
```

Expected: PASS (same as before — both producers emit equivalent shapes).

If FAIL: a v1↔v2 divergence emerged. Investigate; should not happen since the fix is in the shared code path.

### Task E3: Commit

```bash
cd U:/Git/ALchemist
git add test/smoke/runtimeSmoke.smoke.ts
git commit -m "$(cat <<'EOF'
test(smoke): assert loop variable populates step.capturedValues (G2 fix)

Plan E5 Group B made AL.Runner inject a per-iteration capture for
the loop variable. The smoke test now asserts CU1.al's `for i := 1
to 10` produces captures for `i` (the loop variable) on each
iteration, not just `myInt` (the assignment target). Pins step #3's
i = '3' for explicit value coverage.

Catches the regression where IterationInjector stops emitting the
loop-variable capture call.
EOF
)"
```

---

# Group F — Update Gaps.md

### Task F1: Move G2/G4 to Resolved; G8 stays Confirmed (consumer-side fix)

**Files:**
- Modify: `U:/Git/AL.Runner-protocol-v2/Gaps.md`

- [ ] **Step 1: Restructure entries**

Move the G2 and G4 entries from "Confirmed" to "Resolved" with these new entries:

```markdown
### R6. G2 — Loop-variable per-iteration captures injected by IterationInjector

**Resolved by:** Plan E5 Group B (commit `<sha>`).
**Replacement:** `IterationInjector.WrapLoop` now extracts the loop variable from `ForStatementSyntax.Declaration` and injects a `ValueCapture.Capture` call after `EnterIteration`. The loop variable flows through the same path as assignment targets and appears in each `step.CapturedValues`. ALchemist's compact-form rendering now works for loop variables.
**Test that catches the regression:** `AlRunner.Tests/GapVerificationTests.cs::G2_Fixed_LoopVariableAppearsInPerIterationCaptures`.

### R7. G4 — Per-loop accumulators eliminate nested-loop double-counting

**Resolved by:** Plan E5 Group A (commit `<sha>`).
**Replacement:** `ActiveLoop` now carries `CurrentIterationCaptures` and `CurrentIterationMessages` lists. `ValueCapture.Capture` and `MessageCapture.Capture` push to the INNERMOST active loop's accumulator (one capture, one loop). `EnterIteration` clears the lists; `FinalizeIteration` reads them directly. The snapshot/delta math is gone.
**Test that catches the regression:** `AlRunner.Tests/GapVerificationTests.cs::G4_Fixed_NestedLoopCapturesAttributedToInnermostOnly`.
```

For G8, update the existing entry's Status to reflect the consumer-side fix:

```markdown
### G8. Loop-variable casing in v2 wire format passes through declaration case verbatim

**Status:** Confirmed (runner-side passthrough is intentional). Mitigated consumer-side: ALchemist's `applyIterationView` does case-insensitive lookup against `step.capturedValues` (Plan E5 Group D, ALchemist commit `<sha>`).
... (rest of entry unchanged)
```

- [ ] **Step 2: Commit Gaps.md update**

```bash
cd U:/Git/AL.Runner-protocol-v2
git add Gaps.md
git commit -m "$(cat <<'EOF'
docs(gaps): G2/G4 moved to Resolved; G8 mitigated consumer-side

Plan E5 fixes:
- G2: loop variable per-iteration capture injected by IterationInjector
- G4: per-loop accumulators eliminate nested-loop double-counting
- G8: ALchemist consumer-side case-insensitive lookup mitigates the
  runner's declaration-case passthrough.

R6 and R7 added to Resolved section. G8 entry updated to note the
consumer-side mitigation. Verification tests in GapVerificationTests
now pin the GOOD behavior for G2 and G4.
EOF
)"
```

---

# Group G — ALchemist v0.5.10 release

### Task G1: Bump version + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

`package.json`: `"version": "0.5.9"` → `"version": "0.5.10"`.

- [ ] **Step 2: Append CHANGELOG entry**

```markdown
## 0.5.10 (YYYY-MM-DD)

### Restored

- **Loop-variable per-iteration values now render inline.** Previously the loop counter `i` in `for i := 1 to 10 do` arrived as a single capture at test scope (final value 10), so inline display showed `i = 10` instead of the v0.3.0 `i = 1 ‥ 10 (×10)` distribution. AL.Runner's IterationInjector now emits a per-iteration capture for the loop variable, so it flows through the same compact-form rendering as assignment targets.
- **Nested loops no longer double-count captures.** Previously inner-loop captures appeared in BOTH the inner step and the outer step (snapshot/delta math wasn't stack-aware). The runner's IterationTracker now uses per-loop accumulators — each capture lands in exactly one loop's iteration step (the innermost active one).
- **Mixed-case identifiers now match.** AL is case-insensitive for identifiers; declaration case (e.g., `myint`) may differ from source-text use (e.g., `myInt`). Inline render and stepping flow use case-insensitive lookups against `step.capturedValues`.

### Cross-repo dependency

Requires AL.Runner fork at the Plan E5 Groups A+B+C cut. Runner-side commits in `AlRunner/Runtime/IterationTracker.cs` (per-loop accumulators), `AlRunner/IterationInjector.cs` (loop-variable capture injection), and `AlRunner/Runtime/{ValueCapture,MessageCapture}.cs` (route to innermost loop). Plan document at `docs/superpowers/plans/2026-04-30-plan-e5-fix-confirmed-gaps.md`.

## 0.5.9 (2026-04-30)
```

(Replace `YYYY-MM-DD` with today's date when committing.)

- [ ] **Step 3: Verify all tests pass**

```bash
cd U:/Git/ALchemist
npm test
npm run test:smoke
```

Expected: all green.

### Task G2: Commit + tag + push

- [ ] **Step 1: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to v0.5.10 — loop-variable + nested-loop + casing fixes (Plan E5)"
```

- [ ] **Step 2: Tag**

```bash
git tag v0.5.10
git log --oneline -3
```

- [ ] **Step 3: Push (only when ready to publish — DO NOT push without explicit user authorization)**

```bash
git push origin master
git push origin v0.5.10
```

Wait for the GitHub Actions release workflow to complete before declaring success.

---

# Self-Review Checklist

Before marking the plan complete:

- [ ] **Spec coverage:** Every Confirmed gap (G2, G4, G8) has a fix task.
  - G2 → Group B
  - G4 → Group A
  - G8 → Group D

- [ ] **Type consistency:**
  - `CurrentIterationCaptures: List<CapturedValueSnapshot>` (matches existing IterationStep.CapturedValues type).
  - `CurrentIterationMessages: List<string>` (matches IterationStep.Messages type).
  - `RecordCapture(string variableName, string? value)` signature matches what `ValueCapture.Capture` will call.
  - `IterationInjector` injects `ValueCapture.Capture` with the same parameter order ValueCapture.Capture accepts.

- [ ] **No placeholders:** Every code block contains executable code, every command is exact.

- [ ] **TDD discipline:** Each group's first implementation task is a failing test (A1, B1, D1, E1).

- [ ] **Frequent commits:** Each group ends with a commit task (A7, B6, C2, D4, E3, F2, G2).

- [ ] **Cross-repo handoff:** Each ALchemist task that depends on the runner binary calls out the AL.Runner commit prerequisite.

- [ ] **Gaps.md updates:** Group F formally moves G2/G4 to Resolved with commit refs and updates G8 status.
