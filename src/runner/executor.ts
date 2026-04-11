import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AlRunnerManager } from './alRunnerManager';
import { parseJsonOutput, parseCoberturaXml, ExecutionResult } from './outputParser';

export type ExecutionMode = 'scratch-standalone' | 'scratch-project' | 'test';

export function buildRunnerArgs(mode: ExecutionMode, filePath: string, workspacePath?: string, procedureName?: string): { args: string[]; cwd: string } {
  switch (mode) {
    case 'scratch-standalone':
      return {
        args: ['--output-json', '--capture-values', '--iteration-tracking', filePath],
        cwd: path.dirname(filePath),
      };
    case 'scratch-project': {
      const srcPath = workspacePath || path.dirname(filePath);
      return {
        args: ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', srcPath, filePath],
        cwd: srcPath,
      };
    }
    case 'test': {
      const cwd = workspacePath || path.dirname(filePath);
      const args = ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', cwd];
      if (procedureName) {
        args.splice(args.length - 1, 0, '--run', procedureName);
      }
      return { args, cwd };
    }
  }
}

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
    console.log(`ALchemist: execute(mode=${mode}, filePath=${filePath}, workspacePath=${workspacePath})`);
    this.onDidStartRun.fire(mode);

    const startTime = Date.now();
    const { args, cwd } = this.buildArgs(mode, filePath, workspacePath, procedureName);

    const result = await this.runAndParse(runnerPath, args, cwd, mode, startTime);

    // Fallback: if test mode failed with no tests (e.g. missing project dependencies),
    // retry with just the single file standalone
    if (mode === 'test' && result.tests.length === 0 && result.exitCode !== 0 && filePath.endsWith('.al')) {
      // Retry with just the single file, but keep --coverage for gutter display
      const fallbackArgs = {
        args: ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', filePath],
        cwd: path.dirname(filePath),
      };
      console.log(`ALchemist: project compilation failed (exit=${result.exitCode}), retrying single file: ${filePath}`);
      const fallbackResult = await this.runAndParse(runnerPath, fallbackArgs.args, fallbackArgs.cwd, mode, startTime);
      console.log(`ALchemist: fallback result: exit=${fallbackResult.exitCode}, tests=${fallbackResult.tests.length}, iterations=${fallbackResult.iterations.length}`);
      console.log(`ALchemist: firing fallback result (tests=${fallbackResult.tests.length}, iter=${fallbackResult.iterations.length})`);
      this.onDidFinishRun.fire(fallbackResult);
    } else {
      console.log(`ALchemist: firing result (tests=${result.tests.length}, iter=${result.iterations.length}, exit=${result.exitCode})`);
      this.onDidFinishRun.fire(result);
    }
  }

  private async runAndParse(runnerPath: string, args: string[], cwd: string, mode: ExecutionMode, startTime: number): Promise<ExecutionResult> {
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
      return {
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
        iterations: jsonResult.iterations,
      };
    } catch (err: any) {
      return {
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
        iterations: [],
      };
    }
  }

  cancel(): void {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
      this.currentProcess = undefined;
    }
  }

  private buildArgs(mode: ExecutionMode, filePath: string, workspacePath?: string, procedureName?: string): { args: string[]; cwd: string } {
    return buildRunnerArgs(mode, filePath, workspacePath, procedureName);
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
