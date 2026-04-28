import { ExecutionResult } from '../runner/outputParser';

export interface RunTestsRequest {
  sourcePaths: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
  coverage?: boolean;
}

export interface ExecuteScratchRequest {
  inlineCode?: string;
  filePath?: string;
  sourcePaths?: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
}

export interface ExecutionEngine {
  runTests(req: RunTestsRequest): Promise<ExecutionResult>;
  executeScratch(req: ExecuteScratchRequest): Promise<ExecutionResult>;
  isHealthy(): boolean;
  dispose(): Promise<void>;
}
