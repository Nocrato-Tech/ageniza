import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { ARCHIVE_DUE_CLIENTS_JOB_NAME, ARCHIVE_DUE_CLIENTS_SCHEDULE, archiveDueClientsJob } from './archive-due-clients-job.js';

const LIST_SQL = 'select app_private.due_client_ids() as id';
const ARCHIVE_SQL = 'select app_private.archive_due_client(?::uuid) as archived';

// The fake answers as the driver does: `{ rows }`, a boolean for the boolean function, and the error of a lost race
// carrying the SQLSTATE in `code`. It is told which clients are due and what happens to each, and never the count.
const databaseWith = (due: ReadonlyArray<unknown>, archive: (clientId: string) => Promise<unknown> = async () => ({ rows: [{ archived: true }] })) => {
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    if (sql === LIST_SQL) return { rows: due.map((id) => ({ id })) };
    if (sql === ARCHIVE_SQL) return archive(String(bindings[0]));
    throw new Error(`unexpected statement: ${sql}`);
  });
  const database = { knex: { raw } } as unknown as DatabaseClient;
  return { database, raw };
};

const lostRace = (code: string, message: string): Error => Object.assign(new Error(message), { code });

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

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const ARCHIVED_MESSAGE = 'Archived the clients whose contract ended';

describe('clients.archive-due', () => {
  it('is named and scheduled as decided: ten past every hour in Brasília, which includes 00:10, and once at every start', () => {
    const definition = archiveDueClientsJob(databaseWith([]));
    expect(definition.name).toBe('clients.archive-due');
    expect(definition.schedule).toEqual({ cron: '10 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(ARCHIVE_DUE_CLIENTS_SCHEDULE).toEqual({ cron: '10 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('lists who is due, archives each client in a call of its own, in order, and logs only how many it archived', async () => {
    const { database, raw } = databaseWith([A, B, C]);
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(raw.mock.calls).toEqual([
      [LIST_SQL, []],
      [ARCHIVE_SQL, [A]],
      [ARCHIVE_SQL, [B]],
      [ARCHIVE_SQL, [C]]
    ]);
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ archived: 3, msg: ARCHIVED_MESSAGE })]);
    expect(Object.keys(records[0]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'archived'].includes(key))).toEqual([]);
  });

  it('counts only the clients the database says it archived: one reactivated or archived by the route meanwhile is not', async () => {
    const { database } = databaseWith([A, B], async (clientId) => ({ rows: [{ archived: clientId === A }] }));
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(await captured.records()).toEqual([expect.objectContaining({ archived: 1, msg: ARCHIVED_MESSAGE })]);
  });

  it('archives nothing and calls no archive when nobody is due', async () => {
    const { database, raw } = databaseWith([]);
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(raw.mock.calls).toEqual([[LIST_SQL, []]]);
    expect(await captured.records()).toEqual([expect.objectContaining({ archived: 0, msg: ARCHIVED_MESSAGE })]);
  });

  it.each([
    ['deadlock', lostRace('40P01', 'deadlock detected')],
    ['serialization failure', lostRace('40001', 'could not serialize access')]
  ])('leaves the client that lost a race (%s) for the next run, archives the others, and logs its id and nothing else', async (_name, error) => {
    const { database, raw } = databaseWith([A, B, C], async (clientId) => {
      if (clientId === B) throw error;
      return { rows: [{ archived: true }] };
    });
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(raw.mock.calls.filter(([sql]) => sql === ARCHIVE_SQL).map(([, bindings]) => bindings)).toEqual([[A], [B], [C]]);
    const records = await captured.records();
    expect(records).toEqual([
      expect.objectContaining({ archived: 2, msg: ARCHIVED_MESSAGE }),
      expect.objectContaining({ level: 40, leftForNextRun: 1, clientIds: [B], msg: 'Clients left for the next run after losing a race' })
    ]);
    expect(JSON.stringify(records)).not.toMatch(/deadlock detected|could not serialize|40P01|40001/);
    expect(Object.keys(records[1]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'leftForNextRun', 'clientIds'].includes(key))).toEqual([]);
  });

  it('completes the run when every client loses its race, with none archived and all of them logged', async () => {
    const { database } = databaseWith([A, B], async () => { throw lostRace('40P01', 'deadlock detected'); });
    const captured = captureLogger();

    await run(archiveDueClientsJob({ database }), captured.logger);

    expect(await captured.records()).toEqual([
      expect.objectContaining({ archived: 0, msg: ARCHIVED_MESSAGE }),
      expect.objectContaining({ leftForNextRun: 2, clientIds: [A, B] })
    ]);
  });

  it('lets any other database failure through, so the queue retries the run, without archiving the clients after it or logging of its own', async () => {
    const { database, raw } = databaseWith([A, B, C], async (clientId) => {
      if (clientId === B) throw lostRace('42501', 'permission denied for function archive_due_client');
      return { rows: [{ archived: true }] };
    });
    const captured = captureLogger();

    await expect(run(archiveDueClientsJob({ database }), captured.logger)).rejects.toMatchObject({ code: '42501' });
    expect(raw.mock.calls.filter(([sql]) => sql === ARCHIVE_SQL).map(([, bindings]) => bindings)).toEqual([[A], [B]]);
    expect(await captured.records()).toEqual([]);
  });

  it('lets a failure of the list through', async () => {
    const failure = lostRace('57P01', 'terminating connection due to administrator command');
    const raw = vi.fn(async () => { throw failure; });
    const captured = captureLogger();

    await expect(run(archiveDueClientsJob({ database: { knex: { raw } } as unknown as DatabaseClient }), captured.logger)).rejects.toBe(failure);
    expect(await captured.records()).toEqual([]);
  });

  it.each([[null], [42], [undefined]])('refuses a client id that is not text, %j, instead of acting on it', async (id) => {
    const captured = captureLogger();
    await expect(run(archiveDueClientsJob(databaseWith([id])), captured.logger)).rejects.toThrow('did not return client ids');
    expect(await captured.records()).toEqual([]);
  });

  it.each([[{ rows: [] }], [{ rows: [{ archived: null }] }], [{ rows: [{ archived: 1 }] }], [{ rows: [{ archived: 'true' }] }]])(
    'refuses an answer that is not a boolean, %j, instead of reporting it',
    async (answer) => {
      const captured = captureLogger();
      await expect(run(archiveDueClientsJob(databaseWith([A], async () => answer)), captured.logger)).rejects.toThrow('did not return whether it archived');
      expect(await captured.records()).toEqual([]);
    }
  );
});
