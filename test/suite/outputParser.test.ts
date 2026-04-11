import * as assert from 'assert';
import { parseTestOutput, parseRunSummary, parseCoberturaXml, parseJsonOutput } from '../../src/runner/outputParser';

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

suite('parseJsonOutput', () => {
  test('parses JSON with passing tests', () => {
    const json = JSON.stringify({
      tests: [
        { name: 'TestCalc', status: 'pass', durationMs: 5, message: null, stackTrace: null, alSourceLine: null }
      ],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.tests.length, 1);
    assert.strictEqual(result.tests[0].name, 'TestCalc');
    assert.strictEqual(result.tests[0].status, 'passed');
    assert.strictEqual(result.tests[0].durationMs, 5);
    assert.strictEqual(result.tests[0].alSourceLine, undefined);
  });

  test('parses JSON with failing test and alSourceLine', () => {
    const json = JSON.stringify({
      tests: [
        { name: 'TestFail', status: 'fail', durationMs: 3, message: 'Assert failed', stackTrace: 'at Foo()', alSourceLine: 42 }
      ],
      passed: 0, failed: 1, errors: 0, total: 1, exitCode: 1
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.tests[0].status, 'failed');
    assert.strictEqual(result.tests[0].message, 'Assert failed');
    assert.strictEqual(result.tests[0].alSourceLine, 42);
  });

  test('parses JSON with errored test', () => {
    const json = JSON.stringify({
      tests: [
        { name: 'TestErr', status: 'error', durationMs: 1, message: 'NotSupported', stackTrace: null, alSourceLine: null }
      ],
      passed: 0, failed: 0, errors: 1, total: 1, exitCode: 1
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.tests[0].status, 'errored');
  });

  test('parses capturedValues', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      capturedValues: [
        { scopeName: 'TestCalc', variableName: 'Result', value: '121.00', statementId: 3 },
        { scopeName: 'TestCalc', variableName: 'Rate', value: '0.21', statementId: 2 }
      ]
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.capturedValues.length, 2);
    assert.strictEqual(result.capturedValues[0].variableName, 'Result');
    assert.strictEqual(result.capturedValues[0].value, '121.00');
    assert.strictEqual(result.capturedValues[1].statementId, 2);
  });

  test('handles cached field', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 0 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      cached: true
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.cached, true);
  });

  test('handles missing optional fields gracefully', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.capturedValues.length, 0);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.tests[0].alSourceLine, undefined);
  });

  test('parses summary correctly', () => {
    const json = JSON.stringify({
      tests: [
        { name: 'A', status: 'pass', durationMs: 1 },
        { name: 'B', status: 'fail', durationMs: 2, message: 'err' },
      ],
      passed: 1, failed: 1, errors: 0, total: 2, exitCode: 1
    });
    const result = parseJsonOutput(json);
    assert.deepStrictEqual(result.summary, { passed: 1, failed: 1, errors: 0, total: 2 });
  });
});

suite('parseJsonOutput edge cases', () => {
  test('extracts JSON from mixed stdout (text before JSON)', () => {
    const mixed = [
      'Hello from AL',
      'Count: 42',
      '',
      'Timing: 831ms total',
      '  AL transpilation   330ms',
      '{',
      '  "tests": [],',
      '  "passed": 0, "failed": 0, "errors": 0, "total": 0,',
      '  "exitCode": 0,',
      '  "messages": ["Hello from AL", "Count: 42"]',
      '}',
    ].join('\n');
    const result = parseJsonOutput(mixed);
    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual(result.messages[0], 'Hello from AL');
    assert.strictEqual(result.messages[1], 'Count: 42');
  });

  test('parses clean JSON without prefix text', () => {
    const json = JSON.stringify({
      tests: [], passed: 0, failed: 0, errors: 0, total: 0, exitCode: 0,
      messages: ['hello']
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.messages.length, 1);
  });

  test('handles alSourceColumn in test results', () => {
    const json = JSON.stringify({
      tests: [{ name: 'T', status: 'fail', durationMs: 1, message: 'err', alSourceLine: 10, alSourceColumn: 5 }],
      passed: 0, failed: 1, errors: 0, total: 1, exitCode: 1
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.tests[0].alSourceColumn, 5);
  });

  test('handles null alSourceColumn', () => {
    const json = JSON.stringify({
      tests: [{ name: 'T', status: 'pass', durationMs: 1, alSourceColumn: null }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.tests[0].alSourceColumn, undefined);
  });
});

suite('parseJsonOutput — iterations', () => {
  test('parses iterations array from JSON', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
      iterations: [{
        loopId: 'L0', loopLine: 3, loopEndLine: 10,
        parentLoopId: null, parentIteration: null, iterationCount: 3,
        steps: [
          { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: ['msg1'], linesExecuted: [3, 4, 5] },
          { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: ['msg2'], linesExecuted: [3, 4, 5] },
          { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: ['msg3'], linesExecuted: [3, 4, 5] },
        ],
      }],
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 1);
    assert.strictEqual(result.iterations[0].loopId, 'L0');
    assert.strictEqual(result.iterations[0].iterationCount, 3);
    assert.strictEqual(result.iterations[0].steps.length, 3);
    assert.strictEqual(result.iterations[0].steps[0].capturedValues[0].value, '1');
    assert.deepStrictEqual(result.iterations[0].steps[1].messages, ['msg2']);
    assert.deepStrictEqual(result.iterations[0].steps[2].linesExecuted, [3, 4, 5]);
  });

  test('handles missing iterations field gracefully', () => {
    const json = JSON.stringify({
      tests: [], passed: 0, failed: 0, errors: 0, total: 0, exitCode: 0,
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 0);
  });

  test('parses nested loop with parentLoopId', () => {
    const json = JSON.stringify({
      tests: [], passed: 0, failed: 0, errors: 0, total: 0, exitCode: 0,
      iterations: [
        { loopId: 'L0', loopLine: 3, loopEndLine: 12, parentLoopId: null, parentIteration: null, iterationCount: 2, steps: [] },
        { loopId: 'L1', loopLine: 5, loopEndLine: 9, parentLoopId: 'L0', parentIteration: 1, iterationCount: 4, steps: [] },
      ],
    });
    const result = parseJsonOutput(json);
    assert.strictEqual(result.iterations.length, 2);
    assert.strictEqual(result.iterations[1].parentLoopId, 'L0');
    assert.strictEqual(result.iterations[1].parentIteration, 1);
  });
});
