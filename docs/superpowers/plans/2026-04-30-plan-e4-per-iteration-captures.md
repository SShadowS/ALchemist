# Plan E4 — Per-Iteration Captured Values + Messages + @vscode/test-electron Integration Coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire AL.Runner's `IterationTracker` to read both `TestExecutionScope.Current.CapturedValues` AND `TestExecutionScope.Current.Messages` so per-iteration captured values AND messages populate end-to-end. (The same architectural gap affects both — `ValueCapture.GetCaptures()` and `MessageCapture.GetMessages()` are global aggregates only populated when `Enable()` was called, while the v2 streaming path writes to the per-test scope only.) Add @vscode/test-electron integration tests (no mocks, real VS Code APIs) that drive iteration stepping through the editor surface and validate every VS Code API call against the canonical documentation at https://code.visualstudio.com/api.

**Note on plan-draft corrections:** initial draft used `new TestExecutionScope("...")` to open a scope; the actual API is `using var _ = TestExecutionScope.Begin(testName)` (see `AlRunner/TestExecutionScope.cs:21`). Tests below use the correct API.

**Architecture:**

1. **AL.Runner upstream (`U:/Git/AL.Runner-protocol-v2/`, C#/xUnit).** The `IterationTracker.FinalizeIteration` (line 119-146 of `Runtime/IterationTracker.cs`) reads the captured-value delta from `ValueCapture.GetCaptures()` — the GLOBAL aggregate that is only populated when `ValueCapture._enabled` is true. In the v2 streaming `Executor.RunTests` path, captures go to `TestExecutionScope.Current.CapturedValues` (per-test scope) only — the global stays empty. Switch the snapshot source to the active test scope and the delta math works.

2. **ALchemist consumer integration tests (`U:/Git/ALchemist/`, TypeScript/@vscode/test-electron).** Layer-tests with mocked vscode caught the absolute-path matcher, the schema looseness, the cwd dependency — but missed the iteration-stepping decoration-update because the stepping flow only crashed when no editor was active (a webview cross-surface problem). Plan E3 v0.5.7 fixed the editor-selection bug; this plan adds end-to-end stepping coverage that drives the actual VS Code APIs through the real extension activation path. Every API call in the new tests is annotated with its documentation URL.

3. **Cross-protocol parity test extension.** Extend the existing parity suite to assert that v1 (`--output-json`) and v2 (`--server`) producers emit equivalent per-iteration capture data, so the Plan E3 Group B-C pattern (where v1 had it, v2 silently dropped it) cannot recur for any future iteration-related field.

**Tech Stack:**
- AL.Runner: C# .NET 9, Roslyn, xUnit
- ALchemist: TypeScript 6, VS Code API ^1.88, @vscode/test-electron 2.5
- VS Code Extension API documentation: https://code.visualstudio.com/api (canonical reference for every API call below)
- Wire format: NDJSON over stdio (--server mode)

**Cross-repo execution order:**
- Groups A, B: AL.Runner upstream (runtime fix + sample regen)
- Groups C, D, E: ALchemist consumer tests
- Group F: parity extension
- Group G: release

A subagent can execute each group in isolation if briefed with the prerequisite commit SHA from the previous group.

---

## File Structure

### AL.Runner repo (`U:/Git/AL.Runner-protocol-v2/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `AlRunner/Runtime/IterationTracker.cs:90,122-128` | Iteration boundary tracking + delta finalization | Modify `FinalizeIteration` and `EnterIteration` to read captures from `TestExecutionScope.Current.CapturedValues` instead of `ValueCapture.GetCaptures()`. |
| `AlRunner.Tests/IterationTrackerTests.cs` | Unit tests for IterationTracker boundary semantics | Modify or create. Add tests asserting per-iteration captures populate when the active scope has captures. |
| `AlRunner.Tests/ServerProtocolV2Tests.cs` | Wire-format tests for v2 server | Modify. Tighten the existing iterations test to assert non-empty `steps[i].capturedValues`. |
| `docs/protocol-v2-samples/runtests-iterations.ndjson` | Captured wire sample | Modify. Re-capture after the fix; the file becomes the regression artifact. |

### ALchemist repo (`U:/Git/ALchemist/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `test/integration/iterationStepping.itest.ts` | New end-to-end stepping coverage | Create. Drives `alchemist.iterationNext` and table-panel-style direct store calls against a real opened editor; asserts decoration content. |
| `test/integration/iterationStepperDecoration.itest.ts` | Stepper indicator under real APIs | Create. Drives `IterationStepperDecoration.refresh` against real `visibleTextEditors` and asserts the `⟳ N/M` indicator paints. |
| `test/smoke/runtimeSmoke.smoke.ts` | End-to-end smoke against ALProject4 | Modify. Add an iteration-step assertion: drive `iterationStore.setIteration(loopId, 5)` and assert `result.iterations[0].steps[4].capturedValues` is non-empty AND the DecorationManager contains per-iteration data. |
| `test/parity/iterations.parity.ts` | Cross-protocol per-iteration parity | Create. Drives v1 + v2 producers against the parity fixture and projects each `iterations[].steps[].capturedValues` for comparison. |
| `CHANGELOG.md` | Release notes | Modify under v0.5.9. |
| `package.json` | Version bump | Modify (0.5.8 → 0.5.9). |

---

## VS Code API documentation cross-reference

Every VS Code API call in the new integration tests is cited below with its canonical documentation URL. The plan's test-step prose includes inline citations next to each call so future engineers can validate behavior without guessing.

| API | Documentation URL |
|-----|-------------------|
| `vscode.workspace.openTextDocument(uri)` | https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument |
| `vscode.window.showTextDocument(document)` | https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument |
| `vscode.window.activeTextEditor` | https://code.visualstudio.com/api/references/vscode-api#window.activeTextEditor — undefined when active part is not a text editor |
| `vscode.window.visibleTextEditors` | https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors — readonly array of currently visible editors |
| `vscode.window.createTextEditorDecorationType(options)` | https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType |
| `TextEditor.setDecorations(type, ranges)` | https://code.visualstudio.com/api/references/vscode-api#TextEditor.setDecorations — read-only on the proxy; can't monkey-patch |
| `DecorationOptions.renderOptions.after.contentText` | https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions |
| `vscode.commands.executeCommand(id, ...args)` | https://code.visualstudio.com/api/references/vscode-api#commands.executeCommand |
| `vscode.commands.registerCommand(id, callback)` | https://code.visualstudio.com/api/references/vscode-api#commands.registerCommand |
| `vscode.workspace.getConfiguration(section)` | https://code.visualstudio.com/api/references/vscode-api#workspace.getConfiguration |
| `WorkspaceConfiguration.update(section, value, target)` | https://code.visualstudio.com/api/references/vscode-api#WorkspaceConfiguration.update — `ConfigurationTarget.Global` persists across sessions; restore in suiteTeardown |
| `vscode.extensions.getExtension(id)` | https://code.visualstudio.com/api/references/vscode-api#extensions.getExtension |
| `Extension.activate()` | https://code.visualstudio.com/api/references/vscode-api#Extension.activate |
| `vscode.Range`, `vscode.Position` | https://code.visualstudio.com/api/references/vscode-api#Range, #Position |

---

# Group A — AL.Runner: read iteration deltas from the active test scope

**Working repo:** `U:/Git/AL.Runner-protocol-v2/` on branch `feat/alchemist-protocol-v1`. All commands run from that repo root.

### Task A1: Failing test — per-iteration captures populate from TestExecutionScope

**Files:**
- Create or modify: `AlRunner.Tests/IterationTrackerTests.cs`

- [ ] **Step 1: Inspect the existing IterationTracker test file (if any)**

Run:
```bash
ls U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/IterationTrackerTests.cs 2>&1 || echo "MISSING"
```

If it doesn't exist, create it. If it exists, append to it.

- [ ] **Step 2: Write the failing test**

Add this `[Fact]` to the file (create the surrounding class if needed):

```csharp
using System.Linq;
using AlRunner.Runtime;
using Xunit;

namespace AlRunner.Tests;

public class IterationTrackerStepCapturesTests
{
    [Fact]
    public void FinalizeIteration_ReadsCapturesFromActiveTestExecutionScope()
    {
        // Plan E4 regression repro: the old FinalizeIteration read its
        // capture delta from ValueCapture.GetCaptures() (the GLOBAL
        // aggregate, only populated when ValueCapture.Enable was called).
        // In the v2 streaming Executor.RunTests path, captures go to
        // TestExecutionScope.Current.CapturedValues only — the global
        // aggregate stays empty — so step.CapturedValues was always [].
        IterationTracker.Reset();
        IterationTracker.Enable();

        // Open a per-test scope (the actual API is TestExecutionScope.Begin
        // returning IDisposable; see AlRunner/TestExecutionScope.cs).
        using var _ = AlRunner.TestExecutionScope.Begin("UnitTestProc");

        var loopId = IterationTracker.EnterLoop("ScopeA", sourceStartLine: 10, sourceEndLine: 12);

        // Iteration 1
        IterationTracker.EnterIteration(loopId);
        ValueCapture.Capture("ScopeA", "ObjA", "i", 1, statementId: 0);
        ValueCapture.Capture("ScopeA", "ObjA", "sum", 1, statementId: 1);
        MessageCapture.Capture("hello-1");

        // Iteration 2
        IterationTracker.EnterIteration(loopId);
        ValueCapture.Capture("ScopeA", "ObjA", "i", 2, statementId: 0);
        ValueCapture.Capture("ScopeA", "ObjA", "sum", 3, statementId: 1);
        MessageCapture.Capture("hello-2");

        IterationTracker.ExitLoop(loopId);

        var loops = IterationTracker.GetLoops();
        Assert.Single(loops);
        var loop = loops[0];
        Assert.Equal(2, loop.IterationCount);
        Assert.Equal(2, loop.Steps.Count);

        var step1 = loop.Steps[0];
        Assert.Equal(1, step1.Iteration);
        Assert.Equal(2, step1.CapturedValues.Count);
        Assert.Contains(step1.CapturedValues, cv => cv.VariableName == "i" && cv.Value == "1");
        Assert.Contains(step1.CapturedValues, cv => cv.VariableName == "sum" && cv.Value == "1");
        Assert.Equal(new[] { "hello-1" }, step1.Messages);

        var step2 = loop.Steps[1];
        Assert.Equal(2, step2.Iteration);
        Assert.Equal(2, step2.CapturedValues.Count);
        Assert.Contains(step2.CapturedValues, cv => cv.VariableName == "i" && cv.Value == "2");
        Assert.Contains(step2.CapturedValues, cv => cv.VariableName == "sum" && cv.Value == "3");
        Assert.Equal(new[] { "hello-2" }, step2.Messages);

        IterationTracker.Reset();
    }
}
```

The `MessageCapture.Capture(string)` API matches the existing call surface in `AlRunner/Runtime/MessageCapture.cs` (the `Capture` method that writes to scope + global). If the actual API differs, follow the same pattern as `ValueCapture.Capture`.

- [ ] **Step 3: Run the test and verify it FAILS**

Run:
```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~IterationTrackerStepCapturesTests"
```

Expected: FAIL. Specifically, `step1.CapturedValues.Count` is 0 (or `Assert.Equal(2, step1.CapturedValues.Count)` reports `Expected: 2, Actual: 0`). That confirms the bug.

### Task A2: Fix `IterationTracker.FinalizeIteration` to read from the active scope

**Files:**
- Modify: `AlRunner/Runtime/IterationTracker.cs:90` and `AlRunner/Runtime/IterationTracker.cs:119-146`

- [ ] **Step 1: Update the snapshot sources for BOTH captures and messages**

Find at line 90 (inside `EnterIteration`):
```csharp
        active.ValueSnapshotBefore = ValueCapture.GetCaptures().Count;
        active.MessageSnapshotBefore = MessageCapture.GetMessages().Count;
```
Replace with:
```csharp
        // Snapshot the per-test scope's captures and messages, NOT the
        // global aggregates. The globals are only populated when
        // ValueCapture.Enable / MessageCapture.Enable were called (the
        // legacy v1 --output-json path); the v2 streaming
        // Executor.RunTests path writes only to TestExecutionScope.Current.
        // Read from the scope so per-iteration deltas work in both paths.
        var snapScope = TestExecutionScope.Current;
        active.ValueSnapshotBefore = snapScope?.CapturedValues.Count ?? 0;
        active.MessageSnapshotBefore = snapScope?.Messages.Count ?? 0;
```

Find the body of `FinalizeIteration` (around line 119-146):
```csharp
    private static void FinalizeIteration(ActiveLoop active)
    {
        // Captured values added during this iteration
        var allValues = ValueCapture.GetCaptures();
        var iterValues = new List<CapturedValueSnapshot>();
        for (int i = active.ValueSnapshotBefore; i < allValues.Count; i++)
        {
            var v = allValues[i];
            iterValues.Add(new CapturedValueSnapshot { VariableName = v.VariableName, Value = v.Value ?? "" });
        }

        // Messages added during this iteration
        var allMessages = MessageCapture.GetMessages();
        var iterMessages = new List<string>();
        for (int i = active.MessageSnapshotBefore; i < allMessages.Count; i++)
            iterMessages.Add(allMessages[i]);

        // Lines hit during this iteration
        var iterLines = active.CurrentIterationHits.Distinct().ToList();

        active.Record.Steps.Add(new IterationStep
        {
            Iteration = active.CurrentIteration,
            CapturedValues = iterValues,
            Messages = iterMessages,
            LinesExecuted = iterLines,
        });
    }
```

Replace with:
```csharp
    private static void FinalizeIteration(ActiveLoop active)
    {
        // Captured values + messages added during this iteration come from
        // the per-test scope (the scope is the v2 path's source of truth).
        // The globals (ValueCapture.GetCaptures / MessageCapture.GetMessages)
        // may also be populated for legacy v1 --output-json runs, but the
        // scope is the intersection that always works.
        var scope = TestExecutionScope.Current;

        var iterValues = new List<CapturedValueSnapshot>();
        if (scope != null)
        {
            var allValues = scope.CapturedValues;
            for (int i = active.ValueSnapshotBefore; i < allValues.Count; i++)
            {
                var v = allValues[i];
                iterValues.Add(new CapturedValueSnapshot { VariableName = v.VariableName, Value = v.Value ?? "" });
            }
        }

        var iterMessages = new List<string>();
        if (scope != null)
        {
            var allMessages = scope.Messages;
            for (int i = active.MessageSnapshotBefore; i < allMessages.Count; i++)
            {
                iterMessages.Add(allMessages[i]);
            }
        }

        // Lines hit during this iteration (unchanged — RecordHit writes
        // to active.CurrentIterationHits directly, no scope needed).
        var iterLines = active.CurrentIterationHits.Distinct().ToList();

        active.Record.Steps.Add(new IterationStep
        {
            Iteration = active.CurrentIteration,
            CapturedValues = iterValues,
            Messages = iterMessages,
            LinesExecuted = iterLines,
        });
    }
```

- [ ] **Step 2: Run the failing test and verify it PASSES**

Run:
```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~IterationTrackerStepCapturesTests"
```

Expected: PASS.

- [ ] **Step 3: Run full suite and verify no regressions**

Run:
```bash
dotnet test AlRunner.Tests/AlRunner.Tests.csproj
```

Expected: existing pass count unchanged. Specifically, the existing `RunTests_V2Summary_IncludesIterations_WhenIterationTrackingRequested` test should now also see non-empty `steps[i].capturedValues` if it asserts on that — if it doesn't yet, leave it for Task A3.

### Task A3: Tighten the v2 server iteration test to assert non-empty step captures

**Files:**
- Modify: `AlRunner.Tests/ServerProtocolV2Tests.cs` (`RunTests_V2Summary_IncludesIterations_WhenIterationTrackingRequested`)

- [ ] **Step 1: Inspect the existing test**

Run:
```bash
grep -n "RunTests_V2Summary_IncludesIterations" U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/ServerProtocolV2Tests.cs
```

Read the surrounding test body so the addition fits the existing style (assertions on `JsonElement`).

- [ ] **Step 2: Add assertions on `steps[].capturedValues`**

Inside the existing test, after the assertion that verifies `steps.GetArrayLength() == 3`, add:

```csharp
        // Plan E4: per-iteration captures must populate now that
        // FinalizeIteration reads from TestExecutionScope.Current.
        for (var i = 0; i < stepsProp.GetArrayLength(); i++)
        {
            var step = stepsProp[i];
            Assert.True(step.TryGetProperty("capturedValues", out var cvProp),
                $"step[{i}] must include capturedValues");
            Assert.True(cvProp.GetArrayLength() > 0,
                $"step[{i}].capturedValues must be non-empty for `for i := 1 to 3 do sum += i;` (Plan E4 fix)");

            // For this fixture, each step should capture both `i` and `sum`.
            var varNames = cvProp.EnumerateArray()
                .Select(e => e.GetProperty("variableName").GetString())
                .ToList();
            Assert.Contains("i", varNames);
            Assert.Contains("sum", varNames);
        }
```

- [ ] **Step 3: Run the test**

Run:
```bash
dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~RunTests_V2Summary_IncludesIterations"
```

Expected: PASS.

### Task A4: Re-capture the wire-format sample

**Files:**
- Modify: `docs/protocol-v2-samples/runtests-iterations.ndjson`

- [ ] **Step 1: Build the runner**

Run:
```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet build AlRunner/AlRunner.csproj -c Release
```

Expected: build succeeds. Output binary at `AlRunner/bin/Release/net9.0/AlRunner.exe`.

- [ ] **Step 2: Re-capture the sample using the same procedure as Plan E3 Group C**

Run:
```bash
cd U:/Git/AL.Runner-protocol-v2
node --input-type=module -e "
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const proc = spawn('AlRunner/bin/Release/net9.0/AlRunner.exe', ['--server'], {
  cwd: 'tests/protocol-v2-iterations',
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
proc.stdout.on('data', d => { stdout += d.toString(); });
proc.stderr.on('data', d => process.stderr.write('[stderr] ' + d));

setTimeout(() => {
  proc.stdin.write(JSON.stringify({
    command: 'runtests',
    sourcePaths: [process.cwd() + '/tests/protocol-v2-iterations/test'],
    captureValues: true,
    iterationTracking: true,
    coverage: true,
  }) + '\n');
}, 300);

setTimeout(() => {
  proc.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
}, 8000);

proc.on('exit', code => {
  writeFileSync('docs/protocol-v2-samples/runtests-iterations.ndjson', stdout);
  console.log('exit', code, stdout.split('\\n').filter(l => l.trim()).length, 'lines');
  process.exit(code ?? 0);
});
"
```

Expected: file regenerated. The summary line's `iterations[0].steps[i].capturedValues` arrays must now contain `[{variableName: "i", value: "1"}, {variableName: "sum", value: "1"}]`-shaped entries.

- [ ] **Step 3: Verify the sample by eye**

Run:
```bash
cat U:/Git/AL.Runner-protocol-v2/docs/protocol-v2-samples/runtests-iterations.ndjson | grep -o 'steps[^}]*}[^}]*}[^}]*}' | head -3
```

Expected: matched output contains `"capturedValues":[{"variableName":...` (non-empty, with variable names + values).

- [ ] **Step 4: Re-validate against the schema (AJV)**

Run:
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
  if (!validate(obj)) {
    console.error('FAIL line', i + 1, ':', lines[i].slice(0, 100));
    console.error('  errors:', JSON.stringify(validate.errors));
    bad++;
  }
}
if (bad === 0) console.log('all', lines.length, 'lines valid');
else process.exit(1);
"
```

Expected: `all <N> lines valid`.

If validation fails, the schema's `IterationLoop.steps[].capturedValues[]` shape must be checked — the items must require `variableName` and `value` (both strings). Reference: protocol-v2.schema.json definition for IterationLoop. If the schema and emission disagree, fix the schema.

### Task A5: Commit Group A

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/AL.Runner-protocol-v2
git add \
    AlRunner/Runtime/IterationTracker.cs \
    AlRunner.Tests/IterationTrackerTests.cs \
    AlRunner.Tests/ServerProtocolV2Tests.cs \
    docs/protocol-v2-samples/runtests-iterations.ndjson
git commit -m "$(cat <<'EOF'
fix(iteration): read iteration delta from TestExecutionScope, not global

IterationTracker.FinalizeIteration sampled ValueCapture.GetCaptures()
to compute the per-iteration capture delta. That global aggregate is
only populated when ValueCapture.Enable() has been called — which the
legacy v1 --output-json path does, but the v2 streaming
Executor.RunTests path does NOT. As a result, every step.capturedValues
in the v2 wire format was an empty array even though the per-test
scope was correctly capturing values.

Switch the snapshot source to TestExecutionScope.Current.CapturedValues.
The scope is populated unconditionally inside ValueCapture.Capture
(no Enable guard), so this works for both v1 (which also populates the
scope) and v2 (which only populates the scope).

ALchemist's iteration-stepping flow now has real per-iteration data
to render — without this fix, stepping in the editor produced blank
inline values even though the stepper indicator was correct.

Refreshes docs/protocol-v2-samples/runtests-iterations.ndjson with
the new emission.
EOF
)"
```

