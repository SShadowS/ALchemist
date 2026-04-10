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
