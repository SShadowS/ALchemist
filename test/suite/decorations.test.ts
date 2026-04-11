import * as assert from 'assert';
import { distributeMessages } from '../../src/editor/decorations';

suite('Decorations', () => {
  suite('distributeMessages', () => {
    test('single call single message', () => {
      const result = distributeMessages(1, ['hello']);
      assert.strictEqual(result.get(0)!.display, 'hello');
      assert.strictEqual(result.get(0)!.allValues, undefined);
    });

    test('single call multiple messages shows compact format', () => {
      const msgs = ['Count: 1', 'Count: 2', 'Count: 3', 'Count: 4', 'Count: 5'];
      const result = distributeMessages(1, msgs);
      const entry = result.get(0)!;
      assert.ok(entry.display.includes('Count: 1'));
      assert.ok(entry.display.includes('Count: 5'));
      assert.ok(entry.display.includes('\u00D75')); // x5
      assert.strictEqual(entry.allValues!.length, 5);
    });

    test('two calls two messages', () => {
      const result = distributeMessages(2, ['hello', 'world']);
      assert.strictEqual(result.get(0)!.display, 'hello');
      assert.strictEqual(result.get(1)!.display, 'world');
    });

    test('three calls twelve messages distributes correctly', () => {
      const msgs = ['Hello', 'C:1', 'C:2', 'C:3', 'C:4', 'C:5', 'C:6', 'C:7', 'C:8', 'C:9', 'C:10', 'World'];
      const result = distributeMessages(3, msgs);
      // First call -> first message
      assert.strictEqual(result.get(0)!.display, 'Hello');
      // Last call -> last message
      assert.strictEqual(result.get(2)!.display, 'World');
      // Middle call -> compact format with all 10 loop values
      const middle = result.get(1)!;
      assert.ok(middle.display.includes('C:1'));
      assert.ok(middle.display.includes('C:10'));
      assert.ok(middle.display.includes('\u00D710')); // x10
    });

    test('two values uses pipe separator', () => {
      const result = distributeMessages(1, ['a', 'b']);
      assert.strictEqual(result.get(0)!.display, 'a | b');
    });

    test('three values uses pipe separator', () => {
      const result = distributeMessages(1, ['a', 'b', 'c']);
      assert.strictEqual(result.get(0)!.display, 'a | b | c');
    });

    test('empty messages returns empty map', () => {
      const result = distributeMessages(2, []);
      assert.strictEqual(result.size, 0);
    });

    test('zero calls returns empty map', () => {
      const result = distributeMessages(0, ['hello']);
      assert.strictEqual(result.size, 0);
    });
  });
});
