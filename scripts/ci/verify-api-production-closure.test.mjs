import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_RUNTIME_DEPENDENCIES,
  BOOT_MODULES,
  FORBIDDEN_IN_API_PRODUCTION,
  INTERNAL_RUNTIME_EXTRAS,
  bootFromDeploy,
  checkDeployedApi,
  devDependenciesOfWorkspace,
  forbiddenForWorkspace,
  forbiddenPackagesIn,
  main,
  packageNameFromStoreEntry,
  unexpectedApiDependencies,
  unexpectedInDeploy,
  unexpectedInInternalPackage,
  verifyApiProductionClosure
} from './verify-api-production-closure.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const created = [];
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'closure-test-'));
  created.push(directory);
  return directory;
};

const write = (root, relative, content = '') => {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), content);
};

const CLEAN_FILES = ['package.json', 'dist/app.js', 'dist/server.js', 'dist/modules/auth/routes.js'];

// What `pnpm deploy --prod` leaves of each @ageniza/* package once its `files` are honoured.
const CLEAN_INTERNAL = {
  config: ['package.json', 'README.md', 'dist/server.js', 'dist/server.d.ts.map'],
  contracts: ['package.json', 'README.md', 'dist/index.js'],
  core: ['package.json', 'README.md', 'dist/index.js'],
  database: ['package.json', 'README.md', 'dist/index.js', 'bin/migrate.mjs', 'migrations/20260915000000_database_foundation.mjs'],
  email: ['package.json', 'README.md', 'dist/index.js']
};

/**
 * A deploy as `pnpm deploy --prod` lays it out: `store` is the entries of node_modules/.pnpm, `null` meaning no store at all,
 * and `internal` the files of each @ageniza/* package the API declares, which sit in their own store entry.
 */
const populate = (root, { store = ['better-auth@1.7.5', 'pg@8.16.3'], files = CLEAN_FILES, internal = CLEAN_INTERNAL, manifest = {} } = {}) => {
  if (store !== null) {
    mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
    for (const entry of store) mkdirSync(join(root, 'node_modules', '.pnpm', entry));
    for (const [name, packageFiles] of Object.entries(internal)) {
      const folder = join('node_modules', '.pnpm', `@ageniza+${name}@file+packages+${name}`, 'node_modules', '@ageniza', name);
      for (const file of packageFiles) write(root, join(folder, file));
    }
  }
  for (const file of files) write(root, file);
  const dependencies = Object.fromEntries(Object.keys(internal).map((name) => [`@ageniza/${name}`, `file:packages/${name}`]));
  if (files.includes('package.json')) {
    write(root, 'package.json', JSON.stringify({ name: '@ageniza/api', type: 'module', ...manifest, dependencies: { ...dependencies, ...manifest.dependencies } }));
  }
  return root;
};

/** A workspace as pnpm-workspace.yaml describes it: the root and one project per entry of `projects`. */
const workspace = ({ root = {}, projects = {}, globs = ['apps/*', 'packages/*'] } = {}) => {
  const directory = temporaryDirectory();
  write(directory, 'pnpm-workspace.yaml', `packages:\n${globs.map((glob) => `  - ${glob}\n`).join('')}`);
  write(directory, 'package.json', JSON.stringify(root));
  for (const glob of globs) mkdirSync(join(directory, glob.split('/*')[0]), { recursive: true });
  for (const [path, manifest] of Object.entries(projects)) write(directory, `${path}/package.json`, JSON.stringify(manifest));
  return directory;
};

const deployed = (options) => populate(temporaryDirectory(), options);
const bootsFine = () => undefined;