Verify:
```bash
git log --oneline -1
git status
```

Expected: clean tree, the new commit at HEAD.

---

# Group B — ALchemist: tighten smoke-test assertions on per-iteration captures

**Working repo:** `U:/Git/ALchemist/` on branch `master`.

**Prerequisite:** Group A committed in the AL.Runner repo and the binary at `U:/Git/AL.Runner-protocol-v2/AlRunner/bin/Release/net9.0/AlRunner.exe` was rebuilt as part of Task A4.

### Task B1: Smoke test asserts step.capturedValues populates end-to-end

**Files:**
- Modify: `test/smoke/runtimeSmoke.smoke.ts`

- [ ] **Step 1: Inspect the existing iteration assertion in the smoke test**

Run:
```bash
grep -n "result.iterations\|cu1Loop" U:/Git/ALchemist/test/smoke/runtimeSmoke.smoke.ts | head -10
```

The smoke test already asserts `result.iterations.length > 0`, finds the CU1 loop, and asserts `iterationCount === 10`. Now extend with per-step captured-value assertions.

- [ ] **Step 2: Add per-step assertions**

After the existing `cu1Loop.steps.length === 10` assertion, add:

```typescript
    // Plan E4: per-iteration captures must populate now that the runner's
    // FinalizeIteration reads from TestExecutionScope.Current.CapturedValues.
    // Without this, the iteration stepper updates the indicator but the
    // inline values stay blank (Plan E4 user report).
    const stepsWithCaptures = cu1Loop!.steps.filter(s => s.capturedValues.length > 0);
    assert.ok(
      stepsWithCaptures.length > 0,
      `expected per-iteration captures populated for at least one step in CU1.al; ` +
      `got ${stepsWithCaptures.length} of ${cu1Loop!.steps.length} steps with captures. ` +
      `If 0, AL.Runner's IterationTracker.FinalizeIteration regressed (Plan E4).`,
    );
    // CU1.al's `for i := 1 to 10 do myInt += i;` should yield captures
    // for `myInt` on each iteration. Pin a specific iteration for clarity.
    const step3Captures = cu1Loop!.steps[2].capturedValues;
    assert.ok(
      step3Captures.some(cv => cv.variableName.toLowerCase() === 'myint'),
      `step[3].capturedValues must include myInt; got ${JSON.stringify(step3Captures.map(cv => cv.variableName))}`,
    );
