import * as assert from 'assert';
import { shouldLogCaptureFilterDrop, shouldLogMissingStatementTable } from '../../src/extension';

/**
 * Coverage for the version-gate runtime notice (Task 6). This is the
 * complementary branch to `shouldLogCaptureFilterDrop` (see
 * captureFilterDropDiagnostic.test.ts): it must fire exactly when that one
 * does NOT, for the same "captures arrived" input, because the two decisions
 * differ only in `statementsAvailable`.
 */
suite('shouldLogMissingStatementTable', () => {
  test('no statement table, captures present → true (pre-2.7.0 runner or v1 result)', () => {
    assert.strictEqual(
      shouldLogMissingStatementTable({ statementsAvailable: false, captureCount: 3 }),
      true,
    );
  });

  test('statement table present, captures present → false (table exists, nothing to warn about)', () => {
    assert.strictEqual(
      shouldLogMissingStatementTable({ statementsAvailable: true, captureCount: 3 }),
      false,
    );
  });

  test('no captures at all → false regardless of statementsAvailable', () => {
    assert.strictEqual(
      shouldLogMissingStatementTable({ statementsAvailable: false, captureCount: 0 }),
      false,
    );
    assert.strictEqual(
      shouldLogMissingStatementTable({ statementsAvailable: true, captureCount: 0 }),
      false,
    );
  });

  test('mutually exclusive with shouldLogCaptureFilterDrop across every combination', () => {
    for (const statementsAvailable of [true, false]) {
      for (const captureCount of [0, 3]) {
        for (const capturesForActiveFile of [0, 3]) {
          const stats = { statementsAvailable, captureCount, capturesForActiveFile };
          const filterDrop = shouldLogCaptureFilterDrop(stats);
          const missingTable = shouldLogMissingStatementTable(stats);
          assert.ok(
            !(filterDrop && missingTable),
            `both fired for ${JSON.stringify(stats)}`,
          );
        }
      }
    }
  });
});