describe('pnpm virtual-store entry names', () => {
  it('reads the package name before the version and its peer suffixes', () => {
    expect(packageNameFromStoreEntry('better-auth@1.7.5')).toBe('better-auth');
    expect(packageNameFromStoreEntry('vitest@3.2.7(@types/node@22.20.2)(jsdom@26.1.0)')).toBe('vitest');
  });

  it('reads a scoped package', () => {
    expect(packageNameFromStoreEntry('@types+node@22.20.2')).toBe('@types/node');
    expect(packageNameFromStoreEntry('@fastify+rate-limit@10.3.0')).toBe('@fastify/rate-limit');
  });
});

describe('API production closure', () => {
  it('forbids exactly the test tooling the review of #300 named, by value', () => {
    expect(FORBIDDEN_IN_API_PRODUCTION).toEqual(['vitest', 'vite', 'vite-node', 'tinypool', 'postcss', 'source-map-js', 'jsdom']);
  });

  it('accepts a closure without the test tooling', () => {
    expect(forbiddenPackagesIn(['better-auth@1.7.5', '@fastify+rate-limit@10.3.0', 'pg@8.16.3'])).toEqual([]);
  });

  it('reports vitest and its chain, once each and sorted', () => {
    expect(forbiddenPackagesIn(['vitest@3.2.7', 'vite@7.1.0', 'tinypool@2.1.2', 'vitest@3.2.7'])).toEqual(['tinypool', 'vite', 'vitest']);
  });

  it('reports each forbidden package on its own, from a literal list rather than the one the script exports', () => {
    for (const name of ['vitest', 'vite', 'vite-node', 'tinypool', 'postcss', 'source-map-js', 'jsdom']) {
      expect(forbiddenPackagesIn([`${name}@1.0.0`]), name).toEqual([name]);
    }
  });

  it('reports the vitest scoped packages through their scope', () => {
    expect(forbiddenPackagesIn(['@vitest+expect@3.2.7', '@vitest+runner@3.2.7', '@vitest+utils@3.2.7']))
      .toEqual(['@vitest/expect', '@vitest/runner', '@vitest/utils']);
  });

  it('does not flag a package whose name merely contains a forbidden one', () => {
    expect(forbiddenPackagesIn(['vite-plugin-checker@1.0.0', 'postcssify@2.0.0', 'jsdom-global@3.0.2'])).toEqual([]);
  });
});

describe('what the production image carries', () => {
  it('keeps the compiled runtime and package.json', () => {
    expect(unexpectedInDeploy(['package.json', 'dist/app.js', 'dist/app.js.map', 'dist/app.d.ts', 'dist/cli/agency.js', 'dist/modules/auth/better-auth.js'])).toEqual([]);
  });

  it('flags source, tooling and the Dockerfile outside dist', () => {
    expect(unexpectedInDeploy(['package.json', 'src/app.ts', 'tsconfig.json', 'vitest.integration.config.ts', 'Dockerfile', '.turbo/turbo-build.log', 'dist/app.js']))
      .toEqual(['.turbo/turbo-build.log', 'Dockerfile', 'src/app.ts', 'tsconfig.json', 'vitest.integration.config.ts']);
  });

  it('flags compiled tests in every output form, and the test support that only tests import', () => {
    expect(unexpectedInDeploy([
      'dist/app.test.js', 'dist/app.test.d.ts', 'dist/app.test.js.map',
      'dist/modules/clients/clients.integration.test.js',
      'dist/modules/auth/test-support/harness.js',
      'dist/modules/auth/test-support/nested/helper.js',
      'dist/modules/auth/routes.js', 'dist/latest.js'
    ])).toEqual([
      'dist/app.test.d.ts', 'dist/app.test.js', 'dist/app.test.js.map',
      'dist/modules/auth/test-support/harness.js', 'dist/modules/auth/test-support/nested/helper.js',
      'dist/modules/clients/clients.integration.test.js'
    ]);
  });
});

