import * as vscode from 'vscode';
import { ALCHEMIST_DEBUG_TYPE } from './debugAdapterFactory';

/**
 * Launch configuration for a debug session started from the Test Explorer.
 *
 * `bundleDir` is always set — it's the compatibility fallback
 * `resolveSourcePaths` (Task 7) uses when no `sourcePaths` list is given,
 * and the single-directory shape upstream's own docs still show. When the
 * caller has resolved a multi-app dependency closure for the selected test
 * — the same derivation `AlchemistTestController.runTests` uses for
 * ordinary (non-debug) runs, since a declared app dependency does not
 * auto-resolve from a sibling folder — `sourcePaths` is set too, and
 * `resolveSourcePaths` prefers it over `bundleDir`. An empty `sourcePaths`
 * list is omitted rather than sent as `[]`: `resolveSourcePaths` treats a
 * non-empty list as authoritative, so an empty one must not win over
 * `bundleDir` and produce an empty `--dap` invocation.
 *
 * `testFilter` is omitted rather than set to undefined when no single test
 * is selected: an explicit undefined would be serialized into the
 * configuration and read by the adapter as a filter matching nothing.
 *
 * `testFilter` itself is UNVERIFIED against AL.Runner: nothing in the
 * reachable AL.Runner source (`AlRunner/Program.cs`, `AlRunner/DapServer.cs`,
 * `docs/dap.md`) shows a per-test selection mechanism — the DAP server runs
 * the whole pipeline over the given source paths and lets breakpoints do
 * the narrowing. Sending `testFilter` is harmless (an unrecognised launch
 * property is ignored) and documents intent; a debug session is fully
 * useful without it because breakpoints filter execution regardless.
 */
export function buildDebugConfiguration(opts: {
  bundleDir: string;
  sourcePaths?: string[];
  testName?: string;
}): vscode.DebugConfiguration {
  const name = opts.testName
    ? `ALchemist: Debug ${opts.testName}`
    : 'ALchemist: Debug AL Tests';
  return {
    type: ALCHEMIST_DEBUG_TYPE,
    request: 'launch',
    name,
    bundleDir: opts.bundleDir,
    ...(opts.sourcePaths && opts.sourcePaths.length > 0 ? { sourcePaths: opts.sourcePaths } : {}),
    ...(opts.testName ? { testFilter: opts.testName } : {}),
  };
}

/**
 * Whether to show the one-per-session stepping caveat.
 *
 * AL.Runner's DAP adapter implements breakpoints, pause, stack, and
 * variables, but `next`/`stepIn`/`stepOut` currently behave like `continue`
 * (see `docs/dap.md`'s Known Limitations in the AL.Runner repo). Saying so
 * once beats letting a user conclude the debugger is broken.
 */
export function shouldWarnAboutStepping(alreadyWarned: boolean): boolean {
  return !alreadyWarned;
}

export const STEPPING_CAVEAT =
  'ALchemist debug: stepping (step over/in/out) currently acts as continue. Breakpoints, pause, call stack, and variables are fully functional.';
