# Iteration Navigation — Design Spec

**Goal:** Add time-travel iteration stepping to ALchemist so users can press forward/backward through loop iterations, seeing per-iteration variable values, Message output, coverage, and branch paths update in the editor in real time.

**Architecture:** Three-layer approach — inline editor decorations + CodeLens stepper for the core experience, a WebView table panel for the overview, and keyboard shortcuts for speed. An `IterationStore` owns the data and selection state, decoupled from the UI. Per-iteration data comes from a new `--iteration-tracking` flag contributed upstream to AL.Runner.

**Tech Stack:** TypeScript (VS Code extension), C# (AL.Runner upstream), VS Code WebView API, VS Code CodeLens API.

---

## 1. AL.Runner Per-Iteration Data Model

A new `--iteration-tracking` CLI flag on AL.Runner adds an `iterations` array to the `--output-json` output. Existing flat fields (`messages`, `capturedValues`, coverage) remain unchanged for backward compatibility.

### JSON Output Shape

```json
{
  "messages": ["small: 10", "small: 20", "big: 30", "big: 40", "big: 50"],
  "capturedValues": [
    { "scopeName": "Run", "variableName": "Result", "value": "50", "statementId": 1 }
  ],
  "iterations": [
    {
      "loopId": "L0",
      "loopLine": 3,
      "loopEndLine": 10,
      "parentLoopId": null,
      "parentIteration": null,
      "iterationCount": 5,
      "steps": [
        {
          "iteration": 1,
          "capturedValues": [
            { "variableName": "i", "value": "1" },
            { "variableName": "Result", "value": "10" }
          ],
          "messages": ["small: 10"],
          "linesExecuted": [3, 4, 5, 7, 8, 10]
        },
        {
          "iteration": 2,
          "capturedValues": [
            { "variableName": "i", "value": "2" },
            { "variableName": "Result", "value": "20" }
          ],
          "messages": ["small: 20"],
          "linesExecuted": [3, 4, 5, 7, 8, 10]
        }
      ]
    },
    {
      "loopId": "L1",
      "loopLine": 5,
      "loopEndLine": 7,
      "parentLoopId": "L0",
      "parentIteration": 1,
      "iterationCount": 4,
      "steps": []
    }
  ]
}
```

### Key Design Points

- `loopId` — stable identifier per loop, based on scope + source line position.
- `loopLine` / `loopEndLine` — source line range of the loop statement and its closing `end;`. Used by cursor-aware stepping to determine which loop the cursor is inside.
- `parentLoopId` + `parentIteration` — links nested loops to their parent and which specific outer iteration they belong to. A nested loop emits one `iterations` entry per outer iteration it ran in.
- `linesExecuted` — per-step line numbers that executed, enabling per-iteration coverage and branch path detection.
- `steps[].capturedValues` — full variable snapshot per iteration (not just last value).
- Backward compatible — consumers that don't know about `iterations` continue using the flat fields.

---

## 2. AL.Runner Implementation

