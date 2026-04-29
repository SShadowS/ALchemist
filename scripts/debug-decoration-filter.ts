// Debug script: trace what applyInlineCapturedValues would do with real
// fork-binary output against the user's ALProject4 workspace.
// Run: npx tsx scripts/debug-decoration-filter.ts
import * as path from 'path';
import { v2ToV1Captured } from '../src/execution/captureValueAdapter';
import { CapturedValue as V2CapturedValue } from '../src/execution/protocolV2Types';

const editorFsPath = String.raw`C:\Users\SShadowS\Documents\AL\ALProject4\CU1.al`;
const workspacePath = String.raw`C:\Users\SShadowS\Documents\AL\ALProject4`;

// Real test event from fork smoke (post-f2d2bb3):
const testEventAlSourceFile = 'TextCU.al';
const v2Capture: V2CapturedValue = {
  scopeName: 'MyProcedure_Scope_1496267096',
  objectName: 'CU1',
  alSourceFile: 'CU1.al',
  variableName: 'myint',
  value: '1',
  statementId: 0,
};

console.log('--- Stage 1: v2ToV1Captured translation ---');
const v1 = v2ToV1Captured(v2Capture, testEventAlSourceFile);
console.log(JSON.stringify(v1, null, 2));

console.log('\n--- Stage 2: applyInlineCapturedValues filter logic ---');
console.log(`editor.uri.fsPath:     ${editorFsPath}`);
console.log(`workspacePath:         ${workspacePath}`);
console.log(`cv.sourceFile:         ${v1.sourceFile}`);
const resolved = path.resolve(workspacePath, v1.sourceFile);
console.log(`path.resolve():        ${resolved}`);
const lhs = path.normalize(resolved).toLowerCase();
const rhs = path.normalize(editorFsPath).toLowerCase();
console.log(`normalized lhs:        ${lhs}`);
console.log(`normalized rhs:        ${rhs}`);
console.log(`MATCHES: ${lhs === rhs}`);

console.log('\n--- Conclusion ---');
if (lhs === rhs) {
  console.log('Filter PASSES. Capture should render. Bug is elsewhere — likely extension version not reloaded.');
} else {
  console.log('Filter FAILS. Bug in path resolution.');
}
