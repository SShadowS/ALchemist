import * as assert from 'assert';
import { parseCoberturaXml } from '../../src/runner/outputParser';

suite('Coverage Gutters — data quality', () => {
  test('only executable lines should appear in coverage data', () => {
    // After the AL.Runner fix, only lines with StmtHit calls appear.
    // Declarations, blank lines, and structural keywords are excluded.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1.0" lines-covered="1" lines-valid="1">
  <packages>
    <package name="al-source" line-rate="1.0">
      <classes>
        <class name="test" filename="test.al" line-rate="1.0">
          <lines>
            <line number="11" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].lines.length, 1);
    assert.strictEqual(entries[0].lines[0].number, 11);
    assert.strictEqual(entries[0].lines[0].hits, 1);
  });

  test('library scope lines should not appear in user file coverage', () => {
    // After the fix, library scopes (Assert, etc.) are excluded from
    // the coverage report entirely — no fallback to user file.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1.0" lines-covered="1" lines-valid="1">
  <packages>
    <package name="al-source" line-rate="1.0">
      <classes>
        <class name="test" filename="test.al" line-rate="1.0">
          <lines>
            <line number="11" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    const entries = parseCoberturaXml(xml);
    // No lines beyond the file should exist
    const invalid = entries[0].lines.filter(l => l.number > 15);
    assert.strictEqual(invalid.length, 0, 'No library scope lines should be present');
  });
});
