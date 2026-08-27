import * as path from 'path';
import { FileCoverage, StatementRecord } from './protocolV2Types';

/**
 * Per-statement index for one source file.
 *
 * Built from AL.Runner 2.7.0's `coverage[].statements[]`. This is the single
 * place that answers "where is statement N of scope S" and "what ran on this
 * line" — before 2.7.0 those questions were answered by using a statementId
 * as an index into covered lines sorted by line number, which broke on
 * multi-statement lines and skipped statements.
 */
export class FileStatementIndex {
  private readonly byScope = new Map<string, Map<number, StatementRecord>>();
  private readonly byLine = new Map<number, StatementRecord[]>();

  constructor(public readonly statements: readonly StatementRecord[]) {
    for (const s of statements) {
      // AL identifiers are case-insensitive; the runner emits declaration
      // case while captures may carry a different case for the same scope.
      const scopeKey = s.scope.toLowerCase();
      let scoped = this.byScope.get(scopeKey);
      if (!scoped) { scoped = new Map(); this.byScope.set(scopeKey, scoped); }
      scoped.set(s.id, s);

      const online = this.byLine.get(s.line);
      if (online) { online.push(s); } else { this.byLine.set(s.line, [s]); }
    }
    for (const list of this.byLine.values()) {
      list.sort((a, b) => a.column - b.column);
    }
  }

  /** Exact position of statement `id` in `scope`, or undefined when unknown. */
  lookup(scope: string, id: number): StatementRecord | undefined {
    return this.byScope.get(scope.toLowerCase())?.get(id);
  }

  /** Statements starting on a 1-based line, ordered by column. */
  statementsOnLine(line: number): StatementRecord[] {
    return this.byLine.get(line) ?? [];
  }

  /**
   * Line-level hit counts, taking the MAX across statements on a line.
   * Max, not sum: a line with three statements each hit once ran once, and
   * summing would report it as three executions.
   */
  lineRollup(): Map<number, number> {
    const rollup = new Map<number, number>();
    for (const [line, list] of this.byLine) {
      rollup.set(line, Math.max(...list.map(s => s.hits)));
    }
    return rollup;
  }
}

/**
 * Statement indexes for every file in one run's coverage, keyed by a
 * normalized absolute path.
 *
 * Coverage entry filenames arrive in three shapes depending on producer:
 * workspace-relative with forward slashes, absolute with forward slashes,
 * and absolute with native slashes. `normalizeKey` collapses all three, so
 * consumers can look a file up by `editor.document.uri.fsPath` directly.
 */
export class CoverageModel {
  private constructor(
    private readonly byFile: Map<string, FileStatementIndex>,
    public readonly hasStatements: boolean,
  ) {}

  static fromFileCoverage(coverage: FileCoverage[], workspacePath: string): CoverageModel {
    const byFile = new Map<string, FileStatementIndex>();
    let hasStatements = false;
    for (const entry of coverage) {
      if (!entry.statements || entry.statements.length === 0) continue;
      hasStatements = true;
      byFile.set(
        CoverageModel.normalizeKey(entry.file, workspacePath),
        new FileStatementIndex(entry.statements),
      );
    }
    return new CoverageModel(byFile, hasStatements);
  }

  forFile(fsPath: string): FileStatementIndex | undefined {
    return this.byFile.get(CoverageModel.normalizeKey(fsPath, ''));
  }

  /**
   * `path.resolve` returns an absolute input unchanged and resolves a
   * relative one against the workspace, so one call covers all three
   * producer shapes. Lowercased for Windows-friendly comparison.
   */
  private static normalizeKey(file: string, workspacePath: string): string {
    const absolute = workspacePath ? path.resolve(workspacePath, file) : path.resolve(file);
    return path.normalize(absolute).toLowerCase();
  }
}
