import { execFileSync, spawnSync } from 'node:child_process';
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

// What the production image carries besides node_modules: the `files` of apps/api/package.json
// (issue #305). Anything else in the deploy is source, test or tooling the runtime never reads.
const RUNTIME_ROOT_ENTRIES = new Set(['dist', 'node_modules', 'package.json']);

// Loading these in the deploy proves the closure still has everything the API imports at boot, and
// the two commands the production runbook runs in the image: a green image build does not
// (issue #281, the lesson of the review of #300).
export const BOOT_MODULES = ['dist/app.js', 'dist/server.js', 'dist/cli/agency.js', 'dist/cli/email-change.js'];

// The closure is read from the directory names of pnpm's virtual store (`name@version_peers`). A
// pnpm that names them differently, or lays node_modules out another way, finds no sentinel and
// fails the gate instead of passing it, so a format change shows up as red rather than as a
// closure nobody inspected.
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

const isTestArtifact = (path) => /(^|\/)[^/]*\.test\.[^/]*$/.test(path) || path.split('/').includes('test-support');

/** Files (posix paths relative to the deploy, node_modules left out) the production image should not carry. */
export const unexpectedInDeploy = (paths) =>
  paths.filter((path) => !RUNTIME_ROOT_ENTRIES.has(path.split('/')[0]) || isTestArtifact(path)).sort();

const listFiles = (root, relative = '') => {
  const files = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (relative === '' && entry.name === 'node_modules') continue;
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else files.push(path);
  }
  return files;
};

/** Imports the boot modules from inside the deploy; returns the error message, or undefined when they load. */
export const bootFromDeploy = (target, modules = BOOT_MODULES) => {
  const script = `Promise.all(${JSON.stringify(modules)}.map((file) => import(require('node:url').pathToFileURL(require('node:path').resolve(file)).href))).then(() => process.exit(0), (error) => { console.error(error?.message ?? String(error)); process.exit(1); })`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: target, encoding: 'utf8' });
  if (result.error) return `could not start node: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return (result.stderr || result.stdout || `node exited with ${result.status}`).trim().split('\n')[0];
};

/** Everything wrong with an already deployed API, as messages; an empty list is a closure worth trusting. */
export const checkDeployedApi = (target, { boot = bootFromDeploy } = {}) => {
  const failures = [];

  const store = join(target, 'node_modules', '.pnpm');
  const entries = existsSync(store)
    ? readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];

  if (!entries.some((entry) => packageNameFromStoreEntry(entry) === closureSentinel)) {
    failures.push(`the deploy has no ${closureSentinel} to inspect.`);
    return failures;
  }

  const forbidden = forbiddenPackagesIn(entries);
  if (forbidden.length > 0) {
    failures.push(
      `${forbidden.join(', ')} reached the deployed API.\n` +
      'Keep test-only tooling out of the API production dependencies; see docs/ci/README.md.'
    );
  }

  const unexpected = unexpectedInDeploy(listFiles(target));
  if (unexpected.length > 0) {
    failures.push(
      `the deploy carries ${unexpected.length} file(s) the runtime does not read, such as ${unexpected.slice(0, 5).join(', ')}.\n` +
      'Keep them out of `files` in apps/api/package.json; see docs/ci/README.md.'
    );
  }

  const bootError = boot(target);
  if (bootError !== undefined) {
    failures.push(`${BOOT_MODULES.join(' and ')} do not load in the deploy: ${bootError}\nThe deploy ships the compiled dist, so the API has to be built first (pnpm build).`);
  }

  return failures;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Node refuses to spawn a .cmd shim directly on Windows, so that one goes through cmd.exe.
const deployWithPnpm = (target) => {
  const args = ['--filter', '@ageniza/api', '--prod', 'deploy', target];
  const options = { cwd: repoRoot, stdio: 'inherit' };
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], options);
  } else {
    execFileSync('pnpm', args, options);
  }
};

/** Deploys the API into a temporary directory, checks it, and removes it. Returns the failures. */
export const verifyApiProductionClosure = ({ deploy = deployWithPnpm, boot = bootFromDeploy } = {}) => {
  const target = mkdtempSync(join(tmpdir(), 'ageniza-api-production-'));
  try {
    deploy(target);
    return checkDeployedApi(target, { boot });
  } finally {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // A busy junction on Windows must not turn a passing check red.
    }
  }
};

export const main = (options) => {
  const failures = verifyApiProductionClosure(options);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`API production closure check failed: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`API production closure is free of ${FORBIDDEN_IN_API_PRODUCTION.join(', ')}, carries only what the runtime reads, and boots.`);
  }
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  main();
}
