import { createHash, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, waitForBackendsBlockedBy, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures, QUIET_SECONDS, secondsUntilClockIsQuiet } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';
import { setPortalAccessStatus } from './support/portal-access.js';

// Scope telas-melhorias, decision 2 of 2026-11-10: the reminders "due tomorrow" and "overdue" of an approval round, in the queue of the
// worker. The worker is `ageniza_app` with no actor bound to the transaction. A reminder is for an exact day, so the tests do not move the
// clock: a send cannot be made in the past, so a round is sent for real and then aged by the owner (its deadline and the day it was sent
// are moved), which is how "the day before the deadline" is reached. RLS filters silently, so a read is checked by the rows it returns and
// a write by the state left in the tables. Every negative case runs next to a control that is enqueued in the same run: a function that
// enqueued nothing at all would otherwise pass them.
const w = createContentWorld('approval-reminders');
const { ids } = w;
const f = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
let worker: DatabaseClient;

const owner = (): Knex => w.getOwner().knex;
const worldClients = (): string[] => [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended, ...f.extraClients];

const DUE_SOON = 'content_approval_due_soon';
const OVERDUE = 'content_approval_overdue';
const REMINDER_TYPES = [DUE_SOON, OVERDUE];
// The people of a fresh client: portalA1 and portalA1Second, an access each.
const PEOPLE = 2;

describe('the clock guard of this suite and of the rounds', () => {
  it('lets a run start in the middle of the day and waits out the minute on each side of São Paulo midnight', () => {
    expect(secondsUntilClockIsQuiet(12 * 3600, 12 * 3600)).toBe(0);
    expect(secondsUntilClockIsQuiet(QUIET_SECONDS, 86_400 - QUIET_SECONDS)).toBe(0);
    expect(secondsUntilClockIsQuiet(10, 86_390)).toBe(QUIET_SECONDS - 10);
    expect(secondsUntilClockIsQuiet(QUIET_SECONDS - 1, 86_000)).toBe(1);
    expect(secondsUntilClockIsQuiet(86_370, 30)).toBe(30 + QUIET_SECONDS);
    expect(secondsUntilClockIsQuiet(86_000, QUIET_SECONDS - 1)).toBe(QUIET_SECONDS - 1 + QUIET_SECONDS);
  });
});

beforeAll(async () => {
  await w.setup();
  await f.waitForQuietClock();
  worker = createLocalTestDatabaseClient(applicationUrl);
}, 300_000);

beforeEach(async () => {
  await owner()('notification_queue').whereIn('client_id', worldClients()).delete();
  await owner()('content_approval_rounds').whereIn('client_id', worldClients()).delete();
});

