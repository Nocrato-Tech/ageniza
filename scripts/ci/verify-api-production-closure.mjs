import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-auth declares vitest as an optional peer, so `pnpm deploy --prod` would ship vitest and
// its chain in the API image (issue #281). The hook in .pnpmfile.cjs keeps it out; this gate fails
// when a regenerated lockfile or a new dependency brings the chain back.
export const FORBIDDEN_IN_API_PRODUCTION = [
  'vitest',
  'vite',
  'vite-node',
  'tinypool',
  'postcss',
  'source-map-js',
  'jsdom'
];

// A deploy without better-auth is not a closure worth trusting.
const closureSentinel = 'better-auth';

/** Package name encoded in a pnpm virtual-store directory name: `vitest@3.2.7(...)` -> `vitest`. */
export const packageNameFromStoreEntry = (entry) => {
  const scoped = /^(@[^+@]+\+[^@]+)@/.exec(entry);
  if (scoped) return scoped[1].replace('+', '/');
  const plain = /^([^@]+)@/.exec(entry);
  return plain ? plain[1] : entry;
};

/** A name is forbidden by itself, and a scoped package is forbidden through its scope: `@vitest/*`. */
export const isForbiddenPackage = (name, forbidden = FORBIDDEN_IN_API_PRODUCTION) =>
  forbidden.includes(name) || (name.startsWith('@') && forbidden.includes(name.slice(1).split('/')[0]));

/** Forbidden package names present in the entries, sorted and without repeats. */
export const forbiddenPackagesIn = (entries, forbidden = FORBIDDEN_IN_API_PRODUCTION) => {
  const found = new Set();
  for (const entry of entries) {
    const name = packageNameFromStoreEntry(entry);
    if (isForbiddenPackage(name, forbidden)) found.add(name);
  }
  return [...found].sort();
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Node refuses to spawn a .cmd shim directly on Windows, so that one goes through cmd.exe.
const deploy = (target) => {
  const args = ['--filter', '@ageniza/api', '--prod', 'deploy', target];
  const options = { cwd: repoRoot, stdio: 'inherit' };
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], options);
  } else {
    execFileSync('pnpm', args, options);
  }
};

const main = () => {
  const target = mkdtempSync(join(tmpdir(), 'ageniza-api-production-'));
  try {
    deploy(target);

    const store = join(target, 'node_modules', '.pnpm');
    const entries = existsSync(store)
      ? readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [];

    if (!entries.some((entry) => packageNameFromStoreEntry(entry) === closureSentinel)) {
      console.error(`API production closure check failed: the deploy has no ${closureSentinel} to inspect.`);
      process.exitCode = 1;
      return;
    }

    const forbidden = forbiddenPackagesIn(entries);
    if (forbidden.length > 0) {
      console.error(
        `API production closure check failed: ${forbidden.join(', ')} reached the deployed API.\n` +
        'Keep test-only tooling out of the API production dependencies; see docs/ci/README.md.'
      );
      process.exitCode = 1;
    } else {
      console.log(`API production closure is free of ${FORBIDDEN_IN_API_PRODUCTION.join(', ')}.`);
    }
  } finally {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // A busy junction on Windows must not turn a passing check red.
    }
  }
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  main();
}
