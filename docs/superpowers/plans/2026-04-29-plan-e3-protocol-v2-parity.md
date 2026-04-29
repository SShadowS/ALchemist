# Plan E3 — Protocol v2 Parity Restoration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore v0.3.0 ALchemist feature parity that was silently dropped when the protocol v2 spec (Plan E1/E2) modernized streaming + native VS Code APIs without auditing legacy v1 features. Specifically: emit absolute paths and per-loop iteration data on the v2 wire, consume them in ALchemist, render compact captured-value loop summaries, and lock parity into a test suite so future protocol changes can't silently regress.

**Architecture:** Two-repo, coupled-but-separately-shippable changes.

1. **AL.Runner upstream (`U:/Git/AL.Runner-protocol-v2/`, C# / xUnit):** kill cwd-dependence by emitting absolute paths everywhere (`Path.GetFullPath` instead of `Path.GetRelativePath(cwd, ...)`); add `iterations` to the v2 summary by piping through the data Pipeline.cs already collects for v1 `--output-json`; mirror both into `protocol-v2.schema.json` so downstream consumers can validate.

2. **ALchemist consumer (`U:/Git/ALchemist/`, TypeScript / Mocha):** confirm `result.iterations` flows from v2 (`serverExecutionEngine.ts:116` already does the no-op mapping); replace the captured-value dedup-to-last in `applyInlineCapturedValues` with distribution-based compact rendering (`first .. last (×N)`) that reuses the existing `distributeMessages` design; remove the v0.5.4 cwd-pin workaround in `extension.ts` once the runner emits absolute paths.

3. **Cross-cutting parity test suite:** drive a single AL fixture through v1 (`--output-json`) and v2 (`--server`) producers, normalize each `ExecutionResult`, and assert structural equivalence on the union of fields the UI consumes (captures, iterations, coverage). This is the test that would have caught the v0.3.0 → v0.5.0 regression and will catch the next one.

**Tech Stack:**
- AL.Runner: C# (.NET 9), Roslyn, xUnit
- ALchemist: TypeScript 6, VS Code API ^1.88, Mocha 11, sinon 21, @vscode/test-electron 2.5
- JSON Schema: protocol-v2.schema.json (in runner repo)
- Wire format: NDJSON over stdio (--server mode)

**Cross-repo execution order:**
- Groups A, B, C: AL.Runner upstream — work in `U:/Git/AL.Runner-protocol-v2/` worktree.
- Groups D, E, F: ALchemist consumer — work in `U:/Git/ALchemist/` worktree.
- Group G: parity suite — lives in ALchemist, depends on a runner build that completed Groups A+B.

Recommended sequence: A → B → C → G (skeleton with v2-only assertions) → D → E → F → G (complete with both producers). A subagent can execute each group in isolation if briefed with the prerequisite commit SHA from the previous group.

---

## File Structure

### AL.Runner repo (`U:/Git/AL.Runner-protocol-v2/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `AlRunner/Pipeline.cs` | Source-file ingestion + SourceFileMapper registration | Modify L457, L473 — replace `Path.GetRelativePath(Directory.GetCurrentDirectory(), f)` with `Path.GetFullPath(f)` |
| `AlRunner/Server.cs` | v2 wire serialization | Modify `SerializeSummary` (L663-694) to include `iterations` field; thread `iterationLoops` through `HandleRunTests` (L243-) into the call |
| `AlRunner/Pipeline.cs` | Pipeline result struct | Confirm `Iterations` already populated on `PipelineResult` (L256) — Server.cs reads from there |
| `protocol-v2.schema.json` | NDJSON schema | Document `coverage[].file` and `capturedValues[].alSourceFile` as absolute; add `iterations` schema to summary |
| `AlRunner.Tests/PipelineTests.cs` | Pipeline behavior | Add tests asserting absolute paths regardless of cwd |
| `AlRunner.Tests/RunTestsStreamingTests.cs` | --server protocol | Add tests asserting iterations field appears in summary when iteration-tracking requested |
| `tests/protocol-v2-iterations/` | Test fixture | Create AL fixture with a for-loop to exercise iteration emission end-to-end |
| `docs/protocol-v2-samples/runtests-iterations.ndjson` | Wire-format sample | Create new sample with iterations in summary |
| `CHANGELOG.md` | Release notes | Append entry under fork's next version |

### ALchemist repo (`U:/Git/ALchemist/`)

| Path | Responsibility | Action |
|------|---------------|--------|
| `src/execution/serverExecutionEngine.ts` | v2 → ExecutionResult mapping | L116 already maps `iterations: response.iterations ?? []`. Add test that asserts this when v2 summary carries iterations |
| `src/runner/outputParser.ts` | v1 JSON parsing | L221 already parses `data.iterations`. No change required; cited so engineer doesn't duplicate |
| `src/iteration/types.ts` | Iteration data shape | No change unless v2 wire shape diverges from v1 (it shouldn't — confirm in Group D) |
| `src/editor/decorations.ts` | Inline render | Replace dedup-to-last (L467-471) with `distributeMessages`-style compact rendering |
| `src/editor/decorations.ts` | Hover provider | Extend `getCapturedValues` to return all values for a (statementId, variable) so hover shows full series |
| `src/extension.ts` | Activation | Remove cwd pin (L177-187) once runner emits absolute paths; replace with assertion that runner is on a build emitting absolute paths (negotiated via protocol version or explicit handshake check) |
| `test/fixtures/protocol-v2-samples/runtests-iterations.ndjson` | Sample wire data | Mirror of runner repo's iteration NDJSON sample |
| `test/suite/decorations.test.ts` | Compact rendering unit | Add tests for distribution behavior |
| `test/suite/serverExecutionEngine.test.ts` | iteration mapping | Add unit test asserting `response.iterations` flows through |
| `test/parity/v1v2Parity.test.ts` | Cross-protocol parity | New file: drive both v1 and v2 producers against same fixture, assert equivalence |
| `test/runParityTests.ts` | Parity test entry point | New file (mirrors `runIntegrationTests.ts` pattern) |
| `test/parity/index.ts` | Mocha bootstrap | New file (mirrors `test/integration/index.ts` pattern) |
| `package.json` | Test scripts | Add `test:parity` script |
| `CHANGELOG.md` | Release notes | Append entry for v0.5.5 |

---

# Group A — AL.Runner: emit absolute paths

**Working repo:** `U:/Git/AL.Runner-protocol-v2/`. All commands run from there.

### Task A1: Failing test — Pipeline emits absolute path regardless of cwd

**Files:**
- Create: `AlRunner.Tests/SourceFilePathEmissionTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using System;
using System.IO;
using AlRunner;
using Xunit;

namespace AlRunner.Tests;

public class SourceFilePathEmissionTests
{
    [Fact]
    public void SourceFileMapper_RegistersAbsolutePath_RegardlessOfCwd()
    {
        // Repro the v0.5.4 bug: when the runner is spawned from VS Code's
        // install dir, Path.GetRelativePath(cwd, file) produces a path that
        // walks up several levels to reach the workspace. ALchemist then
        // can't resolve it against `workspacePath` and silently drops every
        // capture's file filter. The fix is to emit absolute paths so the
        // wire format doesn't depend on the spawner's cwd.
        var tmpDir = Path.Combine(Path.GetTempPath(), "alrunner-test-" + Guid.NewGuid().ToString("N"));
        var alSubdir = Path.Combine(tmpDir, "ALProject");
        Directory.CreateDirectory(alSubdir);
        var alFile = Path.Combine(alSubdir, "CU1.al");
        File.WriteAllText(alFile, "codeunit 50100 CU1\n{\n}\n");

        // Save & change cwd to a directory completely unrelated to the AL file
        // (analogous to VS Code's install dir vs. user's Documents).
        var origCwd = Directory.GetCurrentDirectory();
        var foreignCwd = Path.Combine(Path.GetTempPath(), "foreign-cwd-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(foreignCwd);
        Directory.SetCurrentDirectory(foreignCwd);

        try
        {
            SourceFileMapper.Clear();
            var options = new PipelineOptions();
            options.InputPaths.Add(alFile);

            var pipeline = new Pipeline(options);
            pipeline.Compile();

            var registered = SourceFileMapper.GetFile("CU1");
            Assert.NotNull(registered);
            Assert.True(
                Path.IsPathFullyQualified(registered),
                $"SourceFileMapper.GetFile('CU1') must be an absolute path; got '{registered}'");
            Assert.Equal(
                Path.GetFullPath(alFile).Replace('\\', '/'),
                registered.Replace('\\', '/'));
        }
        finally
        {
            Directory.SetCurrentDirectory(origCwd);
            Directory.Delete(tmpDir, recursive: true);
            Directory.Delete(foreignCwd, recursive: true);
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~SourceFilePathEmissionTests"`

Expected: FAIL — registered path will be a relative `..\..\..\Temp\...\ALProject\CU1.al` shape, failing `Path.IsPathFullyQualified`.

### Task A2: Fix Pipeline.cs to emit absolute paths

**Files:**
- Modify: `AlRunner/Pipeline.cs:457`
- Modify: `AlRunner/Pipeline.cs:473`

- [ ] **Step 1: Replace the two `Path.GetRelativePath(...)` call sites**

Find at line 457:

```csharp
                    var relativePath = Path.GetRelativePath(Directory.GetCurrentDirectory(), f);
                    foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                        SourceFileMapper.Register(objName, relativePath);
```

Replace with:

```csharp
                    var absolutePath = Path.GetFullPath(f).Replace('\\', '/');
                    foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                        SourceFileMapper.Register(objName, absolutePath);
```

Find at line 473:

```csharp
                var relativePath = Path.GetRelativePath(Directory.GetCurrentDirectory(), path);
                foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                    SourceFileMapper.Register(objName, relativePath);
```

Replace with:

```csharp
                var absolutePath = Path.GetFullPath(path).Replace('\\', '/');
                foreach (var objName in SourceFileMapper.ParseObjectDeclarations(src))
                    SourceFileMapper.Register(objName, absolutePath);
```

Rationale for `Replace('\\', '/')`: keep wire format stable across platforms. Forward slashes already match the existing `--server` output style (we logged `C:/Users/.../CU1.al` in `scripts/drive-server.ts`).

- [ ] **Step 2: Run the test to verify it passes**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~SourceFilePathEmissionTests"`

Expected: PASS.

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj`

Expected: All passing. (Existing tests may have used relative-path assertions; if any fail, audit each — they were verifying the bug. Update the assertion to expect absolute paths.)

### Task A3: Add coverage-emission absolute-path test

**Files:**
- Modify: `AlRunner.Tests/SourceFilePathEmissionTests.cs`

- [ ] **Step 1: Add a second fact covering coverage emission**

Append to the test class:

```csharp
[Fact]
public void Coverage_EmitsAbsoluteFilePath_RegardlessOfCwd()
{
    var tmpDir = Path.Combine(Path.GetTempPath(), "alrunner-cov-" + Guid.NewGuid().ToString("N"));
    var alSubdir = Path.Combine(tmpDir, "ALProject");
    Directory.CreateDirectory(alSubdir);
    var alFile = Path.Combine(alSubdir, "CU1.al");
    File.WriteAllText(alFile,
        "codeunit 50100 CU1\n" +
        "{\n" +
        "    procedure DoIt(): Integer\n" +
        "    begin\n" +
        "        exit(1);\n" +
        "    end;\n" +
        "}\n");

    var origCwd = Directory.GetCurrentDirectory();
    var foreignCwd = Path.Combine(Path.GetTempPath(), "foreign-cov-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(foreignCwd);
    Directory.SetCurrentDirectory(foreignCwd);

    try
    {
        SourceFileMapper.Clear();
        Runtime.AlScope.ResetCoverage();
        var options = new PipelineOptions { Coverage = true };
        options.InputPaths.Add(alFile);

        var pipeline = new Pipeline(options);
        var result = pipeline.Compile();
        Assert.NotNull(result.SourceSpans);

        var (hits, totals) = Runtime.AlScope.GetCoverageSets();
        var fileCovs = CoverageReport.ToJson(result.SourceSpans!, hits, totals, result.ScopeToObject!);
        Assert.NotEmpty(fileCovs);
        foreach (var fc in fileCovs)
        {
            Assert.True(
                Path.IsPathFullyQualified(fc.File),
                $"FileCoverage.File must be absolute; got '{fc.File}'");
        }
    }
    finally
    {
        Directory.SetCurrentDirectory(origCwd);
        Directory.Delete(tmpDir, recursive: true);
        Directory.Delete(foreignCwd, recursive: true);
    }
}
```

- [ ] **Step 2: Run to verify it passes (Pipeline fix from A2 propagates)**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~SourceFilePathEmissionTests"`

Expected: PASS for both facts. Coverage paths come from SourceFileMapper, so the A2 fix already covers this; the test cements that contract.

### Task A4: Commit Group A

- [ ] **Step 1: Stage and commit**

Run:

```bash
cd U:/Git/AL.Runner-protocol-v2
git add AlRunner/Pipeline.cs AlRunner.Tests/SourceFilePathEmissionTests.cs
git status
```

Verify only Pipeline.cs and the new test file are staged (no stray edits).

```bash
git commit -m "$(cat <<'EOF'
fix(server): emit absolute paths in SourceFileMapper

Pipeline.cs registered file paths via
Path.GetRelativePath(Directory.GetCurrentDirectory(), file). When the
runner is spawned from VS Code's extension host (cwd = VS Code install
dir), the resulting path walks up several levels to reach the workspace.
Downstream consumers like ALchemist can't resolve such paths against
their own workspace root and silently drop captures.

Switch to Path.GetFullPath + forward-slash normalization. Wire format is
now cwd-independent.
EOF
)"
```

---

# Group B — AL.Runner: emit iterations in v2 summary

### Task B1: Failing test — v2 summary contains iterations

**Files:**
- Modify: `AlRunner.Tests/RunTestsStreamingTests.cs`

- [ ] **Step 1: Locate an existing streaming-test pattern**

Run: `grep -n "iterationTracking\|iterations" U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/RunTestsStreamingTests.cs`

Expected: zero hits — confirming the gap that this group fixes.

- [ ] **Step 2: Add a test that runs --server with iteration tracking enabled and asserts the summary carries iterations**

Append to `RunTestsStreamingTests.cs` (the existing test class):

```csharp
[Fact]
public async Task V2Summary_IncludesIterations_WhenIterationTrackingRequested()
{
    // Repro: protocol v2 dropped iteration data on the wire even though
    // Pipeline.cs already collects it for v1 --output-json. ALchemist's
    // iteration stepper / table view depends on result.iterations being
    // populated end-to-end. This test cements the contract.

    var fixture = TestFixtures.WriteAlFixture(@"
codeunit 50100 LoopFixture
{
    procedure DoLoop(): Integer
    var
        i: Integer;
        sum: Integer;
    begin
        for i := 1 to 3 do
            sum += i;
        exit(sum);
    end;
}");

    var (events, summary) = await RunStreamingAsync(new
    {
        command = "runtests",
        sourcePaths = new[] { fixture.AlFilePath },
        captureValues = true,
        iterationTracking = true,
    });

    Assert.NotNull(summary);
    Assert.True(summary.TryGetProperty("iterations", out var iterationsProp),
        "v2 summary must include 'iterations' field when iterationTracking=true");
    Assert.Equal(JsonValueKind.Array, iterationsProp.ValueKind);
    Assert.True(iterationsProp.GetArrayLength() > 0,
        "iterations array must be non-empty for a fixture that exercises a for-loop");

    var firstLoop = iterationsProp[0];
    Assert.True(firstLoop.TryGetProperty("loopId", out _), "loop has loopId");
    Assert.True(firstLoop.TryGetProperty("sourceFile", out _), "loop has sourceFile");
    Assert.True(firstLoop.TryGetProperty("loopLine", out _), "loop has loopLine");
    Assert.True(firstLoop.TryGetProperty("loopEndLine", out _), "loop has loopEndLine");
    Assert.True(firstLoop.TryGetProperty("iterationCount", out var countProp), "loop has iterationCount");
    Assert.Equal(3, countProp.GetInt32());
    Assert.True(firstLoop.TryGetProperty("steps", out var stepsProp), "loop has steps");
    Assert.Equal(3, stepsProp.GetArrayLength());
}
```

If `TestFixtures.WriteAlFixture` and `RunStreamingAsync` don't exist on the test class, locate the helpers used by existing tests in the same file and call them with the same pattern. (`grep -n "WriteAlFixture\|RunStreamingAsync\|StreamingHelper" U:/Git/AL.Runner-protocol-v2/AlRunner.Tests/RunTestsStreamingTests.cs` will surface the actual names; if the names differ, replace verbatim.)

- [ ] **Step 3: Run to confirm it fails for the right reason**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~V2Summary_IncludesIterations"`

Expected: FAIL with `summary.TryGetProperty("iterations", out _) returned false` — exactly the spec gap.

### Task B2: Thread iterations into v2 summary serialization

**Files:**
- Modify: `AlRunner/Server.cs:663-694` (SerializeSummary signature + body)
- Modify: `AlRunner/Server.cs` (call site of SerializeSummary inside HandleRunTests, around L243-)

- [ ] **Step 1: Extend SerializeSummary signature to accept iterations**

In `AlRunner/Server.cs` find:

```csharp
private static string SerializeSummary(
    List<TestResult> tests,
    int exitCode,
    bool cached,
    List<string>? changedFiles,
    Dictionary<string, List<string>>? compilationErrors,
    List<FileCoverage>? coverage,
    bool cancelled)
{
```

Replace with:

```csharp
private static string SerializeSummary(
    List<TestResult> tests,
    int exitCode,
    bool cached,
    List<string>? changedFiles,
    Dictionary<string, List<string>>? compilationErrors,
    List<FileCoverage>? coverage,
    List<Runtime.IterationTracker.LoopRecord>? iterations,
    bool cancelled)
{
```

- [ ] **Step 2: Add iterations to the anonymous summary object**

Find inside the same method:

```csharp
            coverage = (coverage != null && coverage.Count > 0) ? coverage : null,
            protocolVersion = 2,
        }, JsonOpts);
```

Replace with:

```csharp
            coverage = (coverage != null && coverage.Count > 0) ? coverage : null,
            iterations = (iterations != null && iterations.Count > 0)
                ? iterations.Select(loop => new
                {
                    loopId = loop.LoopId,
                    sourceFile = SourceFileMapper.GetFileForScope(loop.ScopeName, _scopeToObject) ?? loop.SourceFile,
                    loopLine = loop.LoopLine,
                    loopEndLine = loop.LoopEndLine,
                    parentLoopId = loop.ParentLoopId,
                    parentIteration = loop.ParentIteration,
                    iterationCount = loop.IterationCount,
                    steps = loop.Steps.Select(step => new
                    {
                        iteration = step.Iteration,
                        capturedValues = step.CapturedValues.Select(cv => new
                        {
                            variableName = cv.VariableName,
                            value = cv.Value,
                        }),
                        messages = step.Messages,
                        linesExecuted = step.LinesExecuted,
                    }),
                })
                : null,
            protocolVersion = 2,
        }, JsonOpts);
```

If `_scopeToObject` is not in scope inside `SerializeSummary` (it may be a HandleRunTests local), pass it as a parameter or fall back to `loop.SourceFile`. Either way, the field MUST be populated — ALchemist filters captures by `sourceFile` and an empty value drops the loop.

- [ ] **Step 3: Update the call site inside HandleRunTests**

Locate the call (around L243 area, in the streaming handler). Find the line that reads:

```csharp
SerializeSummary(testResults, exitCode, cached, changedFiles, compilationErrors, coverage, cancelled)
```

Replace with:

```csharp
SerializeSummary(testResults, exitCode, cached, changedFiles, compilationErrors, coverage, iterationLoops, cancelled)
```

`iterationLoops` is already collected at Pipeline.cs:232-256 (the v1 path uses it). Plumb it from the Pipeline result through `HandleRunTests` into the call site. Look for `result.Iterations` on the `PipelineResult` instance — that's the value to pass.

If `iterationLoops` isn't already a local in `HandleRunTests`, add it:

```csharp
List<Runtime.IterationTracker.LoopRecord>? iterationLoops = null;
if (request.IterationTracking == true)
{
    iterationLoops = pipelineResult.Iterations;
}
```

(Adapt the variable names to match the surrounding code's conventions — search for how `coverage` is collected in the same method and follow that pattern.)

- [ ] **Step 4: Re-run B1's failing test**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~V2Summary_IncludesIterations"`

Expected: PASS.

- [ ] **Step 5: Run full suite for regressions**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj`

Expected: All passing.

### Task B3: Add a "no iterations when not requested" test

**Files:**
- Modify: `AlRunner.Tests/RunTestsStreamingTests.cs`

- [ ] **Step 1: Add the negative test**

Append:

```csharp
[Fact]
public async Task V2Summary_OmitsIterations_WhenIterationTrackingNotRequested()
{
    var fixture = TestFixtures.WriteAlFixture(@"
codeunit 50100 NoLoop
{
    procedure DoIt(): Integer begin exit(1); end;
}");

    var (_, summary) = await RunStreamingAsync(new
    {
        command = "runtests",
        sourcePaths = new[] { fixture.AlFilePath },
        captureValues = true,
        iterationTracking = false,
    });

    if (summary.TryGetProperty("iterations", out var prop))
    {
        Assert.True(prop.ValueKind == JsonValueKind.Null,
            "iterations must be null/omitted when iterationTracking=false");
    }
    // else: field omitted entirely — also valid.
}
```

- [ ] **Step 2: Run to verify**

Run: `dotnet test AlRunner.Tests/AlRunner.Tests.csproj --filter "FullyQualifiedName~V2Summary_OmitsIterations"`

Expected: PASS.

### Task B4: Commit Group B

- [ ] **Step 1: Stage and commit**

Run:

```bash
cd U:/Git/AL.Runner-protocol-v2
git add AlRunner/Server.cs AlRunner.Tests/RunTestsStreamingTests.cs
git commit -m "$(cat <<'EOF'
feat(server): emit iterations in v2 summary

Pipeline.cs already collects per-loop iteration data for the v1
--output-json path. The v2 protocol introduced in Plan E1 dropped this
on the wire — Server.cs's SerializeSummary never plumbed iterationLoops
through. ALchemist's iteration stepper and table-view depend on
result.iterations being populated end-to-end and silently degraded
to no-op when v2 became the default.

Pipe iterationLoops through HandleRunTests into SerializeSummary and
emit it as a structured array on the v2 summary, matching the v1 JSON
shape.

Field is omitted (null) when iterationTracking is not requested, to
keep summary size minimal for runs that don't need it.
EOF
)"
```

---

# Group C — AL.Runner: schema + sample updates

### Task C1: Update protocol-v2.schema.json

**Files:**
- Modify: `protocol-v2.schema.json`

- [ ] **Step 1: Read current schema to find the summary type**

Run: `grep -n "summary\|iterations\|coverage\[\|alSourceFile" U:/Git/AL.Runner-protocol-v2/protocol-v2.schema.json`

Note the line ranges where (a) the summary object's properties are defined, (b) the coverage array's items, and (c) the capturedValues array's items. The schema uses JSON Schema Draft 7 / 2020-12 conventions.

- [ ] **Step 2: Document `coverage[].file` and `capturedValues[].alSourceFile` as absolute**

Find the existing definition for coverage's `file` property. Add a `description` field (or extend the existing one) to read:

```json
"file": {
  "type": "string",
  "description": "Absolute path to the source file (forward-slash separators on all platforms). Wire format is cwd-independent: AL.Runner emits `Path.GetFullPath(file).Replace('\\\\','/')`."
}
```

Apply the same description language to `capturedValues[].alSourceFile`.

- [ ] **Step 3: Add `iterations` to the summary schema**

Inside the summary object's `properties`, add:

```json
"iterations": {
  "type": ["array", "null"],
  "description": "Per-loop iteration data, populated when the runtests request set `iterationTracking: true`. Null or omitted otherwise.",
  "items": {
    "type": "object",
    "required": ["loopId", "sourceFile", "loopLine", "loopEndLine", "iterationCount", "steps"],
    "properties": {
      "loopId": { "type": "string", "description": "Unique identifier for this loop instance within the run." },
      "sourceFile": { "type": "string", "description": "Absolute path to the AL file containing the loop." },
      "loopLine": { "type": "integer", "description": "1-based line number of the loop's opening keyword." },
      "loopEndLine": { "type": "integer", "description": "1-based line number of the loop's `end;`." },
      "parentLoopId": { "type": ["string", "null"], "description": "When this loop is nested, the loopId of the enclosing loop. Null at top level." },
      "parentIteration": { "type": ["integer", "null"], "description": "1-based iteration index of the parent at which this nested loop ran. Null at top level." },
      "iterationCount": { "type": "integer", "description": "Total iterations recorded." },
      "steps": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["iteration", "capturedValues", "messages", "linesExecuted"],
          "properties": {
            "iteration": { "type": "integer", "description": "1-based iteration number." },
            "capturedValues": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["variableName", "value"],
                "properties": {
                  "variableName": { "type": "string" },
                  "value": { "type": "string" }
                }
              }
            },
            "messages": { "type": "array", "items": { "type": "string" } },
            "linesExecuted": { "type": "array", "items": { "type": "integer" } }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Verify the schema is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('U:/Git/AL.Runner-protocol-v2/protocol-v2.schema.json','utf8')); console.log('valid')"`

Expected: `valid` printed, no parse error.

### Task C2: Add a sample NDJSON for iterations

**Files:**
- Create: `docs/protocol-v2-samples/runtests-iterations.ndjson`

- [ ] **Step 1: Capture a real iterations sample using the new binary**

Run from a workspace-rooted cwd (so paths show absolute):

```bash
cd U:/Git/AL.Runner-protocol-v2
dotnet build AlRunner/AlRunner.csproj -c Release
node -e "
const cp = require('child_process');
const proc = cp.spawn('AlRunner/bin/Release/net9.0/AlRunner.exe', ['--server'], {cwd:'tests/protocol-v2-iterations'});
proc.stdout.on('data', d => process.stdout.write(d));
proc.stderr.on('data', d => process.stderr.write(d));
setTimeout(() => {
  proc.stdin.write(JSON.stringify({command:'runtests', sourcePaths:['tests/protocol-v2-iterations'], captureValues:true, iterationTracking:true, coverage:true})+'\n');
}, 300);
setTimeout(() => proc.stdin.write(JSON.stringify({command:'shutdown'})+'\n'), 8000);
" > docs/protocol-v2-samples/runtests-iterations.ndjson
```

You'll need to first create the `tests/protocol-v2-iterations/` fixture directory with an AL file containing a for-loop. Use:

```bash
mkdir -p tests/protocol-v2-iterations/test
cat > tests/protocol-v2-iterations/test/Loop.Codeunit.al <<'EOF'
codeunit 50200 LoopTest
{
    Subtype = Test;

    [Test]
    procedure RunsLoop()
    var
        i: Integer;
        sum: Integer;
    begin
        for i := 1 to 3 do
            sum += i;
        if sum <> 6 then Error('expected 6');
    end;
}
EOF
```

- [ ] **Step 2: Inspect the captured NDJSON**

Open `docs/protocol-v2-samples/runtests-iterations.ndjson`. Verify:
- Test event includes alSourceFile as absolute path
- Summary's `iterations` array exists with at least one loop entry
- The loop entry has `iterationCount: 3` and 3 steps

If the file is empty or malformed, the build/spawn failed. Re-run with verbose output and fix.

### Task C3: Validate sample against the schema

**Files:**
- Modify: existing schema-validation script if one exists (`grep -rn "validate" U:/Git/AL.Runner-protocol-v2/tools/`); otherwise inline validation

- [ ] **Step 1: Run schema validation against the new sample**

If a validator exists in the repo, use it. Otherwise:

```bash
cd U:/Git/AL.Runner-protocol-v2
npm install --no-save ajv ajv-formats
node -e "
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const fs = require('fs');
const ajv = new Ajv({allErrors: true});
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync('protocol-v2.schema.json','utf8'));
const validate = ajv.compile(schema);
const lines = fs.readFileSync('docs/protocol-v2-samples/runtests-iterations.ndjson','utf8').split('\n').filter(l => l.trim());
let bad = 0;
for (const line of lines) {
  const obj = JSON.parse(line);
  if (!validate(obj)) {
    console.error('FAIL:', line.slice(0,80), '\n  errors:', validate.errors);
    bad++;
  }
}
if (bad === 0) console.log('all', lines.length, 'lines valid');
else process.exit(1);
"
```

Expected: `all N lines valid`.

If validation fails, the schema or the sample is wrong. Fix whichever — the schema is the source of truth for downstream consumers.

### Task C4: Commit Group C

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/AL.Runner-protocol-v2
git add protocol-v2.schema.json docs/protocol-v2-samples/runtests-iterations.ndjson tests/protocol-v2-iterations/
git commit -m "$(cat <<'EOF'
docs(schema): document absolute paths and iterations in v2 summary

Wire-format documentation lagged behind implementation:
- coverage[].file and capturedValues[].alSourceFile are now spec'd as
  absolute fwd-slash paths.
- iterations is added to the v2 summary schema with the same shape as
  the v1 --output-json iterations array.

Adds a captured NDJSON sample (runtests-iterations.ndjson) and a
fixture (tests/protocol-v2-iterations) so downstream consumers can
diff against a known-good wire payload.
EOF
)"
```

---

# Group D — ALchemist: consume iterations from v2

**Working repo:** `U:/Git/ALchemist/`. All commands run from there. **Prerequisite:** Group A + B + C committed in the AL.Runner repo, fork binary rebuilt at `U:/Git/AL.Runner-protocol-v2/AlRunner/bin/Release/net9.0/AlRunner.exe`.

### Task D1: Failing test — engine maps v2 iterations into ExecutionResult

**Files:**
- Modify: `test/suite/serverExecutionEngine.test.ts`

- [ ] **Step 1: Read the existing test layout**

Run: `grep -n "iterations\|protocolVersion" U:/Git/ALchemist/test/suite/serverExecutionEngine.test.ts | head -10`

Note the existing test patterns (look for tests that build a fake response with v2 fields). Mirror that style.

- [ ] **Step 2: Add the failing test**

Append to the existing suite block:

```typescript
test('v2 summary with iterations populates result.iterations', async () => {
  const sp = makeFakeServerProcess({
    response: {
      type: 'summary',
      tests: [],
      passed: 0, failed: 0, errors: 0, total: 0,
      exitCode: 0,
      protocolVersion: 2,
      iterations: [{
        loopId: 'L1',
        sourceFile: 'C:/x/CU1.al',
        loopLine: 5,
        loopEndLine: 9,
        parentLoopId: null,
        parentIteration: null,
        iterationCount: 3,
        steps: [
          { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [6] },
          { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [6] },
          { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [6] },
        ],
      }],
    },
  });
  const engine = new ServerExecutionEngine(sp);
  const result = await engine.runTests({ sourcePaths: ['/ws'], iterationTracking: true });
  assert.strictEqual(result.iterations.length, 1, 'iterations must flow through engine mapping');
  assert.strictEqual(result.iterations[0].loopId, 'L1');
  assert.strictEqual(result.iterations[0].iterationCount, 3);
  assert.strictEqual(result.iterations[0].steps.length, 3);
  assert.strictEqual(result.iterations[0].steps[0].capturedValues[0].value, '1');
});
```

If `makeFakeServerProcess` doesn't exist, follow the pattern of an existing v2 test in the same file — there are several stubs of `ServerProcess` already.

- [ ] **Step 3: Run the test**

Run: `npm run test:unit -- --grep "v2 summary with iterations"`

Expected: This MAY pass already because `serverExecutionEngine.ts:116` already maps `response.iterations ?? []`. If it passes, the test still has value as a regression lock — proceed to commit. If it fails, the engine isn't routing v2 iterations correctly; investigate and fix.

### Task D2: Smoke test asserts iterations from real fork binary

**Files:**
- Modify: `test/smoke/runtimeSmoke.smoke.ts`

- [ ] **Step 1: Extend the existing smoke test**

After the existing `assert.ok(coverageV2.length > 0, ...)` block, add:

```typescript
// Group D: v2 summary must carry iteration data when iterationTracking
// is requested (Plan E3). Without this, iterationStore stays empty and
// the CodeLens stepper / table view silently degrade — exactly the
// regression that v2 introduced in Plan E1/E2.
assert.ok(
  result.iterations.length > 0,
  'result.iterations must be non-empty for a fixture exercising a for-loop ' +
  '(MyProcedure has `for i := 1 to 10 do begin ... end`). ' +
  'If empty, AL.Runner v2 isn\'t plumbing iterations into the summary ' +
  '(see Plan E3 Group B in AL.Runner repo).',
);
const cu1Loop = result.iterations.find(loop =>
  loop.sourceFile.toLowerCase().endsWith('cu1.al'));
assert.ok(cu1Loop, 'iterations must include a loop in CU1.al');
assert.strictEqual(cu1Loop.iterationCount, 10, 'CU1.al for-loop iterates 10 times');
assert.strictEqual(cu1Loop.steps.length, 10, 'all 10 steps recorded');
```

- [ ] **Step 2: Run the smoke test**

Run: `npm run test:smoke`

Expected: PASS only if the runner binary at `alchemist.alRunnerPath` was rebuilt from a checkout including Group B. If FAIL with "iterations must be non-empty", the runner build is stale — rebuild via `dotnet build AlRunner/AlRunner.csproj -c Release` in the AL.Runner repo.

### Task D3: Commit Group D

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add test/suite/serverExecutionEngine.test.ts test/smoke/runtimeSmoke.smoke.ts
git commit -m "$(cat <<'EOF'
test(consumer): assert v2 iterations flow through engine + smoke

ServerExecutionEngine already mapped response.iterations into
ExecutionResult.iterations (line 116) but no test guarded the contract.
The v2 spec gap that left iterations off the wire was invisible in
ALchemist tests because none of them asserted the data arrived.

Add unit + smoke coverage so the next regression at the wire-format
level surfaces here, not in the user's editor.
EOF
)"
```

---

# Group E — ALchemist: compact-form inline display

### Task E1: Failing test — repeated values per (statementId, variable) render compactly

**Files:**
- Modify: `test/suite/decorations.test.ts`

- [ ] **Step 1: Inspect the existing distributeMessages test for the format we want to mirror**

Run: `grep -n "distributeMessages\|first .. last\|×" U:/Git/ALchemist/test/suite/decorations.test.ts U:/Git/ALchemist/src/editor/decorations.ts`

Note the expected compact format: `first … last (×N)` for >3 values, joined-by-pipe for 2-3 values, plain for 1 value. The same convention should apply to captures.

- [ ] **Step 2: Add the failing test**

Append to the existing `decorations.test.ts` suite (or add a new suite at the bottom):

```typescript
suite('applyInlineCapturedValues — compact loop rendering', () => {
  test('multiple values per (statementId, variable) render as compact loop summary', () => {
    const dm = new DecorationManager(__dirname);
    const calls: { type: any; ranges: any[] }[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const editor = makeFakeEditor(filePath, calls, { lineCount: 10 });

    // 10 captures of `myInt` at statementId 2 (mimics a for 1..10 loop).
    const captures: CapturedValue[] = [];
    for (let v = 2; v <= 56; v += Math.floor(56 / 10)) {
      captures.push({
        scopeName: 's', sourceFile: filePath.replace(/\\/g, '/'),
        variableName: 'myInt', value: String(v), statementId: 2,
      });
    }
    captures.length = 10; // ensure exactly 10

    const result = makeV2ResultWithCoverage([{
      name: 'TestProc', status: 'passed', durationMs: 0,
      capturedValues: captures.map(cv => ({
        scopeName: cv.scopeName, objectName: 'CU1',
        alSourceFile: cv.sourceFile, variableName: cv.variableName,
        value: cv.value, statementId: cv.statementId,
      })),
      alSourceFile: filePath.replace(/\\/g, '/'),
    } as any], filePath.replace(/\\/g, '/'));

    dm.applyResults(editor, result, workspacePath);

    const captureCalls = calls.filter(c => c.ranges.length > 0 && c.ranges[0]?.renderOptions?.after);
    assert.ok(captureCalls.length > 0, 'must paint at least one capture decoration');

    // The decoration's contentText must show compact form, not just the last value.
    const contentTexts = captureCalls.flatMap(c =>
      c.ranges.map(r => r.renderOptions.after.contentText as string));
    const compact = contentTexts.find(t => /myInt\s*=.*\.\..*\(×\d+\)/.test(t));
    assert.ok(
      compact,
      `expected a "myInt = 2 .. 56 (×10)"-style compact decoration; got ${JSON.stringify(contentTexts)}`,
    );
  });

  test('single value per (statementId, variable) still renders as plain assignment', () => {
    const dm = new DecorationManager(__dirname);
    const calls: { type: any; ranges: any[] }[] = [];
    const path = require('path') as typeof import('path');
    const workspacePath = path.resolve(__dirname, 'fixture-ws');
    const filePath = path.join(workspacePath, 'CU1.al');
    const editor = makeFakeEditor(filePath, calls, { lineCount: 10 });

    const result = makeV2ResultWithCoverage([{
      name: 'TestProc', status: 'passed', durationMs: 0,
      capturedValues: [{
        scopeName: 's', objectName: 'CU1',
        alSourceFile: filePath.replace(/\\/g, '/'),
        variableName: 'myInt', value: '1', statementId: 0,
      }],
      alSourceFile: filePath.replace(/\\/g, '/'),
    } as any], filePath.replace(/\\/g, '/'));

    dm.applyResults(editor, result, workspacePath);

    const captureCalls = calls.filter(c => c.ranges.length > 0 && c.ranges[0]?.renderOptions?.after);
    const contentTexts = captureCalls.flatMap(c =>
      c.ranges.map(r => r.renderOptions.after.contentText as string));
    assert.ok(
      contentTexts.some(t => /myInt\s*=\s*1\b/.test(t) && !t.includes('×')),
      `single-value capture must NOT use compact form; got ${JSON.stringify(contentTexts)}`,
    );
  });
});

// --- helpers ---
function makeV2ResultWithCoverage(tests: any[], file: string): ExecutionResult {
  return {
    mode: 'test', tests, messages: [], stderrOutput: [],
    summary: { passed: 1, failed: 0, errors: 0, total: 1 },
    coverage: [],
    coverageV2: [{
      file,
      lines: [{ line: 1, hits: 1 }, { line: 3, hits: 10 }, { line: 5, hits: 5 }],
      totalStatements: 5, hitStatements: 5,
    }],
    exitCode: 0, durationMs: 1, capturedValues: [],
    cached: false, iterations: [], protocolVersion: 2,
  };
}
```

If `makeFakeEditor` and other helpers don't exist in `decorations.test.ts` already, look in `decorationManager.perTest.test.ts` — they're defined there and can be moved to a shared `test/helpers/decorations.ts` if duplicated. (Minor refactor; do it only if the test would otherwise duplicate >20 lines.)

- [ ] **Step 3: Run to confirm it fails for the right reason**

Run: `npm run test:unit -- --grep "compact loop rendering"`

Expected: FAIL — current code dedupes to last value via `lastValues.set(...)` so the contentText is `myInt = 56` (no `..` or `×`).

### Task E2: Replace dedup with distribution-based rendering

**Files:**
- Modify: `src/editor/decorations.ts:467-498` (the `for (const cv of lastValues.values())` block area)

- [ ] **Step 1: Read the existing distributeMessages helper for the formatting convention**

It's in the same file. Verify the format strings exactly so captures match:

```
1 value         → "value"
2-3 values      → "v1 | v2 | v3"
4+ values       → "first … last (×N)"           (note: U+2025 horizontal ellipsis-ish, used in distributeMessages)
```

Confirm by reading `src/editor/decorations.ts:18-62` (the existing `distributeMessages` definition).

- [ ] **Step 2: Replace the dedup loop with a group-and-distribute loop**

Find:

```typescript
    // Group captured values by statementId, keeping only the last value per variable per statement
    const lastValues = new Map<string, CapturedValue>();
    for (const cv of fileValues) {
      const key = `${cv.statementId}:${cv.variableName}`;
      lastValues.set(key, cv);
    }
```

Replace with:

```typescript
    // Group captured values by (statementId, variable) keeping ALL values
    // so loops render as compact "first … last (×N)" instead of just the
    // last value. This restores v0.3.0 inline behavior that v0.5.0 lost
    // when it dedup'd here. Hover (getCapturedValues) already returns
    // every value so the full series is available on demand.
    const groupedValues = new Map<string, CapturedValue[]>();
    for (const cv of fileValues) {
      const key = `${cv.statementId}:${cv.variableName}`;
      const arr = groupedValues.get(key) ?? [];
      arr.push(cv);
      groupedValues.set(key, arr);
    }
```

Then find:

```typescript
    for (const cv of lastValues.values()) {
      // Map statementId to a covered line (best effort: statementId as index into covered lines)
      if (cv.statementId >= 0 && cv.statementId < coveredLines.length) {
        const lineNumber = coveredLines[cv.statementId].number - 1;
        if (lineNumber >= 0 && lineNumber < editor.document.lineCount) {
          decorations.push({
            range: editor.document.lineAt(lineNumber).range,
            renderOptions: {
              after: { contentText: `  ${cv.variableName} = ${cv.value}` },
            },
          });
        }
      }
    }
```

Replace with:

```typescript
    for (const [, group] of groupedValues) {
      const head = group[0];
      // Map statementId to a covered line (best effort: statementId as index into covered lines)
      if (head.statementId < 0 || head.statementId >= coveredLines.length) continue;
      const lineNumber = coveredLines[head.statementId].number - 1;
      if (lineNumber < 0 || lineNumber >= editor.document.lineCount) continue;

      const display = formatCaptureGroup(group);
      decorations.push({
        range: editor.document.lineAt(lineNumber).range,
        renderOptions: {
          after: { contentText: `  ${head.variableName} = ${display}` },
        },
      });
    }
```

- [ ] **Step 3: Add the formatCaptureGroup helper near the existing distributeMessages**

Add this private function inside the same `decorations.ts` file (above the class, alongside `distributeMessages`):

```typescript
/**
 * Format an ordered list of captured values for inline display.
 * Mirrors `distributeMessages`'s compact-form convention so messages
 * and captures look consistent in the editor.
 *
 * Examples:
 *   formatCaptureGroup([{value:'1'}])                            → '1'
 *   formatCaptureGroup([{value:'1'},{value:'2'}])                → '1 | 2'
 *   formatCaptureGroup([{value:'1'},{value:'2'},{value:'3'}])    → '1 | 2 | 3'
 *   formatCaptureGroup([{value:'2'},...,{value:'56'}]) // 10 vals → '2 ‥ 56  (×10)'
 */
export function formatCaptureGroup(group: CapturedValue[]): string {
  if (group.length === 0) return '';
  if (group.length === 1) return group[0].value;
  if (group.length <= 3) return group.map(cv => cv.value).join(' | ');
  return `${group[0].value} ‥ ${group[group.length - 1].value}  (×${group.length})`;
}
```

- [ ] **Step 4: Run the test from E1**

Run: `npm run test:unit -- --grep "compact loop rendering"`

Expected: PASS for both tests.

- [ ] **Step 5: Run full unit suite for regressions**

Run: `npm run test:unit`

Expected: All passing. Existing tests that asserted `myInt = <last value>` may break — they were verifying the bug. Update those assertions to expect compact form.

### Task E3: Hover provider returns full series

**Files:**
- Modify: `src/editor/decorations.ts` (`getCapturedValues` if needed)
- Modify: `src/editor/hoverProvider.ts`

- [ ] **Step 1: Inspect the current hover behavior**

Run: `grep -n "getCapturedValues\|provideHover" U:/Git/ALchemist/src/editor/hoverProvider.ts`

Read the existing hover logic. The hover already shows captured values; check whether it dedupes or shows all.

- [ ] **Step 2: Add a hover test for the multi-value case**

Append to `test/suite/hoverProvider.test.ts`:

```typescript
test('hover on a loop variable shows full value series, not just last', () => {
  const dm = new DecorationManager(__dirname);
  for (let v = 1; v <= 10; v++) {
    dm.setCapturedValuesForTest('TestProc', [
      // ...accumulating; the API may take all-at-once, follow existing pattern
    ]);
  }
  // Drive provideHover and assert hover content includes all 10 values
  // (not just the 10th).
  // Adapt to existing hover provider API in U:/Git/ALchemist/src/editor/hoverProvider.ts.
});
```

The exact test depends on the hover provider's API — read `src/editor/hoverProvider.ts` first and write the test that exercises the realistic provideHover call. If hover already returns all values, this test passes immediately and acts as a regression guard.

- [ ] **Step 3: Run the hover test**

Run: `npm run test:unit -- --grep "hover on a loop variable"`

Expected: PASS if hover already shows all values; FAIL otherwise. If FAIL, modify hover provider to use the full grouped values.

### Task E4: Commit Group E

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add src/editor/decorations.ts src/editor/hoverProvider.ts test/suite/decorations.test.ts test/suite/hoverProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(decorations): compact-form inline rendering for loop captures

v0.3.0 inline display showed loop iterations as `myInt = 2 .. 56 (×10)`.
Plan E2's port to v2 dedup'd captures by (statementId, variable),
keeping only the last value — so loops collapsed to `myInt = 56`. The
data was always there (v2 captures arrive multi-valued), just
discarded.

Replace the dedup with the same `first .. last (×N)` distribution
already used by Message() output. Single values still render plain.
Hover continues to expose the full series for users who need every
iteration's value.
EOF
)"
```

---

# Group F — ALchemist: drop the cwd-pin workaround

**Prerequisite:** Group A committed in AL.Runner repo and the binary at `alchemist.alRunnerPath` rebuilt from a checkout including A. After A, the runner emits absolute paths regardless of cwd, so the v0.5.4 cwd pin in `extension.ts` is dead code.

### Task F1: Failing test — extension does not pin cwd

**Files:**
- Modify: `test/suite/serverProcess.test.ts`

- [ ] **Step 1: Update the existing cwd test to reflect new expectation**

Find the test added in v0.5.4: `'forwards cwd to the spawner so AL.Runner emits workspace-relative source paths'`. Replace its body and rename to match new expectation:

```typescript
test('does NOT pin cwd by default; spawned runner inherits caller cwd', async () => {
  // Plan E3: AL.Runner now emits absolute paths via Path.GetFullPath
  // (Pipeline.cs), so the wire format is cwd-independent. We removed
  // the v0.5.4 cwd-pin workaround; this test cements that.
  const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
  setImmediate(() => proc.pushStdout('{"ready":true}'));
  setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
  await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
  const callArgs = spawner.firstCall.args;
  assert.strictEqual(
    callArgs[2],
    undefined,
    'spawner third arg must be undefined when cwd is not opted into',
  );
  await sp.dispose();
});

test('cwd is still respected when explicitly provided (defensive depth)', async () => {
  const sp = new ServerProcess({
    runnerPath: 'al-runner',
    spawner,
    cwd: 'C:/some/explicit/cwd',
  });
  setImmediate(() => proc.pushStdout('{"ready":true}'));
  setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
  await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
  assert.deepStrictEqual(spawner.firstCall.args[2], { cwd: 'C:/some/explicit/cwd' });
  await sp.dispose();
});
```

- [ ] **Step 2: Run to verify the first test fails (extension still pins)**

Run: `npm run test:unit -- --grep "does NOT pin cwd"`

Expected: This test passes already — the `cwd` parameter on `ServerProcess` is opt-in. The failure point will be in extension.ts, where the workaround is the offender.

### Task F2: Remove the cwd workaround from extension.ts

**Files:**
- Modify: `src/extension.ts:175-191` (the `executionEngineReady = runnerManager.ensureInstalled()...` chain with the cwd pin)

- [ ] **Step 1: Replace the cwd-pinning block**

Find:

```typescript
  executionEngineReady = runnerManager.ensureInstalled()
    .then((runnerPath) => {
      // Pin the runner's cwd to the first workspace folder. AL.Runner's
      // SourceFileMapper emits paths via `Path.GetRelativePath(cwd, file)`
      // (Pipeline.cs:457). If we don't set cwd here, the child inherits
      // the extension host's cwd (typically VS Code's install dir, which
      // is unrelated to the project) and source paths in JSON output
      // become `../../../../Documents/AL/...` strings that the inline-
      // capture filter can't resolve against the workspace. Pinning to a
      // workspace folder makes emitted paths workspace-relative — and
      // applyInlineCapturedValues then resolves them correctly via
      // `path.resolve(workspacePath, sourceFile)`.
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      serverProcess = new ServerProcess({ runnerPath, cwd });
      executionEngine = new ServerExecutionEngine(serverProcess);
    })
```

Replace with:

```typescript
  executionEngineReady = runnerManager.ensureInstalled()
    .then((runnerPath) => {
      // Plan E3: AL.Runner v2 emits absolute paths via Path.GetFullPath
      // (Pipeline.cs), so the wire format is cwd-independent. The cwd
      // pin previously needed here as a workaround is removed. The
      // ServerProcess `cwd` option remains available for future
      // diagnostic scenarios but is not exercised on the happy path.
      serverProcess = new ServerProcess({ runnerPath });
      executionEngine = new ServerExecutionEngine(serverProcess);
    })
```

- [ ] **Step 2: Build the bundle and re-run the smoke test**

Run:

```bash
npm run package
npm run test:smoke
```

Expected: PASS. The smoke test exercises the full activation → engine → handleResult → applyResults path with a real fork binary; if the binary at `alchemist.alRunnerPath` was rebuilt from a Group-A checkout, paths arrive absolute and the matcher resolves them.

If FAIL with `Inline: N captures → 0 for CU1.al`, the runner binary is stale (rebuild from a Group-A checkout) OR Group A was incomplete. Don't paper over by reinstating the cwd pin — fix the runner.

### Task F3: Commit Group F

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add src/extension.ts test/suite/serverProcess.test.ts
git commit -m "$(cat <<'EOF'
refactor(extension): drop cwd-pin workaround now that runner emits abs paths

v0.5.4 added a defensive cwd pin to compensate for AL.Runner emitting
source paths relative to its spawn cwd (Pipeline.cs path-emission bug).
Plan E3 fixed that upstream — paths are now Path.GetFullPath, so the
wire format no longer depends on the spawner's cwd.

Remove the workaround. ServerProcess.cwd remains available as a
defensive option for future diagnostic scenarios. The runtime path is
cleaner and the bug-incident comment is now history (release notes
trail it).
EOF
)"
```

---

# Group G — Cross-protocol parity test suite

**Goal:** Drive a single AL fixture through both v1 (`--output-json`) and v2 (`--server`) producers, normalize each `ExecutionResult`, and assert structural equivalence on the union of fields the UI consumes. This is the test that would have caught the v0.3.0 → v0.5.0 silent feature drop.

### Task G1: Skeleton — parity test entry point

**Files:**
- Create: `test/runParityTests.ts`
- Create: `test/parity/index.ts`

- [ ] **Step 1: Create the runner entry**

`test/runParityTests.ts`:

```typescript
import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

/**
 * Parity-test entry. Drives a single AL fixture through both producers
 * and asserts UI-relevant fields are equivalent.
 *
 * Skips when the fork binary or fixture isn't present (CI-friendly).
 */
const FORK_BINARY = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './parity/index');

    if (!fs.existsSync(FORK_BINARY)) {
      console.warn(`Parity tests require fork binary at ${FORK_BINARY}; skipping.`);
      process.exit(0);
    }

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { ALCHEMIST_TEST_HOOKS: '1' },
    });
  } catch (err) {
    console.error('Parity tests failed:', err);
    process.exit(1);
  }
}

main();
```

`test/parity/index.ts`:

```typescript
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 90_000 });
  const testsRoot = path.resolve(__dirname, '.');
  const files = await glob('**/*.parity.js', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      failures > 0 ? reject(new Error(`${failures} parity tests failed.`)) : resolve();
    });
  });
}
```

- [ ] **Step 2: Add the test:parity npm script**

Modify `package.json` scripts:

```json
"test:parity": "npm run package && npm run test-compile && node ./out/test/runParityTests.js",
```

- [ ] **Step 3: Verify infra without writing the test yet**

Run: `npm run test:parity`

Expected: A line like `0 passing` (no `*.parity.js` files yet, but the harness boots cleanly).

### Task G2: Failing test — captures parity (v1 vs v2)

**Files:**
- Create: `test/parity/captures.parity.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TestHooks } from '../../src/extension';

const FORK = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;
const FIXTURE_DIR = path.resolve(__dirname, '../../../test/fixtures/parity-loop-fixture');

/**
 * Run the fork binary in legacy v1 (--output-json) mode and parse the result.
 */
function runV1(): Promise<any> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const proc = cp.spawn(FORK, [
      '--output-json',
      '--capture-values',
      '--iteration-tracking',
      '--coverage',
      FIXTURE_DIR,
    ], { cwd: FIXTURE_DIR });
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('exit', code => {
      if (code !== 0 && code !== 1) return reject(new Error(`v1 exited ${code}: ${stdout.slice(-200)}`));
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (e) {
        reject(new Error(`v1 stdout not JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Drive the v2 path through the activated extension's TestHooks.
 * We get an ExecutionResult that has already been mapped from v2 NDJSON.
 */
async function runV2(hooks: TestHooks): Promise<any> {
  return await hooks.runTestsAndApply([FIXTURE_DIR]);
}

/**
 * Normalize both shapes into a UI-relevant subset that's comparable
 * across protocols. Discards wire-format-specific fields (durationMs,
 * cached, protocolVersion, etc.) and focuses on what the UI displays.
 */
function normalizeForParity(input: any): any {
  return {
    captures: (input.capturedValues ?? input.tests?.flatMap?.((t: any) => t.capturedValues ?? []) ?? [])
      .map((cv: any) => ({
        scope: cv.scopeName,
        variable: cv.variableName,
        value: cv.value,
        statementId: cv.statementId,
        sourceFileBasename: path.basename(cv.sourceFile ?? cv.alSourceFile ?? ''),
      }))
      .sort((a: any, b: any) => a.statementId - b.statementId || a.variable.localeCompare(b.variable) || String(a.value).localeCompare(String(b.value))),
    iterations: (input.iterations ?? []).map((loop: any) => ({
      iterationCount: loop.iterationCount,
      stepCount: loop.steps?.length,
      sourceFileBasename: path.basename(loop.sourceFile ?? ''),
    })),
    coverage: (input.coverage ?? input.coverageV2 ?? []).map((cov: any) => ({
      fileBasename: path.basename(cov.filename ?? cov.file ?? ''),
      hitLineCount: (cov.lines ?? []).filter((l: any) => (l.hits ?? 0) > 0).length,
    })).sort((a: any, b: any) => a.fileBasename.localeCompare(b.fileBasename)),
    testStatuses: (input.tests ?? []).map((t: any) => ({ name: t.name, status: t.status }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name)),
  };
}

suite('Parity — v1 (--output-json) and v2 (--server) produce equivalent UI state', function () {
  this.timeout(60_000);

  if (!fs.existsSync(FORK)) {
    test.skip(`fork binary missing at ${FORK}; skipping parity suite`, () => {});
    return;
  }
  if (!fs.existsSync(FIXTURE_DIR)) {
    test.skip(`fixture missing at ${FIXTURE_DIR}; skipping parity suite`, () => {});
    return;
  }

  test('captures, iterations, coverage, and test statuses match between v1 and v2', async () => {
    const vscode = require('vscode');
    await vscode.workspace.getConfiguration('alchemist').update(
      'alRunnerPath', FORK, vscode.ConfigurationTarget.Global);
    const ext = vscode.extensions.getExtension('SShadowSdk.al-chemist');
    const hooks = (await ext.activate()) as TestHooks;
    await hooks.awaitEngineReady();

    // Run both producers
    const v1Raw = await runV1();
    const v2Raw = await runV2(hooks);

    const v1 = normalizeForParity(v1Raw);
    const v2 = normalizeForParity(v2Raw);

    assert.deepStrictEqual(
      v2.testStatuses, v1.testStatuses,
      'test statuses must match across producers',
    );
    assert.deepStrictEqual(
      v2.iterations, v1.iterations,
      'iteration data (count + step count + file) must match across producers',
    );
    assert.deepStrictEqual(
      v2.coverage, v1.coverage,
      'coverage (file + hit-line count) must match across producers',
    );
    assert.deepStrictEqual(
      v2.captures, v1.captures,
      'captured values (scope + var + value + statementId + file basename) must match across producers',
    );
  });
});
```

- [ ] **Step 2: Create the parity fixture**

The fixture must exercise: a `[Test]` procedure, captures, a for-loop (for iterations), and coverage. Reuse the smoke fixture pattern:

```bash
mkdir -p test/fixtures/parity-loop-fixture
cat > test/fixtures/parity-loop-fixture/app.json <<'EOF'
{
  "id": "11223344-5566-7788-99aa-bbccddeeff00",
  "name": "ParityFixture",
  "publisher": "ALchemist",
  "version": "1.0.0.0",
  "idRanges": [{ "from": 50300, "to": 50349 }],
  "runtime": "12.0",
  "features": ["NoImplicitWith"]
}
EOF
cat > test/fixtures/parity-loop-fixture/CU1.al <<'EOF'
codeunit 50300 ParityCU
{
    procedure DoLoop(): Integer
    var
        i: Integer;
        sum: Integer;
    begin
        for i := 1 to 5 do
            sum += i;
        exit(sum);
    end;
}
EOF
cat > test/fixtures/parity-loop-fixture/Test.al <<'EOF'
codeunit 50301 ParityTest
{
    Subtype = Test;

    [Test]
    procedure RunsLoop()
    var
        cu: Codeunit ParityCU;
    begin
        if cu.DoLoop() <> 15 then Error('expected 15');
    end;
}
EOF
```

- [ ] **Step 3: Run to confirm parity test fails on a meaningful divergence**

Run: `npm run test:parity`

Expected: This will likely fail on `iterations` parity (v1 emits, v2 emits only after Group B; and on the count/order of captures because v2 may differ from v1 on per-test scoping). The test reveals every actual divergence.

If it passes immediately, you're done — but verify by temporarily commenting one of the assertions and confirming it fires under the right divergence.

### Task G3: Resolve parity divergences

For each diff the parity test surfaces, classify:

- [ ] **Step 1: Triage divergences**

Open each failing assertion's diff. For each one, decide:

  1. **v2 is wrong → fix v2.** Adjust either AL.Runner (Group B-style upstream change) or ALchemist's mapping (`serverExecutionEngine.ts`). Document in the commit.
  2. **v1 is wrong → fix v1.** Less common; v1 is the long-stable reference. If v1 is ACTUALLY wrong, document and update the parity test's normalization to allow the divergence with explicit reasoning.
  3. **Both shapes are valid representations of the same data.** Strengthen `normalizeForParity` so the test's projection treats them as equal.

- [ ] **Step 2: For each fix, commit separately with a descriptive message**

Example:

```
fix(serverExecutionEngine): preserve scope name across v2 mapping

The parity test surfaced that v2 captures arrive with `scopeName` as
`MyProcedure_Scope_1496267096` while v1 emits `MyProcedure`. Strip the
`_Scope_<id>` suffix in v2ToV1Captured so downstream consumers see a
stable scope identifier across producers.
```

- [ ] **Step 3: Re-run parity until green**

Run: `npm run test:parity`

Expected: PASS.

### Task G4: Wire parity into the default test target

**Files:**
- Modify: `package.json` `test` script

- [ ] **Step 1: Add parity to the full test target**

Find:

```json
"test": "npm run test:unit && npm run test:integration",
```

Replace with:

```json
"test": "npm run test:unit && npm run test:integration && npm run test:parity",
```

The parity suite skips cleanly when the fork binary isn't present (the `test.skip` guards in the suite), so this is CI-safe.

- [ ] **Step 2: Run the full test target**

Run: `npm test`

Expected: All passing (unit, integration, parity).

### Task G5: Commit Group G

- [ ] **Step 1: Stage and commit**

```bash
cd U:/Git/ALchemist
git add test/runParityTests.ts test/parity/ test/fixtures/parity-loop-fixture/ package.json
git commit -m "$(cat <<'EOF'
test(parity): cross-protocol equivalence harness for v1/v2 producers

Plan E1/E2 modernized the wire format from v1 (--output-json) to v2
(--server NDJSON streaming) without auditing for feature parity. The
result was a silent regression: ALchemist's iteration stepper / table
view depended on `result.iterations` being populated, but the v2
spec dropped that field from the summary.

This suite drives a single AL fixture through both producers,
normalizes each result into a UI-relevant subset, and asserts
structural equivalence. Future protocol changes that drop or rename
fields surface here, not in the user's editor weeks later.

Currently exercises captures, iterations, coverage, and test
statuses. Extend the projection in normalizeForParity to lock in
additional UI surfaces as they're added.
EOF
)"
```

---

# Group H — Release notes + version bump

### Task H1: Bump ALchemist version + CHANGELOG

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json` change `"version": "0.5.4"` to `"version": "0.5.5"`.

- [ ] **Step 2: Append CHANGELOG entry**

Insert above the `## 0.5.4` heading:

```markdown
## 0.5.5 (YYYY-MM-DD)

### Restored

- **Iteration stepper / table view (regression from v0.5.0).** The protocol-v2 NDJSON wire format silently dropped `iterations` from the summary in Plan E1/E2; downstream the ALchemist iteration UI quietly degraded to no-op. AL.Runner now emits per-loop iteration data on the v2 wire (matching v1 `--output-json` shape), and ALchemist consumes it through the existing `result.iterations` mapping. Requires AL.Runner fork branch at the Plan-E3 cut.
- **Compact loop captured-value rendering (regression from v0.5.0).** Inline display of loop iterations had collapsed to the last value (`myInt = 56`). Restored the v0.3.0 `myInt = 2 .. 56 (×10)` distribution form. Hover continues to expose the full series.

### Internal

- AL.Runner upstream: source-file paths now emitted absolute via `Path.GetFullPath`; wire format is cwd-independent. ALchemist's v0.5.4 cwd-pin workaround is removed.
- New `npm run test:parity` cross-protocol harness drives a single AL fixture through v1 (`--output-json`) and v2 (`--server`) producers and asserts UI-relevant equivalence. Skips cleanly when the fork binary isn't present.

### Why this took several releases

A modernization PR (Plan E1/E2) shipped without a feature-parity audit against the prior release. Subsequent releases (v0.5.1 through v0.5.4) chased visible symptoms — captures missing, paths mismatched, gutter not painting — without surfacing the underlying spec gap. Plan E3 names that gap and locks parity into a test suite so it can't recur silently.
```

(Replace `YYYY-MM-DD` with today's date when committing.)

- [ ] **Step 3: Commit version bump**

```bash
cd U:/Git/ALchemist
git add package.json CHANGELOG.md
git commit -m "chore: bump to v0.5.5 — protocol v2 parity restored (Plan E3)"
```

### Task H2: Tag and push

- [ ] **Step 1: Create the git tag**

```bash
git tag v0.5.5
git log --oneline -1
```

Verify the tag points at the version-bump commit.

- [ ] **Step 2: Push (only when ready to publish)**

```bash
# Don't push without explicit user approval — the GitHub Actions
# release workflow on tag push triggers Marketplace publish.
git push origin master
git push origin v0.5.5
```

---

# Final Self-Review Checklist

Before marking the plan complete, verify:

- [ ] **Spec coverage:** Every requirement in the spec has at least one task.
  - "AL.Runner emits absolute paths" → Group A (A1-A4)
  - "AL.Runner emits iteration data in v2 summary" → Group B (B1-B4)
  - "ALchemist consumes iterations" → Group D (D1-D3) — confirmed engine mapping is already in place; test seals it.
  - "ALchemist renders compact loop captures inline" → Group E (E1-E4)
  - "Add a v1↔v2 parity test suite" → Group G (G1-G5)
  - **Bonus addressed:** Schema doc updates (Group C), cwd-workaround removal (Group F), release notes (Group H).

- [ ] **Type consistency:** Property names match across tasks. `iterations` is consistently spelled; `loopId`, `sourceFile`, `iterationCount`, `steps` match v1 outputParser shape so consumers don't need a translator.

- [ ] **No placeholders:** Every code block contains executable code, every command is exact.

- [ ] **TDD discipline:** Each group's first task is a failing test. The test cements the contract before the implementation lands.

- [ ] **Frequent commits:** Each group ends with a commit task. The git log will tell the story of the regression and its repair.
