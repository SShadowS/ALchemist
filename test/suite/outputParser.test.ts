import * as assert from 'assert';
import { parseTestOutput, parseRunSummary } from '../../src/runner/outputParser';

suite('OutputParser', () => {
  suite('parseTestOutput', () => {
    test('parses a passing test', () => {
      const stdout = 'PASS  TestCalcDiscount (3ms)\n';
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestCalcDiscount');
      assert.strictEqual(result.tests[0].status, 'passed');
      assert.strictEqual(result.tests[0].durationMs, 3);
    });

    test('parses a failing test with assertion message', () => {
      const stdout = [
        'FAIL  TestGreeting',
        '      Assert.AreEqual failed. Expected: <Goodbye>, Actual: <Hello>. Greeting should match',
        '      at Codeunit50906+TestGreet_Scope_12345.OnRun()',
        '      at System.Reflection.MethodInvoker.Invoke()',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestGreeting');
      assert.strictEqual(result.tests[0].status, 'failed');
      assert.strictEqual(result.tests[0].message, 'Assert.AreEqual failed. Expected: <Goodbye>, Actual: <Hello>. Greeting should match');
      assert.ok(result.tests[0].stackTrace!.includes('Codeunit50906'));
    });

    test('parses an errored test', () => {
      const stdout = [
        'ERROR TestUnsupported',
        '      NotSupportedException: Page objects not supported',
        '      Inject this dependency via an AL interface.',
        '      at SomeStackFrame()',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestUnsupported');
      assert.strictEqual(result.tests[0].status, 'errored');
      assert.ok(result.tests[0].message!.includes('NotSupportedException'));
    });

    test('parses multiple tests in sequence', () => {
      const stdout = [
        'PASS  TestA (1ms)',
        'PASS  TestB (2ms)',
        'FAIL  TestC',
        '      Some error',
        '',
        'Results: 2 passed, 1 failed, 0 errors, 3 total',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 3);
      assert.strictEqual(result.tests[0].status, 'passed');
      assert.strictEqual(result.tests[1].status, 'passed');
      assert.strictEqual(result.tests[2].status, 'failed');
    });

    test('captures Message() output as messages', () => {
      const stdout = [
        'Hello from AL',
        'PASS  TestA (0ms)',
        'Item count: 5',
        'PASS  TestB (1ms)',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.deepStrictEqual(result.messages, ['Hello from AL', 'Item count: 5']);
    });

    test('handles empty output', () => {
      const result = parseTestOutput('');
      assert.strictEqual(result.tests.length, 0);
      assert.strictEqual(result.messages.length, 0);
    });
  });

  suite('parseRunSummary', () => {
    test('parses summary line', () => {
      const line = 'Results: 3 passed, 1 failed, 0 errors, 4 total';
      const summary = parseRunSummary(line);
      assert.deepStrictEqual(summary, { passed: 3, failed: 1, errors: 0, total: 4 });
    });

    test('returns undefined for non-summary line', () => {
      const summary = parseRunSummary('PASS  TestA (1ms)');
      assert.strictEqual(summary, undefined);
    });
  });
});
