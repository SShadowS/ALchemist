import { CapturedValue as CapturedValueV1 } from '../runner/outputParser';
import { CapturedValue as CapturedValueV2 } from './protocolV2Types';

/**
 * Translate a v2 `CapturedValue` (objectName + JSON-shaped value) into the
 * legacy v1 shape used by `DecorationManager.applyInlineCapturedValues`.
 *
 * LOSSY — read carefully:
 *
 * - v2's `objectName` (e.g. "Codeunit MyTest") is fed into v1's `sourceFile`
 *   slot. `sourceFile` is conceptually a workspace-relative file path, and
 *   the downstream `applyInlineCapturedValues` filter compares it against
 *   the active editor's `fsPath`. A translated v2 record will typically
 *   fail that filter and not render inline through the legacy
 *   file-filtered path. This is acceptable as a transitional stopgap:
 *   the v2 streaming flow goes through `setCapturedValuesForTest`
 *   (per-test scope map), which does NOT use the file filter.
 *
 * - v2's `value` is `unknown` (any JSON shape per the v2 schema). Non-string
 *   values are JSON-stringified so consumers see a printable representation.
 *
 * - v2's `objectName` is optional in the schema. When the emitter omits it,
 *   we substitute the empty string so the v1 record stays well-typed; the
 *   inline-render filter naturally rejects empty `sourceFile`.
 *
 * The proper long-term fix is to thread `event.alSourceFile` (which the v2
 * server emits on the TestEvent) into the captured-value record at the
 * controller boundary and extend the v1 CapturedValue shape to carry it.
 * That is deferred — see CHANGELOG known limitations.
 */
export function v2ToV1Captured(v2: CapturedValueV2): CapturedValueV1 {
  return {
    scopeName: v2.scopeName,
    sourceFile: v2.objectName ?? '',
    variableName: v2.variableName,
    value: typeof v2.value === 'string' ? v2.value : JSON.stringify(v2.value),
    statementId: v2.statementId,
  };
}
