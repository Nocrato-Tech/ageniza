import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, waitForBackendsBlockedBy, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';
import { setPortalAccessStatus } from './support/portal-access.js';
import { askedAtOrAfter, callAtInstant } from './support/pinned-clock.js';

// Scope redesign-igual, subtask W11-S1: the request for changes on an APPROVED content against whatever else moves the same content, with two
// real transactions, through the portal (the link of the e-mail does not take the new rule). The function takes the share lock of the client and then the lock of the
// content (the order of the archive and of every edit) and adds no lock of its own for the new transition: the one that waited reads the state, the revision and the planned day of the row AFTER the wait, and judges the day by the
// clock of that moment. The holder is always the transaction that came first; the one under test is asked to wait for it
// (`waitForBackendsBlockedBy`), never by a sleep.
const w = createContentWorld('w11s1-race');
const { ids } = w;
const a = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
const owner = (): Knex => w.getOwner().knex;

let worker: DatabaseClient;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
  await a.waitForQuietClock();
}, 300_000);

afterAll(async () => {
  try {
    await a.cleanUp();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

const COMMENT = 'Troque a foto da capa';
const settle = (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);
const rowOf = (content: string): Promise<Record<string, unknown>> => w.contentRow(content);
const threadsOf = (content: string): Promise<unknown[]> => owner()('client_threads').where({ content_id: content });
const commentsOf = (content: string): Promise<unknown[]> =>
  owner()('client_thread_comments').whereIn('thread_id', owner()('client_threads').where({ content_id: content }).select('id')).select('body');
const notificationsOf = (content: string): Promise<unknown[]> => owner()('notifications').where({ content_id: content }).select('kind');

interface Door {
  readonly name: string;
  /** Who is bound in the transaction of the call: no one for the link. */
  readonly actor: string | null;
  /** An approved reels with a confirmed video, planned on `day`, that this door reaches. */
  seedOn(day: string): Promise<string>;
  open(): Promise<Knex.Transaction>;
  call(transaction: Knex.Transaction, content: string, revision: number): Promise<unknown>;
}

const attachVideo = async (content: string, clientId: string): Promise<void> => {
  await w.attach(content, [await w.seedAsset(clientId, await w.folderOf(clientId), { category: 'video' })]);
};

const portalDoor = (): Door => ({
  name: 'the portal',
  actor: ids.portalA1,
  seedOn: async (day) => {
    const content = await w.seedContent(ids.clientA1, { status: 'approved', publishOn: day });
    await attachVideo(content, ids.clientA1);
    return content;
  },
  open: () => w.openTransactionAs(ids.portalA1),
  call: (transaction, content, revision) =>
    transaction.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision, COMMENT])
});

const request = async (door: Door, content: string, revision = 1): Promise<void> => {
  const transaction = await door.open();
  try {
    await door.call(transaction, content, revision);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

const publish = async (content: string): Promise<void> => {
  await w.asUser(ids.adminA, async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await a.day(0)]));
};

/**
 * Runs `holder` in a transaction that is open, starts `waiting` while it is, and commits the holder once `waiting` is blocked by it. Returns what
 * the waiting call answered: undefined when it went through, the error otherwise.
 */
const heldWhile = async (
  open: () => Promise<Knex.Transaction>,
  holder: (transaction: Knex.Transaction) => Promise<unknown>,
  waiting: () => Promise<unknown>
): Promise<unknown> => {
  const first = await open();
  const pid = await backendPid(first);
  let second: Promise<unknown> | undefined;
  try {
    await holder(first);
    second = settle(waiting());
    await waitForBackendsBlockedBy(owner(), pid);
  } catch (error) {
    await first.rollback();
    await second;
    throw error;
  }
  await first.commit();
  return second;
};

const byAgency = (): Promise<Knex.Transaction> => w.openTransactionAs(ids.productionA);
const today = 'app_private.sao_paulo_date(pg_catalog.now())';

describe('the portal: a request for changes on an approved content, against what else moves the content', () => {
  const door = portalDoor();
  const approved = async (offset: number): Promise<string> => door.seedOn(await a.day(offset));

  it('finds the content published when the publication held the row first: A0062, and no comment, thread or notification', async () => {
    const content = await approved(3);

    const answer = await heldWhile(() => w.openTransactionAs(ids.adminA), async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await a.day(0)]), () => request(door, content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'published' });
    expect(await threadsOf(content)).toEqual([]);
    expect(await notificationsOf(content)).toEqual([]);
  });

  it('makes the publication that waited find the content in adjustment when the request held the row first: A0062, and one comment', async () => {
    const content = await approved(3);

    const answer = await heldWhile(door.open, (t) => door.call(t, content, 1), () => publish(content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', published_on: null, published_at: null, approved_by: null });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT }]);
    expect(await notificationsOf(content)).toEqual([{ kind: 'content_changes_requested' }]);
  });

  it('reads the planned day after the wait: the agency moved it to today and held the row, so the request is refused and writes nothing', async () => {
    const content = await approved(3);

    const answer = await heldWhile(byAgency, (t) => t('contents').where({ id: content }).update({ publish_on: t.raw(today) }), () => request(door, content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
    expect(await threadsOf(content)).toEqual([]);
    expect(await notificationsOf(content)).toEqual([]);
  });

  it('reads the planned day after the wait, the other way: the agency moved it from today to tomorrow, so the request that waited is accepted', async () => {
    const content = await approved(0);

    const answer = await heldWhile(byAgency, (t) => t('contents').where({ id: content }).update({ publish_on: t.raw(`${today} + 1`) }), () => request(door, content));

    expect(answer).toBeUndefined();
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT }]);
  });

  it('takes no lock the edit does not: an edit of the title that holds the row does not deadlock with the request', async () => {
    const content = await approved(3);

    const answer = await heldWhile(byAgency, (t) => t('contents').where({ id: content }).update({ title: 'Título novo' }), () => request(door, content));

    expect(answer).toBeUndefined();
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', title: 'Título novo' });
  });

  it('lets only one of two requests at the same moment move the content: the one that waited finds it in adjustment, with one comment and one notification', async () => {
    const content = await approved(3);

    const answer = await heldWhile(door.open, (t) => door.call(t, content, 1), () => request(door, content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT }]);
    expect(await notificationsOf(content)).toEqual([{ kind: 'content_changes_requested' }]);
  });

  it('refuses the revision the person saw when the agency edited the caption, which sent the approved content back to waiting with a new revision, and writes nothing', async () => {
    const content = await approved(3);

    const answer = await heldWhile(byAgency, (t) => t('contents').where({ id: content }).update({ caption: 'Legenda nova' }), () => request(door, content, 1));

    expect(answer).toMatchObject({ code: 'A0063' });
    expect(await rowOf(content)).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    expect(await threadsOf(content)).toEqual([]);
  });
});

