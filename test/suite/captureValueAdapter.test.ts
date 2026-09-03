import * as assert from 'assert';
import { v2ToV1Captured } from '../../src/execution/captureValueAdapter';
import { CapturedValue } from '../../src/execution/protocolV2Types';

function captured(overrides: Partial<CapturedValue> = {}): CapturedValue {
  return {
    scopeName: 'Codeunit 50100.Run',
    objectName: 'My Codeunit',
    variableName: 'Total',
    value: '42',
    statementId: 17,
    ...overrides,
  };
}

suite('captureValueAdapter', () => {
  test('preserves common captured-value fields', () => {
    const result = v2ToV1Captured(captured({
      alSourceFile: 'src/MyCodeunit.Codeunit.al',
    }));

    assert.deepStrictEqual(result, {
      scopeName: 'Codeunit 50100.Run',
      sourceFile: 'src/MyCodeunit.Codeunit.al',
      variableName: 'Total',
      value: '42',
      statementId: 17,
    });
  });

  test('prefers capture alSourceFile over event fallback and object name', () => {
    const result = v2ToV1Captured(captured({
      alSourceFile: 'src/Owned.Codeunit.al',
      objectName: 'Different Object',
    }), 'src/Fallback.Codeunit.al');

    assert.strictEqual(result.sourceFile, 'src/Owned.Codeunit.al');
  });

  test('uses event source file when the capture has no source file', () => {
    const result = v2ToV1Captured(captured({
      alSourceFile: undefined,
      objectName: 'My Codeunit',
    }), 'src/Test.Codeunit.al');

    assert.strictEqual(result.sourceFile, 'src/Test.Codeunit.al');
  });

  test('falls back to objectName when neither source-file value exists', () => {
    const result = v2ToV1Captured(captured({
      alSourceFile: undefined,
      objectName: 'My Codeunit',
    }));

    assert.strictEqual(result.sourceFile, 'My Codeunit');
  });

  test('uses an empty source file when every source hint is absent', () => {
    const result = v2ToV1Captured(captured({
      alSourceFile: undefined,
      objectName: undefined,
    }));

    assert.strictEqual(result.sourceFile, '');
  });

  test('leaves string values unchanged', () => {
    const result = v2ToV1Captured(captured({
      value: '{"already":"text"}',
    }));

    assert.strictEqual(result.value, '{"already":"text"}');
  });

  test('JSON-serializes non-string protocol values', () => {
    const cases: Array<[unknown, string]> = [
      [42, '42'],
      [true, 'true'],
      [null, 'null'],
      [[1, 'two'], '[1,"two"]'],
      [{ amount: 12, active: false }, '{"amount":12,"active":false}'],
    ];

    for (const [value, expected] of cases) {
      const result = v2ToV1Captured(captured({ value }));
      assert.strictEqual(result.value, expected);
    }
  });

  test('does not mutate the v2 capture', () => {
    const input = captured({
      alSourceFile: 'src/Input.al',
      value: { nested: ['value'] },
    });
    const snapshot = JSON.stringify(input);

    v2ToV1Captured(input, 'src/Fallback.al');

    assert.strictEqual(JSON.stringify(input), snapshot);
  });
});
