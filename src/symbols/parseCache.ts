import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { Parser, Language, Edit, type Tree } from 'web-tree-sitter';

export interface ParseEdit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
}

export interface ParseResult {
  filePath: string;
  ast: Tree;
  hasErrors: boolean;
  contentHash: string;
}

export class ParseCache {
  private parser: Parser | undefined;
  private alLanguage: Language | undefined;
  private current = new Map<string, ParseResult>();
  private lastGoodMap = new Map<string, ParseResult>();
  private disposed = false;
  private timeoutMs = 500;

  constructor(private wasmDir: string) {}

  async initialize(): Promise<void> {
    try {
      await Parser.init({
        locateFile: (file: string) => {
          // web-tree-sitter requests 'web-tree-sitter.wasm'; we copy it as 'tree-sitter.wasm'
          const mapped = file === 'web-tree-sitter.wasm' ? 'tree-sitter.wasm' : file;
          return path.join(this.wasmDir, mapped);
        },
      });
      const wasmPath = path.join(this.wasmDir, 'tree-sitter-al.wasm');
      if (!fs.existsSync(wasmPath)) {
        return;
      }
      this.alLanguage = await Language.load(wasmPath);
      this.parser = new Parser();
      this.parser.setLanguage(this.alLanguage);
    } catch {
      this.parser = undefined;
      this.alLanguage = undefined;
    }
  }

  isAvailable(): boolean {
    return !this.disposed && this.parser !== undefined && this.alLanguage !== undefined;
  }

  setParseTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  parse(filePath: string, content: string): ParseResult | undefined {
    this.assertNotDisposed();
    if (!this.parser) { return undefined; }
    return this.doParse(filePath, content, undefined);
  }

  parseIncremental(filePath: string, content: string, edit: ParseEdit): ParseResult | undefined {
    this.assertNotDisposed();
    if (!this.parser) { return undefined; }
    const previous = this.current.get(filePath)?.ast;
    if (!previous) {
      return this.doParse(filePath, content, undefined);
    }
    previous.edit(new Edit({
      startIndex: edit.startIndex,
      oldEndIndex: edit.oldEndIndex,
      newEndIndex: edit.newEndIndex,
      startPosition: edit.startPosition,
      oldEndPosition: edit.oldEndPosition,
      newEndPosition: edit.newEndPosition,
    }));
    return this.doParse(filePath, content, previous);
  }

  private doParse(
    filePath: string,
    content: string,
    oldTree: Tree | undefined
  ): ParseResult | undefined {
    const parser = this.parser!;
    const deadline = Date.now() + this.timeoutMs;

    let tree: Tree | null;
    try {
      tree = parser.parse(content, oldTree ?? null, {
        // The .d.ts types progressCallback as returning void, but the runtime
        // treats a truthy return as a cancellation signal (matches ProgressCallback type).
        progressCallback: ((state: { currentOffset: number; hasError: boolean }) => {
          void state;
          return Date.now() > deadline;
        }) as unknown as (state: { currentOffset: number; hasError: boolean }) => void,
      });
    } catch {
      return undefined;
    }

    if (!tree) { return undefined; }

    const hasErrors = tree.rootNode.hasError;
    const result: ParseResult = {
      filePath,
      ast: tree,
      hasErrors,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    };
    this.current.set(filePath, result);
    if (!hasErrors) {
      this.lastGoodMap.set(filePath, result);
    }
    return result;
  }

  invalidate(filePath: string): void {
    this.current.delete(filePath);
    this.lastGoodMap.delete(filePath);
  }

  getLastGood(filePath: string): ParseResult | undefined {
    return this.lastGoodMap.get(filePath);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.current.clear();
    this.lastGoodMap.clear();
    this.parser?.delete();
    this.parser = undefined;
    this.alLanguage = undefined;
  }

  private assertNotDisposed(): void {
    if (this.disposed) { throw new Error('ParseCache used after dispose'); }
  }
}
