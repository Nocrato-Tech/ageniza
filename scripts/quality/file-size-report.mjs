#!/usr/bin/env node
// Lists source files over the review threshold, as a prompt for a structural review. It never fails the build.
//   node scripts/quality/file-size-report.mjs           list
//   node scripts/quality/file-size-report.mjs --json    machine-readable
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const THRESHOLD = 800;
const SOURCE = /^(apps|packages)\/[^/]+\/src\/.+\.(ts|tsx|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|js|mjs|cjs)$|\/test\//;
const GENERATED = /\.gen\.[^/]+$|\/generated\//;

// A trailing empty line after the final newline is not a line.
export function countLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length;
}

export function isReviewed(path) {
  return SOURCE.test(path) && !TEST.test(path) && !GENERATED.test(path);
}

export function analyze(sizes) {
  const files = Object.entries(sizes)
    .filter(([path, lines]) => isReviewed(path) && lines > THRESHOLD)
    .map(([path, lines]) => ({ path, lines }))
    .sort((a, b) => b.lines - a.lines);
  return { threshold: THRESHOLD, count: files.length, files };
}

function readSizes() {
  const files = execFileSync('git', ['ls-files', '-z', 'apps', 'packages'], { encoding: 'utf8' })
    .split('\0')
    .filter(isReviewed);
  return Object.fromEntries(files.map((path) => [path, countLines(readFileSync(path, 'utf8'))]));
}

function main(args) {
  const report = analyze(readSizes());

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Source files over ${report.threshold} lines, to review for structure: ${report.count}.`);
  for (const f of report.files) console.log(`  ${String(f.lines).padStart(5)}  ${f.path}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
