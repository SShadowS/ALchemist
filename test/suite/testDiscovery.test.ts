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

suite('TestDiscovery — unquoted names, namespaces, multiline attrs', () => {
  test('discovers tests in codeunit with unquoted name', () => {
    const content = `
codeunit 71180500 AlertEngineTestSESTM
{
    Subtype = Test;

    [Test]
    procedure NewInsertsAlertWithDefaultSeverity()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'AlertEngineTest.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitId, 71180500);
    assert.strictEqual(result[0].codeunitName, 'AlertEngineTestSESTM');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'NewInsertsAlertWithDefaultSeverity');
  });

  test('discovers tests in namespaced file with unquoted codeunit', () => {
    const content = `namespace STM.BusinessCentral.Sentinel.Test;

using STM.BusinessCentral.Sentinel;

codeunit 71180500 AlertEngineTestSESTM
{
    Subtype = Test;
    Access = Internal;

    [Test]
    procedure NewInsertsAlertWithDefaultSeverity()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'AlertEngineTest.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitId, 71180500);
    assert.strictEqual(result[0].codeunitName, 'AlertEngineTestSESTM');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'NewInsertsAlertWithDefaultSeverity');
  });

  test('still discovers tests in codeunit with quoted name (regression)', () => {
    const content = `
codeunit 50200 "Test Sales Calculation"
{
    Subtype = Test;

    [Test]
    procedure TestBasicDiscount()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'TestSales.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'Test Sales Calculation');
  });

  test('handles mixed codeunits (one quoted, one unquoted) in same file', () => {
    const content = `
codeunit 50100 "Old Style Test"
{
    [Test]
    procedure A() begin end;
}

codeunit 50101 NewStyleTest
{
    [Test]
    procedure B() begin end;
}`;
    const result = discoverTestsFromContent(content, 'Mixed.al');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].codeunitName, 'Old Style Test');
    assert.strictEqual(result[1].codeunitName, 'NewStyleTest');
  });

  test('rejects malformed codeunit header (missing id)', () => {
    const content = `
codeunit SomeCodeunit
{
    [Test]
    procedure X() begin end;
}`;
    const result = discoverTestsFromContent(content, 'Bad.al');
    assert.strictEqual(result.length, 0);
  });

  test('does not exclude AL keywords from bare-identifier slot (documents current behavior)', () => {
    // The regex is intentionally permissive — AL.Runner is the authority on
    // whether the source compiles. Verify our extractor returns whatever the
    // file says, even when the name is a reserved word.
    const content = `
codeunit 50100 procedure
{
    [Test]
    procedure X() begin end;
}`;
    const result = discoverTestsFromContent(content, 'Weird.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'procedure');
  });

  test('discovers test with multi-attribute decoration on same line', () => {
    const content = `
codeunit 50200 MultiAttrTest
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('MessageHandler')]
    procedure WithHandler()
    begin
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'MultiAttr.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests.length, 1, 'one [Test] procedure (the [MessageHandler]-decorated one is not a test)');
    assert.strictEqual(result[0].tests[0].name, 'WithHandler');
  });

  test('discovers test with combined attributes [Test, HandlerFunctions(...)] on one line', () => {
    const content = `
codeunit 50201 CombinedAttrTest
{
    Subtype = Test;

    [Test, HandlerFunctions('H')]
    procedure CombinedAttr()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'CombinedAttr.al');
    // Behavior: TEST_ATTR_REGEX is /^\s*\[Test\]\s*$/i — strict equality, requiring
    // [Test] alone on the line. Combined-attribute syntax [Test, HandlerFunctions(...)]
    // does NOT match. This is a known limitation; Plan B's tree-sitter discovery fixes it.
    assert.strictEqual(result.length, 0, 'documented gap: comma-separated [Test, HandlerFunctions(...)] not detected; stacked [Test] then [HandlerFunctions(...)] on next line works (Plan B fixes via tree-sitter)');
  });

  test('discovers test in codeunit with underscore-prefixed bare name', () => {
    // Valid AL: identifiers may start with underscore. Edge case the regex
    // accepts ([A-Za-z_]\w*); document via a test.
    const content = `
codeunit 50300 _LegacyName
{
    Subtype = Test;

    [Test]
    procedure RunsCleanly()
    begin
    end;
}`;
    const result = discoverTestsFromContent(content, 'Legacy.al');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, '_LegacyName');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'RunsCleanly');
  });
});
