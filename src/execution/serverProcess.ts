import * as cp from 'child_process';
import { isProtocolV2Line, ProtocolLine } from './protocolV2Types';

export type ServerSpawner = (
  runnerPath: string,
  args: string[],
  options?: { cwd?: string },
) => cp.ChildProcessWithoutNullStreams;

export interface ServerProcessOptions {
  runnerPath: string;
  args?: string[];
  spawner?: ServerSpawner;
  shutdownTimeoutMs?: number;
  /**
   * Working directory for the spawned AL.Runner process.
   *
   * Defensive opt-in for diagnostic scenarios. AL.Runner v2 emits source
   * paths via `Path.GetFullPath(file).Replace('\\','/')` (absolute,
   * fwd-slash) regardless of cwd, so the wire format is stable whatever
   * the spawner's cwd. The v0.5.4 cwd pin that compensated for the older
   * `Path.GetRelativePath(cwd, file)` emission is no longer needed (Plan
   * E3 Group A landed the upstream fix). Production callers leave this
   * unset; the option remains so tests and future debug paths can inject
   * a custom cwd without monkey-patching.
   */
  cwd?: string;
}

interface PendingRequest {
  payload: object;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  retried: boolean;
  onEvent?: (event: ProtocolLine) => void;
  /** True once at least one onEvent has fired for this request. */
  streamed: boolean;
}

export class ServerProcess {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private ready = false;
  private buffer = '';
  private queue: PendingRequest[] = [];
  private inFlight: PendingRequest | undefined;
  private disposed = false;
  /** Resolves when the process emits {"ready":true} OR when the process exits (so waiters unblock). */
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  /** True while dispatchWhenReady is awaiting readyPromise (prevents duplicate dispatchers). */
  private dispatching = false;

  constructor(private readonly opts: ServerProcessOptions) {}

