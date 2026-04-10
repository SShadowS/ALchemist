// Minimal vscode mock for unit tests run outside the VS Code host
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
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Uri: {
    file: (path) => ({ fsPath: path }),
  },
};
