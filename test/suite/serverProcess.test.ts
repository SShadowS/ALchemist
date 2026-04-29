import * as assert from 'assert';
import { EventEmitter, Readable, Writable } from 'stream';
import * as sinon from 'sinon';
import { ServerProcess, ServerSpawner } from '../../src/execution/serverProcess';

class MockChildProcess extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  emitted: string[] = [];
  stdin: any;
  pid = 1234;
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

suite('ServerProcess', () => {
  let proc: MockChildProcess;
  let spawner: any;

  setup(() => {
    proc = new MockChildProcess();
    spawner = sinon.stub().returns(proc as any);
  });

  test('lazy spawn — does not spawn until first request', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
    assert.strictEqual(spawner.callCount, 0);
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
    await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
    assert.strictEqual(spawner.callCount, 1);
    await sp.dispose();
  });

  test('forwards explicit cwd option to the spawner (defensive opt-in)', async () => {
    // Plan E3 Group F: AL.Runner emits absolute paths regardless of cwd
    // (Path.GetFullPath, see Pipeline.cs upstream). The cwd option is no
    // longer needed for path correctness. We retain it as a defensive
    // opt-in for future diagnostic scenarios — this test pins that the
    // option still threads through to the spawner unchanged when set.
    const sp = new ServerProcess({
      runnerPath: 'al-runner',
      spawner,
      cwd: 'C:/some/explicit/cwd',
    });
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
    await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
    assert.strictEqual(spawner.callCount, 1, 'spawner called once');
    assert.deepStrictEqual(
      spawner.firstCall.args[2],
      { cwd: 'C:/some/explicit/cwd' },
      'spawner must receive { cwd } as third argument when caller opts into it',
    );
    await sp.dispose();
  });

  test('omits cwd option when none provided (preserves legacy spawn signature)', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
    await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
    const callArgs = spawner.firstCall.args;
    assert.strictEqual(
      callArgs[2],
      undefined,
      'when cwd is not provided, the third spawner arg must be undefined (don\'t coerce to {})',
    );
    await sp.dispose();
  });

  test('ready handshake awaits {"ready":true} before sending', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
    const sendPromise = sp.send({ command: 'runtests', sourcePaths: ['/x'] });
    setTimeout(() => proc.pushStdout('{"ready":true}'), 30);
    setTimeout(() => proc.pushStdout('{"tests":[],"exitCode":0}'), 50);
    const res: any = await sendPromise;
    assert.strictEqual(res.exitCode, 0);
    assert.ok(proc.emitted.length === 1, 'one request written');
    await sp.dispose();
  });

  test('sequential FIFO ordering', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout('{"id":1}'));
    setImmediate(() => proc.pushStdout('{"id":2}'));
    const a = sp.send({ command: 'runtests', sourcePaths: ['/a'] });
    const b = sp.send({ command: 'runtests', sourcePaths: ['/b'] });
    const [resA, resB]: any = await Promise.all([a, b]);
    assert.strictEqual(resA.id, 1);
    assert.strictEqual(resB.id, 2);
    await sp.dispose();
  });

  test('respawns once on process exit and retries in-flight request', async () => {
    let firstSpawn = true;
    const stubSpawner = sinon.stub().callsFake(() => {
      if (firstSpawn) {
        firstSpawn = false;
        return proc as any;
      }
      const proc2 = new MockChildProcess();
      setImmediate(() => proc2.pushStdout('{"ready":true}'));
      setImmediate(() => proc2.pushStdout('{"tests":[],"exitCode":0,"retried":true}'));
      return proc2 as any;
    });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner: stubSpawner });
    setImmediate(() => proc.emit('exit', 1, null));
    const result: any = await sp.send({ command: 'runtests', sourcePaths: ['/x'] });
    assert.strictEqual(result.retried, true);
    assert.strictEqual(stubSpawner.callCount, 2);
    await sp.dispose();
  });

  test('surfaces error if respawn also fails', async () => {
    const failingSpawner = sinon.stub()
      .onFirstCall().returns(proc as any)
      .onSecondCall().throws(new Error('spawn ENOENT'));
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner: failingSpawner });
    setImmediate(() => proc.emit('exit', 1, null));
    await assert.rejects(
      sp.send({ command: 'runtests', sourcePaths: ['/x'] }),
      /spawn ENOENT/,
    );
    await sp.dispose();
  });

  test('graceful shutdown sends shutdown command and waits for exit', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout('{"tests":[],"exitCode":0}'));
    await sp.send({ command: 'runtests', sourcePaths: ['/x'] });

    setTimeout(() => proc.emit('exit', 0, null), 50);
    await sp.dispose();
    const lastReq = proc.emitted[proc.emitted.length - 1].trim();
    assert.ok(lastReq.includes('"command":"shutdown"'), `expected shutdown message, got: ${lastReq}`);
  });
});
