// Minimal vscode mock for unit tests run outside the VS Code host

class MockTestItemCollection {
  constructor() { this._items = new Map(); }
  add(item) { this._items.set(item.id, item); }
  replace(items) { this._items.clear(); for (const item of items) { this._items.set(item.id, item); } }
  delete(id) { this._items.delete(id); }
  get size() { return this._items.size; }
  forEach(cb) { this._items.forEach(cb); }
}

function createMockTestItem(id, label, uri) {
  return { id, label, uri, children: new MockTestItemCollection(), range: undefined };
}

/**
 * Spy-friendly TestRun. Records every call so unit tests can assert on
 * order, arguments, and per-method counts. Used by streaming/v2 tests.
 */
class MockTestRun {
  constructor(request) {
    this.request = request;
    this.passedCalls = [];
    this.failedCalls = [];
    this.erroredCalls = [];
    this.skippedCalls = [];
    this.coverageCalls = [];
    this.ended = false;
  }
  passed(item, duration) { this.passedCalls.push({ item, duration }); }
  failed(item, message, duration) { this.failedCalls.push({ item, message, duration }); }
  errored(item, message, duration) { this.erroredCalls.push({ item, message, duration }); }
  skipped(item) { this.skippedCalls.push({ item }); }
  addCoverage(fc) { this.coverageCalls.push(fc); }
  end() { this.ended = true; }
}

/**
 * Mock controller. Exposes `__lastRunProfile`, `__runProfiles`, and
 * `__lastTestRun` so tests can drive the run-profile callback directly
 * and observe the resulting TestRun without resorting to deeper hacks.
 */
function createMockTestController(id, label) {
  const controller = {
    id,
    label,
    items: new MockTestItemCollection(),
    __runProfiles: [],
    __lastRunProfile: undefined,
    __lastTestRun: undefined,
    createRunProfile(profileLabel, kind, runHandler, isDefault) {
      const profile = {
        label: profileLabel,
        kind,
        runHandler,
        isDefault,
        loadDetailedCoverage: undefined,
      };
      controller.__runProfiles.push(profile);
      controller.__lastRunProfile = profile;
      return profile;
    },
    createTestItem: createMockTestItem,
    createTestRun(request) {
      const run = new MockTestRun(request);
      controller.__lastTestRun = run;
      return run;
    },
    dispose() {},
  };
  return controller;
}

/**
 * Minimal MarkdownString mock — appendMarkdown / appendCodeblock noop-record.
 */
class MockMarkdownString {
  constructor(value) {
    this.value = value || '';
    this.isTrusted = false;
  }
  appendMarkdown(s) { this.value += s; return this; }
  appendCodeblock(s, _lang) { this.value += s; return this; }
}

/**
 * Spy-friendly TextEditorDecorationType. The DecorationManager stores
 * each instance and calls editor.setDecorations(type, options); tests
 * can match by reference identity.
 */
class MockTextEditorDecorationType {
  constructor(options) {
    this.options = options;
    this.disposed = false;
  }
  dispose() { this.disposed = true; }
}

/**
 * Spy-friendly StatusBarItem. Records the most-recent text/tooltip/command
 * assignments so tests can assert on observable side-effects without
 * driving the real VS Code window. show()/hide() are no-ops; dispose()
 * sets a flag so leak-checks can verify the manager cleaned up.
 */
class MockStatusBarItem {
  constructor(alignment, priority) {
    this.alignment = alignment;
    this.priority = priority;
    this.text = '';
    this.tooltip = undefined;
    this.command = undefined;
    this.color = undefined;
    this.backgroundColor = undefined;
    this.shown = false;
    this.disposed = false;
  }
  show() { this.shown = true; }
  hide() { this.shown = false; }
  dispose() { this.disposed = true; }
}