  /**
   * Send a payload to the AL.Runner --server process.
   *
   * Behavior depends on the server's protocol version (detected per-line via
   * isProtocolV2Line):
   * - v2: zero-or-more `{type:"test"|"progress"}` lines fire `onEvent` (if
   *   provided), then a terminal `{type:"summary"|"ack"}` resolves the promise.
   * - v1 (no `type` field): the first complete JSON line resolves the promise;
   *   `onEvent` is never fired.
   *
   * If the server crashes mid-stream after at least one onEvent has fired,
   * the request is rejected (NOT retried) — consumers should not see partial
   * results followed by a re-stream of the same events.
   *
   * If `onEvent` throws, the in-flight request is rejected with that error.
   */
  async send(payload: object, onEvent?: (event: ProtocolLine) => void): Promise<any> {
    if (this.disposed) { throw new Error('ServerProcess disposed'); }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject, retried: false, onEvent, streamed: false });
      this.pump();
    });
  }

  /**
   * Fire-and-forget cancel. Writes `{"command":"cancel"}\n` to stdin and
   * returns. Does NOT await any response — the cancel ack arrives on the
   * normal stream and is routed by `routeLine`: if a `cancel` send is in
   * flight, that call resolves; otherwise the ack is silently dropped.
   *
   * Safe to call when no request is in flight or when `proc` exists but
   * `ready === false` (the OS pipe buffers the write until the dispatch
   * loop starts processing it).
   */
  async cancel(): Promise<void> {
    if (this.disposed || !this.proc) { return; }
    try {
      this.proc.stdin.write(JSON.stringify({ command: 'cancel' }) + '\n');
    } catch {
      // ignore — best-effort fire-and-forget
    }
  }

  isHealthy(): boolean {
    return !this.disposed && this.proc !== undefined && this.ready;
  }

  /** Synchronously ensure the process is started, then async-wait for ready. */
  private pump(): void {
    // If a request is actively being waited on (in-flight), don't start another dispatch loop.
    if (this.inFlight) { return; }
    // If a dispatch coroutine is already waiting for ready, don't start another.
    if (this.dispatching) { return; }

    // Spawn synchronously if not already running.
    if (!this.proc) {
      try {
        this.spawnProcess();
      } catch (err: any) {
        const head = this.queue.shift();
        if (head) { head.reject(err); }
        return;
      }
    }

    // Wait for ready, then dispatch.
    this.dispatching = true;
    void this.dispatchWhenReady();
  }

  private spawnProcess(): void {
    const args = this.opts.args ?? ['--server'];
    const spawner: ServerSpawner = this.opts.spawner ?? (cp.spawn as any);
    const spawnOpts = this.opts.cwd ? { cwd: this.opts.cwd } : undefined;
    // spawner may throw (e.g. spawn ENOENT)
    const child = spawner(this.opts.runnerPath, args, spawnOpts);
    this.proc = child;
    this.ready = false;
    this.buffer = '';
    this.readyPromise = new Promise<void>((res) => {
      this.readyResolve = res;
    });
    // Attach listeners synchronously so they're in place before any setImmediate/setTimeout fires.
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.on('exit', (code) => this.handleExit(code));
    child.on('error', (err) => this.handleProcError(err));
  }

  private async dispatchWhenReady(): Promise<void> {
    // Capture the current readyPromise; if it changes (respawn) we detect it.
    const rp = this.readyPromise;
    if (rp) { await rp; }
    this.dispatching = false;

    if (this.disposed) { return; }

    // If proc died while we were waiting (handleExit resolved the promise), restart dispatch.
    if (!this.proc || !this.ready) {
      // Items in queue haven't been sent yet — re-enter pump so a new proc is spawned.
      if (this.queue.length > 0) {
        this.pump();
      }
      return;
    }

    if (this.inFlight) { return; }
    const next = this.queue.shift();
    if (!next) { return; }
    this.inFlight = next;
    const wire = JSON.stringify(next.payload) + '\n';
    try {
      this.proc.stdin.write(wire);
    } catch (err: any) {
      next.reject(err);
      this.inFlight = undefined;
    }
  }

  private handleStdout(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) { continue; }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!this.ready) {
        if (obj && obj.ready === true) {
          this.ready = true;
          this.readyResolve?.();
        }
        continue;
      }
      if (this.inFlight) {
        this.routeLine(obj);
      }
    }
  }

  private routeLine(obj: any): void {
    const req = this.inFlight!;
    if (isProtocolV2Line(obj)) {
      if (obj.type === 'summary' || obj.type === 'ack') {
        // Terminal line — resolve. The summary's `protocolVersion` field
        // (if present) flows downstream as part of the resolved object;
        // ServerExecutionEngine.runTests reads it from there and surfaces
        // it on `ExecutionResult.protocolVersion`. No probe API is kept
        // on ServerProcess — the resolved-payload path is the single
        // source of truth.
        this.inFlight = undefined;
        req.resolve(obj);
        this.pump();
        return;
      }
      // Non-terminal v2 line (test / progress) — fire onEvent, keep buffering.
      // Mark `streamed` BEFORE invoking the callback so handleExit/handleProcError
      // know not to respawn-retry even if onEvent throws.
      try {
        req.streamed = true;
        req.onEvent?.(obj);
      } catch (err: any) {
        // Consumer's onEvent threw — abandon this stream, surface the error.
        this.inFlight = undefined;
        req.reject(err instanceof Error ? err : new Error(String(err)));
        this.pump();
      }
      return;
    }
    // Not a v2 line. v1 fallback: a single-line response. Resolve directly.
    this.inFlight = undefined;
    req.resolve(obj);
    this.pump();
  }

  private handleExit(_code: number | null): void {
    if (this.disposed) { return; }

    const wasInFlight = this.inFlight;
    this.proc = undefined;
    this.ready = false;

    // Resolve the readyPromise so any dispatchWhenReady coroutine waiting on it unblocks.
    this.readyResolve?.();
    this.readyPromise = undefined;
    this.readyResolve = undefined;

    if (wasInFlight && !wasInFlight.retried && !wasInFlight.streamed) {
      // In-flight request that hasn't streamed any events yet: re-queue with
      // retried flag and respawn. Safe because the consumer hasn't observed
      // any partial state, so a second run won't double-fire events.
      wasInFlight.retried = true;
      this.queue.unshift(wasInFlight);
      this.inFlight = undefined;
      this.pump();
    } else if (wasInFlight) {
      // Already retried OR already streamed events — give up rather than
      // double-fire. The consumer has either had its retry chance, or has
      // already seen partial test events that can't be unsent.
      this.inFlight = undefined;
      const reason = wasInFlight.streamed
        ? 'AL.Runner --server crashed mid-stream after partial test events were delivered'
        : 'AL.Runner --server crashed and respawn already attempted';
      wasInFlight.reject(new Error(reason));
    }
    // If no in-flight: items in queue will be handled by dispatchWhenReady detecting proc===undefined
    // and calling pump() → spawnProcess() again.
  }

  private handleProcError(err: Error): void {
    if (this.inFlight && !this.inFlight.retried && !this.inFlight.streamed) {
      const req = this.inFlight;
      req.retried = true;
      this.inFlight = undefined;
      this.queue.unshift(req);
      this.proc = undefined;
      this.readyPromise = undefined;
      this.ready = false;
      this.pump();
    } else if (this.inFlight) {
      // Already retried OR already streamed events — surface the error
      // rather than respawn-and-replay.
      const req = this.inFlight;
      this.inFlight = undefined;
      const surfaced = req.streamed
        ? new Error('AL.Runner --server crashed mid-stream after partial test events were delivered')
        : err;
      req.reject(surfaced);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.proc) {
      try {
        this.proc.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      } catch { /* ignore */ }
      const timeout = this.opts.shutdownTimeoutMs ?? 2000;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, timeout);
        // Register exit listener first, then send SIGTERM so mock's synchronous emit is caught.
        this.proc!.once('exit', () => { clearTimeout(t); resolve(); });
        // Send SIGTERM to encourage the process to exit after receiving the shutdown command.
        // In tests the mock's kill() emits exit synchronously; in production this ensures
        // the server terminates even if it ignores the JSON shutdown command.
        try { this.proc!.kill('SIGTERM'); } catch { /* ignore — process may already be gone */ }
      });
    }
    for (const req of this.queue) {
      req.reject(new Error('ServerProcess disposed before request completed'));
    }
    this.queue.length = 0;
    if (this.inFlight) {
      this.inFlight.reject(new Error('ServerProcess disposed mid-request'));
      this.inFlight = undefined;
    }
  }
}
