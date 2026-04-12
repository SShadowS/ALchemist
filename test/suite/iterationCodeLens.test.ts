import * as assert from 'assert';
import * as path from 'path';
import { IterationStore } from '../../src/iteration/iterationStore';
import { buildCodeLenses } from '../../src/iteration/iterationCodeLensProvider';
import { IterationData } from '../../src/iteration/types';

const WS = '/ws';
const DOC_TEST_AL = path.resolve(WS, 'src/Test.al');

function makeSingleLoop(): IterationData[] {
  return [{
    loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 3, loopEndLine: 10,
    parentLoopId: null, parentIteration: null, iterationCount: 5,
    steps: [
      { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }], messages: [], linesExecuted: [3] },
      { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }], messages: [], linesExecuted: [3] },
      { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }], messages: [], linesExecuted: [3] },
      { iteration: 4, capturedValues: [{ variableName: 'i', value: '4' }], messages: [], linesExecuted: [3] },
      { iteration: 5, capturedValues: [{ variableName: 'i', value: '5' }], messages: [], linesExecuted: [3] },
    ],
  }];
}

suite('IterationCodeLensProvider', () => {
  test('returns lenses for loop with 2+ iterations', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.ok(lenses.length >= 3); // prev, next/info, showAll, table
  });

  test('returns no lenses when store is empty', () => {
    const store = new IterationStore();
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.strictEqual(lenses.length, 0);
  });

  test('returns no lenses for single-iteration loop', () => {
    const store = new IterationStore();
    store.load([{
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 1, loopEndLine: 3,
      parentLoopId: null, parentIteration: null, iterationCount: 1,
      steps: [{ iteration: 1, capturedValues: [], messages: [], linesExecuted: [1] }],
    }], WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    assert.strictEqual(lenses.length, 0);
  });

  test('lens line matches loopLine (0-indexed)', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    // loopLine is 3 (1-based) → Range should use line 2 (0-based)
    for (const lens of lenses) {
      assert.strictEqual(lens.range.start.line, 2);
    }
  });

  test('lens title shows current iteration', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    store.setIteration('L0', 3);
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const iterLens = titles.find((t: string) => t.includes('3') && t.includes('5'));
    assert.ok(iterLens, `Expected a lens showing "3 of 5", got: ${titles.join(', ')}`);
  });

  test('lens shows "All" when in showAll mode', () => {
    const store = new IterationStore();
    store.load(makeSingleLoop(), WS);
    store.showAll('L0');
    const lenses = buildCodeLenses(store, DOC_TEST_AL);
    const titles = lenses.map((l: any) => l.command?.title || '');
    const allLens = titles.find((t: string) => t.includes('All'));
    assert.ok(allLens, `Expected a lens with "All", got: ${titles.join(', ')}`);
  });
});