afterAll(async () => {
  try {
    await owner()('notification_queue').whereIn('client_id', worldClients()).delete();
    await f.cleanUp();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers ----------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface Waiting { client: string; content: string; round: string }

const asWorker = <T>(work: (transaction: Knex.Transaction) => Promise<T>, isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'): Promise<T> =>
  worker.knex.transaction(work, isolationLevel === undefined ? {} : { isolationLevel });
const enqueueIn = async (transaction: Knex.Transaction): Promise<number> =>
  Number((await transaction.raw<{ rows: Array<{ enqueued: number }> }>('select app_private.enqueue_approval_reminders() as enqueued')).rows[0]!.enqueued);
const enqueue = (): Promise<number> => asWorker(enqueueIn);
// The function of the owner, which reads the day at an instant a test fixes: the worker has no way to say one.
const enqueueAt = (instant: string): Promise<number> =>
  owner().transaction(async (transaction) =>
    Number((await transaction.raw<{ rows: Array<{ enqueued: number }> }>('select app_private.enqueue_approval_reminders_at(?::timestamptz) as enqueued', [instant])).rows[0]!.enqueued)
  );

/**
 * The round the reminders look at: due `dueOffset` days from today (null: no deadline) and sent `sentDaysAgo` days ago, long before the
 * eve unless a test says otherwise. The owner moves it, since a send cannot be made in the past.
 */
const age = async (roundId: string, dueOffset: number | null, sentDaysAgo = 14): Promise<void> => {
  const dueOn = dueOffset === null ? null : await f.day(dueOffset);
  await owner().raw("update public.content_approval_rounds set due_on = ?::date, sent_at = pg_catalog.now() - (?::integer * interval '1 day') where id = ?::uuid", [dueOn, sentDaysAgo, roundId]);
};
const latestRound = async (content: string): Promise<string> => {
  const rounds = await f.roundsOf(content);
  return rounds[rounds.length - 1]!.id as string;
};
const waiting = async (dueOffset: number | null, options: { client?: string; note?: string; sentDaysAgo?: number } = {}): Promise<Waiting> => {
  const client = options.client ?? (await f.freshClient());
  const content = await f.readyContent(client);
  await f.submit(ids.productionA, content, null, options.note ?? null);
  const round = await latestRound(content);
  await age(round, dueOffset, options.sentDaysAgo);
  return { client, content, round };
};
// A content of agency B, whose state (suspended, read only) the tests change while agency A, where the control is, stays as it is.
const waitingInB = async (dueOffset: number): Promise<Waiting> => {
  const folder = await w.folderOf(ids.clientB);
  const content = await w.seedContent(ids.clientB, { owner: ids.adminB });
  await w.attach(content, [await w.seedAsset(ids.clientB, folder, { category: 'video' })]);
  await f.submit(ids.adminB, content);
  const round = await latestRound(content);
  await age(round, dueOffset);
  return { client: ids.clientB, content, round };
};

const remindersOf = async (content: string, type?: string): Promise<Row[]> =>
  (await f.queueOf(content)).filter((row) => REMINDER_TYPES.includes(row.type as string) && (type === undefined || row.type === type));
const discarded = (rows: readonly Row[]): Row[] => rows.filter((row) => row.discarded_at !== null);
const accessesOf = async (client: string): Promise<string[]> =>
  ((await owner()('client_portal_accesses').where({ client_id: client, status: 'active' }).select('id')) as Array<{ id: string }>).map((row) => row.id).sort();
const recipientsOf = (rows: readonly object[]): string[] => rows.map((row) => (row as Row).recipient_portal_access_id as string).sort();
const stampsOf = async (round: string): Promise<Row> =>
  (await owner()('content_approval_rounds').where({ id: round }).first('reminded_due_soon_at', 'reminded_overdue_at')) as Row;

interface Claimed {
  item_id: string; claim_token: string; notification_type: string; client_id: string; recipient_portal_access_id: string; content_id: string;
  approval_due_on: string | null; approval_note: string | null; approval_batch_id: string | null;
}
const COLUMNS = `item_id, claim_token, notification_type, client_id, recipient_portal_access_id, content_id, approval_due_on::text as approval_due_on, approval_note, approval_batch_id`;
const claim = (): Promise<Claimed[]> =>
  asWorker(async (t) => (await t.raw<{ rows: Claimed[] }>(`select ${COLUMNS} from app_private.claim_notification_batch(?::integer)`, [100])).rows.filter((row) => worldClients().includes(row.client_id)));
const claimOf = async (...contents: string[]): Promise<Claimed[]> => (await claim()).filter((row) => contents.includes(row.content_id));
const recheck = (batch: readonly Claimed[]): Promise<Claimed[]> =>
  asWorker(async (t) =>
    (await t.raw<{ rows: Claimed[] }>(`select ${COLUMNS} from app_private.recheck_notifications(?::uuid[], ?::uuid)`, [batch.map((row) => row.item_id) as never, batch[0]?.claim_token ?? randomUUID()])).rows
  );
const markSent = (batch: readonly Claimed[]): Promise<number> =>
  asWorker(async (t) => Number((await t.raw<{ rows: Array<{ marked: number }> }>('select app_private.mark_notifications_sent(?::uuid[], ?::uuid) as marked', [batch.map((row) => row.item_id) as never, batch[0]!.claim_token])).rows[0]!.marked));
const fail = (batch: readonly Claimed[], code: string): Promise<number> =>
  asWorker(async (t) => Number((await t.raw<{ rows: Array<{ failed: number }> }>('select app_private.fail_notifications(?::uuid[], ?::uuid, ?::text) as failed', [batch.map((row) => row.item_id) as never, batch[0]!.claim_token, code])).rows[0]!.failed));

const approveAs = async (user: string, content: string): Promise<void> => {
  const revision = (await w.contentRow(content)).revision as number;
  await w.asUser(user, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [content, revision]));
};
const sendAgain = async (content: string, note = 'Rodada nova'): Promise<void> => {
  await f.requestChanges(ids.portalA1, content);
  await f.submit(ids.productionA, content, null, note);
};

// ---- the queue knows the two reminders --------------------------------------------------------------------------------------

describe('the queue holds the two reminders, each bound to the round it reminds of', () => {
  const tryInsert = async (row: Record<string, unknown>): Promise<unknown> => {
    const transaction = await owner().transaction();
    try {
      await transaction('notification_queue').insert(row);
      return 'inserted';
    } catch (error) {
      return error;
    } finally {
      await transaction.rollback();
    }
  };

  it.each([
    ['a "due tomorrow" reminder with its round', (c: Waiting) => ({ type: DUE_SOON, approval_round_id: c.round }), 'inserted'],
    ['an "overdue" reminder with its round', (c: Waiting) => ({ type: OVERDUE, approval_round_id: c.round }), 'inserted'],
    ['a "due tomorrow" reminder without a round', () => ({ type: DUE_SOON }), { code: '23514', constraint: 'notification_queue_round_check' }],
    ['an "overdue" reminder without a round', () => ({ type: OVERDUE }), { code: '23514', constraint: 'notification_queue_round_check' }],
    ['a "to approve" item that carries a round', (c: Waiting) => ({ type: 'content_awaiting_approval', approval_round_id: c.round }), { code: '23514', constraint: 'notification_queue_round_check' }],
    ['a "published" item that carries a round', (c: Waiting) => ({ type: 'content_published', approval_round_id: c.round }), { code: '23514', constraint: 'notification_queue_round_check' }],
    ['a type nobody knows', (c: Waiting) => ({ type: 'content_approval_reminder', approval_round_id: c.round }), { code: '23514' }],
    ['a reminder whose round belongs to ANOTHER content', (_c: Waiting, other: Waiting) => ({ type: DUE_SOON, approval_round_id: other.round }), { code: '23503', constraint: 'notification_queue_round_fk' }]
  ])('takes %s as the table decides', async (_label, build, expected) => {
    const target = await waiting(1);
    const other = await waiting(1);
    const row = { client_id: target.client, content_id: target.content, recipient_portal_access_id: (await accessesOf(target.client))[0], send_after: new Date(), ...build(target, other) };

    const outcome = await tryInsert(row);

    if (expected === 'inserted') expect(outcome).toBe('inserted');
    else expect(outcome).toMatchObject(expected as object);
  });

  it('takes the reminders of a round with it when the round goes', async () => {
    const { content, round } = await waiting(1);
    expect(await enqueue()).toBe(PEOPLE);

    await owner()('content_approval_rounds').where({ id: round }).delete();

    expect(await remindersOf(content)).toEqual([]);
  });

  it.each([DUE_SOON, OVERDUE])('is due at the very instant it is asked for, for a "%s" reminder', async (type) => {
    const instant = await f.sql("select to_char(app_private.notification_send_after(?, '2026-11-12 02:30:00+00'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as value", [type]);
    expect(instant).toBe('2026-11-12 02:30:00');
  });

  it('still gives the "to approve" item its 15 minutes', async () => {
    const instant = await f.sql("select to_char(app_private.notification_send_after('content_awaiting_approval', '2026-11-12 02:30:00+00'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as value");
    expect(instant).toBe('2026-11-12 02:45:00');
  });
});

describe('the functions of the worker', () => {
  const describeFunction = async (signature: string) =>
    (await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; config: string[] | null; definer: boolean }> }>(
      `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
              coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl, p.proconfig as config, p.prosecdef as definer
       from pg_proc p where p.oid = ?::regprocedure`, [signature]
    )).rows[0];

  it.each([
    'app_private.enqueue_approval_reminders()',
    'app_private.claim_notification_batch(integer)',
    'app_private.recheck_notifications(uuid[], uuid)'
  ])('opens %s to the application role alone, as a definer function with an empty search path', async (signature) => {
    expect(await describeFunction(signature)).toEqual({ app: true, public_acl: false, config: ['search_path=""'], definer: true });
  });

  it.each([
    'app_private.notification_item_round(text, uuid, uuid)',
    'app_private.notification_item_still_holds(text, uuid, uuid, uuid, uuid)',
    'app_private.notification_item_still_holds(text, uuid, uuid, uuid)'
  ])('keeps %s internal: nobody but the functions that call it runs it', async (signature) => {
    expect(await describeFunction(signature)).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: false });
  });

  it('keeps the instant of the reminders to the owner: the function that takes one is closed to the application role, and the worker has one function of that name, with no argument', async () => {
    expect(await describeFunction('app_private.enqueue_approval_reminders_at(timestamptz)')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: true });
    const named = await owner().raw<{ rows: Array<{ arguments: string }> }>(
      `select pg_get_function_arguments(p.oid) as arguments from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = 'enqueue_approval_reminders'`
    );
    expect(named.rows).toEqual([{ arguments: '' }]);
  });

  it('refuses the application role the function that takes an instant, whatever the instant, and enqueues nothing', async () => {
    const { content, round } = await waiting(1);
    for (const instant of ['pg_catalog.now()', "pg_catalog.now() - interval '1 day'", "pg_catalog.now() - interval '31 days'", 'null::timestamptz']) {
      await expect(asWorker((t) => t.raw(`select app_private.enqueue_approval_reminders_at(${instant})`)), instant).rejects.toMatchObject({ code: '42501' });
    }
    expect(await remindersOf(content)).toEqual([]);
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: null });
  });

  it('runs the function of the owner at the instant of the transaction when the worker asks: the text of the entrance says so', async () => {
    const source = await f.sql<string>(`select pg_get_functiondef(p.oid) as value from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = 'enqueue_approval_reminders'`);
    expect(source).toContain('enqueue_approval_reminders_at(pg_catalog.now())');
  });

  it('returns the deadline, the note and the batch of the round, and no column of who sent it', async () => {
    for (const signature of ['app_private.claim_notification_batch(integer)', 'app_private.recheck_notifications(uuid[], uuid)']) {
      const columns = await f.sql<string>('select pg_get_function_result(?::regprocedure) as value', [signature]);
      expect(columns, signature).toMatch(/content_publish_on date, approval_due_on date, approval_note text, approval_batch_id uuid\)?$/);
      expect(columns, signature).not.toMatch(/sent_by|sequence|reminded/);
    }
  });

  it('refuses a person of the agency and a person of the portal with 42501, and enqueues nothing', async () => {
    const { content } = await waiting(1);
    for (const user of [ids.adminA, ids.portalA1]) {
      await expect(w.asUser(user, (t) => t.raw('select app_private.enqueue_approval_reminders()'))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('worker') });
    }
    expect(await remindersOf(content)).toEqual([]);
    expect(await enqueue()).toBe(PEOPLE);
  });

  it.each(['repeatable read', 'serializable'] as const)('refuses %s, which would read a snapshot older than the locks it waits for, with 40001', async (level) => {
    const { content } = await waiting(1);
    await expect(asWorker(async (t) => { await t.raw('select 1'); return enqueueIn(t); }, level)).rejects.toMatchObject({ code: '40001' });
    expect(await remindersOf(content)).toEqual([]);
  });

  it('keeps the rule of four arguments as the rule of five without a round, and a reminder never holds without its own round', async () => {
    const { client, content, round } = await waiting(1);
    const other = await waiting(1);
    const access = (await accessesOf(client))[0]!;
    const holds5 = (type: string, roundId: string | null): Promise<boolean> =>
      f.sql<boolean>('select app_private.notification_item_still_holds(?, ?::uuid, ?::uuid, ?::uuid, ?::uuid) as value', [type, client, access, content, roundId]);
    const holds4 = (type: string): Promise<boolean> =>
      f.sql<boolean>('select app_private.notification_item_still_holds(?, ?::uuid, ?::uuid, ?::uuid) as value', [type, client, access, content]);

    expect(await holds4('content_awaiting_approval')).toBe(true);
    expect(await holds5('content_awaiting_approval', null)).toBe(true);
    expect(await holds5('content_published', null)).toBe(false);
    expect(await holds5(DUE_SOON, round)).toBe(true);
    expect(await holds5(OVERDUE, round)).toBe(true);
    expect(await holds5(DUE_SOON, null)).toBe(false);
    expect(await holds4(DUE_SOON)).toBe(false);
    expect(await holds5(DUE_SOON, other.round)).toBe(false);
    expect(await holds5(DUE_SOON, randomUUID())).toBe(false);

    // An item names its client twice (its own column and the one of its content): the rule holds only when they agree.
    const otherClient = (await waiting(1)).client;
    const holdsOf = (type: string, clientId: string, accessId: string): Promise<boolean> =>
      f.sql<boolean>('select app_private.notification_item_still_holds(?, ?::uuid, ?::uuid, ?::uuid, ?::uuid) as value', [type, clientId, accessId, content, type === 'content_awaiting_approval' ? null : round]);
    expect(await holdsOf('content_awaiting_approval', client, access)).toBe(true);
    expect(await holdsOf('content_awaiting_approval', otherClient, access)).toBe(false);
    expect(await holdsOf(DUE_SOON, otherClient, access)).toBe(false);
    expect(await holdsOf('content_awaiting_approval', client, (await accessesOf(otherClient))[0]!)).toBe(false);
  });

  it('takes the clients in key order before it waits for any of them, in the enqueue and in the recheck: the order is written in the statement', async () => {
    for (const name of ['enqueue_approval_reminders_at', 'recheck_notifications']) {
      const source = await f.sql<string>(`select pg_get_functiondef(p.oid) as value from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = ?`, [name]);
      expect(source, name).toMatch(/order by client\.id\s+for share of client;/);
    }
  });
});

