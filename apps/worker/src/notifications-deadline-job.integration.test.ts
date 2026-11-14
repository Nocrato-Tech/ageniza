import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { createLocalTestDatabaseClient, raw, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME,
  APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE,
  approvalDeadlineNotificationsJob
} from './notifications-deadline-job.js';
import { createDurableQueue, type DurableJobDefinition, type DurableQueue } from './queue.js';

// Decision 2026-11-11 (notifications inside the app), against the migrated local database as the application role, the one the worker uses in
// production, with the real function `app_private.notify_approval_deadlines_passed()`. The function walks the whole database, so a case reads
// the rows of its own contents and never leans on the number the job reports.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const prefix = `test.${randomUUID().slice(0, 8)}`;
const jobName = `${prefix}.${APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME}`;
const REQUEST_ID = 'job:notifications.approval-deadline-passed';
const NOTIFIED_MESSAGE = 'Notified the approvals whose deadline passed';

const id = () => randomUUID();
const ids = { agency: id(), ownerUser: id(), responsible: id(), other: id() };
const users = [ids.ownerUser, ids.responsible, ids.other];

let owner: DatabaseClient;
let application: DatabaseClient;
const running = new Set<DurableQueue>();
const clients: string[] = [];
const contents: string[] = [];
const knex = () => owner.knex;

const captureLogs = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    records: (): Array<Record<string, unknown>> => output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    text: (): string => output.join('')
  };
};

type Captured = ReturnType<typeof captureLogs>;

const runJob = async (database: DatabaseClient = application): Promise<Captured> => {
  const logs = captureLogs();
  await approvalDeadlineNotificationsJob({ database }).handler(
    { id: 'job-1', name: APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME, payload: {}, attempt: 1 },
    { logger: logs.logger, signal: new AbortController().signal }
  );
  return logs;
};

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

// The application role, with what the function must refuse run INSIDE the transaction of the call: the job asks for one statement and the client
// below is what it asks it on.
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

const asActor = <T>(actor: string, work: (transaction: Transaction) => Promise<T>): Promise<T> =>
  knex().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    return work(transaction);
  });

const freshClient = async (): Promise<string> => {
  const clientId = id();
  clients.push(clientId);
  await knex()('clients').insert({ id: clientId, agency_id: ids.agency, name: `Padaria Sol ${clientId.slice(0, 8)}` });
  return clientId;
};

type Deadline = 'passed' | 'future' | 'none';
const DUE_AT: Record<Exclude<Deadline, 'none'>, string> = {
  passed: "now() - interval '2 hours'",
  future: "now() + interval '2 hours'"
};

/** A content in `awaiting_approval` whose latest round has the deadline given. */
const waitingContent = async (
  clientId: string,
  deadline: Deadline,
  options: { readonly title?: string } = {}
): Promise<{ contentId: string; roundId: string }> => {
  const contentId = id();
  contents.push(contentId);
  const folder = (await knex()('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;
  await knex()('contents').insert({
    id: contentId, client_id: clientId, title: options.title ?? `Post ${contentId.slice(0, 8)}`, platform: 'instagram', format: 'reels',
    publish_on: '2026-10-20', publish_at_time: '18:30', caption: 'Legenda', folder_id: folder, owner_user_id: ids.responsible, status: 'in_production'
  });
  await asActor(ids.responsible, (t) => t('contents').where({ id: contentId }).update({ status: 'awaiting_approval' }));
  return { contentId, roundId: await addRound(clientId, contentId, 1, deadline) };
};

const addRound = async (clientId: string, contentId: string, sequence: number, deadline: Deadline): Promise<string> => {
  const roundId = id();
  await knex()('content_approval_rounds').insert({
    id: roundId, batch_id: id(), client_id: clientId, content_id: contentId, sequence, sent_by: ids.responsible, note: 'Preciso do seu OK.',
    due_at: deadline === 'none' ? null : knex().raw(DUE_AT[deadline]),
    due_on: deadline === 'none' ? null : knex().raw(`app_private.sao_paulo_date(${DUE_AT[deadline]})`),
    sent_at: knex().raw("now() - interval '5 days'")
  });
  return roundId;
};

const notificationsOf = async (contentId: string) =>
  (await knex()('notifications').where({ content_id: contentId }).select('id', 'kind', 'recipient_user_id', 'agency_id', 'client_id', 'approval_round_id', 'summary', 'read_at')) as Array<{
    id: string; kind: string; recipient_user_id: string; agency_id: string; client_id: string; approval_round_id: string; summary: string; read_at: Date | null;
  }>;

const auditEvents = async () =>
  (await knex()('audit.events').where({ agency_id: ids.agency, action: 'notification.approval_deadline_passed' }).select('target_id', 'target_type', 'actor_user_id', 'request_id')) as Array<{
    target_id: string; target_type: string; actor_user_id: string | null; request_id: string;
  }>;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const admin = await presetRole('admin');
  await knex().transaction(async (transaction) => {
    await transaction('auth.user').insert(users.map((userId) => ({ id: userId, name: `User ${userId}`, email: `${userId}@worker-deadline-notifications.test`, emailVerified: true })));
    await transaction('agencies').insert({ id: ids.agency, name: `Agência Aurora ${ids.agency.slice(0, 8)}`, owner_user_id: ids.ownerUser });
    await transaction('agency_memberships').insert([
      { agency_id: ids.agency, user_id: ids.responsible, role_id: admin },
      { agency_id: ids.agency, user_id: ids.other, role_id: admin }
    ]);
  });
}, 300_000);

