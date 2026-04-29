import { TestRouter, TestRoutingResult } from './testRouter';
import { SymbolIndex } from '../symbols/symbolIndex';
import { AlApp } from '../workspace/types';

export class TreeSitterTestRouter implements TestRouter {
  constructor(private readonly index: SymbolIndex) {}

  isAvailable(): boolean {
    return this.index.isReady();
  }

  getTestsAffectedBy(filePath: string, _app: AlApp): TestRoutingResult {
    if (!this.index.isReady()) {
      return { confident: false, reason: 'symbol index not ready' };
    }
    if (!this.index.isSettled()) {
      return { confident: false, reason: 'index awaiting reparse — please wait' };
    }
    const tests = this.index.getTestsAffectedBy(filePath);
    if (tests === null) {
      return { confident: false, reason: `file ${shortBasename(filePath)} has parse errors` };
    }
    return { confident: true, tests };
  }

  dispose(): void {}
}

function shortBasename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}