// ---- who is reminded, and when ----------------------------------------------------------------------------------------------

describe('the reminder of the eve and of the day after', () => {
  it('enqueues "due tomorrow" for each person active on the portal, bound to the round and due at once, and stamps the round', async () => {
    const { client, content, round } = await waiting(1, { note: 'Prazo curto' });
    expect(await remindersOf(content)).toEqual([]);

    expect(await enqueue()).toBe(PEOPLE);

    const rows = await remindersOf(content);
    expect(rows).toHaveLength(PEOPLE);
    expect(recipientsOf(rows)).toEqual(await accessesOf(client));
    for (const row of rows) {
      expect(row).toMatchObject({
        type: DUE_SOON, client_id: client, content_id: content, approval_round_id: round,
        sent_at: null, discarded_at: null, claimed_at: null, claim_token: null, attempts: 0, last_error: null
      });
      expect((row.send_after as Date).getTime()).toBe((row.created_at as Date).getTime());
    }
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: expect.any(Date), reminded_overdue_at: null });
  });

  it('enqueues "overdue" the day after the deadline, to the same people, and stamps only its own mark', async () => {
    const { client, content, round } = await waiting(-1);

    expect(await enqueue()).toBe(PEOPLE);

    const rows = await remindersOf(content);
    expect(rows).toHaveLength(PEOPLE);
    expect(recipientsOf(rows)).toEqual(await accessesOf(client));
    for (const row of rows) {
      expect(row).toMatchObject({ type: OVERDUE, client_id: client, content_id: content, approval_round_id: round, sent_at: null, discarded_at: null, claimed_at: null, attempts: 0 });
      expect((row.send_after as Date).getTime()).toBe((row.created_at as Date).getTime());
    }
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: expect.any(Date) });
  });

  it.each([-3, -2, 0, 2, 3, 90])('is for the exact day: a deadline %i days from today is neither "due tomorrow" nor "overdue"', async (offset) => {
    const { content, round } = await waiting(offset);
    expect(await enqueue()).toBe(0);
    expect(await remindersOf(content)).toEqual([]);
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: null });
  });

  it('does nothing for a round with no deadline', async () => {
    const { content, round } = await waiting(null);
    expect(await enqueue()).toBe(0);
    expect(await remindersOf(content)).toEqual([]);
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: null });
  });

  it('does nothing for a content that has no round: one that was already waiting before the rounds existed', async () => {
    const client = await f.freshClient();
    const content = await w.seedContent(client, { status: 'awaiting_approval' });
    expect(await enqueue()).toBe(0);
    expect(await remindersOf(content)).toEqual([]);
  });

  it('is owed once per round: a second run enqueues nothing, and neither does a run after the e-mail left', async () => {
    const eve = await waiting(1);
    const day = await waiting(-1);
    expect(await enqueue()).toBe(2 * PEOPLE);
    expect(await enqueue()).toBe(0);
    expect(await remindersOf(eve.content)).toHaveLength(PEOPLE);
    expect(await remindersOf(day.content)).toHaveLength(PEOPLE);

    const batch = await claimOf(eve.content, day.content);
    expect(batch).toHaveLength(2 * PEOPLE);
    expect(await markSent(batch)).toBe(2 * PEOPLE);

    expect(await enqueue()).toBe(0);
    for (const content of [eve.content, day.content]) {
      const rows = await remindersOf(content);
      expect(rows).toHaveLength(PEOPLE);
      expect(rows.every((row) => row.sent_at !== null)).toBe(true);
    }
  });

  it('owes the two reminders of a round independently: the one of the eve does not replace the one of the day after', async () => {
    const { content, round } = await waiting(1);
    expect(await enqueue()).toBe(PEOPLE);

    await age(round, -1, 20);
    expect(await enqueue()).toBe(PEOPLE);

    expect((await remindersOf(content, DUE_SOON)).length).toBe(PEOPLE);
    expect((await remindersOf(content, OVERDUE)).length).toBe(PEOPLE);
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: expect.any(Date), reminded_overdue_at: expect.any(Date) });
    expect(await enqueue()).toBe(0);
  });

  it('goes to the people who are active on the portal today, not to the removed ones', async () => {
    const client = await f.freshClient([ids.portalA1, ids.portalA1Second, ids.dualBare]);
    await setPortalAccessStatus(owner(), client, ids.portalA1Second, 'removed');
    const { content } = await waiting(1, { client });

    expect(await enqueue()).toBe(2);

    const recipients = recipientsOf(await remindersOf(content));
    expect(recipients).toEqual(await accessesOf(client));
    expect(recipients).toHaveLength(2);
  });

  it('enqueues nothing, and is not an error, for a client with nobody on the portal', async () => {
    const client = await f.freshClient([]);
    const { content } = await waiting(1, { client });
    expect(await enqueue()).toBe(0);
    expect(await remindersOf(content)).toEqual([]);
  });

  it('reminds the people of every client in one run, each of the round of its own content', async () => {
    const first = await waiting(1);
    const second = await waiting(-1);
    const third = await waiting(1);

    expect(await enqueue()).toBe(3 * PEOPLE);

    for (const [target, type] of [[first, DUE_SOON], [second, OVERDUE], [third, DUE_SOON]] as const) {
      const rows = await remindersOf(target.content);
      expect(rows.map((row) => [row.type, row.approval_round_id, row.client_id])).toEqual(Array.from({ length: PEOPLE }, () => [type, target.round, target.client]));
    }
  });

  describe('a round sent on the eve itself', () => {
    it('is not reminded of the eve: the e-mail of the send already said so, and the round sent two days before is', async () => {
      const client = await f.freshClient();
      const content = await f.readyContent(client);
      await f.submit(ids.productionA, content, await f.day(1));
      const control = await waiting(1, { sentDaysAgo: 2 });

      expect(await enqueue()).toBe(PEOPLE);

      expect(await remindersOf(content)).toEqual([]);
      expect(await remindersOf(control.content)).toHaveLength(PEOPLE);
      expect((await stampsOf(await latestRound(content))).reminded_due_soon_at).toBeNull();
    });

    // Sao Paulo is three hours behind UTC: a send at night is already the next day in UTC. The day of the send is the day of Sao Paulo.
    it.each([
      ['at 22:30 of the eve, which is already the day of the deadline in UTC', 0, '22:30', false],
      ['at 00:30 of the eve', 0, '00:30', false],
      ['at 21:30 of the day before the eve, which is already the eve in UTC', -1, '21:30', true],
      ['at 23:30 of the day before the eve', -1, '23:30', true]
    ])('is judged by the day of São Paulo: a send %s', async (_label, dayOffset, clock, reminded) => {
      const { content, round } = await waiting(1);
      await owner().raw(
        "update public.content_approval_rounds set sent_at = ((app_private.sao_paulo_date(pg_catalog.now()) + ?::integer)::timestamp + ?::time) at time zone 'America/Sao_Paulo' where id = ?::uuid",
        [dayOffset, clock, round]
      );

      expect(await enqueue()).toBe(reminded ? PEOPLE : 0);
      expect(await remindersOf(content)).toHaveLength(reminded ? PEOPLE : 0);
    });
  });
});

