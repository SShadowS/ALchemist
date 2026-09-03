import * as assert from 'assert';
import { extractSymbols } from '../../src/symbols/symbolExtractor';
import { ParseResult } from '../../src/symbols/parseCache';
import { SymbolKind } from '../../src/symbols/types';

interface FakeNodeOptions {
  text?: string;
  row?: number;
  fields?: Record<string, FakeNode | undefined>;
  namedChildren?: FakeNode[];
  children?: FakeNode[];
}

class FakeNode {
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly namedChildren: FakeNode[];
  previousNamedSibling: FakeNode | null = null;

  private readonly fields: Record<string, FakeNode | undefined>;
  private readonly children: FakeNode[];

  constructor(readonly type: string, options: FakeNodeOptions = {}) {
    this.text = options.text ?? '';
    this.startPosition = { row: options.row ?? 0, column: 0 };
    this.fields = options.fields ?? {};
    this.namedChildren = options.namedChildren ?? [];
    this.children = options.children ?? this.namedChildren;
  }

  childForFieldName(name: string): FakeNode | null {
    return this.fields[name] ?? null;
  }

  get childCount(): number {
    return this.children.length;
  }

  child(index: number): FakeNode | null {
    return this.children[index] ?? null;
  }
}

function linkSiblings(children: FakeNode[]): FakeNode[] {
  for (let i = 0; i < children.length; i++) {
    children[i].previousNamedSibling = i > 0 ? children[i - 1] : null;
  }
  return children;
}

function declaration(
  type: string,
  name: string,
  id: string | undefined,
  row: number,
  body: FakeNode[] = [],
): FakeNode {
  return new FakeNode(type, {
    row,
    fields: {
      object_name: new FakeNode('identifier', { text: name }),
      object_id: id === undefined
        ? undefined
        : new FakeNode('integer_literal', { text: id }),
    },
    namedChildren: linkSiblings(body),
  });
}

function extract(...children: FakeNode[]) {
  const root = new FakeNode('source_file', {
    namedChildren: linkSiblings(children),
  });
  const parse = {
    filePath: '/Synthetic.al',
    ast: { rootNode: root },
    hasErrors: false,
    contentHash: 'synthetic',
  } as unknown as ParseResult;

  return extractSymbols(parse);
}

suite('SymbolExtractor — additional declaration kinds', () => {
  test('extracts every supported declaration kind', () => {
    const declarations: Array<[string, SymbolKind]> = [
      ['page_declaration', 'page'],
      ['report_declaration', 'report'],
      ['query_declaration', 'query'],
      ['xmlport_declaration', 'xmlport'],
      ['enum_declaration', 'enum'],
      ['interface_declaration', 'interface'],
      ['tableextension_declaration', 'tableextension'],
      ['pageextension_declaration', 'pageextension'],
      ['enumextension_declaration', 'enumextension'],
    ];

    const file = extract(...declarations.map(([nodeType], index) =>
      declaration(nodeType, `Object${index}`, String(50100 + index), 10 + index),
    ));

    assert.deepStrictEqual(
      file.declared.map(symbol => symbol.kind),
      declarations.map(([, kind]) => kind),
    );
    assert.deepStrictEqual(
      file.declared.map(symbol => symbol.line),
      declarations.map((_, index) => 10 + index),
    );
  });

  test('uses undefined for a missing or non-numeric object id', () => {
    const file = extract(
      declaration('codeunit_declaration', 'NoId', undefined, 1),
      declaration('codeunit_declaration', 'BadId', 'not-a-number', 2),
    );

    assert.strictEqual(file.declared[0].id, undefined);
    assert.strictEqual(file.declared[1].id, undefined);
  });
});

suite('SymbolExtractor — additional references and tests', () => {
  test('extracts quoted record references and known and unknown object references', () => {
    const recordReference = new FakeNode('record_type', {
      row: 4,
      fields: {
        reference: new FakeNode('identifier', { text: '"Sales Header"' }),
      },
    });
    const pageReference = new FakeNode('object_reference_type', {
      row: 5,
      fields: {
        object_type: new FakeNode('page_keyword'),
        reference: new FakeNode('identifier', { text: 'CustomerCard' }),
      },
    });
    const unknownReference = new FakeNode('object_reference_type', {
      row: 6,
      fields: {
        object_type: new FakeNode('unsupported_keyword'),
        reference: new FakeNode('identifier', { text: 'FutureObject' }),
      },
    });

    const file = extract(declaration(
      'codeunit_declaration',
      'Consumer',
      '50100',
      0,
      [recordReference, pageReference, unknownReference],
    ));

    assert.ok(file.references.some(reference =>
      reference.kind === 'table'
      && reference.name === 'Sales Header'
      && reference.line === 4,
    ));
    assert.ok(file.references.some(reference =>
      reference.kind === 'page'
      && reference.name === 'CustomerCard'
      && reference.line === 5,
    ));
    assert.ok(file.references.some(reference =>
      reference.kind === 'unknown'
      && reference.name === 'FutureObject'
      && reference.line === 6,
    ));
  });

  test('recognizes a case-insensitive Test attribute and strips a quoted procedure name', () => {
    const attributeName = new FakeNode('identifier', { text: 'tEsT' });
    const attributeContent = new FakeNode('attribute_content', {
      fields: { name: attributeName },
      children: [attributeName],
      namedChildren: [attributeName],
    });
    const attribute = new FakeNode('attribute_item', {
      children: [attributeContent],
      namedChildren: [attributeContent],
    });
    const procedure = new FakeNode('procedure', {
      row: 9,
      fields: {
        name: new FakeNode('identifier', { text: '"Runs Correctly"' }),
      },
    });

    const file = extract(declaration(
      'codeunit_declaration',
      '"Tests"',
      undefined,
      1,
      [attribute, procedure],
    ));

    assert.strictEqual(file.tests.length, 1);
    assert.deepStrictEqual(file.tests[0], {
      codeunitId: -1,
      codeunitName: 'Tests',
      procName: 'Runs Correctly',
      line: 9,
    });
  });

  test('does not register Test procedures outside codeunits', () => {
    const attributeName = new FakeNode('identifier', { text: 'Test' });
    const attributeContent = new FakeNode('attribute_content', {
      fields: { name: attributeName },
      children: [attributeName],
    });
    const attribute = new FakeNode('attribute_item', {
      children: [attributeContent],
    });
    const procedure = new FakeNode('procedure', {
      row: 3,
      fields: {
        name: new FakeNode('identifier', { text: 'NotATestCodeunitProcedure' }),
      },
    });

    const file = extract(declaration(
      'table_declaration',
      'SomeTable',
      '50100',
      0,
      [attribute, procedure],
    ));

    assert.deepStrictEqual(file.tests, []);
  });
});
