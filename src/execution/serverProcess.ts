import * as cp from 'child_process';

export type ServerSpawner = (runnerPath: string, args: string[]) => cp.ChildProcessWithoutNullStreams;

export interface ServerProcessOptions {
  runnerPath: string;
  args?: string[];
  spawner?: ServerSpawner;
  shutdownTimeoutMs?: number;
}

interface PendingRequest {
  payload: object;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  retried: boolean;
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

  async send(payload: object): Promise<any> {
    if (this.disposed) { throw new Error('ServerProcess disposed'); }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject, retried: false });
      this.pump();
    });
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
    // spawner may throw (e.g. spawn ENOENT)
    const child = spawner(this.opts.runnerPath, args);
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
        const req = this.inFlight;
        this.inFlight = undefined;
        req.resolve(obj);
        // Dispatch the next queued request.
        this.pump();
      }
    }
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

    if (wasInFlight && !wasInFlight.retried) {
      // In-flight request: re-queue with retried flag and respawn.
      wasInFlight.retried = true;
      this.queue.unshift(wasInFlight);
      this.inFlight = undefined;
      this.pump();
    } else if (wasInFlight) {
      // Already retried once — give up.
      this.inFlight = undefined;
      wasInFlight.reject(new Error('AL.Runner --server crashed and respawn already attempted'));
    }
    // If no in-flight: items in queue will be handled by dispatchWhenReady detecting proc===undefined
    // and calling pump() → spawnProcess() again.
  }

  private handleProcError(err: Error): void {
    if (this.inFlight && !this.inFlight.retried) {
      const req = this.inFlight;
      req.retried = true;
      this.inFlight = undefined;
      this.queue.unshift(req);
      this.proc = undefined;
      this.readyPromise = undefined;
      this.ready = false;
      this.pump();
    } else if (this.inFlight) {
      const req = this.inFlight;
      this.inFlight = undefined;
      req.reject(err);
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
