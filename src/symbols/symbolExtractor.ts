import { Node as SyntaxNode } from 'web-tree-sitter';
import { FileSymbols, DeclaredSymbol, ReferencedSymbol, SymbolKind } from './types';
import { ParseResult } from './parseCache';

const KIND_BY_DECL_NODE: Record<string, SymbolKind> = {
  table_declaration: 'table',
  page_declaration: 'page',
  codeunit_declaration: 'codeunit',
  report_declaration: 'report',
  query_declaration: 'query',
  xmlport_declaration: 'xmlport',
  enum_declaration: 'enum',
  interface_declaration: 'interface',
  tableextension_declaration: 'tableextension',
  pageextension_declaration: 'pageextension',
  enumextension_declaration: 'enumextension',
};

// Map from object_type keyword node type to SymbolKind
const KIND_BY_OBJECT_TYPE_NODE: Record<string, SymbolKind> = {
  codeunit_keyword: 'codeunit',
  page_keyword: 'page',
  enum_keyword: 'enum',
  report_keyword: 'report',
  interface_keyword: 'interface',
  xmlport_keyword: 'xmlport',
  query_keyword: 'query',
};

export function extractSymbols(parse: ParseResult): FileSymbols {
  const root = parse.ast.rootNode;
  const file: FileSymbols = {
    filePath: parse.filePath,
    namespace: undefined,
    usings: [],
    declared: [],
    references: [],
    tests: [],
  };

  for (const child of root.namedChildren) {
    if (child.type === 'namespace_declaration') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) { file.namespace = nameNode.text; }
    } else if (child.type === 'using_statement') {
      // grammar field is 'namespace', not 'name'
      const nameNode = child.childForFieldName('namespace') ?? child.namedChildren[0];
      if (nameNode) { file.usings.push(nameNode.text); }
    } else {
      collectFromNode(child, file);
    }
  }

  return file;
}

function collectFromNode(node: SyntaxNode, file: FileSymbols): void {
  const declKind = KIND_BY_DECL_NODE[node.type];
  if (declKind) {
    const symbol = extractDeclaration(node, declKind, file.namespace);
    if (symbol) {
      file.declared.push(symbol);
      walkBody(
        node,
        file,
        symbol.kind === 'codeunit'
          ? { codeunitId: symbol.id, codeunitName: symbol.name }
          : undefined,
      );
    }
    return;
  }
  for (const child of node.namedChildren) { collectFromNode(child, file); }
}

function extractDeclaration(
  node: SyntaxNode,
  kind: SymbolKind,
  namespace: string | undefined,
): DeclaredSymbol | undefined {
  const nameNode = node.childForFieldName('object_name');
  const idNode = node.childForFieldName('object_id');
  if (!nameNode) { return undefined; }
  const rawName = nameNode.text;
  const name = rawName.startsWith('"') ? rawName.slice(1, -1) : rawName;
  const id = idNode ? Number(idNode.text) : undefined;
  return {
    kind,
    id: typeof id === 'number' && !Number.isNaN(id) ? id : undefined,
    name,
    fqName: namespace ? `${namespace}.${name}` : name,
    line: node.startPosition.row,
  };
}

function walkBody(
  declNode: SyntaxNode,
  file: FileSymbols,
  codeunitContext: { codeunitId: number | undefined; codeunitName: string } | undefined,
): void {
  const stack: SyntaxNode[] = [...declNode.namedChildren];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'procedure' && codeunitContext && hasTestAttribute(node)) {
      const procNameNode = node.childForFieldName('name');
      const procName = procNameNode?.text.replace(/^"|"$/g, '');
      if (procName) {
        file.tests.push({
          codeunitId: codeunitContext.codeunitId ?? -1,
          codeunitName: codeunitContext.codeunitName,
          procName,
          line: node.startPosition.row,
        });
      }
    }
    if (node.type === 'record_type') {
      addReferenceFromTypeNode(node, 'table', file);
    } else if (node.type === 'object_reference_type') {
      const kind = inferRefKindFromNode(node);
      addReferenceFromTypeNode(node, kind, file);
    }
    for (const child of node.namedChildren) { stack.push(child); }
  }
}

/**
 * Check whether `attribute_item` contains a "Test" attribute name.
 *
 * Three cases exist in the AL grammar:
 *   1. [Test]                 → attribute_content.name = "Test"
 *   2. [Test, HandlerFunctions(...)] → ERROR node contains identifier "Test"
 *                                       as first child (grammar parse error for
 *                                       combined attributes)
 *   3. (checked from procedure's prev-siblings, handles stacked attrs)
 */
function isTestAttributeItem(attrItem: SyntaxNode): boolean {
  for (let i = 0; i < attrItem.childCount; i++) {
    const child = attrItem.child(i);
    if (child === null) { continue; }

    if (child.type === 'attribute_content') {
      // Standard single attribute: [Test] or [Test(...)]
      const nameNode = child.childForFieldName('name');
      if (nameNode && /^test$/i.test(nameNode.text)) { return true; }
    } else if (child.type === 'ERROR') {
      // Combined attribute: [Test, HandlerFunctions(...)]
      // The grammar parses "Test," as an ERROR; Test is an identifier child
      for (let j = 0; j < child.childCount; j++) {
        const errChild = child.child(j);
        if (errChild !== null && errChild.type === 'identifier' && /^test$/i.test(errChild.text)) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasTestAttribute(procNode: SyntaxNode): boolean {
  let prev = procNode.previousNamedSibling;
  while (prev && prev.type === 'attribute_item') {
    if (isTestAttributeItem(prev)) { return true; }
    prev = prev.previousNamedSibling;
  }
  return false;
}

function inferRefKindFromNode(node: SyntaxNode): SymbolKind | 'unknown' {
  // object_reference_type has an 'object_type' field which is a keyword node
  const objTypeNode = node.childForFieldName('object_type');
  if (objTypeNode) {
    const kind = KIND_BY_OBJECT_TYPE_NODE[objTypeNode.type];
    if (kind) { return kind; }
  }
  return 'unknown';
}

function addReferenceFromTypeNode(
  node: SyntaxNode,
  kind: SymbolKind | 'unknown',
  file: FileSymbols,
): void {
  const refNode = node.childForFieldName('reference') ?? node.namedChildren[0];
  if (!refNode) { return; }
  const raw = refNode.text;
  const name = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  if (!name) { return; }
  file.references.push({ kind, name, line: node.startPosition.row });
}
