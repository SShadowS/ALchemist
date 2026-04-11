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
