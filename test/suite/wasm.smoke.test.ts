import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

suite('WASM bundling smoke test', () => {
  test('tree-sitter.wasm is present in dist', () => {
    const distRoot = path.resolve(__dirname, '../../../dist');
    assert.ok(fs.existsSync(path.join(distRoot, 'tree-sitter.wasm')), 'tree-sitter.wasm missing');
  });

  test('tree-sitter-al.wasm is present in dist', () => {
    const distRoot = path.resolve(__dirname, '../../../dist');
    assert.ok(fs.existsSync(path.join(distRoot, 'tree-sitter-al.wasm')), 'tree-sitter-al.wasm missing');
  });
});
