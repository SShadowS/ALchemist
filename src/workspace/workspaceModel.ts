import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { AlApp } from './types';
import { parseAppJsonFile } from './appJsonParser';

export type WarnCallback = (message: string) => void;

/** Trailing-edge debounce for FileSystemWatcher events (ms). */
export const FILE_WATCH_DEBOUNCE_MS = 200;

export class WorkspaceModel {
  private apps: AlApp[] = [];
  private reverseEdges: Map<string, string[]> | null = null;
  private appsById: Map<string, AlApp> = new Map();
  private cycleDetected: boolean | null = null;
  private listeners = new Set<() => void>();
  private lastSignature = '';

  constructor(
    private workspaceFolders: string[],
    private warn: WarnCallback = () => {},
  ) {}

  async scan(): Promise<void> {
    this.apps = [];
    this.appsById.clear();
    this.reverseEdges = null;
    this.cycleDetected = null;

    const seen = new Set<string>();
    for (const folder of this.workspaceFolders) {
      const roots = findAppJsonRootsIn(folder);
      for (const root of roots) {
        if (seen.has(root)) continue;
        seen.add(root);

        const result = parseAppJsonFile(path.join(root, 'app.json'));
        if (!result.ok) {
          this.warn(`ALchemist: failed to parse ${result.error.path}: ${result.error.message}`);
          continue;
        }
        this.apps.push(result.app);
        this.appsById.set(result.app.id, result.app);
      }
    }

    this.lastSignature = this.computeSignature();
  }

  /**
   * Subscribe to workspace-model changes. Returns an unsubscribe function.
   * Fires exactly once per `triggerRescan` that produces a different app set
   * (identity by app.path + version string).
   */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Force a rescan. Intended to be called from a debounced FileSystemWatcher
   * handler in production; also called directly from tests.
   */
  async triggerRescan(): Promise<void> {
    const prevSignature = this.lastSignature;
    await this.scan(); // scan() sets this.lastSignature to the new signature
    if (this.lastSignature !== prevSignature) {
      for (const listener of this.listeners) listener();
    }
  }

  private computeSignature(): string {
    return this.apps
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(a => `${a.path}|${a.id}|${a.version}|${a.dependencies.map(d => d.id).join(',')}`)
      .join('\n');
  }

  getApps(): AlApp[] {
    return [...this.apps];
  }

  /**
   * Return `appId`'s own app plus all apps that transitively depend on it.
   * Save-triggered test runs walk this set: editing a file in app X warrants
   * running tests in every app that (directly or transitively) depends on X.
   *
   * Returns [] if appId matches no known app.
   */
  getDependents(appId: string): AlApp[] {
    const root = this.appsById.get(appId);
    if (!root) return [];

    // Build reverse adjacency once, cache until next scan().
    if (!this.reverseEdges) {
      this.reverseEdges = new Map<string, string[]>();
      for (const app of this.apps) {
        for (const dep of app.dependencies) {
          const list = this.reverseEdges.get(dep.id) ?? [];
          list.push(app.id);
          this.reverseEdges.set(dep.id, list);
        }
      }
    }

    // Cache cycle-detection result once per scan.
    if (this.cycleDetected === null) {
      this.cycleDetected = hasCycle(this.apps);
      if (this.cycleDetected) {
        this.warn('ALchemist: dependency cycle detected in app.json graph; results may be incomplete.');
      }
    }

    const visited = new Set<string>();
    const result: AlApp[] = [];
    const reverseEdges = this.reverseEdges;
    const appsById = this.appsById;

    function dfs(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      const app = appsById.get(id);
      if (app) result.push(app);
      for (const dependentId of reverseEdges.get(id) ?? []) {
        dfs(dependentId);
      }
    }

    dfs(appId);
    return result;
  }

