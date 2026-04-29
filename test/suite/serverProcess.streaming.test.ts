import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter, Readable, Writable } from 'stream';
import * as sinon from 'sinon';
import { ServerProcess, ServerSpawner } from '../../src/execution/serverProcess';

const FIX = path.resolve(__dirname, '../../../test/fixtures');

// ---------------------------------------------------------------------------
// MockChildProcess — mirrors the pattern in serverProcess.test.ts exactly.
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

suite('ServerProcess — streaming + cancel + v1 fallback', () => {
  let proc: MockChildProcess;
  let spawner: sinon.SinonStub;

  setup(() => {
    proc = new MockChildProcess();
    spawner = sinon.stub().returns(proc as any);
  });

  teardown(() => sinon.restore());

  // -------------------------------------------------------------------------
  // Test 1: Streams test events, fires onEvent, resolves on summary
  // -------------------------------------------------------------------------
  test('streams test events, fires onEvent per-event, resolves on summary', async () => {
    const samplePath = path.join(FIX, 'protocol-v2-samples', 'runtests-coverage-success.ndjson');
    const lines = fs.readFileSync(samplePath, 'utf8').split('\n').filter(l => l.length > 0);
    // lines[0] = {"ready":true}
    // lines[1..3] = 3 test events
    // lines[4] = summary (protocolVersion: 2)
    // lines[5] = {"status":"shutting down"} — drop
    const scriptedLines = [lines[0], ...lines.slice(1, 5)];

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    // Emit the ready line on next tick, then the test/summary lines.
    // Two separate setImmediate calls: the first delivers {"ready":true} so
    // dispatchWhenReady can run (and set inFlight) before the response lines arrive.
    setImmediate(() => proc.pushStdout(scriptedLines[0]));
    setImmediate(() => {
      for (const line of scriptedLines.slice(1)) {
        proc.pushStdout(line);
      }
    });

    const onEventCalls: any[] = [];
    const result: any = await sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    assert.strictEqual(onEventCalls.length, 3, 'expected 3 onEvent calls (one per test event)');
    for (const evt of onEventCalls) {
      assert.strictEqual(evt.type, 'test', 'each onEvent should be a test line');
    }
    assert.strictEqual(result.type, 'summary', 'resolved value should be the summary object');
    assert.strictEqual(result.protocolVersion, 2, 'summary must carry protocolVersion: 2');
    assert.strictEqual(result.passed, 2, 'passed: 2');
    assert.strictEqual(result.failed, 1, 'failed: 1');

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 2: v1 fallback — single-line response with no type field
  // -------------------------------------------------------------------------
  test('v1 fallback: single-line response with no type field resolves directly', async () => {
    const v1Response = JSON.stringify({
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      tests: [{ name: 'X', status: 'pass', durationMs: 5 }]
    });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(v1Response));

    const onEventCalls: any[] = [];
    const result: any = await sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    assert.strictEqual(onEventCalls.length, 0, 'no onEvent calls for v1 response');
    assert.strictEqual(result.passed, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.protocolVersion, undefined, 'v1 response has no protocolVersion');

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3: cancel writes {"command":"cancel"} immediately without waiting
  // -------------------------------------------------------------------------
  test('cancel writes cancel command without waiting for send to resolve', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    // We need the process to be ready before sending, otherwise cancel has no proc.
    // Emit ready on next tick so send can queue — but never emit a response,
    // so the send never resolves on its own.
    setImmediate(() => proc.pushStdout('{"ready":true}'));

    // Start a send but do NOT await it.
    const sendPromise = sp.send({ command: 'runtests' });

    // Wait for the ready handshake so the send is truly in-flight.
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

    // cancel() must resolve immediately even though send is unresolved.
    await sp.cancel();

    // Verify the cancel JSON was written to stdin.
    const cancelWritten = proc.emitted.some(msg => {
      try { return JSON.parse(msg.trim()).command === 'cancel'; } catch { return false; }
    });
    assert.ok(cancelWritten, 'cancel command must be written to stdin');

    // dispose() should reject the in-flight send with a "disposed" error.
    await sp.dispose();

    await assert.rejects(sendPromise, /disposed/i);
  });

  // -------------------------------------------------------------------------
  // Test 4: malformed JSON line is skipped; real summary still resolves
  // -------------------------------------------------------------------------
  test('malformed JSON line is skipped silently; summary still resolves', async () => {
    const testEvent = JSON.stringify({ type: 'test', name: 'MyTest', status: 'pass', durationMs: 10 });
    const summary = JSON.stringify({ type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2 });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => {
      proc.pushStdout(testEvent);
      proc.pushStdout('this is not valid json {{{');
      proc.pushStdout(summary);
    });

    const onEventCalls: any[] = [];
    const result: any = await sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    assert.strictEqual(onEventCalls.length, 1, 'one onEvent call for the valid test event');
    assert.strictEqual(result.type, 'summary');
    assert.strictEqual(result.protocolVersion, 2);

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 5: cancel ack line (single ack) resolves send
  // -------------------------------------------------------------------------
  test('cancel ack response (single ack line) resolves send', async () => {
    const ack = JSON.stringify({ type: 'ack', command: 'cancel', noop: true });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(ack));

    const result: any = await sp.send({ command: 'cancel' });

    assert.strictEqual(result.type, 'ack');
    assert.strictEqual(result.command, 'cancel');
    assert.strictEqual(result.noop, true);

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 6: onEvent that throws causes send() to reject
  // -------------------------------------------------------------------------
  test('onEvent that throws causes send to reject', async () => {
    const testEvent = JSON.stringify({ type: 'test', name: 'X', status: 'pass', durationMs: 5 });
    const summary = JSON.stringify({ type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2 });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => {
      proc.pushStdout(testEvent);
      // The summary is pushed too, but send() should already have rejected
      // by the time we get here. Pushing it verifies that a stray late line
      // does not crash anything.
      proc.pushStdout(summary);
    });

    const sendPromise = sp.send({ command: 'runtests' }, () => {
      throw new Error('boom from onEvent');
    });

    await assert.rejects(sendPromise, /boom from onEvent/);

    // Process should still be alive (no crash), and dispose should work cleanly.
    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 7: Multiple sends FIFO during streaming
  // -------------------------------------------------------------------------
  test('multiple sends FIFO — second resolves after first summary', async () => {
    const summaryA = JSON.stringify({ type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2, tag: 'A' });
    const summaryB = JSON.stringify({ type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2, tag: 'B' });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(summaryA));
    // Push summaryB on a later tick so the dispatcher has time to write
    // request B's payload to stdin before its response arrives.
    setTimeout(() => proc.pushStdout(summaryB), 20);

    const a = sp.send({ command: 'runtests', label: 'A' });
    const b = sp.send({ command: 'runtests', label: 'B' });

    const [resA, resB]: any = await Promise.all([a, b]);

    assert.strictEqual(resA.tag, 'A', 'first send resolves with summaryA');
    assert.strictEqual(resB.tag, 'B', 'second send resolves with summaryB');

    // Verify both payloads were written to stdin in order.
    assert.strictEqual(proc.emitted.length, 2, 'two payloads written in total');
    assert.ok(proc.emitted[0].includes('"label":"A"'), 'first payload is A');
    assert.ok(proc.emitted[1].includes('"label":"B"'), 'second payload is B');

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 8: cancel() when idle (no proc) is safe — no error, no spawn
  // -------------------------------------------------------------------------
  test('cancel when idle is safe (no proc spawned, no error)', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    // No send issued — proc has never been spawned.
    await sp.cancel();

    assert.strictEqual(spawner.callCount, 0, 'cancel must not lazily spawn the runner');
    assert.strictEqual(proc.emitted.length, 0, 'nothing should have been written');

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 9: cancel() called twice rapidly — both resolve, no error
  // -------------------------------------------------------------------------
  test('cancel called twice rapidly — both resolve without error', async () => {
    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    // Need a proc so cancel actually attempts the write path.
    setImmediate(() => proc.pushStdout('{"ready":true}'));
    // Issue a never-completing send to force spawn + ready.
    const pending = sp.send({ command: 'runtests' });
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

    // Both cancels must resolve cleanly.
    await Promise.all([sp.cancel(), sp.cancel()]);

    // Two cancel JSON writes should be present (one per cancel call).
    const cancelCount = proc.emitted.filter(msg => {
      try { return JSON.parse(msg.trim()).command === 'cancel'; } catch { return false; }
    }).length;
    assert.strictEqual(cancelCount, 2, 'two cancel commands should have been written');

    await sp.dispose();
    await assert.rejects(pending, /disposed/i);
  });

  // -------------------------------------------------------------------------
  // Test 10: v2 stream with zero test events — summary directly resolves send
  // -------------------------------------------------------------------------
  test('v2 stream with zero test events resolves on summary; onEvent never called', async () => {
    const summary = JSON.stringify({ type: 'summary', exitCode: 0, passed: 0, failed: 0, errors: 0, total: 0, protocolVersion: 2 });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => proc.pushStdout(summary));

    const onEventCalls: any[] = [];
    const result: any = await sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    assert.strictEqual(onEventCalls.length, 0, 'onEvent must not fire when there are no test/progress lines');
    assert.strictEqual(result.type, 'summary');
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.protocolVersion, 2);

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 11: v2 stream with progress event — both progress + test fire onEvent
  // -------------------------------------------------------------------------
  test('v2 stream with progress event fires onEvent for progress and test', async () => {
    const progress = JSON.stringify({ type: 'progress', completed: 1, total: 2 });
    const testEvent = JSON.stringify({ type: 'test', name: 'A', status: 'pass', durationMs: 7 });
    const summary = JSON.stringify({ type: 'summary', exitCode: 0, passed: 1, failed: 0, errors: 0, total: 1, protocolVersion: 2 });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => {
      proc.pushStdout(progress);
      proc.pushStdout(testEvent);
      proc.pushStdout(summary);
    });

    const onEventCalls: any[] = [];
    const result: any = await sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    assert.strictEqual(onEventCalls.length, 2, 'two non-terminal events: progress + test');
    assert.strictEqual(onEventCalls[0].type, 'progress');
    assert.strictEqual(onEventCalls[0].completed, 1);
    assert.strictEqual(onEventCalls[0].total, 2);
    assert.strictEqual(onEventCalls[1].type, 'test');
    assert.strictEqual(onEventCalls[1].name, 'A');
    assert.strictEqual(result.type, 'summary');

    await sp.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 12: Crash mid-stream rejects without retry (no second spawn)
  // -------------------------------------------------------------------------
  test('crash mid-stream rejects with "crashed mid-stream"; no retry', async () => {
    const testEvent = JSON.stringify({ type: 'test', name: 'A', status: 'pass', durationMs: 7 });

    const sp = new ServerProcess({ runnerPath: 'al-runner', spawner });

    setImmediate(() => proc.pushStdout('{"ready":true}'));
    setImmediate(() => {
      proc.pushStdout(testEvent);
      // Now simulate the runner crashing mid-stream BEFORE summary arrives.
      proc.emit('exit', 1, null);
    });

    const onEventCalls: any[] = [];
    const sendPromise = sp.send({ command: 'runtests' }, (evt) => {
      onEventCalls.push(evt);
    });

    await assert.rejects(sendPromise, /crashed mid-stream/i);

    // The consumer must have observed exactly the one test event before the crash.
    assert.strictEqual(onEventCalls.length, 1, 'one onEvent observed before crash');
    assert.strictEqual(onEventCalls[0].type, 'test');

    // Critically: no respawn should have happened — exactly one spawn.
    assert.strictEqual(spawner.callCount, 1, 'must NOT respawn after a streamed mid-stream crash');

    await sp.dispose();
  });
});
