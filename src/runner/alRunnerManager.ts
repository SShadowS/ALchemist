import * as vscode from 'vscode';
import * as cp from 'child_process';

/**
 * Minimum supported AL.Runner version.
 *
 * 2.7.0 is the floor because two features depend on it and have no fallback:
 * the per-statement coverage table (exact inline-value placement and hit
 * counts) and the `--dap stdio` transport used by the debug adapter.
 */
export const MIN_AL_RUNNER_VERSION = '2.7.0';

/**
 * Negative when a < b, 0 when equal, positive when a > b. Pre-release
 * suffixes are ignored. A version with fewer than three segments is
 * zero-padded (`'2.7'` compares as `'2.7.0'`) rather than producing NaN.
 */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string) => {
    const [major, minor, patch] = v.split('-')[0].split('.');
    return [major, minor, patch].map(n => parseInt(n, 10) || 0);
  };
  const [aMajor, aMinor, aPatch] = parts(a);
  const [bMajor, bMinor, bPatch] = parts(b);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

/** First `major.minor.patch` in `al-runner --version` output, or undefined. */
export function parseRunnerVersion(stdout: string): string | undefined {
  const match = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return match ? match[1] : undefined;
}

export class AlRunnerManager {
  private resolvedPath: string | undefined;
  private warnedVersion = false;

