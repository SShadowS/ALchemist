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

module.exports = {
  workspace: {
    openTextDocument: async () => ({}),
    applyEdit: async () => true,
    workspaceFolders: [],
  },
  window: {
    showTextDocument: async () => ({}),
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showSaveDialog: async () => undefined,
    activeTextEditor: undefined,
  },
  commands: {
    executeCommand: async () => {},
  },
  tests: {
    createTestController: (id, label) => ({
      id,
      label,
      items: new MockTestItemCollection(),
      createRunProfile: () => ({}),
      createTestItem: createMockTestItem,
      createTestRun: () => ({
        passed: () => {},
        failed: () => {},
        errored: () => {},
        skipped: () => {},
        end: () => {},
      }),
      dispose: () => {},
    }),
  },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  TestMessage: class TestMessage {
    constructor(message) { this.message = message; }
  },
  TestRunRequest: class TestRunRequest {
    constructor(include, exclude, profile) {
      this.include = include;
      this.exclude = exclude;
      this.profile = profile;
    }
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
  CodeLens: class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
  },
  Uri: {
    file: (path) => ({ fsPath: path }),
  },
};