  /**
   * Return `appId`'s own app plus all apps it transitively depends on
   * (forward closure). Used to compute the AL.Runner source-path set:
   * AL.Runner needs the test app plus every app it imports symbols from
   * to resolve cross-app references during transpile.
   *
   * Returns [] if appId matches no known app.
   */
  getDependencies(appId: string): AlApp[] {
    const root = this.appsById.get(appId);
    if (!root) return [];

    // Reuse the cycle warning gate from getDependents.
    if (this.cycleDetected === null) {
      this.cycleDetected = hasCycle(this.apps);
      if (this.cycleDetected) {
        this.warn('ALchemist: dependency cycle detected in app.json graph; results may be incomplete.');
      }
    }

    const visited = new Set<string>();
    const result: AlApp[] = [];
    const appsById = this.appsById;

    function dfs(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      const app = appsById.get(id);
      if (!app) return;
      result.push(app);
      for (const dep of app.dependencies) {
        dfs(dep.id);
      }
    }

    dfs(appId);
    return result;
  }

  /**
   * Return the AlApp whose path is the longest prefix of `filePath`. If
   * filePath is outside every app, returns undefined.
   */
  getAppContaining(filePath: string): AlApp | undefined {
    const abs = path.resolve(filePath);
    let best: AlApp | undefined;
    for (const app of this.apps) {
      const appPrefix = path.resolve(app.path) + path.sep;
      if (abs.startsWith(appPrefix) || abs === path.resolve(app.path)) {
        if (!best || path.resolve(app.path).length > path.resolve(best.path).length) {
          best = app;
        }
      }
    }
    return best;
  }
}

/**
 * Three-color DFS cycle detection on the dependency graph.
 * Returns true if any cycle exists among the provided apps.
 */
function hasCycle(apps: AlApp[]): boolean {
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen, 1=onstack, 2=done
  const byId = new Map(apps.map(a => [a.id, a] as const));

  function visit(id: string): boolean {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;      // back edge
    if (s === 2) return false;     // already proven acyclic from here
    state.set(id, 1);
    const app = byId.get(id);
    if (app) {
      for (const dep of app.dependencies) {
        if (byId.has(dep.id) && visit(dep.id)) return true;
      }
    }
    state.set(id, 2);
    return false;
  }

  for (const app of apps) {
    if (visit(app.id)) return true;
  }
  return false;
}

/** Directories never recursed into during workspace/file scans. Shared by WorkspaceModel and testDiscovery. */
export const EXCLUDED_DIR_NAMES = new Set([
  '.alpackages',
  '.alcache',
  'node_modules',
  '.AL-Go',
  '.git',
  '.hg',
  '.svn',
  'bin',
  'obj',
  'out',
  '.snapshots',
  '.vscode-test',
]);

/**
 * Walk `root` recursively, returning the absolute path of every folder that
 * contains an app.json. Once an app.json is found in a folder, descent stops
 * there — nested apps are not supported in AL.
 */
export function findAppJsonRootsIn(root: string): string[] {
  const results: string[] = [];
  walk(root);
  return results;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }

    // If this directory itself contains app.json, record and stop descent.
    if (entries.some(e => e.isFile() && e.name.toLowerCase() === 'app.json')) {
      results.push(dir);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !EXCLUDED_DIR_NAMES.has(entry.name)) {
        walk(path.join(dir, entry.name));
      }
    }
  }
}

/**
 * Wire a WorkspaceModel to VS Code FileSystemWatcher events. The watcher
 * observes every `app.json` under every workspaceFolder; changes debounce
 * (200ms trailing) into a single `triggerRescan` call.
 *
 * Returns a disposable that tears down the watcher.
 */
export function bindWorkspaceModelToVsCode(
  model: WorkspaceModel,
  vscodeApi: typeof vscode,
): { dispose(): void } {
  const watcher = vscodeApi.workspace.createFileSystemWatcher('**/app.json');
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void model.triggerRescan(); }, FILE_WATCH_DEBOUNCE_MS);
  };
  const subs = [
    watcher.onDidCreate(schedule),
    watcher.onDidChange(schedule),
    watcher.onDidDelete(schedule),
  ];
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      for (const s of subs) s.dispose();
      watcher.dispose();
    },
  };
}