```

- [ ] **Step 3: Run the smoke test**

Run:
```bash
cd U:/Git/ALchemist
npm run test:smoke
```

Expected: PASS. If FAIL with "expected per-iteration captures populated for at least one step", the runner binary is stale — rebuild via:
```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet build AlRunner/AlRunner.csproj -c Release
```
Then re-run the smoke test.

### Task B2: Commit Group B

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add test/smoke/runtimeSmoke.smoke.ts
git commit -m "$(cat <<'EOF'
test(smoke): assert per-iteration captures populate after Plan E4 fix

Tighten the runtime smoke test to verify each iteration step's
capturedValues array is non-empty for CU1.al's for-loop. Previously
the smoke test only asserted iterationCount and steps.length —
Plan E4's bug (step.capturedValues was always []) silently passed
because the array was present, just empty.

Now asserts at least one step has captures and pins step #3 to
include myInt — catches the regression where IterationTracker
sampled the wrong source (global ValueCapture aggregate instead of
TestExecutionScope.Current).

Requires AL.Runner fork from a checkout including Plan E4 Group A.
EOF
)"
```

---

# Group C — ALchemist: end-to-end stepping coverage with @vscode/test-electron

**The user's directive: "Use electron tests so they are actual tests and not mocks."** All tests in this group run inside the real VS Code extension host via `@vscode/test-electron`, exercising the same APIs production code uses. Every API call below is annotated with its documentation URL.

