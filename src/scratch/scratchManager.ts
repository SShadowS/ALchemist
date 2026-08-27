import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AlApp } from '../workspace/types';

export type ScratchAppResolution =
  | { mode: 'standalone' }
  | { mode: 'app'; app: AlApp }
  | { mode: 'needsPrompt'; choices: AlApp[] };

/**
 * Decide which AL app context to use for a project-aware scratch file.
 *
 * Priority:
 *   1. `settingAppId` (user's `alchemist.scratchProjectAppId` setting) if it
 *      matches an app in `apps`.
 *   2. `persistedAppId` (stored in ext global state keyed by scratch file
 *      path) if it matches an app in `apps`.
 *   3. With 0 apps: standalone. With 1 app: that app. With N: prompt.
 */
export function resolveScratchProjectApp(
  apps: AlApp[],
  settingAppId: string | undefined,
  persistedAppId: string | undefined,
): ScratchAppResolution {
  if (apps.length === 0) return { mode: 'standalone' };

  if (settingAppId) {
    const match = apps.find(a => a.id === settingAppId);
    if (match) return { mode: 'app', app: match };
  }

  if (persistedAppId) {
    const match = apps.find(a => a.id === persistedAppId);
    if (match) return { mode: 'app', app: match };
  }

  if (apps.length === 1) return { mode: 'app', app: apps[0] };
  return { mode: 'needsPrompt', choices: apps };
}

const SCRATCH_DIR_NAME = 'alchemist-scratch';
const PROJECT_DIRECTIVE_REGEX = /^\/\/\s*alchemist:\s*project/i;

export function isProjectAware(fileContent: string): boolean {
  const firstLine = fileContent.split('\n')[0] || '';
  return PROJECT_DIRECTIVE_REGEX.test(firstLine.trim());
}

export function isScratchFile(filePath: string): boolean {
  return filePath.includes(SCRATCH_DIR_NAME);
}

const SCRATCH_BUNDLE_NAME_REGEX = /^scratch(\d+)$/;

/**
 * The bundle directory to hand AL.Runner for a given scratch file.
 *
 * AL.Runner 2.7.0's `execute` command requires `sourcePaths` entries to be
 * bundle directories, not individual .al files — passing the scratch file
 * itself fails with "bundle directory not found". Each scratch file lives
 * in its own same-named subdirectory of alchemist-scratch/, so the bundle
 * directory is simply that file's parent directory.
 */
export function getScratchBundleDir(scratchFilePath: string): string {
  return path.dirname(scratchFilePath);
}

export class ScratchManager {
  private readonly scratchDir: string;
  private scratchCounter = 0;

  constructor(globalStoragePath: string) {
    this.scratchDir = path.join(globalStoragePath, SCRATCH_DIR_NAME);
    if (!fs.existsSync(this.scratchDir)) {
      fs.mkdirSync(this.scratchDir, { recursive: true });
    }
    // Older versions left scratch files loose directly in scratchDir; move
    // each into its own same-named subdirectory so AL.Runner 2.7.0's
    // bundle-directory requirement is met (see getScratchBundleDir above).
    this.migrateLooseScratchFiles();
    // Continue numbering from the highest existing bundle directory so a
    // new file never collides with one left behind by a gap (e.g. scratch2
    // deleted while scratch1 and scratch3 still exist).
    this.scratchCounter = this.findHighestScratchIndex();
  }

  /**
   * Move any `*.al` sitting loose directly in scratchDir into its own
   * same-named subdirectory (e.g. `scratch1.al` -> `scratch1/scratch1.al`).
   * Safe to run every time the manager is constructed: once a file has been
   * moved it is no longer a loose file, so a second pass finds nothing left
   * to do. Never overwrites an existing target — a loose file whose target
   * directory already holds a same-named file is left in place untouched.
   */
  private migrateLooseScratchFiles(): void {
    const entries = fs.readdirSync(this.scratchDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.al')) continue;
      const baseName = path.parse(entry.name).name;
      const loosePath = path.join(this.scratchDir, entry.name);
      const targetDir = path.join(this.scratchDir, baseName);
      const targetPath = path.join(targetDir, entry.name);
      if (fs.existsSync(targetPath)) {
        // Target already claimed — leave the loose file alone rather than
        // clobbering whatever is already bundled there.
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(loosePath, targetPath);
    }
  }

  /** Highest `scratchN` bundle-directory index currently under scratchDir (0 if none). */
  private findHighestScratchIndex(): number {
    const entries = fs.readdirSync(this.scratchDir, { withFileTypes: true });
    let highest = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = SCRATCH_BUNDLE_NAME_REGEX.exec(entry.name);
      if (match) {
        highest = Math.max(highest, parseInt(match[1], 10));
      }
    }
    return highest;
  }

  async newScratchFile(extensionPath: string): Promise<vscode.TextEditor> {
    this.scratchCounter++;
    const fileName = `scratch${this.scratchCounter}.al`;
    const bundleDir = path.join(this.scratchDir, `scratch${this.scratchCounter}`);
    fs.mkdirSync(bundleDir, { recursive: true });
    const filePath = path.join(bundleDir, fileName);

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
    this.removeEmptyBundleDir(filePath);
  }

  /** Remove a scratch file's bundle directory, but only if it is now empty and genuinely inside scratchDir. */
  private removeEmptyBundleDir(scratchFilePath: string): void {
    const bundleDir = getScratchBundleDir(scratchFilePath);
    const relativeToScratchDir = path.relative(this.scratchDir, bundleDir);
    // Never remove scratchDir itself, and never step outside it.
    if (relativeToScratchDir === '' || relativeToScratchDir.startsWith('..') || path.isAbsolute(relativeToScratchDir)) {
      return;
    }
    if (!fs.existsSync(bundleDir)) return;
    if (fs.readdirSync(bundleDir).length === 0) {
      fs.rmdirSync(bundleDir);
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
