import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

/**
 * Smoke-test entry point. Runs the runtime smoke suite (full extension
 * activation against the user's local ALProject4 + AL.Runner fork build) in
 * its own VS Code process. Kept separate from `runIntegrationTests.ts` because:
 *
 *  - The smoke test activates the extension, which registers a global
 *    `vscode.tests.createTestController('alchemist', ...)`. The integration
 *    suite constructs its own controllers with the same id; running both
 *    sets in the same process triggers duplicate-id failures.
 *  - The smoke test uses `launchArgs: [ALProject4]` so the workspace folder
 *    is present at activate time (workspaceModel.scan picks up the project).
 *  - The smoke test depends on absolute paths to the user's machine; CI
 *    skips it via the existsSync guard inside the suite.
 */
const ALPROJECT4 = String.raw`C:\Users\SShadowS\Documents\AL\ALProject4`;

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './smoke/index');

    // Note: we deliberately don't pass `launchArgs: [ALPROJECT4]` here. With
    // launchArgs + extensionDevelopmentPath, test-electron spawns two
    // extension hosts (one for the test extension, one for the workspace)
    // and the test ends up reading state from the wrong process. Instead,
    // we drive the engine directly via `TestHooks.runTestsAndApply` —
    // sourcePaths is plumbed through to the AL.Runner --server protocol
    // without needing a workspace-folder mount.
    void fs;

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { ALCHEMIST_TEST_HOOKS: '1' },
    });
  } catch (err) {
    console.error('Smoke tests failed:', err);
    process.exit(1);
  }
}

main();
