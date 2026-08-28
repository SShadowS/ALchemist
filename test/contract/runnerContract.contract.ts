import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Contract test for AL.Runner's `--server` `execute` command — specifically
 * what shapes of `sourcePaths` it accepts and rejects.
 *
 * This pins the runner's own contract independent of ALchemist's client code
 * (src/execution/serverProcess.ts, serverExecutionEngine.ts), so an
 * *upstream* AL.Runner change that narrows or widens what `execute` accepts
 * breaks a test here instead of a user's scratch run. See test/parity/ for
 * the sibling suite that pins UI-relevant equivalence between protocol
 * versions; this suite is narrower and lower-level — it never touches
 * ALchemist or vscode at all, only the installed binary's stdin/stdout wire
 * format.
 *
 * Targets the **installed** runner resolved from PATH (`al-runner`), not a
 * hard-coded fork build — that's the binary real users run, and the one
 * whose 2.7.0 contract change (bundle directories, not files) broke
 * production scratch runs. Skips cleanly (exit 0) when nothing is on PATH,
 * so CI without a local AL.Runner install is unaffected.
 */

const PARITY_APP_DIR = path.resolve(__dirname, '../../../test/fixtures/parity-loop-fixture');

const SCRATCH_CODEUNIT =
  'codeunit 50000 Scratch\n' +
  '{\n' +
  '    trigger OnRun()\n' +
  "    begin\n" +
  "        Message('x');\n" +
  '    end;\n' +
  '}\n';

/**
 * Resolve `al-runner` from PATH the same way a user's shell would
 * (`where`/`which`), independent of ALchemist's own AlRunnerManager —
 * this suite must pin the CLI's contract, not our resolution logic.
 * Returns the absolute path to the executable, or undefined if not found.
 */
function resolveOnPath(): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = cp.execSync(`${cmd} al-runner`, { encoding: 'utf8' });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Minimal NDJSON client for AL.Runner's `--server` mode: one request in
 * flight at a time, resolving with the first complete JSON line emitted
 * after the request is written. `execute` never streams intermediate
 * events (see serverProcess.ts's "executeScratch does not pass onEvent"
 * contract) — one line in, one line out.
 *
 * Deliberately independent of the production ServerProcess class: this
 * suite exists to verify the runner's own behavior, not ours.
 */