describe('what an @ageniza/* package carries', () => {
  it('keeps the compiled runtime, package.json and the README npm always packs', () => {
    expect(unexpectedInInternalPackage('@ageniza/core', ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'dist/logging/redaction.js'])).toEqual([]);
  });

  it('flags source, tests, tooling and the build cache outside dist', () => {
    expect(unexpectedInInternalPackage('@ageniza/config', [
      'package.json', 'dist/server.js', 'src/server.ts', 'src/server.test.ts', 'test/env.test.ts',
      '.turbo/turbo-build.log', 'tsconfig.json', 'vitest.config.ts', 'vitest.integration.config.ts'
    ])).toEqual(['.turbo/turbo-build.log', 'src/server.test.ts', 'src/server.ts', 'test/env.test.ts', 'tsconfig.json', 'vitest.config.ts', 'vitest.integration.config.ts']);
  });

  it('flags compiled tests and test support inside dist', () => {
    expect(unexpectedInInternalPackage('@ageniza/database', [
      'dist/index.js', 'dist/integration-database-url.test.js', 'dist/integration-database-url.test.d.ts.map', 'dist/test-support/harness.js'
    ])).toEqual(['dist/integration-database-url.test.d.ts.map', 'dist/integration-database-url.test.js', 'dist/test-support/harness.js']);
  });

  it('lets only the database carry the migration runner and the migrations, which the migrations image runs', () => {
    expect(INTERNAL_RUNTIME_EXTRAS).toEqual({ '@ageniza/database': ['bin', 'migrations'] });
    const runner = ['bin/migrate.mjs', 'migrations/20260915000000_database_foundation.mjs'];
    expect(unexpectedInInternalPackage('@ageniza/database', runner)).toEqual([]);
    expect(unexpectedInInternalPackage('@ageniza/core', runner)).toEqual(runner);
    expect(unexpectedInInternalPackage('@ageniza/email', runner)).toEqual(runner);
  });

  it('still flags a test that hides under the database migrations', () => {
    expect(unexpectedInInternalPackage('@ageniza/database', ['migrations/helper.test.mjs'])).toEqual(['migrations/helper.test.mjs']);
  });
});

describe('the files of the internal packages', () => {
  const filesOf = (name) => JSON.parse(readFileSync(join(repositoryRoot, 'packages', name, 'package.json'), 'utf8')).files;

  it('ship the compiled runtime without compiled tests, by value', () => {
    for (const name of ['config', 'contracts', 'core', 'email']) {
      expect(filesOf(name), name).toEqual(['dist', '!dist/**/*.test.*', '!dist/**/test-support/**']);
    }
  });

  it('ship, for the database, the migration runner and the migrations the migrations image runs', () => {
    expect(filesOf('database')).toEqual(['dist', 'bin', 'migrations', '!dist/**/*.test.*', '!dist/**/test-support/**']);
  });
});

describe('the devDependencies of the workspace', () => {
  it('collects the root and every project of the workspace globs, sorted and without repeats', () => {
    const root = workspace({
      root: { devDependencies: { typescript: '5', vitest: '3' } },
      projects: {
        'apps/api': { devDependencies: { tsx: '4', '@types/pg': '8' }, dependencies: { fastify: '5' } },
        'apps/worker': { devDependencies: { tsx: '4' } },
        'packages/database': { devDependencies: { '@types/pg': '8' } },
        'packages/core': { dependencies: { pino: '10' } }
      }
    });
    expect(devDependenciesOfWorkspace(root)).toEqual(['@types/pg', 'tsx', 'typescript', 'vitest']);
  });

  it('skips a folder of the globs that is not a project', () => {
    const root = workspace({ projects: { 'apps/api': { devDependencies: { tsx: '4' } } } });
    mkdirSync(join(root, 'apps', 'scratch'));
    expect(devDependenciesOfWorkspace(root)).toEqual(['tsx']);
  });

  it('reads the devDependencies of this repository, project by project', () => {
    const found = devDependenciesOfWorkspace(repositoryRoot);
    for (const name of ['typescript', 'vitest', 'eslint', 'tsx', '@asteasolutions/zod-to-openapi', '@scalar/fastify-api-reference', '@types/pg', '@types/nodemailer', 'jsdom', '@testing-library/react']) {
      expect(found, name).toContain(name);
    }
    for (const name of ['fastify', 'better-auth', 'pg', 'zod', 'knex', 'pino']) {
      expect(found, name).not.toContain(name);
    }
  });

  it('refuses a workspace folder that is not there instead of reading a workspace with no projects', () => {
    const root = workspace();
    rmSync(join(root, 'packages'), { recursive: true });
    expect(() => devDependenciesOfWorkspace(root)).toThrow();
  });

  it('refuses a workspace pattern it cannot read instead of ignoring the projects it names', () => {
    expect(() => devDependenciesOfWorkspace(workspace({ globs: ['apps/**'] }))).toThrow('cannot read');
  });

  it('adds them to the test tooling chain that no devDependency names', () => {
    const root = workspace({ projects: { 'apps/api': { devDependencies: { tsx: '4' } } } });
    expect(forbiddenForWorkspace(root)).toEqual([...FORBIDDEN_IN_API_PRODUCTION, 'tsx'].sort());
  });
});

