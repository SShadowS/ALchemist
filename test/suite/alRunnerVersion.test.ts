import * as assert from 'assert';
import { compareSemver, parseRunnerVersion, MIN_AL_RUNNER_VERSION } from '../../src/runner/alRunnerManager';

suite('AL.Runner version gate', () => {
  test('minimum is 2.7.0 — the release that ships the statement table and --dap stdio', () => {
    assert.strictEqual(MIN_AL_RUNNER_VERSION, '2.7.0');
  });

  test('compareSemver orders by major, then minor, then patch', () => {
    assert.ok(compareSemver('2.6.9', '2.7.0') < 0);
    assert.ok(compareSemver('2.7.0', '2.7.0') === 0);
    assert.ok(compareSemver('2.7.1', '2.7.0') > 0);
    assert.ok(compareSemver('3.0.0', '2.7.0') > 0);
    assert.ok(compareSemver('10.0.0', '9.9.9') > 0, 'numeric compare, not lexical');
  });

  test('compareSemver ignores a pre-release suffix', () => {
    assert.strictEqual(compareSemver('2.7.0-alpha.1', '2.7.0'), 0);
  });

  test('compareSemver zero-pads a version with fewer than three segments instead of producing NaN', () => {
    assert.strictEqual(compareSemver('2.7', '2.7.0'), 0);
    assert.ok(!Number.isNaN(compareSemver('2.7', '2.7.0')));
    assert.ok(!Number.isNaN(compareSemver('2.7.0', '2.7')));
    assert.ok(compareSemver('2', '2.0.1') < 0, "'2' behaves as '2.0.0'");
    assert.ok(compareSemver('2.8', '2.7.9') > 0);
  });

  test('parseRunnerVersion pulls the version out of --version output', () => {
    assert.strictEqual(parseRunnerVersion('2.7.0'), '2.7.0');
    assert.strictEqual(parseRunnerVersion('al-runner 2.7.0\n'), '2.7.0');
    assert.strictEqual(parseRunnerVersion('AL.Runner version 2.7.1 (build 42)'), '2.7.1');
  });

  test('parseRunnerVersion returns undefined when no version is present', () => {
    assert.strictEqual(parseRunnerVersion(''), undefined);
    assert.strictEqual(parseRunnerVersion('command not found'), undefined);
  });
});
