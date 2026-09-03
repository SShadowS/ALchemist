// src/iteration/types.ts

export interface IterationStepData {
  iteration: number;
  // scopeName/statementId retained from the upstream tags so a callee's same-named
  // local is not silently rendered against the caller (the store's Map projection is
  // still last-write-wins for the current UI, but the raw adapter output is faithful).
  capturedValues: Array<{ variableName: string; value: string; scopeName?: string; statementId?: number }>;
  messages: string[];
  linesExecuted: number[];
  statementsExecuted?: number[];
}

export interface IterationData {
  loopId: string;
  sourceFile: string;
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  steps: IterationStepData[];
  // #2056 upstream metadata, null on the fork wire.
  unsegmentable?: string | null;
  closedBy?: string | null;
}

export interface LoopInfo {
  loopId: string;
  sourceFile: string;
  loopLine: number;
  loopEndLine: number;
  parentLoopId: string | null;
  parentIteration: number | null;
  iterationCount: number;
  currentIteration: number; // 1-based when stepping, 0 = "show all"
  unsegmentable?: string | null;
  closedBy?: string | null;
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
