import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME,
  APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE,
  approvalDeadlineNotificationsJob
} from './notifications-deadline-job.js';

const SQL = 'select app_private.notify_approval_deadlines_passed() as notified';
const NOTIFIED_MESSAGE = 'Notified the approvals whose deadline passed';

// The fake answers as the driver does: `{ rows }` with the integer the function returns, and an error carrying the SQLSTATE in `code`.
const databaseAnswering = (answer: () => Promise<unknown>) => {
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    if (sql === SQL) return answer();
    throw new Error(`unexpected statement: ${sql} ${JSON.stringify(bindings)}`);
  });
  const transaction = vi.fn();
  const database = { knex: { raw }, transaction } as unknown as DatabaseClient;
  return { database, raw, transaction };
};

const sqlError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

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

const run = async (definition: ReturnType<typeof approvalDeadlineNotificationsJob>, logger: ReturnType<typeof createLogger>): Promise<void> => {
  await definition.handler(
    { id: 'job-1', name: APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME, payload: {}, attempt: 1 },
    { logger, signal: new AbortController().signal }
  );
};

describe('notifications.approval-deadline-passed', () => {
  it('is named and scheduled as decided: five past every hour, and once at every start', () => {
    const definition = approvalDeadlineNotificationsJob(databaseAnswering(async () => ({ rows: [{ notified: 0 }] })));
    expect(definition.name).toBe('notifications.approval-deadline-passed');
    expect(definition.schedule).toEqual({ cron: '5 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE).toEqual({ cron: '5 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('calls the function once, straight on the client with no binding and no transaction of an actor, and logs only how many it notified', async () => {
    const { database, raw, transaction } = databaseAnswering(async () => ({ rows: [{ notified: 3 }] }));
    const captured = captureLogger();

    await run(approvalDeadlineNotificationsJob({ database }), captured.logger);

    expect(raw.mock.calls).toEqual([[SQL, []]]);
    // An authenticated transaction would bind an actor first, and the function refuses to run for one.
    expect(transaction).not.toHaveBeenCalled();
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ notified: 3, msg: NOTIFIED_MESSAGE })]);
    expect(Object.keys(records[0]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'notified'].includes(key))).toEqual([]);
  });

  it('logs zero when nobody is due', async () => {
    const captured = captureLogger();

    await run(approvalDeadlineNotificationsJob(databaseAnswering(async () => ({ rows: [{ notified: 0 }] }))), captured.logger);

    expect(await captured.records()).toEqual([expect.objectContaining({ notified: 0, msg: NOTIFIED_MESSAGE })]);
  });

  it.each([
    ['deadlock', sqlError('40P01', 'deadlock detected')],
    ['serialization failure', sqlError('40001', 'could not serialize access')]
  ])('leaves the deadlines to the next run when it loses a race (%s), without failing the run or logging the detail', async (_name, error) => {
    const captured = captureLogger();

    await expect(run(approvalDeadlineNotificationsJob(databaseAnswering(async () => { throw error; })), captured.logger)).resolves.toBeUndefined();

    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ level: 40, msg: 'Approval deadlines left for the next run after losing a race' })]);
    expect(JSON.stringify(records)).not.toMatch(/deadlock detected|could not serialize|40P01|40001/);
  });

  it.each([
    ['an actor was bound', sqlError('42501', 'The approval deadlines are notified by the worker, not by a request.')],
    ['the connection dropped', sqlError('57P01', 'terminating connection due to administrator command')]
  ])('lets any other failure through (%s), so the queue retries the run and the failure is not hidden as a lost race', async (_name, error) => {
    const captured = captureLogger();

    await expect(run(approvalDeadlineNotificationsJob(databaseAnswering(async () => { throw error; })), captured.logger)).rejects.toBe(error);
    expect(await captured.records()).toEqual([]);
  });

  it.each([[{ rows: [] }], [{ rows: [{ notified: null }] }], [{ rows: [{ notified: '2' }] }], [{ rows: [{ notified: 1.5 }] }]])(
    'refuses an answer that is not an integer, %j, instead of reporting it',
    async (answer) => {
      const captured = captureLogger();
      await expect(run(approvalDeadlineNotificationsJob(databaseAnswering(async () => answer)), captured.logger)).rejects.toThrow('did not return how many it notified');
      expect(await captured.records()).toEqual([]);
    }
  );
});
