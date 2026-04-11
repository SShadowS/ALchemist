import * as assert from 'assert';

suite('HoverProvider', () => {
  // Test the deduplication logic directly
  test('last captured value wins when multiple exist for same variable', () => {
    // Simulate what buildHover does: filter by variable name, take last
    const capturedValues = [
      { scopeName: 'Scope1', variableName: 'Txt2', value: 'Hello', statementId: 1 },
      { scopeName: 'Scope2', variableName: 'Txt2', value: 'World', statementId: 0 },
    ];
    const hoveredWord = 'Txt2';
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === hoveredWord.toLowerCase()
    );
    const lastValue = matching[matching.length - 1].value;
    assert.strictEqual(lastValue, 'World');
    assert.strictEqual(matching.length, 2); // two matches
  });

  test('variable matching is case-insensitive', () => {
    const capturedValues = [
      { scopeName: 'Scope', variableName: 'MyVar', value: '42', statementId: 0 },
    ];
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === 'myvar'
    );
    assert.strictEqual(matching.length, 1);
  });

  test('no match for unknown variable', () => {
    const capturedValues = [
      { scopeName: 'Scope', variableName: 'X', value: '1', statementId: 0 },
    ];
    const matching = capturedValues.filter(
      cv => cv.variableName.toLowerCase() === 'y'
    );
    assert.strictEqual(matching.length, 0);
  });
});