// ---- the day the job reads --------------------------------------------------------------------------------------------------

describe('the day of the reminders is the one of São Paulo at the instant the function of the owner is given, and at now for the worker', () => {
  // Yesterday (or today, at midnight) at a clock of São Paulo, as a UTC instant. São Paulo is three hours behind UTC, so from 21:00 on the
  // UTC date is already the next day of São Paulo.
  const instantOf = (dayOffset: number, clock: string): Promise<string> =>
    f.sql(
      `select to_char((((app_private.sao_paulo_date(pg_catalog.now()) + ?::integer)::timestamp + ?::time) at time zone 'America/Sao_Paulo') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as value`,
      [dayOffset, clock]
    );

  it.each([
    ['00:00:00 of today, the first second of the day', 0, '00:00:00'],
    ['00:30 of yesterday', -1, '00:30:00'],
    ['20:59:59 of yesterday, the last second the UTC date is the same', -1, '20:59:59'],
    ['21:00:00 of yesterday, the first second the UTC date is the next day', -1, '21:00:00'],
    ['22:30 of yesterday', -1, '22:30:00'],
    ['23:59:59 of yesterday, the last second of the day', -1, '23:59:59']
  ])('at %s, the eve and the day after are the ones of São Paulo and no other round is reminded', async (_label, dayOffset, clock) => {
    const soon = await waiting(dayOffset + 1);
    const late = await waiting(dayOffset - 1);
    const others = [await waiting(dayOffset), await waiting(dayOffset + 2), await waiting(dayOffset - 2)];

    expect(await enqueueAt(await instantOf(dayOffset, clock))).toBe(2 * PEOPLE);

    expect((await remindersOf(soon.content)).map((row) => row.type)).toEqual(Array.from({ length: PEOPLE }, () => DUE_SOON));
    expect((await remindersOf(late.content)).map((row) => row.type)).toEqual(Array.from({ length: PEOPLE }, () => OVERDUE));
    for (const other of others) expect(await remindersOf(other.content)).toEqual([]);
    expect(await stampsOf(soon.round)).toEqual({ reminded_due_soon_at: expect.any(Date), reminded_overdue_at: null });
    expect(await stampsOf(late.round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: expect.any(Date) });
  });

  it('refuses a missing instant with 22023, which would match no round and say nothing, and stamps nothing', async () => {
    const { content, round } = await waiting(1);

    await expect(enqueueAt(null as never)).rejects.toMatchObject({ code: '22023' });

    expect(await remindersOf(content)).toEqual([]);
    expect(await stampsOf(round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: null });
  });

  it('reads the day of now when the worker asks: the eve and the day after of today, and no day made up for', async () => {
    const soon = await waiting(1);
    const late = await waiting(-1);
    const others = [await waiting(0), await waiting(2), await waiting(-2), await waiting(3), await waiting(-3), await waiting(31), await waiting(-30)];

    expect(await enqueue()).toBe(2 * PEOPLE);

    expect((await remindersOf(soon.content)).map((row) => row.type)).toEqual(Array.from({ length: PEOPLE }, () => DUE_SOON));
    expect((await remindersOf(late.content)).map((row) => row.type)).toEqual(Array.from({ length: PEOPLE }, () => OVERDUE));
    for (const other of others) {
      expect(await remindersOf(other.content)).toEqual([]);
      expect(await stampsOf(other.round)).toEqual({ reminded_due_soon_at: null, reminded_overdue_at: null });
    }
  });
});