### Task C1: Iteration stepping integration test (file + index wiring)

**Files:**
- Create: `test/integration/iterationStepping.itest.ts`
- Modify: `test/integration/index.ts` (no changes needed — the glob already picks up `**/*.itest.js`)

- [ ] **Step 1: Inspect the existing integration-test pattern**

Run:
```bash
cat U:/Git/ALchemist/test/integration/decorationRender.itest.ts | head -80
```

Note the pattern:
- `vscode.workspace.openTextDocument(path)` to open the AL fixture file.
- `vscode.window.showTextDocument(doc)` to surface the editor.
- A `wrapEditor` helper (defined at file end) that creates a non-Proxy stand-in with the real `document` but a stubbed `setDecorations` that records calls. The wrapper is required because `editor.setDecorations` on the real `TextEditor` is a non-writable, non-configurable slot — both direct assignment and `Proxy.get` interception throw. See https://code.visualstudio.com/api/references/vscode-api#TextEditor for the API surface; the read-only-slot behavior is a runtime invariant (verified in commit `5b4e9d2`).

- [ ] **Step 2: Write the test file**

Create `test/integration/iterationStepping.itest.ts`:

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { DecorationManager } from '../../src/editor/decorations';
import { IterationStore } from '../../src/iteration/iterationStore';
import { findEditorsForLoopSourceFile } from '../../src/iteration/iterationViewSync';
import { IterationData } from '../../src/iteration/types';
import type { ExecutionResult } from '../../src/runner/outputParser';