describe('the request for changes of the portal on an approved content, against the client and its own account', () => {
  const door = portalDoor();

  it('judges a request that waited for the client undoing the approval as one on a content awaiting approval, which is the old rule and is accepted', async () => {
    const content = await door.seedOn(await a.day(0));

    const answer = await heldWhile(
      () => w.openTransactionAs(ids.portalA1),
      (t) => t.raw('select app_private.withdraw_content_approval(?::uuid, ?::integer)', [content, 1]),
      () => w.asUser(ids.portalA1Second, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, COMMENT]))
    );

    expect(answer).toBeUndefined();
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', approved_by: null });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT }]);
  });

  it('checks again, after the lock, that the person is still of the portal: removed while the request waited for the row, it answers "not found" and writes nothing', async () => {
    const content = await door.seedOn(await a.day(3));
    const holder = await byAgency();
    const pid = await backendPid(holder);
    let asking: Promise<unknown> | undefined;

    try {
      await holder('contents').where({ id: content }).update({ title: 'Título novo' });
      asking = settle(w.asUser(ids.portalA1Second, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, COMMENT])));
      await waitForBackendsBlockedBy(owner(), pid);
      await setPortalAccessStatus(owner(), ids.clientA1, ids.portalA1Second, 'removed');
    } finally {
      await holder.commit();
    }

    try {
      expect(await asking).toMatchObject({ code: 'A0060' });
      expect(await rowOf(content)).toMatchObject({ status: 'approved', title: 'Título novo', approved_by: ids.portalA1 });
      expect(await threadsOf(content)).toEqual([]);
      expect(await commentsOf(content)).toEqual([]);
      expect(await notificationsOf(content)).toEqual([]);
    } finally {
      await setPortalAccessStatus(owner(), ids.clientA1, ids.portalA1Second, 'active');
    }
  });

  it('waits for the archiving of the client, which cancels its contents, then answers "not found" and writes no comment', async () => {
    const content = await w.seedContent(ids.clientA2, { status: 'approved', publishOn: await a.day(3) });
    await attachVideo(content, ids.clientA2);

    const answer = await heldWhile(
      () => w.openTransactionAs(ids.adminA),
      (t) => t.raw('select app_private.archive_client(?::uuid)', [ids.clientA2]),
      () => w.asUser(ids.portalA2, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, COMMENT]))
    );

    try {
      expect(answer).toMatchObject({ code: 'A0060' });
      expect(await rowOf(content)).toMatchObject({ status: 'cancelled' });
      expect(await threadsOf(content)).toEqual([]);
      expect(await notificationsOf(content)).toEqual([]);
    } finally {
      await w.reactivateClient(ids.clientA2);
    }
  });
});

describe('the portal: the clock of the day is the one of the moment the request gets the lock', () => {
  const door = portalDoor();

  it('asks the day of São Paulo at an instant after the wait, not at the one the transaction began', async () => {
    const content = await door.seedOn('2031-03-14');
    const holder = await byAgency();
    const pid = await backendPid(holder);
    let released = '';
    let asking: ReturnType<typeof callAtInstant<boolean>> | undefined;

    try {
      await holder('contents').where({ id: content }).update({ title: 'Título novo' });
      asking = callAtInstant(owner(), '2031-03-13T12:00:00-03:00', door.actor, (t) => door.call(t, content, 1), (t) => askedAtOrAfter(t, released));
      void asking.catch(() => undefined);
      await waitForBackendsBlockedBy(owner(), pid);
      released = (await holder.raw<{ rows: Array<{ now: string }> }>('select pg_catalog.clock_timestamp()::pg_catalog.text as now')).rows[0]!.now;
    } finally {
      await holder.commit();
    }

    expect(await asking).toEqual({ ok: true, read: true });
  });

  it('judges by the clock of the wait a request that began on the eve and got the lock on the planned day: the day moved while it waited', async () => {
    const content = await door.seedOn('2031-03-14');
    const holder = await byAgency();
    const pid = await backendPid(holder);
    let asking: Promise<unknown> | undefined;

    try {
      await holder('contents').where({ id: content }).update({ title: 'Título novo' });
      // The stand-in answers the day of the instant it is asked about, moved by the time the transaction has run: the eve at 23:59:59 for a
      // function that asks at once, and the planned day for one that asks after the wait.
      asking = callAtInstant(owner(), '2031-03-13T23:59:59-03:00', door.actor, (t) => door.call(t, content, 1), async () => true);
      void settle(asking);
      await waitForBackendsBlockedBy(owner(), pid);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    } finally {
      await holder.commit();
    }

    expect(await asking).toEqual({ ok: false, code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
  });
});
