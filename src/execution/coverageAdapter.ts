import * as vscode from 'vscode';
import { FileCoverage } from './protocolV2Types';

/**
 * Per-FileCoverage statement-detail registry.
 *
 * VS Code's public `FileCoverage` class does not expose a place to attach
 * detailed per-statement data; the framework instead requests it lazily via
 * `TestRunProfile.loadDetailedCoverage(testRun, fileCoverage, token)`. We
 * therefore stash the details out-of-band, keyed by the FileCoverage
 * instance, and expose `getDetails(fc)` so the consumer (TestController)
 * can retrieve them inside that callback without re-deriving them.
 *
 * A WeakMap is used so the entry is collected together with its
 * FileCoverage; nothing in the adapter holds either alive past its useful
 * lifetime. This replaces the previous approach of attaching a
 * `detailedCoverage` runtime property via an unsafe cast.
 */
const detailsByFc = new WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]>();

/**
 * Translate AL.Runner protocol-v2 `FileCoverage[]` into VS Code's native
 * `FileCoverage[]` shape so callers can pass the result directly to
 * `vscode.TestRun.addCoverage()`.
 *
 * AL.Runner emits 1-indexed line numbers; VS Code's `Position` is
 * 0-indexed. This adapter performs the offset.
 *
 * Hit-count semantics: AL.Runner sums hits across statements on the same
 * line (a line with three statements all hit reports `hits: 3`), unlike
 * cobertura which clamps to 1. VS Code's `StatementCoverage.executed`
 * accepts an integer hit count; we pass it through directly (no max-1
 * clamping). `0` means uncovered, any positive value means covered.
 *
 * Implementation notes:
 *
 * - We use the explicit `FileCoverage(uri, statementCoverage)` constructor
 *   rather than the `FileCoverage.fromDetails(uri, details)` static
 *   factory. The factory derives totals from the detail array, but the
 *   runner reports `totalStatements`/`hitStatements` independently of
 *   `lines[]` — `lines[]` covers only line-level rollups, while the
 *   totals can include statements the runner did not surface as line
 *   entries (real fixtures show e.g. 10 totalStatements over 7 line
 *   entries). Threading the runner totals through preserves fidelity.
 * - `branchCoverage` and `declarationCoverage` are deliberately left
 *   `undefined`: AL.Runner does not currently emit branch or declaration
 *   data.
 * - Per-statement details are stored in a module-private `WeakMap`
 *   (`detailsByFc`) and retrieved via `getDetails(fc)`. This avoids the
 *   previous runtime-property cast and keeps the adapter API typed.
 */
export function toVsCodeCoverage(input: FileCoverage[]): vscode.FileCoverage[] {
  return input.map(fc => {
    const fileCoverage = new vscode.FileCoverage(
      vscode.Uri.file(fc.file),
      new vscode.TestCoverageCount(fc.hitStatements, fc.totalStatements),
    );
    const details = fc.lines.map(l =>
      new vscode.StatementCoverage(
        l.hits,
        new vscode.Position(l.line - 1, 0),
      ),
    );
    detailsByFc.set(fileCoverage, details);
    return fileCoverage;
  });
}

/**
 * Retrieve the per-statement detail array for a `FileCoverage` produced by
 * {@link toVsCodeCoverage}.
 *
 * Returns `undefined` if the supplied `FileCoverage` did not originate
 * from this adapter (e.g. it was constructed elsewhere). The
 * `TestController.loadDetailedCoverage` callback uses this to return
 * details VS Code asks for on demand.
 */
export function getDetails(fc: vscode.FileCoverage): vscode.StatementCoverage[] | undefined {
  return detailsByFc.get(fc);
}
