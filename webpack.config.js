//@ts-check
'use strict';

const path = require('path');
const { execSync } = require('child_process');

class CopyWasmPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyWasmPlugin', () => {
      execSync('node scripts/copy-wasm.js', { stdio: 'inherit', cwd: path.resolve(__dirname) });
    });
  }
}

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.build.json' } }]
      }
    ]
  },
  devtool: 'nosources-source-map',
  plugins: [new CopyWasmPlugin()]
};

module.exports = config;