beforeEach(async () => {
  // A round left over by a case before must not be told in the next one.
  await knex()('notifications').where({ agency_id: ids.agency }).delete();
  await knex()('audit.events').where({ agency_id: ids.agency }).delete();
  await knex()('content_approval_rounds').whereIn('client_id', clients).delete();
});

// Children before parents, and every step is tried even when one fails, so a failed case never leaves a client, a round or the agency behind.
afterAll(async () => {
  await Promise.allSettled([...running].map((queue) => queue.stop()));
  const steps: Array<() => Promise<unknown>> = [
    () => knex().raw("select pgboss.delete_queue(name) from pgboss.queue where name like ? and name not like '%.dead'", [`${prefix}.%`]),
    () => knex().raw('select pgboss.delete_queue(name) from pgboss.queue where name like ?', [`${prefix}.%`]),
    () => knex()('notifications').where({ agency_id: ids.agency }).delete(),
    () => knex()('audit.events').where({ agency_id: ids.agency }).delete(),
    () => knex()('content_approval_rounds').whereIn('client_id', clients).delete(),
    () => knex()('contents').whereIn('id', contents).delete(),
    () => knex()('media_folders').whereIn('client_id', clients).delete(),
    () => knex()('clients').whereIn('id', clients).delete(),
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

describe('notifications.approval-deadline-passed against the database', () => {
  it('tells the responsible of the content whose round deadline passed, once, bound to the round, with the summary and an audit event of the job', async () => {
    const client = await freshClient();
    const { contentId, roundId } = await waitingContent(client, 'passed', { title: 'Promoção de pães' });

    const logs = await runJob();

    const notifications = await notificationsOf(contentId);
    expect(notifications).toEqual([{
      id: expect.any(String),
      kind: 'approval_deadline_passed',
      recipient_user_id: ids.responsible,
      agency_id: ids.agency,
      client_id: client,
      approval_round_id: roundId,
      summary: 'O prazo de "Promoção de pães" venceu',
      read_at: null
    }]);
    expect((await logs.records()).find((record) => record.msg === NOTIFIED_MESSAGE)?.notified).toBeGreaterThanOrEqual(1);
    // One audit event, with no person and the job as the origin, pointing at the notification it created.
    expect(await auditEvents()).toEqual([{ target_id: notifications[0]!.id, target_type: 'notification', actor_user_id: null, request_id: REQUEST_ID }]);
  });

  it('is idempotent: a second run and a third tell nobody again and audit nothing more', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');

    await runJob();
    const first = await notificationsOf(contentId);
    const second = await runJob();
    await runJob();

    expect(await notificationsOf(contentId)).toEqual(first);
    expect(await auditEvents()).toHaveLength(1);
    expect(second.records().find((record) => record.msg === NOTIFIED_MESSAGE)?.notified).toBe(0);
  });

  it('tells nobody about a deadline in the future, a round with no deadline, or a content that is no longer waiting', async () => {
    const client = await freshClient();
    const future = await waitingContent(client, 'future');
    const none = await waitingContent(client, 'none');
    const decided = await waitingContent(client, 'passed');
    await asActor(ids.responsible, (t) => t('contents').where({ id: decided.contentId }).update({ status: 'adjusting' }));

    await runJob();

    for (const { contentId } of [future, none, decided]) expect(await notificationsOf(contentId), contentId).toEqual([]);
    expect(await auditEvents()).toEqual([]);
  });

  it('judges the latest round only: a content sent again with a new deadline is not told for the deadline of the round before', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');
    await addRound(client, contentId, 2, 'future');
    const sentAgain = await waitingContent(client, 'passed');
    const latest = await addRound(client, sentAgain.contentId, 2, 'passed');

    await runJob();

    expect(await notificationsOf(contentId)).toEqual([]);
    expect((await notificationsOf(sentAgain.contentId)).map((notification) => notification.approval_round_id)).toEqual([latest]);
  });

  it('calls the function with no actor bound: with one bound the database refuses (42501), nothing is told, and the job fails instead of hiding it', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');

    const withActor = applicationWith(async (transaction) => { await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.responsible]); });
    await expect(runJob(withActor)).rejects.toMatchObject({ code: '42501' });

    expect(await notificationsOf(contentId)).toEqual([]);
    expect(await auditEvents()).toEqual([]);
    // The same content, the real job: told.
    await runJob();
    expect(await notificationsOf(contentId)).toHaveLength(1);
  });

  it.each(['repeatable read', 'serializable'] as const)('leaves everything for the next run when the function refuses a transaction in %s (40001), without failing the run', async (isolation) => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');

    const logs = await runJob(applicationWith(async () => undefined, isolation));

    expect(logs.records()).toEqual([expect.objectContaining({ level: 40, msg: 'Approval deadlines left for the next run after losing a race' })]);
    expect(logs.text()).not.toMatch(/40001|could not serialize/);
    expect(await notificationsOf(contentId)).toEqual([]);
    await runJob();
    expect(await notificationsOf(contentId)).toHaveLength(1);
  });

  it('logs the count and nothing about a content, a client or a person', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed', { title: 'Sigilo da Padaria' });

    const logs = await runJob();

    for (const secret of [contentId, client, 'Sigilo', 'Padaria', ids.responsible, ids.agency, '@worker-deadline-notifications.test']) expect(logs.text(), secret).not.toContain(secret);
  });
});

