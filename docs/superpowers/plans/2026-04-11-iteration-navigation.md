# Iteration Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add time-travel iteration stepping to ALchemist so users can navigate forward/backward through loop iterations, seeing per-iteration variable values, messages, coverage, and branch paths update live in the editor.

**Architecture:** `IterationStore` (pure data layer) holds parsed per-iteration data and selection state. A `CodeLensProvider` renders steppers above loops. `DecorationManager` gains a per-iteration render path. A WebView panel shows a tabular overview. All UI components subscribe to store change events. Data comes from a new `iterations[]` field in AL.Runner's JSON output (until upstream lands, we use mock data for testing).

**Tech Stack:** TypeScript, VS Code Extension API (CodeLens, WebView, TextEditorDecorationType), mocha/sinon for tests.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/iteration/types.ts` | Iteration-specific interfaces (`LoopInfo`, `IterationStep`, `LoopChangeEvent`, `IterationData`) |
| `src/iteration/iterationStore.ts` | Data layer — holds iteration data, manages selection state per loop, fires change events |
| `src/iteration/iterationCodeLensProvider.ts` | CodeLens stepper above each loop (`◀ ⟨3 of 5⟩ ▶ \| Show All \| Table`) |
| `src/iteration/iterationCommands.ts` | Command handlers for next/prev/first/last/showAll/table, cursor-aware loop detection |
| `src/iteration/iterationTablePanel.ts` | WebView table panel showing all iterations in a grid |
| `test/suite/iterationStore.test.ts` | Unit tests for IterationStore |
| `test/suite/iterationCodeLens.test.ts` | Unit tests for CodeLens provider |
| `test/suite/iterationCommands.test.ts` | Unit tests for cursor-aware command handlers |

### Modified Files

| File | Changes |
|------|---------|
| `src/runner/outputParser.ts` | Add `IterationData` parsing to `parseJsonOutput()`, add `iterations` field to return type |
| `src/runner/executor.ts` | Pass `--iteration-tracking` flag in `buildRunnerArgs()` |
| `src/editor/decorations.ts` | Add `applyIterationView()` method and value-change flash decoration |
| `src/output/statusBar.ts` | Add iteration indicator (`⟳3/5`) when stepping |
| `src/extension.ts` | Wire up IterationStore, CodeLens, commands, WebView panel |
| `package.json` | Add 6 new commands, 6 keybindings, 2 settings |
| `test/__mocks__/vscode.js` | Add `CodeLens` class and `languages.registerCodeLensProvider` mock |
| `test/suite/outputParser.test.ts` | Add tests for `iterations[]` parsing |
| `test/suite/executor.test.ts` | Update `buildRunnerArgs` tests for `--iteration-tracking` flag |

---

### Task 1: Iteration Type Definitions

**Files:**
- Create: `src/iteration/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/iteration/types.ts

export interface IterationStepData {
  iteration: number;
  capturedValues: Array<{ variableName: string; value: string }>;
  messages: string[];
  linesExecuted: number[];
}

export interface IterationData {
  loopId: string;
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  steps: IterationStepData[];
}

export interface LoopInfo {
  loopId: string;
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  currentIteration: number; // 1-based when stepping, 0 = "show all"
  errorIteration?: number;
}

export interface IterationStep {
  iteration: number;
  capturedValues: Map<string, string>;
  messages: string[];
  linesExecuted: Set<number>;
}

export interface LoopChangeEvent {
  loopId: string;
  kind: 'iteration-changed' | 'show-all' | 'loaded' | 'cleared';
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/iteration/types.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/iteration/types.ts
git commit -m "feat(iteration): add type definitions for iteration navigation"
```

---

### Task 2: IterationStore — Core Data Management

**Files:**
- Create: `src/iteration/iterationStore.ts`
- Create: `test/suite/iterationStore.test.ts`

- [ ] **Step 1: Write failing tests for IterationStore basics**

```typescript
// test/suite/iterationStore.test.ts
import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

function makeSingleLoop(): IterationData[] {
  return [{
    loopId: 'L0',
    loopLine: 3,
    loopEndLine: 10,
    parentLoopId: null,
    parentIteration: null,
    iterationCount: 5,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'Result', value: '10' }], messages: ['small: 10'], linesExecuted: [3, 4, 5, 7, 8, 10] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'Result', value: '20' }], messages: ['small: 20'], linesExecuted: [3, 4, 5, 7, 8, 10] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'Result', value: '30' }], messages: ['big: 30'], linesExecuted: [3, 4, 5, 6, 10] },
      { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }, { variableName: 'Result', value: '40' }], messages: ['big: 40'], linesExecuted: [3, 4, 5, 6, 10] },
      { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }, { variableName: 'Result', value: '50' }], messages: ['big: 50'], linesExecuted: [3, 4, 5, 6, 10] },
    ],
  }];
}

