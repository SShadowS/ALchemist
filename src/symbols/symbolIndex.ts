import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceModel } from '../workspace/workspaceModel';
import { ParseCache } from './parseCache';
import { extractSymbols } from './symbolExtractor';
import { FileSymbols, TestProcedure } from './types';

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.alpackages', '.alcache', '.git', '.AL-Go',
  'bin', 'obj', 'out', '.snapshots', '.vscode-test',
]);

export class SymbolIndex {
  private fileSymbols = new Map<string, FileSymbols>();
  private declarers = new Map<string, string>();           // FqName → declarer file path
  private referrers = new Map<string, Set<string>>();      // FqName → Set of referrer paths
  private fileToAppId = new Map<string, string>();          // file path → AlApp.id

  private parseCache: ParseCache | undefined;
  private model: WorkspaceModel | undefined;
  private ready = false;
  private settled = true;
  private pendingFiles = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  async initialize(
    model: WorkspaceModel,
    parseCache: ParseCache,
    onProgress?: (current: number, total: number) => void,
  ): Promise<void> {
    this.model = model;
    this.parseCache = parseCache;
    if (!parseCache.isAvailable()) {
      this.ready = false;
      return;
    }
    this.fileSymbols.clear();
    this.declarers.clear();
    this.referrers.clear();
    this.fileToAppId.clear();

    // Two-pass scan:
    // Pass 1: parse all files, populate fileSymbols and declarers.
    //         References are NOT resolved yet — declarers must be complete first.
    // Pass 2: resolve references against the fully-populated declarers map.
    const allFiles: string[] = [];
    for (const app of model.getApps()) {
      const alFiles = findAlFiles(app.path);
      for (const file of alFiles) {
        this.fileToAppId.set(file, app.id);
        allFiles.push(file);
      }
    }

    const totalFiles = allFiles.length;
    let processed = 0;

    // Pass 1: parse + declarations only
    for (const file of allFiles) {
      await this.parseFileDeclarations(file);
      processed++;
      if (onProgress && processed % 32 === 0) {
        onProgress(processed, totalFiles);
      }
    }

    // Pass 2: resolve references now that all declarers are known
    for (const file of allFiles) {
      this.resolveFileReferences(file);
    }

    if (onProgress) {
      onProgress(totalFiles, totalFiles);
    }

    this.ready = true;
    // Initial-scan parse errors are not "pending reparse" — those files are
    // represented by their last-good edges (or empty if never parsed clean).
    // Clear pendingFiles so isSettled() doesn't permanently report false on
    // a workspace where any file has stale syntax errors at startup.
    // The per-saved-file confidence gate in getTestsAffectedBy still checks
    // pendingFiles.has(savedFile) — that is set by refreshFile() during edits,
    // not by initial scan.
    this.pendingFiles.clear();
    this.settled = true;
    this.emitter.fire();
  }

  isReady(): boolean { return this.ready; }
  isSettled(): boolean { return this.settled && this.pendingFiles.size === 0; }

  getDeclarer(fqName: string): string | undefined {
    return this.declarers.get(fqName);
  }

  getReferencers(fqName: string): Set<string> {
    return this.referrers.get(fqName) ?? new Set();
  }

  getTestsInFile(filePath: string): TestProcedure[] {
    return this.fileSymbols.get(filePath)?.tests ?? [];
  }

  getAllTests(): Map<string, TestProcedure[]> {
    const out = new Map<string, TestProcedure[]>();
    for (const [file, syms] of this.fileSymbols) {
      const appId = this.fileToAppId.get(file);
      if (!appId || syms.tests.length === 0) continue;
      const list = out.get(appId) ?? [];
      list.push(...syms.tests);
      out.set(appId, list);
    }
    return out;
  }

  /** Parse a file, store its symbols, and register its declarations only. Used in Pass 1 of initial scan. */
  private async parseFileDeclarations(filePath: string): Promise<void> {
    if (!this.parseCache) return;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      this.removeFile(filePath);
      return;
    }
    const parse = this.parseCache.parse(filePath, content);
    if (!parse) return;
    if (parse.hasErrors) {
      this.pendingFiles.add(filePath);
      return;
    }
    this.pendingFiles.delete(filePath);
    const symbols = extractSymbols(parse);

    const old = this.fileSymbols.get(filePath);
    if (old) this.removeFileEdges(filePath, old);

