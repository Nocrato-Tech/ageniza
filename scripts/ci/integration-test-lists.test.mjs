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
