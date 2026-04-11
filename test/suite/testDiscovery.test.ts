import * as assert from 'assert';
import { discoverTestsFromContent } from '../../src/testing/testDiscovery';

suite('TestDiscovery', () => {
  test('discovers test procedures in a test codeunit', () => {
    const content = `
codeunit 50200 "Test Sales Calculation"
{
    Subtype = Test;

    [Test]
    procedure TestBasicDiscount()
    begin
        // test code
    end;

    [Test]
    procedure TestVolumeDiscount()
    begin
        // test code
    end;

    procedure HelperProc()
    begin
        // not a test
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestSales.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'Test Sales Calculation');
    assert.strictEqual(result[0].codeunitId, 50200);
    assert.strictEqual(result[0].tests.length, 2);
    assert.strictEqual(result[0].tests[0].name, 'TestBasicDiscount');
    assert.strictEqual(result[0].tests[1].name, 'TestVolumeDiscount');
  });

  test('ignores non-test codeunits', () => {
    const content = `
codeunit 50100 "Sales Calculation"
{
    procedure CalcDiscount()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Sales.al');
    assert.strictEqual(result.length, 0);
  });

  test('discovers tests by [Test] attribute even without Subtype', () => {
    const content = `
codeunit 50201 "More Tests"
{
    [Test]
    procedure TestSomething()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'MoreTests.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests.length, 1);
  });

  test('returns line numbers for test procedures', () => {
    const content = `codeunit 50200 "Test X"
{
    [Test]
    procedure TestA()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestX.al');
    assert.strictEqual(result[0].tests[0].line, 2); // 0-indexed line of [Test]
  });

  test('discovers multiple codeunits in same file', () => {
    const content = `
codeunit 50200 "Test A"
{
    [Test]
    procedure TestOne()
    begin
    end;
}

codeunit 50201 "Test B"
{
    [Test]
    procedure TestTwo()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Multi.al');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].codeunitName, 'Test A');
    assert.strictEqual(result[1].codeunitName, 'Test B');
  });

  test('handles [Test] with blank lines before procedure', () => {
    const content = `
codeunit 50200 "Test X"
{
    [Test]

    procedure TestWithGap()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Gap.al');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'TestWithGap');
  });

  test('handles local procedure with [Test]', () => {
    const content = `
codeunit 50200 "Test X"
{
    [Test]
    local procedure TestLocal()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Local.al');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'TestLocal');
  });

  test('ignores [Test] with no procedure found within lookahead', () => {
    const content = `
codeunit 50200 "Test X"
{
    [Test]
    // comment
    // comment
    // comment
    // comment
    procedure TooFar()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Far.al');
    // Lookahead is 3 lines, procedure is 4 lines away — no tests found,
    // so codeunit is not included in results at all
    assert.strictEqual(result.length, 0);
  });

  test('handles empty file', () => {
    const result = discoverTestsFromContent('', 'Empty.al');
    assert.strictEqual(result.length, 0);
  });
});
