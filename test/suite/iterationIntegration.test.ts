// test/suite/iterationIntegration.test.ts
import * as assert from 'assert';
import { parseJsonOutput } from '../../src/runner/outputParser';
import { IterationStore } from '../../src/iteration/iterationStore';
import { buildCodeLenses } from '../../src/iteration/iterationCodeLensProvider';
import { findLoopAtCursor } from '../../src/iteration/iterationCommands';

suite('Iteration Integration', () => {
  const jsonWithIterations = JSON.stringify({
    tests: [{ name: 'TestLoop', status: 'pass', durationMs: 10 }],
    passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    messages: ['small: 10', 'small: 20', 'big: 30'],
    capturedValues: [{ scopeName: 'Run', variableName: 'Result', value: '30', statementId: 1 }],
    iterations: [{
      loopId: 'L0', loopLine: 3, loopEndLine: 10,
      parentLoopId: null, parentIteration: null, iterationCount: 3,
      steps: [
        { iteration: 1, capturedValues: [{ variableName: 'i', value: '1' }, { variableName: 'Result', value: '10' }], messages: ['small: 10'], linesExecuted: [3, 4, 5, 7, 8, 10] },
        { iteration: 2, capturedValues: [{ variableName: 'i', value: '2' }, { variableName: 'Result', value: '20' }], messages: ['small: 20'], linesExecuted: [3, 4, 5, 7, 8, 10] },
        { iteration: 3, capturedValues: [{ variableName: 'i', value: '3' }, { variableName: 'Result', value: '30' }], messages: ['big: 30'], linesExecuted: [3, 4, 5, 6, 10] },
      ],
    }],
  });

  test('full flow: parse → store → step → codelens → changed values', () => {
    // 1. Parse
    const parsed = parseJsonOutput(jsonWithIterations);
    assert.strictEqual(parsed.iterations.length, 1);

    // 2. Load store
    const store = new IterationStore();
    store.load(parsed.iterations);
    assert.strictEqual(store.getLoops().length, 1);

    // 3. Step to iteration 2
    const step2 = store.setIteration('L0', 2);
    assert.strictEqual(step2.capturedValues.get('Result'), '20');
    assert.deepStrictEqual(step2.messages, ['small: 20']);

    // 4. Step to iteration 3 — check changed values
    store.setIteration('L0', 3);
    const changed = store.getChangedValues('L0', 3);
    assert.ok(changed.includes('Result'));
    assert.ok(changed.includes('i'));

    // 5. Check lines executed changed (different branch)
    const step3 = store.getStep('L0', 3);
    assert.ok(step3.linesExecuted.has(6));    // then branch
    assert.ok(!step3.linesExecuted.has(7));   // else branch not taken
    assert.ok(!step3.linesExecuted.has(8));

    // 6. CodeLens shows correct iteration
    const lenses = buildCodeLenses(store);
    assert.ok(lenses.length > 0);
    const titles = lenses.map((l: any) => l.command?.title || '');
    assert.ok(titles.some((t: string) => t.includes('3') && t.includes('3')));

    // 7. Show All mode
    store.showAll('L0');
    assert.strictEqual(store.isShowingAll('L0'), true);
    const allLenses = buildCodeLenses(store);
    const allTitles = allLenses.map((l: any) => l.command?.title || '');
    assert.ok(allTitles.some((t: string) => t.includes('All')));

    // 8. Cursor-aware: cursor at line 5 → finds L0
    const loopId = findLoopAtCursor(store.getLoops(), 5);
    assert.strictEqual(loopId, 'L0');
  });

  test('backward compatible: no iterations field', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Test', status: 'pass', durationMs: 1 }],
      passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0,
    });
    const parsed = parseJsonOutput(json);
    assert.strictEqual(parsed.iterations.length, 0);

    const store = new IterationStore();
    store.load(parsed.iterations);
    assert.strictEqual(store.getLoops().length, 0);

    const lenses = buildCodeLenses(store);
    assert.strictEqual(lenses.length, 0);
  });
});
