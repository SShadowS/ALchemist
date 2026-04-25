import * as assert from 'assert';
import { buildRunnerArgs, shouldFallbackSingleFile } from '../../src/runner/executor';

suite('Executor', () => {
  suite('buildRunnerArgs', () => {
    test('scratch-standalone includes --output-json and --capture-values', () => {
      const { args, cwd } = buildRunnerArgs('scratch-standalone', '/tmp/scratch.al');
      assert.ok(args.includes('--output-json'));
      assert.ok(args.includes('--capture-values'));
      assert.ok(args.includes('/tmp/scratch.al'));
      assert.strictEqual(cwd, '/tmp');
    });

    test('scratch-project includes --coverage', () => {
      const { args, cwd } = buildRunnerArgs('scratch-project', '/tmp/scratch.al', '/workspace/src');
      assert.ok(args.includes('--output-json'));
      assert.ok(args.includes('--capture-values'));
      assert.ok(args.includes('--coverage'));
      assert.ok(args.includes('/workspace/src'));
      assert.ok(args.includes('/tmp/scratch.al'));
      assert.strictEqual(cwd, '/workspace/src');
    });

    test('test mode includes --output-json --capture-values --coverage', () => {
      const { args, cwd } = buildRunnerArgs('test', '/workspace/test.al', '/workspace');
      assert.ok(args.includes('--output-json'));
      assert.ok(args.includes('--capture-values'));
      assert.ok(args.includes('--coverage'));
      assert.strictEqual(cwd, '/workspace');
    });

    test('test mode with procedureName includes --run', () => {
      const { args } = buildRunnerArgs('test', '/workspace/test.al', '/workspace', 'TestCalcDiscount');
      assert.ok(args.includes('--run'));
      assert.ok(args.includes('TestCalcDiscount'));
      // --run should come before the cwd path
      const runIdx = args.indexOf('--run');
      const cwdIdx = args.lastIndexOf('/workspace');
      assert.ok(runIdx < cwdIdx, '--run should come before cwd path');
    });

    test('test mode without procedureName does not include --run', () => {
      const { args } = buildRunnerArgs('test', '/workspace/test.al', '/workspace');
      assert.ok(!args.includes('--run'));
    });

    test('scratch-project falls back to filePath dirname when no workspacePath', () => {
      const { cwd } = buildRunnerArgs('scratch-project', '/tmp/dir/scratch.al');
      assert.strictEqual(cwd, '/tmp/dir');
    });

    test('test mode falls back to filePath dirname when no workspacePath', () => {
      const { cwd } = buildRunnerArgs('test', '/workspace/src/test.al');
      assert.strictEqual(cwd, '/workspace/src');
    });

    test('scratch-standalone includes --iteration-tracking', () => {
      const { args } = buildRunnerArgs('scratch-standalone', '/tmp/scratch.al');
      assert.ok(args.includes('--iteration-tracking'));
    });

    test('scratch-project includes --iteration-tracking', () => {
      const { args } = buildRunnerArgs('scratch-project', '/tmp/scratch.al', '/workspace');
      assert.ok(args.includes('--iteration-tracking'));
    });

    test('test mode includes --iteration-tracking', () => {
      const { args } = buildRunnerArgs('test', '/workspace/test.al', '/workspace');
      assert.ok(args.includes('--iteration-tracking'));
    });
  });
});

suite('buildRunnerArgs — exit-code-aware behavior (test-mode)', () => {
  test('test mode builds project-scoped args', () => {
    const { args, cwd } = buildRunnerArgs('test', '/ws/main/src/T.al', '/ws/main');
    assert.deepStrictEqual(args, ['--output-json', '--capture-values', '--iteration-tracking', '--coverage', '/ws/main']);
    assert.strictEqual(cwd, '/ws/main');
  });

  test('test mode with procedureName inserts --run before path', () => {
    const { args } = buildRunnerArgs('test', '/ws/main/src/T.al', '/ws/main', 'MyProc');
    const runIdx = args.indexOf('--run');
    assert.ok(runIdx >= 0, '--run flag present');
    assert.strictEqual(args[runIdx + 1], 'MyProc');
    assert.strictEqual(args[args.length - 1], '/ws/main', 'path is last arg');
  });
});

suite('shouldFallbackSingleFile', () => {
  test('retries on AL compile error (exit 3)', () => {
    assert.strictEqual(shouldFallbackSingleFile(3, 0), true);
  });
  test('does not retry on assertion failure (exit 1, tests ran)', () => {
    assert.strictEqual(shouldFallbackSingleFile(1, 5), false);
  });
  test('does not retry on runner limitation (exit 2)', () => {
    assert.strictEqual(shouldFallbackSingleFile(2, 0), false);
  });
  test('does not retry on pass (exit 0)', () => {
    assert.strictEqual(shouldFallbackSingleFile(0, 5), false);
  });
  test('retries on exit 1 with zero tests (legacy AL.Runner < 1.0.12)', () => {
    assert.strictEqual(shouldFallbackSingleFile(1, 0), true);
  });
});
