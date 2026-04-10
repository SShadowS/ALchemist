import * as assert from 'assert';
import { parseTestOutput, parseRunSummary, parseCoberturaXml } from '../../src/runner/outputParser';

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

suite('parseCoberturaXml', () => {
  test('parses coverage entries from XML', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.7143" lines-covered="5" lines-valid="7" version="1.0" timestamp="1712764800">
  <sources><source>.</source></sources>
  <packages>
    <package name="al-source" line-rate="0.7143">
      <classes>
        <class name="Calculator" filename="src/Calculator.al" line-rate="1.0000">
          <lines>
            <line number="5" hits="1" />
            <line number="6" hits="1" />
            <line number="7" hits="1" />
          </lines>
        </class>
        <class name="Validator" filename="src/Validator.al" line-rate="0.5000">
          <lines>
            <line number="3" hits="1" />
            <line number="4" hits="0" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    assert.strictEqual(entries.length, 2);

    assert.strictEqual(entries[0].className, 'Calculator');
    assert.strictEqual(entries[0].filename, 'src/Calculator.al');
    assert.strictEqual(entries[0].lines.length, 3);
    assert.deepStrictEqual(entries[0].lines[0], { number: 5, hits: 1 });

    assert.strictEqual(entries[1].className, 'Validator');
    assert.strictEqual(entries[1].lines.length, 2);
    assert.deepStrictEqual(entries[1].lines[1], { number: 4, hits: 0 });
  });

  test('handles missing coverage XML gracefully', () => {
    const entries = parseCoberturaXml('');
    assert.strictEqual(entries.length, 0);
  });

  test('handles single class (non-array)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1.0" lines-covered="2" lines-valid="2" version="1.0" timestamp="1712764800">
  <sources><source>.</source></sources>
  <packages>
    <package name="al-source" line-rate="1.0">
      <classes>
        <class name="OnlyOne" filename="src/OnlyOne.al" line-rate="1.0">
          <lines>
            <line number="1" hits="1" />
            <line number="2" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].className, 'OnlyOne');
  });
});
