import * as vscode from 'vscode';
import * as path from 'path';

/** Debug type id — must match `contributes.debuggers[].type` in package.json. */
export const ALCHEMIST_DEBUG_TYPE = 'alchemist';

/** The subset of AlRunnerManager this factory needs, so tests can supply a stub. */
interface RunnerResolver {
  ensureInstalled(): Promise<string>;
}

/**
 * Launch-configuration shape this module resolves paths from. `bundleDir` is
 * the single-directory form upstream's own docs still show (`al-runner --dap
 * 4711 ./src ./test` takes any number of source paths, of which a bundle
 * directory is just the one-entry case); `sourcePaths` is the explicit list
 * for the multi-app case ALchemist already handles for ordinary test runs
 * (see `WorkspaceModel.getDependencies` / `sourcePaths` in testController.ts
 * and extension.ts) — a declared dependency does not auto-resolve from a
 * sibling folder, so AL.Runner must be given the test app plus its
 * transitive dependency source paths explicitly.
 */
interface DebugLaunchConfig {
  bundleDir?: string;
  program?: string;
  sourcePaths?: string[];
}

/**
 * Single directory to fall back to when the launch configuration gives no
 * explicit `sourcePaths` list: `bundleDir` if set, else the directory
 * holding `program`, else the workspace folder.
 */
function resolveSingleBundleDir(config: DebugLaunchConfig, workspaceFolder: string | undefined): string {
  if (config.bundleDir) {
    return path.isAbsolute(config.bundleDir)
      ? config.bundleDir
      : path.resolve(workspaceFolder ?? '', config.bundleDir);
  }
  if (config.program) return path.dirname(config.program);
  if (workspaceFolder) return workspaceFolder;
  throw new Error('ALchemist debug: set `bundleDir` in the launch configuration — no workspace folder to fall back to.');
}

/**
 * Source paths to hand AL.Runner after `--dap stdio`. An explicit,
 * non-empty `sourcePaths` list wins and is resolved entry-by-entry;
 * otherwise this falls back to a single-entry list built from `bundleDir`,
 * `program`, or the workspace folder (see `resolveSingleBundleDir`).
 *
 * This only makes the seam accept a list — it does not resolve a test app's
 * dependencies itself. Callers that need the multi-app case (Task 8 and
 * beyond) pass `sourcePaths` explicitly, the same way `runTests` and
 * `executeScratch` already do for ordinary (non-debug) runs.
 */
export function resolveSourcePaths(config: DebugLaunchConfig, workspaceFolder: string | undefined): string[] {
  if (config.sourcePaths && config.sourcePaths.length > 0) {
    return config.sourcePaths.map(p =>
      path.isAbsolute(p) ? p : path.resolve(workspaceFolder ?? '', p),
    );
  }
  return [resolveSingleBundleDir(config, workspaceFolder)];
}

/**
 * Launches `al-runner --dap stdio <path> [<path> ...]` and speaks DAP over
 * its stdio pipes.
 *
 * Two tokens, `--dap` and `stdio`: AL.Runner 2.7.0 takes the transport as a
 * separate argument. `--dap [PORT]` still selects TCP, which ALchemist does
 * not use — TCP would mean spawning the process ourselves, detecting when it
 * is listening, and handling port collisions between sessions.
 *
 * In stdio mode the runner's stdout carries only the DAP wire format; all of
 * its logging goes to stderr.
 */
export class AlchemistDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly runnerManager: RunnerResolver) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor> {
    let runnerPath: string;
    try {
      runnerPath = await this.runnerManager.ensureInstalled();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`ALchemist debug: AL.Runner is required to debug AL tests — ${detail}`);
    }

    const sourcePaths = resolveSourcePaths(
      session.configuration as DebugLaunchConfig,
      session.workspaceFolder?.uri.fsPath,
    );

    return new vscode.DebugAdapterExecutable(runnerPath, ['--dap', 'stdio', ...sourcePaths]);
  }
}
