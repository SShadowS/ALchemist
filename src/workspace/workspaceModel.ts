import * as fs from 'fs';
import * as path from 'path';
import { AlApp } from './types';
import { parseAppJsonFile } from './appJsonParser';

export type WarnCallback = (message: string) => void;

export class WorkspaceModel {
  private apps: AlApp[] = [];
  // Map from app path → AlApp; used for fast dep-graph lookups later.
  private appsByPath = new Map<string, AlApp>();

  constructor(
    private workspaceFolders: string[],
    private warn: WarnCallback = () => {},
  ) {}

  async scan(): Promise<void> {
    this.apps = [];
    this.appsByPath.clear();

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
        this.appsByPath.set(result.app.path, result.app);
      }
    }
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
    const root = this.apps.find(a => a.id === appId);
    if (!root) return [];

    // Build reverse adjacency: for each app, which apps list it in deps.
    const reverseEdges = new Map<string, string[]>();
    for (const app of this.apps) {
      for (const dep of app.dependencies) {
        const list = reverseEdges.get(dep.id) ?? [];
        list.push(app.id);
        reverseEdges.set(dep.id, list);
      }
    }

    const visited = new Set<string>();
    const result: AlApp[] = [];

    const dfs = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const app = this.apps.find(a => a.id === id);
      if (app) result.push(app);

      for (const dependentId of reverseEdges.get(id) ?? []) {
        dfs(dependentId);
      }
    };

    // Detect cycles via standard three-color DFS on forward edges.
    if (hasCycle(this.apps)) {
      this.warn('ALchemist: dependency cycle detected in app.json graph; results may be incomplete.');
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

/** Directories never recursed into during workspace scan. */
const EXCLUDED_DIR_NAMES = new Set([
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