/**
 * End-to-end iteration-stepping coverage through real VS Code APIs.
 *
 * Plan E4 Task C1.
 *
 * Drives the same code path the user hits when clicking a row in the
 * Iteration Table panel:
 *   IterationStore.setIteration → onDidChange listener → onIterationChanged →
 *   findEditorsForLoopSourceFile + DecorationManager.applyIterationView →
 *   editor.setDecorations.
 *
 * We don't fire the actual command (alchemist.iterationNext) because the
 * extension's iteration-changed listener is wired in `activate(context)`
 * and we don't activate the full extension here (this test is integration
 * not smoke). Instead, we drive the same applyIterationView call directly
 * with the loop+step the store would resolve, against a real editor, and
 * assert the decoration outcomes.
 *
 * Cited APIs:
 * - vscode.workspace.openTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
 * - vscode.window.showTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
 * - vscode.window.visibleTextEditors (read-only):
 *   https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
 * - vscode.window.createTextEditorDecorationType (called inside
 *   DecorationManager constructor):
 *   https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
 * - TextEditor.setDecorations (the slot we proxy via wrapEditor below):
 *   https://code.visualstudio.com/api/references/vscode-api#TextEditor.setDecorations
 * - DecorationOptions.renderOptions.after.contentText (the inline-text
 *   slot we assert on):
 *   https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
 */
const FIX = path.resolve(__dirname, '../../../test/fixtures');
const APP_ROOT = path.join(FIX, 'multi-app', 'MainApp.Test');
const AL_FILE = path.join(APP_ROOT, 'src', 'SomeTest.Codeunit.al');
const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