// ---- what stops a reminder --------------------------------------------------------------------------------------------------

describe.each([[1, DUE_SOON], [-1, OVERDUE]] as const)('a reminder with the deadline %i days from today (%s)', (dueOffset, type) => {
  const expectOnlyTheControl = async (target: Waiting, control: Waiting): Promise<void> => {
    expect(await enqueue()).toBe(PEOPLE);
    expect(await remindersOf(target.content)).toEqual([]);
    const rows = await remindersOf(control.content, type);
    expect(recipientsOf(rows)).toEqual(await accessesOf(control.client));
  };

  it.each([
    ['the content went back to adjustment', ({ content }: Waiting) => f.requestChanges(ids.portalA1, content)],
    ['the content was approved', ({ content }: Waiting) => approveAs(ids.portalA1, content)],
    ['the content was cancelled', async ({ content }: Waiting) => { await w.asUser(ids.adminA, (t) => t.raw('select app_private.cancel_content(?::uuid)', [content])); }],
    ['a newer round replaced it', ({ content }: Waiting) => sendAgain(content)],
    ['the client was archived', ({ client }: Waiting) => w.archiveClient(client)]
  ])('is not enqueued once %s', async (_label, stop) => {
    const control = await waiting(dueOffset);
    const target = await waiting(dueOffset);
    await stop(target);

    await expectOnlyTheControl(target, control);
  });

  it.each([
    ['the agency was suspended', () => owner()('agencies').where({ id: ids.agencyB }).update({ status: 'suspended' })],
    ['the trial of the agency ended and it is read only', () => owner()('agencies').where({ id: ids.agencyB }).update({
      plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
    })]
  ])('is not enqueued once %s, and the enqueue of the other agencies still runs', async (_label, stop) => {
    const control = await waiting(dueOffset);
    const target = await waitingInB(dueOffset);
    const before = await owner()('agencies').where({ id: ids.agencyB }).first('status', 'plan', 'trial_ends_at', 'trial_owner_email_key');
    try {
      await stop();
      await expectOnlyTheControl(target, control);
    } finally {
      await owner()('agencies').where({ id: ids.agencyB }).update(before);
    }
  });

  it('is enqueued for the round after a withdrawn approval, which returns the content to the SAME round', async () => {
    const { client, content, round } = await waiting(dueOffset);
    await approveAs(ids.portalA1, content);
    const revision = (await w.contentRow(content)).revision as number;
    await w.asUser(ids.portalA1, (t) => t.raw('select app_private.withdraw_content_approval(?::uuid, ?::integer)', [content, revision]));
    expect(await latestRound(content)).toBe(round);

    expect(await enqueue()).toBe(PEOPLE);

    const rows = await remindersOf(content, type);
    expect(recipientsOf(rows)).toEqual(await accessesOf(client));
    expect(rows.every((row) => row.approval_round_id === round)).toBe(true);
  });

  it('goes to the newest round, and to none of the older ones, when the content was sent again with the same deadline', async () => {
    const { client, content, round } = await waiting(dueOffset);
    await sendAgain(content, 'Rodada com prazo');
    const second = await latestRound(content);
    expect(second).not.toBe(round);
    await age(second, dueOffset);

    expect(await enqueue()).toBe(PEOPLE);

    const rows = await remindersOf(content);
    expect(recipientsOf(rows)).toEqual(await accessesOf(client));
    expect(rows.every((row) => row.approval_round_id === second && row.type === type)).toBe(true);
  });

  it('is moved to the new round when the open reminder of the old one was never claimed, and left alone when it was', async () => {
    const { client, content } = await waiting(dueOffset);
    expect(await enqueue()).toBe(PEOPLE);
    const [claimed, unclaimed] = await remindersOf(content, type);
    await owner()('notification_queue').where({ id: unclaimed!.id }).update({ attempts: 3, last_error: 'smtp_timeout', send_after: owner().raw("now() + interval '1 hour'") });
    await owner()('notification_queue').where({ id: claimed!.id }).update({ claimed_at: owner().raw('now()'), claim_token: randomUUID(), attempts: 1 });

    await sendAgain(content, 'Rodada que substitui');
    const second = await latestRound(content);
    await age(second, dueOffset);
    expect(await enqueue()).toBe(1);

    const rows = await remindersOf(content);
    expect(rows).toHaveLength(PEOPLE);
    expect(recipientsOf(rows)).toEqual(await accessesOf(client));
    const moved = rows.find((row) => row.id === unclaimed!.id)!;
    const held = rows.find((row) => row.id === claimed!.id)!;
    expect(moved).toMatchObject({ approval_round_id: second, attempts: 0, last_error: null, claimed_at: null });
    expect((moved.send_after as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(held).toMatchObject({ approval_round_id: expect.not.stringMatching(second), attempts: 1, last_error: null });
  });
});

// ---- the claim and the recheck ----------------------------------------------------------------------------------------------

describe('what the claim and the recheck hand over of an approval', () => {
  it.each([[1, DUE_SOON], [-1, OVERDUE]] as const)('hand the deadline, the note and the batch of the round of the item, with a reminder of %i days', async (dueOffset, type) => {
    const { content } = await waiting(dueOffset, { note: 'Confirme até o prazo' });
    const [round] = await f.roundsOf(content);
    expect(await enqueue()).toBe(PEOPLE);

    const claimed = await claimOf(content);

    expect(claimed).toHaveLength(PEOPLE);
    for (const row of claimed) {
      expect(row).toMatchObject({ notification_type: type, approval_due_on: await f.day(dueOffset), approval_note: 'Confirme até o prazo', approval_batch_id: round!.batch_id });
    }
    expect(await recheck(claimed)).toEqual(claimed);
  });

  it('hand the LATEST round of the content with "to approve": its deadline, its note and its batch', async () => {
    const client = await f.freshClient();
    const content = await f.readyContent(client);
    await f.submit(ids.productionA, content, await f.day(3), 'Primeira rodada');
    await f.requestChanges(ids.portalA1, content);
    await f.submit(ids.productionA, content, await f.day(6), 'Segunda rodada');
    const second = (await f.roundsOf(content))[1]!;
    await owner().raw('update public.notification_queue set send_after = created_at where content_id = ?::uuid', [content]);

    const claimed = await claimOf(content);

    expect(claimed).toHaveLength(PEOPLE);
    for (const row of claimed) {
      expect(row).toMatchObject({ notification_type: 'content_awaiting_approval', approval_due_on: await f.day(6), approval_note: 'Segunda rodada', approval_batch_id: second.batch_id });
    }
    expect(await recheck(claimed)).toEqual(claimed);
  });

  it('hand nothing of the round with "published", although the content has one, and with "to approve" of a content that has no round', async () => {
    const client = await f.freshClient();
    const content = await f.readyContent(client);
    await f.submit(ids.productionA, content, await f.day(3), 'Para aprovar');
    await approveAs(ids.portalA1, content);
    await w.asUser(ids.productionA, async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await f.day(0)]));
    await owner().raw('update public.notification_queue set send_after = created_at where content_id = ?::uuid', [content]);
    const legacy = await w.seedContent(client, { status: 'awaiting_approval' });
    expect(await f.roundsOf(content)).toHaveLength(1);

    const claimed = await claimOf(content);

    expect(claimed).toHaveLength(PEOPLE);
    for (const row of claimed) {
      expect(row).toMatchObject({ notification_type: 'content_published', approval_due_on: null, approval_note: null, approval_batch_id: null });
    }
    expect(await recheck(claimed)).toEqual(claimed);

    // A content that was already waiting before the rounds has none: the "to approve" item of it says so with nulls.
    const access = (await accessesOf(client))[0]!;
    await owner()('notification_queue').insert({ type: 'content_awaiting_approval', client_id: client, recipient_portal_access_id: access, content_id: legacy, send_after: owner().raw("now() - interval '1 minute'") });
    expect(await claimOf(legacy)).toEqual([expect.objectContaining({ approval_due_on: null, approval_note: null, approval_batch_id: null })]);
  });

  it.each([
    ['the content went back to adjustment', ({ content }: Waiting) => f.requestChanges(ids.portalA1, content), 0],
    ['the content was sent again and a newer round replaced the round', ({ content }: Waiting) => sendAgain(content), 0],
    ['one of the two people was removed from the portal', ({ client }: Waiting) => setPortalAccessStatus(owner(), client, ids.portalA1Second, 'removed'), 1],
    ['the client was archived', ({ client }: Waiting) => w.archiveClient(client), 0]
  ])('discard what stopped being true, at the claim and at the recheck: %s', async (_label, change, kept) => {
    for (const dueOffset of [1, -1]) {
      for (const through of ['claim', 'recheck'] as const) {
        const target = await waiting(dueOffset);
        await enqueue();
        const batch = through === 'recheck' ? await claimOf(target.content) : [];
        if (through === 'recheck') expect(batch).toHaveLength(PEOPLE);

        await change(target);
        const handedOver = through === 'recheck' ? await recheck(batch) : await claimOf(target.content);

        const expectedRecipients = kept === 0 ? [] : await accessesOf(target.client);
        expect(recipientsOf(handedOver), `${dueOffset} through the ${through}`).toEqual(expectedRecipients);
        expect(discarded(await remindersOf(target.content)), `${dueOffset} through the ${through}`).toHaveLength(PEOPLE - kept);
      }
    }
  });

  it('hand a reminder that still holds, once more, while it is neither sent nor discarded', async () => {
    const { content } = await waiting(1);
    await enqueue();
    const claimed = await claimOf(content);
    expect(claimed).toHaveLength(PEOPLE);

    expect(await recheck(claimed)).toEqual(claimed);
    expect(discarded(await remindersOf(content))).toEqual([]);
  });
});

