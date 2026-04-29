import * as assert from 'assert';
import { EventEmitter, Readable, Writable } from 'stream';
import * as sinon from 'sinon';
import { ServerProcess, ServerSpawner } from '../../src/execution/serverProcess';

// ---------------------------------------------------------------------------
// MockChildProcess — mirrors the pattern from serverProcess.streaming.test.ts
// ---------------------------------------------------------------------------

class MockChildProcess extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  emitted: string[] = [];
  stdin: any;
  pid = 5678;
  killed = false;

  constructor() {
    super();
    const self = this;
    this.stdin = new Writable({
      write(chunk: any, _enc: any, cb: any) {
        self.emitted.push(chunk.toString());
        cb();
      }
    });
  }

  kill(_sig?: NodeJS.Signals) { this.killed = true; this.emit('exit', 0, null); }
  pushStdout(line: string) { this.stdout.push(line + '\n'); }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('ServerProcess protocol version detection', () => {
  let proc: MockChildProcess;
  let spawner: sinon.SinonStub;

  setup(() => {
    proc = new MockChildProcess();
    spawner = sinon.stub().returns(proc as any);
  });

  teardown(() => sinon.restore());

  test('records protocolVersion 2 from v2 summary', async () => {
    const sp = new ServerProcess({ runnerPath: 'fake', spawner });

    const testLine = JSON.stringify({ type: 'test', name: 'A', status: 'pass', durationMs: 1 });
    const summaryLine = JSON.stringify({
      type: 'summary',
      exitCode: 0,
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      protocolVersion: 2
    });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => {
      proc.pushStdout(testLine);
      proc.pushStdout(summaryLine);
    });

    await sp.send({ command: 'runtests' }, () => {});
    assert.strictEqual(sp.getProtocolVersion(), 2, 'should record protocolVersion 2');
    await sp.dispose();
  });

  test('returns undefined for v1 (no protocolVersion in response)', async () => {
    const sp = new ServerProcess({ runnerPath: 'fake', spawner });

    const v1Response = JSON.stringify({
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      exitCode: 0,
      tests: [{ name: 'A', status: 'pass', durationMs: 1 }]
    });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(v1Response));

    await sp.send({ command: 'runtests' });
    assert.strictEqual(sp.getProtocolVersion(), undefined, 'should return undefined for v1 response');
    await sp.dispose();
  });

  test('updates after runtests cycles (v1 then v2)', async () => {
    // First instance with v1 response
    const sp1 = new ServerProcess({ runnerPath: 'fake', spawner: sinon.stub().callsFake(() => {
      const p = new MockChildProcess();
      setImmediate(() => p.pushStdout('{"ready":true}'));
      setImmediate(() => p.pushStdout(JSON.stringify({
        passed: 0,
        failed: 0,
        errors: 0,
        total: 0,
        exitCode: 0,
        tests: []
      })));
      return p as any;
    }) });

    await sp1.send({ command: 'runtests' });
    assert.strictEqual(sp1.getProtocolVersion(), undefined, 'first instance should show v1 (undefined)');
    await sp1.dispose();

    // Second instance with v2 response
    const sp2 = new ServerProcess({ runnerPath: 'fake', spawner: sinon.stub().callsFake(() => {
      const p = new MockChildProcess();
      setImmediate(() => p.pushStdout('{"ready":true}'));
      setImmediate(() => p.pushStdout(JSON.stringify({
        type: 'summary',
        exitCode: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        total: 0,
        protocolVersion: 2
      })));
      return p as any;
    }) });

    await sp2.send({ command: 'runtests' }, () => {});
    assert.strictEqual(sp2.getProtocolVersion(), 2, 'second instance should show v2');
    await sp2.dispose();
  });

  test('protocol version persists across multiple sends', async () => {
    const sp = new ServerProcess({ runnerPath: 'fake', spawner });

    const summaryLine = JSON.stringify({
      type: 'summary',
      exitCode: 0,
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      protocolVersion: 2
    });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(summaryLine));

    // First send with v2 summary
    await sp.send({ command: 'runtests' });
    assert.strictEqual(sp.getProtocolVersion(), 2, 'should have v2 after first send');

    // Query again — should still be v2
    assert.strictEqual(sp.getProtocolVersion(), 2, 'version should persist after subsequent query');

    await sp.dispose();
  });
});
