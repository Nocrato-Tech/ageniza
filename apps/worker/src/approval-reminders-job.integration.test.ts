import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { APPROVAL_REMINDERS_JOB_NAME, approvalRemindersJob } from './approval-reminders-job.js';

// Decision 2026-11-10 (reminders of approval), against the migrated local database as the application role, the one the worker uses in
// production, with the real function `app_private.enqueue_approval_reminders()`. The function reads the clock of the database (now()), so the
// rounds are made relative to the day of São Paulo at the moment of the test: due tomorrow, due yesterday.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

// The hour the job judges "morning" at: it reads the clock of the machine, which this suite must not depend on. The day of the rounds is the
// database's, which is why the suite also waits for a quiet clock below.
const MORNING = new Date('2026-11-13T15:00:00Z');
const QUIET_SECONDS = 60;

const id = () => randomUUID();
const ids = { agency: id(), ownerUser: id(), actor: id(), portal1: id(), portal2: id() };
const users = [ids.ownerUser, ids.actor, ids.portal1, ids.portal2];
const emailOf = (userId: string): string => `${userId}@worker-approval-reminders.test`;

let owner: DatabaseClient;
let application: DatabaseClient;
const clients: string[] = [];
// Clients of another "file" of the same database: each case plants a round of one of them, due tomorrow and not told yet, which the job finds
// and counts too, so no case can lean on the number the job returns.
const strangers: string[] = [];
const contents: string[] = [];
const knex = () => owner.knex;