class ContractServerClient {
  private readonly proc: cp.ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly lineQueue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];

  constructor(runnerPath: string, cwd: string) {
    this.proc = cp.spawn(runnerPath, ['--server'], { cwd });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const waiter = this.waiters.shift();
      if (waiter) { waiter(line); } else { this.lineQueue.push(line); }
    }
  }

  private nextLine(timeoutMs: number): Promise<string> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for a server line`)), timeoutMs);
      this.waiters.push((line) => { clearTimeout(timer); resolve(line); });
    });
  }

  async waitForReady(timeoutMs: number): Promise<void> {
    const line = await this.nextLine(timeoutMs);
    const obj: unknown = JSON.parse(line);
    if (!obj || typeof obj !== 'object' || (obj as { ready?: unknown }).ready !== true) {
      throw new Error(`expected {"ready":true} as the server's first line, got: ${line}`);
    }
  }

  /** Send one `execute` request; returns the parsed terminal response. */
  async send(payload: object, timeoutMs = 20_000): Promise<any> {
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    const line = await this.nextLine(timeoutMs);
    return JSON.parse(line);
  }

  async shutdown(): Promise<void> {
    try {
      this.proc.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
    } catch {
      // best-effort — process may already be gone
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

const RUNNER = resolveOnPath();

suite('AL.Runner contract — --server execute / sourcePaths (installed runner, resolved from PATH)', function () {
  this.timeout(120_000);

  if (!RUNNER) {
    test.skip('al-runner not found on PATH; skipping contract suite', () => {});
    return;
  }

  let tmpRoot: string;
  let bundleDir: string;
  let emptyDir: string;
  let spacedDir: string;
  let client: ContractServerClient;

  suiteSetup(async function () {
    this.timeout(30_000);

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemist-contract-'));

    bundleDir = path.join(tmpRoot, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'Scratch.al'), SCRATCH_CODEUNIT);

    emptyDir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    spacedDir = path.join(tmpRoot, 'has space in it');
    fs.mkdirSync(spacedDir, { recursive: true });
    fs.writeFileSync(path.join(spacedDir, 'Scratch.al'), SCRATCH_CODEUNIT);

    assert.ok(
      fs.existsSync(PARITY_APP_DIR),
      `parity-loop-fixture must exist at ${PARITY_APP_DIR} for the two-entry sourcePaths case`,
    );

    // One process for the whole suite. Server startup (BC engine init)
    // dominates the runtime — cheap with warm artifacts, far slower on a
    // cold cache — so spawning per-test would make this suite unusable.
    // cwd is the tmp root so the "relative path" case below resolves
    // against a known directory.
    client = new ContractServerClient(RUNNER, tmpRoot);
    await client.waitForReady(20_000);
  });

  suiteTeardown(async function () {
    this.timeout(10_000);
    if (client) { await client.shutdown(); }
    if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  });

  // --- ACCEPTED shapes (must all be an existing directory) ---

  test('absolute path, native backslashes → exitCode 0', async () => {
    const res = await client.send({ command: 'execute', sourcePaths: [bundleDir], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('absolute path, forward slashes → exitCode 0', async () => {
    const forwardSlashed = bundleDir.replace(/\\/g, '/');
    const res = await client.send({ command: 'execute', sourcePaths: [forwardSlashed], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('trailing path separator → exitCode 0', async () => {
    const res = await client.send({ command: 'execute', sourcePaths: [bundleDir + path.sep], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('unnormalised dot-segments (..) → exitCode 0', async () => {
    // Built via string concatenation, NOT path.join/path.resolve — both
    // normalize away ".." segments, which would defeat the point of this
    // case (the runner must tolerate an unnormalized path itself).
    const dotted = `${tmpRoot}${path.sep}bundle${path.sep}..${path.sep}bundle`;
    assert.ok(dotted.includes('..'), 'test bug: path got normalized before reaching the runner');
    const res = await client.send({ command: 'execute', sourcePaths: [dotted], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('lowercased drive letter → exitCode 0', async function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    const lowered = bundleDir.charAt(0).toLowerCase() + bundleDir.slice(1);
    const res = await client.send({ command: 'execute', sourcePaths: [lowered], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('path containing spaces → exitCode 0', async () => {
    const res = await client.send({ command: 'execute', sourcePaths: [spacedDir], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test("relative path resolves against the runner's own cwd → exitCode 0", async () => {
    // The shared server process was spawned with cwd = tmpRoot, so a bare
    // "bundle" (no path separators) must resolve to tmpRoot/bundle.
    const res = await client.send({ command: 'execute', sourcePaths: ['bundle'], captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  test('existing but empty directory (no .al files) → accepted: exitCode 1, zero tests', async () => {
    const res = await client.send({ command: 'execute', sourcePaths: [emptyDir], captureValues: true });
    assert.strictEqual(res.error, undefined, 'an empty directory is ACCEPTED — must not surface as a bundle-directory error');
    assert.strictEqual(res.exitCode, 1, JSON.stringify(res));
    assert.deepStrictEqual(res.tests, [], JSON.stringify(res));
  });

  test('two entries [appDir, scratchBundleDir] → exitCode 0, both codeunits run', async () => {
    const res = await client.send({
      command: 'execute',
      sourcePaths: [PARITY_APP_DIR, bundleDir],
      captureValues: true,
    });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
    assert.strictEqual(
      res.tests?.length,
      2,
      `expected one test entry per sourcePaths directory (one codeunit each); got ${JSON.stringify(res.tests)}`,
    );
  });

  test('`code` alone (inline source, no sourcePaths) → exitCode 0', async () => {
    const res = await client.send({ command: 'execute', code: SCRATCH_CODEUNIT, captureValues: true });
    assert.strictEqual(res.exitCode, 0, JSON.stringify(res));
  });

  // --- REJECTED shapes ---

  test('REGRESSION GUARD: a .al FILE path is rejected with "bundle directory not found" — the exact production bug', async () => {
    // Plan E5 shipped precisely because scratch mode passed a .al FILE path
    // here instead of its containing directory. If AL.Runner ever again
    // accepts a file path (or changes the error shape), this must fail
    // loudly rather than the regression only surfacing as a silent
    // production failure again.
    const filePath = path.join(bundleDir, 'Scratch.al');
    const res = await client.send({ command: 'execute', sourcePaths: [filePath], captureValues: true });
    assert.strictEqual(typeof res.error, 'string', `expected an error response, got: ${JSON.stringify(res)}`);
    assert.match(res.error, /bundle directory not found/);
    assert.ok(res.error.includes(filePath), 'error message must name the offending path');
  });

  test('a nonexistent directory is rejected with "bundle directory not found"', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist-xyz');
    const res = await client.send({ command: 'execute', sourcePaths: [missing], captureValues: true });
    assert.strictEqual(typeof res.error, 'string', `expected an error response, got: ${JSON.stringify(res)}`);
    assert.match(res.error, /bundle directory not found/);
  });

  test("`code` and `sourcePaths` together are rejected as mutually exclusive", async () => {
    const res = await client.send({
      command: 'execute',
      code: SCRATCH_CODEUNIT,
      sourcePaths: [bundleDir],
      captureValues: true,
    });
    assert.strictEqual(typeof res.error, 'string', `expected an error response, got: ${JSON.stringify(res)}`);
    assert.match(res.error, /mutually exclusive/);
  });
});
