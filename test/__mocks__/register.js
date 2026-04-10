// Register vscode mock for mocha tests running outside VS Code
const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return path.join(__dirname, 'vscode.js');
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