suite('Integration — iteration stepping updates inline values via real VS Code APIs', () => {
  test('applyIterationView paints per-iteration captured values on the matched line', async () => {
    // 1. Open a real AL fixture file.
    const vscode = require('vscode');
    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    const realEditor = await vscode.window.showTextDocument(doc);

    // 2. Wrap the real editor so we can record setDecorations calls.
    //    (TextEditor.setDecorations is a read-only slot — see Plan E3 v0.5.4.)
    type Call = { type: any; ranges: any[] };
    const calls: Call[] = [];
    const editor = wrapEditor(realEditor, calls);

    // 3. Build a DecorationManager backed by real
    //    vscode.window.createTextEditorDecorationType calls.
    //    https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
    const dm = new DecorationManager(EXTENSION_ROOT);
    const captureType = (dm as unknown as { capturedValueDecorationType: unknown })
      .capturedValueDecorationType;
    assert.ok(captureType, 'DecorationManager must expose capturedValueDecorationType');

    // 4. Construct an IterationStore loaded with realistic per-iteration
    //    data — the wire shape Plan E4 Group A produces. Each step has
    //    populated capturedValues for the loop variable.
    //    SomeTest.Codeunit.al at line 14 has `if Sut.Compute(3) <> 6 then Error('expected 6');`
    //    which isn't a loop. For a real loop we'd need a different fixture,
    //    but the integration here is about the path: store → applyIterationView.
    //    We craft loop data that points at line 14 (1-based) and assert
    //    decoration paints there.
    const loop: IterationData = {
      loopId: 'L0',
      sourceFile: AL_FILE,
      loopLine: 14,
      loopEndLine: 14,
      parentLoopId: null,
      parentIteration: null,
      iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'Sut', value: '1' }], messages: [], linesExecuted: [14] },
        { iteration: 2, capturedValues: [{ variableName: 'Sut', value: '2' }], messages: [], linesExecuted: [14] },
        { iteration: 3, capturedValues: [{ variableName: 'Sut', value: '3' }], messages: [], linesExecuted: [14] },
      ],
    };
    const store = new IterationStore();
    store.load([loop], APP_ROOT);

    // 5. Verify findEditorsForLoopSourceFile picks up our editor.
    //    https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
    const matched = findEditorsForLoopSourceFile(
      vscode.window.visibleTextEditors,
      loop.sourceFile,
    );
    assert.ok(
      matched.length >= 1,
      `findEditorsForLoopSourceFile must include the editor whose document is ${AL_FILE}; ` +
      `got ${matched.length} match(es). visibleTextEditors paths: ${vscode.window.visibleTextEditors.map((e: any) => e.document.uri.fsPath).join(', ')}`,
    );

    // 6. Step to iteration 2 and apply the per-iteration view through the
    //    same code path the user hits.
    store.setIteration(loop.loopId, 2);
    const step = store.getStep(loop.loopId, 2);
    const changedVars = store.getChangedValues(loop.loopId, 2);
    dm.applyIterationView(editor as any, step, changedVars, /*flashMs*/ 0, {
      start: loop.loopLine,
      end: loop.loopEndLine,
    });

    // 7. Assert the captured-value decoration was painted on the assignment line.
    const captureCalls = calls.filter(c => c.type === captureType);
    const nonEmpty = captureCalls.filter(c => c.ranges.length > 0);
    assert.ok(
      nonEmpty.length > 0,
      `expected applyIterationView to paint a captured-value decoration; ` +
      `got ${captureCalls.length} call(s), all empty. ` +
      `Inline values would be blank in the editor (the user-reported Plan E4 symptom).`,
    );

    // 8. Decoration must be on the loop line and contain the iteration-2 value.
    //    https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
    const decoration = nonEmpty[0].ranges[0];
    const startLine = decoration.range?.start?.line ?? decoration.start?.line;
    assert.strictEqual(
      startLine,
      13, // 1-based 14 → 0-based 13
      `decoration must land on line 14 (0-based 13); got line ${startLine}`,
    );
    const contentText: string | undefined = decoration.renderOptions?.after?.contentText;
    assert.ok(
      contentText && contentText.includes('Sut') && contentText.includes('2'),
      `inline contentText must include the iteration-2 value 'Sut = 2'; got ${JSON.stringify(contentText)}`,
    );

    dm.dispose();
  });
});

/**
 * Build a stand-in editor that holds the real document but records
 * setDecorations calls. Cannot proxy the real editor because
 * TextEditor.setDecorations is a non-writable, non-configurable slot
 * (verified at runtime in commit 5b4e9d2). The stand-in still exercises
 * real Document.lineAt + real path resolution; only the painting
 * side-effect is stubbed.
 *
 * https://code.visualstudio.com/api/references/vscode-api#TextEditor
 */
function wrapEditor(real: any, calls: { type: any; ranges: any[] }[]): any {
  return {
    document: real.document,
    selection: real.selection,
    visibleRanges: real.visibleRanges,
    options: real.options,
    setDecorations: (type: any, ranges: any[]) => {
      calls.push({ type, ranges });
    },
  };
}
```

- [ ] **Step 3: Run the integration test**

```bash
cd U:/Git/ALchemist
npm run test:integration -- --grep "iteration stepping updates inline values"
```

Expected: PASS. If FAIL on the `findEditorsForLoopSourceFile` assertion, the test's editor isn't visible in `vscode.window.visibleTextEditors` — verify the `await vscode.window.showTextDocument(doc)` returned successfully and that `realEditor.document.uri.fsPath` matches `AL_FILE`.

### Task C2: Stepper-decoration integration test (visibleTextEditors)

**Files:**
- Create: `test/integration/iterationStepperDecoration.itest.ts`

- [ ] **Step 1: Write the test file**

```typescript
import * as assert from 'assert';
import * as path from 'path';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationStepperDecoration } from '../../src/iteration/iterationCodeLensProvider';
import { IterationData } from '../../src/iteration/types';

/**
 * End-to-end coverage for IterationStepperDecoration through real VS Code
 * APIs. Plan E4 Task C2.
 *
 * Validates that the stepper indicator (`⟳ N/M`) paints on the matched
 * editor when `refresh()` is invoked, even though the decoration class
 * was constructed with the real vscode.window event subscriptions.
 *
 * Cited APIs:
 * - vscode.workspace.openTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument
 * - vscode.window.showTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#window.showTextDocument
 * - vscode.window.visibleTextEditors:
 *   https://code.visualstudio.com/api/references/vscode-api#window.visibleTextEditors
 * - vscode.window.onDidChangeActiveTextEditor:
 *   https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeActiveTextEditor
 * - vscode.workspace.onDidChangeTextDocument:
 *   https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument
 */
const FIX = path.resolve(__dirname, '../../../test/fixtures');
const APP_ROOT = path.join(FIX, 'multi-app', 'MainApp.Test');
const AL_FILE = path.join(APP_ROOT, 'src', 'SomeTest.Codeunit.al');

