import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AlRunnerManager } from './alRunnerManager';
import { parseJsonOutput, parseCoberturaXml, ExecutionResult } from './outputParser';

export type ExecutionMode = 'scratch-standalone' | 'scratch-project' | 'test';

export class Executor {
  private currentProcess: cp.ChildProcess | undefined;
  private readonly onDidStartRun = new vscode.EventEmitter<ExecutionMode>();
  private readonly onDidFinishRun = new vscode.EventEmitter<ExecutionResult>();

  readonly onStart = this.onDidStartRun.event;
  readonly onFinish = this.onDidFinishRun.event;

  constructor(private readonly runnerManager: AlRunnerManager) {}

  async execute(mode: ExecutionMode, filePath: string, workspacePath?: string, procedureName?: string): Promise<void> {
    const runnerPath = this.runnerManager.getPath();
    if (!runnerPath) {
      vscode.window.showErrorMessage('AL.Runner not found. Run "ALchemist: Run Now" to trigger installation.');
      return;
    }

    this.cancel();
    this.onDidStartRun.fire(mode);

    const startTime = Date.now();
    const { args, cwd } = this.buildArgs(mode, filePath, workspacePath, procedureName);

    try {
      const { stdout, stderr, exitCode } = await this.spawn(runnerPath, args, cwd);
      const coberturaPath = path.join(cwd, 'cobertura.xml');
      let coverageXml = '';
      if (fs.existsSync(coberturaPath)) {
        coverageXml = fs.readFileSync(coberturaPath, 'utf-8');
        fs.unlinkSync(coberturaPath); // Clean up after reading
      }

      const coverage = parseCoberturaXml(coverageXml);
      const stderrLines = stderr.split('\n').filter((l) => l.trim().length > 0);

      console.log('ALchemist: using JSON parser (--output-json)');
      const jsonResult = parseJsonOutput(stdout);
      const result: ExecutionResult = {
        mode: mode === 'test' ? 'test' : 'scratch',
        tests: jsonResult.tests,
        messages: jsonResult.messages,
        stderrOutput: stderrLines,
        summary: jsonResult.summary,
        coverage,
        exitCode,
        durationMs: Date.now() - startTime,
        capturedValues: jsonResult.capturedValues,
        cached: jsonResult.cached,
      };

      this.onDidFinishRun.fire(result);
    } catch (err: any) {
      const result: ExecutionResult = {
        mode: mode === 'test' ? 'test' : 'scratch',
        tests: [],
        messages: [],
        stderrOutput: [err.message || 'Unknown error'],
        summary: undefined,
        coverage: [],
        exitCode: 1,
        durationMs: Date.now() - startTime,
        capturedValues: [],
        cached: false,
      };
      this.onDidFinishRun.fire(result);
    }
  }

  cancel(): void {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
      this.currentProcess = undefined;
    }
  }

  private buildArgs(mode: ExecutionMode, filePath: string, workspacePath?: string, procedureName?: string): { args: string[]; cwd: string } {
    switch (mode) {
      case 'scratch-standalone':
        return {
          args: ['--output-json', '--capture-values', filePath],
          cwd: path.dirname(filePath),
        };
      case 'scratch-project': {
        const srcPath = workspacePath || path.dirname(filePath);
        return {
          args: ['--output-json', '--capture-values', '--coverage', srcPath, filePath],
          cwd: srcPath,
        };
      }
      case 'test': {
        const cwd = workspacePath || path.dirname(filePath);
        const args = ['--output-json', '--capture-values', '--coverage', cwd];
        if (procedureName) {
          args.splice(args.length - 1, 0, '--run', procedureName);
        }
        return { args, cwd };
      }
    }
  }

  private spawn(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(command, args, { cwd, shell: true });
      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        this.currentProcess = undefined;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        this.currentProcess = undefined;
        reject(err);
      });
    });
  }

  dispose(): void {
    this.cancel();
    this.onDidStartRun.dispose();
    this.onDidFinishRun.dispose();
  }
}
