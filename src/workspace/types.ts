export interface AlAppDependency {
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export interface AlApp {
  /** Absolute path to the folder containing app.json */
  path: string;
  /** app.json "id" — GUID */
  id: string;
  /** app.json "name" */
  name: string;
  /** app.json "publisher" */
  publisher: string;
  /** app.json "version" */
  version: string;
  /** app.json "dependencies" (empty array if none) */
  dependencies: AlAppDependency[];
}

export interface AppJsonParseError {
  path: string;
  message: string;
}

export type AppJsonParseResult =
  | { ok: true; app: AlApp }
  | { ok: false; error: AppJsonParseError };
