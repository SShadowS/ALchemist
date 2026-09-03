// Normalizes an `execute` response into the projections every downstream consumer needs,
// bridging two runner wire shapes for #2056 (see
// docs/superpowers/specs/2026-09-03-upstream-iterations-consumer-design.md).
//
//   Upstream (StefanMaron/BusinessCentral.AL.Runner#2475): per-test `loops[]`, and the
//     flat `capturedValues`/`messages` records tagged with `loop`+`iteration`.
//   Fork (today): top-level `iterations[]` with steps that copy values/messages.
//
// Detection is by response shape, not a version string. Runs on the RAW response before
// the engine's per-test mapping discards fields.
import { CapturedValue as CapturedValueV1 } from '../runner/outputParser';
import { CapturedValue, UpstreamLoop, UpstreamMessage } from './protocolV2Types';
import { v2ToV1Captured } from './captureValueAdapter';
import { IterationData } from '../iteration/types';

export type ExecuteShape = 'upstream' | 'fork' | 'none' | 'conflict';

export interface NormalizedExecute {
  shape: ExecuteShape;
  iterations: IterationData[];
  /** Aggregate legacy projection for show-all hover / inline capture rendering. */
  capturedValues: CapturedValueV1[];
  /** Aggregate legacy text projection for OutputChannel / inline messages. */
  messages: string[];
  /** Retained upstream message records so exact placement (statementId) is possible later. */
  structuredMessages: UpstreamMessage[];
  /** Bundle scopes whose loops could not be tracked (upstream); surfaced as a diagnostic. */
  unresolvedScopes: string[];
  /** Set when both shapes appear at once (a transition artifact); upstream is preferred. */
  conflict: boolean;
}

/** Canonical value rendering. Never equates a capture error with a genuine null. */
export function toDisplayValue(cv: Pick<CapturedValue, 'value' | 'captureError'>): string {
  if (cv.captureError != null) return `<capture error: ${cv.captureError}>`;
  const v = cv.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** One upstream loop instance -> the fork-shaped IterationData the store consumes, by
 * filtering the flat series on this loop's id and each iteration's index. */
export function adaptUpstreamLoop(
  loop: UpstreamLoop,
  caps: CapturedValue[],
  msgs: UpstreamMessage[],
): IterationData {
  const steps = (loop.iterations ?? []).map((it) => ({
    iteration: it.index,
    // Faithful: Array.filter preserves source order and duplicates; a nested loop's
    // records carry the nested id and are excluded; a callee's capture with a different
    // scope but a matching tag is correctly included (tags are authoritative, not scope).
    capturedValues: caps
      .filter((cv) => cv.loop === loop.id && cv.iteration === it.index)
      .map((cv) => ({
        variableName: cv.variableName,
        value: toDisplayValue(cv),
        scopeName: cv.scopeName,
        statementId: cv.statementId,
      })),
    messages: msgs
      .filter((m) => m.loop === loop.id && m.iteration === it.index)
      .map((m) => m.text),
    linesExecuted: it.lines ?? [],
    statementsExecuted: it.statements ?? [],
  }));

  return {
    loopId: String(loop.id),
    sourceFile: loop.file,
    loopLine: loop.line,
    loopEndLine: loop.endLine,
    parentLoopId: loop.parentLoop != null ? String(loop.parentLoop) : null,
    parentIteration: loop.parentIteration ?? null,
    iterationCount: loop.iterationCount ?? 0,
    unsegmentable: loop.unsegmentable ?? null,
    closedBy: loop.closedBy ?? null,
    steps,
  };
}

function isUpstreamTest(t: any): boolean {
  return t != null && Array.isArray(t.loops);
}

/** Text projection tolerant of both wire shapes (`string[]` fork, object[] upstream). */
function messageText(m: any): string {
  return typeof m === 'string' ? m : (m?.text ?? '');
}

export function normalizeExecuteResponse(response: any): NormalizedExecute {
  const rawTests: any[] = Array.isArray(response?.tests) ? response.tests : [];
  const upstreamTests = rawTests.filter(isUpstreamTest);
  const hasFork = Array.isArray(response?.iterations);
  const conflict = upstreamTests.length > 0 && hasFork;

  if (upstreamTests.length > 0) {
    // Upstream wins over any coexisting fork data; never merge (ids could collide).
    const structuredMessages: UpstreamMessage[] = Array.isArray(response?.messages)
      ? response.messages.filter((m: any) => m != null && typeof m === 'object')
      : [];
    const iterations = upstreamTests.flatMap((t) =>
      (t.loops as UpstreamLoop[]).map((l) =>
        adaptUpstreamLoop(l, (t.capturedValues ?? []) as CapturedValue[], structuredMessages),
      ),
    );
    const capturedValues = upstreamTests.flatMap((t) =>
      ((t.capturedValues ?? []) as CapturedValue[]).map((cv) => ({
        ...v2ToV1Captured(cv, t.alSourceFile),
        value: toDisplayValue(cv), // canonical: null vs captureError vs number/bool
      })),
    );
    const messages = (Array.isArray(response?.messages) ? response.messages : []).map(messageText);
    const unresolvedScopes = upstreamTests.flatMap((t) =>
      Array.isArray(t.unresolvedScopes) ? (t.unresolvedScopes as string[]) : [],
    );
    return { shape: 'upstream', iterations, capturedValues, messages, structuredMessages, unresolvedScopes, conflict };
  }

  if (hasFork) {
    return {
      shape: 'fork',
      iterations: (response.iterations ?? []) as IterationData[],
      capturedValues: (response.capturedValues ?? []) as CapturedValueV1[],
      messages: (Array.isArray(response?.messages) ? response.messages : []).map(messageText),
      structuredMessages: [],
      unresolvedScopes: [],
      conflict: false,
    };
  }

  return {
    shape: 'none',
    iterations: [],
    capturedValues: (response?.capturedValues ?? []) as CapturedValueV1[],
    messages: (Array.isArray(response?.messages) ? response.messages : []).map(messageText),
    structuredMessages: [],
    unresolvedScopes: [],
    conflict: false,
  };
}
