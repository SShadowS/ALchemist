import * as assert from 'assert';
import { StatusBarManager } from '../../src/output/statusBar';
import { ExecutionResult } from '../../src/runner/outputParser';

/**
 * Reach into the spy-mock StatusBarItem inside StatusBarManager.
 *
 * The manager exposes no getter for its internal `item` — these tests
 * assert against the mock by reading the private field directly. Tests
 * are unit-scoped: this is the only sanctioned way to verify the
 * tooltip composition without the real VS Code window.
 */
function getMainItem(sb: StatusBarManager): { tooltip: string | undefined; text: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = (sb as any).item;
  return internal;
}

function makeTestResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    mode: 'test',
    tests: [],
    messages: [],
    stderrOutput: [],
    summary: { passed: 0, failed: 0, errors: 0, total: 0 },
    coverage: [],
    exitCode: 0,
    durationMs: 42,
    capturedValues: [],
    cached: false,
    iterations: [],
    ...overrides,
  };
}

suite('StatusBarManager — tooltip composition', () => {
  test('setIdle composes base + v1 protocol line', () => {
    const sb = new StatusBarManager();
    try {
      sb.setIdle();
      const { tooltip } = getMainItem(sb);
      assert.ok(tooltip, 'tooltip must be set');
      // Base portion
      assert.ok(tooltip!.includes('ALchemist — Ready') || tooltip!.includes('ALchemist — Ready'),
        `expected base text "ALchemist — Ready" in tooltip; got: ${tooltip}`);
      // Default protocol line is v1 (no version reported yet)
      assert.ok(tooltip!.includes('AL.Runner protocol v1'),
        `expected v1 protocol line; got: ${tooltip}`);
    } finally {
      sb.dispose();
    }
  });

  test('setProtocolVersion(2) preserves base tooltip and updates protocol line', () => {
    const sb = new StatusBarManager();
    try {
      sb.setResult(makeTestResult({ durationMs: 123 }));
      sb.setProtocolVersion(2);
      const { tooltip } = getMainItem(sb);
      assert.ok(tooltip, 'tooltip must be set');
      // Base survives
      assert.ok(tooltip!.includes('123ms'),
        `expected base text containing 123ms; got: ${tooltip}`);
      assert.ok(tooltip!.includes('Coverage:'),
        `expected base text containing Coverage:; got: ${tooltip}`);
      // Protocol line is v2
      assert.ok(tooltip!.includes('AL.Runner protocol v2'),
        `expected v2 protocol line; got: ${tooltip}`);
      assert.ok(!tooltip!.includes('protocol v1'),
        `should not show v1 line when v2 is set; got: ${tooltip}`);
    } finally {
      sb.dispose();
    }
  });

  test('setProtocolVersion(undefined) shows v1 (upgrade) line', () => {
    const sb = new StatusBarManager();
    try {
      sb.setIdle();
      sb.setProtocolVersion(undefined);
      const { tooltip } = getMainItem(sb);
      assert.ok(tooltip!.includes('AL.Runner protocol v1 (upgrade for live updates)'),
        `expected v1 upgrade-hint line; got: ${tooltip}`);
    } finally {
      sb.dispose();
    }
  });

  test('subsequent setBaseTooltip-driven mutations preserve v2 protocol line', () => {
    // Regression: the previous fragile `tooltip.includes('protocol')` heuristic
    // could lose the protocol line on a second base-tooltip mutation. The
    // refactored composition holds `baseTooltip` separately, so multiple
    // mutations should always render the protocol line exactly once.
    const sb = new StatusBarManager();
    try {
      sb.setProtocolVersion(2);
      sb.setRunning('test');
      sb.setResult(makeTestResult({ durationMs: 50 }));
      sb.setIdle();
      const { tooltip } = getMainItem(sb);
      assert.ok(tooltip!.includes('ALchemist — Ready') || tooltip!.includes('ALchemist — Ready'),
        `final base should be Ready; got: ${tooltip}`);
      // Exactly one occurrence of the protocol line.
      const occurrences = (tooltip!.match(/AL\.Runner protocol v2/g) || []).length;
      assert.strictEqual(occurrences, 1,
        `expected exactly one v2 protocol line after multiple base mutations; got ${occurrences}: ${tooltip}`);
    } finally {
      sb.dispose();
    }
  });

  test('protocol line never appears in base tooltip portion', () => {
    // Sanity: verify the structural separation. Splitting on the newline
    // should yield a base portion (no "protocol") and a protocol portion.
    const sb = new StatusBarManager();
    try {
      sb.setProtocolVersion(2);
      sb.setIdle();
      const { tooltip } = getMainItem(sb);
      const lines = (tooltip ?? '').split('\n');
      assert.ok(lines.length >= 2, `expected multi-line tooltip; got: ${tooltip}`);
      // The last line is the protocol line.
      assert.ok(lines[lines.length - 1].startsWith('AL.Runner protocol'),
        `last tooltip line should be protocol; got: ${tooltip}`);
      // Earlier lines shouldn't carry the protocol marker.
      for (let i = 0; i < lines.length - 1; i++) {
        assert.ok(!lines[i].includes('AL.Runner protocol'),
          `base tooltip line ${i} unexpectedly contains protocol marker; got: ${tooltip}`);
      }
    } finally {
      sb.dispose();
    }
  });
});
