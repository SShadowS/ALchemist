import * as vscode from 'vscode';
import * as cp from 'child_process';

export class AlRunnerManager {
  private resolvedPath: string | undefined;

  async ensureInstalled(): Promise<string> {
    const configPath = vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '');
    if (configPath) {
      this.resolvedPath = configPath;
      return configPath;
    }

    // Check if al-runner is on PATH
    const pathResult = await this.tryFindOnPath();
    if (pathResult) {
      this.resolvedPath = pathResult;
      return pathResult;
    }

    // Try to install via dotnet tool
    const installed = await this.installViaDotnet();
    if (installed) {
      this.resolvedPath = installed;
      return installed;
    }

    throw new Error('Could not find or install AL.Runner');
  }

  getPath(): string | undefined {
    return this.resolvedPath;
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
      cp.exec(`${dotnetPath} tool install -g BusinessCentral.AL.Runner`, (err, stdout, stderr) => {
        if (err) {
          // Might already be installed, try update
          cp.exec(`${dotnetPath} tool update -g BusinessCentral.AL.Runner`, (err2) => {
            if (err2) {
              vscode.window.showErrorMessage(
                `Failed to install AL.Runner: ${stderr || err2.message}. Install manually: dotnet tool install -g BusinessCentral.AL.Runner`
              );
              resolve(undefined);
            } else {
              this.tryFindOnPath().then(resolve);
            }
          });
        } else {
          this.tryFindOnPath().then(resolve);
        }
      });
    });
  }

  async checkForUpdates(): Promise<void> {
    const configPath = vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '');
    if (configPath) return; // Skip update checks for custom paths

    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';

    cp.exec(`${dotnetPath} tool list -g`, (err, stdout) => {
      if (err || !stdout.includes('businesscentral.al.runner')) return;

      // Check NuGet for newer version (non-blocking, best-effort)
      cp.exec(`${dotnetPath} tool search BusinessCentral.AL.Runner --take 1`, (err2, searchStdout) => {
        if (err2 || !searchStdout) return;

        const installedMatch = stdout.match(/businesscentral\.al\.runner\s+(\S+)/i);
        const latestMatch = searchStdout.match(/BusinessCentral\.AL\.Runner\s+(\S+)/i);

        if (installedMatch && latestMatch && installedMatch[1] !== latestMatch[1]) {
          vscode.window.showInformationMessage(
            `AL.Runner update available: ${latestMatch[1]} (current: ${installedMatch[1]})`,
            'Update'
          ).then((action) => {
            if (action === 'Update') {
              cp.exec(`${dotnetPath} tool update -g BusinessCentral.AL.Runner`, (err3) => {
                if (err3) {
                  vscode.window.showErrorMessage(`Update failed: ${err3.message}`);
                } else {
                  vscode.window.showInformationMessage('AL.Runner updated successfully.');
                  this.tryFindOnPath().then((p) => { this.resolvedPath = p; });
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
