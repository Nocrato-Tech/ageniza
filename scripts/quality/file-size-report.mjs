#!/usr/bin/env node
// Measures how far the linted source is over the max-lines budget, so the trend can be followed over time.
//   node scripts/quality/file-size-report.mjs           summary
//   node scripts/quality/file-size-report.mjs --json    machine-readable, for history snapshots
//   node scripts/quality/file-size-report.mjs --prune   drops from the baseline files that are back under budget
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE_URL = new URL('./max-lines-baseline.json', import.meta.url);
const SOURCE = /^(apps|packages)\/[^/]+\/(src|test)\/.+\.(ts|tsx|js|mjs|cjs)$/;
const TEST = /(\.test\.(ts|tsx)$)|(^(apps|packages)\/[^/]+\/test\/)|(\/test\/)/;

// Same count as ESLint's max-lines: a trailing empty line after the final newline does not count.
export function countLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length;
}

export function isGatedSource(path) {
  return SOURCE.test(path) && !TEST.test(path);
}

export function analyze({ sizes, baseline }) {
  const listed = new Set(baseline.files);
  const over = Object.entries(sizes)
    .filter(([path, lines]) => isGatedSource(path) && lines > baseline.max)
    .map(([path, lines]) => ({ path, lines, excess: lines - baseline.max }))
    .sort((a, b) => b.lines - a.lines);
  const tests = Object.entries(sizes).filter(([path]) => SOURCE.test(path) && TEST.test(path));
  return {
    max: baseline.max,
    overBudget: over.length,
    excessLines: over.reduce((sum, f) => sum + f.excess, 0),
    largest: over.slice(0, 10),
    notInBaseline: over.filter((f) => !listed.has(f.path)).map((f) => f.path),
    prunable: baseline.files.filter((path) => !(path in sizes) || sizes[path] <= baseline.max),
    testsOverBudget: tests.filter(([, lines]) => lines > baseline.max).length,
    testExcessLines: tests.reduce((sum, [, lines]) => sum + Math.max(0, lines - baseline.max), 0)
  };
}

function readSizes() {
  const files = execFileSync('git', ['ls-files', '-z', 'apps', 'packages'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => SOURCE.test(path));
  return Object.fromEntries(files.map((path) => [path, countLines(readFileSync(path, 'utf8'))]));
}

function main(args) {
  const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
  const report = analyze({ sizes: readSizes(), baseline });

  if (args.includes('--prune')) {
    const keep = baseline.files.filter((path) => !report.prunable.includes(path));
    writeFileSync(BASELINE_URL, `${JSON.stringify({ ...baseline, files: keep }, null, 2)}\n`);
    console.log(`Baseline: ${baseline.files.length} -> ${keep.length} files.`);
    return;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), ...report }, null, 2));
    return;
  }

  console.log(`Source over ${report.max} lines: ${report.overBudget} files, ${report.excessLines} lines over budget.`);
  console.log(`Tests over ${report.max} lines (not gated): ${report.testsOverBudget} files, ${report.testExcessLines} lines over budget.`);
  for (const f of report.largest) console.log(`  ${String(f.lines).padStart(5)}  ${f.path}`);
  if (report.prunable.length) console.log(`Back under budget, run --prune: ${report.prunable.join(', ')}`);
  if (report.notInBaseline.length) console.log(`Over budget outside the baseline (lint fails): ${report.notInBaseline.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
