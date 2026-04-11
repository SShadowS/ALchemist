import * as assert from 'assert';
import { findLoopAtCursor } from '../../src/iteration/iterationCommands';
import { LoopInfo } from '../../src/iteration/types';

const loops: LoopInfo[] = [
  { loopId: 'L0', loopLine: 3, loopEndLine: 20, parentLoopId: null, parentIteration: null, iterationCount: 5, currentIteration: 1 },
  { loopId: 'L1', loopLine: 8, loopEndLine: 15, parentLoopId: 'L0', parentIteration: null, iterationCount: 3, currentIteration: 1 },
];

suite('iterationCommands', () => {
  test('findLoopAtCursor returns innermost loop when cursor is inside nested loop', () => {
    // Cursor at line 10 (1-based) → inside L1 (8-15) which is inside L0 (3-20)
    const result = findLoopAtCursor(loops, 10);
    assert.strictEqual(result, 'L1');
  });

  test('findLoopAtCursor returns outer loop when cursor is between inner and outer', () => {
    // Cursor at line 5 (1-based) → inside L0 (3-20) but not inside L1 (8-15)
    const result = findLoopAtCursor(loops, 5);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns nearest loop above cursor when outside all loops', () => {
    // Cursor at line 22 (1-based) → outside both loops, nearest above is L0
    const result = findLoopAtCursor(loops, 22);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns null when no loops exist', () => {
    const result = findLoopAtCursor([], 5);
    assert.strictEqual(result, null);
  });

  test('findLoopAtCursor returns loop when cursor is on loop start line', () => {
    const result = findLoopAtCursor(loops, 3);
    assert.strictEqual(result, 'L0');
  });

  test('findLoopAtCursor returns loop when cursor is on loop end line', () => {
    const result = findLoopAtCursor(loops, 15);
    assert.strictEqual(result, 'L1');
  });
});
