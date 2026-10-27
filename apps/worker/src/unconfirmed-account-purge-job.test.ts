import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import {
  UNCONFIRMED_ACCOUNT_PURGE_BATCH_SIZE,
  UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME,
  UNCONFIRMED_ACCOUNT_PURGE_SCHEDULE,
  unconfirmedAccountPurgeJob
} from './unconfirmed-account-purge-job.js';

const PURGE_SQL = 'select app_private.purge_unconfirmed_accounts(pg_catalog.now(), ?::integer) as purged';
const BATCH = UNCONFIRMED_ACCOUNT_PURGE_BATCH_SIZE;
const PURGED_MESSAGE = 'Purged the unconfirmed accounts past their retention';

// The fake answers as the driver does: `{ rows }` with the integer of the function, and the error of a lost race carrying the SQLSTATE
// in `code`. It is told how many accounts each call deletes, and never the count the job should report.
const databaseWith = (answers: ReadonlyArray<unknown>) => {
  const queue = [...answers];
  const raw = vi.fn(async (sql: string) => {
    if (sql !== PURGE_SQL) throw new Error(`unexpected statement: ${sql}`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { rows: [{ purged: next }] };
  });
  return { database: { knex: { raw } } as unknown as DatabaseClient, raw };
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

const run = async (definition: ReturnType<typeof unconfirmedAccountPurgeJob>, logger: ReturnType<typeof createLogger>, signal = new AbortController().signal): Promise<void> => {
  await definition.handler({ id: 'job-1', name: UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME, payload: {}, attempt: 1 }, { logger, signal });
};

const lostRace = (code: string, message: string): Error => Object.assign(new Error(message), { code });

describe('accounts.purge-unconfirmed', () => {
  it('is named and scheduled as decided: 04:10 every day in Brasília, after the media purge, and once at every start', () => {
    const definition = unconfirmedAccountPurgeJob(databaseWith([]));
    expect(definition.name).toBe('accounts.purge-unconfirmed');
    expect(definition.schedule).toEqual({ cron: '10 4 * * *', timeZone: 'America/Sao_Paulo' });
    expect(UNCONFIRMED_ACCOUNT_PURGE_SCHEDULE).toEqual({ cron: '10 4 * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('asks for a batch the database accepts: from 1 to 500 accounts', () => {
    expect(BATCH).toBeGreaterThanOrEqual(1);
    expect(BATCH).toBeLessThanOrEqual(500);
  });

  it('asks the database to purge with its own clock, one batch, and logs only how many it deleted', async () => {
    const { database, raw } = databaseWith([3]);
    const captured = captureLogger();

    await run(unconfirmedAccountPurgeJob({ database }), captured.logger);

    expect(raw.mock.calls).toEqual([[PURGE_SQL, [BATCH]]]);
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ purged: 3, msg: PURGED_MESSAGE })]);
    expect(Object.keys(records[0]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'purged'].includes(key))).toEqual([]);
  });

  it('does nothing more when nothing is due', async () => {
    const { database, raw } = databaseWith([0]);
    const captured = captureLogger();

    await run(unconfirmedAccountPurgeJob({ database }), captured.logger);

    expect(raw).toHaveBeenCalledTimes(1);
    expect(await captured.records()).toEqual([expect.objectContaining({ purged: 0, msg: PURGED_MESSAGE })]);
  });

  it('keeps asking while a batch comes back full and stops at the first one that does not, summing them', async () => {
    const { database, raw } = databaseWith([BATCH, BATCH, 7, 99]);
    const captured = captureLogger();

    await run(unconfirmedAccountPurgeJob({ database }), captured.logger);

    expect(raw).toHaveBeenCalledTimes(3);
    expect(await captured.records()).toEqual([expect.objectContaining({ purged: 2 * BATCH + 7, msg: PURGED_MESSAGE })]);
  });

  it('stops after 100 batches even if every one comes back full', async () => {
    const { database, raw } = databaseWith(Array.from({ length: 150 }, () => BATCH));
    const captured = captureLogger();

    await run(unconfirmedAccountPurgeJob({ database }), captured.logger);

    expect(raw).toHaveBeenCalledTimes(100);
    expect(await captured.records()).toEqual([expect.objectContaining({ purged: 100 * BATCH })]);
  });

  it.each([
    ['deadlock', lostRace('40P01', 'deadlock detected')],
    ['serialization failure', lostRace('40001', 'could not serialize access')]
  ])('ends the run on a lost race (%s), keeps what it deleted before, and logs nothing of the error', async (_name, error) => {
    const { database, raw } = databaseWith([BATCH, error, BATCH]);
    const captured = captureLogger();

    await run(unconfirmedAccountPurgeJob({ database }), captured.logger);

    expect(raw).toHaveBeenCalledTimes(2);
    const records = await captured.records();
    expect(records).toEqual([
      expect.objectContaining({ purged: BATCH, msg: PURGED_MESSAGE }),
      expect.objectContaining({ level: 40, purged: BATCH })
    ]);
    expect(JSON.stringify(records)).not.toMatch(/deadlock detected|could not serialize|40P01|40001/);
  });

  it('lets any other database failure through, so the queue retries the run, without logging of its own', async () => {
    const { database } = databaseWith([lostRace('42501', 'permission denied for function purge_unconfirmed_accounts')]);
    const captured = captureLogger();

    await expect(run(unconfirmedAccountPurgeJob({ database }), captured.logger)).rejects.toMatchObject({ code: '42501' });
    expect(await captured.records()).toEqual([]);
  });

  it.each([[undefined], [null], ['3'], [-1], [1.5]])('refuses an answer that is not a count (%s) instead of reporting it', async (answer) => {
    const { database } = databaseWith([answer]);
    const captured = captureLogger();

    await expect(run(unconfirmedAccountPurgeJob({ database }), captured.logger)).rejects.toThrow('did not return how many it deleted');
    expect(await captured.records()).toEqual([]);
  });

  it('does not start a batch once the worker is stopping', async () => {
    const { database, raw } = databaseWith([BATCH, BATCH]);
    const controller = new AbortController();
    controller.abort();

    await expect(run(unconfirmedAccountPurgeJob({ database }), captureLogger().logger, controller.signal)).rejects.toThrow();
    expect(raw).not.toHaveBeenCalled();
  });
});
