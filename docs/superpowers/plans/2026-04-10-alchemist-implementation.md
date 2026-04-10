# ALchemist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VSCode extension that provides Quokka.js-style live execution and inline feedback for AL (Business Central), powered by BusinessCentral.AL.Runner.

**Architecture:** TypeScript VSCode extension invoking AL.Runner CLI as a child process. Parses stdout (PASS/FAIL/ERROR lines, Message output) and Cobertura XML for coverage. Results displayed via inline editor decorations, gutter icons, output channel, status bar, and VSCode Test Explorer integration. Two modes: scratch pad for quick experiments, test runner for project tests.

**Tech Stack:** TypeScript, VSCode Extension API, webpack (bundler), mocha + sinon (tests), fast-xml-parser (Cobertura XML parsing)

**v1 Limitation:** AL.Runner's Cobertura XML records binary coverage only (hits: 0 or 1), not actual hit counts. The `// ×N` hit count annotations shown in the design mockup are deferred to Phase 2 when AL.Runner gains richer output. v1 shows covered/not-covered gutter dots and hover tooltips.

---

## File Structure

```
alchemist/
├── src/
│   ├── extension.ts              # Activation, deactivation, wiring
│   ├── runner/
│   │   ├── alRunnerManager.ts    # Download, locate, version-check AL.Runner
│   │   ├── executor.ts           # Spawn al-runner CLI, collect output
│   │   └── outputParser.ts       # Parse stdout + Cobertura XML
│   ├── editor/
│   │   ├── decorations.ts        # Inline ghost text + gutter icon decorations
│   │   └── hoverProvider.ts      # Coverage tooltips on hover
│   ├── scratch/
│   │   └── scratchManager.ts     # Create/manage scratch files, detect directives
│   ├── testing/
│   │   ├── testDiscovery.ts      # Find test codeunits in workspace
│   │   └── testController.ts     # VSCode Test Explorer integration
│   └── output/
│       ├── outputChannel.ts      # ALchemist output panel formatting
│       └── statusBar.ts          # Status bar item
├── resources/
│   ├── gutter-green.svg          # Covered line gutter icon
│   ├── gutter-red.svg            # Error line gutter icon
│   ├── gutter-gray.svg           # Not-covered line gutter icon
│   └── scratch-template.al       # Default scratch file template
├── test/
│   ├── suite/
│   │   ├── outputParser.test.ts  # Unit tests for output parser
│   │   ├── testDiscovery.test.ts # Unit tests for test discovery
│   │   └── scratchManager.test.ts # Unit tests for scratch detection
│   └── runTest.ts                # Mocha test runner entry point
├── package.json
├── tsconfig.json
├── webpack.config.js
├── .vscodeignore
└── .gitignore
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `webpack.config.js`
- Create: `.vscodeignore`
- Create: `.gitignore`
- Create: `test/runTest.ts`

- [ ] **Step 1: Initialize the project**

```bash
cd U:/Git/ALchemist
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install --save fast-xml-parser
npm install --save-dev @types/vscode @types/mocha @types/sinon @types/node typescript mocha sinon ts-loader webpack webpack-cli @vscode/test-electron glob
```

- [ ] **Step 3: Write package.json**

Replace the generated `package.json` with the full extension manifest:

```json
{
  "name": "alchemist",
  "displayName": "ALchemist",
  "description": "Quokka-style live execution and inline feedback for AL (Business Central)",
  "version": "0.1.0",
  "publisher": "alchemist",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/TODO/alchemist"
  },
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Testing", "Debuggers", "Other"],
  "keywords": ["AL", "Business Central", "Dynamics 365", "test runner", "live coding"],
  "activationEvents": ["onLanguage:al"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "alchemist.newScratchFile", "title": "ALchemist: New Scratch File" },
      { "command": "alchemist.toggleProjectContext", "title": "ALchemist: Toggle Project Context" },
      { "command": "alchemist.deleteScratchFile", "title": "ALchemist: Delete Scratch File" },
      { "command": "alchemist.saveScratchAs", "title": "ALchemist: Save Scratch As..." },
      { "command": "alchemist.runNow", "title": "ALchemist: Run Now" },
      { "command": "alchemist.stopRun", "title": "ALchemist: Stop Run" },
      { "command": "alchemist.clearDecorations", "title": "ALchemist: Clear Results" },
      { "command": "alchemist.showOutput", "title": "ALchemist: Show Output" }
    ],
    "keybindings": [
      { "command": "alchemist.newScratchFile", "key": "ctrl+shift+a n" },
      { "command": "alchemist.runNow", "key": "ctrl+shift+a r" },
      { "command": "alchemist.clearDecorations", "key": "ctrl+shift+a c" }
    ],
    "configuration": {
      "title": "ALchemist",
      "properties": {
        "alchemist.alRunnerPath": {
          "type": "string",
          "default": "",
          "description": "Custom path to al-runner binary. Leave empty for auto-managed."
        },
        "alchemist.dotnetPath": {
          "type": "string",
          "default": "",
          "description": "Custom path to dotnet SDK."
        },
        "alchemist.runOnSave": {
          "type": "boolean",
          "default": true,
          "description": "Execute automatically on file save."
        },
        "alchemist.testRunOnSave": {
          "type": "string",
          "enum": ["current", "all", "off"],
          "default": "current",
          "description": "Which tests to run on save."
        },
        "alchemist.showOutputOnError": {
          "type": "string",
          "enum": ["always", "never", "onlyOnFailure"],
          "default": "onlyOnFailure",
          "description": "When to auto-focus the output panel."
        },
        "alchemist.showInlineMessages": {
          "type": "boolean",
          "default": true,
          "description": "Show Message()/Error() output inline in the editor."
        },
        "alchemist.showGutterCoverage": {
          "type": "boolean",
          "default": true,
          "description": "Show coverage gutter indicators."
        },
        "alchemist.showHitCounts": {
          "type": "boolean",
          "default": true,
          "description": "Show hit counts on repeated lines (requires AL.Runner API — Phase 2)."
        },
        "alchemist.dimUncoveredLines": {
          "type": "boolean",
          "default": true,
          "description": "Reduce opacity of lines not reached."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "webpack",
    "watch": "webpack --watch",
    "package": "webpack --mode production --devtool hidden-source-map",
    "test-compile": "tsc -p ./tsconfig.json",
    "test": "npm run test-compile && node ./out/test/runTest.js",
    "lint": "eslint src"
  },
  "devDependencies": {},
  "dependencies": {}
}
```

Note: `devDependencies` and `dependencies` will be populated by the npm install step. The versions above are placeholders — npm install handles actual versions.

- [ ] **Step 4: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": ".",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Write webpack.config.js**

```js
//@ts-check
'use strict';

const path = require('path');

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
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  devtool: 'nosources-source-map'
};

