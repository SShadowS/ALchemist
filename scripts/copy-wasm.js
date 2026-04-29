const fs = require('fs');
const path = require('path');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ${src} -> ${dest}`);
}

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

// web-tree-sitter ships the WASM as web-tree-sitter.wasm (not tree-sitter.wasm)
// We copy it to dist/tree-sitter.wasm which is the name web-tree-sitter expects at runtime.
const treeSitterWasmCandidates = [
  path.join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
];
const treeSitterWasm = treeSitterWasmCandidates.find(p => fs.existsSync(p));
if (!treeSitterWasm) {
  throw new Error(`tree-sitter.wasm not found in: ${treeSitterWasmCandidates.join(', ')}`);
}
copy(treeSitterWasm, path.join(dist, 'tree-sitter.wasm'));

const alWasmCandidates = [
  path.join(root, 'node_modules', '@sshadows', 'tree-sitter-al', 'tree-sitter-al.wasm'),
  path.join(root, 'node_modules', '@sshadows', 'tree-sitter-al', 'prebuilds', 'tree-sitter-al.wasm'),
];
const alWasm = alWasmCandidates.find(p => fs.existsSync(p));
if (!alWasm) {
  throw new Error(`tree-sitter-al.wasm not found in: ${alWasmCandidates.join(', ')}`);
}
copy(alWasm, path.join(dist, 'tree-sitter-al.wasm'));
