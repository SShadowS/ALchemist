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
