import { CapturedValue as CapturedValueV1 } from '../runner/outputParser';
import { CapturedValue as CapturedValueV2 } from './protocolV2Types';

/**
 * Translate a v2 `CapturedValue` into the legacy v1 shape used by
 * `DecorationManager.applyInlineCapturedValues` and the OutputChannel.
 *
 * v2 emits `objectName` (the AL codeunit/page name); v1 expects
 * `sourceFile` (a relative AL file path, e.g. `src/Calc.Codeunit.al`).
 * The two are different concepts. To make the inline-render file filter
 * work, this translator resolves `sourceFile` in priority order:
 *
 *   1. The capture's own `alSourceFile` (added by the runner via per-capture
 *      SourceFileMapper lookup) — most accurate, attributes captures from
 *      a codeunit invoked indirectly by the test to that codeunit's file.
 *   2. The `fallbackAlSourceFile` argument — typically the test event's
 *      own `alSourceFile`. Used when (1) is absent.
 *   3. `objectName` — lossy, only fires if both above are absent. The
 *      DecorationManager logs a one-time warning when the resulting
 *      sourceFile doesn't end in `.al` so this case is observable.
 */
export function v2ToV1Captured(
  v2: CapturedValueV2,
  fallbackAlSourceFile?: string,
): CapturedValueV1 {
  return {
    scopeName: v2.scopeName,
    sourceFile: v2.alSourceFile ?? fallbackAlSourceFile ?? v2.objectName ?? '',
    variableName: v2.variableName,
    value: typeof v2.value === 'string' ? v2.value : JSON.stringify(v2.value),
    statementId: v2.statementId,
  };
}
