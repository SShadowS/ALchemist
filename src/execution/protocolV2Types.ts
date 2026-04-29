/**
 * TypeScript types for AL.Runner protocol v2 (NDJSON streaming).
 *
 * Source of truth: `protocol-v2.schema.json` in the AL.Runner repo
 * (https://github.com/StefanMaron/BusinessCentral.AL.Runner — fork branch
 * `feat/alchemist-protocol-v1`).
 *
 * The wire shape is newline-delimited JSON. A `runtests` request emits
 * zero or more `TestEvent` lines, optional `Progress` lines, then exactly
 * one `Summary` line. `cancel` (and other commands) return a single
 * `Ack` line.
 */

export type FramePresentationHint = 'normal' | 'subtle' | 'deemphasize' | 'label';

export type AlErrorKind =
  | 'assertion'
  | 'runtime'
  | 'compile'
  | 'setup'
  | 'timeout'
  | 'unknown';

export type TestStatus = 'pass' | 'fail' | 'error';

export interface AlStackFrame {
  name: string;
  source?: { path?: string; name?: string };
  line?: number;        // 1-based
  column?: number;      // 1-based
  presentationHint?: FramePresentationHint;
}

export interface CapturedValue {
  scopeName: string;
  /** Optional in protocol; emitter currently always populates. */
  objectName?: string;
  variableName: string;
  value: unknown;       // schema permits any JSON
  statementId: number;
}

export interface TestEvent {
  type: 'test';
  name: string;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  errorKind?: AlErrorKind;
  alSourceFile?: string;
  alSourceLine?: number;     // 1-based
  alSourceColumn?: number;   // 1-based
  stackFrames?: AlStackFrame[];
  stackTrace?: string;       // raw .NET StackTrace text — fallback only
  messages?: string[];
  capturedValues?: CapturedValue[];
}

export interface FileCoverageLine {
  line: number;   // 1-based
  hits: number;   // SUMMED across statements on the same line, not max-1
}

export interface FileCoverage {
  file: string;                // relative path, forward-slash
  lines: FileCoverageLine[];
  totalStatements: number;
  hitStatements: number;
}

export interface Summary {
  type: 'summary';
  exitCode: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  cached?: boolean;
  cancelled?: boolean;
  changedFiles?: string[];
  compilationErrors?: { file: string; errors: string[] }[];
  coverage?: FileCoverage[];
  protocolVersion: 2;          // const per schema
  /** Tolerated forward-compat fields. */
  [extra: string]: unknown;
}

export interface Ack {
  type: 'ack';
  command: string;
  noop?: boolean;
}

export interface Progress {
  type: 'progress';
  completed?: number;
  total?: number;
}

export type ProtocolLine = TestEvent | Summary | Ack | Progress;

/**
 * Type guard: is this parsed JSON object a v2 protocol line?
 *
 * v1 servers emit a single line that is NOT shaped as one of the above
 * (no `type` discriminator). Returning `false` here is the v1 fallback
 * trigger.
 */
export function isProtocolV2Line(value: unknown): value is ProtocolLine {
  if (typeof value !== 'object' || value === null) { return false; }
  const t = (value as { type?: unknown }).type;
  return t === 'test' || t === 'summary' || t === 'ack' || t === 'progress';
}