const SCALAR = '@scalar/fastify-api-reference';

describe('the direct dependencies of the API (issue #517)', () => {
  it('are allowed by value, from a literal list rather than the one the script exports', () => {
    expect([...API_RUNTIME_DEPENDENCIES].sort()).toEqual([
      '@ageniza/config', '@ageniza/contracts', '@ageniza/core', '@ageniza/database', '@ageniza/email',
      '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner',
      '@fastify/cors', '@fastify/helmet', '@fastify/rate-limit',
      'better-auth', 'fastify', 'helmet', 'kysely', 'pg', 'pg-boss', 'zod'
    ]);
  });

  it('are the ones apps/api/package.json declares today, so a new runtime dependency has to be added on purpose', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'apps', 'api', 'package.json'), 'utf8'));
    expect(Object.keys(manifest.dependencies).sort()).toEqual([...API_RUNTIME_DEPENDENCIES].sort());
    expect(unexpectedApiDependencies(manifest)).toEqual([]);
  });

  it('flags a dependency that is not on the list, sorted, and reads optionalDependencies too', () => {
    expect(unexpectedApiDependencies({ dependencies: { zod: '3', tsx: '4', [SCALAR]: '1' }, optionalDependencies: { fsevents: '2' } }))
      .toEqual([SCALAR, 'fsevents', 'tsx']);
  });

  it('accepts a manifest without dependencies', () => {
    expect(unexpectedApiDependencies({})).toEqual([]);
  });
});