    this.fileSymbols.set(filePath, symbols);
    for (const decl of symbols.declared) {
      this.declarers.set(decl.fqName, filePath);
    }
  }

  /** Resolve references for an already-parsed file against the current declarers map. Used in Pass 2. */
  private resolveFileReferences(filePath: string): void {
    const symbols = this.fileSymbols.get(filePath);
    if (!symbols) return;
    // Remove any stale referrer edges for this file before re-adding
    for (const [fq, set] of this.referrers) {
      set.delete(filePath);
      if (set.size === 0) this.referrers.delete(fq);
    }
    for (const ref of symbols.references) {
      const fq = this.resolveReferencerFq(ref.name, symbols);
      if (!fq) continue;
      const set = this.referrers.get(fq) ?? new Set();
      set.add(filePath);
      this.referrers.set(fq, set);
    }
  }

  /** Incremental update for a single file: re-parse declarations then re-resolve references. */
  async refreshFile(filePath: string): Promise<void> {
    await this.parseFileDeclarations(filePath);
    // After updating declarations, re-resolve ALL files' references because
    // a declaration change in one file can affect reference resolution elsewhere.
    // For now (initial skeleton), re-resolve only the updated file itself,
    // which is correct when declarations don't change kind/fqName.
    this.resolveFileReferences(filePath);
  }

  private resolveReferencerFq(name: string, symbols: FileSymbols): string | undefined {
    if (symbols.namespace) {
      const candidate = `${symbols.namespace}.${name}`;
      if (this.declarers.has(candidate)) return candidate;
    }
    for (const ns of symbols.usings) {
      const candidate = `${ns}.${name}`;
      if (this.declarers.has(candidate)) return candidate;
    }
    if (this.declarers.has(name)) return name;
    return undefined;
  }

  removeFile(filePath: string): void {
    const old = this.fileSymbols.get(filePath);
    if (old) this.removeFileEdges(filePath, old);
    this.fileSymbols.delete(filePath);
    this.fileToAppId.delete(filePath);
    this.pendingFiles.delete(filePath);
  }

  private removeFileEdges(filePath: string, old: FileSymbols): void {
    for (const decl of old.declared) {
      if (this.declarers.get(decl.fqName) === filePath) {
        this.declarers.delete(decl.fqName);
      }
    }
    for (const [fq, set] of this.referrers) {
      set.delete(filePath);
      if (set.size === 0) this.referrers.delete(fq);
    }
  }

  /**
   * Returns tests affected by editing `filePath`:
   *   union of (a) tests declared in filePath
   *           (b) tests in OTHER files that reference any symbol declared in filePath.
   * Returns null when low-confidence:
   *   - filePath has parse errors (in pendingFiles), or
   *   - index not settled (any file pending).
   */
  getTestsAffectedBy(filePath: string): TestProcedure[] | null {
    if (!this.ready) return null;
    if (this.pendingFiles.has(filePath)) return null;
    if (!this.isSettled()) return null;

    const own = this.fileSymbols.get(filePath);
    if (!own) return [];

    const affected: TestProcedure[] = [...own.tests];
    const seen = new Set<string>();
    for (const t of own.tests) seen.add(`${filePath}|${t.procName}`);

    for (const decl of own.declared) {
      const referrers = this.referrers.get(decl.fqName);
      if (!referrers) continue;
      for (const refFile of referrers) {
        if (refFile === filePath) continue;
        const refSyms = this.fileSymbols.get(refFile);
        if (!refSyms) continue;
        for (const t of refSyms.tests) {
          const key = `${refFile}|${t.procName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          affected.push(t);
        }
      }
    }
    return affected;
  }

  /**
   * Return the AlApp.id that owns a given test (looked up via fileToAppId
   * and reverse-walking from TestProcedure → declaring file).
   * Used by precision-tier app-narrowing in routeSave.
   */
  getAppIdForTest(test: TestProcedure): string | undefined {
    // Find the file declaring this test by scanning fileSymbols.
    for (const [file, syms] of this.fileSymbols) {
      if (syms.tests.some(t =>
        t.codeunitId === test.codeunitId &&
        t.codeunitName === test.codeunitName &&
        t.procName === test.procName
      )) {
        return this.fileToAppId.get(file);
      }
    }
    return undefined;
  }

  dispose(): void {
    this.fileSymbols.clear();
    this.declarers.clear();
    this.referrers.clear();
    this.fileToAppId.clear();
    this.pendingFiles.clear();
    this.emitter.dispose();
    this.ready = false;
  }
}

const FILE_WATCH_DEBOUNCE_MS = 100;

/**
 * Wire SymbolIndex to VS Code FileSystemWatcher events on **\/*.al.
 * Debounces 100ms trailing per file. Returns disposable.
 */
export function bindSymbolIndexToVsCode(
  index: SymbolIndex,
  vscodeApi: typeof vscode,
): { dispose(): void } {
  const watcher = vscodeApi.workspace.createFileSystemWatcher('**/*.al');
  const timers = new Map<string, NodeJS.Timeout>();

  function schedule(uri: vscode.Uri, action: 'refresh' | 'remove') {
    const file = uri.fsPath;
    const old = timers.get(file);
    if (old) clearTimeout(old);
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      if (action === 'remove') index.removeFile(file);
      else void index.refreshFile(file);
    }, FILE_WATCH_DEBOUNCE_MS));
  }

  const subs = [
    watcher.onDidCreate((u) => schedule(u, 'refresh')),
    watcher.onDidChange((u) => schedule(u, 'refresh')),
    watcher.onDidDelete((u) => schedule(u, 'remove')),
  ];

  return {
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const s of subs) s.dispose();
      watcher.dispose();
    },
  };
}

function findAlFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir);
  return out;
  function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIR_NAMES.has(e.name)) walk(path.join(d, e.name));
      else if (e.isFile() && e.name.endsWith('.al')) out.push(path.join(d, e.name));
    }
  }
}
