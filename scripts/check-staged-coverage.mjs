#!/usr/bin/env node
// Per-file coverage gate. Reads coverage/coverage-summary.json (vitest /
// v8 / istanbul output) and verifies each staged .ts/.tsx file meets the
// thresholds. Used by the pre-commit hook.
//
// Behavior:
//   - No staged .ts/.tsx files                → exit 0 (nothing to check)
//   - coverage-summary.json missing           → exit 0 with a one-line hint
//                                               (so bootstrap commits aren't
//                                               blocked before tests exist)
//   - Staged file present in report + below   → BLOCK (exit 1)
//   - Staged file absent from report          → BLOCK (exit 1) — staged
//                                               source code with no test
//                                               file at all is the worst
//                                               quality signal we have
//
// Override (escape hatch for legitimate bootstrap commits with no tests):
//   STAGED_COVERAGE_SKIP=1 git commit ...

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const THRESHOLDS = {
  statements: 75,
  branches: 60,
  functions: 75,
  lines: 75,
};

// Infrastructure files that legitimately have no unit tests: build/tooling
// configs, ambient type declarations, and test-harness setup. These are
// exempt from the coverage gate so a first scaffold commit — which stages
// exactly these files — passes without an escape hatch. This keeps the
// documented bootstrap flow consistent with CLAUDE.md commit discipline
// (which forbids STAGED_COVERAGE_SKIP without explicit user instruction).
const COVERAGE_EXEMPT = [
  /\.d\.ts$/, // ambient type declarations (e.g. vite-env.d.ts)
  /(^|\/)[^/]+\.config\.ts$/, // build/tooling configs (vite.config.ts, vitest.config.ts, ...)
  /(^|\/)test\/setup\.ts$/, // test-harness setup (src/test/setup.ts)
];

if (process.env.STAGED_COVERAGE_SKIP === '1') {
  console.log('STAGED_COVERAGE_SKIP=1 — coverage gate bypassed (use sparingly).');
  process.exit(0);
}

const stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
  .filter((f) => !COVERAGE_EXEMPT.some((re) => re.test(f)))
  .filter(Boolean);

if (stagedFiles.length === 0) {
  console.log('Coverage gate: no staged .ts/.tsx — skipped.');
  process.exit(0);
}

const coverageFile = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
if (!fs.existsSync(coverageFile)) {
  console.log(
    'Coverage gate: coverage/coverage-summary.json not found — skipped.\n' +
      '  Run `npm run test:coverage` to enable the gate. Once a report exists,\n' +
      '  this gate will enforce per-file thresholds on subsequent commits.',
  );
  process.exit(0);
}

const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf-8'));

const failures = [];
const notFound = [];

for (const file of stagedFiles) {
  const absolutePath = path.resolve(process.cwd(), file);
  const fileCoverage = coverage[absolutePath];

  if (!fileCoverage) {
    notFound.push(file);
    continue;
  }

  const issues = [];
  for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
    const pct = fileCoverage[metric]?.pct ?? 0;
    if (pct < threshold) issues.push(`${metric}: ${pct.toFixed(2)}% < ${threshold}%`);
  }
  if (issues.length > 0) failures.push({ file, issues });
}

if (failures.length === 0 && notFound.length === 0) {
  console.log(`Coverage gate: ${stagedFiles.length} staged file(s) above thresholds. ✓`);
  process.exit(0);
}

console.error('');
console.error('╔══════════════════════════════════════════════════════════════════╗');
console.error('║  COVERAGE GATE FAILED                                            ║');
console.error('╚══════════════════════════════════════════════════════════════════╝');

if (failures.length > 0) {
  console.error('');
  console.error('Below threshold:');
  for (const { file, issues } of failures) {
    console.error(`  ${file}`);
    for (const issue of issues) console.error(`    ${issue}`);
  }
}

if (notFound.length > 0) {
  console.error('');
  console.error('No coverage report entry (file has no associated test):');
  for (const file of notFound) console.error(`  ${file}`);
}

console.error('');
console.error('Thresholds:', JSON.stringify(THRESHOLDS));
console.error('Fix: add or improve tests, then `npm run test:coverage` to refresh the report.');
console.error('Bypass (use sparingly):  STAGED_COVERAGE_SKIP=1 git commit ...');
console.error('');
process.exit(1);
