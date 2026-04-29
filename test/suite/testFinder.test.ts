import * as vscode from 'vscode';
import * as assert from 'assert';
import { findTestItemAtPosition } from '../../src/testing/testFinder';

function makeItem(id: string, label: string, uri: vscode.Uri, range: vscode.Range): vscode.TestItem {
  return { id, label, uri, range, children: { add: () => {}, replace: () => {}, get: () => undefined, forEach: () => {}, size: 0 } } as any;
}

suite('findTestItemAtPosition', () => {
  test('returns the TestItem whose range covers the position', () => {
    const uri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(12, 4));
    assert.strictEqual(result?.label, 'Foo');
  });

  test('returns undefined when no test item matches', () => {
    const uri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(20, 0));
    assert.strictEqual(result, undefined);
  });

  test('returns undefined when document URI does not match', () => {
    const itemUri = vscode.Uri.file('/fake/CalcTest.Codeunit.al');
    const otherUri = vscode.Uri.file('/fake/Other.Codeunit.al');
    const item = makeItem('test-1-1-Foo', 'Foo', itemUri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(item.id, item);
    const result = findTestItemAtPosition(items, otherUri, new vscode.Position(12, 0));
    assert.strictEqual(result, undefined);
  });

  test('multiple matches → returns the smallest enclosing range', () => {
    const uri = vscode.Uri.file('/fake/FooTest.al');
    const codeunit = makeItem('codeunit-1-1', 'FooTest', uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(50, 0)));
    const fooProc = makeItem('test-1-1-Foo', 'Foo', uri,
      new vscode.Range(new vscode.Position(10, 0), new vscode.Position(15, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(codeunit.id, codeunit);
    items.set(fooProc.id, fooProc);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(12, 0));
    assert.strictEqual(result?.label, 'Foo');
  });

  test('only test-prefixed ids considered (codeunit/app items skipped)', () => {
    const uri = vscode.Uri.file('/fake/FooTest.al');
    const codeunit = makeItem('codeunit-1-1', 'FooTest', uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(50, 0)));
    const items = new Map<string, vscode.TestItem>();
    items.set(codeunit.id, codeunit);
    const result = findTestItemAtPosition(items, uri, new vscode.Position(5, 0));
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for empty map', () => {
    const items = new Map<string, vscode.TestItem>();
    const uri = vscode.Uri.file('/fake/x.al');
    const result = findTestItemAtPosition(items, uri, new vscode.Position(0, 0));
    assert.strictEqual(result, undefined);
  });
});
