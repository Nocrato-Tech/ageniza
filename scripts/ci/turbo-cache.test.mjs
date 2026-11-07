import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readCiWorkflow } from './ci-workflow.mjs';

const root = join(import.meta.dirname, '..', '..');
const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));

// CI replays build, typecheck and lint when their inputs did not change. A test that is replayed is a test that did not run.
describe('turbo caches only tasks whose output is fixed by their inputs', () => {
  it('never caches the test task, so a suite always runs', () => {
    expect(turbo.tasks.test.cache).toBe(false);
  });

  it('does not override the test task for any package in a way that turns the cache back on', () => {
    const overrides = Object.entries(turbo.tasks).filter(([id]) => /#test$/.test(id));
    for (const [id, task] of overrides) expect(task.cache, id).toBe(false);
  });

  it('declares the root files that change the output of every task as global dependencies', () => {
    for (const file of ['pnpm-lock.yaml', 'tsconfig.base.json', 'eslint.config.mjs', '.nvmrc']) expect(turbo.globalDependencies, file).toContain(file);
  });

  it('declares the docs the web build bundles from outside its package', () => {
    const inputs = turbo.tasks['@ageniza/web#build']?.inputs ?? [];
    expect(inputs).toContain('$TURBO_DEFAULT$');
    expect(inputs).toContain('$TURBO_ROOT$/docs/api/openapi.json');
    expect(inputs).toContain('$TURBO_ROOT$/docs/mobile/**');
  });
});

// A pull request writes to the cache scope of its own ref, which its next commit restores first: whatever commit A
// leaves in .turbo/cache, commit B would replay as a green gate. Only a push to develop saves.
describe('only a push to develop writes the turbo cache', () => {
  const workflow = readCiWorkflow();
  const steps = workflow.split(/\n {6}- /).slice(1);
  const touchesTurboCache = (step) => /path: \.turbo\/cache/.test(step) || /find \.turbo\/cache/.test(step);

  it('has the save step and the clean-up step, each only for a push', () => {
    const save = steps.filter((step) => /uses: actions\/cache\/save@/.test(step) && touchesTurboCache(step));
    const drop = steps.filter((step) => /find \.turbo\/cache/.test(step));
    expect(save).toHaveLength(1);
    expect(drop).toHaveLength(1);
    for (const step of [...save, ...drop]) expect(step).toMatch(/^ {8}if: github\.event_name == 'push'$/m);
  });

  it('does not use the combined cache action, which saves in its post step, for the turbo cache', () => {
    const combined = steps.filter((step) => /uses: actions\/cache@/.test(step) && touchesTurboCache(step));
    expect(combined).toEqual([]);
  });

  it('restores the turbo cache everywhere with restore-only', () => {
    const restores = steps.filter((step) => /uses: actions\/cache\/restore@/.test(step) && touchesTurboCache(step));
    expect(restores.length).toBeGreaterThanOrEqual(4);
  });
});
