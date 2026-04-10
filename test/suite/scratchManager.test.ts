import * as assert from 'assert';
import { isProjectAware, isScratchFile } from '../../src/scratch/scratchManager';

suite('ScratchManager', () => {
  suite('isProjectAware', () => {
    test('detects project directive at first line', () => {
      assert.strictEqual(isProjectAware('//alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('detects directive with extra spaces', () => {
      assert.strictEqual(isProjectAware('// alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('returns false without directive', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch {}'), false);
    });

    test('returns false when directive is not on first line', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch\n//alchemist: project\n{}'), false);
    });
  });

  suite('isScratchFile', () => {
    test('identifies scratch file by path containing alchemist-scratch', () => {
      assert.strictEqual(isScratchFile('/tmp/alchemist-scratch/scratch1.al'), true);
    });

    test('rejects normal project file', () => {
      assert.strictEqual(isScratchFile('/workspace/src/MyCodeunit.al'), false);
    });
  });
});
