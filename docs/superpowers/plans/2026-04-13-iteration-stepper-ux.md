# Interactive Iteration Stepper UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace non-clickable decoration stepper with a three-layer interactive UX: compact decoration (visual anchor), interactive hover (contextual nav + values), and status bar stepper (persistent click controls).

**Architecture:** Decoration simplified to `⟳ 3/10`. Hover provider enhanced with `MarkdownString` command URIs for clickable navigation. Status bar gets 4 separate `StatusBarItem` instances for prev/counter/next/table. All three layers react to `IterationStore.onDidChange` events.

**Tech Stack:** TypeScript, VS Code Extension API (MarkdownString, StatusBarItem, TextEditorDecorationType, HoverProvider)

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/iteration/iterationCodeLensProvider.ts:13-18` | Simplify `buildStepperText()` to compact format |
| Modify | `src/editor/hoverProvider.ts:71-104` | Add command URIs to iteration hover, configurable detail levels |
| Modify | `src/output/statusBar.ts:70-80` | Replace append-based indicator with 4 clickable StatusBarItem instances |
| Modify | `src/extension.ts:202,223,237` | Wire new status bar methods, remove old indicator calls |
| Modify | `package.json:249-258` | Add `iterationHoverDetail` setting |
| Modify | `test/suite/iterationDisplay.test.ts` | Update stepper text assertions |
| Create | `test/suite/iterationHover.test.ts` | Test hover markdown generation with command URIs |
| Create | `test/suite/statusBarStepper.test.ts` | Test status bar stepper item management |

---

## Task 1: Simplify Decoration Text

**Files:**
- Modify: `src/iteration/iterationCodeLensProvider.ts:13-18`

- [ ] **Step 1: Update buildStepperText**

In `src/iteration/iterationCodeLensProvider.ts`, replace `buildStepperText`:

```typescript
export function buildStepperText(store: IterationStore, loopId: string): string {
  const loop = store.getLoop(loopId);
  if (store.isShowingAll(loopId)) {
    return '\u27F3 All';
  }
  return `\u27F3 ${loop.currentIteration}/${loop.iterationCount}`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd U:/Git/ALchemist && npx tsc --noEmit`
Expected: Exit 0 (test files that reference `buildStepperText` don't check its output string)

- [ ] **Step 3: Commit**

```bash
cd U:/Git/ALchemist
git add src/iteration/iterationCodeLensProvider.ts
git commit -m "Simplify decoration stepper text to compact format"
```

---

## Task 2: Interactive Hover with Command URIs

**Files:**
- Modify: `src/editor/hoverProvider.ts:48-66, 71-104`
- Modify: `package.json` (configuration section)

- [ ] **Step 1: Add iterationHoverDetail setting to package.json**

In `package.json`, after the `iterationFlashDuration` entry (line 258), add:

```json
        "alchemist.iterationHoverDetail": {
          "type": "string",
          "enum": ["minimal", "values", "rich"],
          "default": "rich",
          "description": "Detail level for iteration hover: minimal (nav only), values (nav + variables), rich (nav + variables + messages)."
        }
```

- [ ] **Step 2: Add helper to build command URI**

In `src/editor/hoverProvider.ts`, add after the imports (line 4):

```typescript
function cmdUri(command: string, loopId: string): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([loopId]))}`;
}
```

- [ ] **Step 3: Add method to build navigation links markdown**

In `CoverageHoverProvider`, add new private method:

```typescript
  private buildIterationNavMarkdown(loopId: string, loop: { currentIteration: number; iterationCount: number }): string {
    if (this.iterationStore!.isShowingAll(loopId)) {
      return `[$(chevron-left) Step in](${cmdUri('alchemist.iterationPrev', loopId)}) | ` +
        `[Step in $(chevron-right)](${cmdUri('alchemist.iterationNext', loopId)}) | ` +
        `[Table](${cmdUri('alchemist.iterationTable', loopId)})`;
    }
    return `[$(chevron-left) Prev](${cmdUri('alchemist.iterationPrev', loopId)}) | ` +
      `[Next $(chevron-right)](${cmdUri('alchemist.iterationNext', loopId)}) | ` +
      `[Show All](${cmdUri('alchemist.iterationShowAll', loopId)}) | ` +
      `[Table](${cmdUri('alchemist.iterationTable', loopId)})`;
  }
```

