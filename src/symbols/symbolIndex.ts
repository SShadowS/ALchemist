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

  async initialize(model: WorkspaceModel, parseCache: ParseCache): Promise<void> {
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

    // Pass 1: parse + declarations only
    for (const file of allFiles) {
      await this.parseFileDeclarations(file);
    }

    // Pass 2: resolve references now that all declarers are known
    for (const file of allFiles) {
      this.resolveFileReferences(file);
    }

    this.ready = true;
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
