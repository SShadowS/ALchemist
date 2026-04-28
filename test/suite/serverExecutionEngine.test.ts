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
});
