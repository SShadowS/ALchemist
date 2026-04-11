import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

/**
 * Test fixture based on real AL.Runner output for:
 *
 *   codeunit 69000 "Name Meth"
 *   {
 *       Subtype = Test;
 *       [Test]
 *       procedure DoMethodName()
 *       var
 *           i: Integer;
 *           myText: Text[20];
 *       begin
 *           for i := 1 to 10 do                    // line 10
 *               myText := myText + Format(i);      // line 11
 *       end;
 *   }
 */
function makeRealLoopData(): IterationData[] {
  return [{
    loopId: 'L0',
    loopLine: 10,
    loopEndLine: 11,
    parentLoopId: null,
    parentIteration: null,
    iterationCount: 10,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'myText', value: '1' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 2, capturedValues: [{ variableName: 'myText', value: '12' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 3, capturedValues: [{ variableName: 'myText', value: '123' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 4, capturedValues: [{ variableName: 'myText', value: '1234' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 5, capturedValues: [{ variableName: 'myText', value: '12345' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 6, capturedValues: [{ variableName: 'myText', value: '123456' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 7, capturedValues: [{ variableName: 'myText', value: '1234567' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 8, capturedValues: [{ variableName: 'myText', value: '12345678' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 9, capturedValues: [{ variableName: 'myText', value: '123456789' }], messages: [], linesExecuted: [10, 11] },
      { iteration: 10, capturedValues: [{ variableName: 'myText', value: '12345678910' }], messages: [], linesExecuted: [10, 11] },
    ],
  }];
}

suite('Iteration Display — per-iteration values', () => {
  test('stepping to iteration 7 returns myText = 1234567', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    const step = store.setIteration('L0', 7);
    assert.strictEqual(step.capturedValues.get('myText'), '1234567');
  });

  test('stepping to iteration 1 returns myText = 1', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    const step = store.setIteration('L0', 1);
    assert.strictEqual(step.capturedValues.get('myText'), '1');
  });

  test('stepping to iteration 10 returns myText = 12345678910', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    const step = store.setIteration('L0', 10);
    assert.strictEqual(step.capturedValues.get('myText'), '12345678910');
  });

  test('changed values: iteration 2 shows myText changed', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    const changed = store.getChangedValues('L0', 2);
    assert.ok(changed.includes('myText'), 'myText should be marked as changed');
  });

  test('linesExecuted includes loop body lines for every iteration', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    for (let i = 1; i <= 10; i++) {
      const step = store.getStep('L0', i);
      assert.ok(step.linesExecuted.has(10), `iteration ${i} should have line 10 executed`);
      assert.ok(step.linesExecuted.has(11), `iteration ${i} should have line 11 executed`);
    }
  });
});

suite('Iteration Display — hover should use iteration data', () => {
  test('when stepping, getStep provides per-iteration value for hover', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());

    // Simulate stepping to iteration 3
    store.setIteration('L0', 3);
    const currentIter = store.getCurrentIteration('L0');
    const step = store.getStep('L0', currentIter);

    // Hover for 'myText' should show iteration 3's value, not aggregate
    assert.strictEqual(step.capturedValues.get('myText'), '123');
  });

  test('when showing all, no per-iteration data — hover uses aggregate', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    store.showAll('L0');

    assert.strictEqual(store.isShowingAll('L0'), true);
    // In show-all mode, hover falls back to aggregate capturedValues from ExecutionResult
  });
});

suite('Iteration Display — coverage per iteration', () => {
  test('per-iteration linesExecuted used for coverage when stepping', () => {
    const store = new IterationStore();
    store.load(makeRealLoopData());
    const step = store.setIteration('L0', 5);

    // Lines in the loop body should show as executed
    assert.ok(step.linesExecuted.has(10));
    assert.ok(step.linesExecuted.has(11));

    // Lines outside the loop should NOT be in linesExecuted
    assert.ok(!step.linesExecuted.has(1));
    assert.ok(!step.linesExecuted.has(9));
    assert.ok(!step.linesExecuted.has(12));
  });
});
