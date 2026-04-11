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
