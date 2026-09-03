import * as assert from 'assert';
import {
  normalizeExecuteResponse,
  adaptUpstreamLoop,
  toDisplayValue,
} from '../../src/execution/upstreamExecuteNormalizer';
import { UpstreamLoop, UpstreamMessage, CapturedValue } from '../../src/execution/protocolV2Types';

function loop(partial: Partial<UpstreamLoop> & { id: number }): UpstreamLoop {
  return {
    scope: 'OnRun', file: 'src/X.al', line: 9, endLine: 12,
    iterationCount: partial.iterations?.length ?? 0, iterations: [],
    ...partial,
  } as UpstreamLoop;
}
function cap(v: Partial<CapturedValue> & { variableName: string }): CapturedValue {
  return { scopeName: 'OnRun', statementId: 0, value: v.value ?? 0, ...v } as CapturedValue;
}

suite('upstreamExecuteNormalizer', () => {
  suite('toDisplayValue', () => {
    test('primitives, null, and objects', () => {
      assert.strictEqual(toDisplayValue({ value: 'hi' } as any), 'hi');
      assert.strictEqual(toDisplayValue({ value: 6 } as any), '6');
      assert.strictEqual(toDisplayValue({ value: true } as any), 'true');
      assert.strictEqual(toDisplayValue({ value: null } as any), '');
      assert.strictEqual(toDisplayValue({ value: undefined } as any), '');
    });
    test('a capture error is distinct from a genuine null', () => {
      const err = toDisplayValue({ value: null, captureError: 'field read threw X' } as any);
      assert.notStrictEqual(err, '');
      assert.ok(err.includes('capture error'));
    });
  });

  suite('adaptUpstreamLoop', () => {
    test('filters the flat series by (loop, iteration), preserving order and duplicates', () => {
      const caps: CapturedValue[] = [
        cap({ variableName: 'i', value: 1, loop: 0, iteration: 1 }),
        cap({ variableName: 'total', value: 1, loop: 0, iteration: 1 }),
        cap({ variableName: 'i', value: 2, loop: 0, iteration: 2 }),
        cap({ variableName: 'x', value: 9, loop: 1, iteration: 1 }), // a different loop
        cap({ variableName: 'i', value: 99 }),                        // untagged (outside loops)
      ];
      const l = loop({ id: 0, iterations: [{ index: 1, statements: [2], lines: [10] }, { index: 2, statements: [2], lines: [10] }] });
      const data = adaptUpstreamLoop(l, caps, []);
      assert.strictEqual(data.loopId, '0');
      assert.deepStrictEqual(data.steps[0].capturedValues.map((c) => [c.variableName, c.value]), [['i', '1'], ['total', '1']]);
      assert.deepStrictEqual(data.steps[1].capturedValues.map((c) => [c.variableName, c.value]), [['i', '2']]);
      // the other loop's and the untagged record never leak in
      assert.ok(!data.steps.some((s) => s.capturedValues.some((c) => c.value === '9' || c.value === '99')));
    });

    test('keeps scopeName and statementId so a callee local is distinguishable', () => {
      const caps = [
        cap({ variableName: 'total', value: 3, scopeName: 'OnRun', statementId: 1, loop: 0, iteration: 1 }),
        cap({ variableName: 'total', value: 5, scopeName: 'Calc', statementId: 2, loop: 0, iteration: 1 }),
      ];
      const l = loop({ id: 0, iterations: [{ index: 1, statements: [1], lines: [7] }] });
      const step = adaptUpstreamLoop(l, caps, []).steps[0];
      assert.strictEqual(step.capturedValues.length, 2); // duplicates preserved in the adapter
      assert.deepStrictEqual(step.capturedValues.map((c) => c.scopeName), ['OnRun', 'Calc']);
    });

    test('messages are filtered and projected to text', () => {
      const msgs: UpstreamMessage[] = [
        { text: 'LOOP_1', loop: 0, iteration: 1 },
        { text: 'LOOP_2', loop: 0, iteration: 2 },
        { text: 'AFTER' }, // outside the loop
      ];
      const l = loop({ id: 0, iterations: [{ index: 1, statements: [], lines: [] }, { index: 2, statements: [], lines: [] }] });
      const data = adaptUpstreamLoop(l, [], msgs);
      assert.deepStrictEqual(data.steps[0].messages, ['LOOP_1']);
      assert.deepStrictEqual(data.steps[1].messages, ['LOOP_2']);
    });

    test('root loop, parent, unsegmentable, closedBy', () => {
      const root = adaptUpstreamLoop(loop({ id: 0, iterationCount: 2, iterations: [{ index: 1, statements: [], lines: [] }, { index: 2, statements: [], lines: [] }], closedBy: 'exit' }), [], []);
      assert.strictEqual(root.parentLoopId, null);
      assert.strictEqual(root.parentIteration, null);
      assert.strictEqual(root.closedBy, 'exit');

      const child = adaptUpstreamLoop(loop({ id: 2, parentLoop: 0, parentIteration: 2, iterations: [{ index: 1, statements: [], lines: [] }] }), [], []);
      assert.strictEqual(child.parentLoopId, '0');
      assert.strictEqual(child.parentIteration, 2);

      const unseg = adaptUpstreamLoop(loop({ id: 3, unsegmentable: 'emptyBody', iterations: [] }), [], []);
      assert.strictEqual(unseg.iterationCount, 0);
      assert.strictEqual(unseg.unsegmentable, 'emptyBody');
      assert.strictEqual(unseg.steps.length, 0);
    });
  });

  suite('detection', () => {
    test('upstream: tests[].loops present', () => {
      const r = normalizeExecuteResponse({
        tests: [{ name: 'X.OnRun', loops: [loop({ id: 0, iterations: [{ index: 1, statements: [2], lines: [10] }] })], capturedValues: [cap({ variableName: 'i', value: 1, loop: 0, iteration: 1 })] }],
        messages: [{ text: 'M', loop: 0, iteration: 1 }],
      });
      assert.strictEqual(r.shape, 'upstream');
      assert.strictEqual(r.iterations.length, 1);
      assert.strictEqual(r.capturedValues.length, 1);       // aggregate legacy projection rebuilt
      assert.deepStrictEqual(r.messages, ['M']);            // text projection
      assert.strictEqual(r.structuredMessages.length, 1);   // retained
    });

    test('fork: top-level iterations, no tests[].loops', () => {
      const r = normalizeExecuteResponse({
        tests: [{ name: 'X.OnRun' }],
        iterations: [{ loopId: 'L0', sourceFile: 'src/X.al', loopLine: 1, loopEndLine: 1, parentLoopId: null, parentIteration: null, iterationCount: 1, steps: [] }],
        capturedValues: [{ scopeName: 'OnRun', variableName: 'i', value: 1, statementId: 0 }],
        messages: ['M'],
      });
      assert.strictEqual(r.shape, 'fork');
      assert.strictEqual(r.iterations.length, 1);
      assert.deepStrictEqual(r.messages, ['M']);
    });

    test('none: tracking off (tests but no loops, no iterations) is not a warning shape', () => {
      const r = normalizeExecuteResponse({ tests: [{ name: 'X.OnRun', capturedValues: [] }] });
      assert.strictEqual(r.shape, 'none');
      assert.strictEqual(r.iterations.length, 0);
    });

    test('both shapes present: prefer upstream, flag conflict, never merge', () => {
      const r = normalizeExecuteResponse({
        tests: [{ name: 'X.OnRun', loops: [loop({ id: 0, iterations: [{ index: 1, statements: [], lines: [] }] })], capturedValues: [] }],
        iterations: [{ loopId: 'L0', sourceFile: 'src/X.al', loopLine: 1, loopEndLine: 1, parentLoopId: null, parentIteration: null, iterationCount: 5, steps: [] }],
      });
      assert.strictEqual(r.shape, 'upstream');
      assert.strictEqual(r.conflict, true);
      assert.strictEqual(r.iterations[0].loopId, '0'); // upstream, not the fork "L0"
    });

    test('multi-bundle: loop ids unique per response, captures filtered per test', () => {
      const r = normalizeExecuteResponse({
        tests: [
          { name: 'A.OnRun', loops: [loop({ id: 0, scope: 'OnRun', iterations: [{ index: 1, statements: [], lines: [] }] })], capturedValues: [cap({ variableName: 'i', value: 1, loop: 0, iteration: 1 })] },
          { name: 'B.OnRun', loops: [loop({ id: 1, scope: 'OnRun', iterations: [{ index: 1, statements: [], lines: [] }] })], capturedValues: [cap({ variableName: 'j', value: 7, loop: 1, iteration: 1 })] },
        ],
        messages: [{ text: 'A1', loop: 0, iteration: 1 }, { text: 'B1', loop: 1, iteration: 1 }],
      });
      assert.strictEqual(r.shape, 'upstream');
      assert.deepStrictEqual(r.iterations.map((i) => i.loopId), ['0', '1']);
      // A's capture only in loop 0's step, B's only in loop 1's — no cross-bundle mixing
      assert.deepStrictEqual(r.iterations[0].steps[0].capturedValues.map((c) => c.variableName), ['i']);
      assert.deepStrictEqual(r.iterations[1].steps[0].capturedValues.map((c) => c.variableName), ['j']);
      assert.strictEqual(r.iterations[0].steps[0].messages[0], 'A1');
      assert.strictEqual(r.iterations[1].steps[0].messages[0], 'B1');
    });

    test('unresolvedScopes surfaced from upstream tests', () => {
      const r = normalizeExecuteResponse({ tests: [{ name: 'X.OnRun', loops: [], capturedValues: [], unresolvedScopes: ['OnValidate@src/T.al'] }] });
      assert.deepStrictEqual(r.unresolvedScopes, ['OnValidate@src/T.al']);
    });
  });
});