module.exports = {
  workspace: {
    openTextDocument: async () => ({}),
    applyEdit: async () => true,
    workspaceFolders: [],
    getConfiguration: (_section) => ({
      get: (_key, defaultValue) => defaultValue,
    }),
  },
  window: {
    showTextDocument: async () => ({}),
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    showSaveDialog: async () => undefined,
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createTextEditorDecorationType: (options) => new MockTextEditorDecorationType(options),
    createStatusBarItem: (alignment, priority) => new MockStatusBarItem(alignment, priority),
  },
  commands: {
    executeCommand: async () => {},
  },
  tests: {
    createTestController: (id, label) => createMockTestController(id, label),
  },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TestMessage: class TestMessage {
    constructor(message) { this.message = message; }
  },
  TestMessageStackFrame: class TestMessageStackFrame {
    constructor(label, uri, position) {
      this.label = label;
      this.uri = uri;
      this.position = position;
    }
  },
  TestRunRequest: class TestRunRequest {
    constructor(include, exclude, profile) {
      this.include = include;
      this.exclude = exclude;
      this.profile = profile;
    }
  },
  CancellationTokenSource: class CancellationTokenSource {
    constructor() {
      this._listeners = [];
      const self = this;
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb) => {
          self._listeners.push(cb);
          return { dispose: () => { self._listeners = self._listeners.filter(l => l !== cb); } };
        },
      };
    }
    cancel() {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      const listeners = this._listeners.slice();
      this._listeners = [];
      for (const cb of listeners) {
        try { cb(); } catch { /* noop */ }
      }
    }
    dispose() { this._listeners = []; }
  },
  EventEmitter: class EventEmitter {
    constructor() { this._listeners = []; }
    get event() { return (listener) => { this._listeners.push(listener); return { dispose: () => {} }; }; }
    fire(data) { this._listeners.forEach(l => l(data)); }
    dispose() { this._listeners = []; }
  },
  WorkspaceEdit: class WorkspaceEdit {
    delete() {}
    insert() {}
  },
  Position: class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class Range {
    constructor(startOrLine, endOrChar, endLine, endChar) {
      if (typeof startOrLine === 'number') {
        // 4-argument form: (startLine, startChar, endLine, endChar)
        this.start = { line: startOrLine, character: endOrChar };
        this.end = { line: endLine, character: endChar };
      } else {
        // 2-argument form: (startPosition, endPosition)
        this.start = startOrLine;
        this.end = endOrChar;
      }
    }
  },
  Location: class Location {
    constructor(uri, rangeOrPosition) {
      this.uri = uri;
      if (rangeOrPosition && Object.prototype.hasOwnProperty.call(rangeOrPosition, 'start')) {
        this.range = rangeOrPosition;
      } else {
        this.range = { start: rangeOrPosition, end: rangeOrPosition };
      }
    }
  },
  CodeLens: class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  MarkdownString: MockMarkdownString,
  ThemeColor: class ThemeColor {
    constructor(id) { this.id = id; }
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
  },
  Uri: {
    file: (path) => ({
      fsPath: path,
      toString: () => `file://${path.replace(/\\/g, '/')}`,
    }),
  },
  TestCoverageCount: class TestCoverageCount {
    constructor(covered, total) {
      this.covered = covered;
      this.total = total;
    }
  },
  FileCoverage: class FileCoverage {
    constructor(uri, statementCoverage, branchCoverage, declarationCoverage, includesTests) {
      this.uri = uri;
      this.statementCoverage = statementCoverage;
      this.branchCoverage = branchCoverage;
      this.declarationCoverage = declarationCoverage;
      this.includesTests = includesTests;
    }
    /**
     * Mirror of vscode.FileCoverage.fromDetails (VS Code 1.88+):
     * derive statement totals from a detail array.
     *   - total   = details.length
     *   - covered = details where executed > 0 (or === true)
     * branchCoverage / declarationCoverage are left undefined; this matches
     * what the public factory does for callers that supply only statement
     * details.
     */
    static fromDetails(uri, details) {
      const total = details.length;
      const covered = details.filter(d => {
        const e = d.executed;
        return typeof e === 'number' ? e > 0 : !!e;
      }).length;
      // Lazy-grab TestCoverageCount from module.exports so the same class
      // identity is used as the rest of the mock.
      const TCC = module.exports.TestCoverageCount;
      return new module.exports.FileCoverage(uri, new TCC(covered, total), undefined, undefined);
    }
  },
  StatementCoverage: class StatementCoverage {
    constructor(executed, location, branches) {
      this.executed = executed;
      this.location = location;
      this.branches = branches ?? [];
    }
  },
};