- [ ] **Step 4: Enhance buildIterationHover with nav links and detail levels**

Replace the `buildIterationHover` method (lines 71-104) with:

```typescript
  private buildIterationHover(
    hoveredWord: string,
    lineNumber: number,
    stepping: { loopId: string; iteration: number },
  ): vscode.Hover | undefined {
    const step = this.iterationStore!.getStep(stepping.loopId, stepping.iteration);
    const loop = this.iterationStore!.getLoop(stepping.loopId);

    const hoveredLower = hoveredWord.toLowerCase();
    const matchingKey = hoveredWord ? Array.from(step.capturedValues.keys()).find(k => k.toLowerCase() === hoveredLower) : undefined;
    const hasMatchingVar = !!matchingKey;
    const lineExecuted = step.linesExecuted.has(lineNumber);

    if (!hasMatchingVar && !lineExecuted) return undefined;

    const detail = vscode.workspace.getConfiguration('alchemist').get<string>('iterationHoverDetail', 'rich');
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.supportHtml = true;

    // Header
    markdown.appendMarkdown(`**Iteration ${stepping.iteration} of ${loop.iterationCount}**\n\n`);

    // Navigation links
    markdown.appendMarkdown(this.buildIterationNavMarkdown(stepping.loopId, loop));
    markdown.appendMarkdown('\n\n');

    // Per-iteration variable value (for hovered word)
    if (hasMatchingVar) {
      const value = step.capturedValues.get(matchingKey!)!;
      markdown.appendCodeblock(`${matchingKey} = ${value}`, 'al');
    }

    // Values table (values + rich modes)
    if (detail !== 'minimal' && step.capturedValues.size > 0) {
      const changedVars = this.iterationStore!.getChangedValues(stepping.loopId, stepping.iteration);
      const prevStep = stepping.iteration > 1 ? this.iterationStore!.getStep(stepping.loopId, stepping.iteration - 1) : null;

      markdown.appendMarkdown('\n| Variable | Value |\n|----------|-------|\n');
      for (const [name, value] of step.capturedValues) {
        const changed = changedVars.includes(name);
        const prevValue = prevStep?.capturedValues.get(name);
        const changeNote = changed && prevValue !== undefined ? ` *(was ${prevValue})*` : '';
        markdown.appendMarkdown(`| ${name} | \`${value}\`${changeNote} |\n`);
      }
    }

    // Messages (rich mode only)
    if (detail === 'rich' && step.messages.length > 0) {
      markdown.appendMarkdown(`\nMessages: ${step.messages.map(m => `\`${m}\``).join(', ')}\n`);
    }

    return new vscode.Hover(markdown);
  }
```

- [ ] **Step 5: Add hover for loop line in show-all mode**

The existing `getActiveSteppingLoop` only returns loops being stepped (not show-all). We need to also show navigation hover when hovering on a loop line in show-all mode. Update `buildHover` (lines 23-42) to also handle loop lines in show-all mode:

Replace the `buildHover` method:

```typescript
  private buildHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // Convert to 1-indexed

    // Check if we're in per-iteration stepping mode
    const steppingLoop = this.getActiveSteppingLoop(lineNumber);

    // Get the hovered word for variable matching
    const wordRange = document.getWordRangeAtPosition(position);
    const hoveredWord = wordRange ? document.getText(wordRange) : '';

    if (steppingLoop) {
      return this.buildIterationHover(hoveredWord, lineNumber, steppingLoop);
    }

    // Show-all mode: if hovering on a loop line, show nav-only hover
    const loopLineHover = this.buildLoopLineHover(lineNumber);
    if (loopLineHover) return loopLineHover;

    return this.buildAggregateHover(filePath, hoveredWord, lineNumber);
  }
```

Add `buildLoopLineHover`:

