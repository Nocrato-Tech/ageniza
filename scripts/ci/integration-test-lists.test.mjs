import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// An integration file that is not in the test:integration script of its package never runs in CI: PR #596 found two in
// apps/api that were missing (issue #597). The packages below spell out the files in their script, so every
// *.integration.test.ts on disk must be listed there, and every listed file must exist. apps/worker filters by a
// pattern instead of a list, so the check there is that the pattern matches every integration file.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const INTEGRATION = /\.integration\.test\.ts$/;

const trackedIntegrationFiles = (pkgDir) =>
  git(['ls-files', '--', pkgDir])
    .split('\n')
    .filter((path) => INTEGRATION.test(path))
    .map((path) => path.slice(pkgDir.length + 1));

const integrationScript = (pkgDir) =>
  JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8')).scripts['test:integration'];

const scriptTokens = (script) => script.split(/\s+/).filter((token) => token !== '');

const listedFiles = (script) => scriptTokens(script).filter((token) => INTEGRATION.test(token));

const listedPackages = ['apps/api', 'packages/database'];

describe('test:integration lists the integration files of each package', () => {
  it('finds integration files in apps/api, so the checks below are not empty', () => {
    expect(trackedIntegrationFiles('apps/api')).toContain('src/modules/media/media-download-url.integration.test.ts');
  });

  for (const pkgDir of listedPackages) {
    it(`${pkgDir}: every integration file is in the test:integration script (issue #597)`, () => {
      const listed = listedFiles(integrationScript(pkgDir));
      const missing = trackedIntegrationFiles(pkgDir).filter((file) => !listed.includes(file));

      expect(
        missing,
        `fora da lista do test:integration de ${pkgDir}/package.json: ${missing.join(', ')}. Acrescente cada um ao script, senão o CI nunca roda.`,
      ).toEqual([]);
    });

    it(`${pkgDir}: every file named in the test:integration script exists`, () => {
      const listed = listedFiles(integrationScript(pkgDir));
      const absent = listed.filter((file) => !existsSync(join(root, pkgDir, file)));

      expect(
        absent,
        `citados no test:integration de ${pkgDir}/package.json e inexistentes: ${absent.join(', ')}. Remova ou corrija o caminho.`,
      ).toEqual([]);
    });
  }

  it('apps/worker: the test:integration pattern matches every integration file (it takes a pattern, not a list)', () => {
    const script = integrationScript('apps/worker');
    const patterns = scriptTokens(script).slice(scriptTokens(script).indexOf('run') + 1).filter((token) => !token.startsWith('-'));
    const unmatched = trackedIntegrationFiles('apps/worker').filter((file) => !patterns.some((pattern) => file.includes(pattern)));

    expect(patterns.length, 'o script do worker precisa de um padrão de arquivo').toBeGreaterThan(0);
    expect(
      unmatched,
      `o padrão "${patterns.join(' ')}" do test:integration do worker não pega: ${unmatched.join(', ')}`,
    ).toEqual([]);
  });
});

// The API and the worker import @ageniza/contracts through its dist, and `pnpm --filter <pkg> test:integration` does not
// rebuild it. A dist from another commit then fails the suite with undefined values (issue #609). A package that depends
// on the workspace must run the turbo build of its dependencies in a `pre` hook, with that exact command; a package
// without workspace dependencies (packages/database) builds itself inside its script with `pnpm build &&`. The packages
// are found by git, so a new package with test:integration is checked too.
const readPackage = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));

const testIntegrationPackages = () =>
  git(['ls-files', '*/package.json'])
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => path.slice(0, -'/package.json'.length))
    .filter((dir) => readPackage(dir).scripts?.['test:integration'] !== undefined);

const workspaceDependencies = (pkg) =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([, version]) => String(version).startsWith('workspace:'))
    .map(([name]) => name);

describe('test:integration rebuilds the workspace dependencies before it runs (issue #609)', () => {
  const discovered = testIntegrationPackages();

  it('finds the packages with test:integration, so the checks below are not empty', () => {
    expect(discovered).toEqual(expect.arrayContaining(['apps/api', 'apps/worker', 'packages/database']));
  });

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
