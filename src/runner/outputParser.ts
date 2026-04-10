import { XMLParser } from 'fast-xml-parser';

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'errored';
  durationMs: number | undefined;
  message: string | undefined;
  stackTrace: string | undefined;
}

export interface CoverageEntry {
  className: string;
  filename: string;
  lineRate: number;
  lines: Array<{ number: number; hits: number }>;
}

export interface RunSummary {
  passed: number;
  failed: number;
  errors: number;
  total: number;
}

export interface ExecutionResult {
  mode: 'test' | 'scratch';
  tests: TestResult[];
  messages: string[];
  stderrOutput: string[];
  summary: RunSummary | undefined;
  coverage: CoverageEntry[];
  exitCode: number;
  durationMs: number;
}

const PASS_REGEX = /^PASS\s{2}(\S+)\s+\((\d+)ms\)$/;
const FAIL_REGEX = /^FAIL\s{2}(\S+)$/;
const ERROR_REGEX = /^ERROR\s+(\S+)$/;
const SUMMARY_REGEX = /^Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+errors,\s+(\d+)\s+total$/;
const INDENT_REGEX = /^\s{6}/;

export function parseRunSummary(line: string): RunSummary | undefined {
  const m = line.match(SUMMARY_REGEX);
  if (!m) { return undefined; }
  return {
    passed: parseInt(m[1], 10),
    failed: parseInt(m[2], 10),
    errors: parseInt(m[3], 10),
    total: parseInt(m[4], 10),
  };
}

export function parseTestOutput(stdout: string): { tests: TestResult[]; messages: string[]; summary: RunSummary | undefined } {
  const lines = stdout.split('\n');
  const tests: TestResult[] = [];
  const messages: string[] = [];
  let summary: RunSummary | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const passMatch = line.match(PASS_REGEX);
    if (passMatch) {
      tests.push({
        name: passMatch[1],
        status: 'passed',
        durationMs: parseInt(passMatch[2], 10),
        message: undefined,
        stackTrace: undefined,
      });
      i++;
      continue;
    }

    const failMatch = line.match(FAIL_REGEX);
    if (failMatch) {
      const { message, stackTrace, nextIndex } = collectIndentedBlock(lines, i + 1);
      tests.push({
        name: failMatch[1],
        status: 'failed',
        durationMs: undefined,
        message,
        stackTrace,
      });
      i = nextIndex;
      continue;
    }

    const errorMatch = line.match(ERROR_REGEX);
    if (errorMatch) {
      const { message, stackTrace, nextIndex } = collectIndentedBlock(lines, i + 1);
      tests.push({
        name: errorMatch[1],
        status: 'errored',
        durationMs: undefined,
        message,
        stackTrace,
      });
      i = nextIndex;
      continue;
    }

    const summaryMatch = parseRunSummary(line);
    if (summaryMatch) {
      summary = summaryMatch;
      i++;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length > 0) {
      messages.push(trimmed);
    }

    i++;
  }

  return { tests, messages, summary };
}

function collectIndentedBlock(lines: string[], startIndex: number): { message: string; stackTrace: string; nextIndex: number } {
  const detailLines: string[] = [];
  let i = startIndex;
  while (i < lines.length && INDENT_REGEX.test(lines[i])) {
    detailLines.push(lines[i].trim());
    i++;
  }
  const message = detailLines[0] || '';
  const stackTrace = detailLines.slice(1).join('\n');
  return { message, stackTrace, nextIndex: i };
}

export function parseCoberturaXml(xml: string): CoverageEntry[] {
  if (!xml || xml.trim().length === 0) { return []; }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'class' || name === 'line' || name === 'package',
  });

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const packages = parsed?.coverage?.packages?.package;
  if (!packages) { return []; }

  const entries: CoverageEntry[] = [];

  for (const pkg of Array.isArray(packages) ? packages : [packages]) {
    const classes = pkg?.classes?.class;
    if (!classes) { continue; }

    for (const cls of Array.isArray(classes) ? classes : [classes]) {
      const lines = cls?.lines?.line;
      const parsedLines: Array<{ number: number; hits: number }> = [];

      if (lines) {
        for (const line of Array.isArray(lines) ? lines : [lines]) {
          parsedLines.push({
            number: parseInt(line['@_number'], 10),
            hits: parseInt(line['@_hits'], 10),
          });
        }
      }

      entries.push({
        className: cls['@_name'] || '',
        filename: cls['@_filename'] || '',
        lineRate: parseFloat(cls['@_line-rate'] || '0'),
        lines: parsedLines,
      });
    }
  }

  return entries;
}
