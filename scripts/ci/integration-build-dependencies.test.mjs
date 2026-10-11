import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The API and the worker import @ageniza/contracts through its dist, and `pnpm --filter <pkg> test:integration` does not
// rebuild it. A dist left by another commit then makes the suite fail with values that are undefined (issue #609). The
// scripts below must rebuild the workspace dependencies first, with the same turbo filter the CI uses, through a `pre`
// hook that pnpm runs before the script.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const packages = [
  { dir: 'apps/api', name: '@ageniza/api' },
  { dir: 'apps/worker', name: '@ageniza/worker' },
];

const readScripts = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts ?? {};

const buildsDependencies = (name) => new RegExp(`turbo run build --filter=${name}\\^\\.\\.\\.(\\s|$)`);

describe('integration and unit scripts rebuild the workspace dependencies before they run (issue #609)', () => {
  it('finds the packages, so the checks below are not empty', () => {
    for (const { dir } of packages) {
      expect(existsSync(join(root, dir, 'package.json')), `${dir}/package.json`).toBe(true);
    }
  });

  for (const { dir, name } of packages) {
    for (const script of ['test', 'test:integration']) {
      it(`${dir}: pre${script} rebuilds the dependencies of ${name}`, () => {
        const hook = readScripts(dir)[`pre${script}`] ?? '';

        expect(
          buildsDependencies(name).test(hook),
          `${dir}/package.json: "pre${script}" precisa rodar "turbo run build --filter=${name}^..." antes de "${script}". Sem isso o dist de @ageniza/contracts pode ser de outro commit.`,
        ).toBe(true);
      });
    }
  }
});