  /**
   * The al-runner path from `alchemist.alRunnerPath` or `ALCHEMIST_RUNNER_PATH`
   * (e.g. `.vscode/launch.json` pointing at a local fork build), or `''` when
   * neither is set. The single place both `ensureInstalled` (to resolve the
   * path to run) and `checkForUpdates` (to skip nagging about a runner the
   * user chose, not one we installed) read this from — a second, independent
   * read of just the setting is what previously let the env-var case
   * silently diverge from the setting-only case in both call sites.
   */
  private resolveConfiguredPath(): string {
    return vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '')
      || process.env.ALCHEMIST_RUNNER_PATH
      || '';
  }

  async ensureInstalled(): Promise<string> {
    const configPath = this.resolveConfiguredPath();
    if (configPath) {
      this.resolvedPath = configPath;
      // configPath came from the alRunnerPath setting or ALCHEMIST_RUNNER_PATH
      // (e.g. .vscode/launch.json points this at a local fork build) — either
      // way the user chose this binary, so no Update button.
      void this.warnIfBelowMinimum(configPath, /* userConfigured */ true);
      return configPath;
    }

    // Check if al-runner is on PATH
    const pathResult = await this.tryFindOnPath();
    if (pathResult) {
      this.resolvedPath = pathResult;
      void this.warnIfBelowMinimum(pathResult, /* userConfigured */ false);
      return pathResult;
    }

    // Try to install via dotnet tool
    const installed = await this.installViaDotnet();
    if (installed) {
      this.resolvedPath = installed;
      void this.warnIfBelowMinimum(installed, /* userConfigured */ false);
      return installed;
    }

    throw new Error('Could not find or install AL.Runner');
  }

  getPath(): string | undefined {
    return this.resolvedPath;
  }

  /**
   * Warn once per session when the resolved runner predates the minimum.
   * Best-effort: an unreadable `--version` is not treated as a failure,
   * because the runtime notice in extension.ts still catches a missing
   * statement table.
   *
   * `userConfigured` is passed in by the caller rather than re-derived here
   * from `alchemist.alRunnerPath` — `ensureInstalled` already knows which
   * branch resolved `runnerPath` (the setting or `ALCHEMIST_RUNNER_PATH` vs.
   * PATH lookup or a fresh dotnet install), and re-reading just the setting
   * here previously missed the env-var case, wrongly offering to
   * `dotnet tool update` a runner the user pointed us at directly.
   */
  private async warnIfBelowMinimum(runnerPath: string, userConfigured: boolean): Promise<void> {
    if (this.warnedVersion) return;
    const stdout = await new Promise<string>((resolve) => {
      cp.exec(`"${runnerPath}" --version`, (err, out) => resolve(err ? '' : out));
    });
    const version = parseRunnerVersion(stdout);
    if (!version || compareSemver(version, MIN_AL_RUNNER_VERSION) >= 0) return;

    this.warnedVersion = true;
    const message =
      `ALchemist requires AL.Runner ${MIN_AL_RUNNER_VERSION} or newer (found ${version}). ` +
      'Inline values, hit counts, and debugging are unavailable until it is updated.';
    if (userConfigured) {
      vscode.window.showWarningMessage(message);
      return;
    }
    const action = await vscode.window.showWarningMessage(message, 'Update');
    if (action !== 'Update') return;
    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';
    cp.exec(`${dotnetPath} tool update -g msdyn365bc.al.runner`, (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Update failed: ${err.message}`);
      } else {
        vscode.window.showInformationMessage('AL.Runner updated successfully.');
        void this.tryFindOnPath().then((p) => { this.resolvedPath = p; });
      }
    });
  }

  private tryFindOnPath(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      cp.exec(`${cmd} al-runner`, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(undefined);
        } else {
          resolve(stdout.trim().split('\n')[0].trim());
        }
      });
    });
  }

  private async installViaDotnet(): Promise<string | undefined> {
    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';

    // Check dotnet is available
    const dotnetAvailable = await this.checkCommand(dotnetPath);
    if (!dotnetAvailable) {
      const action = await vscode.window.showErrorMessage(
        'ALchemist requires .NET 8 SDK. Please install it to continue.',
        'Download .NET SDK'
      );
      if (action === 'Download .NET SDK') {
        vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download/dotnet/8.0'));
      }
      return undefined;
    }

    // Install al-runner
    const installChoice = await vscode.window.showInformationMessage(
      'ALchemist needs to install AL.Runner. Install now?',
      'Install', 'Cancel'
    );
    if (installChoice !== 'Install') return undefined;

    return new Promise((resolve) => {
      cp.exec(`${dotnetPath} tool install -g msdyn365bc.al.runner`, (err, stdout, stderr) => {
        if (err) {
          // Might already be installed, try update
          cp.exec(`${dotnetPath} tool update -g msdyn365bc.al.runner`, (err2) => {
            if (err2) {
              vscode.window.showErrorMessage(
                `Failed to install AL.Runner: ${stderr || err2.message}. Install manually: dotnet tool install -g msdyn365bc.al.runner`
              );
              resolve(undefined);
            } else {
              void this.tryFindOnPath().then(resolve);
            }
          });
        } else {
          void this.tryFindOnPath().then(resolve);
        }
      });
    });
  }

  async checkForUpdates(): Promise<void> {
    if (this.resolveConfiguredPath()) return; // Skip update checks for a user-configured path (setting or ALCHEMIST_RUNNER_PATH)

    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';

    cp.exec(`${dotnetPath} tool list -g`, (err, stdout) => {
      if (err || !stdout.includes('msdyn365bc.al.runner')) return;

      // Check NuGet for newer version (non-blocking, best-effort)
      cp.exec(`${dotnetPath} tool search msdyn365bc.al.runner --take 1`, (err2, searchStdout) => {
        if (err2 || !searchStdout) return;

        const installedMatch = stdout.match(/msdyn365bc\.al\.runner\s+(\S+)/i);
        const latestMatch = searchStdout.match(/msdyn365bc\.al\.runner\s+(\S+)/i);

        if (installedMatch && latestMatch && installedMatch[1] !== latestMatch[1]) {
          vscode.window.showInformationMessage(
            `AL.Runner update available: ${latestMatch[1]} (current: ${installedMatch[1]})`,
            'Update'
          ).then((action) => {
            if (action === 'Update') {
              cp.exec(`${dotnetPath} tool update -g msdyn365bc.al.runner`, (err3) => {
                if (err3) {
                  vscode.window.showErrorMessage(`Update failed: ${err3.message}`);
                } else {
                  vscode.window.showInformationMessage('AL.Runner updated successfully.');
                  void this.tryFindOnPath().then((p) => { this.resolvedPath = p; });
                }
              });
            }
          });
        }
      });
    });
  }

  private checkCommand(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      cp.exec(`${cmd} --version`, (err) => resolve(!err));
    });
  }
}
