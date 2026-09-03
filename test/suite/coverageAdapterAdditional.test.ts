import * as assert from 'assert';
import * as vscode from 'vscode';
import { getDetails, toVsCodeCoverage } from '../../src/execution/coverageAdapter';
import { FileCoverage } from '../../src/execution/protocolV2Types';

suite('coverageAdapter — additional edge cases', () => {
  test('getDetails returns undefined for a foreign FileCoverage instance', () => {
    const foreign = new vscode.FileCoverage(
      vscode.Uri.file('/tmp/Foreign.al'),
      new vscode.TestCoverageCount(0, 1),
    );

    assert.strictEqual(getDetails(foreign), undefined);
  });

  test('converts both ends of a multi-line statement range to zero-based positions', () => {
    const input: FileCoverage[] = [{
      file: '/tmp/MultiLine.al',
      lines: [
        { line: 10, hits: 1 },
        { line: 12, hits: 1 },
      ],
      totalStatements: 1,
      hitStatements: 1,
      statements: [{
        id: 4,
        scope: 'Codeunit 50100.Run',
        line: 10,
        column: 3,
        endLine: 12,
        endColumn: 8,
        hits: 2,
      }],
    }];

    const fileCoverage = toVsCodeCoverage(input)[0];
    const details = getDetails(fileCoverage)!;
    const range = details[0].location as vscode.Range;

    assert.strictEqual(range.start.line, 9);
    assert.strictEqual(range.start.character, 2);
    assert.strictEqual(range.end.line, 11);
    assert.strictEqual(range.end.character, 7);
    assert.strictEqual(details[0].executed, 2);
  });

  test('associates each detail array with its corresponding FileCoverage', () => {
    const input: FileCoverage[] = [
      {
        file: '/tmp/First.al',
        lines: [{ line: 1, hits: 1 }],
        totalStatements: 1,
        hitStatements: 1,
        statements: [{
          id: 0,
          scope: 'First',
          line: 1,
          column: 1,
          hits: 3,
        }],
      },
      {
        file: '/tmp/Second.al',
        lines: [{ line: 20, hits: 0 }],
        totalStatements: 1,
        hitStatements: 0,
        statements: [{
          id: 1,
          scope: 'Second',
          line: 20,
          column: 5,
          hits: 0,
        }],
      },
    ];

    const output = toVsCodeCoverage(input);
    const firstDetails = getDetails(output[0])!;
    const secondDetails = getDetails(output[1])!;

    assert.strictEqual(firstDetails.length, 1);
    assert.strictEqual(firstDetails[0].executed, 3);
    assert.strictEqual(
      (firstDetails[0].location as vscode.Range).start.line,
      0,
    );

    assert.strictEqual(secondDetails.length, 1);
    assert.strictEqual(secondDetails[0].executed, 0);
    assert.strictEqual(
      (secondDetails[0].location as vscode.Range).start.line,
      19,
    );
  });
});
