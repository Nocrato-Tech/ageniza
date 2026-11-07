import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const readPackage = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
const INTEGRATION = /\.integration\.test\.ts$/;

const testIntegrationPackages = () =>
  git(['ls-files', '*/package.json'])
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => path.slice(0, -'/package.json'.length))
    .filter((dir) => readPackage(dir).scripts?.['test:integration'] !== undefined);

const discovered = testIntegrationPackages();

// apps/api and packages/database select their integration files with the `include` of their vitest.integration.config.ts,
// and apps/worker with a file pattern: none lists files by hand, so a new `*.integration.test.ts` reaches CI by itself.
describe('test:integration selects the integration files by pattern, not by list', () => {
  it('finds the packages with test:integration, so the checks below are not empty', () => {
    expect(discovered).toEqual(expect.arrayContaining(['apps/api', 'apps/worker', 'packages/database']));
  });

  for (const dir of discovered) {
    it(`${dir}: test:integration names no integration file`, () => {
      const listed = readPackage(dir).scripts['test:integration'].split(/\s+/).filter((token) => INTEGRATION.test(token));

      expect(listed, `${dir}/package.json lista arquivos à mão; use o include do vitest.integration.config.ts`).toEqual([]);
    });
  }

  for (const dir of ['apps/api', 'packages/database']) {
    it(`${dir}: test:integration uses the integration config, whose include takes every *.integration.test.ts`, () => {
      expect(readPackage(dir).scripts['test:integration']).toMatch(/vitest run --config vitest\.integration\.config\.ts$/);
      expect(readFileSync(join(root, dir, 'vitest.integration.config.ts'), 'utf8')).toContain("include: ['**/*.integration.test.ts']");
    });
  }

  it('apps/worker: the test:integration pattern matches every integration file', () => {
    const tokens = readPackage('apps/worker').scripts['test:integration'].split(/\s+/).filter((token) => token !== '');
    const patterns = tokens.slice(tokens.indexOf('run') + 1).filter((token) => !token.startsWith('-'));
    const files = git(['ls-files', '--', 'apps/worker'])
      .split('\n')
      .filter((path) => INTEGRATION.test(path))
      .map((path) => path.slice('apps/worker/'.length));
    const unmatched = files.filter((file) => !patterns.some((pattern) => file.includes(pattern)));

    expect(patterns.length, 'o script do worker precisa de um padrão de arquivo').toBeGreaterThan(0);
    expect(unmatched, `o padrão "${patterns.join(' ')}" não pega: ${unmatched.join(', ')}`).toEqual([]);
  });
});

// The API and the worker import @ageniza/contracts through its dist, and `pnpm --filter <pkg> test:integration` does not
// rebuild it. A dist from another commit then fails the suite with undefined values (issue #609). A package that depends
// on the workspace must run the turbo build of its dependencies in a `pre` hook, with that exact command; a package
// without workspace dependencies (packages/database) builds itself inside its script with `pnpm build &&`. The packages
// are found by git, so a new package with test:integration is checked too.
const workspaceDependencies = (pkg) =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([, version]) => String(version).startsWith('workspace:'))
    .map(([name]) => name);

describe('test:integration rebuilds the workspace dependencies before it runs (issue #609)', () => {
  for (const dir of discovered) {
    const pkg = readPackage(dir);
    const script = pkg.scripts['test:integration'];

    if (workspaceDependencies(pkg).length > 0) {
      it(`${dir}: pretest:integration is the turbo build of ${pkg.name}'s dependencies, and nothing else`, () => {
        expect(pkg.scripts['pretest:integration'], `${dir}/package.json`).toBe(
          `pnpm exec turbo run build --filter=${pkg.name}^...`,
        );
      });
    } else {
      it(`${dir}: test:integration builds the package before it runs (it has no workspace dependencies)`, () => {
        expect(script.startsWith('pnpm build &&'), `${dir}/package.json: "${script.slice(0, 40)}..."`).toBe(true);
      });
    }
  }
});
