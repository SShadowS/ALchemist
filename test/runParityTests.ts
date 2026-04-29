import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

/**
 * Parity-test entry. Drives a single AL fixture through both producers
 * (v1 `--output-json` and v2 `--server`) and asserts UI-relevant
 * equivalence. This is the test that would have caught the v0.3.0 →
 * v0.5.0 silent feature drop where the v2 wire format dropped iterations.
 *
 * Skips at the suite level when the fork binary isn't present (the suite's
 * `test.skip` guard handles missing fixtures too). CI-friendly.
 */
const FORK_BINARY = String.raw`U:\Git\AL.Runner-protocol-v2\AlRunner\bin\Release\net9.0\AlRunner.exe`;

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './parity/index');

    if (!fs.existsSync(FORK_BINARY)) {
      console.warn(`Parity tests require fork binary at ${FORK_BINARY}; exiting cleanly.`);
      process.exit(0);
    }

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { ALCHEMIST_TEST_HOOKS: '1' },
    });
  } catch (err) {
    console.error('Parity tests failed:', err);
    process.exit(1);
  }
}

main();
