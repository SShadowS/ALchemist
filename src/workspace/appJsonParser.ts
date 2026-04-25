import * as fs from 'fs';
import * as path from 'path';
import { AlApp, AppJsonParseResult } from './types';

/**
 * Parse an app.json file on disk. Returns { ok: false, error } on any failure
 * (file missing, invalid JSON, missing required fields). Never throws.
 */
export function parseAppJsonFile(appJsonPath: string): AppJsonParseResult {
  let raw: string;
  try {
    raw = fs.readFileSync(appJsonPath, 'utf-8');
  } catch (err: any) {
    return { ok: false, error: { path: appJsonPath, message: `read failed: ${err.message}` } };
  }
  return parseAppJsonContent(raw, appJsonPath);
}

/**
 * Parse app.json content. Shared with parseAppJsonFile and exposed for unit
 * tests that supply content directly without touching the filesystem.
 */
export function parseAppJsonContent(content: string, appJsonPath: string): AppJsonParseResult {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return { ok: false, error: { path: appJsonPath, message: `JSON parse error: ${err.message}` } };
  }

  const missing: string[] = [];
  if (typeof parsed.id !== 'string') missing.push('id');
  if (typeof parsed.name !== 'string') missing.push('name');
  if (typeof parsed.publisher !== 'string') missing.push('publisher');
  if (typeof parsed.version !== 'string') missing.push('version');
  if (missing.length > 0) {
    return {
      ok: false,
      error: { path: appJsonPath, message: `missing required field(s): ${missing.join(', ')}` },
    };
  }

  const deps = Array.isArray(parsed.dependencies) ? parsed.dependencies : [];
  const app: AlApp = {
    path: path.dirname(appJsonPath),
    id: parsed.id,
    name: parsed.name,
    publisher: parsed.publisher,
    version: parsed.version,
    dependencies: deps
      .filter((d: any) => typeof d === 'object' && d !== null)
      .map((d: any) => ({
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        publisher: String(d.publisher ?? ''),
        version: String(d.version ?? ''),
      })),
  };
  return { ok: true, app };
}
