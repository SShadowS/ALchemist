// Drive AL.Runner --server with a runtests command for ALProject4 and dump
// every NDJSON line we receive. Mirrors what the extension's serverProcess
// transport does, so we can compare against what the extension is actually
// receiving at runtime.
import { spawn } from 'child_process';
import * as readline from 'readline';

const BINARY = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;
const APP = String.raw`C:\Users\SShadowS\Documents\AL\ALProject4`;

const child = spawn(BINARY, ['--server'], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stderr.on('data', d => process.stderr.write(`[stderr] ${d}`));

const rl = readline.createInterface({ input: child.stdout, terminal: false });
let lineNum = 0;
rl.on('line', line => {
  lineNum++;
  console.log(`[${lineNum}] ${line}`);
  // Try to parse + flag captures-of-interest
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'test') {
      const caps = obj.capturedValues ?? [];
      console.log(`     test=${obj.name} status=${obj.status} alSourceFile=${obj.alSourceFile ?? '<none>'} captures=${caps.length}`);
      for (const cv of caps) {
        console.log(`       cap: ${cv.variableName}=${cv.value} stmt=${cv.statementId} obj=${cv.objectName} alSourceFile=${cv.alSourceFile ?? '<none>'}`);
      }
    }
    if (obj.type === 'summary') {
      console.log(`     summary protocolVersion=${obj.protocolVersion} passed=${obj.passed} failed=${obj.failed} coverage.files=${obj.coverage?.length ?? 0}`);
      if (obj.coverage) {
        for (const fc of obj.coverage) {
          console.log(`       cov: ${fc.file} hit=${fc.hitStatements}/${fc.totalStatements}`);
        }
      }
    }
  } catch { /* ignore */ }
});

child.on('exit', code => {
  console.log(`\n[child exited with code ${code}, ${lineNum} lines received]`);
  process.exit(code ?? 0);
});

// Wait for ready, then send runtests
function send(obj: object) {
  const line = JSON.stringify(obj);
  console.log(`>>> ${line}`);
  child.stdin.write(line + '\n');
}

setTimeout(() => {
  send({
    command: 'runtests',
    sourcePaths: [
      `${APP}\\CU1.al`,
      `${APP}\\TextCU.al`,
    ],
    packagePaths: [`${APP}\\.alpackages`],
    captureValues: true,
    coverage: true,
  });

  // Give it 15s to finish, then shutdown
  setTimeout(() => {
    send({ command: 'shutdown' });
  }, 15000);
}, 500);
