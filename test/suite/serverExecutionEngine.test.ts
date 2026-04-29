import * as assert from 'assert';
import * as sinon from 'sinon';
import { ServerExecutionEngine } from '../../src/execution/serverExecutionEngine';

suite('ServerExecutionEngine', () => {
  test('runTests sends runtests command with sourcePaths', async () => {
    const sendStub = sinon.stub().resolves({ tests: [], messages: [], capturedValues: [], iterations: [], exitCode: 0 });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    await eng.runTests({ sourcePaths: ['/a', '/b'], captureValues: true });
    sinon.assert.calledOnce(sendStub);
    const payload = sendStub.firstCall.args[0];
    assert.strictEqual(payload.command, 'runtests');
    assert.deepStrictEqual(payload.sourcePaths, ['/a', '/b']);
    assert.strictEqual(payload.captureValues, true);
  });

  test('executeScratch with inlineCode sends execute command + code', async () => {
    const sendStub = sinon.stub().resolves({ tests: [], messages: [], capturedValues: [], iterations: [], exitCode: 0 });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    await eng.executeScratch({ inlineCode: 'codeunit 1 X{}', captureValues: true });
    const payload = sendStub.firstCall.args[0];
    assert.strictEqual(payload.command, 'execute');
    assert.strictEqual(payload.code, 'codeunit 1 X{}');
  });

  test('executeScratch with sourcePaths sends execute command + sourcePaths', async () => {
    const sendStub = sinon.stub().resolves({ tests: [], messages: [], capturedValues: [], iterations: [], exitCode: 0 });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    await eng.executeScratch({ sourcePaths: ['/main', '/scratch'], captureValues: true });
    const payload = sendStub.firstCall.args[0];
    assert.strictEqual(payload.command, 'execute');
    assert.deepStrictEqual(payload.sourcePaths, ['/main', '/scratch']);
  });

  test('server "error" response surfaces as ExecutionResult success=false', async () => {
    const sendStub = sinon.stub().resolves({ error: 'Unknown command: foo' });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    const result = await eng.runTests({ sourcePaths: ['/a'] });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.stderrOutput.some(line => line.includes('Unknown command')));
  });

  test('dispose() forwards to underlying process', async () => {
    const disposeStub = sinon.stub().resolves();
    const fakeProcess: any = { send: sinon.stub(), dispose: disposeStub, isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    await eng.dispose();
    sinon.assert.calledOnce(disposeStub);
  });

  test('v2 summary with iterations populates result.iterations', async () => {
    const v2Iterations = [{
      loopId: 'L1',
      sourceFile: 'C:/x/CU1.al',
      loopLine: 5,
      loopEndLine: 9,
      iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], linesExecuted: [6] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], linesExecuted: [6] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], linesExecuted: [6] },
      ],
    }];
    // ServerExecutionEngine reads `response.iterations` (line 116) for both
    // v1 (--output-json) and v2 (--server) — same field name. The runner-side
    // change in Plan E3 Group B emits this field on the v2 summary; this test
    // asserts the engine's mapping passes it through unchanged.
    const sendStub = sinon.stub().resolves({
      tests: [],
      messages: [],
      capturedValues: [],
      iterations: v2Iterations,
      exitCode: 0,
      protocolVersion: 2,
    });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    const result = await eng.runTests({ sourcePaths: ['/ws'], iterationTracking: true });

    assert.strictEqual(result.iterations.length, 1, 'iterations must flow through engine mapping');
    assert.strictEqual(result.iterations[0].loopId, 'L1');
    assert.strictEqual(result.iterations[0].iterationCount, 3);
    assert.strictEqual(result.iterations[0].steps.length, 3);
    assert.strictEqual(result.iterations[0].steps[0].capturedValues[0].variableName, 'i');
    assert.strictEqual(result.iterations[0].steps[0].capturedValues[0].value, '1');
  });

  test('runTests forwards iterationTracking flag to runner payload', async () => {
    const sendStub = sinon.stub().resolves({ tests: [], messages: [], capturedValues: [], iterations: [], exitCode: 0 });
    const fakeProcess: any = { send: sendStub, dispose: sinon.stub().resolves(), isHealthy: () => true };
    const eng = new ServerExecutionEngine(fakeProcess);
    await eng.runTests({ sourcePaths: ['/a'], iterationTracking: true });
    const payload = sendStub.firstCall.args[0];
    assert.strictEqual(payload.iterationTracking, true,
      'iterationTracking flag must be forwarded so the runner enables IterationTracker');
  });
});
