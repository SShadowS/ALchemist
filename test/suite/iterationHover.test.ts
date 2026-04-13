import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

function makeLoopData(): IterationData[] {
  return [{
    loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 10, loopEndLine: 12,
    parentLoopId: null, parentIteration: null, iterationCount: 3,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'total', value: '1' }], messages: ['msg1'], linesExecuted: [10, 11, 12] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'total', value: '3' }], messages: ['msg2'], linesExecuted: [10, 11, 12] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'total', value: '6' }], messages: ['msg3'], linesExecuted: [10, 11, 12] },
    ],
  }];
}

suite('Iteration Hover — data for command URIs', () => {
  test('store provides changed values for hover display', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 2);

    const changed = store.getChangedValues('L0', 2);
    assert.ok(changed.includes('i'));
    assert.ok(changed.includes('total'));

    const step = store.getStep('L0', 2);
    assert.strictEqual(step.capturedValues.get('total'), '3');

    const prevStep = store.getStep('L0', 1);
    assert.strictEqual(prevStep.capturedValues.get('total'), '1');
  });

  test('store provides messages for rich hover', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 2);

    const step = store.getStep('L0', 2);
    assert.deepStrictEqual(step.messages, ['msg2']);
  });

  test('command URI encoding produces valid format', () => {
    const loopId = 'L0';
    const encoded = encodeURIComponent(JSON.stringify([loopId]));
    const uri = `command:alchemist.iterationNext?${encoded}`;
    assert.ok(uri.startsWith('command:alchemist.iterationNext?'));
    assert.ok(uri.includes(encodeURIComponent('"L0"')));
  });

  test('show-all mode detected for nav-only hover', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');

    assert.ok(store.isShowingAll('L0'));

    const loop = store.getLoop('L0');
    assert.strictEqual(loop.iterationCount, 3);
  });
});
