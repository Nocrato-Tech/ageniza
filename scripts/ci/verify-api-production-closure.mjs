import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-auth declares vitest as an optional peer, so `pnpm deploy --prod` would ship vitest and
// its chain in the API image (issue #281). The hook in .pnpmfile.cjs keeps it out; this gate fails
// when a regenerated lockfile or a new dependency brings the chain back. The chain cannot be read
// from a devDependency name, so it stays listed by hand; every devDependency of the workspace is
// added to it when the gate runs (issue #510).
export const FORBIDDEN_IN_API_PRODUCTION = [
  'vitest',
  'vite',
  'vite-node',
  'tinypool',
  'postcss',
  'source-map-js',
  'jsdom'
];

// The direct dependencies of the API, by value (issue #517). The list derived from the workspace above
// cannot see a package that is a devDependency of one project only: moved to the API's `dependencies` it
// stops being a devDependency anywhere and leaves the derived list, so it would ship with exit 0. A new
// runtime dependency of the API is added to the JSON on purpose, in the change that adds it. The list is a
// file of its own so that the S3Client census (scripts/ci/s3-client-options.test.mjs) does not read it as
// a use of the SDK.
export const API_RUNTIME_DEPENDENCIES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api-runtime-dependencies.json'), 'utf8')
);

// What the production image carries besides node_modules: the `files` of apps/api/package.json
// (issue #305). Anything else in the deploy is source, test or tooling the runtime never reads.
const RUNTIME_ROOT_ENTRIES = new Set(['dist', 'node_modules', 'package.json']);

// The `@ageniza/*` packages reach the image through `pnpm deploy` too, and pnpm honours their
// `files` (issue #510): dist is the runtime, and package.json and README.md are always packed.
// `database` also carries bin and migrations because the migrations image deploys that same
// package and runs them; restricting its `files` further would empty that image.
const INTERNAL_RUNTIME_ENTRIES = new Set(['dist', 'package.json', 'README.md']);
export const INTERNAL_RUNTIME_EXTRAS = { '@ageniza/database': ['bin', 'migrations'] };

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

/** Direct dependencies a package.json declares that are not on the allowed list, sorted. */
export const unexpectedApiDependencies = (manifest, allowed = API_RUNTIME_DEPENDENCIES) =>
  [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])]
    .filter((name) => !allowed.includes(name))
    .sort();

/** Files (posix paths relative to the deploy, node_modules left out) the production image should not carry. */
export const unexpectedInDeploy = (paths) =>
  paths.filter((path) => !RUNTIME_ROOT_ENTRIES.has(path.split('/')[0]) || isTestArtifact(path)).sort();

/** Files (posix paths relative to the package) an `@ageniza/*` package carries beyond its runtime. */
export const unexpectedInInternalPackage = (name, paths) => {
  const allowed = new Set([...INTERNAL_RUNTIME_ENTRIES, ...(INTERNAL_RUNTIME_EXTRAS[name] ?? [])]);
  return paths.filter((path) => !allowed.has(path.split('/')[0]) || isTestArtifact(path)).sort();
};

/** The package.json of every workspace project, the root included, from the globs in pnpm-workspace.yaml. */
const workspaceManifests = (root) => {
  const manifests = [JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))];
  for (const line of readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split(/\r?\n/)) {
    if (!/^\s*-\s/.test(line)) continue;
    const glob = /^\s*-\s*['"]?([^'"\s*]+)\/\*['"]?\s*$/.exec(line);
    if (!glob) throw new Error(`pnpm-workspace.yaml has a pattern this gate cannot read: ${line.trim()}`);
    for (const entry of readdirSync(join(root, glob[1]), { withFileTypes: true })) {
      const manifest = join(root, glob[1], entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(manifest)) manifests.push(JSON.parse(readFileSync(manifest, 'utf8')));
    }
  }
  return manifests;
};

/** Every devDependency the workspace declares, sorted and without repeats. */
export const devDependenciesOfWorkspace = (root) =>
  [...new Set(workspaceManifests(root).flatMap((manifest) => Object.keys(manifest.devDependencies ?? {})))].sort();

/** The hand-listed chain plus every devDependency of the workspace: none of them belongs in the API image. */
export const forbiddenForWorkspace = (root) =>
  [...new Set([...FORBIDDEN_IN_API_PRODUCTION, ...devDependenciesOfWorkspace(root)])].sort();

