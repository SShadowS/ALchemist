import { ExecutionEngine, RunTestsRequest, ExecuteScratchRequest } from './executionEngine';
import { ExecutionResult, TestResult } from '../runner/outputParser';
import { TestEvent, FileCoverage } from './protocolV2Types';

const STATUS_MAP: Record<string, 'passed' | 'failed' | 'errored'> = {
  pass: 'passed',
  fail: 'failed',
  error: 'errored',
};

interface ServerProcessLike {
  send(payload: object, onEvent?: (event: any) => void): Promise<any>;
  cancel?(): Promise<void>;
  dispose(): Promise<void>;
  isHealthy?(): boolean;
}

export class ServerExecutionEngine implements ExecutionEngine {
  constructor(private readonly process: ServerProcessLike) {}

  async runTests(req: RunTestsRequest, onTest?: (event: TestEvent) => void): Promise<ExecutionResult> {
    const startTime = Date.now();
    const payload: any = {
      command: 'runtests',
      sourcePaths: req.sourcePaths,
      captureValues: req.captureValues ?? true,
    };
    if (req.iterationTracking) { payload.iterationTracking = true; }
    if (req.coverage) { payload.coverage = true; }
    if (req.cobertura) { payload.cobertura = true; }
    if (req.testFilter) { payload.testFilter = req.testFilter; }

    const accumulated: TestResult[] = [];
    const onEvent = (event: any) => {
      if (event && event.type === 'test') {
        accumulated.push(this.mapTestEvent(event));
        if (onTest) { onTest(event as TestEvent); }
      }
      // 'progress' events ignored for now (future use)
    };

    let response: any;
    try {
      response = await this.process.send(payload, onEvent);
    } catch (err: any) {
      return failureResult(err.message ?? String(err), startTime, 'test');
    }

    if (response.error && !response.type) {
      return failureResult(response.error, startTime, 'test');
    }

    let tests: TestResult[];
    if (response.type === 'summary') {
      // v2 streaming path — events accumulated above.
      tests = accumulated;
    } else {
      // v1 fallback — tests inline on response.
      const rawTests: any[] = response.tests ?? [];
      tests = rawTests.map((t: any) => this.mapV1Test(t));
    }

    const summary = response.type === 'summary'
      ? {
          passed: response.passed ?? 0,
          failed: response.failed ?? 0,
          errors: response.errors ?? 0,
          total: response.total ?? 0,
        }
      : ((response.passed !== undefined || response.total !== undefined)
          ? {
              passed: response.passed ?? 0,
              failed: response.failed ?? 0,
              errors: response.errors ?? 0,
              total: response.total ?? 0,
            }
          : undefined);

    return {
      mode: 'test',
      tests,
      messages: response.messages ?? [],
      stderrOutput: [],
      summary,
      coverage: (response.type !== 'summary' && Array.isArray(response.coverage)) ? response.coverage : [],
      coverageV2: response.type === 'summary' && Array.isArray(response.coverage)
        ? (response.coverage as FileCoverage[])
        : undefined,
      exitCode: response.exitCode ?? 0,
      durationMs: Date.now() - startTime,
      capturedValues: response.capturedValues ?? [],
      cached: response.cached ?? false,
      cancelled: response.cancelled === true,
      protocolVersion: typeof response.protocolVersion === 'number' ? response.protocolVersion : undefined,
      iterations: response.iterations ?? [],
    };
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
    return this.executeSingle(payload, startTime, 'scratch');
  }

  isHealthy(): boolean {
    return this.process.isHealthy?.() ?? true;
  }

  async cancel(): Promise<void> {
    if (this.process.cancel) {
      await this.process.cancel();
    }
  }

  async dispose(): Promise<void> {
    await this.process.dispose();
  }

  private async executeSingle(payload: any, startTime: number, mode: 'test' | 'scratch'): Promise<ExecutionResult> {
    let response: any;
    try {
      response = await this.process.send(payload);
    } catch (err: any) {
      return failureResult(err.message ?? String(err), startTime, mode);
    }
    if (response.error) {
      return failureResult(response.error, startTime, mode);
    }
    const rawTests: any[] = response.tests ?? [];
    const tests: TestResult[] = rawTests.map((t: any) => this.mapV1Test(t));

    const summary = response.summary ?? (
      (response.passed !== undefined || response.total !== undefined)
        ? {
            passed: response.passed ?? 0,
            failed: response.failed ?? 0,
            errors: response.errors ?? 0,
            total: response.total ?? 0,
          }
        : undefined
    );

    return {
      mode,
      tests,
      messages: response.messages ?? [],
      stderrOutput: [],
      summary,
      coverage: response.coverage ?? [],
      exitCode: response.exitCode ?? 0,
      durationMs: Date.now() - startTime,
      capturedValues: response.capturedValues ?? [],
      cached: response.cached ?? false,
      iterations: response.iterations ?? [],
    };
  }

  private mapTestEvent(event: any): TestResult {
    return {
      name: event.name,
      status: STATUS_MAP[event.status] ?? 'errored',
      durationMs: event.durationMs ?? undefined,
      message: event.message ?? undefined,
      stackTrace: event.stackTrace ?? undefined,
      alSourceLine: event.alSourceLine ?? undefined,
      alSourceColumn: event.alSourceColumn ?? undefined,
      alSourceFile: event.alSourceFile ?? undefined,
      errorKind: event.errorKind ?? undefined,
      stackFrames: event.stackFrames ?? undefined,
      messages: event.messages ?? undefined,
      capturedValues: event.capturedValues ?? undefined,
    };
  }

  private mapV1Test(t: any): TestResult {
    return {
      name: t.name,
      status: STATUS_MAP[t.status] ?? 'errored',
      durationMs: t.durationMs ?? undefined,
      message: t.message ?? undefined,
      stackTrace: t.stackTrace ?? undefined,
      alSourceLine: t.alSourceLine ?? undefined,
      alSourceColumn: t.alSourceColumn ?? undefined,
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
