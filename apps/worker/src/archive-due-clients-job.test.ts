import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { ARCHIVE_DUE_CLIENTS_JOB_NAME, ARCHIVE_DUE_CLIENTS_SCHEDULE, archiveDueClientsJob } from './archive-due-clients-job.js';

const databaseReturning = (answer: () => Promise<unknown>) => {
  const raw = vi.fn(answer);
  const database = { knex: { raw } } as unknown as DatabaseClient;
  return { database, raw };
};

const captureLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async records(): Promise<Array<Record<string, unknown>>> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
};

const run = async (definition: ReturnType<typeof archiveDueClientsJob>, logger: ReturnType<typeof createLogger>): Promise<void> => {
  await definition.handler(
    { id: 'job-1', name: ARCHIVE_DUE_CLIENTS_JOB_NAME, payload: {}, attempt: 1 },
    { logger, signal: new AbortController().signal }
  );
};

describe('clients.archive-due', () => {
  it('is named and scheduled as decided: ten past every hour in Brasília, which includes 00:10, and once at every start', () => {
    const definition = archiveDueClientsJob(databaseReturning(async () => ({ rows: [{ archived: 0 }] })));
    expect(definition.name).toBe('clients.archive-due');
    expect(definition.schedule).toEqual({ cron: '10 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(ARCHIVE_DUE_CLIENTS_SCHEDULE).toEqual({ cron: '10 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('asks the database function for the work and logs only how many it archived', async () => {
    const { database, raw } = databaseReturning(async () => ({ rows: [{ archived: 3 }] }));
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith('select app_private.archive_due_clients() as archived', []);
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ archived: 3, msg: 'Archived the clients whose contract ended' })]);
    expect(Object.keys(records[0]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'archived'].includes(key))).toEqual([]);
  });

  it('reads the count the database returns as text, as a bigint column would', async () => {
    const captured = captureLogger();
    await run(archiveDueClientsJob(databaseReturning(async () => ({ rows: [{ archived: '0' }] }))), captured.logger);
    expect(await captured.records()).toEqual([expect.objectContaining({ archived: 0 })]);
  });

  it('lets a database failure through, so the queue retries it, and logs nothing of its own', async () => {
    const captured = captureLogger();
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    await expect(run(archiveDueClientsJob(databaseReturning(async () => { throw deadlock; })), captured.logger)).rejects.toBe(deadlock);
    expect(await captured.records()).toEqual([]);
  });

  it.each([[{ rows: [] }], [{ rows: [{ archived: null }] }], [{ rows: [{ archived: -1 }] }], [{ rows: [{ archived: 1.5 }] }], [{ rows: [{ archived: 'many' }] }]])(
    'refuses an answer that is not a count, %j, instead of reporting it',
    async (answer) => {
      const captured = captureLogger();
      await expect(run(archiveDueClientsJob(databaseReturning(async () => answer)), captured.logger)).rejects.toThrow('did not return a count');
      expect(await captured.records()).toEqual([]);
    }
  );
});
