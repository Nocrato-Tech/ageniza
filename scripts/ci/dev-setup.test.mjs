import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import webConfig from '../../apps/web/vite.config.ts';

// Issue #697: `pnpm dev` has to come up on a clone whose compiled packages are old or missing. Nothing in the CI starts the dev
// servers, so each piece that makes it work gets a look here.
const root = join(import.meta.dirname, '..', '..');
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('the dev scripts of the API and the worker put tsx watch before its flags (issue #697)', () => {
  it.each(['apps/api', 'apps/worker'])('%s runs `tsx watch` first, so the flags are not read as the script file', (app) => {
    const dev = readJson(`${app}/package.json`).scripts.dev;
    expect(dev).toMatch(/^tsx watch --env-file=\S+ --env-file=\S+ src\/index\.ts$/);
  });
});

describe('the turbo dev task builds the internal packages first (issue #697)', () => {
  it('depends on the build of the dependencies, as the build task does', () => {
    const { tasks } = readJson('turbo.json');
    expect(tasks.dev.dependsOn).toEqual(['^build']);
    expect(tasks.dev.persistent).toBe(true);
  });
});

describe('the web reads the design system from its source only in the dev server (issue #697)', () => {
  const ui = join(root, 'packages', 'ui', 'src', 'index.tsx');

  it('aliases @ageniza/ui to packages/ui/src when serving in development', () => {
    const config = webConfig({ command: 'serve', mode: 'development' });
    expect(config.resolve.alias).toEqual({ '@ageniza/ui': ui });
    // The alias is only useful while it points at a file: moving the entry would leave both sides equal and the server broken.
    expect(existsSync(ui)).toBe(true);
  });

  it.each([
    ['the production build', { command: 'build', mode: 'production' }],
    ['a build made in development mode', { command: 'build', mode: 'development' }],
    ['the test run, which serves in test mode', { command: 'serve', mode: 'test' }]
  ])('keeps the compiled package for %s', (_name, env) => {
    expect(webConfig(env).resolve).toEqual({});
  });
});