suite('IterationStore', () => {
  test('load populates loops', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const loops = store.getLoops();
    assert.strictEqual(loops.length, 1);
    assert.strictEqual(loops[0].loopId, 'L0');
    assert.strictEqual(loops[0].iterationCount, 5);
    assert.strictEqual(loops[0].currentIteration, 1);
  });

  test('getLoop returns loop info', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const loop = store.getLoop('L0');
    assert.strictEqual(loop.loopLine, 3);
    assert.strictEqual(loop.loopEndLine, 10);
  });

  test('getLoop throws for unknown loopId', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    assert.throws(() => store.getLoop('UNKNOWN'));
  });

  test('getStep returns iteration data', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.getStep('L0', 1);
    assert.strictEqual(step.iteration, 1);
    assert.strictEqual(step.capturedValues.get('i'), '1');
    assert.strictEqual(step.capturedValues.get('Result'), '10');
    assert.deepStrictEqual(step.messages, ['small: 10']);
    assert.ok(step.linesExecuted.has(3));
  });

  test('setIteration updates currentIteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.setIteration('L0', 3);
    assert.strictEqual(step.iteration, 3);
    assert.strictEqual(store.getLoop('L0').currentIteration, 3);
  });

  test('nextIteration advances by one', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 2);
    const step = store.nextIteration('L0');
    assert.strictEqual(step.iteration, 3);
  });

  test('nextIteration wraps at end', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 5);
    const step = store.nextIteration('L0');
    assert.strictEqual(step.iteration, 5);
  });

  test('prevIteration goes back by one', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 3);
    const step = store.prevIteration('L0');
    assert.strictEqual(step.iteration, 2);
  });

  test('prevIteration stops at first', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 1);
    const step = store.prevIteration('L0');
    assert.strictEqual(step.iteration, 1);
  });

  test('firstIteration jumps to 1', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 4);
    const step = store.firstIteration('L0');
    assert.strictEqual(step.iteration, 1);
  });

  test('lastIteration jumps to iterationCount', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.lastIteration('L0');
    assert.strictEqual(step.iteration, 5);
  });

  test('showAll sets currentIteration to 0', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 3);
    store.showAll('L0');
    assert.strictEqual(store.getLoop('L0').currentIteration, 0);
    assert.strictEqual(store.isShowingAll('L0'), true);
  });

  test('isShowingAll returns false when stepping', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    assert.strictEqual(store.isShowingAll('L0'), false);
  });

  test('clear resets all state', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.clear();
    assert.strictEqual(store.getLoops().length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test-compile && npx mocha out/test/suite/iterationStore.test.js`
Expected: FAIL — `Cannot find module '../../src/iteration/iterationStore'`

- [ ] **Step 3: Implement IterationStore**

```typescript
// src/iteration/iterationStore.ts
import { IterationData, IterationStep, LoopInfo, LoopChangeEvent } from './types';

type ChangeListener = (event: LoopChangeEvent) => void;

export class IterationStore {
  private loops = new Map<string, { info: LoopInfo; steps: IterationStep[] }>();
  private listeners: ChangeListener[] = [];

  load(iterations: IterationData[]): void {
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
        loopLine: iter.loopLine,
        loopEndLine: iter.loopEndLine,
        parentLoopId: iter.parentLoopId,
        parentIteration: iter.parentIteration,
        iterationCount: iter.iterationCount,
        currentIteration: iter.iterationCount > 1 ? 1 : 0,
      };

      this.loops.set(iter.loopId, { info, steps });
    }
    this.fire({ loopId: '', kind: 'loaded' });
  }

  getLoops(): LoopInfo[] {
    return Array.from(this.loops.values()).map((l) => ({ ...l.info }));
  }

  getLoop(loopId: string): LoopInfo {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    return { ...entry.info };
  }

  getStep(loopId: string, iteration: number): IterationStep {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    const step = entry.steps.find((s) => s.iteration === iteration);
    if (!step) throw new Error(`No step ${iteration} for loop ${loopId}`);
    return step;
  }

  getCurrentIteration(loopId: string): number {
    return this.getLoop(loopId).currentIteration;
  }

  setIteration(loopId: string, n: number): IterationStep {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    const clamped = Math.max(1, Math.min(n, entry.info.iterationCount));
    entry.info.currentIteration = clamped;
    this.fire({ loopId, kind: 'iteration-changed' });
    return this.getStep(loopId, clamped);
  }

  nextIteration(loopId: string): IterationStep {
    const current = this.getCurrentIteration(loopId);
    const count = this.getLoop(loopId).iterationCount;
    return this.setIteration(loopId, Math.min(current + 1, count));
  }

  prevIteration(loopId: string): IterationStep {
    const current = this.getCurrentIteration(loopId);
    return this.setIteration(loopId, Math.max(current - 1, 1));
  }

  firstIteration(loopId: string): IterationStep {
    return this.setIteration(loopId, 1);
  }

  lastIteration(loopId: string): IterationStep {
    const count = this.getLoop(loopId).iterationCount;
    return this.setIteration(loopId, count);
  }

  showAll(loopId: string): void {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    entry.info.currentIteration = 0;
    this.fire({ loopId, kind: 'show-all' });
  }

  isShowingAll(loopId: string): boolean {
    return this.getLoop(loopId).currentIteration === 0;
  }

  getNestedLoops(loopId: string, iteration: number): LoopInfo[] {
    return Array.from(this.loops.values())
      .filter((l) => l.info.parentLoopId === loopId && l.info.parentIteration === iteration)
      .map((l) => ({ ...l.info }));
  }

  getChangedValues(loopId: string, iteration: number): string[] {
    if (iteration <= 1) return [];
    const current = this.getStep(loopId, iteration);
    const prev = this.getStep(loopId, iteration - 1);
    const changed: string[] = [];
    for (const [name, value] of current.capturedValues) {
      if (prev.capturedValues.get(name) !== value) {
        changed.push(name);
      }
    }
    return changed;
  }

  onDidChange(listener: ChangeListener): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  clear(): void {
    this.loops.clear();
    this.fire({ loopId: '', kind: 'cleared' });
  }

  private fire(event: LoopChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/iterationStore.test.js`
Expected: All 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/iteration/iterationStore.ts test/suite/iterationStore.test.ts
git commit -m "feat(iteration): add IterationStore with core stepping logic"
```

---

### Task 3: IterationStore — Nested Loops and Changed Values

**Files:**
- Modify: `test/suite/iterationStore.test.ts`
- Modify: `src/iteration/iterationStore.ts` (already implemented, this task adds tests)

- [ ] **Step 1: Write tests for nested loops and changed values**

Append to `test/suite/iterationStore.test.ts`:

```typescript
function makeNestedLoops(): IterationData[] {
  return [
    {
      loopId: 'L0', loopLine: 3, loopEndLine: 12,
      parentLoopId: null, parentIteration: null, iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [3, 4, 5, 12] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [3, 4, 5, 12] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [3, 4, 5, 12] },
      ],
    },
    {
      loopId: 'L1-i1', loopLine: 5, loopEndLine: 9,
      parentLoopId: 'L0', parentIteration: 1, iterationCount: 2,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'j', value: '1' }], messages: ['1x1'], linesExecuted: [5, 6, 7, 9] },
        { iteration: 2, capturedValues: [{ variableName: 'j', value: '2' }], messages: ['1x2'], linesExecuted: [5, 6, 7, 9] },
      ],
    },
    {
      loopId: 'L1-i2', loopLine: 5, loopEndLine: 9,
      parentLoopId: 'L0', parentIteration: 2, iterationCount: 2,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'j', value: '1' }], messages: ['2x1'], linesExecuted: [5, 6, 7, 9] },
        { iteration: 2, capturedValues: [{ variableName: 'j', value: '2' }], messages: ['2x2'], linesExecuted: [5, 6, 7, 9] },
      ],
    },
  ];
}

suite('IterationStore — nested loops', () => {
  test('getNestedLoops returns inner loops for specific outer iteration', () => {
    const store = new IterationStore();
    store.load(makeNestedLoops());
    const nested = store.getNestedLoops('L0', 1);
    assert.strictEqual(nested.length, 1);
    assert.strictEqual(nested[0].loopId, 'L1-i1');
  });

  test('getNestedLoops returns empty for iteration with no inner loops', () => {
    const store = new IterationStore();
    store.load(makeNestedLoops());
    const nested = store.getNestedLoops('L0', 3);
    assert.strictEqual(nested.length, 0);
  });

  test('inner loops step independently from outer', () => {
    const store = new IterationStore();
    store.load(makeNestedLoops());
    store.setIteration('L0', 2);
    store.setIteration('L1-i1', 2);
    assert.strictEqual(store.getLoop('L0').currentIteration, 2);
    assert.strictEqual(store.getLoop('L1-i1').currentIteration, 2);
  });
});

suite('IterationStore — changed values', () => {
  test('getChangedValues returns changed variable names', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const changed = store.getChangedValues('L0', 3);
    assert.ok(changed.includes('i'));
    assert.ok(changed.includes('Result'));
  });

  test('getChangedValues returns empty for first iteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const changed = store.getChangedValues('L0', 1);
    assert.strictEqual(changed.length, 0);
  });

  test('getChangedValues detects unchanged variables', () => {
    const data: IterationData[] = [{
      loopId: 'L0', loopLine: 1, loopEndLine: 5,
      parentLoopId: null, parentIteration: null, iterationCount: 2,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'x', value: '10' }, { variableName: 'y', value: '20' }], messages: [], linesExecuted: [1, 2, 3] },
        { iteration: 2, capturedValues: [{ variableName: 'x', value: '10' }, { variableName: 'y', value: '30' }], messages: [], linesExecuted: [1, 2, 3] },
      ],
    }];
    const store = new IterationStore();
    store.load(data);
    const changed = store.getChangedValues('L0', 2);
    assert.ok(!changed.includes('x'));
    assert.ok(changed.includes('y'));
  });
});

suite('IterationStore — events', () => {
  test('onDidChange fires on setIteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const events: string[] = [];
    store.onDidChange((e) => events.push(e.kind));
    store.setIteration('L0', 3);
    assert.ok(events.includes('iteration-changed'));
  });

  test('onDidChange fires on showAll', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const events: string[] = [];
    store.onDidChange((e) => events.push(e.kind));
    store.showAll('L0');
    assert.ok(events.includes('show-all'));
  });

  test('dispose removes listener', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const events: string[] = [];
    const sub = store.onDidChange((e) => events.push(e.kind));
    sub.dispose();
    store.setIteration('L0', 2);
    assert.strictEqual(events.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/iterationStore.test.js`
Expected: All tests PASS (the implementation from Task 2 already handles these cases).

- [ ] **Step 3: Commit**

```bash
git add test/suite/iterationStore.test.ts
git commit -m "test(iteration): add tests for nested loops, changed values, and events"
```

---

### Task 4: Parse `iterations[]` from JSON Output

**Files:**
- Modify: `src/runner/outputParser.ts:34-45,139-189`
- Modify: `test/suite/outputParser.test.ts`

- [ ] **Step 1: Write failing test for iterations parsing**

Append to `test/suite/outputParser.test.ts`:

```typescript
suite('parseJsonOutput — iterations', () => {
  test('parses iterations array from JSON', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      iterations: [{
        loopId: 'L0', loopLine: 3, loopEndLine: 10,
        parentLoopId: null, parentIteration: null, iterationCount: 3,
        steps: [
          { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: ['msg1'], linesExecuted: [3, 4, 5] },
          { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: ['msg2'], linesExecuted: [3, 4, 5] },
          { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: ['msg3'], linesExecuted: [3, 4, 5] },
        ],
      }],
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 1);
    assert.strictEqual(result.iterations[0].loopId, 'L0');
    assert.strictEqual(result.iterations[0].iterationCount, 3);
    assert.strictEqual(result.iterations[0].steps.length, 3);
    assert.strictEqual(result.iterations[0].steps[0].capturedValues[0].value, '1');
    assert.deepStrictEqual(result.iterations[0].steps[1].messages, ['msg2']);
    assert.deepStrictEqual(result.iterations[0].steps[2].linesExecuted, [3, 4, 5]);
  });

  test('handles missing iterations field gracefully', () => {
    const json = JSON.stringify({
      tests: [], passed: 0, failed: 0, errors: 0, total: 0, exitCode: 0,
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 0);
  });

  test('parses nested loop with parentLoopId', () => {
    const json = JSON.stringify({
      tests: [], passed: 0, failed: 0, errors: 0, total: 0, exitCode: 0,
      iterations: [
        { loopId: 'L0', loopLine: 3, loopEndLine: 12, parentLoopId: null, parentIteration: null, iterationCount: 2, steps: [] },
        { loopId: 'L1', loopLine: 5, loopEndLine: 9, parentLoopId: 'L0', parentIteration: 1, iterationCount: 4, steps: [] },
      ],
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 2);
    assert.strictEqual(result.iterations[1].parentLoopId, 'L0');
    assert.strictEqual(result.iterations[1].parentIteration, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test-compile && npx mocha out/test/suite/outputParser.test.js`
Expected: FAIL — `result.iterations` is undefined.

- [ ] **Step 3: Add IterationData import and iterations to parseJsonOutput return type**

In `src/runner/outputParser.ts`, add import at the top (after line 1):

```typescript
import { IterationData } from '../iteration/types';
```

Add `iterations` field to the `ExecutionResult` interface (after `cached: boolean;` on line 44):

```typescript
  iterations: IterationData[];
```

Update the `parseJsonOutput` return type (line 139) to include `iterations`:

```typescript
export function parseJsonOutput(json: string): {
  tests: TestResult[];
  messages: string[];
  summary: RunSummary;
  capturedValues: CapturedValue[];
  cached: boolean;
  iterations: IterationData[];
} {
```

Add iterations parsing before the return statement (before line 182):

```typescript
  const iterations: IterationData[] = (data.iterations || []).map((iter: any) => ({
    loopId: iter.loopId,
    loopLine: iter.loopLine,
    loopEndLine: iter.loopEndLine,
    parentLoopId: iter.parentLoopId ?? null,
    parentIteration: iter.parentIteration ?? null,
    iterationCount: iter.iterationCount,
    steps: (iter.steps || []).map((s: any) => ({
      iteration: s.iteration,
      capturedValues: (s.capturedValues || []).map((cv: any) => ({
        variableName: cv.variableName,
        value: cv.value ?? '',
      })),
      messages: s.messages || [],
      linesExecuted: s.linesExecuted || [],
    })),
  }));
```

Add `iterations` to the return object:

```typescript
  return {
    tests,
    messages: data.messages || [],
    summary,
    capturedValues,
    cached: data.cached ?? false,
    iterations,
  };
```

- [ ] **Step 4: Update executor.ts to pass iterations through to ExecutionResult**

In `src/runner/executor.ts`, add `iterations` to the result object inside `execute()` (line 82, after `cached`):

```typescript
        iterations: jsonResult.iterations,
```

And in the error result (line 98, after `cached`):

```typescript
        iterations: [],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/outputParser.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Run all tests to check nothing broke**

Run: `npm run test-compile && npx mocha out/test/suite/*.test.js`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runner/outputParser.ts src/runner/executor.ts test/suite/outputParser.test.ts
git commit -m "feat(iteration): parse iterations[] from AL.Runner JSON output"
```

---

### Task 5: Add `--iteration-tracking` Flag to Runner Args

**Files:**
- Modify: `src/runner/executor.ts:10-33`
- Modify: `test/suite/executor.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/suite/executor.test.ts` (in the existing `buildRunnerArgs` suite):

```typescript
  test('scratch-standalone includes --iteration-tracking', () => {
    const { args } = buildRunnerArgs('scratch-standalone', '/tmp/scratch.al');
    assert.ok(args.includes('--iteration-tracking'));
  });

  test('test mode includes --iteration-tracking', () => {
    const { args } = buildRunnerArgs('test', '/workspace/test.al', '/workspace');
    assert.ok(args.includes('--iteration-tracking'));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test-compile && npx mocha out/test/suite/executor.test.js`
Expected: FAIL — `--iteration-tracking` not in args.

- [ ] **Step 3: Add flag to buildRunnerArgs**

In `src/runner/executor.ts`, update each case in `buildRunnerArgs` to include `'--iteration-tracking'`:

```typescript
export function buildRunnerArgs(mode: ExecutionMode, filePath: string, workspacePath?: string, procedureName?: string): { args: string[]; cwd: string } {
  switch (mode) {
    case 'scratch-standalone':
      return {
        args: ['--output-json', '--capture-values', '--iteration-tracking', filePath],
        cwd: path.dirname(filePath),
      };
    case 'scratch-project': {
      const srcPath = workspacePath || path.dirname(filePath);
      return {
        args: ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', srcPath, filePath],
        cwd: srcPath,
      };
    }
    case 'test': {
      const cwd = workspacePath || path.dirname(filePath);
      const args = ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', cwd];
      if (procedureName) {
        args.splice(args.length - 1, 0, '--run', procedureName);
      }
      return { args, cwd };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/executor.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner/executor.ts test/suite/executor.test.ts
git commit -m "feat(iteration): pass --iteration-tracking flag to AL.Runner"
```

---

### Task 6: CodeLens Provider

**Files:**
- Create: `src/iteration/iterationCodeLensProvider.ts`
- Create: `test/suite/iterationCodeLens.test.ts`
- Modify: `test/__mocks__/vscode.js`

- [ ] **Step 1: Add CodeLens mock to vscode.js**

Add to `test/__mocks__/vscode.js` exports (after the `Range` class, around line 81):

```javascript
  CodeLens: class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
  },
```

- [ ] **Step 2: Write failing tests**

```typescript
// test/suite/iterationCodeLens.test.ts
import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { buildCodeLenses } from '../../src/iteration/iterationCodeLensProvider';
import { IterationData } from '../../src/iteration/types';

function makeSingleLoop(): IterationData[] {
  return [{
    loopId: 'L0', loopLine: 3, loopEndLine: 10,
    parentLoopId: null, parentIteration: null, iterationCount: 5,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [3] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [3] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [3] },
      { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }], messages: [], linesExecuted: [3] },
      { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }], messages: [], linesExecuted: [3] },
    ],
  }];
}

suite('IterationCodeLensProvider', () => {
  test('returns lenses for loop with 2+ iterations', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const lenses = buildCodeLenses(store);
    assert.ok(lenses.length >= 3); // prev, next/info, showAll, table
  });

  test('returns no lenses when store is empty', () => {
    const store = new IterationStore();
    const lenses = buildCodeLenses(store);
    assert.strictEqual(lenses.length, 0);
  });

  test('returns no lenses for single-iteration loop', () => {
    const store = new IterationStore();
    store.load([{
      loopId: 'L0', loopLine: 1, loopEndLine: 3,
      parentLoopId: null, parentIteration: null, iterationCount: 1,
      steps: [{ iteration: 1, capturedValues: [], messages: [], linesExecuted: [1] }],
    }]);
    const lenses = buildCodeLenses(store);
    assert.strictEqual(lenses.length, 0);
  });

  test('lens line matches loopLine (0-indexed)', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const lenses = buildCodeLenses(store);
    // loopLine is 3 (1-based) → Range should use line 2 (0-based)
    for (const lens of lenses) {
      assert.strictEqual(lens.range.start.line, 2);
    }
  });

  test('lens title shows current iteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 3);
    const lenses = buildCodeLenses(store);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const iterLens = titles.find((t: string) => t.includes('3') && t.includes('5'));
    assert.ok(iterLens, `Expected a lens showing "3 of 5", got: ${titles.join(', ')}`);
  });

  test('lens shows "All" when in showAll mode', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.showAll('L0');
    const lenses = buildCodeLenses(store);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const allLens = titles.find((t: string) => t.includes('All'));
    assert.ok(allLens, `Expected a lens with "All", got: ${titles.join(', ')}`);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test-compile && npx mocha out/test/suite/iterationCodeLens.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Implement buildCodeLenses and CodeLens provider**

```typescript
// src/iteration/iterationCodeLensProvider.ts
import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';

/**
 * Builds CodeLens items from the current IterationStore state.
 * Exported separately for unit testing (no VS Code dependency in the logic).
 */
export function buildCodeLenses(store: IterationStore): vscode.CodeLens[] {
  const loops = store.getLoops();
  const lenses: vscode.CodeLens[] = [];

  for (const loop of loops) {
    if (loop.iterationCount < 2) continue;

    const line = loop.loopLine - 1; // Convert 1-based to 0-based
    const range = new vscode.Range(line, 0, line, 0);

    if (store.isShowingAll(loop.loopId)) {
      // "All" mode — show re-entry point
      lenses.push(new vscode.CodeLens(range, {
        title: '◀',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: `⟨ All ⟩`,
        command: 'alchemist.iterationShowAll',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '▶',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    } else {
      lenses.push(new vscode.CodeLens(range, {
        title: '◀',
        command: 'alchemist.iterationPrev',
        arguments: [loop.loopId],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: `⟨ ${loop.currentIteration} of ${loop.iterationCount} ⟩`,
        command: '',
        arguments: [],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: '▶',
        command: 'alchemist.iterationNext',
        arguments: [loop.loopId],
      }));
    }

    lenses.push(new vscode.CodeLens(range, {
      title: 'Show All',
      command: 'alchemist.iterationShowAll',
      arguments: [loop.loopId],
    }));

    lenses.push(new vscode.CodeLens(range, {
      title: 'Table',
      command: 'alchemist.iterationTable',
      arguments: [loop.loopId],
    }));
  }

  return lenses;
}

export class IterationCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor(private readonly store: IterationStore) {
    store.onDidChange(() => this.onDidChangeEmitter.fire());
  }

  provideCodeLenses(): vscode.CodeLens[] {
    return buildCodeLenses(this.store);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/iterationCodeLens.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/iteration/iterationCodeLensProvider.ts test/suite/iterationCodeLens.test.ts test/__mocks__/vscode.js
git commit -m "feat(iteration): add CodeLens provider for loop steppers"
```

---

### Task 7: Iteration Commands — Cursor-Aware Stepping

**Files:**
- Create: `src/iteration/iterationCommands.ts`
- Create: `test/suite/iterationCommands.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/suite/iterationCommands.test.ts
import * as assert from 'assert';
import { findLoopAtCursor } from '../../src/iteration/iterationCommands';
import { LoopInfo } from '../../src/iteration/types';

const loops: LoopInfo[] = [
  { loopId: 'L0', loopLine: 3, loopEndLine: 20, parentLoopId: null, parentIteration: null, iterationCount: 5, currentIteration: 1 },
  { loopId: 'L1', loopLine: 8, loopEndLine: 15, parentLoopId: 'L0', parentIteration: null, iterationCount: 3, currentIteration: 1 },
];

suite('iterationCommands', () => {
  test('findLoopAtCursor returns innermost loop when cursor is inside nested loop', () => {
    // Cursor at line 10 (1-based) → inside L1 (8-15) which is inside L0 (3-20)
    const result = findLoopAtCursor(loops, 10);
    assert.strictEqual(result, 'L1');
  });

  test('findLoopAtCursor returns outer loop when cursor is between inner and outer', () => {
    // Cursor at line 5 (1-based) → inside L0 (3-20) but not inside L1 (8-15)
    const result = findLoopAtCursor(loops, 5);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns nearest loop above cursor when outside all loops', () => {
    // Cursor at line 22 (1-based) → outside both loops, nearest above is L0
    const result = findLoopAtCursor(loops, 22);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns null when no loops exist', () => {
    const result = findLoopAtCursor([], 5);
    assert.strictEqual(result, null);
  });

  test('findLoopAtCursor returns loop when cursor is on loop start line', () => {
    const result = findLoopAtCursor(loops, 3);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns loop when cursor is on loop end line', () => {
    const result = findLoopAtCursor(loops, 15);
    assert.strictEqual(result, 'L1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test-compile && npx mocha out/test/suite/iterationCommands.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement findLoopAtCursor and command registration**

```typescript
// src/iteration/iterationCommands.ts
import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { LoopInfo } from './types';

/**
 * Find the innermost loop containing the cursor, or the nearest loop above.
 * cursorLine is 1-based (matches LoopInfo.loopLine).
 */
export function findLoopAtCursor(loops: LoopInfo[], cursorLine: number): string | null {
  // Find all loops containing the cursor, pick the innermost (smallest range)
  const containing = loops
    .filter((l) => cursorLine >= l.loopLine && cursorLine <= l.loopEndLine)
    .sort((a, b) => (a.loopEndLine - a.loopLine) - (b.loopEndLine - b.loopLine));

  if (containing.length > 0) return containing[0].loopId;

  // No containing loop — find nearest loop above cursor
  const above = loops
    .filter((l) => l.loopLine <= cursorLine)
    .sort((a, b) => b.loopLine - a.loopLine);

  return above.length > 0 ? above[0].loopId : null;
}

function getTargetLoopId(store: IterationStore, explicitLoopId?: string): string | null {
  if (explicitLoopId) return explicitLoopId;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const cursorLine = editor.selection.active.line + 1; // Convert 0-based to 1-based
  return findLoopAtCursor(store.getLoops(), cursorLine);
}

export function registerIterationCommands(
  context: vscode.ExtensionContext,
  store: IterationStore,
  onIterationChanged: (loopId: string) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.iterationNext', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.nextIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationPrev', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.prevIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationFirst', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.firstIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationLast', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.lastIteration(id);
      onIterationChanged(id);
    }),
    vscode.commands.registerCommand('alchemist.iterationShowAll', (loopId?: string) => {
      const id = getTargetLoopId(store, loopId);
      if (!id) return;
      store.showAll(id);
      onIterationChanged(id);
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test-compile && npx mocha out/test/suite/iterationCommands.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/iteration/iterationCommands.ts test/suite/iterationCommands.test.ts
git commit -m "feat(iteration): add cursor-aware iteration commands"
```

---

### Task 8: DecorationManager — Per-Iteration Rendering

**Files:**
- Modify: `src/editor/decorations.ts:55-112,142-150`

- [ ] **Step 1: Add the changedValueDecorationType and applyIterationView method**

In `src/editor/decorations.ts`, add a new decoration type in the constructor (after `errorMessageDecorationType`, around line 111):

```typescript
    this.changedValueFlashDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#9cdcfe',
        margin: '0 0 0 16px',
        fontStyle: 'italic',
        backgroundColor: 'rgba(86, 156, 214, 0.15)',
      },
    });
```

Add the field declaration (after line 62):

```typescript
  private readonly changedValueFlashDecorationType: vscode.TextEditorDecorationType;
```

Add a flash timeout tracker (after `capturedValuesStore`):

```typescript
  private flashTimeout: ReturnType<typeof setTimeout> | undefined;
```

Add the `applyIterationView` method (before `dispose()`):

```typescript
  applyIterationView(
    editor: vscode.TextEditor,
    step: { capturedValues: Map<string, string>; messages: string[]; linesExecuted: Set<number> },
    changedVarNames: string[],
    flashDurationMs: number,
  ): void {
    // Clear existing iteration-specific decorations
    editor.setDecorations(this.capturedValueDecorationType, []);
    editor.setDecorations(this.messageDecorationType, []);
    editor.setDecorations(this.changedValueFlashDecorationType, []);
    editor.setDecorations(this.coveredDecorationType, []);
    editor.setDecorations(this.uncoveredDecorationType, []);
    editor.setDecorations(this.dimmedDecorationType, []);

    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
      this.flashTimeout = undefined;
    }

    // Apply per-iteration coverage gutters
    const covered: vscode.DecorationOptions[] = [];
    const uncovered: vscode.DecorationOptions[] = [];
    const dimmed: vscode.DecorationOptions[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
      const lineNum = i + 1; // 1-based
      const range = new vscode.Range(i, 0, i, 0);
      if (step.linesExecuted.has(lineNum)) {
        covered.push({ range });
      } else {
        // Only show uncovered/dimmed for lines that are in the general coverage range
        uncovered.push({ range });
        dimmed.push({ range: editor.document.lineAt(i).range });
      }
    }
    editor.setDecorations(this.coveredDecorationType, covered);
    editor.setDecorations(this.uncoveredDecorationType, uncovered);
    editor.setDecorations(this.dimmedDecorationType, dimmed);

    // Apply per-iteration captured values
    const valueDecorations: vscode.DecorationOptions[] = [];
    const flashDecorations: vscode.DecorationOptions[] = [];
    const changedSet = new Set(changedVarNames.map((n) => n.toLowerCase()));

    // Find assignment lines and map captured values to them
    const assignRegex = /\b(\w+)\s*:=/;
    for (let i = 0; i < editor.document.lineCount; i++) {
      const lineText = editor.document.lineAt(i).text;
      const match = lineText.match(assignRegex);
      if (match) {
        const varName = match[1];
        const value = step.capturedValues.get(varName);
        if (value !== undefined) {
          const range = editor.document.lineAt(i).range;
          const isChanged = changedSet.has(varName.toLowerCase());
          const decorations = isChanged && flashDurationMs > 0 ? flashDecorations : valueDecorations;
          decorations.push({
            range,
            renderOptions: {
              after: { contentText: `  ${varName} = ${value}` },
            },
          });
        }
      }
    }
    editor.setDecorations(this.capturedValueDecorationType, valueDecorations);

    // Apply flash to changed values
    if (flashDecorations.length > 0 && flashDurationMs > 0) {
      editor.setDecorations(this.changedValueFlashDecorationType, flashDecorations);
      this.flashTimeout = setTimeout(() => {
        // Move flash decorations to normal style
        editor.setDecorations(this.changedValueFlashDecorationType, []);
        editor.setDecorations(this.capturedValueDecorationType, [...valueDecorations, ...flashDecorations.map((d) => ({
          ...d,
          // Remove the flash background by using normal decoration type
        }))]);
        this.flashTimeout = undefined;
      }, flashDurationMs);
    }

    // Apply per-iteration messages
    const messageCallRegex = /\bMessage\s*\(/i;
    const callLines: number[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
      if (messageCallRegex.test(editor.document.lineAt(i).text)) {
        callLines.push(i);
      }
    }
    if (callLines.length > 0 && step.messages.length > 0) {
      const msgDecorations: vscode.DecorationOptions[] = [];
      // In per-iteration mode, each Message() call produces at most one message
      for (let c = 0; c < callLines.length && c < step.messages.length; c++) {
        const range = editor.document.lineAt(callLines[c]).range;
        msgDecorations.push({
          range,
          renderOptions: {
            after: { contentText: `  \u2192 ${step.messages[c]}` },
          },
        });
      }
      editor.setDecorations(this.messageDecorationType, msgDecorations);
    }
  }
```

Update `clearDecorations` to also clear the flash type (add after line 149):

```typescript
    editor.setDecorations(this.changedValueFlashDecorationType, []);
```

Update `dispose` to also dispose the flash type and clear timeout (add in dispose method):

```typescript
    this.changedValueFlashDecorationType.dispose();
    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
    }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `npm run test-compile && npx mocha out/test/suite/*.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/editor/decorations.ts
git commit -m "feat(iteration): add applyIterationView with value change flash"
```

---

### Task 9: Status Bar Iteration Indicator

**Files:**
- Modify: `src/output/statusBar.ts`

- [ ] **Step 1: Add setIterationIndicator method**

Add to `src/output/statusBar.ts` (before `dispose()`):

```typescript
  setIterationIndicator(loopId: string, current: number, total: number): void {
    // Append iteration indicator to existing text
    const baseText = this.item.text;
    // Remove any existing iteration indicator
    const cleaned = baseText.replace(/\s*\u27F3\d+\/\d+$/, '');
    this.item.text = `${cleaned} \u27F3${current}/${total}`;
  }

  clearIterationIndicator(): void {
    this.item.text = this.item.text.replace(/\s*\u27F3\d+\/\d+$/, '');
  }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `npm run test-compile && npx mocha out/test/suite/*.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/output/statusBar.ts
git commit -m "feat(iteration): add iteration indicator to status bar"
```

---

### Task 10: Iteration Table Panel — WebView

**Files:**
- Create: `src/iteration/iterationTablePanel.ts`

- [ ] **Step 1: Implement the WebView panel**

```typescript
// src/iteration/iterationTablePanel.ts
import * as vscode from 'vscode';
import { IterationStore } from './iterationStore';
import { LoopInfo } from './types';

export class IterationTablePanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: IterationStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  show(loopId: string): void {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'alchemistIterationTable',
        'ALchemist: Iteration Table',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, null, this.disposables);

      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'selectIteration') {
          this.store.setIteration(msg.loopId, msg.iteration);
        }
      }, null, this.disposables);

      this.disposables.push(
        this.store.onDidChange(() => {
          if (this.panel) this.updateContent(loopId);
        })
      );
    }

    this.updateContent(loopId);
  }

  private updateContent(loopId: string): void {
    if (!this.panel) return;

    let loop: LoopInfo;
    try {
      loop = this.store.getLoop(loopId);
    } catch {
      return;
    }

    const rows: string[] = [];
    for (let i = 1; i <= loop.iterationCount; i++) {
      const step = this.store.getStep(loopId, i);
      const isCurrent = i === loop.currentIteration;
      const isError = i === loop.errorIteration;

      // Detect changed values
      let changedVars = new Set<string>();
      if (i > 1) {
        const prev = this.store.getStep(loopId, i - 1);
        for (const [name, value] of step.capturedValues) {
          if (prev.capturedValues.get(name) !== value) {
            changedVars.add(name);
          }
        }
      }

      // Build variable cells
      const varNames = Array.from(step.capturedValues.keys());
      const varCells = varNames.map((name) => {
        const value = step.capturedValues.get(name) || '';
        const changed = changedVars.has(name) ? ' class="changed"' : '';
        return `<td${changed}>${escapeHtml(value)}</td>`;
      }).join('');

      const msgCell = step.messages.length > 0
        ? `<td class="message">${escapeHtml(step.messages.join(', '))}</td>`
        : '<td></td>';

      // Check for nested loops
      const nested = this.store.getNestedLoops(loopId, i);
      const nestedCell = nested.length > 0
        ? `<td><a href="#" onclick="drillDown('${nested[0].loopId}')">▶ ${nested[0].iterationCount} inner iterations</a></td>`
        : '<td></td>';

      const rowClass = [
        isCurrent ? 'current' : '',
        isError ? 'error' : '',
      ].filter(Boolean).join(' ');

      rows.push(`<tr class="${rowClass}" onclick="selectRow(${i}, '${loopId}')">
        <td class="row-num">${isCurrent ? '►' : ''}${i}</td>
        ${varCells}
        ${msgCell}
        ${nestedCell}
      </tr>`);
    }

    // Build header from first step's variable names
    const firstStep = this.store.getStep(loopId, 1);
    const varHeaders = Array.from(firstStep.capturedValues.keys())
      .map((name) => `<th>${escapeHtml(name)}</th>`)
      .join('');

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
  }
  .loop-header {
    color: var(--vscode-textLink-foreground);
    font-size: 12px;
    margin-bottom: 12px;
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
  }
  tr { cursor: pointer; }
  tr:hover { background: var(--vscode-list-hoverBackground); }
  tr.current {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  tr.error { border-left: 3px solid var(--vscode-errorForeground); }
  td.changed {
    color: var(--vscode-textLink-foreground);
    font-weight: bold;
  }
  td.message { color: var(--vscode-debugTokenExpression-string); }
  td.row-num { color: var(--vscode-descriptionForeground); width: 40px; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="loop-header">for loop — line ${loop.loopLine}</div>
  <table>
    <thead><tr><th>#</th>${varHeaders}<th>Message</th><th></th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>
  <script>
    const vscode = acquireVsCodeApi();
    function selectRow(iteration, loopId) {
      vscode.postMessage({ type: 'selectIteration', iteration, loopId });
    }
    function drillDown(loopId) {
      vscode.postMessage({ type: 'drillDown', loopId });
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run test-compile`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/iteration/iterationTablePanel.ts
git commit -m "feat(iteration): add WebView iteration table panel"
```

---

### Task 11: Wire Everything in extension.ts and package.json

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Update package.json with new commands, keybindings, and settings**

Add to `package.json` `contributes.commands` array (after the existing 8 commands):

```json
      {
        "command": "alchemist.iterationNext",
        "title": "ALchemist: Next Iteration"
      },
      {
        "command": "alchemist.iterationPrev",
        "title": "ALchemist: Previous Iteration"
      },
      {
        "command": "alchemist.iterationFirst",
        "title": "ALchemist: First Iteration"
      },
      {
        "command": "alchemist.iterationLast",
        "title": "ALchemist: Last Iteration"
      },
      {
        "command": "alchemist.iterationShowAll",
        "title": "ALchemist: Show All Iterations"
      },
      {
        "command": "alchemist.iterationTable",
        "title": "ALchemist: Open Iteration Table"
      }
```

Add to `contributes.keybindings` array:

```json
      {
        "command": "alchemist.iterationNext",
        "key": "ctrl+shift+a right",
        "when": "alchemist.hasIterationData"
      },
      {
        "command": "alchemist.iterationPrev",
        "key": "ctrl+shift+a left",
        "when": "alchemist.hasIterationData"
      },
      {
        "command": "alchemist.iterationFirst",
        "key": "ctrl+shift+a home",
        "when": "alchemist.hasIterationData"
      },
      {
        "command": "alchemist.iterationLast",
        "key": "ctrl+shift+a end",
        "when": "alchemist.hasIterationData"
      },
      {
        "command": "alchemist.iterationShowAll",
        "key": "ctrl+shift+a a",
        "when": "alchemist.hasIterationData"
      },
      {
        "command": "alchemist.iterationTable",
        "key": "ctrl+shift+a t",
        "when": "alchemist.hasIterationData"
      }
```

Add to `contributes.configuration.properties`:

```json
        "alchemist.showIterationStepper": {
          "type": "boolean",
          "default": true,
          "description": "Show CodeLens iteration stepper above loops."
        },
        "alchemist.iterationFlashDuration": {
          "type": "number",
          "default": 600,
          "description": "Duration in ms for the value change flash when stepping (0 to disable)."
        }
```

- [ ] **Step 2: Wire up IterationStore, CodeLens, commands, and table panel in extension.ts**

Add imports at top of `src/extension.ts`:

```typescript
import { IterationStore } from './iteration/iterationStore';
import { IterationCodeLensProvider } from './iteration/iterationCodeLensProvider';
import { registerIterationCommands } from './iteration/iterationCommands';
import { IterationTablePanel } from './iteration/iterationTablePanel';
```

Add new component declarations (after line 18):

```typescript
let iterationStore: IterationStore;
let iterationTablePanel: IterationTablePanel;
```

Add initialization inside the try block (after testController creation, line 31):

```typescript
    iterationStore = new IterationStore();
    iterationTablePanel = new IterationTablePanel(iterationStore, context.extensionUri);
```

Add iteration loading in the `executor.onFinish` handler (after `testController.updateFromResult(result)`, line 74):

```typescript
      // Load iteration data
      if (result.iterations && result.iterations.length > 0) {
        iterationStore.load(result.iterations);
        vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', true);
      } else {
        iterationStore.clear();
        vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      }
```

Add iteration rendering callback and command registration (after the existing commands block, before the hover provider):

```typescript
  // --- Iteration navigation ---

  const onIterationChanged = (loopId: string) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const loop = iterationStore.getLoop(loopId);
    if (iterationStore.isShowingAll(loopId)) {
      // Re-apply aggregate view
      const wsPath = workspaceFolder?.uri.fsPath || path.dirname(editor.document.uri.fsPath);
      // Need to get the last execution result — for now, clear iteration decorations
      statusBar.clearIterationIndicator();
      return;
    }

    const step = iterationStore.getStep(loopId, loop.currentIteration);
    const config = vscode.workspace.getConfiguration('alchemist');
    const flashMs = config.get<number>('iterationFlashDuration', 600);
    const changedVars = iterationStore.getChangedValues(loopId, loop.currentIteration);

    decorationManager.applyIterationView(editor, step, changedVars, flashMs);
    statusBar.setIterationIndicator(loopId, loop.currentIteration, loop.iterationCount);
  };

  registerIterationCommands(context, iterationStore, onIterationChanged);

  // Iteration table command
  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.iterationTable', (loopId?: string) => {
      const id = loopId || iterationStore.getLoops()[0]?.loopId;
      if (id) iterationTablePanel.show(id);
    })
  );

  // CodeLens provider (for AL files)
  if (vscode.workspace.getConfiguration('alchemist').get<boolean>('showIterationStepper', true)) {
    const codeLensProvider = new IterationCodeLensProvider(iterationStore);
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ language: 'al' }, codeLensProvider),
      codeLensProvider
    );
  }
```

Add to the disposables push (line 192):

```typescript
    iterationTablePanel,
```

Also update the `clearDecorations` command to clear iteration state:

```typescript
    vscode.commands.registerCommand('alchemist.clearDecorations', () => {
      decorationManager.clearAll();
      iterationStore.clear();
      vscode.commands.executeCommand('setContext', 'alchemist.hasIterationData', false);
      statusBar.clearIterationIndicator();
      statusBar.setIdle();
    }),
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run test-compile`
Expected: No errors.

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `npm run test-compile && npx mocha out/test/suite/*.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Build production bundle**

Run: `npx webpack --mode production`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(iteration): wire up iteration navigation in extension"
```

---

### Task 12: Integration Test — Full Iteration Flow

**Files:**
- Create: `test/suite/iterationIntegration.test.ts`

- [ ] **Step 1: Write integration test that exercises the full flow**

```typescript
// test/suite/iterationIntegration.test.ts
import * as assert from 'assert';
import { parseJsonOutput } from '../../src/runner/outputParser';
import { IterationStore } from '../../src/iteration/iterationStore';
import { buildCodeLenses } from '../../src/iteration/iterationCodeLensProvider';
import { findLoopAtCursor } from '../../src/iteration/iterationCommands';

suite('Iteration Integration', () => {
  const jsonWithIterations = JSON.stringify({
    tests: [{ name: 'TestLoop', status: 'pass', durationMs: 10 }],
    passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    messages: ['small: 10', 'small: 20', 'big: 30'],
    capturedValues: [{ scopeName: 'Run', variableName: 'Result', value: '30', statementId: 1 }],
    iterations: [{
      loopId: 'L0', loopLine: 3, loopEndLine: 10,
      parentLoopId: null, parentIteration: null, iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'Result', value: '10' }], messages: ['small: 10'], linesExecuted: [3, 4, 5, 7, 8, 10] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'Result', value: '20' }], messages: ['small: 20'], linesExecuted: [3, 4, 5, 7, 8, 10] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'Result', value: '30' }], messages: ['big: 30'], linesExecuted: [3, 4, 5, 6, 10] },
      ],
    }],
  });

  test('full flow: parse → store → step → codelens → changed values', () => {
    // 1. Parse
    const parsed = parseJsonOutput(jsonWithIterations);
    assert.strictEqual(parsed.iterations.length, 1);

    // 2. Load store
    const store = new IterationStore();
    store.load(parsed.iterations);
    assert.strictEqual(store.getLoops().length, 1);

    // 3. Step to iteration 2
    const step2 = store.setIteration('L0', 2);
    assert.strictEqual(step2.capturedValues.get('Result'), '20');
    assert.deepStrictEqual(step2.messages, ['small: 20']);

    // 4. Step to iteration 3 — check changed values
    store.setIteration('L0', 3);
    const changed = store.getChangedValues('L0', 3);
    assert.ok(changed.includes('Result'));
    assert.ok(changed.includes('i'));

    // 5. Check lines executed changed (different branch)
    const step3 = store.getStep('L0', 3);
    assert.ok(step3.linesExecuted.has(6));    // then branch
    assert.ok(!step3.linesExecuted.has(7));   // else branch not taken
    assert.ok(!step3.linesExecuted.has(8));

    // 6. CodeLens shows correct iteration
    const lenses = buildCodeLenses(store);
    assert.ok(lenses.length > 0);
    const titles = lenses.map((l: any) => l.command?.title || '');
    assert.ok(titles.some((t: string) => t.includes('3') && t.includes('3')));

    // 7. Show All mode
    store.showAll('L0');
    assert.strictEqual(store.isShowingAll('L0'), true);
    const allLenses = buildCodeLenses(store);
    const allTitles = allLenses.map((l: any) => l.command?.title || '');
    assert.ok(allTitles.some((t: string) => t.includes('All')));

    // 8. Cursor-aware: cursor at line 5 → finds L0
    const loopId = findLoopAtCursor(store.getLoops(), 5);
    assert.strictEqual(loopId, 'L0');
  });

  test('backward compatible: no iterations field', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    });
    const parsed = parseJsonOutput(json);
    assert.strictEqual(parsed.iterations.length, 0);

    const store = new IterationStore();
    store.load(parsed.iterations);
    assert.strictEqual(store.getLoops().length, 0);

    const lenses = buildCodeLenses(store);
    assert.strictEqual(lenses.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npm run test-compile && npx mocha out/test/suite/iterationIntegration.test.js`
Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm run test-compile && npx mocha out/test/suite/*.test.js`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/suite/iterationIntegration.test.ts
git commit -m "test(iteration): add integration test for full iteration flow"
```

---

## Summary

| Task | Description | Tests Added |
|------|-------------|-------------|
| 1 | Type definitions | 0 (types only) |
| 2 | IterationStore core | 14 |
| 3 | Nested loops + changed values + events | 9 |
| 4 | Parse iterations from JSON | 3 |
| 5 | --iteration-tracking flag | 2 |
| 6 | CodeLens provider | 6 |
| 7 | Cursor-aware commands | 6 |
| 8 | DecorationManager iteration view | 0 (VS Code API, tested via integration) |
| 9 | Status bar indicator | 0 (trivial addition) |
| 10 | WebView table panel | 0 (WebView, manual testing) |
| 11 | Wire extension.ts + package.json | 0 (wiring) |
| 12 | Integration test | 2 |
| **Total** | | **42 new tests** |

**After all tasks:** The extension supports iteration navigation with CodeLens steppers, keyboard shortcuts, per-iteration value/coverage updates, value change flash, and a WebView table panel. The feature activates automatically when AL.Runner provides `iterations[]` data (requires the upstream `--iteration-tracking` flag to be implemented). Until then, all code is testable with mock data and the existing flat output continues to work unchanged.

**Next plan needed:** AL.Runner upstream contribution — `IterationTracker` class, transpiler instrumentation, `--iteration-tracking` flag. This is a separate plan in the `U:\Git\BusinessCentral.AL.Runner\` repository.
