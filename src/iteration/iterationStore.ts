import * as path from 'path';
import { IterationData, IterationStep, LoopInfo, LoopChangeEvent } from './types';

type ChangeListener = (event: LoopChangeEvent) => void;

export class IterationStore {
  private loops = new Map<string, { info: LoopInfo; steps: IterationStep[] }>();
  private listeners: ChangeListener[] = [];

  load(iterations: IterationData[], workspacePath: string): void {
    this.loops.clear();
    for (const iter of iterations) {
      const steps: IterationStep[] = iter.steps.map((s) => ({
        iteration: s.iteration,
        // The v2 wire format uses WhenWritingNull serialization (Plan E3
        // Group C) — empty/null fields are OMITTED, not emitted as `null`
        // or `[]`. Coerce to safe defaults so downstream consumers
        // (IterationTablePanel.updateContent) can read `.length`/`.size`
        // without first checking for undefined. Pre-Plan-E3 v1 wire format
        // always emitted these arrays, so the coercion is also a forward
        // upgrade path.
        capturedValues: new Map((s.capturedValues ?? []).map((cv) => [cv.variableName, cv.value])),
        messages: s.messages ?? [],
        linesExecuted: new Set(s.linesExecuted ?? []),
      }));

      const info: LoopInfo = {
        loopId: iter.loopId,
        sourceFile: path.resolve(workspacePath, iter.sourceFile),
        loopLine: iter.loopLine,
        loopEndLine: iter.loopEndLine,
        parentLoopId: iter.parentLoopId,
        parentIteration: iter.parentIteration,
        iterationCount: iter.iterationCount,
        unsegmentable: iter.unsegmentable ?? null,
        closedBy: iter.closedBy ?? null,
        // Start in "show all" mode (0) — aggregate values are already displayed by applyResults().
        // User steps in via keyboard or CodeLens when they want per-iteration view.
        currentIteration: 0,
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

  /** True when the loop has at least one iteration to step through. An unsegmentable
   * or zero-iteration loop is loaded and listed but not navigable, so navigation must
   * short-circuit instead of throwing on a missing step. */
  isNavigable(loopId: string): boolean {
    const entry = this.loops.get(loopId);
    return entry != null && entry.steps.length > 0;
  }

  getStep(loopId: string, iteration: number): IterationStep {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    const step = entry.steps.find((s) => s.iteration === iteration);
    if (!step) throw new Error(`No step ${iteration} for loop ${loopId}`);
    return { ...step, capturedValues: new Map(step.capturedValues), linesExecuted: new Set(step.linesExecuted) };
  }

  getCurrentIteration(loopId: string): number {
    return this.getLoop(loopId).currentIteration;
  }

  setIteration(loopId: string, n: number): IterationStep | undefined {
    const entry = this.loops.get(loopId);
    if (!entry) throw new Error(`Unknown loopId: ${loopId}`);
    // A non-navigable loop (unsegmentable / zero iterations) has no step to select;
    // return undefined without firing a change so consumers never read a missing step.
    if (entry.steps.length === 0) return undefined;
    const clamped = Math.max(1, Math.min(n, entry.info.iterationCount));
    entry.info.currentIteration = clamped;
    this.fire({ loopId, kind: 'iteration-changed' });
    return this.getStep(loopId, clamped);
  }

  nextIteration(loopId: string): IterationStep | undefined {
    const current = this.getCurrentIteration(loopId);
    if (current === 0) {
      // From show-all, go to first iteration
      return this.setIteration(loopId, 1);
    }
    const count = this.getLoop(loopId).iterationCount;
    return this.setIteration(loopId, Math.min(current + 1, count));
  }

  prevIteration(loopId: string): IterationStep | undefined {
    const current = this.getCurrentIteration(loopId);
    if (current === 0) {
      // From show-all, go to last iteration
      return this.setIteration(loopId, this.getLoop(loopId).iterationCount);
    }
    return this.setIteration(loopId, Math.max(current - 1, 1));
  }

  firstIteration(loopId: string): IterationStep | undefined {
    return this.setIteration(loopId, 1);
  }

  lastIteration(loopId: string): IterationStep | undefined {
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
