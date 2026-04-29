import { ExecutionResult } from '../runner/outputParser';
import { TestEvent } from './protocolV2Types';

export interface RunTestsRequest {
  sourcePaths: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
  coverage?: boolean;
  /** v2: narrow which tests run. */
  testFilter?: { codeunitNames?: string[]; procNames?: string[] };
  /** v2: also write cobertura.xml (default false in server mode). */
  cobertura?: boolean;
}

export interface ExecuteScratchRequest {
  inlineCode?: string;
  filePath?: string;
  sourcePaths?: string[];
  captureValues?: boolean;
  iterationTracking?: boolean;
}

export interface ExecutionEngine {
  /** v2 callers may pass onTest to receive per-test events as they arrive. */
  runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult>;
  executeScratch(req: ExecuteScratchRequest): Promise<ExecutionResult>;
  isHealthy(): boolean;
  /** Fire-and-forget cancellation of the in-flight runtests. No-op if none. */
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
