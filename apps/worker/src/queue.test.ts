import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { getConstructionPlans, type JobWithMetadata } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { createDurableQueue, deadLetterQueueName, QUEUE_SCHEMA, runDurableJob } from './queue.js';

interface QueueMigration {
  readonly pgBossSchemaVersion?: number;
  readonly pgBossConstructionSql?: string;
}

const migrationsDirectory = new URL('../../../packages/database/migrations/', import.meta.url);
const installedPgBoss = createRequire(import.meta.url)('pg-boss/package.json') as { version: string; pgboss: { schema: number } };

/** Loads every migration that declares a pg-boss schema version. */
const loadQueueMigrations = async (): Promise<Array<QueueMigration & { file: string }>> => {
  const files = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.mjs')).sort();
  const migrations = await Promise.all(files.map(async (file) => ({
    file,
    ...((await import(new URL(file, migrationsDirectory).href)) as QueueMigration)
  })));
  return migrations.filter((migration) => migration.pgBossSchemaVersion !== undefined);
};

const withoutOuterTransaction = (sql: string): string => {
  const lines = sql.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  let last = lines.length - 1;
  while (last >= 0 && lines[last]?.trim() === '') last -= 1;
  expect(lines[first]?.trim()).toBe('BEGIN;');
  expect(lines[last]?.trim()).toBe('COMMIT;');
  return lines.slice(first + 1, last).join('\n');
};

const createCapturedLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async records(): Promise<Array<Record<string, unknown>>> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text: () => output.join('')
  };
};

const job = (overrides: Partial<JobWithMetadata<{ assetId: string }>> = {}): JobWithMetadata<{ assetId: string }> => ({
  id: 'job-1',
  name: 'media.thumbnail',
  data: { assetId: 'payload-value-not-logged' },
  retryCount: 0,
  retryLimit: 2,
  signal: new AbortController().signal,
  ...overrides
}) as JobWithMetadata<{ assetId: string }>;

describe('queue schema migration', () => {
  it('creates the pg-boss schema version the installed package expects', async () => {
    const versions = (await loadQueueMigrations()).map((migration) => migration.pgBossSchemaVersion ?? 0);
    expect(
      Math.max(...versions),
      `pg-boss ${installedPgBoss.version} expects schema ${installedPgBoss.pgboss.schema}; add a migration built from getMigrationPlans`
    ).toBe(installedPgBoss.pgboss.schema);
  });

  it('froze the construction SQL of the pg-boss version that authored it', async () => {
    const [construction] = await loadQueueMigrations();
    expect(construction?.pgBossConstructionSql).toBeDefined();
    // Provenance only holds while that version is installed; after an upgrade, the test above takes over.
    if (construction?.pgBossSchemaVersion !== installedPgBoss.pgboss.schema) return;
    expect(construction.pgBossConstructionSql).toBe(withoutOuterTransaction(getConstructionPlans(QUEUE_SCHEMA)));
  });
});

describe('durable job execution', () => {
  it('passes the payload with a 1-based attempt and logs completion without the payload', async () => {
    const captured = createCapturedLogger();
    const seen: Array<{ payload: object; attempt: number }> = [];
    await runDurableJob(
      { name: 'media.thumbnail', handler: async (received) => { seen.push({ payload: received.payload, attempt: received.attempt }); } },
      job({ retryCount: 1 }),
      captured.logger
    );
    expect(seen).toEqual([{ payload: { assetId: 'payload-value-not-logged' }, attempt: 2 }]);
    expect(await captured.records()).toContainEqual(expect.objectContaining({
      msg: 'Durable job completed', queue: 'media.thumbnail', jobId: 'job-1', attempt: 2, status: 'completed'
    }));
    expect(captured.text()).not.toContain('payload-value-not-logged');
  });

  it('logs a retry without the payload or error message and rethrows so the queue retries', async () => {
    const captured = createCapturedLogger();
    await expect(runDurableJob(
      { name: 'media.thumbnail', handler: async () => { throw new Error('token=secret-in-error-message'); } },
      job(),
      captured.logger
    )).rejects.toThrow('secret-in-error-message');
    expect(await captured.records()).toContainEqual(expect.objectContaining({ msg: 'Durable job failed and will be retried', status: 'retrying', attempt: 1 }));
    expect(captured.text()).not.toContain('secret-in-error-message');
    expect(captured.text()).not.toContain('payload-value-not-logged');
  });

  it('reports the last attempt as a permanent failure', async () => {
    const captured = createCapturedLogger();
    await expect(runDurableJob(
      { name: 'media.thumbnail', handler: async () => { throw new Error('corrupt'); } },
      job({ retryCount: 2, retryLimit: 2 }),
      captured.logger
    )).rejects.toThrow('corrupt');
    expect(await captured.records()).toContainEqual(expect.objectContaining({ msg: 'Durable job failed permanently', status: 'failed', attempt: 3 }));
  });
});

describe('durable queue registration', () => {
  const queue = () => createDurableQueue({
    connectionString: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
    logger: createLogger({ enabled: false }),
    concurrency: 1
  });

  it('refuses a job type that could not be retried after a deploy interrupts it', () => {
    expect(() => queue().register({ name: 'media.thumbnail', retryLimit: 0, handler: async () => undefined })).toThrow('retryLimit of at least 1');
  });

  it('refuses to register the same job type twice', () => {
    const durable = queue();
    durable.register({ name: 'media.thumbnail', handler: async () => undefined });
    expect(() => durable.register({ name: 'media.thumbnail', handler: async () => undefined })).toThrow('already registered');
  });

  it('names the dead letter queue after its source queue', () => {
    expect(deadLetterQueueName('media.thumbnail')).toBe('media.thumbnail.dead');
  });
});