describe('what the worker does with a reminder it holds', () => {
  const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
  const issue = (item: Claimed, tokenHash = sha(randomUUID())): Promise<unknown> =>
    asWorker((t) => t.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?) as expires_at', [[item.item_id] as never, item.claim_token, tokenHash]));

  it.each([1, -1] as const)('issues the approval link of a reminder of %i days, which opens the content', async (dueOffset) => {
    const { content } = await waiting(dueOffset);
    await enqueue();
    const [item] = await claimOf(content);
    const tokenHash = sha(randomUUID());

    await expect(issue(item!, tokenHash)).resolves.toBeDefined();

    const opened = await owner()('client_portal_approval_link_contents as linked')
      .join('client_portal_approval_links as link', 'link.id', 'linked.link_id')
      .where('link.token_hash', tokenHash)
      .select('linked.content_id');
    expect(opened).toEqual([{ content_id: content }]);
  });

  it('still refuses the link of a "published" item: its e-mail has nothing to approve', async () => {
    const client = await f.freshClient();
    const content = await f.readyContent(client);
    await f.submit(ids.productionA, content);
    await approveAs(ids.portalA1, content);
    await w.asUser(ids.productionA, async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await f.day(0)]));
    await owner().raw('update public.notification_queue set send_after = created_at where content_id = ?::uuid', [content]);
    const published = (await claimOf(content)).filter((row) => row.notification_type === 'content_published');
    expect(published).toHaveLength(PEOPLE);

    await expect(issue(published[0]!)).rejects.toMatchObject({ code: 'A0101' });
  });

  it('marks it as sent or as failed like any other item of the queue', async () => {
    const eve = await waiting(1);
    const day = await waiting(-1);
    await enqueue();
    const batch = await claimOf(eve.content, day.content);
    expect(batch).toHaveLength(2 * PEOPLE);

    expect(await markSent(batch.filter((row) => row.content_id === eve.content))).toBe(PEOPLE);
    expect(await fail(batch.filter((row) => row.content_id === day.content), 'smtp_timeout')).toBe(PEOPLE);

    expect((await remindersOf(eve.content)).every((row) => row.sent_at !== null && row.last_error === null)).toBe(true);
    for (const row of await remindersOf(day.content)) {
      expect(row).toMatchObject({ sent_at: null, claim_token: null, claimed_at: null, last_error: 'smtp_timeout', attempts: 1 });
    }
  });
});

