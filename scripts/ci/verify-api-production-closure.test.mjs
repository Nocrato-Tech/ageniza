import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BOOT_MODULES,
  FORBIDDEN_IN_API_PRODUCTION,
  bootFromDeploy,
  checkDeployedApi,
  forbiddenPackagesIn,
  main,
  packageNameFromStoreEntry,
  unexpectedInDeploy,
  verifyApiProductionClosure
} from './verify-api-production-closure.mjs';

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

/** A deploy as `pnpm deploy --prod` lays it out: `store` is the entries of node_modules/.pnpm, `null` meaning no store at all. */
const populate = (root, { store = ['better-auth@1.7.5', 'pg@8.16.3'], files = CLEAN_FILES } = {}) => {
  if (store !== null) {
    mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
    for (const entry of store) mkdirSync(join(root, 'node_modules', '.pnpm', entry));
  }
  for (const file of files) write(root, file);
  return root;
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

  it('fails when the deploy carries source or compiled tests', () => {
    const failures = checkDeployedApi(deployed({ files: [...CLEAN_FILES, 'src/app.ts', 'dist/app.test.js', 'dist/modules/auth/test-support/harness.js'] }), { boot: bootsFine });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('3 file(s) the runtime does not read');
    expect(failures[0]).toContain('dist/app.test.js');
  });

  it('fails when the boot modules do not load, with the reason', () => {
    const failures = checkDeployedApi(deployed(), { boot: () => "Cannot find package 'pg'" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("do not load in the deploy: Cannot find package 'pg'");
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