module.exports = config;
```

- [ ] **Step 6: Write .vscodeignore**

```
.vscode/**
src/**
test/**
out/**
node_modules/**
.gitignore
webpack.config.js
tsconfig.json
**/*.map
```

- [ ] **Step 7: Write .gitignore**

```
node_modules/
out/
dist/
*.vsix
.superpowers/
```

- [ ] **Step 8: Write test runner entry point**

Create `test/runTest.ts`:

```typescript
import * as path from 'path';
import * as Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true });
  const testsRoot = path.resolve(__dirname, 'suite');
  const files = await glob('**/*.test.js', { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
```

- [ ] **Step 9: Write minimal extension.ts stub**

Create `src/extension.ts`:

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  // Will be wired up in Task 12
}

export function deactivate(): void {
  // Cleanup will be added in Task 12
}
```

- [ ] **Step 10: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: builds successfully, creates `dist/extension.js`.

- [ ] **Step 11: Commit**

```bash
git init
git add package.json tsconfig.json webpack.config.js .vscodeignore .gitignore src/extension.ts test/runTest.ts
git commit -m "chore: scaffold ALchemist VSCode extension"
```

---

### Task 2: Output Parser — Test Results

**Files:**
- Create: `src/runner/outputParser.ts`
- Create: `test/suite/outputParser.test.ts`

This is the core parsing logic — pure functions, no VSCode dependency. Full TDD.

**AL.Runner stdout format reference:**
- `PASS  TestName (Nms)` — passing test
- `FAIL  TestName` followed by indented error + stack — failing test
- `ERROR TestName` followed by indented error + stack — errored test
- Bare lines between test results — `Message()` output
- Final line: `Results: N passed, M failed, E errors, T total`
- `-e` mode: bare `Message()` output on stdout, errors on stderr, no PASS/FAIL lines

- [ ] **Step 1: Define result types**

Create `src/runner/outputParser.ts`:

```typescript
export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'errored';
  durationMs: number | undefined;
  message: string | undefined;
  stackTrace: string | undefined;
}

export interface CoverageEntry {
  className: string;
  filename: string;
  lineRate: number;
  lines: Array<{ number: number; hits: number }>;
}

export interface RunSummary {
  passed: number;
  failed: number;
  errors: number;
  total: number;
}

export interface ExecutionResult {
  mode: 'test' | 'scratch';
  tests: TestResult[];
  messages: string[];
  stderrOutput: string[];
  summary: RunSummary | undefined;
  coverage: CoverageEntry[];
  exitCode: number;
  durationMs: number;
}
```

- [ ] **Step 2: Write failing tests for test result parsing**

Create `test/suite/outputParser.test.ts`:

```typescript
import * as assert from 'assert';
import { parseTestOutput, parseRunSummary } from '../../src/runner/outputParser';

suite('OutputParser', () => {
  suite('parseTestOutput', () => {
    test('parses a passing test', () => {
      const stdout = 'PASS  TestCalcDiscount (3ms)\n';
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestCalcDiscount');
      assert.strictEqual(result.tests[0].status, 'passed');
      assert.strictEqual(result.tests[0].durationMs, 3);
    });

    test('parses a failing test with assertion message', () => {
      const stdout = [
        'FAIL  TestGreeting',
        '      Assert.AreEqual failed. Expected: <Goodbye>, Actual: <Hello>. Greeting should match',
        '      at Codeunit50906+TestGreet_Scope_12345.OnRun()',
        '      at System.Reflection.MethodInvoker.Invoke()',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestGreeting');
      assert.strictEqual(result.tests[0].status, 'failed');
      assert.strictEqual(result.tests[0].message, 'Assert.AreEqual failed. Expected: <Goodbye>, Actual: <Hello>. Greeting should match');
      assert.ok(result.tests[0].stackTrace!.includes('Codeunit50906'));
    });

    test('parses an errored test', () => {
      const stdout = [
        'ERROR TestUnsupported',
        '      NotSupportedException: Page objects not supported',
        '      Inject this dependency via an AL interface.',
        '      at SomeStackFrame()',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 1);
      assert.strictEqual(result.tests[0].name, 'TestUnsupported');
      assert.strictEqual(result.tests[0].status, 'errored');
      assert.ok(result.tests[0].message!.includes('NotSupportedException'));
    });

    test('parses multiple tests in sequence', () => {
      const stdout = [
        'PASS  TestA (1ms)',
        'PASS  TestB (2ms)',
        'FAIL  TestC',
        '      Some error',
        '',
        'Results: 2 passed, 1 failed, 0 errors, 3 total',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.strictEqual(result.tests.length, 3);
      assert.strictEqual(result.tests[0].status, 'passed');
      assert.strictEqual(result.tests[1].status, 'passed');
      assert.strictEqual(result.tests[2].status, 'failed');
    });

    test('captures Message() output as messages', () => {
      const stdout = [
        'Hello from AL',
        'PASS  TestA (0ms)',
        'Item count: 5',
        'PASS  TestB (1ms)',
      ].join('\n');
      const result = parseTestOutput(stdout);
      assert.deepStrictEqual(result.messages, ['Hello from AL', 'Item count: 5']);
    });

    test('handles empty output', () => {
      const result = parseTestOutput('');
      assert.strictEqual(result.tests.length, 0);
      assert.strictEqual(result.messages.length, 0);
    });
  });

  suite('parseRunSummary', () => {
    test('parses summary line', () => {
      const line = 'Results: 3 passed, 1 failed, 0 errors, 4 total';
      const summary = parseRunSummary(line);
      assert.deepStrictEqual(summary, { passed: 3, failed: 1, errors: 0, total: 4 });
    });

    test('returns undefined for non-summary line', () => {
      const summary = parseRunSummary('PASS  TestA (1ms)');
      assert.strictEqual(summary, undefined);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm run test-compile && npx mocha out/test/suite/outputParser.test.js
```

Expected: FAIL — `parseTestOutput` and `parseRunSummary` are not defined.

- [ ] **Step 4: Implement test result parsing**

Add to `src/runner/outputParser.ts`:

```typescript
const PASS_REGEX = /^PASS\s{2}(\S+)\s+\((\d+)ms\)$/;
const FAIL_REGEX = /^FAIL\s{2}(\S+)$/;
const ERROR_REGEX = /^ERROR\s+(\S+)$/;
const SUMMARY_REGEX = /^Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+errors,\s+(\d+)\s+total$/;
const INDENT_REGEX = /^\s{6}/;

export function parseRunSummary(line: string): RunSummary | undefined {
  const m = line.match(SUMMARY_REGEX);
  if (!m) return undefined;
  return {
    passed: parseInt(m[1], 10),
    failed: parseInt(m[2], 10),
    errors: parseInt(m[3], 10),
    total: parseInt(m[4], 10),
  };
}

export function parseTestOutput(stdout: string): { tests: TestResult[]; messages: string[]; summary: RunSummary | undefined } {
  const lines = stdout.split('\n');
  const tests: TestResult[] = [];
  const messages: string[] = [];
  let summary: RunSummary | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Try PASS
    const passMatch = line.match(PASS_REGEX);
    if (passMatch) {
      tests.push({
        name: passMatch[1],
        status: 'passed',
        durationMs: parseInt(passMatch[2], 10),
        message: undefined,
        stackTrace: undefined,
      });
      i++;
      continue;
    }

    // Try FAIL
    const failMatch = line.match(FAIL_REGEX);
    if (failMatch) {
      const { message, stackTrace, nextIndex } = collectIndentedBlock(lines, i + 1);
      tests.push({
        name: failMatch[1],
        status: 'failed',
        durationMs: undefined,
        message,
        stackTrace,
      });
      i = nextIndex;
      continue;
    }

    // Try ERROR
    const errorMatch = line.match(ERROR_REGEX);
    if (errorMatch) {
      const { message, stackTrace, nextIndex } = collectIndentedBlock(lines, i + 1);
      tests.push({
        name: errorMatch[1],
        status: 'errored',
        durationMs: undefined,
        message,
        stackTrace,
      });
      i = nextIndex;
      continue;
    }

    // Try summary
    const summaryMatch = parseRunSummary(line);
    if (summaryMatch) {
      summary = summaryMatch;
      i++;
      continue;
    }

    // Non-empty, non-matched lines are Message() output
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      messages.push(trimmed);
    }

    i++;
  }

  return { tests, messages, summary };
}

function collectIndentedBlock(lines: string[], startIndex: number): { message: string; stackTrace: string; nextIndex: number } {
  const detailLines: string[] = [];
  let i = startIndex;
  while (i < lines.length && INDENT_REGEX.test(lines[i])) {
    detailLines.push(lines[i].trim());
    i++;
  }
  const message = detailLines[0] || '';
  const stackTrace = detailLines.slice(1).join('\n');
  return { message, stackTrace, nextIndex: i };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test-compile && npx mocha out/test/suite/outputParser.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runner/outputParser.ts test/suite/outputParser.test.ts
git commit -m "feat: add test result and message output parser with tests"
```

---

### Task 3: Output Parser — Cobertura XML Coverage

**Files:**
- Modify: `src/runner/outputParser.ts`
- Modify: `test/suite/outputParser.test.ts`

- [ ] **Step 1: Write failing tests for Cobertura parsing**

Append to `test/suite/outputParser.test.ts`:

```typescript
import { parseCoberturaXml } from '../../src/runner/outputParser';

suite('parseCoberturaXml', () => {
  test('parses coverage entries from XML', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.7143" lines-covered="5" lines-valid="7" version="1.0" timestamp="1712764800">
  <sources><source>.</source></sources>
  <packages>
    <package name="al-source" line-rate="0.7143">
      <classes>
        <class name="Calculator" filename="src/Calculator.al" line-rate="1.0000">
          <lines>
            <line number="5" hits="1" />
            <line number="6" hits="1" />
            <line number="7" hits="1" />
          </lines>
        </class>
        <class name="Validator" filename="src/Validator.al" line-rate="0.5000">
          <lines>
            <line number="3" hits="1" />
            <line number="4" hits="0" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    assert.strictEqual(entries.length, 2);

    assert.strictEqual(entries[0].className, 'Calculator');
    assert.strictEqual(entries[0].filename, 'src/Calculator.al');
    assert.strictEqual(entries[0].lines.length, 3);
    assert.deepStrictEqual(entries[0].lines[0], { number: 5, hits: 1 });

    assert.strictEqual(entries[1].className, 'Validator');
    assert.strictEqual(entries[1].lines.length, 2);
    assert.deepStrictEqual(entries[1].lines[1], { number: 4, hits: 0 });
  });

  test('handles missing coverage XML gracefully', async () => {
    const entries = parseCoberturaXml('');
    assert.strictEqual(entries.length, 0);
  });

  test('handles single class (non-array)', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1.0" lines-covered="2" lines-valid="2" version="1.0" timestamp="1712764800">
  <sources><source>.</source></sources>
  <packages>
    <package name="al-source" line-rate="1.0">
      <classes>
        <class name="OnlyOne" filename="src/OnlyOne.al" line-rate="1.0">
          <lines>
            <line number="1" hits="1" />
            <line number="2" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].className, 'OnlyOne');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test-compile && npx mocha out/test/suite/outputParser.test.js
```

Expected: FAIL — `parseCoberturaXml` not defined.

- [ ] **Step 3: Implement Cobertura XML parsing**

Add to `src/runner/outputParser.ts`:

```typescript
import { XMLParser } from 'fast-xml-parser';

export function parseCoberturaXml(xml: string): CoverageEntry[] {
  if (!xml || xml.trim().length === 0) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'class' || name === 'line' || name === 'package',
  });

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const packages = parsed?.coverage?.packages?.package;
  if (!packages) return [];

  const entries: CoverageEntry[] = [];

  for (const pkg of Array.isArray(packages) ? packages : [packages]) {
    const classes = pkg?.classes?.class;
    if (!classes) continue;

    for (const cls of Array.isArray(classes) ? classes : [classes]) {
      const lines = cls?.lines?.line;
      const parsedLines: Array<{ number: number; hits: number }> = [];

      if (lines) {
        for (const line of Array.isArray(lines) ? lines : [lines]) {
          parsedLines.push({
            number: parseInt(line['@_number'], 10),
            hits: parseInt(line['@_hits'], 10),
          });
        }
      }

      entries.push({
        className: cls['@_name'] || '',
        filename: cls['@_filename'] || '',
        lineRate: parseFloat(cls['@_line-rate'] || '0'),
        lines: parsedLines,
      });
    }
  }

  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test-compile && npx mocha out/test/suite/outputParser.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner/outputParser.ts test/suite/outputParser.test.ts
git commit -m "feat: add Cobertura XML coverage parser with tests"
```

---

### Task 4: AL.Runner Manager

**Files:**
- Create: `src/runner/alRunnerManager.ts`

- [ ] **Step 1: Write the AL.Runner manager**

Create `src/runner/alRunnerManager.ts`:

```typescript
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class AlRunnerManager {
  private resolvedPath: string | undefined;

  async ensureInstalled(): Promise<string> {
    const configPath = vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '');
    if (configPath) {
      this.resolvedPath = configPath;
      return configPath;
    }

    // Check if al-runner is on PATH
    const pathResult = await this.tryFindOnPath();
    if (pathResult) {
      this.resolvedPath = pathResult;
      return pathResult;
    }

    // Try to install via dotnet tool
    const installed = await this.installViaDotnet();
    if (installed) {
      this.resolvedPath = installed;
      return installed;
    }

    throw new Error('Could not find or install AL.Runner');
  }

  getPath(): string | undefined {
    return this.resolvedPath;
  }

  private tryFindOnPath(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      cp.exec(`${cmd} al-runner`, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(undefined);
        } else {
          resolve(stdout.trim().split('\n')[0].trim());
        }
      });
    });
  }

  private async installViaDotnet(): Promise<string | undefined> {
    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';

    // Check dotnet is available
    const dotnetAvailable = await this.checkCommand(dotnetPath);
    if (!dotnetAvailable) {
      const action = await vscode.window.showErrorMessage(
        'ALchemist requires .NET 8 SDK. Please install it to continue.',
        'Download .NET SDK'
      );
      if (action === 'Download .NET SDK') {
        vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download/dotnet/8.0'));
      }
      return undefined;
    }

    // Install al-runner
    const installChoice = await vscode.window.showInformationMessage(
      'ALchemist needs to install AL.Runner. Install now?',
      'Install', 'Cancel'
    );
    if (installChoice !== 'Install') return undefined;

    return new Promise((resolve) => {
      cp.exec(`${dotnetPath} tool install -g BusinessCentral.AL.Runner`, (err, stdout, stderr) => {
        if (err) {
          // Might already be installed, try update
          cp.exec(`${dotnetPath} tool update -g BusinessCentral.AL.Runner`, (err2) => {
            if (err2) {
              vscode.window.showErrorMessage(
                `Failed to install AL.Runner: ${stderr || err2.message}. Install manually: dotnet tool install -g BusinessCentral.AL.Runner`
              );
              resolve(undefined);
            } else {
              this.tryFindOnPath().then(resolve);
            }
          });
        } else {
          this.tryFindOnPath().then(resolve);
        }
      });
    });
  }

  async checkForUpdates(): Promise<void> {
    const configPath = vscode.workspace.getConfiguration('alchemist').get<string>('alRunnerPath', '');
    if (configPath) return; // Skip update checks for custom paths

    const dotnetPath = vscode.workspace.getConfiguration('alchemist').get<string>('dotnetPath', '') || 'dotnet';

    cp.exec(`${dotnetPath} tool list -g`, (err, stdout) => {
      if (err || !stdout.includes('businesscentral.al.runner')) return;

      // Check NuGet for newer version (non-blocking, best-effort)
      cp.exec(`${dotnetPath} tool search BusinessCentral.AL.Runner --take 1`, (err2, searchStdout) => {
        if (err2 || !searchStdout) return;

        const installedMatch = stdout.match(/businesscentral\.al\.runner\s+(\S+)/i);
        const latestMatch = searchStdout.match(/BusinessCentral\.AL\.Runner\s+(\S+)/i);

        if (installedMatch && latestMatch && installedMatch[1] !== latestMatch[1]) {
          vscode.window.showInformationMessage(
            `AL.Runner update available: ${latestMatch[1]} (current: ${installedMatch[1]})`,
            'Update'
          ).then((action) => {
            if (action === 'Update') {
              cp.exec(`${dotnetPath} tool update -g BusinessCentral.AL.Runner`, (err3) => {
                if (err3) {
                  vscode.window.showErrorMessage(`Update failed: ${err3.message}`);
                } else {
                  vscode.window.showInformationMessage('AL.Runner updated successfully.');
                  this.tryFindOnPath().then((p) => { this.resolvedPath = p; });
                }
              });
            }
          });
        }
      });
    });
  }

  private checkCommand(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      cp.exec(`${cmd} --version`, (err) => resolve(!err));
    });
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/runner/alRunnerManager.ts
git commit -m "feat: add AL.Runner auto-download and version management"
```

---

### Task 5: Executor

**Files:**
- Create: `src/runner/executor.ts`

- [ ] **Step 1: Write the executor**

Create `src/runner/executor.ts`:

```typescript
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AlRunnerManager } from './alRunnerManager';
import { parseTestOutput, parseCoberturaXml, ExecutionResult } from './outputParser';

export type ExecutionMode = 'scratch-standalone' | 'scratch-project' | 'test';

export class Executor {
  private currentProcess: cp.ChildProcess | undefined;
  private readonly onDidStartRun = new vscode.EventEmitter<ExecutionMode>();
  private readonly onDidFinishRun = new vscode.EventEmitter<ExecutionResult>();

  readonly onStart = this.onDidStartRun.event;
  readonly onFinish = this.onDidFinishRun.event;

  constructor(private readonly runnerManager: AlRunnerManager) {}

  async execute(mode: ExecutionMode, filePath: string, workspacePath?: string): Promise<void> {
    const runnerPath = this.runnerManager.getPath();
    if (!runnerPath) {
      vscode.window.showErrorMessage('AL.Runner not found. Run "ALchemist: Run Now" to trigger installation.');
      return;
    }

    this.cancel();
    this.onDidStartRun.fire(mode);

    const startTime = Date.now();
    const { args, cwd } = this.buildArgs(mode, filePath, workspacePath);

    try {
      const { stdout, stderr, exitCode } = await this.spawn(runnerPath, args, cwd);
      const coberturaPath = path.join(cwd, 'cobertura.xml');
      let coverageXml = '';
      if (fs.existsSync(coberturaPath)) {
        coverageXml = fs.readFileSync(coberturaPath, 'utf-8');
        fs.unlinkSync(coberturaPath); // Clean up after reading
      }

      const { tests, messages, summary } = parseTestOutput(stdout);
      const coverage = parseCoberturaXml(coverageXml);
      const stderrLines = stderr.split('\n').filter((l) => l.trim().length > 0);

      const result: ExecutionResult = {
        mode: mode === 'test' ? 'test' : 'scratch',
        tests,
        messages,
        stderrOutput: stderrLines,
        summary,
        coverage,
        exitCode,
        durationMs: Date.now() - startTime,
      };

      this.onDidFinishRun.fire(result);
    } catch (err: any) {
      const result: ExecutionResult = {
        mode: mode === 'test' ? 'test' : 'scratch',
        tests: [],
        messages: [],
        stderrOutput: [err.message || 'Unknown error'],
        summary: undefined,
        coverage: [],
        exitCode: 1,
        durationMs: Date.now() - startTime,
      };
      this.onDidFinishRun.fire(result);
    }
  }

  cancel(): void {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
      this.currentProcess = undefined;
    }
  }

  private buildArgs(mode: ExecutionMode, filePath: string, workspacePath?: string): { args: string[]; cwd: string } {
    switch (mode) {
      case 'scratch-standalone':
        return {
          args: ['-e', fs.readFileSync(filePath, 'utf-8')],
          cwd: path.dirname(filePath),
        };
      case 'scratch-project': {
        const srcPath = workspacePath || path.dirname(filePath);
        return {
          args: ['--coverage', srcPath, filePath],
          cwd: srcPath,
        };
      }
      case 'test': {
        const cwd = workspacePath || path.dirname(filePath);
        return {
          args: ['--coverage', cwd],
          cwd,
        };
      }
    }
  }

  private spawn(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(command, args, { cwd, shell: true });
      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        this.currentProcess = undefined;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        this.currentProcess = undefined;
        reject(err);
      });
    });
  }

  dispose(): void {
    this.cancel();
    this.onDidStartRun.dispose();
    this.onDidFinishRun.dispose();
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/runner/executor.ts
git commit -m "feat: add executor for spawning AL.Runner and collecting results"
```

---

### Task 6: Gutter Icons and Decorations

**Files:**
- Create: `resources/gutter-green.svg`
- Create: `resources/gutter-red.svg`
- Create: `resources/gutter-gray.svg`
- Create: `src/editor/decorations.ts`

- [ ] **Step 1: Create gutter icon SVGs**

Create `resources/gutter-green.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="5" fill="#4ec9b0"/>
</svg>
```

Create `resources/gutter-red.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="5" fill="#f14c4c"/>
</svg>
```

Create `resources/gutter-gray.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="5" fill="none" stroke="#858585" stroke-width="1.5"/>
</svg>
```

- [ ] **Step 2: Write the decoration manager**

Create `src/editor/decorations.ts`:

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { ExecutionResult, CoverageEntry } from '../runner/outputParser';

export class DecorationManager {
  private readonly coveredDecorationType: vscode.TextEditorDecorationType;
  private readonly uncoveredDecorationType: vscode.TextEditorDecorationType;
  private readonly errorLineDecorationType: vscode.TextEditorDecorationType;
  private readonly dimmedDecorationType: vscode.TextEditorDecorationType;
  private readonly messageDecorationType: vscode.TextEditorDecorationType;
  private readonly errorMessageDecorationType: vscode.TextEditorDecorationType;

  // Track per-file line coverage for hover provider
  private lineCoverageMap = new Map<string, Map<number, { hits: number }>>();

  constructor(private readonly extensionPath: string) {
    this.coveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-green.svg'),
      gutterIconSize: 'contain',
    });

    this.uncoveredDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-gray.svg'),
      gutterIconSize: 'contain',
    });

    this.errorLineDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'resources', 'gutter-red.svg'),
      gutterIconSize: 'contain',
    });

    this.dimmedDecorationType = vscode.window.createTextEditorDecorationType({
      opacity: '0.5',
    });

    this.messageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#6a9955',
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });

    this.errorMessageDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: '#f14c4c',
        margin: '0 0 0 16px',
        fontStyle: 'normal',
      },
    });
  }

  applyResults(editor: vscode.TextEditor, result: ExecutionResult, workspacePath: string): void {
    this.clearDecorations(editor);

    const config = vscode.workspace.getConfiguration('alchemist');
    const filePath = editor.document.uri.fsPath;

    // Apply gutter coverage
    if (config.get<boolean>('showGutterCoverage', true)) {
      this.applyCoverageGutters(editor, result.coverage, filePath, workspacePath);
    }

    // Apply dimming for uncovered lines
    if (config.get<boolean>('dimUncoveredLines', true)) {
      this.applyDimming(editor, result.coverage, filePath, workspacePath);
    }

    // Apply inline error messages from test failures
    if (config.get<boolean>('showInlineMessages', true)) {
      this.applyInlineErrors(editor, result);
    }
  }

  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.coveredDecorationType, []);
    editor.setDecorations(this.uncoveredDecorationType, []);
    editor.setDecorations(this.errorLineDecorationType, []);
    editor.setDecorations(this.dimmedDecorationType, []);
    editor.setDecorations(this.messageDecorationType, []);
    editor.setDecorations(this.errorMessageDecorationType, []);
  }

  clearAll(): void {
    this.lineCoverageMap.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearDecorations(editor);
    }
  }

  getLineCoverage(filePath: string): Map<number, { hits: number }> | undefined {
    return this.lineCoverageMap.get(filePath);
  }

  private applyCoverageGutters(editor: vscode.TextEditor, coverage: CoverageEntry[], filePath: string, workspacePath: string): void {
    const entry = this.findCoverageForFile(coverage, filePath, workspacePath);
    if (!entry) return;

    const covered: vscode.DecorationOptions[] = [];
    const uncovered: vscode.DecorationOptions[] = [];
    const fileMap = new Map<number, { hits: number }>();

    for (const line of entry.lines) {
      const lineIndex = line.number - 1; // VSCode is 0-indexed
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;
      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
      fileMap.set(line.number, { hits: line.hits });

      if (line.hits > 0) {
        covered.push({ range });
      } else {
        uncovered.push({ range });
      }
    }

    this.lineCoverageMap.set(filePath, fileMap);
    editor.setDecorations(this.coveredDecorationType, covered);
    editor.setDecorations(this.uncoveredDecorationType, uncovered);
  }

  private applyDimming(editor: vscode.TextEditor, coverage: CoverageEntry[], filePath: string, workspacePath: string): void {
    const entry = this.findCoverageForFile(coverage, filePath, workspacePath);
    if (!entry) return;

    const dimmed: vscode.DecorationOptions[] = [];
    for (const line of entry.lines) {
      if (line.hits === 0) {
        const lineIndex = line.number - 1;
        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;
        const range = editor.document.lineAt(lineIndex).range;
        dimmed.push({ range });
      }
    }
    editor.setDecorations(this.dimmedDecorationType, dimmed);
  }

  private applyInlineErrors(editor: vscode.TextEditor, result: ExecutionResult): void {
    // Parse AL line references from stderr and test failure messages
    const errorDecorations: vscode.DecorationOptions[] = [];
    const alLineRegex = /\[AL line ~?(\d+) in (\w+)\]/;

    for (const test of result.tests) {
      if (test.status === 'failed' && test.message) {
        // Try to find AL line reference in stack trace
        const fullText = [test.message, test.stackTrace || ''].join('\n');
        const match = fullText.match(alLineRegex);
        if (match) {
          const lineNumber = parseInt(match[1], 10) - 1;
          if (lineNumber >= 0 && lineNumber < editor.document.lineCount) {
            const range = editor.document.lineAt(lineNumber).range;
            errorDecorations.push({
              range,
              renderOptions: {
                after: { contentText: `  \u2717 ${test.message}` },
              },
            });

            // Also set red gutter for this line
            editor.setDecorations(this.errorLineDecorationType, [{ range: new vscode.Range(lineNumber, 0, lineNumber, 0) }]);
          }
        }
      }
    }

    editor.setDecorations(this.errorMessageDecorationType, errorDecorations);

    // Apply Message() output for scratch mode
    if (result.mode === 'scratch' && result.messages.length > 0) {
      this.applyInlineMessages(editor, result.messages);
    }
  }

  private applyInlineMessages(editor: vscode.TextEditor, messages: string[]): void {
    // Best-effort: match Message() calls in source to output by order of appearance
    const messageDecorations: vscode.DecorationOptions[] = [];
    const messageCallRegex = /\bMessage\s*\(/i;
    let messageIndex = 0;

    for (let i = 0; i < editor.document.lineCount && messageIndex < messages.length; i++) {
      const lineText = editor.document.lineAt(i).text;
      if (messageCallRegex.test(lineText)) {
        const range = editor.document.lineAt(i).range;
        messageDecorations.push({
          range,
          renderOptions: {
            after: { contentText: `  \u2192 ${messages[messageIndex]}` },
          },
        });
        messageIndex++;
      }
    }

    editor.setDecorations(this.messageDecorationType, messageDecorations);
  }

  private findCoverageForFile(coverage: CoverageEntry[], filePath: string, workspacePath: string): CoverageEntry | undefined {
    const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
    return coverage.find((e) => {
      const entryPath = e.filename.replace(/\\/g, '/');
      return entryPath === relativePath || filePath.endsWith(entryPath);
    });
  }

  dispose(): void {
    this.coveredDecorationType.dispose();
    this.uncoveredDecorationType.dispose();
    this.errorLineDecorationType.dispose();
    this.dimmedDecorationType.dispose();
    this.messageDecorationType.dispose();
    this.errorMessageDecorationType.dispose();
    this.lineCoverageMap.clear();
  }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 4: Commit**

```bash
git add resources/gutter-green.svg resources/gutter-red.svg resources/gutter-gray.svg src/editor/decorations.ts
git commit -m "feat: add gutter icons and inline decoration manager"
```

---

### Task 7: Hover Provider

**Files:**
- Create: `src/editor/hoverProvider.ts`

- [ ] **Step 1: Write the hover provider**

Create `src/editor/hoverProvider.ts`:

```typescript
import * as vscode from 'vscode';
import { DecorationManager } from './decorations';

export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(private readonly decorationManager: DecorationManager) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // Convert to 1-indexed
    const lineCoverage = this.decorationManager.getLineCoverage(filePath);

    if (!lineCoverage) return undefined;

    const entry = lineCoverage.get(lineNumber);
    if (!entry) return undefined;

    const status = entry.hits > 0 ? 'Covered' : 'Not Covered';
    const statusIcon = entry.hits > 0 ? '\u25CF' : '\u25CB'; // ● or ○
    const statusColor = entry.hits > 0 ? '#4ec9b0' : '#858585';

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.appendMarkdown(`**Statement Coverage**\n\n`);
    markdown.appendMarkdown(`Status: ${status}\n\n`);
    markdown.appendMarkdown(`Hits: ${entry.hits}\n`);

    return new vscode.Hover(markdown);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/editor/hoverProvider.ts
git commit -m "feat: add coverage hover tooltip provider"
```

---

### Task 8: Output Channel

**Files:**
- Create: `src/output/outputChannel.ts`

- [ ] **Step 1: Write the output channel formatter**

Create `src/output/outputChannel.ts`:

```typescript
import * as vscode from 'vscode';
import { ExecutionResult } from '../runner/outputParser';

export class AlchemistOutputChannel {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('ALchemist');
  }

  displayResult(result: ExecutionResult, fileName: string): void {
    this.channel.clear();

    const separator = '\u2501'.repeat(47); // ━
    this.channel.appendLine(`\u2501\u2501\u2501 ALchemist ${separator.substring(14)}`);

    // Header
    const modeLabel = result.mode === 'scratch' ? 'scratch' : 'test';
    this.channel.appendLine(`  \u25B6 ${fileName} (${modeLabel})`);
    this.channel.appendLine(`  \u23F1 ${result.durationMs}ms`);
    this.channel.appendLine('');

    if (result.mode === 'test') {
      this.displayTestResults(result);
    } else {
      this.displayScratchResults(result);
    }

    // Coverage summary
    if (result.coverage.length > 0) {
      const totalLines = result.coverage.reduce((sum, e) => sum + e.lines.length, 0);
      const coveredLines = result.coverage.reduce(
        (sum, e) => sum + e.lines.filter((l) => l.hits > 0).length, 0
      );
      const pct = totalLines > 0 ? ((coveredLines / totalLines) * 100).toFixed(1) : '0.0';
      this.channel.appendLine(`  Coverage: ${coveredLines}/${totalLines} statements (${pct}%)`);
    }

    this.channel.appendLine(separator);

    // Auto-focus based on settings
    const config = vscode.workspace.getConfiguration('alchemist');
    const showOnError = config.get<string>('showOutputOnError', 'onlyOnFailure');

    if (showOnError === 'always') {
      this.channel.show(true);
    } else if (showOnError === 'onlyOnFailure') {
      const hasFailures = result.tests.some((t) => t.status !== 'passed')
        || result.stderrOutput.length > 0
        || result.exitCode !== 0;
      if (hasFailures) {
        this.channel.show(true);
      }
    }
  }

  show(): void {
    this.channel.show(true);
  }

  private displayTestResults(result: ExecutionResult): void {
    for (const test of result.tests) {
      if (test.status === 'passed') {
        const duration = test.durationMs !== undefined ? `${test.durationMs}ms` : '';
        this.channel.appendLine(`  \u2713 ${test.name}${duration ? '           ' + duration : ''}`);
      } else if (test.status === 'failed') {
        this.channel.appendLine(`  \u2717 ${test.name}`);
        if (test.message) {
          this.channel.appendLine(`    \u2192 ${test.message}`);
        }
        if (test.stackTrace) {
          for (const line of test.stackTrace.split('\n')) {
            if (line.trim()) {
              this.channel.appendLine(`      ${line.trim()}`);
            }
          }
        }
      } else {
        this.channel.appendLine(`  \u26A0 ${test.name}`);
        if (test.message) {
          this.channel.appendLine(`    \u2192 ${test.message}`);
        }
      }
    }

    // Summary
    if (result.summary) {
      this.channel.appendLine('');
      this.channel.appendLine(`  Results: ${result.summary.passed} passed, ${result.summary.failed} failed`);
    }

    this.channel.appendLine('');
  }

  private displayScratchResults(result: ExecutionResult): void {
    // Messages
    if (result.messages.length > 0) {
      this.channel.appendLine('  Messages:');
      for (const msg of result.messages) {
        this.channel.appendLine(`    ${msg}`);
      }
      this.channel.appendLine('');
    }

    // Errors from stderr
    if (result.stderrOutput.length > 0) {
      this.channel.appendLine('  Errors:');
      for (const err of result.stderrOutput) {
        this.channel.appendLine(`    ${err}`);
      }
      this.channel.appendLine('');
    }
  }

  dispose(): void {
    this.channel.dispose();
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/output/outputChannel.ts
git commit -m "feat: add formatted ALchemist output channel"
```

---

### Task 9: Status Bar

**Files:**
- Create: `src/output/statusBar.ts`

- [ ] **Step 1: Write the status bar manager**

Create `src/output/statusBar.ts`:

```typescript
import * as vscode from 'vscode';
import { ExecutionResult } from '../runner/outputParser';
import { ExecutionMode } from '../runner/executor';

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'alchemist.showOutput';
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.item.text = '$(beaker) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'ALchemist — Ready';
  }

  setRunning(mode: ExecutionMode): void {
    this.item.text = '$(loading~spin) ALchemist';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    const modeLabel = mode === 'test' ? 'tests' : 'scratch file';
    this.item.tooltip = `ALchemist — Running ${modeLabel}...`;
  }

  setResult(result: ExecutionResult): void {
    if (result.mode === 'test') {
      this.setTestResult(result);
    } else {
      this.setScratchResult(result);
    }
  }

  private setTestResult(result: ExecutionResult): void {
    const passed = result.summary?.passed ?? result.tests.filter((t) => t.status === 'passed').length;
    const total = result.summary?.total ?? result.tests.length;
    const hasFailures = result.tests.some((t) => t.status !== 'passed');

    if (hasFailures) {
      this.item.text = `$(error) ALchemist: ${passed}/${total} passed`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `$(check) ALchemist: ${passed}/${total} passed`;
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;

    // Build tooltip
    const coverageTotal = result.coverage.reduce((s, e) => s + e.lines.length, 0);
    const coverageCovered = result.coverage.reduce((s, e) => s + e.lines.filter((l) => l.hits > 0).length, 0);
    const pct = coverageTotal > 0 ? ((coverageCovered / coverageTotal) * 100).toFixed(1) : '—';
    this.item.tooltip = `ALchemist — ${result.durationMs}ms\nCoverage: ${pct}%`;
  }

  private setScratchResult(result: ExecutionResult): void {
    if (result.exitCode !== 0) {
      this.item.text = '$(warning) ALchemist: Error';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = '$(check) ALchemist';
      this.item.backgroundColor = undefined;
    }
    this.item.color = undefined;
    this.item.tooltip = `ALchemist — Scratch (${result.durationMs}ms)`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/output/statusBar.ts
git commit -m "feat: add status bar indicator with run states"
```

---

### Task 10: Scratch Pad Mode

**Files:**
- Create: `src/scratch/scratchManager.ts`
- Create: `resources/scratch-template.al`
- Create: `test/suite/scratchManager.test.ts`

- [ ] **Step 1: Write the scratch template**

Create `resources/scratch-template.al`:

```al
codeunit 50000 Scratch
{
    procedure Run()
    var

    begin
        Message('Hello from ALchemist');
    end;
}
```

- [ ] **Step 2: Write failing tests for scratch detection**

Create `test/suite/scratchManager.test.ts`:

```typescript
import * as assert from 'assert';
import { isProjectAware, isScratchFile } from '../../src/scratch/scratchManager';

suite('ScratchManager', () => {
  suite('isProjectAware', () => {
    test('detects project directive at first line', () => {
      assert.strictEqual(isProjectAware('//alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('detects directive with extra spaces', () => {
      assert.strictEqual(isProjectAware('// alchemist: project\ncodeunit 50000 Scratch {}'), true);
    });

    test('returns false without directive', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch {}'), false);
    });

    test('returns false when directive is not on first line', () => {
      assert.strictEqual(isProjectAware('codeunit 50000 Scratch\n//alchemist: project\n{}'), false);
    });
  });

  suite('isScratchFile', () => {
    test('identifies scratch file by path containing alchemist-scratch', () => {
      assert.strictEqual(isScratchFile('/tmp/alchemist-scratch/scratch1.al'), true);
    });

    test('rejects normal project file', () => {
      assert.strictEqual(isScratchFile('/workspace/src/MyCodeunit.al'), false);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm run test-compile && npx mocha out/test/suite/scratchManager.test.js
```

Expected: FAIL — functions not defined.

- [ ] **Step 4: Write the scratch manager**

Create `src/scratch/scratchManager.ts`:

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const SCRATCH_DIR_NAME = 'alchemist-scratch';
const PROJECT_DIRECTIVE_REGEX = /^\/\/\s*alchemist:\s*project/i;

export function isProjectAware(fileContent: string): boolean {
  const firstLine = fileContent.split('\n')[0] || '';
  return PROJECT_DIRECTIVE_REGEX.test(firstLine.trim());
}

export function isScratchFile(filePath: string): boolean {
  return filePath.includes(SCRATCH_DIR_NAME);
}

export class ScratchManager {
  private readonly scratchDir: string;
  private scratchCounter = 0;

  constructor(globalStoragePath: string) {
    this.scratchDir = path.join(globalStoragePath, SCRATCH_DIR_NAME);
    if (!fs.existsSync(this.scratchDir)) {
      fs.mkdirSync(this.scratchDir, { recursive: true });
    }
    // Count existing scratch files to continue numbering
    const existing = fs.readdirSync(this.scratchDir).filter((f) => f.endsWith('.al'));
    this.scratchCounter = existing.length;
  }

  async newScratchFile(extensionPath: string): Promise<vscode.TextEditor> {
    this.scratchCounter++;
    const fileName = `scratch${this.scratchCounter}.al`;
    const filePath = path.join(this.scratchDir, fileName);

    // Read template
    const templatePath = path.join(extensionPath, 'resources', 'scratch-template.al');
    let template: string;
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf-8');
    } else {
      template = `codeunit 50000 Scratch\n{\n    procedure Run()\n    begin\n        Message('Hello from ALchemist');\n    end;\n}`;
    }

    fs.writeFileSync(filePath, template, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    return vscode.window.showTextDocument(doc);
  }

  async deleteScratchFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isScratchFile(editor.document.uri.fsPath)) {
      vscode.window.showWarningMessage('No active scratch file to delete.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async saveScratchAs(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isScratchFile(editor.document.uri.fsPath)) {
      vscode.window.showWarningMessage('No active scratch file to save.');
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      filters: { 'AL Files': ['al'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });

    if (uri) {
      const content = editor.document.getText();
      // Strip project directive if present when saving to workspace
      const cleaned = content.replace(/^\/\/\s*alchemist:\s*project\n?/i, '');
      fs.writeFileSync(uri.fsPath, cleaned, 'utf-8');
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
    }
  }

  async toggleProjectContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const content = doc.getText();
    const edit = new vscode.WorkspaceEdit();

    if (isProjectAware(content)) {
      // Remove directive
      const firstLine = doc.lineAt(0);
      const range = new vscode.Range(firstLine.range.start, doc.lineAt(0).rangeIncludingLineBreak.end);
      edit.delete(doc.uri, range);
    } else {
      // Add directive
      edit.insert(doc.uri, new vscode.Position(0, 0), '//alchemist: project\n');
    }

    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  getScratchDir(): string {
    return this.scratchDir;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test-compile && npx mocha out/test/suite/scratchManager.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scratch/scratchManager.ts test/suite/scratchManager.test.ts resources/scratch-template.al
git commit -m "feat: add scratch pad file management with project-aware directive"
```

---

### Task 11: Test Discovery & Test Explorer

**Files:**
- Create: `src/testing/testDiscovery.ts`
- Create: `src/testing/testController.ts`
- Create: `test/suite/testDiscovery.test.ts`

- [ ] **Step 1: Write failing tests for test discovery**

Create `test/suite/testDiscovery.test.ts`:

```typescript
import * as assert from 'assert';
import { discoverTestsFromContent } from '../../src/testing/testDiscovery';

suite('TestDiscovery', () => {
  test('discovers test procedures in a test codeunit', () => {
    const content = `
codeunit 50200 "Test Sales Calculation"
{
    Subtype = Test;

    [Test]
    procedure TestBasicDiscount()
    begin
        // test code
    end;

    [Test]
    procedure TestVolumeDiscount()
    begin
        // test code
    end;

    procedure HelperProc()
    begin
        // not a test
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestSales.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'Test Sales Calculation');
    assert.strictEqual(result[0].codeunitId, 50200);
    assert.strictEqual(result[0].tests.length, 2);
    assert.strictEqual(result[0].tests[0].name, 'TestBasicDiscount');
    assert.strictEqual(result[0].tests[1].name, 'TestVolumeDiscount');
  });

  test('ignores non-test codeunits', () => {
    const content = `
codeunit 50100 "Sales Calculation"
{
    procedure CalcDiscount()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Sales.al');
    assert.strictEqual(result.length, 0);
  });

  test('discovers tests by [Test] attribute even without Subtype', () => {
    const content = `
codeunit 50201 "More Tests"
{
    [Test]
    procedure TestSomething()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'MoreTests.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests.length, 1);
  });

  test('returns line numbers for test procedures', () => {
    const content = `codeunit 50200 "Test X"
{
    [Test]
    procedure TestA()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestX.al');
    assert.strictEqual(result[0].tests[0].line, 3); // 0-indexed line of [Test]
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test-compile && npx mocha out/test/suite/testDiscovery.test.js
```

Expected: FAIL — `discoverTestsFromContent` not defined.

- [ ] **Step 3: Implement test discovery**

Create `src/testing/testDiscovery.ts`:

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveredTest {
  name: string;
  line: number; // 0-indexed line of the [Test] attribute
}

export interface DiscoveredTestCodeunit {
  codeunitName: string;
  codeunitId: number;
  fileName: string;
  tests: DiscoveredTest[];
}

const CODEUNIT_REGEX = /codeunit\s+(\d+)\s+"([^"]+)"/i;
const TEST_ATTR_REGEX = /^\s*\[Test\]\s*$/i;
const PROCEDURE_REGEX = /^\s*(?:local\s+)?procedure\s+(\w+)\s*\(/i;
const SUBTYPE_TEST_REGEX = /Subtype\s*=\s*Test\s*;/i;

export function discoverTestsFromContent(content: string, fileName: string): DiscoveredTestCodeunit[] {
  const lines = content.split('\n');
  const codeunits: DiscoveredTestCodeunit[] = [];

  let currentCodeunitName: string | undefined;
  let currentCodeunitId: number | undefined;
  let currentTests: DiscoveredTest[] = [];
  let hasTestAttribute = false;
  let hasAnyTestProc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect codeunit declaration
    const codeunitMatch = line.match(CODEUNIT_REGEX);
    if (codeunitMatch) {
      // Save previous codeunit if it had tests
      if (currentCodeunitName && currentTests.length > 0) {
        codeunits.push({
          codeunitName: currentCodeunitName,
          codeunitId: currentCodeunitId!,
          fileName,
          tests: currentTests,
        });
      }
      currentCodeunitId = parseInt(codeunitMatch[1], 10);
      currentCodeunitName = codeunitMatch[2];
      currentTests = [];
      hasAnyTestProc = false;
      continue;
    }

    // Detect [Test] attribute
    if (TEST_ATTR_REGEX.test(line)) {
      hasTestAttribute = true;
      // Look ahead for the procedure name
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const procMatch = lines[j].match(PROCEDURE_REGEX);
        if (procMatch) {
          currentTests.push({ name: procMatch[1], line: i });
          hasAnyTestProc = true;
          break;
        }
      }
      continue;
    }
  }

  // Save last codeunit
  if (currentCodeunitName && currentTests.length > 0) {
    codeunits.push({
      codeunitName: currentCodeunitName,
      codeunitId: currentCodeunitId!,
      fileName,
      tests: currentTests,
    });
  }

  return codeunits;
}

export async function discoverTestsInWorkspace(workspacePath: string): Promise<DiscoveredTestCodeunit[]> {
  const allCodeunits: DiscoveredTestCodeunit[] = [];

  const alFiles = await findAlFiles(workspacePath);
  for (const filePath of alFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(workspacePath, filePath);
    const discovered = discoverTestsFromContent(content, relativePath);
    allCodeunits.push(...discovered);
  }

  return allCodeunits;
}

async function findAlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.alpackages') {
      results.push(...await findAlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.al')) {
      results.push(fullPath);
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test-compile && npx mocha out/test/suite/testDiscovery.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Write the Test Controller (VSCode Test Explorer integration)**

Create `src/testing/testController.ts`:

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { discoverTestsInWorkspace, DiscoveredTestCodeunit } from './testDiscovery';
import { Executor } from '../runner/executor';
import { ExecutionResult } from '../runner/outputParser';

export class AlchemistTestController {
  private readonly controller: vscode.TestController;
  private readonly testItems = new Map<string, vscode.TestItem>();

  constructor(private readonly executor: Executor) {
    this.controller = vscode.tests.createTestController('alchemist', 'ALchemist');

    this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true
    );
  }

  async refreshTests(workspacePath: string): Promise<void> {
    const codeunits = await discoverTestsInWorkspace(workspacePath);

    // Clear existing items
    this.controller.items.replace([]);
    this.testItems.clear();

    for (const codeunit of codeunits) {
      const codeunitItem = this.controller.createTestItem(
        `codeunit-${codeunit.codeunitId}`,
        codeunit.codeunitName,
        vscode.Uri.file(path.join(workspacePath, codeunit.fileName))
      );

      for (const test of codeunit.tests) {
        const testItem = this.controller.createTestItem(
          `test-${codeunit.codeunitId}-${test.name}`,
          test.name,
          vscode.Uri.file(path.join(workspacePath, codeunit.fileName))
        );
        testItem.range = new vscode.Range(test.line, 0, test.line, 0);
        codeunitItem.children.add(testItem);
        this.testItems.set(test.name, testItem);
      }

      this.controller.items.add(codeunitItem);
    }
  }

  updateFromResult(result: ExecutionResult): void {
    if (result.mode !== 'test') return;

    const run = this.controller.createTestRun(new vscode.TestRunRequest());

    for (const testResult of result.tests) {
      const item = this.testItems.get(testResult.name);
      if (!item) continue;

      if (testResult.status === 'passed') {
        run.passed(item, testResult.durationMs);
      } else if (testResult.status === 'failed') {
        const message = new vscode.TestMessage(testResult.message || 'Test failed');
        run.failed(item, message, testResult.durationMs);
      } else {
        const message = new vscode.TestMessage(testResult.message || 'Test errored');
        run.errored(item, message, testResult.durationMs);
      }
    }

    run.end();
  }

  private async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    token.onCancellationRequested(() => this.executor.cancel());

    await this.executor.execute('test', workspaceFolder.uri.fsPath, workspaceFolder.uri.fsPath);
    // Results flow through the executor's onFinish event, which calls updateFromResult
  }

  dispose(): void {
    this.controller.dispose();
  }
}
```

- [ ] **Step 6: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 7: Commit**

```bash
git add src/testing/testDiscovery.ts src/testing/testController.ts test/suite/testDiscovery.test.ts
git commit -m "feat: add test discovery and VSCode Test Explorer integration"
```

---

### Task 12: Extension Entry Point — Wire Everything Together

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Write the full extension entry point**

Replace `src/extension.ts` with the complete wiring:

```typescript
import * as vscode from 'vscode';
import { AlRunnerManager } from './runner/alRunnerManager';
import { Executor } from './runner/executor';
import { DecorationManager } from './editor/decorations';
import { CoverageHoverProvider } from './editor/hoverProvider';
import { AlchemistOutputChannel } from './output/outputChannel';
import { StatusBarManager } from './output/statusBar';
import { ScratchManager, isScratchFile, isProjectAware } from './scratch/scratchManager';
import { AlchemistTestController } from './testing/testController';
import * as path from 'path';

let runnerManager: AlRunnerManager;
let executor: Executor;
let decorationManager: DecorationManager;
let outputChannel: AlchemistOutputChannel;
let statusBar: StatusBarManager;
let scratchManager: ScratchManager;
let testController: AlchemistTestController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize components
  runnerManager = new AlRunnerManager();
  executor = new Executor(runnerManager);
  decorationManager = new DecorationManager(context.extensionPath);
  outputChannel = new AlchemistOutputChannel();
  statusBar = new StatusBarManager();
  scratchManager = new ScratchManager(context.globalStorageUri.fsPath);
  testController = new AlchemistTestController(executor);

  // Ensure AL.Runner is available
  try {
    await runnerManager.ensureInstalled();
  } catch {
    // Will show error when user tries to run
  }

  // Check for updates (non-blocking)
  runnerManager.checkForUpdates();

  // Discover tests in workspace
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    testController.refreshTests(workspaceFolder.uri.fsPath);
  }

  // --- Event handlers ---

  // Executor events
  context.subscriptions.push(
    executor.onStart((mode) => {
      statusBar.setRunning(mode);
    }),
    executor.onFinish((result) => {
      statusBar.setResult(result);

      // Get the active editor's file name for the output channel
      const activeFile = vscode.window.activeTextEditor?.document.fileName || 'unknown';
      outputChannel.displayResult(result, path.basename(activeFile));

      // Apply decorations to active editor
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const wsPath = workspaceFolder?.uri.fsPath || path.dirname(editor.document.uri.fsPath);
        decorationManager.applyResults(editor, result, wsPath);
      }

      // Update Test Explorer
      testController.updateFromResult(result);
    })
  );

  // On-save handler
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId !== 'al') return;

      const config = vscode.workspace.getConfiguration('alchemist');
      if (!config.get<boolean>('runOnSave', true)) return;

      if (!runnerManager.getPath()) {
        try {
          await runnerManager.ensureInstalled();
        } catch {
          return;
        }
      }

      const filePath = doc.uri.fsPath;

      if (isScratchFile(filePath)) {
        // Scratch mode
        const content = doc.getText();
        const wsPath = workspaceFolder?.uri.fsPath;
        if (isProjectAware(content) && wsPath) {
          await executor.execute('scratch-project', filePath, wsPath);
        } else {
          await executor.execute('scratch-standalone', filePath);
        }
      } else if (workspaceFolder) {
        // Test mode
        const testRunScope = config.get<string>('testRunOnSave', 'current');
        if (testRunScope === 'off') return;
        await executor.execute('test', filePath, workspaceFolder.uri.fsPath);
      }
    })
  );

  // Re-apply decorations when switching editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Decorations are per-editor, re-applied when we get new results
    })
  );

  // Refresh tests on file changes
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'al' && workspaceFolder) {
        testController.refreshTests(workspaceFolder.uri.fsPath);
      }
    })
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('alchemist.newScratchFile', () =>
      scratchManager.newScratchFile(context.extensionPath)
    ),
    vscode.commands.registerCommand('alchemist.toggleProjectContext', () =>
      scratchManager.toggleProjectContext()
    ),
    vscode.commands.registerCommand('alchemist.deleteScratchFile', () =>
      scratchManager.deleteScratchFile()
    ),
    vscode.commands.registerCommand('alchemist.saveScratchAs', () =>
      scratchManager.saveScratchAs()
    ),
    vscode.commands.registerCommand('alchemist.runNow', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'al') {
        vscode.window.showWarningMessage('Open an AL file to run ALchemist.');
        return;
      }

      if (!runnerManager.getPath()) {
        try {
          await runnerManager.ensureInstalled();
        } catch {
          return;
        }
      }

      const filePath = editor.document.uri.fsPath;
      const wsPath = workspaceFolder?.uri.fsPath;

      if (isScratchFile(filePath)) {
        const content = editor.document.getText();
        if (isProjectAware(content) && wsPath) {
          await executor.execute('scratch-project', filePath, wsPath);
        } else {
          await executor.execute('scratch-standalone', filePath);
        }
      } else if (wsPath) {
        await executor.execute('test', filePath, wsPath);
      }
    }),
    vscode.commands.registerCommand('alchemist.stopRun', () => {
      executor.cancel();
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.clearDecorations', () => {
      decorationManager.clearAll();
      statusBar.setIdle();
    }),
    vscode.commands.registerCommand('alchemist.showOutput', () => {
      outputChannel.show();
    })
  );

  // --- Hover provider ---

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('al', new CoverageHoverProvider(decorationManager))
  );

  // Push all disposables
  context.subscriptions.push(
    executor,
    decorationManager,
    outputChannel,
    statusBar,
    testController
  );
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx webpack --mode development
```

Expected: compiles successfully.

- [ ] **Step 3: Test the extension locally**

Press `F5` in VSCode (or run the `Extension Development Host` launch config) to test:
1. Open an `.al` file — verify extension activates (status bar shows beaker icon)
2. Run `ALchemist: New Scratch File` from command palette — verify scratch file opens
3. Save the scratch file — verify AL.Runner is invoked (check output panel)
4. Run `ALchemist: Clear Results` — verify decorations are cleared

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire up extension entry point with all components"
```

---

### Task 13: Launch Configuration & Final Polish

**Files:**
- Create: `.vscode/launch.json`
- Verify: all files compile and package

- [ ] **Step 1: Write launch.json for extension debugging**

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "${defaultBuildTask}"
    },
    {
      "name": "Run Tests",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "--extensionTestsPath=${workspaceFolder}/out/test/runTest"
      ],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "npm: test-compile"
    }
  ]
}
```

- [ ] **Step 2: Verify resources are included in package**

The SVG gutter icons and AL template live in `resources/` at the project root. The `.vscodeignore` does NOT exclude `resources/`, so they're included in the `.vsix` package. `context.extensionPath` points to the extension root in both dev and production, so `path.join(extensionPath, 'resources', 'gutter-green.svg')` in `decorations.ts` resolves correctly. No copy plugin or additional config needed.

- [ ] **Step 3: Build and verify**

```bash
npx webpack --mode production
```

Expected: builds successfully, creates `dist/extension.js`.

- [ ] **Step 4: Package the extension**

```bash
npm install -g @vscode/vsce
vsce package
```

Expected: creates `alchemist-0.1.0.vsix`.

- [ ] **Step 5: Commit**

```bash
git add .vscode/launch.json webpack.config.js
git commit -m "chore: add launch config and finalize build setup"
```

---

## v1 Known Limitations

These limitations stem from AL.Runner's current CLI output and are documented for Phase 2/3:

1. **Hit counts are binary** — Cobertura XML records `hits: 0` or `hits: 1` only. The `// ×N` inline annotations shown in the design mockup require the future AL.Runner `--capture-values` or enhanced coverage output.
2. **Message() line mapping is best-effort** — In scratch mode, `Message()` output is matched to source lines by order of appearance. In test mode, messages appear in the output panel but can't be reliably mapped to specific lines.
3. **Error line mapping is approximate** — AL.Runner's `[AL line ~N in ObjectName]` suffix provides approximate line numbers. Exact column-level positioning requires future AL.Runner improvements.
4. **No incremental re-execution** — Every save triggers a full AL.Runner invocation. The future sidecar/server mode would enable incremental compilation.

## Future AL.Runner API Requirements (Carried from Design Spec)

For Phase 2/3, these changes to AL.Runner would unlock the full ALchemist experience:

- `--output-json`: Structured test results with per-line execution data, hit counts, and Message() source mapping
- `--server` mode: Long-running process with JSON-RPC for fast re-execution
- Incremental compilation: Re-run only changed codeunits
- `--capture-values`: Emit variable values at each statement for inline display
- Single-procedure execution for scratch codelens
- Column-level error line mapping
