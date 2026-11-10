import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_REMINDERS_FIRST_HOUR, APPROVAL_REMINDERS_JOB_NAME, APPROVAL_REMINDERS_SCHEDULE, approvalRemindersJob, type ApprovalRemindersJobDependencies } from './approval-reminders-job.js';

const ENQUEUE_SQL = 'select app_private.enqueue_approval_reminders() as enqueued';

// The fake answers as the driver does: `{ rows }` for the function, and the error of the database carrying the SQLSTATE in `code`.
const databaseWith = (answer: () => Promise<unknown>) => {
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    if (sql === ENQUEUE_SQL && bindings.length === 0) return answer();
    throw new Error(`unexpected statement: ${sql}`);
  });
  return { database: { knex: { raw } } as unknown as DatabaseClient, raw };
};
const enqueues = (count: unknown) => databaseWith(async () => ({ rows: [{ enqueued: count }] }));
const databaseError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const captureLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async text(): Promise<string> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('');
    },
    async records(): Promise<Array<Record<string, unknown>>> {
      return (await this.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
};

const run = async (definition: ReturnType<typeof approvalRemindersJob>, logger: ReturnType<typeof createLogger>): Promise<void> => {
  await definition.handler(
    { id: 'job-1', name: APPROVAL_REMINDERS_JOB_NAME, payload: {}, attempt: 1 },
    { logger, signal: new AbortController().signal }
  );
};

// 12:00 UTC is 09:00 in São Paulo (no daylight saving since 2019): the morning the job may run in, unless a test moves the clock.
const NINE_IN_SAO_PAULO = '2026-11-13T12:00:00Z';
const jobOf = (dependencies: Omit<ApprovalRemindersJobDependencies, 'now'>, now: string = NINE_IN_SAO_PAULO) =>
  approvalRemindersJob({ ...dependencies, now: () => new Date(now) });

// Whether a daily cron "m h * * *" fires at an instant, read on the wall clock of its own time zone.
const firesAt = (schedule: { cron: string; timeZone: string }, instant: string): boolean => {
  const [minute, hour, ...rest] = schedule.cron.split(' ');
  expect(rest).toEqual(['*', '*', '*']);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return read('hour') === Number(hour) && read('minute') === Number(minute);
};

describe('approvals.enqueue-reminders', () => {
  it('is named, and scheduled once a day at 09:00 in São Paulo, and once at every start', () => {
    const definition = jobOf(enqueues(0));

    expect(definition.name).toBe('approvals.enqueue-reminders');
    expect(definition.schedule).toEqual({ cron: '0 9 * * *', timeZone: 'America/Sao_Paulo' });
    expect(APPROVAL_REMINDERS_SCHEDULE).toEqual({ cron: '0 9 * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
    expect(definition.concurrency).toBe(1);
  });

  it('fires at 09:00 of São Paulo, which is 12:00 UTC, on the fixed days of the fixture, and at no other hour', () => {
    const schedule = jobOf(enqueues(0)).schedule!;

    for (const instant of ['2026-11-13T12:00:00Z', '2026-11-14T12:00:00Z', '2027-01-01T12:00:00Z', '2026-12-25T12:00:00Z']) expect(firesAt(schedule, instant)).toBe(true);
    for (const instant of ['2026-11-13T09:00:00Z', '2026-11-13T11:59:00Z', '2026-11-13T12:01:00Z', '2026-11-13T13:00:00Z', '2026-11-13T00:00:00Z']) expect(firesAt(schedule, instant)).toBe(false);
  });

  describe('a start before the morning waits for the cron of 09:00 in São Paulo', () => {
    it('knows the morning begins at 9', () => {
      expect(APPROVAL_REMINDERS_FIRST_HOUR).toBe(9);
    });

    it.each([
      ['00:00', '2026-11-13T03:00:00Z'],
      ['02:00', '2026-11-13T05:00:00Z'],
      ['08:00', '2026-11-13T11:00:00Z'],
      ['08:59:59.999', '2026-11-13T11:59:59.999Z']
    ])('does not call the function at %s in São Paulo, and says why', async (_label, instant) => {
      const { database, raw } = enqueues(3);
      const captured = captureLogger();

      await run(jobOf({ database }, instant), captured.logger);

      expect(raw).not.toHaveBeenCalled();
      expect(await captured.records()).toEqual([expect.objectContaining({ skipped: 'before_morning' })]);
    });

    it.each([
      ['09:00:00', '2026-11-13T12:00:00Z'],
      ['09:00:00.001', '2026-11-13T12:00:00.001Z'],
      ['14:30', '2026-11-13T17:30:00Z'],
      ['23:59:59', '2026-11-14T02:59:59Z']
    ])('calls the function once at %s in São Paulo', async (_label, instant) => {
      const { database, raw } = enqueues(3);
      const captured = captureLogger();

      await run(jobOf({ database }, instant), captured.logger);

      expect(raw.mock.calls).toEqual([[ENQUEUE_SQL, []]]);
      expect(await captured.records()).toEqual([expect.objectContaining({ enqueued: 3 })]);
    });

    it('reads the hour of São Paulo, not the one of UTC or of the machine', async () => {
      // 11:59:59 UTC is hour 11 there and 08:59:59 here; 02:00 UTC of the next day is 23:00 here and hour 2 there.
      const early = enqueues(0);
      await run(jobOf({ database: early.database }, '2026-11-13T11:59:59Z'), captureLogger().logger);
      expect(early.raw).not.toHaveBeenCalled();
      const late = enqueues(0);
      await run(jobOf({ database: late.database }, '2026-11-14T02:00:00Z'), captureLogger().logger);
      expect(late.raw).toHaveBeenCalledTimes(1);
    });

    it('still runs once at every start, and the cron of 09:00 is the same', () => {
      const definition = approvalRemindersJob(enqueues(0));
      expect(definition.runOnStart).toBe(true);
      expect(definition.schedule).toEqual({ cron: '0 9 * * *', timeZone: 'America/Sao_Paulo' });
    });
  });

  it('retries over the morning, since a day it misses is not made up for', () => {
    const definition = jobOf(enqueues(0));

    expect(definition.retryLimit).toBeGreaterThanOrEqual(3);
    expect(definition.retryDelaySeconds).toBeGreaterThanOrEqual(30);
  });

  it('calls the function once, with no argument and no instant, and logs only how many it enqueued', async () => {
    const { database, raw } = enqueues(7);
    const captured = captureLogger();

    await run(jobOf({ database }), captured.logger);

    expect(raw.mock.calls).toEqual([[ENQUEUE_SQL, []]]);
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ enqueued: 7, msg: 'Approval reminders enqueued' })]);
    expect(Object.keys(records[0]!).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'enqueued'].includes(key))).toEqual([]);
  });

  it('is happy with a run that finds nothing to remind, and a second run is another call', async () => {
    const { database, raw } = enqueues(0);
    const captured = captureLogger();
    const definition = jobOf({ database });

    await run(definition, captured.logger);
    await run(definition, captured.logger);

    expect(raw).toHaveBeenCalledTimes(2);
    expect(await captured.records()).toEqual([expect.objectContaining({ enqueued: 0 }), expect.objectContaining({ enqueued: 0 })]);
  });

  it('refuses an answer that is not a count', async () => {
    for (const answer of [undefined, null, '3', 1.5, -1, true]) {
      await expect(run(jobOf(enqueues(answer)), captureLogger().logger)).rejects.toThrow('did not return how many it enqueued');
    }
    await expect(run(jobOf(databaseWith(async () => ({ rows: [] }))), captureLogger().logger)).rejects.toThrow('did not return how many it enqueued');
  });

  it('refuses a call that carries an actor (42501): logs the code as an error, ends the run with an error of its own and tells nothing of the database', async () => {
    const { database, raw } = databaseWith(async () => { throw databaseError('42501', 'The approval reminders are enqueued by the worker, not by a request. secret-detail'); });
    const captured = captureLogger();

    const failure = await run(jobOf({ database }), captured.logger).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('enqueue_approval_reminders() failed with 42501.');
    expect(raw).toHaveBeenCalledTimes(1);
    const records = await captured.records();
    expect(records).toEqual([expect.objectContaining({ level: 50, errorCode: '42501' })]);
    expect(await captured.text()).not.toContain('secret-detail');
  });

  it.each(['40001', '40P01'])('ends the run with an error the queue retries, and logs the code as a warning, when it loses a race (%s)', async (code) => {
    const { database } = databaseWith(async () => { throw databaseError(code, 'could not serialize access: secret-detail'); });
    const captured = captureLogger();

    const failure = await run(jobOf({ database }), captured.logger).then(() => undefined, (error: unknown) => error);

    expect((failure as Error).message).toBe(`enqueue_approval_reminders() failed with ${code}.`);
    expect(await captured.records()).toEqual([expect.objectContaining({ level: 40, errorCode: code })]);
    expect(await captured.text()).not.toContain('secret-detail');
  });

  it('runs again after a lost race, as the queue does, and then enqueues', async () => {
    const answers = [() => Promise.reject(databaseError('40001', 'x')), () => Promise.resolve({ rows: [{ enqueued: 2 }] })];
    const { database } = databaseWith(() => answers.shift()!());
    const definition = jobOf({ database });
    const captured = captureLogger();

    await expect(run(definition, captured.logger)).rejects.toThrow('40001');
    await run(definition, captured.logger);

    expect(await captured.records()).toEqual([expect.objectContaining({ errorCode: '40001' }), expect.objectContaining({ enqueued: 2 })]);
  });

  it('lets any other failure through as it came, to be retried and reported by the queue', async () => {
    const failure = new Error('connection reset');
    const { database } = databaseWith(async () => { throw failure; });

    await expect(run(jobOf({ database }), captureLogger().logger)).rejects.toBe(failure);
    const other = databaseError('57014', 'canceling statement due to statement timeout');
    await expect(run(jobOf({ database: databaseWith(async () => { throw other; }).database }), captureLogger().logger)).rejects.toBe(other);
  });
});