describe('checking a deployed API', () => {
  it('accepts a closure that is clean, carries only the runtime and boots', () => {
    expect(checkDeployedApi(deployed(), { boot: bootsFine })).toEqual([]);
  });

  it('fails closed when the deploy has no .pnpm store', () => {
    const failures = checkDeployedApi(deployed({ store: null }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no better-auth to inspect');
  });

  it('fails closed when the store has no better-auth, even with nothing forbidden in it', () => {
    const failures = checkDeployedApi(deployed({ store: ['pg@8.16.3', 'zod@3.25.76'] }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no better-auth to inspect');
  });

  it('fails closed on a store naming it does not recognise, so a pnpm that renames the entries turns the gate red', () => {
    const failures = checkDeployedApi(deployed({ store: ['better-auth+1.7.5', 'vitest+3.2.7'] }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no better-auth to inspect');
  });

  it('names the forbidden packages that reached the deploy', () => {
    const failures = checkDeployedApi(deployed({ store: ['better-auth@1.7.5', 'vitest@3.2.7(jsdom@26.1.0)', '@vitest+expect@3.2.7', 'jsdom@26.1.0'] }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@vitest/expect, jsdom, vitest reached the deployed API');
  });

  it('names a direct dependency of the API that is not on the allowed list', () => {
    const failures = checkDeployedApi(deployed({ manifest: { dependencies: { zod: '3', [SCALAR]: '^1.72.2', tsx: '4' } } }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${SCALAR}, tsx are direct dependencies of the API that are not on the allowed list`);
  });

  it('names a single dependency in the singular', () => {
    const failures = checkDeployedApi(deployed({ manifest: { dependencies: { [SCALAR]: '^1.72.2' } } }), { boot: bootsFine });
    expect(failures[0]).toContain(`${SCALAR} is a direct dependency of the API that is not on the allowed list`);
  });

  it('names an optional dependency too', () => {
    const failures = checkDeployedApi(deployed({ manifest: { optionalDependencies: { fsevents: '2' } } }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('fsevents is a direct dependency');
  });

  it('checks the deployed manifest against the allowed list it is given', () => {
    const root = deployed({ manifest: { dependencies: { zod: '3' } } });
    expect(checkDeployedApi(root, { boot: bootsFine, allowedDependencies: [] })).toHaveLength(1);
    expect(checkDeployedApi(root, { boot: bootsFine })).toEqual([]);
  });

  it('fails when the deploy carries source or compiled tests', () => {
    const failures = checkDeployedApi(deployed({ files: [...CLEAN_FILES, 'src/app.ts', 'dist/app.test.js', 'dist/modules/auth/test-support/harness.js'] }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('3 file(s) the runtime does not read');
    expect(failures[0]).toContain('dist/app.test.js');
  });

  it('names a development tool the caller derived from the workspace, which the test chain alone does not know', () => {
    const store = ['better-auth@1.7.5', 'tsx@4.19.3', 'esbuild@0.25.0'];
    expect(checkDeployedApi(deployed({ store }), { boot: bootsFine })).toEqual([]);
    const failures = checkDeployedApi(deployed({ store }), { boot: bootsFine, forbidden: [...FORBIDDEN_IN_API_PRODUCTION, 'tsx'] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tsx reached the deployed API');
  });

  it('fails when an @ageniza/* package carries its source, its tests or its build cache', () => {
    const internal = {
      ...CLEAN_INTERNAL,
      config: [...CLEAN_INTERNAL.config, 'src/server.ts', '.turbo/turbo-build.log'],
      database: [...CLEAN_INTERNAL.database, 'test/postgres.integration.test.ts']
    };
    const failures = checkDeployedApi(deployed({ internal }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('3 file(s) of @ageniza/* the runtime does not read');
    expect(failures[0]).toContain('@ageniza/config/.turbo/turbo-build.log, @ageniza/config/src/server.ts, @ageniza/database/test/postgres.integration.test.ts');
  });

  it('fails when the compiled tests of an @ageniza/* package reach dist', () => {
    const internal = { ...CLEAN_INTERNAL, core: [...CLEAN_INTERNAL.core, 'dist/logging.test.js', 'dist/test-support/clock.js'] };
    const failures = checkDeployedApi(deployed({ internal }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@ageniza/core/dist/logging.test.js, @ageniza/core/dist/test-support/clock.js');
  });

  it('accepts the migration runner and the migrations in the database package and nowhere else', () => {
    expect(checkDeployedApi(deployed(), { boot: bootsFine })).toEqual([]);
    const internal = { ...CLEAN_INTERNAL, email: [...CLEAN_INTERNAL.email, 'bin/migrate.mjs'] };
    const failures = checkDeployedApi(deployed({ internal }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@ageniza/email/bin/migrate.mjs');
  });

  it('fails when an @ageniza/* package the API declares is not in the store, so a renamed entry is not a pass', () => {
    const root = deployed();
    const store = join(root, 'node_modules', '.pnpm');
    rmSync(join(store, '@ageniza+contracts@file+packages+contracts'), { recursive: true });
    mkdirSync(join(store, '@ageniza+contracts+file+packages+contracts', 'node_modules', '@ageniza', 'contracts', 'src'), { recursive: true });
    const failures = checkDeployedApi(root, { boot: bootsFine });
    expect(failures).toEqual(['the deploy has no @ageniza/contracts to inspect, and the API declares it.']);
  });

  it('inspects every store entry of a package the store holds twice, as pnpm does when peers differ', () => {
    const root = deployed();
    write(root, 'node_modules/.pnpm/@ageniza+core@file+packages+core_pino@10.0.0/node_modules/@ageniza/core/src/index.ts');
    const failures = checkDeployedApi(root, { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@ageniza/core/src/index.ts');
  });

  it('fails when the boot modules do not load, with the reason', () => {
    const failures = checkDeployedApi(deployed(), { boot: () => "Cannot find package 'pg'" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("do not load in the deploy: Cannot find package 'pg'");
  });

  it('says the API has to be built first when nothing loads, which is what a gate run before the build looks like', () => {
    const failures = checkDeployedApi(deployed({ files: ['package.json'] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('do not load in the deploy');
    expect(failures[0]).toContain('pnpm build');
  });

  it('reports every problem at once', () => {
    const failures = checkDeployedApi(deployed({ store: ['better-auth@1.7.5', 'vitest@3.2.7'], files: [...CLEAN_FILES, 'src/app.ts'] }), { boot: () => 'boom' });
    expect(failures).toHaveLength(3);
  });

  it('hands the deploy directory to the boot step', () => {
    const directory = deployed();
    const boot = vi.fn(() => undefined);
    checkDeployedApi(directory, { boot });
    expect(boot).toHaveBeenCalledWith(directory);
  });
});

describe('booting the deploy', () => {
  const bootable = () => {
    const root = temporaryDirectory();
    write(root, 'package.json', '{"type":"module"}');
    write(root, 'dist/app.js', 'export const buildApp = () => 1;\n');
    write(root, 'dist/server.js', "import { buildApp } from './app.js';\nexport const startApi = () => buildApp();\n");
    write(root, 'dist/cli/agency.js', 'export const runAgencyCli = () => 0;\n');
    write(root, 'dist/cli/email-change.js', 'export const runEmailChangeCli = () => 0;\n');
    return root;
  };

  it('loads the app, the server and the two commands of the runbook from inside the deploy', () => {
    expect(BOOT_MODULES).toEqual(['dist/app.js', 'dist/server.js', 'dist/cli/agency.js', 'dist/cli/email-change.js']);
    expect(bootFromDeploy(bootable())).toBeUndefined();
  });

  it('reports the package the deploy is missing, which is what a closure that dropped a dependency looks like', () => {
    const root = bootable();
    write(root, 'dist/server.js', "import 'a-package-the-closure-lost';\nexport const startApi = () => 1;\n");
    expect(bootFromDeploy(root)).toContain('a-package-the-closure-lost');
  });

  it('reports a boot module that is not there', () => {
    const root = bootable();
    rmSync(join(root, 'dist', 'app.js'));
    expect(bootFromDeploy(root)).toBeTypeOf('string');
  });

  it('reports a command of the runbook that cannot load', () => {
    const root = bootable();
    write(root, 'dist/cli/email-change.js', "import 'a-package-the-closure-lost';\n");
    expect(bootFromDeploy(root)).toContain('a-package-the-closure-lost');
  });

  it('reports a boot module that throws on load', () => {
    const root = bootable();
    write(root, 'dist/app.js', "throw new Error('failed while loading');\n");
    expect(bootFromDeploy(root)).toContain('failed while loading');
  });
});

describe('verifying the API production closure end to end', () => {
  const deployInto = (options) => (target) => populate(target, options);

  it('returns no failure for a clean deploy, and removes the temporary directory', () => {
    let target;
    const failures = verifyApiProductionClosure({
      deploy: (directory) => { target = directory; populate(directory); },
      boot: bootsFine
    });
    expect(failures).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it('fails closed when the deploy leaves no .pnpm store', () => {
    const failures = verifyApiProductionClosure({ deploy: deployInto({ store: null }), boot: bootsFine });
    expect(failures).toEqual(['the deploy has no better-auth to inspect.']);
  });

  it('fails closed when the sentinel is missing from the store', () => {
    const failures = verifyApiProductionClosure({ deploy: deployInto({ store: ['pg@8.16.3'] }), boot: bootsFine });
    expect(failures).toEqual(['the deploy has no better-auth to inspect.']);
  });

  it('fails when a workspace devDependency reached the deploy, which a package moved to dependencies looks like', () => {
    const workspaceRoot = workspace({ projects: { 'apps/worker': { devDependencies: { tsx: '4' } } } });
    const failures = verifyApiProductionClosure({
      deploy: deployInto({ store: ['better-auth@1.7.5', 'tsx@4.19.3'] }),
      boot: bootsFine,
      workspaceRoot
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tsx reached the deployed API');
  });

  it('fails when a devDependency of the API alone was moved to its dependencies, which the list derived from the workspace cannot see', () => {
    const workspaceRoot = workspace({ projects: { 'apps/api': { dependencies: { zod: '3', [SCALAR]: '^1.72.2' } } } });
    expect(forbiddenForWorkspace(workspaceRoot)).not.toContain(SCALAR);
    const failures = verifyApiProductionClosure({
      deploy: deployInto({ store: ['better-auth@1.7.5', `@scalar+fastify-api-reference@1.72.2`], manifest: { dependencies: { zod: '3', [SCALAR]: '^1.72.2' } } }),
      boot: bootsFine,
      workspaceRoot
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${SCALAR} is a direct dependency of the API that is not on the allowed list`);
  });

  it('takes the list from the workspace it is given, so a package that is no devDependency there is not forbidden', () => {
    const workspaceRoot = workspace({ projects: { 'apps/worker': { devDependencies: { nodemon: '3' } } } });
    const failures = verifyApiProductionClosure({
      deploy: deployInto({ store: ['better-auth@1.7.5', 'tsx@4.19.3'] }),
      boot: bootsFine,
      workspaceRoot
    });
    expect(failures).toEqual([]);
  });

  it('fails when an @ageniza/* package carries its source into the deploy', () => {
    const internal = { ...CLEAN_INTERNAL, email: [...CLEAN_INTERNAL.email, 'src/index.ts'] };
    const failures = verifyApiProductionClosure({ deploy: deployInto({ internal }), boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@ageniza/email/src/index.ts');
  });

  it('removes the temporary directory when the deploy itself fails, and lets the error through', () => {
    let target;
    expect(() => verifyApiProductionClosure({
      deploy: (directory) => { target = directory; throw new Error('pnpm deploy failed'); },
      boot: bootsFine
    })).toThrow('pnpm deploy failed');
    expect(existsSync(target)).toBe(false);
  });
});

describe('the command', () => {
  const run = (options) => {
    const previous = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      main(options);
      return { exitCode: process.exitCode, error: error.mock.calls.flat().join('\n'), log: log.mock.calls.flat().join('\n') };
    } finally {
      process.exitCode = previous;
    }
  };

  it('exits non-zero when the sentinel is missing', () => {
    const result = run({ deploy: (target) => populate(target, { store: ['pg@8.16.3'] }), boot: bootsFine });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('API production closure check failed: the deploy has no better-auth to inspect.');
  });

  it('exits non-zero when the .pnpm store is missing', () => {
    const result = run({ deploy: (target) => populate(target, { store: null }), boot: bootsFine });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('no better-auth to inspect');
  });

  it('exits non-zero when the deploy does not boot', () => {
    const result = run({ deploy: (target) => populate(target), boot: () => 'Cannot find package' });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('do not load in the deploy');
  });

  it('exits zero and says what it proved for a good deploy', () => {
    const result = run({ deploy: (target) => populate(target), boot: bootsFine });
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toBe('');
    expect(result.log).toContain('boots');
  });
});
