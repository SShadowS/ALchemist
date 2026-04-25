import * as fs from 'fs';
import * as path from 'path';

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