```typescript
  /**
   * Show navigation hover when hovering on a loop line in show-all mode.
   */
  private buildLoopLineHover(lineNumber: number): vscode.Hover | undefined {
    if (!this.iterationStore) return undefined;
    const loops = this.iterationStore.getLoops();
    const loop = loops.find(l => l.loopLine === lineNumber && l.iterationCount >= 2);
    if (!loop) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    if (this.iterationStore.isShowingAll(loop.loopId)) {
      markdown.appendMarkdown(`**All iterations** (${loop.iterationCount} total)\n\n`);
    } else {
      markdown.appendMarkdown(`**Iteration ${loop.currentIteration} of ${loop.iterationCount}**\n\n`);
    }
    markdown.appendMarkdown(this.buildIterationNavMarkdown(loop.loopId, loop));
    markdown.appendMarkdown('\n');

    return new vscode.Hover(markdown);
  }
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd U:/Git/ALchemist && npx tsc --noEmit`
Expected: Exit 0

- [ ] **Step 7: Commit**

```bash
cd U:/Git/ALchemist
git add src/editor/hoverProvider.ts package.json
git commit -m "Add interactive hover with command URIs for iteration navigation"
```

---

## Task 3: Status Bar Stepper

**Files:**
- Modify: `src/output/statusBar.ts:70-85`
- Modify: `src/extension.ts:202,223,237`

- [ ] **Step 1: Add iteration stepper items to StatusBarManager**

In `src/output/statusBar.ts`, replace `setIterationIndicator`, `clearIterationIndicator`, and add new methods. Replace lines 70-85 (from `setIterationIndicator` through `dispose`):

```typescript
  // --- Iteration stepper ---

  private prevItem?: vscode.StatusBarItem;
  private counterItem?: vscode.StatusBarItem;
  private nextItem?: vscode.StatusBarItem;
  private tableItem?: vscode.StatusBarItem;

  showIterationStepper(loopId: string, current: number, total: number): void {
    if (!this.prevItem) {
      this.prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
      this.prevItem.command = 'alchemist.iterationPrev';
      this.prevItem.tooltip = 'Previous iteration (Ctrl+Shift+A Left)';

      this.counterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
      this.counterItem.command = 'alchemist.iterationShowAll';
      this.counterItem.tooltip = 'Show all iterations (Ctrl+Shift+A A)';

      this.nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
      this.nextItem.command = 'alchemist.iterationNext';
      this.nextItem.tooltip = 'Next iteration (Ctrl+Shift+A Right)';

      this.tableItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
      this.tableItem.command = 'alchemist.iterationTable';
      this.tableItem.tooltip = 'Open iteration table (Ctrl+Shift+A T)';
    }

    this.prevItem.text = '$(chevron-left)';
    this.counterItem!.text = current === 0 ? 'All' : `${current}/${total}`;
    this.nextItem!.text = '$(chevron-right)';
    this.tableItem!.text = 'Table';

    this.prevItem.show();
    this.counterItem!.show();
    this.nextItem!.show();
    this.tableItem!.show();
  }

  hideIterationStepper(): void {
    this.prevItem?.hide();
    this.counterItem?.hide();
    this.nextItem?.hide();
    this.tableItem?.hide();
  }

  dispose(): void {
    this.item.dispose();
    this.prevItem?.dispose();
    this.counterItem?.dispose();
    this.nextItem?.dispose();
    this.tableItem?.dispose();
  }
```

- [ ] **Step 2: Update extension.ts to use new status bar methods**

In `src/extension.ts`, replace `statusBar.clearIterationIndicator()` with `statusBar.hideIterationStepper()` (2 occurrences — in `clearDecorations` command around line 202 and in `onIterationChanged` around line 223).

Replace `statusBar.setIterationIndicator(loopId, loop.currentIteration, loop.iterationCount)` with `statusBar.showIterationStepper(loopId, loop.currentIteration, loop.iterationCount)` (1 occurrence around line 237).

Also add a call to show the stepper in show-all mode. In `onIterationChanged`, when `iterationStore.isShowingAll(loopId)` is true, before the `return`, add:

```typescript
        const allLoop = iterationStore.getLoop(loopId);
        statusBar.showIterationStepper(loopId, 0, allLoop.iterationCount);
```

And in the store load handler (around line 91), after loading iterations, show stepper for first loop:

