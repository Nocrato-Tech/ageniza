import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, waitForBackendsBlockedBy, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld, type ContentStatus } from './support/content-world.js';
import { createNotificationFixtures } from './support/notification-fixtures.js';

// Scope redesign-igual, subtask W1-S3 (specs/notificacoes.md, section 8): the work of the worker, every hour, tells the responsible of a
// content that the deadline of its latest round passed while it still waits for the approval, once per round. The owner runs the variant
// that takes the instant (checklist 93); the function the worker calls runs as `ageniza_app` with no one bound.
const w = createContentWorld('notif-deadline');
const { ids } = w;
const f = createNotificationFixtures(w);
const a = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
const owner = (): Knex => w.getOwner().knex;

let worker: DatabaseClient;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
}, 300_000);

afterAll(async () => {
  try {
    await f.cleanUp();
    await a.cleanUp();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

interface Overdue { readonly content: string; readonly round: string }

/** A content that waits for the approval, its latest round with the deadline given (an hour ago by default). */
const overdue = async (input: { readonly responsible?: string; readonly client?: string; readonly dueAt?: string; readonly status?: ContentStatus } = {}): Promise<Overdue> => {
  const content = await w.seedContent(input.client ?? ids.clientA1, { status: input.status ?? 'awaiting_approval', owner: input.responsible ?? ids.productionA });
  return { content, round: await f.round(content, { dueAt: input.dueAt ?? ago(1) }) };
};

const runAt = async (at: string, client: Knex | Knex.Transaction = owner()): Promise<number> =>
  (await client.raw<{ rows: Array<{ created: number }> }>('select app_private.notify_approval_deadlines_passed_at(?::timestamptz) as created', [at])).rows[0]!.created;
const runNow = async (client: Knex | Knex.Transaction = owner()): Promise<number> =>
  (await client.raw<{ rows: Array<{ created: number }> }>('select app_private.notify_approval_deadlines_passed_at(pg_catalog.now()) as created')).rows[0]!.created;

const countAll = async (): Promise<number> => Number((await owner()('notifications').count<Array<{ count: string }>>('* as count'))[0]!.count);
const settle = (work: Promise<unknown>): Promise<unknown> => work.then(() => 'done', (error: unknown) => error);

describe('the deadline job tells the responsible of a content that is late (acceptance f)', () => {
  it('creates one notification for the responsible of a content that still waits, with the round and a summary of the title', async () => {
    const { content, round } = await overdue({ responsible: ids.managerA });

    expect(await runNow()).toBeGreaterThanOrEqual(1);

    const title = (await w.contentRow(content)).title as string;
    expect(await f.rowsFor({ contentId: content })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'approval_deadline_passed', content_id: content, thread_id: null,
      invitation_id: null, client_id: ids.clientA1, approval_round_id: round, summary: `O prazo de "${title}" venceu`, created_at: expect.any(Date), read_at: null
    }]);
    expect(await f.visibleTo(ids.managerA)).toContain((await f.rowsFor({ contentId: content }))[0]!.id);
    for (const other of [ids.productionA, ids.adminA, ids.ownerA]) expect(await f.visibleTo(other)).not.toContain((await f.rowsFor({ contentId: content }))[0]!.id);
  });

  it('runs twice without duplicating: the second run creates nothing', async () => {
    const { content } = await overdue();
    await runNow();
    const afterFirst = await countAll();

    expect(await runNow()).toBe(0);

    expect(await countAll()).toBe(afterFirst);
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });

  it('tells at the very instant of the deadline and not a millisecond before', async () => {
    const { content, round } = await overdue({ dueAt: await a.at(1) });
    const runAtDeadline = (offsetMs: number): Promise<unknown> => owner().raw(
      "select app_private.notify_approval_deadlines_passed_at((select due_at from public.content_approval_rounds where id = ?::uuid) + ?::integer * interval '1 millisecond')",
      [round, offsetMs]
    );

    await runNow();
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
    await runAtDeadline(-1);
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
    await runAtDeadline(0);
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });
  it.each(['in_production', 'adjusting', 'approved', 'published', 'cancelled'] as const)('does not tell a content that is %s, though its round is late', async (status) => {
    const { content } = await overdue({ status });
    await runNow();

    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('does not tell a content that was approved after its deadline passed and before the job ran', async () => {
    const { content } = await overdue();
    await w.asUser(ids.portalA1, async (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer, null)', [content, (await w.contentRow(content)).revision]));
    await runNow();

    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_approved']);
  });

  it('counts only the latest round: the late deadline of a round that was replaced is not told', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    await f.round(content, { dueAt: ago(2), sequence: 1 });
    const newest = await f.round(content, { dueAt: await a.at(2), sequence: 2 });
    await runNow();
    expect(await f.rowsFor({ contentId: content })).toEqual([]);

    await runAt(await a.at(3));
    expect((await f.rowsFor({ contentId: content })).map((row) => row.approval_round_id)).toEqual([newest]);
  });

  it('tells once for each round: a content sent again that is late again is a second notification, and a repeat of either is none', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const first = await f.round(content, { dueAt: ago(3), sequence: 1 });
    await runNow();
    expect((await f.rowsFor({ contentId: content })).map((row) => row.approval_round_id)).toEqual([first]);

    const second = await f.round(content, { dueAt: ago(1), sequence: 2 });
    await runNow();
    await runNow();

    expect((await f.rowsFor({ contentId: content })).map((row) => row.approval_round_id).sort()).toEqual([first, second].sort());
  });

  it('tells the new responsible of a content that changed hands after the first notification of the round', async () => {
    const { content, round } = await overdue({ responsible: ids.productionA });
    await runNow();
    await w.asUser(ids.ownerA, (t) => t.raw('update public.contents set owner_user_id = ?::uuid where id = ?::uuid', [ids.managerA, content]));

    expect(await runNow()).toBeGreaterThanOrEqual(1);
    expect(await runNow()).toBe(0);

    const rows = await f.rowsFor({ contentId: content });
    expect(rows.map((row) => row.recipient_user_id).sort()).toEqual([ids.productionA, ids.managerA].sort());
    expect(rows.every((row) => row.approval_round_id === round)).toBe(true);
  });

  it('does not tell a client that was archived, nor an agency that is suspended', async () => {
    const client = await a.freshClient([]);
    const archived = await overdue({ client });
    await w.archiveClient(client);
    const suspended = await w.withSuspendedAgencyActive(async () => {
      const made = await overdue({ client: ids.clientSuspended, responsible: ids.adminSuspended });
      await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });
      return made;
    });

    await runNow();

    expect(await f.rowsFor({ contentId: archived.content })).toEqual([]);
    expect(await f.rowsFor({ contentId: suspended.content })).toEqual([]);
  });

  it('writes a title of 120 characters whole in the summary, and says it in under 160', async () => {
    const { content } = await overdue();
    await owner()('contents').where({ id: content }).update({ title: 'T'.repeat(120) });
    await runNow();

    const [row] = await f.rowsFor({ contentId: content });
    expect(row!.summary).toBe(`O prazo de "${'T'.repeat(120)}" venceu`);
    expect(row!.summary.length).toBeLessThanOrEqual(160);
  });

  it('refuses a call that is not at a read committed level, and a call with no instant', async () => {
    const transaction = await owner().transaction({ isolationLevel: 'repeatable read' });
    try {
      await expect(runNow(transaction)).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    await expect(owner().raw('select app_private.notify_approval_deadlines_passed_at(null)')).rejects.toMatchObject({ code: '22023' });
  });

  it('does not wait for a content it told already, though the content is locked by someone else', async () => {
    const { content } = await overdue();
    await runNow();
    const editing = await owner().transaction();
    try {
      await editing.raw('select 1 from public.contents where id = ?::uuid for update', [content]);
      const job = await owner().transaction();
      try {
        await job.raw("set local lock_timeout = '400ms'");
        await expect(runNow(job)).resolves.toBeGreaterThanOrEqual(0);
      } finally {
        await job.rollback();
      }
    } finally {
      await editing.rollback();
    }
  });

  it('is atomic: a failure after a notification was written leaves nothing of the run', async () => {
    const { content } = await overdue();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(runNow()).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('injected after the notification') });
    });

    expect(await f.rowsFor({ contentId: content })).toEqual([]);
    await runNow();
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });
});