// ---- two workers, and an archive in flight ----------------------------------------------------------------------------------

describe('the enqueue against others at the same time', () => {
  it('owes each reminder to one worker: the second waits for the first, then finds both stamped and enqueues nothing', async () => {
    const eve = await waiting(1);
    const day = await waiting(-1);

    const first = await worker.knex.transaction();
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      expect(await enqueueIn(first)).toBe(2 * PEOPLE);
      second = asWorker(enqueueIn).then((enqueued) => enqueued, (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toBe(0);
    expect(await remindersOf(eve.content)).toHaveLength(PEOPLE);
    expect(await remindersOf(day.content)).toHaveLength(PEOPLE);
  });

  // A UUID is random: two clients are made until the one created FIRST has the higher key, so the order the rows come out of the table in
  // is the opposite of the key order. In key order the worker takes the low client before it waits for the high one.
  const twoClientsInReverseKeyOrder = async (): Promise<{ high: string; low: string }> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const first = await f.freshClient();
      const second = await f.freshClient();
      if (first > second) return { high: first, low: second };
    }
    throw new Error('Thirty pairs of random keys never came out in descending order.');
  };

  it('takes the clients in key order, so an archive that holds the high one is waited for while the low one is already held', async () => {
    const { high, low } = await twoClientsInReverseKeyOrder();
    await waiting(1, { client: high });
    await waiting(1, { client: low });

    const holder = await owner().transaction();
    let outcome: Promise<unknown> | undefined;
    try {
      await holder.raw('select id from public.clients where id = ?::uuid for update', [high]);
      const holderPid = await backendPid(holder);
      outcome = asWorker(enqueueIn).then((enqueued) => enqueued, (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), holderPid);

      await expect(owner().transaction((probe) => probe.raw('select id from public.clients where id = ?::uuid for update nowait', [low]))).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.rollback();
    }

    expect(await outcome).toBe(2 * PEOPLE);
  });

  // The archive of a client is a plain UPDATE of its row (the daily job) or the function the agency calls: the worker waits for either, and a
  // reminder due the eve and one due the day after are each in the set of clients it locks.
  it.each([
    ['the function archive_client', 1], ['the function archive_client', -1], ['a plain UPDATE of the client', 1], ['a plain UPDATE of the client', -1]
  ] as const)('waits for an archive by %s that is not committed, and then enqueues nothing for the archived client (deadline %i days away)', async (how, dueOffset) => {
    const archived = await waiting(dueOffset);
    const control = await waiting(dueOffset);

    const archiving = how === 'the function archive_client' ? await w.openTransactionAs(ids.adminA) : await owner().transaction();
    const archivingPid = await backendPid(archiving);
    let outcome: Promise<unknown> | undefined;
    try {
      if (how === 'the function archive_client') await archiving.raw('select app_private.archive_client(?::uuid)', [archived.client]);
      else await archiving.raw("update public.clients set status = 'archived', archived_at = now() where id = ?::uuid", [archived.client]);
      outcome = asWorker(enqueueIn).then((enqueued) => enqueued, (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toBe(PEOPLE);
    expect(await remindersOf(archived.content)).toEqual([]);
    expect(await remindersOf(control.content)).toHaveLength(PEOPLE);
  });
});