// A pnpm virtual-store entry is a real directory; statSync follows the link a Windows junction is.
const listFiles = (root, relative = '') => {
  const files = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (relative === '' && entry.name === 'node_modules') continue;
    if (statSync(join(root, path)).isDirectory()) files.push(...listFiles(root, path));
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

/** The `@ageniza/*` packages the deployed API declares: which the store lacks, and the files the others carry beyond their runtime. */
const inspectInternalPackages = (target, store, entries) => {
  const declared = Object.keys(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies ?? {})
    .filter((name) => name.startsWith('@ageniza/'));
  const missing = [];
  const unexpected = [];
  for (const name of declared) {
    const folders = entries
      .filter((entry) => packageNameFromStoreEntry(entry) === name)
      .map((entry) => join(store, entry, 'node_modules', name))
      .filter((folder) => existsSync(folder));
    if (folders.length === 0) missing.push(name);
    for (const folder of folders) {
      unexpected.push(...unexpectedInInternalPackage(name, listFiles(folder)).map((path) => `${name}/${path}`));
    }
  }
  return { missing, unexpected: unexpected.sort() };
};

/** Everything wrong with an already deployed API, as messages; an empty list is a closure worth trusting. */
export const checkDeployedApi = (target, { boot = bootFromDeploy, forbidden = FORBIDDEN_IN_API_PRODUCTION, allowedDependencies = API_RUNTIME_DEPENDENCIES } = {}) => {
  const failures = [];

  const store = join(target, 'node_modules', '.pnpm');
  const entries = existsSync(store)
    ? readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];

  if (!entries.some((entry) => packageNameFromStoreEntry(entry) === closureSentinel)) {
    failures.push(`the deploy has no ${closureSentinel} to inspect.`);
    return failures;
  }

  const reached = forbiddenPackagesIn(entries, forbidden);
  if (reached.length > 0) {
    failures.push(
      `${reached.join(', ')} reached the deployed API.\n` +
      'Keep test-only and development tooling out of the API production dependencies; see docs/ci/README.md.'
    );
  }

  const undeclared = unexpectedApiDependencies(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')), allowedDependencies);
  if (undeclared.length > 0) {
    failures.push(
      `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is a' : 'are'} direct dependenc${undeclared.length === 1 ? 'y' : 'ies'} of the API that ${undeclared.length === 1 ? 'is' : 'are'} not on the allowed list.
` +
      'A development tool stays in devDependencies; a real runtime dependency is added to api-runtime-dependencies.json in the same change; see docs/ci/README.md.'
    );
  }

  const unexpected = unexpectedInDeploy(listFiles(target));
  if (unexpected.length > 0) {
    failures.push(
      `the deploy carries ${unexpected.length} file(s) the runtime does not read, such as ${unexpected.slice(0, 5).join(', ')}.\n` +
      'Keep them out of `files` in apps/api/package.json; see docs/ci/README.md.'
    );
  }

  const internal = inspectInternalPackages(target, store, entries);
  if (internal.missing.length > 0) {
    failures.push(`the deploy has no ${internal.missing.join(', ')} to inspect, and the API declares ${internal.missing.length === 1 ? 'it' : 'them'}.`);
  }
  if (internal.unexpected.length > 0) {
    failures.push(
      `the deploy carries ${internal.unexpected.length} file(s) of @ageniza/* the runtime does not read, such as ${internal.unexpected.slice(0, 5).join(', ')}.\n` +
      'Keep them out of `files` in the package.json of that package; see docs/ci/README.md.'
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
export const verifyApiProductionClosure = ({ deploy = deployWithPnpm, boot = bootFromDeploy, workspaceRoot = repoRoot } = {}) => {
  const forbidden = forbiddenForWorkspace(workspaceRoot);
  const target = mkdtempSync(join(tmpdir(), 'ageniza-api-production-'));
  try {
    deploy(target);
    return checkDeployedApi(target, { boot, forbidden });
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
    console.log('API production closure is free of the test tooling and of every workspace devDependency, carries only what the runtime reads (the API and @ageniza/*), and boots.');
  }
};

if (process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url) {
  main();
}
