export type SymbolKind =
  | 'table' | 'codeunit' | 'page' | 'enum'
  | 'report' | 'interface' | 'query' | 'xmlport'
  | 'tableextension' | 'pageextension' | 'enumextension';

export interface DeclaredSymbol {
  kind: SymbolKind;
  id: number | undefined;
  name: string;
  fqName: string;
  line: number;
}

export interface ReferencedSymbol {
  kind: SymbolKind | 'unknown';
  name: string;
  line: number;
}

export interface TestProcedure {
  codeunitId: number;
  codeunitName: string;
  procName: string;
  line: number;
}

export interface FileSymbols {
  filePath: string;
  namespace: string | undefined;
  usings: string[];
  declared: DeclaredSymbol[];
  references: ReferencedSymbol[];
  tests: TestProcedure[];
}
