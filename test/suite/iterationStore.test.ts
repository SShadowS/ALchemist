import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

function makeSingleLoop(): IterationData[] {
  return [{
    loopId: 'L0',
    loopLine: 3,
    loopEndLine: 10,
    parentLoopId: null,
    parentIteration: null,
    iterationCount: 5,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'Result', value: '10' }], messages: ['small: 10'], linesExecuted: [3, 4, 5, 7, 8, 10] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'Result', value: '20' }], messages: ['small: 20'], linesExecuted: [3, 4, 5, 7, 8, 10] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'Result', value: '30' }], messages: ['big: 30'], linesExecuted: [3, 4, 5, 6, 10] },
      { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }, { variableName: 'Result', value: '40' }], messages: ['big: 40'], linesExecuted: [3, 4, 5, 6, 10] },
      { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }, { variableName: 'Result', value: '50' }], messages: ['big: 50'], linesExecuted: [3, 4, 5, 6, 10] },
    ],
  }];
}

suite('IterationStore', () => {
  test('load populates loops', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const loops = store.getLoops();
    assert.strictEqual(loops.length, 1);
    assert.strictEqual(loops[0].loopId, 'L0');
    assert.strictEqual(loops[0].iterationCount, 5);
    assert.strictEqual(loops[0].currentIteration, 1);
  });

  test('getLoop returns loop info', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const loop = store.getLoop('L0');
    assert.strictEqual(loop.loopLine, 3);
    assert.strictEqual(loop.loopEndLine, 10);
  });

  test('getLoop throws for unknown loopId', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    assert.throws(() => store.getLoop('UNKNOWN'));
  });

  test('getStep returns iteration data', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.getStep('L0', 1);
    assert.strictEqual(step.iteration, 1);
    assert.strictEqual(step.capturedValues.get('i'), '1');
    assert.strictEqual(step.capturedValues.get('Result'), '10');
    assert.deepStrictEqual(step.messages, ['small: 10']);
    assert.ok(step.linesExecuted.has(3));
  });

  test('setIteration updates currentIteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.setIteration('L0', 3);
    assert.strictEqual(step.iteration, 3);
    assert.strictEqual(store.getLoop('L0').currentIteration, 3);
  });

  test('nextIteration advances by one', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 2);
    const step = store.nextIteration('L0');
    assert.strictEqual(step.iteration, 3);
  });

  test('nextIteration wraps at end', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 5);
    const step = store.nextIteration('L0');
    assert.strictEqual(step.iteration, 5);
  });

  test('prevIteration goes back by one', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 3);
    const step = store.prevIteration('L0');
    assert.strictEqual(step.iteration, 2);
  });

  test('prevIteration stops at first', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 1);
    const step = store.prevIteration('L0');
    assert.strictEqual(step.iteration, 1);
  });

  test('firstIteration jumps to 1', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 4);
    const step = store.firstIteration('L0');
    assert.strictEqual(step.iteration, 1);
  });

  test('lastIteration jumps to iterationCount', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    const step = store.lastIteration('L0');
    assert.strictEqual(step.iteration, 5);
  });

  test('showAll sets currentIteration to 0', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.setIteration('L0', 3);
    store.showAll('L0');
    assert.strictEqual(store.getLoop('L0').currentIteration, 0);
    assert.strictEqual(store.isShowingAll('L0'), true);
  });

  test('isShowingAll returns false when stepping', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    assert.strictEqual(store.isShowingAll('L0'), false);
  });

  test('clear resets all state', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop());
    store.clear();
    assert.strictEqual(store.getLoops().length, 0);
  });
});