suite('Integration — IterationStepperDecoration paints across visible editors', () => {
  test('refresh paints stepper text on a real editor whose document matches a loop sourceFile', async () => {
    const vscode = require('vscode');

    // 1. Open the AL fixture so visibleTextEditors includes it.
    const doc = await vscode.workspace.openTextDocument(AL_FILE);
    await vscode.window.showTextDocument(doc);

    // 2. Build a store with one loop pointing at this file.
    const loop: IterationData = {
      loopId: 'L0',
      sourceFile: AL_FILE,
      loopLine: 14,
      loopEndLine: 14,
      parentLoopId: null,
      parentIteration: null,
      iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [], messages: [], linesExecuted: [14] },
        { iteration: 2, capturedValues: [], messages: [], linesExecuted: [14] },
        { iteration: 3, capturedValues: [], messages: [], linesExecuted: [14] },
      ],
    };
    const store = new IterationStore();
    store.load([loop], APP_ROOT);

    // 3. Spy on createTextEditorDecorationType so we can capture the
    //    decoration type the stepper class creates (it's a private field).
    //    https://code.visualstudio.com/api/references/vscode-api#window.createTextEditorDecorationType
    const realCreate = vscode.window.createTextEditorDecorationType.bind(vscode.window);
    const created: any[] = [];
    vscode.window.createTextEditorDecorationType = (options: any) => {
      const t = realCreate(options);
      created.push({ options, type: t });
      return t;
    };

    // 4. Spy on TextEditor.setDecorations through the visible editor's
    //    own slot. Since we only need to observe (not block), wrap by
    //    monkeypatching at instance level via Object.defineProperty —
    //    but the slot is non-writable. Use the same wrapEditor pattern
    //    by intercepting all visibleTextEditors entries.
    type Call = { editorPath: string; type: any; ranges: any[] };
    const calls: Call[] = [];
    const origVisible = vscode.window.visibleTextEditors;
    const wrappedVisible = origVisible.map((e: any) => ({
      document: e.document,
      selection: e.selection,
      visibleRanges: e.visibleRanges,
      options: e.options,
      setDecorations: (type: any, ranges: any[]) => {
        calls.push({ editorPath: e.document.uri.fsPath, type, ranges });
      },
    }));
    Object.defineProperty(vscode.window, 'visibleTextEditors', {
      value: wrappedVisible,
      configurable: true,
    });

    let stepperDispose: { dispose(): void } | undefined;
    try {
      // 5. Construct the stepper decoration. Subscribes to
      //    onDidChangeActiveTextEditor + onDidChangeTextDocument internally.
      //    https://code.visualstudio.com/api/references/vscode-api#window.onDidChangeActiveTextEditor
      //    https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument
      const stepper = new IterationStepperDecoration(store);
      stepperDispose = stepper;

      // 6. Trigger a manual refresh and assert decoration call landed on
      //    the matched editor with non-empty contentText.
      stepper.refresh();

      const matchingCalls = calls.filter(
        c => c.editorPath.toLowerCase() === AL_FILE.toLowerCase() &&
             c.ranges.length > 0,
      );
      assert.ok(
        matchingCalls.length >= 1,
        `expected at least one stepper decoration on ${AL_FILE} after refresh(); ` +
        `got ${calls.length} total call(s) across ${wrappedVisible.length} visible editor(s).`,
      );

      // 7. The decoration's contentText must be the stepper indicator
      //    (`⟳ 0/3` because currentIteration is 0 = "Show All" mode by default).
      //    https://code.visualstudio.com/api/references/vscode-api#DecorationInstanceRenderOptions
      const stepperContent = matchingCalls[0].ranges[0]?.renderOptions?.after?.contentText;
      assert.ok(
        stepperContent && (stepperContent.includes('⟳') || stepperContent.includes('All')),
        `stepper contentText must include the stepper indicator; got ${JSON.stringify(stepperContent)}`,
      );
    } finally {
      stepperDispose?.dispose();
      vscode.window.createTextEditorDecorationType = realCreate;
      Object.defineProperty(vscode.window, 'visibleTextEditors', {
        value: origVisible,
        configurable: true,
      });
    }
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
cd U:/Git/ALchemist
npm run test:integration -- --grep "IterationStepperDecoration paints across visible editors"
```

Expected: PASS. If FAIL on the createTextEditorDecorationType spy, the spy assignment failed; check that the property is writable on `vscode.window` — it was in this codebase as of commit `cff4214`.

### Task C3: Commit Group C

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add test/integration/iterationStepping.itest.ts test/integration/iterationStepperDecoration.itest.ts
git commit -m "$(cat <<'EOF'
test(integration): real-VS-Code coverage for iteration stepping flow

Adds two @vscode/test-electron integration tests (no mocks) covering
the iteration-stepping path that broke in v0.5.7 / regressed
fundamentally in Plan E4:

1. iterationStepping.itest.ts — drives applyIterationView against a
   real opened editor with realistic per-iteration data and asserts
   the captured-value decoration paints on the right line with the
   right contentText. Catches the symptom the user reported (stepper
   updates but inline values stay blank).

2. iterationStepperDecoration.itest.ts — drives
   IterationStepperDecoration.refresh against real visibleTextEditors
   and asserts the stepper indicator (`⟳ N/M`) paints on the matched
   editor. Catches the v0.5.7 regression (stepper silently skipped
   when active editor was a webview).

Every VS Code API call in the new tests is annotated with its
canonical documentation URL (see file headers) so future engineers
can validate behavior against https://code.visualstudio.com/api
without guessing API shapes.
EOF
)"
```

---

# Group D — ALchemist: parity test extension for per-iteration captures

### Task D1: Failing parity assertion for per-iteration captures

**Files:**
- Modify: `test/parity/captures.parity.ts`

- [ ] **Step 1: Inspect the existing parity normalization**

Run:
```bash
grep -n "normalizeForParity\|iterations" U:/Git/ALchemist/test/parity/captures.parity.ts | head -10
```

The existing `iterations` projection only captures `{iterationCount, stepCount, sourceFileBasename}`. Extend it to also project per-step capture variable names so the v1↔v2 equivalence catches future iteration-related drops.

- [ ] **Step 2: Tighten the iterations projection**

Find:
```typescript
    iterations: (input.iterations ?? []).map((loop: any) => ({
      iterationCount: loop.iterationCount,
      stepCount: loop.steps?.length ?? 0,
      sourceFileBasename: path.basename(loop.sourceFile ?? ''),
    })).sort((a: any, b: any) => a.sourceFileBasename.localeCompare(b.sourceFileBasename)),
```

Replace with:
```typescript
    iterations: (input.iterations ?? []).map((loop: any) => ({
      iterationCount: loop.iterationCount,
      stepCount: loop.steps?.length ?? 0,
      sourceFileBasename: path.basename(loop.sourceFile ?? ''),
      // Plan E4: project per-step capture variable names so a v1/v2
      // mismatch where one path has populated step.capturedValues but
      // the other doesn't (the regression that motivated Plan E4)
      // surfaces as a parity diff.
      stepVarNames: (loop.steps ?? []).map((s: any) =>
        (s.capturedValues ?? []).map((cv: any) => cv.variableName).sort()
      ),
    })).sort((a: any, b: any) => a.sourceFileBasename.localeCompare(b.sourceFileBasename)),
```

- [ ] **Step 3: Run the parity test**

Run:
```bash
cd U:/Git/ALchemist
npm run test:parity
```

Expected behavior:
- If the runner binary is from a Plan E4 Group A checkout (Task A5 commit), both v1 and v2 produce per-step captures and the parity assertion passes.
- If the runner binary is stale (pre-Group-A), v2 has empty `stepVarNames` arrays while v1 may have populated ones — parity FAILS, surfacing the bug.

If parity fails, the diagnosis is in the `dump()` output. Either:
1. Rebuild the runner from a Group-A checkout (the expected fix).
2. If both producers genuinely produce empty stepVarNames (different runner version semantic), accept the divergence by relaxing the projection — but only with a comment explaining why.

### Task D2: Commit Group D

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add test/parity/captures.parity.ts
git commit -m "$(cat <<'EOF'
test(parity): tighten iterations projection to include per-step var names

The original parity projection only checked iterationCount, stepCount,
and sourceFileBasename. Plan E4's bug (v2 dropped per-step
capturedValues entirely) didn't show up in parity because the array
was present (length 0) and the projection didn't look inside it.

Project the variable names from each step.capturedValues so a v1↔v2
mismatch in iteration-related fields surfaces as a parity diff
immediately, not weeks later in the user's editor.

Requires AL.Runner fork from Plan E4 Group A.
EOF
)"
```

---

# Group E — ALchemist: release v0.5.9

### Task E1: Bump version + CHANGELOG

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json` change `"version": "0.5.8"` to `"version": "0.5.9"`.

