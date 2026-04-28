import { TestProcedure } from '../symbols/types';
import { AlApp } from '../workspace/types';

export type TestRoutingResult =
  | { confident: true; tests: TestProcedure[] }
  | { confident: false; reason: string };

export interface TestRouter {
  getTestsAffectedBy(filePath: string, app: AlApp): TestRoutingResult;
  isAvailable(): boolean;
  dispose(): void;
}
