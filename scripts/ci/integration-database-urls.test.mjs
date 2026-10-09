import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #391: an integration harness that reads DATABASE_URL / MIGRATION_DATABASE_URL on its own, or
// carries a URL for `ageniza`, lets a missing variable send a superuser connection to the owner's
// development database. The only way to get the URLs is `resolveIntegrationDatabaseUrls`.
const root = join(import.meta.dirname, '..', '..');
const skipped = new Set(['node_modules', 'dist', '.git', '.turbo', '.local', '.maestri']);

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const isHarnessFile = (path) => {
  const name = relative(root, path).split(sep).join('/');
  return /\.integration\.test\.ts$/.test(name) || /(^|\/)test-support\//.test(name) || /^packages\/[^/]+\/test\/support\//.test(name);
};

const harnessFiles = ['apps', 'packages'].flatMap((directory) => walk(join(root, directory))).filter(isHarnessFile);

describe('integration harnesses obtain their database only from resolveIntegrationDatabaseUrls (issue #391)', () => {
  it('finds the harnesses it is supposed to police', () => {
    const names = harnessFiles.map((path) => relative(root, path).split(sep).join('/'));
    expect(names).toContain('apps/api/src/modules/auth/test-support/harness.ts');
    expect(names).toContain('apps/worker/src/queue.integration.test.ts');
    expect(names).toContain('packages/database/test/postgres.integration.test.ts');
    expect(names).toContain('packages/database/test/support/content-world.ts');
  });

  it('never reads the database variables or carries a default URL', () => {
    const offenders = harnessFiles
      .filter((path) => /process\.env\.(MIGRATION_)?DATABASE_URL|process\.env\[['"](MIGRATION_)?DATABASE_URL|\}\s*=\s*process\.env\b|postgres(ql)?:\/\/[^'"`\s]*\/ageniza['"`\s?]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});

describe('the CI database job runs against a database of its own (issue #391)', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = workflow.slice(workflow.indexOf('\n  database-local:'));
  const jobEnvironment = job.slice(0, job.indexOf('\n    steps:'));

  it('exports both variables at the job level, naming a database other than ageniza', () => {
    const application = /^\s+DATABASE_URL: postgresql:\/\/\S+\/(\w+)$/m.exec(jobEnvironment);
    const owner = /^\s+MIGRATION_DATABASE_URL: postgresql:\/\/\S+\/(\w+)$/m.exec(jobEnvironment);
    expect(application?.[1]).toBeDefined();
    expect(application?.[1]).not.toBe('ageniza');
    expect(owner?.[1]).toBe(application?.[1]);
  });

  it('creates that database before it migrates', () => {
    const name = /^\s+DATABASE_URL: postgresql:\/\/\S+\/(\w+)$/m.exec(jobEnvironment)?.[1];
    const create = job.indexOf(`create database ${name}`);
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(job.indexOf('pnpm db:migrate'));
  });
});
