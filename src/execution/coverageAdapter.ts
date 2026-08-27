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
 * AL.Runner emits 1-indexed line/column numbers; VS Code's `Position` is
 * 0-indexed. This adapter performs the offset.
 *
 * Hit-count semantics: details are built from AL.Runner >= 2.7.0's
 * per-statement coverage table (`FileCoverage.statements`), where each
 * statement carries its own count — unlike the older `lines[]` rollup,
 * which sums hits across every statement sharing a line. VS Code's
 * `StatementCoverage.executed` accepts an integer hit count; we pass it
 * through directly (no max-1 clamping). `0` means uncovered, any positive
 * value means covered.
 *
 * Implementation notes:
 *
 * - We use the explicit `FileCoverage(uri, statementCoverage)` constructor
 *   rather than the `FileCoverage.fromDetails(uri, details)` static
 *   factory. The factory derives totals from the detail array, but the
 *   runner reports `totalStatements`/`hitStatements` independently of the
 *   entries it surfaces (real fixtures show more total statements than
 *   surfaced entries). Threading the runner totals through preserves
 *   fidelity.
 * - `branchCoverage` and `declarationCoverage` are deliberately left
 *   `undefined`: AL.Runner does not currently emit branch or declaration
 *   data.
 * - Per-statement details are stored in a module-private `WeakMap`
 *   (`detailsByFc`) and retrieved via `getDetails(fc)`. This avoids the
 *   previous runtime-property cast and keeps the adapter API typed.
 * - `statements` is optional (absent on AL.Runner < 2.7.0). When absent,
 *   `getDetails` returns an empty array — there is no fallback to
 *   `lines[]`-derived details; the file still reports summary coverage via
 *   `totalStatements`/`hitStatements`, but with no per-statement detail.
 */
export function toVsCodeCoverage(input: FileCoverage[]): vscode.FileCoverage[] {
  return input.map(fc => {
    const fileCoverage = new vscode.FileCoverage(
      vscode.Uri.file(fc.file),
      new vscode.TestCoverageCount(fc.hitStatements, fc.totalStatements),
    );
    // Details come from AL.Runner >= 2.7.0's statement table: a real Range per
    // statement with its own count, so several statements on one line render
    // separately instead of collapsing onto column 0 with a summed count.
    // Older runners send no table and get summary-only coverage.
    const details = (fc.statements ?? []).map(s => {
      const startLine = s.line - 1;
      const startCol = s.column - 1;
      const endLine = (s.endLine ?? s.line) - 1;
      const endCol = s.endColumn !== undefined ? s.endColumn - 1 : startCol;
      return new vscode.StatementCoverage(
        s.hits,
        new vscode.Range(
          new vscode.Position(startLine, startCol),
          new vscode.Position(endLine, endCol),
        ),
      );
    });
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