describe('the function of the worker (acceptance f)', () => {
  it('tells with no one bound, as the application role, and the responsible reads it', async () => {
    const { content } = await overdue({ responsible: ids.managerA });

    const created = await worker.knex.transaction(async (t) => (await t.raw<{ rows: Array<{ created: number }> }>('select app_private.notify_approval_deadlines_passed() as created')).rows[0]!.created);

    expect(created).toBeGreaterThanOrEqual(1);
    const [row] = await f.rowsFor({ contentId: content });
    expect(row!.recipient_user_id).toBe(ids.managerA);
    expect(await f.visibleTo(ids.managerA)).toContain(row!.id);
  });

  it('does not tell what is not late yet: the worker runs at the instant it is called', async () => {
    const { content } = await overdue({ dueAt: await a.at(2) });

    await worker.knex.transaction((t) => t.raw('select app_private.notify_approval_deadlines_passed()'));

    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('refuses a request of a person: it is the work of the worker, and tells nothing', async () => {
    const { content } = await overdue();

    await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.notify_approval_deadlines_passed()'))).rejects.toMatchObject({ code: '42501' });

    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });
});

describe('the job and the people at the same moment (acceptance h)', () => {
  it('waits for an approval in flight and then does not tell the content that was approved', async () => {
    const { content } = await overdue();
    const approving = await w.openTransactionAs(ids.portalA1);
    const approvingPid = await backendPid(approving);
    let job: Promise<unknown> | undefined;
    try {
      await approving.raw('select app_private.approve_content(?::uuid, ?::integer, null)', [content, (await w.contentRow(content)).revision]);
      job = settle(runNow());
      await waitForBackendsBlockedBy(owner(), approvingPid);
    } finally {
      await approving.commit();
    }

    expect(await job).toBe('done');
    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_approved']);
  });

  it.each([['after', 0], ['at the very instant of', 1]] as const)('does not deadlock with the archive of the client, which cancels its contents after it locked the client: the job runs %s the deadline', async (_when, exact) => {
    const client = await a.freshClient([]);
    const dueAt = ago(1);
    const { content } = await overdue({ client, dueAt });

    const archiving = await owner().transaction();
    const archivingPid = await backendPid(archiving);
    let job: Promise<unknown> | undefined;
    try {
      await archiving.raw('select 1 from public.clients where id = ?::uuid for update', [client]);
      job = settle(exact === 1 ? runAt(dueAt) : runNow());
      await waitForBackendsBlockedBy(owner(), archivingPid);
      await archiving.raw("update public.contents set status = 'cancelled' where id = ?::uuid", [content]);
      await archiving.raw("update public.clients set status = 'archived', archived_at = now() where id = ?::uuid", [client]);
    } finally {
      await archiving.commit();
    }

    expect(await job).toBe('done');
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('does not queue behind the archive of a client whose late content no longer waits for the approval', async () => {
    const client = await a.freshClient([]);
    await overdue({ client, status: 'approved' });

    const archiving = await owner().transaction();
    try {
      await archiving.raw('select 1 from public.clients where id = ?::uuid for update', [client]);
      const job = await owner().transaction();
      try {
        await job.raw("set local lock_timeout = '400ms'");
        await expect(runNow(job)).resolves.toBeGreaterThanOrEqual(0);
      } finally {
        await job.rollback();
      }
    } finally {
      await archiving.rollback();
    }
  });

  it('two runs at the same moment tell each content once, and neither waits for the other in a cycle', async () => {
    const other = await a.freshClient([]);
    const contents = [(await overdue()).content, (await overdue({ client: other })).content, (await overdue()).content, (await overdue({ client: other })).content];

    const first = await owner().transaction();
    const firstPid = await backendPid(first);
    const second = await owner().transaction();
    let secondRun: Promise<unknown> | undefined;
    try {
      expect(await runNow(first)).toBeGreaterThanOrEqual(contents.length);
      secondRun = runNow(second).then((created) => created, (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await secondRun).toBe(0);
    await second.commit();
    for (const content of contents) expect(await f.rowsFor({ contentId: content }), content).toHaveLength(1);
  });
});

// Last: these runs look far ahead, and every content of the file that is still waiting is late by then.
describe('a round with no deadline is never late', () => {
  it('does not tell a content sent with no deadline, whatever the instant', async () => {
    const content = await a.readyContent(ids.clientA1);
    await a.submit(ids.productionA, content, null);
    expect((await a.roundsOf(content)).map((round) => round.due_at)).toEqual([null]);

    await runAt(await a.at(24 * 365));

    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });
});
