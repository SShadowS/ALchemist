import { ExecutionEngine, RunTestsRequest, ExecuteScratchRequest } from './executionEngine';
import { ExecutionResult } from '../runner/outputParser';

interface ServerProcessLike {
  send(payload: object): Promise<any>;
  dispose(): Promise<void>;
  isHealthy?(): boolean;
}

export class ServerExecutionEngine implements ExecutionEngine {
  constructor(private readonly process: ServerProcessLike) {}

  async runTests(req: RunTestsRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    const payload: any = {
      command: 'runtests',
      sourcePaths: req.sourcePaths,
      captureValues: req.captureValues ?? true,
    };
    if (req.iterationTracking) { payload.iterationTracking = true; }
    if (req.coverage) { payload.coverage = true; }
    return this.execute(payload, startTime, 'test');
  }

  async executeScratch(req: ExecuteScratchRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    const payload: any = {
      command: 'execute',
      captureValues: req.captureValues ?? true,
    };
    if (req.inlineCode !== undefined) { payload.code = req.inlineCode; }
    if (req.sourcePaths !== undefined) { payload.sourcePaths = req.sourcePaths; }
    if (req.iterationTracking) { payload.iterationTracking = true; }
    return this.execute(payload, startTime, 'scratch');
  }

  isHealthy(): boolean {
    return this.process.isHealthy?.() ?? true;
  }

  async dispose(): Promise<void> {
    await this.process.dispose();
  }

  private async execute(payload: any, startTime: number, mode: 'test' | 'scratch'): Promise<ExecutionResult> {
    let response: any;
    try {
      response = await this.process.send(payload);
    } catch (err: any) {
      return failureResult(err.message ?? String(err), startTime, mode);
    }
    if (response.error) {
      return failureResult(response.error, startTime, mode);
    }
    return {
      mode,
      tests: response.tests ?? [],
      messages: response.messages ?? [],
      stderrOutput: [],
      summary: response.summary,
      coverage: response.coverage ?? [],
      exitCode: response.exitCode ?? 0,
      durationMs: Date.now() - startTime,
      capturedValues: response.capturedValues ?? [],
      cached: response.cached ?? false,
      iterations: response.iterations ?? [],
    };
  }
}

function failureResult(message: string, startTime: number, mode: 'test' | 'scratch'): ExecutionResult {
  return {
    mode,
    tests: [],
    messages: [],
    stderrOutput: [message],
    summary: undefined,
    coverage: [],
    exitCode: 1,
    durationMs: Date.now() - startTime,
    capturedValues: [],
    cached: false,
    iterations: [],
  };
}
