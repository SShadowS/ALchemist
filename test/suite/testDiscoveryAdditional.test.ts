import * as assert from 'assert';
import { discoverTestsFromContent } from '../../src/testing/testDiscovery';

suite('TestDiscovery — additional content cases', () => {
  test('handles case-insensitive attributes and procedures in CRLF content', () => {
    const content = [
      'codeunit 50100 CrLfTests',
      '{',
      '    [tEsT]',
      '    LOCAL PROCEDURE RunsOnWindows()',
      '    begin',
      '    end;',
      '}',
    ].join('\r\n');

    const result = discoverTestsFromContent(content, 'CrLfTests.al');

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'CrLfTests');
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'RunsOnWindows');
    assert.strictEqual(result[0].tests[0].line, 2);
  });

  test('finds a procedure at the inclusive three-line lookahead boundary', () => {
    const content = `
codeunit 50100 BoundaryTests
{
    [Test]
    // first intervening line

    procedure AtBoundary()
    begin
    end;
}`;

    const result = discoverTestsFromContent(content, 'BoundaryTests.al');

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests.length, 1);
    assert.strictEqual(result[0].tests[0].name, 'AtBoundary');
  });

  test('does not carry a Test attribute from before the first codeunit', () => {
    const content = `
[Test]
procedure GhostTest()
begin
end;

codeunit 50100 RealCodeunit
{
    procedure Helper()
    begin
    end;
}`;

    const result = discoverTestsFromContent(content, 'NoLeak.al');
    assert.deepStrictEqual(result, []);
  });

  test('preserves the supplied filename for each discovered codeunit', () => {
    const content = `
codeunit 50100 FirstTests
{
    [Test]
    procedure First()
    begin
    end;
}

codeunit 50101 SecondTests
{
    [Test]
    procedure Second()
    begin
    end;
}`;

    const result = discoverTestsFromContent(content, 'src/Nested/Tests.al');

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].fileName, 'src/Nested/Tests.al');
    assert.strictEqual(result[1].fileName, 'src/Nested/Tests.al');
  });

  test('accepts underscore and digit characters after the first procedure character', () => {
    const content = `
codeunit 50100 IdentifierTests
{
    [Test]
    procedure _Test_123()
    begin
    end;
}`;

    const result = discoverTestsFromContent(content, 'Identifiers.al');

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tests[0].name, '_Test_123');
  });

  test('emits only codeunits that contain discovered tests', () => {
    const content = `
codeunit 50100 HasTests
{
    [Test]
    procedure Runs()
    begin
    end;
}

codeunit 50101 HelpersOnly
{
    procedure Helper()
    begin
    end;
}`;

    const result = discoverTestsFromContent(content, 'Mixed.al');

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].codeunitName, 'HasTests');
  });
});
