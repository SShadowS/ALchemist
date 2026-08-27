import * as assert from 'assert';
import { shouldLogCaptureFilterDrop } from '../../src/extension';

/**
 * Regression coverage for the misdiagnosis fixed in Task 2's review round:
 * `applyResults` skips `applyInlineCapturedValues` entirely (and therefore
 * never touches the file filter) whenever no statement table landed — v1
 * results, or v2 results without AL.Runner >= 2.7.0's `statements[]`. Before
 * the `statementsAvailable` guard, `extension.ts` blamed that no-op on "the
 * file filter dropped all captures", which is wrong: the filter never ran.
 */
suite('shouldLogCaptureFilterDrop', () => {
  test('no statement table, captures present, none matched → false (not a filter drop)', () => {
    assert.strictEqual(
      shouldLogCaptureFilterDrop({ statementsAvailable: false, captureCount: 3, capturesForActiveFile: 0 }),
      false,
    );
  });

  test('statement table present, captures present, none matched → true (genuine filter drop)', () => {
    assert.strictEqual(
      shouldLogCaptureFilterDrop({ statementsAvailable: true, captureCount: 3, capturesForActiveFile: 0 }),
      true,
    );
  });

  test('statement table present, captures matched → false (nothing was dropped)', () => {
    assert.strictEqual(
      shouldLogCaptureFilterDrop({ statementsAvailable: true, captureCount: 3, capturesForActiveFile: 3 }),
      false,
    );
  });

  test('no captures at all → false regardless of statementsAvailable', () => {
    assert.strictEqual(
      shouldLogCaptureFilterDrop({ statementsAvailable: true, captureCount: 0, capturesForActiveFile: 0 }),
      false,
    );
    assert.strictEqual(
      shouldLogCaptureFilterDrop({ statementsAvailable: false, captureCount: 0, capturesForActiveFile: 0 }),
      false,
    );
  });
});
