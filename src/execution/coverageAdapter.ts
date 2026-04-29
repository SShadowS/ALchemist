import * as vscode from 'vscode';
import { FileCoverage } from './protocolV2Types';

/**
 * Translate AL.Runner protocol-v2 FileCoverage[] into VS Code's native
 * FileCoverage shape so callers can pass the result directly to
 * `vscode.TestRun.addCoverage()`.
 *
 * AL.Runner emits 1-indexed line numbers; VS Code's Position is 0-indexed.
 * This adapter performs the offset.
 *
 * Hit-count semantics differ from cobertura: AL.Runner sums hits across
 * statements on the same line (a line with 3 statements all hit reports
 * `hits: 3`), whereas cobertura clamps to 1. VS Code's StatementCoverage
 * `executed` accepts an integer hit count, so we pass it through directly.
 *
 * Note: VS Code's public `FileCoverage` class does not declare a
 * `detailedCoverage` field — detailed per-statement data is fetched on
 * demand by `TestRunProfile.loadDetailedCoverage`. We attach the
 * statement details as a runtime property so the consumer (TestController)
 * can return it from that callback without re-deriving the data.
 */
export function toVsCodeCoverage(input: FileCoverage[]): vscode.FileCoverage[] {
  return input.map(fc => {
    const fileCoverage = new vscode.FileCoverage(
      vscode.Uri.file(fc.file),
      new vscode.TestCoverageCount(fc.hitStatements, fc.totalStatements),
    );
    const detailedCoverage: vscode.StatementCoverage[] = fc.lines.map(l =>
      new vscode.StatementCoverage(
        l.hits,
        new vscode.Position(l.line - 1, 0),
      ),
    );
    (fileCoverage as unknown as { detailedCoverage: vscode.StatementCoverage[] })
      .detailedCoverage = detailedCoverage;
    return fileCoverage;
  });
}
