import * as fs from 'fs';
import * as path from 'path';
import { EXCLUDED_DIR_NAMES } from '../workspace/workspaceModel';

export interface DiscoveredTest {
  name: string;
  line: number; // 0-indexed line of the [Test] attribute
}

export interface DiscoveredTestCodeunit {
  codeunitName: string;
  codeunitId: number;
  fileName: string;
  tests: DiscoveredTest[];
}

// Accept both quoted identifiers ("Test Foo") and bare identifiers (TestFoo).
// Bare identifiers are AL identifier tokens: first char letter/underscore, rest word chars.
// AL reserved words (procedure, begin, end, ...) are NOT excluded — the AL
// compiler is authoritative. Discovery operates on potentially broken files;
// extracting "procedure" as a codeunit name from `codeunit 50100 procedure`
// is acceptable since AL.Runner will surface the real syntax error.
const CODEUNIT_REGEX = /codeunit\s+(\d+)\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i;
const TEST_ATTR_REGEX = /^\s*\[Test\]\s*$/i;
const PROCEDURE_REGEX = /^\s*(?:local\s+)?procedure\s+(\w+)\s*\(/i;

export function discoverTestsFromContent(content: string, fileName: string): DiscoveredTestCodeunit[] {
  const lines = content.split('\n');
  const codeunits: DiscoveredTestCodeunit[] = [];

  let currentCodeunitName: string | undefined;
  let currentCodeunitId: number | undefined;
  let currentTests: DiscoveredTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect codeunit declaration
    const codeunitMatch = line.match(CODEUNIT_REGEX);
    if (codeunitMatch) {
      // Save previous codeunit if it had tests
      if (currentCodeunitName && currentTests.length > 0) {
        codeunits.push({
          codeunitName: currentCodeunitName,
          codeunitId: currentCodeunitId!,
          fileName,
          tests: currentTests,
        });
      }
      currentCodeunitId = parseInt(codeunitMatch[1], 10);
      currentCodeunitName = codeunitMatch[2] ?? codeunitMatch[3];
      currentTests = [];
      continue;
    }

    // Detect [Test] attribute
    if (TEST_ATTR_REGEX.test(line)) {
      // Look ahead for the procedure name
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const procMatch = lines[j].match(PROCEDURE_REGEX);
        if (procMatch) {
          currentTests.push({ name: procMatch[1], line: i });
          break;
        }
      }
      continue;
    }
  }

  // Save last codeunit
  if (currentCodeunitName && currentTests.length > 0) {
    codeunits.push({
      codeunitName: currentCodeunitName,
      codeunitId: currentCodeunitId!,
      fileName,
      tests: currentTests,
    });
  }

  return codeunits;
}

export function discoverTestsInWorkspaceSync(workspacePath: string): DiscoveredTestCodeunit[] {
  const allCodeunits: DiscoveredTestCodeunit[] = [];
  const alFiles = findAlFilesSync(workspacePath);
  for (const filePath of alFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(workspacePath, filePath);
    const discovered = discoverTestsFromContent(content, relativePath);
    allCodeunits.push(...discovered);
  }
  return allCodeunits;
}

// Keep async wrapper for backward compat with existing callers.
export async function discoverTestsInWorkspace(workspacePath: string): Promise<DiscoveredTestCodeunit[]> {
  return discoverTestsInWorkspaceSync(workspacePath);
}

function findAlFilesSync(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIR_NAMES.has(entry.name)) {
      results.push(...findAlFilesSync(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.al')) {
      results.push(fullPath);
    }
  }
  return results;
}