Follows the same contribution pattern as the MessageCapture PR (merged as PR #2).

### New Class: `IterationTracker`

Static collector mirroring `ValueCapture` and `MessageCapture`:

```
IterationTracker
  Enable() / Disable()
  EnterLoop(loopId, loopLine, parentLoopId?)
  EnterIteration(loopId, iterationNumber)
  ExitLoop(loopId)
  GetResults(): IterationData[]
```

### Transpiler Instrumentation

The AL-to-C# transpiler wraps each loop with tracker calls:

```csharp
// With --iteration-tracking:
IterationTracker.EnterLoop("L0", 3, null);
for (var i = 1; i <= 5; i++) {
    IterationTracker.EnterIteration("L0", i);
    // body (existing ValueCapture + MessageCapture calls)
}
IterationTracker.ExitLoop("L0");
```

### Data Capture Strategy

- **Messages** — `MessageCapture` continues capturing in order. `IterationTracker` records iteration boundaries to partition messages per iteration.
- **Captured values** — `ValueCaptureInjector` continues injecting capture calls. `IterationTracker` snapshots variable state at each iteration boundary.
- **Lines executed** — existing coverage instrumentation tracks line hits. `IterationTracker` records per-iteration line sets.

### Pipeline Integration

`Pipeline.cs` enables/disables the tracker alongside `ValueCapture` and `MessageCapture`. Results are serialized into the JSON output as the `iterations` array.

**Flag:** `--iteration-tracking` enables the tracker. Without it, no `iterations` field in the output.

---

## 3. IterationStore — Extension Data Layer

New file: `src/iteration/iterationStore.ts`. Pure TypeScript, no VS Code dependencies. Fully testable.

### API

```
IterationStore
  load(result: ExecutionResult)
  getLoops(): LoopInfo[]
  getLoop(loopId): LoopInfo
  getStep(loopId, iteration): IterationStep
  getCurrentIteration(loopId): number
  setIteration(loopId, n): IterationStep
  nextIteration(loopId): IterationStep
  prevIteration(loopId): IterationStep
  firstIteration(loopId): IterationStep
  lastIteration(loopId): IterationStep
  showAll(loopId)
  isShowingAll(loopId): boolean
  getNestedLoops(loopId, iteration): LoopInfo[]
  getChangedValues(loopId, iteration): string[]
  onDidChange: Event<LoopChangeEvent>
  clear()
```

### Types

```typescript
interface LoopInfo {
  loopId: string;
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  currentIteration: number;  // 1-based, or 0 = "show all"
  errorIteration?: number;
}

interface IterationStep {
  iteration: number;
  capturedValues: Map<string, string>;
  messages: string[];
  linesExecuted: Set<number>;
}

interface LoopChangeEvent {
  loopId: string;
  kind: 'iteration-changed' | 'show-all' | 'loaded' | 'cleared';
}
```

### Nested Loop Handling

When the user steps the outer loop to iteration 3, `getNestedLoops("L0", 3)` returns only the inner loops that ran during that outer iteration (matched via `parentLoopId` + `parentIteration`). Each inner loop has its own independent stepper.

### Changed Value Detection

`getChangedValues(loopId, iteration)` compares iteration N against N-1 and returns variable names whose values differ. This drives the highlight flash in the decoration layer.

---

## 4. Inline Editor Experience

### CodeLens Provider

New file: `src/iteration/iterationCodeLensProvider.ts`.

For each loop with 2+ iterations, renders a CodeLens line above the loop:

```
◀ Iteration 3 of 5 ▶  |  Show All  |  Table
```

- `◀` / `▶` — clickable, fire `alchemist.iterationPrev` / `alchemist.iterationNext` with the `loopId`.
- `Show All` — fires `alchemist.iterationShowAll`, returns to compact aggregate view.
- `Table` — fires `alchemist.iterationTable`, opens the WebView panel for this loop.
- Refreshes whenever `IterationStore` fires `onDidChange`.
- The iteration number is styled using Unicode box-drawing or parenthesized characters in the CodeLens title text (CodeLens renders plain text only — no custom HTML). Example: `◀ ⟨ 3 of 5 ⟩ ▶`.

### Decoration Updates

`DecorationManager` gains a new method: `applyIterationView(editor, loopId, step)`.

When stepping into an iteration:
- **Inline variable values** update to show this iteration's captured values (not the final aggregate).
- **Inline Message output** updates to show only this iteration's messages.
- **Gutter coverage dots** update based on `step.linesExecuted` — lines that executed in this iteration get green dots, lines that didn't get gray dots.
- **Line dimming** updates — lines not in `step.linesExecuted` are dimmed.

When "Show All" is active, the existing `applyResults()` renders the aggregate view (current behavior).

### Value Change Flash

When stepping between iterations:
1. `IterationStore.getChangedValues()` identifies which variables differ from the previous iteration.
2. A temporary `changedValueDecorationType` is applied to those inline values: `background: rgba(86, 156, 214, 0.15)` (subtle blue).
3. After 600ms (configurable via `alchemist.iterationFlashDuration`), the flash decoration is removed.
4. Net effect: changed values briefly glow, drawing the eye to what's different.

### Branch Path Indicator

Lines inside conditionals within the loop body:
- Lines executed in this iteration: bright, green gutter dot.
- Lines not executed in this iteration: dimmed, gray gutter dot.
- This naturally shows which `if`/`else` branch was taken without extra decoration types.

### Cursor-Aware Stepping

The `alchemist.iterationNext` / `alchemist.iterationPrev` commands determine which loop to step:
1. Find the cursor position.
2. Walk through the known loops (from `IterationStore.getLoops()`).
3. Pick the innermost loop whose `loopLine`–`loopEndLine` range contains the cursor.
4. If cursor is not inside any loop, step the nearest loop above the cursor.

---

## 5. Iteration Table Panel — WebView

New file: `src/iteration/iterationTablePanel.ts`. Uses VS Code WebView API. Opens as a side panel beside the editor.

### Layout

```
┌─────────────────────────────────────────────────┐
│  for i := 1 to 5  ·  line 3                    │
│  ◀ ▶  Jump to iteration: [  3  ]               │
├─────┬─────┬────────┬──────────────┬─────────────┤
│  #  │  i  │ Result │   Message    │   Branch    │
├─────┼─────┼────────┼──────────────┼─────────────┤
│  1  │  1  │   10   │  small: 10   │    else     │
│  2  │  2  │   20   │  small: 20   │    else     │
│ ►3  │  3  │  *30*  │  big: 30     │  ► then     │
│  4  │  4  │   40   │  big: 40     │    then     │
│  5  │  5  │   50   │  big: 50     │    then     │
└─────┴─────┴────────┴──────────────┴─────────────┘
```

### Features

- **Column auto-detection** — columns built from captured variable names, plus "Message" column if `Message()` calls exist in the loop body, plus "Branch" column if conditionals exist.
- **Current iteration row** — highlighted with VS Code selection accent color. Syncs with CodeLens stepper and keyboard navigation.
- **Changed value highlighting** — cells where the value differs from the previous row get a subtle blue accent (same as inline flash).
- **Click row to jump** — sends message to extension, calls `iterationStore.setIteration()`, fires `onDidChange`, updates editor decorations and CodeLens.
- **Error rows** — if an iteration caused an error, the row gets a red left border. Error message appears in a dedicated column.
- **Nested loop drill-down** — rows with inner loops show a `▶ 4 inner iterations` link. Clicking switches the table to the inner loop's iterations for that outer iteration, with breadcrumb navigation: `outer (i) › iteration 3 › inner (j)`.
- **Theming** — uses VS Code CSS variables (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.) to match user's theme.

### Communication

- Extension → WebView: posts messages with iteration data and selection state.
- WebView → Extension: posts messages for row clicks, navigation actions.
- Panel subscribes to `iterationStore.onDidChange` to stay in sync.

---

## 6. Commands, Keybindings & Settings

### New Commands

| Command | Title | Keybinding |
|---------|-------|------------|
| `alchemist.iterationNext` | ALchemist: Next Iteration | `Ctrl+Shift+A Right` |
| `alchemist.iterationPrev` | ALchemist: Previous Iteration | `Ctrl+Shift+A Left` |
| `alchemist.iterationFirst` | ALchemist: First Iteration | `Ctrl+Shift+A Home` |
| `alchemist.iterationLast` | ALchemist: Last Iteration | `Ctrl+Shift+A End` |
| `alchemist.iterationShowAll` | ALchemist: Show All Iterations | `Ctrl+Shift+A A` |
| `alchemist.iterationTable` | ALchemist: Open Iteration Table | `Ctrl+Shift+A T` |

### New Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `alchemist.showIterationStepper` | boolean | `true` | Show CodeLens stepper above loops |
| `alchemist.iterationFlashDuration` | number | `600` | Duration in ms for value change flash (0 to disable) |

### Activation

- Iteration commands use a `when` clause on `alchemist.hasIterationData` context key. Only active when iteration data is present.
- CodeLens provider returns empty when `IterationStore` has no data.
- Zero clutter on single-pass code with no loops.

### Status Bar

The existing beaker status bar item gains an iteration indicator when stepping is active: `🧪 ✓ ⟳3/5`.

---

## 7. File Structure

### New Files

```
src/iteration/
├── iterationStore.ts          # Data layer — loop state and selection
├── iterationCodeLensProvider.ts  # CodeLens stepper above each loop
├── iterationTablePanel.ts     # WebView table panel
└── iterationCommands.ts       # Command handlers for stepping
```

### Modified Files

```
src/runner/outputParser.ts     # Parse iterations[] from JSON output
src/runner/executor.ts         # Pass --iteration-tracking flag
src/editor/decorations.ts      # Add applyIterationView() method
src/extension.ts               # Wire up new commands, CodeLens, panel
package.json                   # New commands, keybindings, settings
```

### AL.Runner Files (upstream contribution)

```
AlRunner/Runtime/IterationTracker.cs    # New static collector
AlRunner/Transpiler/...                 # Loop instrumentation
AlRunner/Pipeline.cs                    # Enable/disable tracker
AlRunner/Program.cs                     # --iteration-tracking flag
```

---

## 8. Data Flow

```
AL code with loops
       │
       ▼
AL.Runner --output-json --iteration-tracking --capture-values
       │
       ▼
JSON output with iterations[] array
       │
       ▼
outputParser.ts → ExecutionResult (with iterations field)
       │
       ▼
IterationStore.load(result)
       │
       ├──► iterationCodeLensProvider reads loop info → renders ◀ 3/5 ▶
       │
       ├──► User clicks ▶ or presses Ctrl+Shift+A Right
       │         │
       │         ▼
       │    iterationStore.nextIteration(loopId)
       │         │
       │         ▼
       │    onDidChange fires
       │         │
       │    ┌────┴────────────────┐
       │    ▼                     ▼
       │  CodeLens refreshes    DecorationManager.applyIterationView()
       │                          │
       │                     ┌────┴────────────┐
       │                     ▼                  ▼
       │               Values update      Coverage updates
       │               + flash on changed  + dimming updates
       │
       └──► iterationTablePanel subscribes to onDidChange
                  │
                  ▼
            Table row highlight syncs, WebView updates
```

---

## 9. Testing Strategy

- **IterationStore** — pure unit tests. Load mock data, verify stepping, changed value detection, nested loop queries, show-all toggling. No VS Code dependency.
- **CodeLens provider** — unit tests with mock store. Verify lenses appear for loops with 2+ iterations, disappear for single-pass, correct command arguments.
- **outputParser** — extend existing tests to parse `iterations[]` from JSON output.
- **DecorationManager.applyIterationView** — unit tests with VS Code mocks (existing pattern).
- **Table panel** — test the message passing logic (extension ↔ WebView communication).
- **Integration** — end-to-end test with a real AL file containing nested loops, verify stepping produces correct inline values.