const captureLogs = () => {
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

const runJob = async (database: DatabaseClient = application) => {
  const logs = captureLogs();
  await approvalRemindersJob({ now: () => MORNING, database }).handler(
    { id: 'job-1', name: APPROVAL_REMINDERS_JOB_NAME, payload: {}, attempt: 1 },
    { logger: logs.logger, signal: new AbortController().signal }
  );
  return logs;
};

/**
 * The deadline of a round is a day of São Paulo and the function reads the clock of the database, so the suite starts only when the minutes
 * around São Paulo midnight are not ahead of it: a "due tomorrow" made before midnight would be "due today" when the job runs. The suite is
 * shorter than the quiet window. Same guard as `waitForQuietClock` of the fixtures of `packages/database/test`.
 */
const waitForQuietClock = async (): Promise<void> => {
  const { rows } = await knex().raw<{ rows: Array<{ since: number; until: number }> }>(`
    select extract(epoch from now() - app_private.sao_paulo_date(now())::timestamp at time zone 'America/Sao_Paulo')::float8 as since,
           extract(epoch from (app_private.sao_paulo_date(now()) + 1)::timestamp at time zone 'America/Sao_Paulo' - now())::float8 as until
  `);
  const { since, until } = rows[0]!;
  const wait = since < QUIET_SECONDS ? QUIET_SECONDS - since : until < QUIET_SECONDS ? until + QUIET_SECONDS : 0;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
};

// The function walks the whole database, so what it returns counts rounds of other clients as well (another file, a run that was cut short):
// a case asserts the rows and the stamps of its own clients, and of the number only that it is not less than what it made.
const enqueuedOf = async (logs: ReturnType<typeof captureLogs>): Promise<number> =>
  (await logs.records()).find((record) => record.msg === 'Approval reminders enqueued')!.enqueued as number;

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

// The application role, but with what the function must refuse or the isolation it must refuse, run INSIDE the transaction of the call: the
// job asks for one statement and the database client below is what it asks it on.
const applicationWith = (setup: (transaction: Transaction) => Promise<void>, isolationLevel?: 'repeatable read' | 'serializable'): DatabaseClient => ({
  knex: {
    raw: (statement: string, bindings: readonly unknown[]) => application.knex.transaction(async (transaction) => {
      await setup(transaction);
      return transaction.raw(statement, bindings as never);
    }, isolationLevel === undefined ? undefined : { isolationLevel })
  }
}) as unknown as DatabaseClient;

const presetRole = async (key: string): Promise<string> =>
  (await knex()('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

const defaultFolder = async (clientId: string): Promise<string> =>
  (await knex()('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;

const freshClient = async (people: readonly string[] = [ids.portal1, ids.portal2]): Promise<string> => {
  const clientId = id();
  clients.push(clientId);
  await knex()('clients').insert({ id: clientId, agency_id: ids.agency, name: `Padaria Sol ${clientId.slice(0, 8)}` });
  if (people.length > 0) await knex()('client_memberships').insert(people.map((user) => ({ client_id: clientId, user_id: user })));
  return clientId;
};

const asActor = <T>(actor: string, work: (transaction: Transaction) => Promise<T>): Promise<T> =>
  knex().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    return work(transaction);
  });

const plantStrangerRound = async (): Promise<void> => {
  const clientId = id();
  strangers.push(clientId);
  await knex()('clients').insert({ id: clientId, agency_id: ids.agency, name: `Estranho ${clientId.slice(0, 8)}` });
  await knex()('client_memberships').insert({ client_id: clientId, user_id: ids.portal1 });
  await waitingContent(clientId, 1);
};

/** A content that waits for approval, in a round that is due `dueInDays` from today in São Paulo (negative: it was due), sent `sentDaysAgo` days ago. */
const waitingContent = async (clientId: string, dueInDays: number | null, sentDaysAgo = 5): Promise<{ contentId: string; roundId: string }> => {
  const contentId = id();
  contents.push(contentId);
  await knex()('contents').insert({
    id: contentId, client_id: clientId, title: `Post ${contentId.slice(0, 8)}`, platform: 'instagram', format: 'reels',
    publish_on: '2026-10-20', publish_at_time: '18:30', caption: 'Legenda', folder_id: await defaultFolder(clientId), owner_user_id: ids.actor, status: 'in_production'
  });
  await asActor(ids.actor, (t) => t('contents').where({ id: contentId }).update({ status: 'awaiting_approval' }));
  const roundId = id();
  await knex()('content_approval_rounds').insert({
    id: roundId, batch_id: id(), client_id: clientId, content_id: contentId, sequence: 1, sent_by: ids.actor, note: 'Preciso do seu OK.',
    due_on: dueInDays === null ? null : knex().raw('app_private.sao_paulo_date(now()) + ?::integer', [dueInDays]),
    sent_at: knex().raw("now() - (?::integer * interval '1 day')", [sentDaysAgo])
  });
  return { contentId, roundId };
};

const queued = () => knex()('notification_queue').whereIn('client_id', clients).whereIn('type', ['content_approval_due_soon', 'content_approval_overdue'])
  .orderBy(['type', 'recipient_portal_access_id']) as unknown as Promise<Array<Record<string, unknown>>>;
const stampsOf = async (roundId: string) =>
  (await knex()('content_approval_rounds').where({ id: roundId }).first('reminded_due_soon_at', 'reminded_overdue_at')) as { reminded_due_soon_at: Date | null; reminded_overdue_at: Date | null };

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  await waitForQuietClock();
  application = createLocalTestDatabaseClient(applicationUrl);
  const admin = await presetRole('admin');
  await knex().transaction(async (transaction) => {
    await transaction('auth.user').insert(users.map((userId) => ({ id: userId, name: `User ${userId}`, email: emailOf(userId), emailVerified: true })));
    await transaction('agencies').insert({ id: ids.agency, name: `Agência Aurora ${ids.agency.slice(0, 8)}`, owner_user_id: ids.ownerUser });
    await transaction('agency_memberships').insert({ agency_id: ids.agency, user_id: ids.actor, role_id: admin });
  });
}, 300_000);

beforeEach(async () => {
  // Rounds and items of the cases before are gone, so a round of this world left unstamped by a failed case is not told in the next one.
  await knex()('notification_queue').whereIn('client_id', clients).delete();
  await knex()('content_approval_rounds').whereIn('client_id', clients).delete();
  await knex()('agencies').where({ id: ids.agency }).update({ status: 'active', plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
  await plantStrangerRound();
});

// What the cases leave in the queue is dropped as soon as the case ends: the queue is global, and an item of a client of this file must not wait
// for the end of the file for anyone who claims the queue.
afterEach(async () => {
  await knex()('notification_queue').whereIn('client_id', [...clients, ...strangers]).delete();
});

// Children before parents, and every step is tried even when one fails, so a failed case never leaves a client, a round or the agency behind.
afterAll(async () => {
  const everyClient = [...clients, ...strangers];
  const steps: Array<() => Promise<unknown>> = [
    () => knex()('client_portal_approval_links').whereIn('client_id', everyClient).delete(),
    () => knex()('notification_queue').whereIn('client_id', everyClient).delete(),
    () => knex()('content_approval_rounds').whereIn('client_id', everyClient).delete(),
    () => knex()('contents').whereIn('id', contents).delete(),
    () => knex()('media_folders').whereIn('client_id', everyClient).delete(),
    () => knex()('client_memberships').whereIn('client_id', everyClient).delete(),
    () => knex()('clients').whereIn('id', everyClient).delete(),
    () => knex()('agency_memberships').where({ agency_id: ids.agency }).delete(),
    () => knex()('agencies').where({ id: ids.agency }).delete(),
    () => knex()('auth.user').whereIn('id', users).delete()
  ];
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  await application.close();
  await owner.close();
  if (failures.length > 0) throw failures[0];
});

describe('approvals.enqueue-reminders against the database', () => {
  it('enqueues "vence amanhã" for the round due tomorrow, one item per active person, bound to the round, and stamps it', async () => {
    const client = await freshClient();
    const { contentId, roundId } = await waitingContent(client, 1);

    const logs = await runJob();

    const items = await queued();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type)).toEqual(['content_approval_due_soon', 'content_approval_due_soon']);
    expect(items.every((item) => item.content_id === contentId && item.approval_round_id === roundId && item.client_id === client)).toBe(true);
    expect(new Set(items.map((item) => item.recipient_portal_access_id)).size).toBe(2);
    expect((await stampsOf(roundId)).reminded_due_soon_at).not.toBeNull();
    expect((await stampsOf(roundId)).reminded_overdue_at).toBeNull();
    expect(await enqueuedOf(logs)).toBeGreaterThanOrEqual(2);
  });

  it('enqueues "venceu" for the round that was due yesterday, and nothing for a deadline of another day', async () => {
    const client = await freshClient();
    const overdue = await waitingContent(client, -1);
    for (const days of [-2, 0, 2, 7]) await waitingContent(client, days);
    await waitingContent(client, null);

    const logs = await runJob();

    const items = await queued();
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.type === 'content_approval_overdue' && item.content_id === overdue.contentId && item.approval_round_id === overdue.roundId)).toBe(true);
    expect((await stampsOf(overdue.roundId)).reminded_overdue_at).not.toBeNull();
    expect(await enqueuedOf(logs)).toBeGreaterThanOrEqual(2);
  });

  it('enqueues each reminder once per round: a second run, and a third, enqueue nothing new', async () => {
    const client = await freshClient();
    const soon = await waitingContent(client, 1);
    const overdue = await waitingContent(client, -1);

    const first = await runJob();
    const afterFirst = await queued();
    const stamps = await stampsOf(soon.roundId);
    const second = await runJob();
    const third = await runJob();

    expect(afterFirst).toHaveLength(4);
    expect(new Set(afterFirst.map((item) => item.type))).toEqual(new Set(['content_approval_due_soon', 'content_approval_overdue']));
    expect(await queued()).toEqual(afterFirst);
    expect((await stampsOf(soon.roundId)).reminded_due_soon_at).toEqual(stamps.reminded_due_soon_at);
    expect((await stampsOf(overdue.roundId)).reminded_overdue_at).not.toBeNull();
    expect(await enqueuedOf(first)).toBeGreaterThanOrEqual(4);
    // Whatever the number of a database that also holds other rounds, nothing of this world is enqueued again, nor stamped again.
    expect(await enqueuedOf(second)).toBeGreaterThanOrEqual(0);
    expect(await enqueuedOf(third)).toBeGreaterThanOrEqual(0);
    expect((await stampsOf(soon.roundId)).reminded_due_soon_at).toEqual(stamps.reminded_due_soon_at);
  });

  it('does not enqueue "vence amanhã" for a round sent on the eve itself: the e-mail of the send already said so', async () => {
    const client = await freshClient();
    const { roundId } = await waitingContent(client, 1, 0);

    await runJob();

    expect(await queued()).toEqual([]);
    expect((await stampsOf(roundId)).reminded_due_soon_at).toBeNull();
  });

  it('enqueues only for the active people of the client', async () => {
    const client = await freshClient();
    await waitingContent(client, 1);
    await knex()('client_memberships').where({ client_id: client, user_id: ids.portal2 }).delete();
    await knex()('client_portal_accesses').where({ client_id: client, user_id: ids.portal2 }).update({ status: 'removed', generation: knex().raw('generation + 1') });

    await runJob();

    const items = await queued();
    expect(items).toHaveLength(1);
    const access = await knex()('client_portal_accesses').where({ id: items[0]!.recipient_portal_access_id as string }).first('user_id');
    expect(access.user_id).toBe(ids.portal1);
  });

  describe('sends no reminder when what it would remind of no longer holds', () => {
    it.each([
      ['the client is archived', async (client: string) => { await knex()('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() }); }],
      ['the content is no longer awaiting (approved)', async (client: string) => {
        await asActor(ids.portal1, (t) => t('contents').where({ client_id: client }).update({ status: 'approved', approved_by: ids.portal1, approved_at: new Date() }));
      }]
    ])('of one client, when %s: the other client of the same agency, with the same rounds, is told', async (_name, spoil) => {
      for (const dueInDays of [1, -1]) {
        const client = await freshClient();
        await waitingContent(client, dueInDays);
        await spoil(client);
      }
      // The same two rounds in a healthy client are the control: without it a function that never enqueues would pass.
      const control = await freshClient();
      await waitingContent(control, 1);
      await waitingContent(control, -1);

      const logs = await runJob();

      const items = await queued();
      expect(items).toHaveLength(4);
      expect(new Set(items.map((item) => item.client_id))).toEqual(new Set([control]));
      expect(await enqueuedOf(logs)).toBeGreaterThanOrEqual(4);
    });

    it.each([
      ['the agency is suspended', async () => { await knex()('agencies').where({ id: ids.agency }).update({ status: 'suspended' }); }],
      ['the agency is read-only (trial ended)', async () => {
        await knex()('agencies').where({ id: ids.agency }).update({
          plan: 'trial', trial_ends_at: knex().raw("now() - interval '1 minute'"), trial_owner_email_key: `worker-reminders-${ids.agency}`
        });
      }]
    ])('of the agency, when %s, and it tells again once the agency is back and has a round due', async (_name, spoil) => {
      const client = await freshClient();
      await waitingContent(client, 1);
      await waitingContent(client, -1);
      await spoil();

      const refused = await runJob();

      expect(await queued()).toEqual([]);
      expect(await enqueuedOf(refused)).toBeGreaterThanOrEqual(0);

      await knex()('agencies').where({ id: ids.agency }).update({ status: 'active', plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
      const later = await waitingContent(client, 1);
      const told = await runJob();

      // The reminder of a day the agency could not be told is not made up for: only the round that came after is enqueued.
      const items = await queued();
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.approval_round_id === later.roundId)).toBe(true);
      expect(await enqueuedOf(told)).toBeGreaterThanOrEqual(2);
    });
  });

  it('refuses a call that carries an actor with 42501, enqueues nothing and stamps nothing', async () => {
    const client = await freshClient();
    const { roundId } = await waitingContent(client, 1);
    const withActor = async (transaction: Transaction) => { await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.actor]); };

    await expect(application.knex.transaction(async (transaction) => {
      await withActor(transaction);
      await transaction.raw('select app_private.enqueue_approval_reminders()');
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('worker, not by a request') });

    const logs = captureLogs();
    const failure = await approvalRemindersJob({ now: () => MORNING, database: applicationWith(withActor) }).handler(
      { id: 'job-1', name: APPROVAL_REMINDERS_JOB_NAME, payload: {}, attempt: 1 },
      { logger: logs.logger, signal: new AbortController().signal }
    ).then(() => undefined, (error: unknown) => error);

    expect((failure as Error).message).toBe('enqueue_approval_reminders() failed with 42501.');
    expect(await logs.records()).toEqual([expect.objectContaining({ level: 50, errorCode: '42501' })]);
    expect(await queued()).toEqual([]);
    expect((await stampsOf(roundId)).reminded_due_soon_at).toBeNull();
  });

  it.each(['repeatable read', 'serializable'] as const)('surfaces the 40001 of an isolation other than READ COMMITTED (%s) as the error the queue retries, and the retry in READ COMMITTED enqueues', async (isolation) => {
    const client = await freshClient();
    const { roundId } = await waitingContent(client, 1);
    const logs = captureLogs();

    // The job does not retry in process: it logs the code and ends the run with an error, which the durable queue retries (retryLimit 6).
    const failure = await approvalRemindersJob({ now: () => MORNING, database: applicationWith(async () => undefined, isolation) }).handler(
      { id: 'job-1', name: APPROVAL_REMINDERS_JOB_NAME, payload: {}, attempt: 1 },
      { logger: logs.logger, signal: new AbortController().signal }
    ).then(() => undefined, (error: unknown) => error);

    expect((failure as Error).message).toBe('enqueue_approval_reminders() failed with 40001.');
    expect(await logs.records()).toEqual([expect.objectContaining({ level: 40, errorCode: '40001' })]);
    expect(await queued()).toEqual([]);
    expect((await stampsOf(roundId)).reminded_due_soon_at).toBeNull();

    const retry = await runJob();

    expect(await queued()).toHaveLength(2);
    expect(await enqueuedOf(retry)).toBeGreaterThanOrEqual(2);
  });

  it('is not callable with an instant by the application role: the function of the owner is closed to it', async () => {
    await expect(application.knex.raw('select app_private.enqueue_approval_reminders_at(now())')).rejects.toMatchObject({ code: '42501' });
  });
});
