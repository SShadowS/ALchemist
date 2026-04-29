import { ExecutionEngine, RunTestsRequest, ExecuteScratchRequest } from './executionEngine';
import { ExecutionResult, TestResult } from '../runner/outputParser';
import { TestEvent, FileCoverage, ProtocolLine } from './protocolV2Types';
import { v2ToV1Captured } from './captureValueAdapter';

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
    const onEvent = (event: ProtocolLine) => {
      if (event.type === 'test') {
        accumulated.push(this.mapTestEvent(event));
        if (onTest) { onTest(event); }
      }
      // 'progress' / 'ack' / 'summary' types ignored here; summary terminates upstream.
    };

    let response: any;
    try {
      response = await this.process.send(payload, onEvent);
    } catch (err: any) {
      return failureResult(err.message ?? String(err), startTime, 'test');
    }

    // Either v1 error response (no type) or v2 error-summary
    // (type === 'summary' carrying a string `error`). Both should fail fast.
    if (response.error && typeof response.error === 'string') {
      return failureResult(response.error, startTime, 'test');
    }

    // Tighten v2 discriminator: ONLY treat as v2 when type==='summary' AND
    // protocolVersion===2. A hypothetical v1 server emitting {type:'summary'}
    // without protocolVersion falls through to the v1 path that reads
    // response.tests[] inline.
    const isV2Summary = response.type === 'summary' && response.protocolVersion === 2;

    let tests: TestResult[];
    if (isV2Summary) {
      // v2 streaming path — events accumulated above.
      tests = accumulated;
    } else {
      // v1 fallback — tests inline on response.
      const rawTests: any[] = response.tests ?? [];
      tests = rawTests.map((t: any) => this.mapV1Test(t));
    }

    const summary = isV2Summary
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
      // v2: per-test messages / capturedValues also live on each TestResult. The
      // top-level fields are populated by FLATTENING across tests so existing v1
      // consumers (DecorationManager.applyInlineMessages, OutputChannel) keep
      // rendering. Per-test scoping is also available via TestResult.{messages,
      // capturedValues} for v2-aware consumers (DecorationManager.setCapturedValuesForTest).
      messages: isV2Summary
        ? tests.flatMap(t => t.messages ?? [])
        : (response.messages ?? []),
      stderrOutput: [],
      summary,
      coverage: (!isV2Summary && Array.isArray(response.coverage)) ? response.coverage : [],
      coverageV2: isV2Summary && Array.isArray(response.coverage)
        ? (response.coverage as FileCoverage[])
        : undefined,
      exitCode: response.exitCode ?? 0,
      durationMs: Date.now() - startTime,
      // v2: per-test capturedValues also live on each TestResult. Top-level
      // fields are flattened for v1 consumers. v2-aware consumers can use per-test fields.
      capturedValues: isV2Summary
        ? tests.flatMap(t =>
            (t.capturedValues ?? []).map(cv => v2ToV1Captured(cv, t.alSourceFile)))
        : (response.capturedValues ?? []),
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