const definition = (overrides: Partial<DurableJobDefinition<Record<string, never>>> = {}): DurableJobDefinition<Record<string, never>> => ({
  ...approvalDeadlineNotificationsJob({ database: application }),
  name: jobName,
  retryDelaySeconds: 1,
  // Off unless a test is about it: a run at every start would add to what the tests read.
  runOnStart: false,
  ...overrides
});

const openQueue = async (jobs: ReadonlyArray<DurableJobDefinition<Record<string, never>>>, captured: Captured): Promise<DurableQueue> => {
  const queue = createDurableQueue({
    connectionString: applicationUrl,
    logger: captured.logger,
    concurrency: 1,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 1
  });
  for (const job of jobs) queue.register(job as DurableJobDefinition<object>);
  running.add(queue);
  await queue.start();
  return queue;
};

const closeQueue = async (queue: DurableQueue): Promise<void> => {
  await queue.stop();
  running.delete(queue);
};

const jobStates = async (): Promise<string[]> =>
  (await raw<{ rows: Array<{ state: string }> }>(knex(), 'select state::text as state from pgboss.job where name = ? order by created_on', [jobName])).rows.map((row) => row.state);

const waitForState = (jobId: string, state: string, timeout = 20_000): Promise<void> =>
  vi.waitFor(async () => {
    const result = await raw<{ rows: Array<{ state: string }> }>(knex(), 'select state::text as state from pgboss.job where id = ?', [jobId]);
    expect(result.rows[0]?.state).toBe(state);
  }, { timeout, interval: 250 });

describe('notifications.approval-deadline-passed on the durable queue', { timeout: 60_000 }, () => {
  it('registers one schedule, at five past every hour in Brasília, and does not add a second when the worker restarts or two run at once', async () => {
    const first = await openQueue([definition()], captureLogs());
    const second = await openQueue([definition()], captureLogs());
    const rows = (await raw<{ rows: Array<{ name: string; cron: string; timezone: string | null }> }>(knex(), 'select name, cron, timezone from pgboss.schedule where name = ?', [jobName])).rows;
    expect(rows).toEqual([{ name: jobName, cron: '5 * * * *', timezone: 'America/Sao_Paulo' }]);
    expect(rows[0]).toMatchObject({ cron: APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE.cron, timezone: APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE.timeZone });
    await closeQueue(first);
    await closeQueue(second);
  });

  it('runs a job sent to the queue, as the application role, and tells the responsible', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');
    const queue = await openQueue([definition()], captureLogs());

    await waitForState(await queue.send(jobName, {}), 'completed');

    expect(await notificationsOf(contentId)).toHaveLength(1);
    await closeQueue(queue);
  });

  it('runs at every start of the worker, so an hour missed while it was down is caught up at once', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');
    const before = (await jobStates()).length;

    const queue = await openQueue([definition({ runOnStart: true })], captureLogs());

    await vi.waitFor(async () => expect(await notificationsOf(contentId)).toHaveLength(1), { timeout: 20_000, interval: 250 });
    await vi.waitFor(async () => expect((await jobStates()).slice(before)).toEqual(['completed']), { timeout: 20_000, interval: 250 });
    await closeQueue(queue);
  });

  it('survives a failure: the run is retried by the queue, the worker keeps serving, and the next run tells what was due', async () => {
    const client = await freshClient();
    const { contentId } = await waitingContent(client, 'passed');
    let attempts = 0;
    const flaky = applicationWith(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    });
    const captured = captureLogs();
    const queue = await openQueue([{ ...approvalDeadlineNotificationsJob({ database: flaky }), name: jobName, retryDelaySeconds: 1, runOnStart: false }], captured);

    const jobId = await queue.send(jobName, {});
    await waitForState(jobId, 'completed');

    expect(attempts).toBe(2);
    expect(captured.records().some((record) => record.msg === 'Durable job failed and will be retried')).toBe(true);
    expect(await notificationsOf(contentId)).toHaveLength(1);
    // Still serving: another job sent afterwards runs.
    await waitForState(await queue.send(jobName, {}), 'completed');
    await closeQueue(queue);
  });
});
