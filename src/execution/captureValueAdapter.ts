import { CapturedValue as CapturedValueV1 } from '../runner/outputParser';
import { CapturedValue as CapturedValueV2 } from './protocolV2Types';

/**
 * Translate a v2 `CapturedValue` into the legacy v1 shape used by
 * `DecorationManager.applyInlineCapturedValues` and the OutputChannel.
 *
 * v2 emits `objectName` (the AL codeunit/page name); v1 expects
 * `sourceFile` (a relative AL file path, e.g. `src/Calc.Codeunit.al`).
 * The two are different concepts. To make the inline-render file filter
 * work, callers should pass the test event's `alSourceFile` as the
 * second argument; the translator uses it for `sourceFile` when present.
 *
 * If `alSourceFile` is omitted (legacy callers, defensive default),
 * `objectName` falls back into `sourceFile` — preserving the previous
 * lossy behavior so existing tests still pass and old call sites don't
 * silently break. The DecorationManager filter logs a debug warning
 * when it sees a `sourceFile` that doesn't end in `.al` (Plan E2.1
 * task 7), making the lossy case observable.
 */
export function v2ToV1Captured(
  v2: CapturedValueV2,
  alSourceFile?: string,
): CapturedValueV1 {
  return {
    scopeName: v2.scopeName,
    sourceFile: alSourceFile ?? v2.objectName ?? '',
    variableName: v2.variableName,
    value: typeof v2.value === 'string' ? v2.value : JSON.stringify(v2.value),
    statementId: v2.statementId,
  };
}
