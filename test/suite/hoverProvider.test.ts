import * as assert from 'assert';
import { IterationStore } from '../../src/iteration/iterationStore';
import { IterationData } from '../../src/iteration/types';

suite('HoverProvider', () => {
  // Test the deduplication logic directly
  test('last captured value wins when multiple exist for same variable', () => {
    // Simulate what buildHover does: filter by variable name, take last
    const capturedValues = [
      { scopeName: 'Scope1', variableName: 'Txt2', value: 'Hello', statementId: 1 },
      { scopeName: 'Scope2', variableName: 'Txt2', value: 'World', statementId: 0 },
    ];
    const hoveredWord = 'Txt2';
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === hoveredWord.toLowerCase()
    );
    const lastValue = matching[matching.length - 1].value;
    assert.strictEqual(lastValue, 'World');
    assert.strictEqual(matching.length, 2); // two matches
  });

  test('variable matching is case-insensitive', () => {
    const capturedValues = [
      { scopeName: 'Scope', variableName: 'MyVar', value: '42', statementId: 0 },
    ];
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === 'myvar'
    );
    assert.strictEqual(matching.length, 1);
  });

  test('no match for unknown variable', () => {
    const capturedValues = [
      { scopeName: 'Scope', variableName: 'X', value: '1', statementId: 0 },
    ];
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === 'y'
    );
    assert.strictEqual(matching.length, 0);
  });
});

suite('HoverProvider — iteration-aware', () => {
  function makeLoopData(): IterationData[] {
    return [{
      loopId: 'L0', sourceFile: 'src/Test.al', loopLine: 10, loopEndLine: 11,
      parentLoopId: null, parentIteration: null, iterationCount: 5,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'myText', value: '1' }], messages: [], linesExecuted: [10, 11] },
        { iteration: 2, capturedValues: [{ variableName: 'myText', value: '12' }], messages: [], linesExecuted: [10, 11] },
        { iteration: 3, capturedValues: [{ variableName: 'myText', value: '123' }], messages: [], linesExecuted: [10, 11] },
        { iteration: 4, capturedValues: [{ variableName: 'myText', value: '1234' }], messages: [], linesExecuted: [10, 11] },
        { iteration: 5, capturedValues: [{ variableName: 'myText', value: '12345' }], messages: [], linesExecuted: [10, 11] },
      ],
    }];
  }

  test('when stepping, store provides per-iteration value (not aggregate)', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 3);

    // Hover should use store's per-iteration value
    const step = store.getStep('L0', store.getCurrentIteration('L0'));
    assert.strictEqual(step.capturedValues.get('myText'), '123');
    // NOT '12345' (the aggregate last value)
  });

  test('when stepping, linesExecuted shows coverage for current iteration', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.setIteration('L0', 2);

    const step = store.getStep('L0', store.getCurrentIteration('L0'));
    assert.ok(step.linesExecuted.has(10), 'loop line should be covered');
    assert.ok(step.linesExecuted.has(11), 'body line should be covered');
    assert.ok(!step.linesExecuted.has(9), 'line before loop should not be covered');
  });

  test('when showing all, iteration store reports show-all mode', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');
    store.showAll('L0');

    assert.ok(store.isShowingAll('L0'));
    // In show-all, hover falls back to aggregate — tested via existing hover tests
  });

  test('stepping through iterations gives correct sequence of values', () => {
    const store = new IterationStore();
    store.load(makeLoopData(), '/ws');

    const expected = ['1', '12', '123', '1234', '12345'];
    for (let i = 1; i <= 5; i++) {
      const step = store.setIteration('L0', i);
      assert.strictEqual(step.capturedValues.get('myText'), expected[i - 1],
        `iteration ${i} should have myText = ${expected[i - 1]}`);
    }
  });

  test('full series hover: multiple captures for same variable yield all values', () => {
    // The new buildAggregateHover behavior emits one line per capture
    // (with `// capture #N` index suffixes) instead of just the last value.
    // Verify the data shape that drives that rendering: matching.length > 1.
    const capturedValues = [
      { scopeName: 'Scope', variableName: 'sum', value: '1', statementId: 0 },
      { scopeName: 'Scope', variableName: 'sum', value: '3', statementId: 0 },
      { scopeName: 'Scope', variableName: 'sum', value: '6', statementId: 0 },
      { scopeName: 'Scope', variableName: 'sum', value: '10', statementId: 0 },
      { scopeName: 'Scope', variableName: 'sum', value: '15', statementId: 0 },
    ];
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === 'sum'
    );
    assert.strictEqual(matching.length, 5, 'all five captures present');
    // Hover would render: 'sum = 1  // capture #1' through 'sum = 15  // capture #5'.
    // We don't drive provideHover here (existing test pattern); we just
    // confirm the data filter returns the FULL series so the renderer has
    // material to display.
    assert.deepStrictEqual(
      matching.map(cv => cv.value),
      ['1', '3', '6', '10', '15'],
    );
  });
});
