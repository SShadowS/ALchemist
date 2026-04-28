import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

suite('WASM bundling smoke test', () => {
  const distRoot = path.resolve(__dirname, '../../../dist');

  test('tree-sitter.wasm is present in dist', () => {
    assert.ok(fs.existsSync(path.join(distRoot, 'tree-sitter.wasm')), 'tree-sitter.wasm missing');
  });

  test('tree-sitter-al.wasm is present in dist', () => {
    assert.ok(fs.existsSync(path.join(distRoot, 'tree-sitter-al.wasm')), 'tree-sitter-al.wasm missing');
  });
});
