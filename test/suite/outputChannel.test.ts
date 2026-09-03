import * as assert from 'assert';
import * as vscode from 'vscode';
import { AlchemistOutputChannel } from '../../src/output/outputChannel';
import { ExecutionResult } from '../../src/runner/outputParser';

interface RecordedOutputChannel {
  name: string;
  lines: string[];
  calls: Array<{ method: string; value?: unknown }>;
  clearCalls: number;
  showCalls: boolean[];
  disposed: boolean;
}

function outputChannels(): RecordedOutputChannel[] {
  return (vscode.window as any).__outputChannels as RecordedOutputChannel[];
}

function lastOutputChannel(): RecordedOutputChannel {
  const channels = outputChannels();
  assert.ok(channels.length > 0, 'expected an output channel to have been created');
  return channels[channels.length - 1];
}

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    mode: 'scratch',
    tests: [],
    messages: [],
    stderrOutput: [],
    summary: undefined,
    coverage: [],
    exitCode: 0,
    durationMs: 0,
    capturedValues: [],
    cached: false,
    iterations: [],
    ...overrides,
  };
}

suite('AlchemistOutputChannel', () => {
  setup(() => {
    outputChannels().splice(0);
  });

  test('constructor creates the named channel and writes the version banner', () => {
    const output = new AlchemistOutputChannel('1.2.3');
    const channel = lastOutputChannel();

    assert.strictEqual(channel.name, 'ALchemist');
    assert.deepStrictEqual(channel.lines, ['ALchemist v1.2.3 loaded']);
    assert.deepStrictEqual(channel.calls, [
      { method: 'appendLine', value: 'ALchemist v1.2.3 loaded' },
    ]);

    output.dispose();
    assert.strictEqual(channel.disposed, true);
  });

  test('displayResult formats scratch output, diagnostics, coverage, and unresolved scopes', () => {
    const output = new AlchemistOutputChannel('1.2.3');
    const channel = lastOutputChannel();

    output.displayResult(makeResult({
      mode: 'scratch',
      durationMs: 37,
      protocolVersion: 2,
      messages: ['first message', 'second message'],
      stderrOutput: ['compiler error'],
      unresolvedScopes: ['Codeunit 50100.Run', 'Page 50101.Open'],
      coverage: [
        {
          className: 'A',
          filename: 'src/A.al',
          lineRate: 0.5,
          lines: [
            { number: 1, hits: 1 },
            { number: 2, hits: 0 },
          ],
        },
        {
          className: 'B',
          filename: 'src/B.al',
          lineRate: 1,
          lines: [{ number: 4, hits: 3 }],
        },
      ],
    }), 'Scratch.al');

    assert.strictEqual(channel.clearCalls, 1);
    assert.ok(
      channel.lines[0].startsWith('━━━ ALchemist v1.2.3 · protocol v2 '),
      `unexpected header: ${channel.lines[0]}`,
    );
    assert.ok(channel.lines.includes('  ▶ Scratch.al (scratch)'));
    assert.ok(channel.lines.includes('  ⏱ 37ms'));

    assert.ok(channel.lines.includes(
      'Iteration tracking could not resolve these scopes (their loops are not shown):',
    ));
    assert.ok(channel.lines.includes('  Codeunit 50100.Run'));
    assert.ok(channel.lines.includes('  Page 50101.Open'));

    assert.ok(channel.lines.includes('  Messages:'));
    assert.ok(channel.lines.includes('    first message'));
    assert.ok(channel.lines.includes('    second message'));

    assert.ok(channel.lines.includes('  Errors:'));
    assert.ok(channel.lines.includes('    compiler error'));
    assert.ok(channel.lines.includes('  Coverage: 2/3 statements (66.7%)'));
    assert.strictEqual(channel.lines[channel.lines.length - 1], '━'.repeat(60));

    assert.deepStrictEqual(
      channel.showCalls,
      [true],
      'stderr should focus output under the default onlyOnFailure setting',
    );
  });

  test('displayResult formats passed, failed, and errored test results', () => {
    const output = new AlchemistOutputChannel('2.0.0');
    const channel = lastOutputChannel();

    output.displayResult(makeResult({
      mode: 'test',
      durationMs: 125,
      tests: [
        {
          name: 'Passes',
          status: 'passed',
          durationMs: 12,
          message: undefined,
          stackTrace: undefined,
          alSourceLine: undefined,
          alSourceColumn: undefined,
        },
        {
          name: 'Fails',
          status: 'failed',
          durationMs: undefined,
          message: 'Expected true',
          stackTrace: ' first frame \n\n second frame ',
          alSourceLine: 10,
          alSourceColumn: 4,
        },
        {
          name: 'Crashes',
          status: 'errored',
          durationMs: undefined,
          message: 'Unexpected error',
          stackTrace: undefined,
          alSourceLine: undefined,
          alSourceColumn: undefined,
        },
      ],
      summary: {
        passed: 1,
        failed: 1,
        errors: 1,
        total: 3,
      },
      exitCode: 1,
    }), 'Tests.Codeunit.al');

    assert.ok(channel.lines.includes('  ▶ Tests.Codeunit.al (test)'));
    assert.ok(channel.lines.includes('  ⏱ 125ms'));
    assert.ok(channel.lines.includes('  ✓ Passes           12ms'));
    assert.ok(channel.lines.includes('  ✗ Fails'));
    assert.ok(channel.lines.includes('    → Expected true'));
    assert.ok(channel.lines.includes('      first frame'));
    assert.ok(channel.lines.includes('      second frame'));
    assert.ok(channel.lines.includes('  ⚠ Crashes'));
    assert.ok(channel.lines.includes('    → Unexpected error'));
    assert.ok(channel.lines.includes('  Results: 1 passed, 1 failed'));
    assert.deepStrictEqual(channel.showCalls, [true]);
  });

  test('appendLine and show delegate to the underlying channel', () => {
    const output = new AlchemistOutputChannel();
    const channel = lastOutputChannel();

    assert.strictEqual(channel.lines[0], 'ALchemist vunknown loaded');

    output.appendLine('manual diagnostic');
    output.show();

    assert.strictEqual(channel.lines[channel.lines.length - 1], 'manual diagnostic');
    assert.deepStrictEqual(channel.showCalls, [true]);
  });

  test('respects always and never output-focus settings', () => {
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    try {
      (vscode.workspace as any).getConfiguration = () => ({
        get: () => 'always',
      });

      const alwaysOutput = new AlchemistOutputChannel('1.0.0');
      const alwaysChannel = lastOutputChannel();
      alwaysOutput.displayResult(makeResult(), 'Passed.al');
      assert.deepStrictEqual(alwaysChannel.showCalls, [true]);

      (vscode.workspace as any).getConfiguration = () => ({
        get: () => 'never',
      });

      const neverOutput = new AlchemistOutputChannel('1.0.0');
      const neverChannel = lastOutputChannel();
      neverOutput.displayResult(makeResult({
        exitCode: 1,
        stderrOutput: ['failed'],
      }), 'Failed.al');
      assert.deepStrictEqual(neverChannel.showCalls, []);
    } finally {
      (vscode.workspace as any).getConfiguration = originalGetConfiguration;
    }
  });
});
