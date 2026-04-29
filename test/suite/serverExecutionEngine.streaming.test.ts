import * as assert from 'assert';
import { ServerExecutionEngine } from '../../src/execution/serverExecutionEngine';
import { TestEvent } from '../../src/execution/protocolV2Types';

class StubProcess {
  public lastPayload: any;
  public lastOnEvent: ((e: any) => void) | undefined;
  public canceled = false;
  constructor(private readonly response: any, private readonly events: any[] = []) {}
  async send(payload: any, onEvent?: any): Promise<any> {
    this.lastPayload = payload;
    this.lastOnEvent = onEvent;
    if (onEvent) { for (const ev of this.events) { onEvent(ev); } }
    return this.response;
  }
  async cancel(): Promise<void> { this.canceled = true; }
  async dispose(): Promise<void> { /* no-op */ }
  isHealthy(): boolean { return true; }
}

suite('ServerExecutionEngine v2 passthrough', () => {
  test('forwards testFilter to payload', async () => {
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    await engine.runTests({
      sourcePaths: ['./src'],
      testFilter: { procNames: ['Foo'] },
    });
    assert.deepStrictEqual(stub.lastPayload.testFilter, { procNames: ['Foo'] });
  });

  test('forwards coverage flag', async () => {
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    await engine.runTests({ sourcePaths: ['./src'], coverage: true });
    assert.strictEqual(stub.lastPayload.coverage, true);
  });

  test('forwards cobertura flag', async () => {
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    await engine.runTests({ sourcePaths: ['./src'], cobertura: true });
    assert.strictEqual(stub.lastPayload.cobertura, true);
  });

  test('onTest callback fires per streaming test event', async () => {
    const ev1: any = { type: 'test', name: 'A', status: 'pass', durationMs: 1 };
    const ev2: any = { type: 'test', name: 'B', status: 'fail', durationMs: 2,
                       message: 'oops', errorKind: 'runtime' };
    const stub = new StubProcess({
      type: 'summary', exitCode: 1, passed: 1, failed: 1, errors: 0, total: 2, protocolVersion: 2,
    }, [ev1, ev2]);
    const engine = new ServerExecutionEngine(stub as any);
    const seen: TestEvent[] = [];
    const result = await engine.runTests({ sourcePaths: ['./src'] }, (e) => seen.push(e));
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0].name, 'A');
    assert.strictEqual(result.tests.length, 2);
    assert.strictEqual(result.tests[1].errorKind, 'runtime');
    assert.strictEqual(result.protocolVersion, 2);
  });

  test('preserves pass→passed status mapping (Plan B+D regression)', async () => {
    const ev: any = { type: 'test', name: 'A', status: 'pass', durationMs: 1 };
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2,
    }, [ev]);
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] }, () => {});
    assert.strictEqual(result.tests[0].status, 'passed');
  });

  test('cancel forwards to ServerProcess', async () => {
    const stub = new StubProcess({});
    const engine = new ServerExecutionEngine(stub as any);
    await engine.cancel();
    assert.strictEqual(stub.canceled, true);
  });

  test('summary cancelled:true sets result.cancelled', async () => {
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0,
      cancelled: true, protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] });
    assert.strictEqual(result.cancelled, true);
  });

  test('summary coverage maps to result.coverageV2', async () => {
    const stub = new StubProcess({
      type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0,
      coverage: [{ file: 'src/Foo.al', lines: [{ line: 1, hits: 1 }],
                   totalStatements: 1, hitStatements: 1 }],
      protocolVersion: 2,
    });
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'], coverage: true });
    assert.strictEqual(result.coverageV2!.length, 1);
    assert.strictEqual(result.coverageV2![0].file, 'src/Foo.al');
    // Legacy `coverage` (CoverageEntry shape) stays empty in v2 path.
    assert.deepStrictEqual(result.coverage, []);
  });

  test('v1 fallback: response without type still maps tests', async () => {
    const v1Response = {
      tests: [{ name: 'X', status: 'pass', durationMs: 5, alSourceLine: 12 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    };
    const stub = new StubProcess(v1Response);
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] });
    assert.strictEqual(result.tests.length, 1);
    assert.strictEqual(result.tests[0].name, 'X');
    assert.strictEqual(result.tests[0].alSourceLine, 12);
    assert.strictEqual(result.protocolVersion, undefined);
  });

  test('v2 test event populates v2 fields on TestResult', async () => {
    const ev: any = {
      type: 'test', name: 'F', status: 'fail', durationMs: 10,
      message: 'boom', errorKind: 'assertion',
      alSourceFile: 'src/X.al', alSourceLine: 42, alSourceColumn: 5,
      stackFrames: [{ name: 'Foo.Bar', line: 42, presentationHint: 'normal' }],
      messages: ['inside'], capturedValues: [{ scopeName: 's', variableName: 'v', value: '1', statementId: 0 }],
    };
    const stub = new StubProcess({
      type: 'summary', exitCode: 1, passed: 0, failed: 1, errors: 0, total: 1, protocolVersion: 2,
    }, [ev]);
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: ['./src'] }, () => {});
    const t = result.tests[0];
    assert.strictEqual(t.alSourceFile, 'src/X.al');
    assert.strictEqual(t.errorKind, 'assertion');
    assert.strictEqual(t.stackFrames!.length, 1);
    assert.deepStrictEqual(t.messages, ['inside']);
    assert.strictEqual(t.capturedValues!.length, 1);
  });

  test('error response without type still maps to failureResult', async () => {
    const stub = new StubProcess({ error: 'sourcePaths is required' });
    const engine = new ServerExecutionEngine(stub as any);
    const result = await engine.runTests({ sourcePaths: [] });
    assert.strictEqual(result.tests.length, 0);
    assert.deepStrictEqual(result.stderrOutput, ['sourcePaths is required']);
    assert.strictEqual(result.exitCode, 1);
  });
});
