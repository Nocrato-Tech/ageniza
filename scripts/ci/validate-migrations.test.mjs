import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { latestVersion, outOfOrder } from './validate-migrations.mjs';

const script = join(import.meta.dirname, 'validate-migrations.mjs');
const dir = 'packages/database/migrations';
const repos = [];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

// A real repository: the script reads the base and head through git, so a fake would answer what the code should compute.
const pullRequest = ({ onBase, afterBranch = [], added = [], edited = [] }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-migrations-'));
  repos.push(cwd);
  git(cwd, 'init', '-q', '-b', 'develop');
  mkdirSync(join(cwd, dir), { recursive: true });
  const write = (name, content = 'export const up = 1;\n') => writeFileSync(join(cwd, dir, name), content);
  const commit = (message) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '--allow-empty', '-m', message); };

  onBase.forEach((name) => write(name));
  commit('base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  added.forEach((name) => write(name));
  edited.forEach((name) => write(name, 'export const up = 2;\n'));
  commit('feature');
  git(cwd, 'checkout', '-q', 'develop');
  afterBranch.forEach((name) => write(name));
  if (afterBranch.length > 0) commit('merged meanwhile');

  const result = spawnSync('node', [script, '--base', 'develop', '--head', 'feature'], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

afterEach(() => {
  while (repos.length > 0) rmSync(repos.pop(), { recursive: true, force: true });
});

const OLD = '20261020000000_old.mjs';
const LATEST = '20261027010100_latest.mjs';

describe('the version of a new migration comes after the newest one on the base', () => {
  it('accepts a new migration newer than the base', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], added: ['20261028000000_new.mjs'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Accepted new versioned migration');
  });

  it('refuses a new migration older than the newest on the base, even when it is newer than others', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], added: ['20261026000000_late.mjs'] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('20261026000000_late.mjs');
    expect(result.stderr).toContain('20261027010100');
    expect(result.stderr).toContain('git mv');
    expect(result.stderr).toContain('not on the base');
  });

  it('refuses a new migration with the same version as the newest on the base', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], added: ['20261027010100_same.mjs'] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('20261027010100_same.mjs');
  });

  it('accepts two new migrations that are both newer than the base', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], added: ['20261028000000_a.mjs', '20261028000100_b.mjs'] });
    expect(result.status).toBe(0);
  });

  it('refuses only the new migration that is late when the pull request adds two', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], added: ['20261028000000_ok.mjs', '20261025000000_late.mjs'] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('20261025000000_late.mjs');
    expect(result.stderr).not.toContain('20261028000000_ok.mjs');
    expect(result.stdout).toContain('20261028000000_ok.mjs');
  });

  it('passes a pull request with no migration', () => {
    const result = pullRequest({ onBase: [OLD, LATEST] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No migration changes found');
  });

  it('counts a migration merged into the base after the branch was cut', () => {
    const result = pullRequest({ onBase: [OLD], added: ['20261026000000_mine.mjs'], afterBranch: ['20261027000000_merged_since.mjs'] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('20261027000000');
  });

  it('does not loosen the immutability of an existing migration', () => {
    const result = pullRequest({ onBase: [OLD, LATEST], edited: [OLD] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Existing migrations are immutable');
  });
});

describe('version comparison', () => {
  it('finds the newest version, whatever the order of the names', () => {
    expect(latestVersion([LATEST, OLD])).toBe(20261027010100n);
    expect(latestVersion(['99999999_short.mjs', LATEST])).toBe(20261027010100n);
    expect(latestVersion([])).toBeUndefined();
  });

  it('compares versions as numbers, not as text', () => {
    expect(outOfOrder(['20261027010100_a.mjs'], ['20261027010101_b.mjs'])).toEqual(['20261027010100_a.mjs']);
    expect(outOfOrder(['20261027010102_a.mjs'], ['20261027010101_b.mjs'])).toEqual([]);
    expect(outOfOrder(['20261027_short.mjs'], ['20261027010101_b.mjs'])).toEqual(['20261027_short.mjs']);
  });
});
