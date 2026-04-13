# Interactive Iteration Stepper UX

**Date:** 2026-04-13
**Status:** Approved

## Problem

The iteration stepper decoration at the loop line shows `◀  All  ▶  |  Show All  |  Table` but is not clickable — decorations are visual only. CodeLens (which is clickable) only renders on files with TestItems in VS Code's test controller, so non-test files with loops get no interactive controls.

Users must rely on keyboard shortcuts (`Ctrl+Shift+A` + arrows) or the command palette for navigation. This is not discoverable and not optimal for casual use.

## Solution

Three complementary interaction layers, each serving a different workflow:

1. **Decoration** — simplified visual anchor at the loop line
2. **Interactive hover** — contextual navigation + value preview via command URIs
3. **Status bar stepper** — persistent clickable controls for rapid stepping

Plus existing keyboard shortcuts and Table panel (unchanged).

---

## Layer 1: Decoration (Visual Anchor)

Simplified from the current full stepper text to a compact state indicator.

**Show-all mode:** `⟳ All`
**Stepping mode:** `⟳ 3/10`

Same styling: `editorCodeLens.foreground` color, 16px left margin. Same debounced refresh on document changes and editor switches.

### Changes

- `buildStepperText()` in `iterationCodeLensProvider.ts` — return `⟳ All` or `⟳ ${current}/${count}` instead of the full nav text.

---

## Layer 2: Interactive Hover (Contextual Navigation)

When hovering over the loop line (any position on the line, including the decoration), show a `MarkdownString` hover with clickable command links.

### Detail Levels

Controlled by setting `alchemist.iterationHoverDetail`: `"minimal"` | `"values"` | `"rich"` (default `"rich"`).

**Minimal:**
```markdown
**Iteration 3 of 10**

[◀ Prev](command:alchemist.iterationPrev?%5B%22L0%22%5D) | [Next ▶](command:alchemist.iterationNext?%5B%22L0%22%5D) | [Show All](command:alchemist.iterationShowAll?%5B%22L0%22%5D) | [Table](command:alchemist.iterationTable?%5B%22L0%22%5D)
```

**Values** (adds variable table):
```markdown
**Iteration 3 of 10**

[◀ Prev](command:...) | [Next ▶](command:...) | [Show All](command:...) | [Table](command:...)

| Variable | Value |
|----------|-------|
| i | `3` |
| myInt | `6` *(was 3)* |
```

**Rich** (adds messages and loop context):
```markdown
**Iteration 3 of 10** — `for i := 1 to 10`

[◀ Prev](command:...) | [Next ▶](command:...) | [Show All](command:...) | [Table](command:...)

| Variable | Value |
|----------|-------|
| i | `3` |
| myInt | `6` *(was 3)* |

Messages: `"small: 6"`
```

**Show-all mode** (all detail levels):
```markdown
**All iterations** (10 total)

[◀ Step in](command:alchemist.iterationPrev?%5B%22L0%22%5D) | [Step in ▶](command:alchemist.iterationNext?%5B%22L0%22%5D) | [Table](command:alchemist.iterationTable?%5B%22L0%22%5D)
```

### Implementation

Enhance the existing `CoverageHoverProvider` in `src/editor/hoverProvider.ts`:

- The hover provider already checks if the cursor is on a loop line and shows iteration data.
- Add command URIs to the existing hover content using `MarkdownString` with `isTrusted = true` (already set).
- Command arguments must be URI-encoded JSON: `command:alchemist.iterationNext?%5B%22L0%22%5D` (encodes `["L0"]`).
- Read the detail level from `alchemist.iterationHoverDetail` configuration.
- Use `store.getChangedValues()` to show "was X" for changed variables.
- Use the loop's step messages for the rich level.

### Hover Trigger

The hover fires when the user hovers over any position on the loop line. The existing `CoverageHoverProvider` already handles this — it checks if the hovered line falls within a loop's `loopLine..loopEndLine` range. The enhancement adds navigation controls to the existing hover content.

---

## Layer 3: Status Bar Stepper (Persistent Rapid-Stepping)

Multiple `StatusBarItem` instances side by side: `◀ 3/10 ▶ | Table`

### Items

| Segment | Text | Command | Tooltip |
|---------|------|---------|---------|
| Prev | `$(chevron-left)` | `alchemist.iterationPrev` | `Previous iteration (Ctrl+Shift+A Left)` |
| Counter | `3/10` or `All` | `alchemist.iterationShowAll` | `Show all iterations (Ctrl+Shift+A A)` |
| Next | `$(chevron-right)` | `alchemist.iterationNext` | `Next iteration (Ctrl+Shift+A Right)` |
| Table | `Table` | `alchemist.iterationTable` | `Open iteration table (Ctrl+Shift+A T)` |

### Behavior

- Only visible when `alchemist.hasIterationData` context is true.
- Updates on every store change event (`iteration-changed`, `show-all`, `loaded`, `cleared`).
- When store is cleared, all items hidden.
- Positioned with descending priority so they appear in order (left to right).
- Use `StatusBarAlignment.Right` to avoid conflicting with the existing ALchemist status bar on the left.

### Changes

- `src/output/statusBar.ts` — replace the current `⟳N/M` append approach with dedicated `StatusBarItem` instances.
- Remove `setIterationIndicator()` and `clearIterationIndicator()` — replaced by the new stepper items.
- Add `createIterationStepper()` method that creates and manages the 4 items.
- Listen to `iterationStore.onDidChange` to update counter text and visibility.

---

## New Setting

```json
"alchemist.iterationHoverDetail": {
  "type": "string",
  "enum": ["minimal", "values", "rich"],
  "default": "rich",
  "description": "Detail level for iteration hover: minimal (nav only), values (nav + variables), rich (nav + variables + messages)"
}
```

---

## What Stays Unchanged

- `IterationCodeLensProvider` — still registered, still works on test files as a bonus
- Keyboard shortcuts — `Ctrl+Shift+A` + arrow keys
- Table webview panel — full iteration analysis
- Inline value decorations — per-line variable values that update on step
- `IterationStepperDecoration` class structure — only `buildStepperText()` output changes

---

## Testing

### Hover

- Hover on loop line in stepping mode → shows nav links + values (per detail level)
- Hover on loop line in show-all mode → shows step-in links
- Hover on non-loop line → no iteration hover (existing coverage hover only)
- Command URIs correctly encoded with loopId argument

### Status Bar

- Items visible when iteration data loaded
- Items hidden when store cleared
- Counter updates on step (prev/next/first/last)
- Counter shows "All" in show-all mode
- Each item triggers correct command on click

### Decoration

- Shows `⟳ All` in show-all mode
- Shows `⟳ 3/10` in stepping mode
- Appears only on file matching sourceFile
- Snaps back after edits (debounced)