```typescript
        const loops = iterationStore.getLoops().filter(l => l.iterationCount >= 2);
        if (loops.length > 0) {
          statusBar.showIterationStepper(loops[0].loopId, 0, loops[0].iterationCount);
        }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd U:/Git/ALchemist && npx tsc --noEmit`
Expected: Exit 0

- [ ] **Step 4: Commit**

```bash
cd U:/Git/ALchemist
git add src/output/statusBar.ts src/extension.ts
git commit -m "Add clickable status bar stepper for iteration navigation"
```

---

## Task 4: Tests

**Files:**
- Modify: `test/suite/iterationDisplay.test.ts`
- Create: `test/suite/iterationHover.test.ts`

- [ ] **Step 1: Update stepper text tests**

In `test/suite/iterationDisplay.test.ts`, find any tests that check `buildStepperText` output. The current tests use `buildStepperText` indirectly via the decoration. Check if any assertions match the old format (`◀  All  ▶  |  Show All  |  Table`). If so, update to match new format (`⟳ All` / `⟳ 3/10`).

Search for the assertion patterns:

```bash
cd U:/Git/ALchemist && grep -n "Show All\|◀\|▶" test/suite/iterationDisplay.test.ts
```

If no direct stepper text assertions exist, no changes needed to this file.

- [ ] **Step 2: Create hover command URI tests**

Create `test/suite/iterationHover.test.ts`:

```typescript
import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

function makeLoopData(): IterationData[] {
  return [{
    loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 10, loopEndLine: 12,
    parentLoopId: null, parentIteration: null, iterationCount: 3,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'total', value: '1' }], messages: ['msg1'], linesExecuted: [10, 11, 12] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'total', value: '3' }], messages: ['msg2'], linesExecuted: [10, 11, 12] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'total', value: '6' }], messages: ['msg3'], linesExecuted: [10, 11, 12] },
    ],
  }];
}

suite('Iteration Hover — data for command URIs', () => {
  test('store provides changed values for hover display', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 2);

    const changed = store.getChangedValues('L0', 2);
    assert.ok(changed.includes('i'));
    assert.ok(changed.includes('total'));

    const step = store.getStep('L0', 2);
    assert.strictEqual(step.capturedValues.get('total'), '3');

    const prevStep = store.getStep('L0', 1);
    assert.strictEqual(prevStep.capturedValues.get('total'), '1');
  });

  test('store provides messages for rich hover', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 2);

    const step = store.getStep('L0', 2);
    assert.deepStrictEqual(step.messages, ['msg2']);
  });

  test('command URI encoding produces valid format', () => {
    const loopId = 'L0';
    const encoded = encodeURIComponent(JSON.stringify([loopId]));
    const uri = `command:alchemist.iterationNext?${encoded}`;
    assert.ok(uri.startsWith('command:alchemist.iterationNext?'));
    assert.ok(uri.includes(encodeURIComponent('"L0"')));
  });

  test('show-all mode detected for nav-only hover', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');

    assert.ok(store.isShowingAll('L0'));

    const loop = store.getLoop('L0');
    assert.strictEqual(loop.iterationCount, 3);
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd U:/Git/ALchemist && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd U:/Git/ALchemist
git add test/suite/iterationHover.test.ts test/suite/iterationDisplay.test.ts
git commit -m "Add tests for iteration hover data and command URI encoding"
```

---

## Task 5: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `cd U:/Git/ALchemist && npm test`
Expected: All tests pass

- [ ] **Step 2: Manual smoke test**

1. F5 from ALchemist
2. Open multi-file AL project with a loop in a non-test codeunit
3. Run test
4. Verify:
   - Decoration shows `⟳ All` at the loop line (correct file)
   - Hovering on loop line shows clickable nav links
   - Status bar shows `◀ All ▶ Table` at bottom right
   - Click `▶` in status bar → decoration changes to `⟳ 1/10`, inline values appear
   - Hover on loop line → shows values table with "was X" for changed vars
   - Click `Prev` in hover → steps back, values update
   - Click `Table` → opens iteration table panel
   - Click `Show All` in hover → returns to aggregate view