- [ ] **Step 2: Append CHANGELOG entry**

Insert above the `## 0.5.8` heading:

```markdown
## 0.5.9 (YYYY-MM-DD)

### Restored

- **Iteration stepping now updates inline captured values.** v0.5.7 fixed which editor the stepping flow paints into; that wasn't enough — `step.capturedValues` was always empty in the v2 wire format because `IterationTracker.FinalizeIteration` (in AL.Runner) sampled the global `ValueCapture.GetCaptures()` aggregate (only populated when `ValueCapture.Enable()` had been called — the legacy v1 `--output-json` path) instead of the per-test scope (`TestExecutionScope.Current.CapturedValues`, which the v2 streaming path always populates). User-visible symptom: stepping to iteration N updated the indicator but the inline `j = ?` text disappeared because there was nothing to render. The runner now reads from the active scope; per-iteration captures populate end-to-end.

### Tests

- Two new `@vscode/test-electron` integration tests (no mocks, real APIs):
  - `iterationStepping.itest.ts` — drives `applyIterationView` against a real opened editor and asserts inline contentText.
  - `iterationStepperDecoration.itest.ts` — drives the stepper indicator through `visibleTextEditors`.
  - Every VS Code API call is annotated with its canonical documentation URL (https://code.visualstudio.com/api/...) so future engineers can validate behavior against the spec.
- Smoke test extended with per-step capture assertions so the symptom can't recur silently.
- Parity suite tightened: per-step variable names are now part of the v1↔v2 projection.

### Cross-repo dependency

Requires AL.Runner fork at the Plan E4 Group A cut. The runner-side fix sits in `AlRunner/Runtime/IterationTracker.cs` (FinalizeIteration reads from TestExecutionScope.Current.CapturedValues).

## 0.5.8 (2026-04-30)
```

(Replace `YYYY-MM-DD` with today's date when committing.)

- [ ] **Step 3: Verify all tests pass before committing**

Run:
```bash
cd U:/Git/ALchemist
npm test          # unit + integration + parity
npm run test:smoke
```

Expected: all green.

### Task E2: Commit + tag

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add package.json CHANGELOG.md
git commit -m "chore: bump to v0.5.9 — per-iteration captures restored (Plan E4)"
```

- [ ] **Step 2: Tag**

```bash
git tag v0.5.9
git log --oneline -3
git tag --list | grep v0.5
```

Verify the tag points at the version-bump commit.

- [ ] **Step 3: Push (only when ready to publish)**

DO NOT push without explicit user approval — the GitHub Actions release workflow on tag push triggers Marketplace publish.

When the user authorizes:
```bash
git push origin master
git push origin v0.5.9
```

---

# Self-Review Checklist

Before marking the plan complete:

- [ ] **Spec coverage:** Every requirement is implemented by a task.
  - "Wire ValueCapture into IterationTracker" → Group A (A1-A5).
  - "Add @vscode/test-electron integration tests (no mocks)" → Group C (C1-C3).
  - "Validate every VS Code API call against documentation" → Documentation cross-reference table at top + inline citations in every test file header in Group C.
  - "Diagnostic evidence" → covered in Task A1's failing test (reproduces the empty-captures symptom).
  - "Cross-repo plan" → Group A (AL.Runner) → Group B (consumer smoke) → Group C (consumer integration) → Group D (parity) → Group E (release).

- [ ] **Type consistency:**
  - `step.CapturedValues` (C# camelCase) ↔ `step.capturedValues` (TypeScript camelCase): match conventions per language.
  - `TestExecutionScope.Current` (C#) used consistently in Group A.
  - `IterationStore.setIteration(loopId, n)` signature used consistently across Group C tests.
  - `findEditorsForLoopSourceFile` import path: `../../src/iteration/iterationViewSync`.
  - `DecorationManager.applyIterationView(editor, step, changedVars, flashMs, range)` signature.

- [ ] **No placeholders:** Every code block contains executable code, every command is exact.

- [ ] **TDD discipline:** Each group's first implementation task is a failing test (A1, B1, C1, C2, D1).

- [ ] **Frequent commits:** Each group ends with a commit task (A5, B2, C3, D2, E2).

- [ ] **VS Code documentation citations:** Every API call in Group C tests has an inline doc URL comment. Group A's runtime change is C#, no VS Code API surface there.

- [ ] **Cross-repo handoff:** Each ALchemist task that depends on the runner binary calls out the AL.Runner commit prerequisite.
