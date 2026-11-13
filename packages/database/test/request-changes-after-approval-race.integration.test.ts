import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';
import { askedAtOrAfter, callAtInstant } from './support/pinned-clock.js';

// Scope redesign-igual, subtask W11-S1: the request for changes on an APPROVED content against whatever else moves the same content, with two
// real transactions. The function takes the lock of the client (FOR SHARE) and then the one of the content (FOR UPDATE), the order of the
// archive and of every edit, and it adds no lock of its own for the new transition: the one that waited reads the state, the revision and the
// planned day of the row AFTER the wait, and judges the day by the clock of that moment. The holder is always the transaction that came first;
// the one under test is asked to wait for it (`waitForBackendsBlockedBy`), never by a sleep.
const w = createContentWorld('w11s1-race');
const { ids } = w;
const a = createApprovalFixtures(w);
const owner = (): Knex => w.getOwner().knex;

beforeAll(async () => {
  await w.setup();
  await a.waitForQuietClock();
}, 300_000);

afterAll(async () => {
  try {
    await a.cleanUp();
  } finally {
    await w.teardown();
  }
});

const COMMENT = 'Troque a foto da capa';
const settle = (work: Promise<unknown>): Promise<unknown> => work.catch((error: unknown) => error);
const rowOf = (content: string): Promise<Record<string, unknown>> => w.contentRow(content);
const threadsOf = (content: string): Promise<unknown[]> => owner()('client_threads').where({ content_id: content });
const commentsOf = (content: string): Promise<unknown[]> =>
  owner()('client_thread_comments').whereIn('thread_id', owner()('client_threads').where({ content_id: content }).select('id')).select('body', 'author_user_id');
const notificationsOf = (content: string): Promise<unknown[]> => owner()('notifications').where({ content_id: content }).select('kind');

/** An approved reels with a confirmed video, planned `offset` days from today in São Paulo: it can be published and sent again. */
const approved = async (offset: number, clientId = ids.clientA1): Promise<string> => {
  const content = await w.seedContent(clientId, { status: 'approved', publishOn: await a.day(offset) });
  await w.attach(content, [await w.seedAsset(clientId, await w.folderOf(clientId), { category: 'video' })]);
  return content;
};

const requestAs = (user: string, content: string, revision = 1): Promise<unknown> =>
  w.asUser(user, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision, COMMENT]));
const requestIn = (transaction: Knex.Transaction, content: string, revision = 1): Promise<unknown> =>
  transaction.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision, COMMENT]);
const publishAs = (user: string, content: string): Promise<unknown> =>
  w.asUser(user, async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await a.day(0)]));

/**
 * Runs `holder` in a transaction that is open, starts `waiting` while it is, and commits the holder once `waiting` is blocked by it. Returns what
 * the waiting call answered.
 */
const heldWhile = async (
  user: string,
  holder: (transaction: Knex.Transaction) => Promise<unknown>,
  waiting: () => Promise<unknown>
): Promise<unknown> => {
  const first = await w.openTransactionAs(user);
  const pid = await backendPid(first);
  let second: Promise<unknown> | undefined;
  try {
    await holder(first);
    second = settle(waiting());
    await waitForBackendsBlockedBy(owner(), pid);
  } finally {
    await first.commit();
  }
  return second;
};

describe('the request for changes on an approved content against a publication', () => {
  it('finds the content published when the publication held the row first: A0062, and no comment, thread or notification', async () => {
    const content = await approved(3);

    const answer = await heldWhile(
      ids.adminA,
      async (t) => t.raw('select app_private.publish_content(?::uuid, ?::date)', [content, await a.day(0)]),
      () => requestAs(ids.portalA1, content)
    );

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'published' });
    expect(await threadsOf(content)).toEqual([]);
    expect(await notificationsOf(content)).toEqual([]);
  });

  it('makes the publication that waited find the content in adjustment when the request held the row first: A0062, and one comment', async () => {
    const content = await approved(3);

    const answer = await heldWhile(ids.portalA1, (t) => requestIn(t, content), () => publishAs(ids.adminA, content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', published_on: null, published_at: null, approved_by: null });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT, author_user_id: ids.portalA1 }]);
    expect(await notificationsOf(content)).toEqual([{ kind: 'content_changes_requested' }]);
  });
});

describe('the request for changes on an approved content against a change of the planned day', () => {
  it('reads the planned day after the wait: the agency moved it to today and held the row, so the request is refused', async () => {
    const content = await approved(3);

    const answer = await heldWhile(
      ids.productionA,
      (t) => t('contents').where({ id: content }).update({ publish_on: t.raw('app_private.sao_paulo_date(pg_catalog.now())') }),
      () => requestAs(ids.portalA1, content)
    );

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
    expect(await threadsOf(content)).toEqual([]);
    expect(await notificationsOf(content)).toEqual([]);
  });

  it('reads the planned day after the wait, the other way: the agency moved it from today to tomorrow, so the request that waited is accepted', async () => {
    const content = await approved(0);

    const answer = await heldWhile(
      ids.productionA,
      (t) => t('contents').where({ id: content }).update({ publish_on: t.raw('app_private.sao_paulo_date(pg_catalog.now()) + 1') }),
      () => requestAs(ids.portalA1, content)
    );

    expect(answer).not.toBeInstanceOf(Error);
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toHaveLength(1);
  });

  it('takes no lock the edit does not: an edit of the title that holds the row and the share lock of the client does not deadlock with the request', async () => {
    const content = await approved(3);

    const answer = await heldWhile(
      ids.productionA,
      (t) => t('contents').where({ id: content }).update({ title: 'Título novo' }),
      () => requestAs(ids.portalA1, content)
    );

    expect(answer).not.toBeInstanceOf(Error);
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', title: 'Título novo' });
  });
});

describe('the request for changes on an approved content against another decision of the client or the agency', () => {
  it('lets only one of two requests at the same moment move the content: the one that waited finds it in adjustment, with one comment and one notification', async () => {
    const content = await approved(3);

    const answer = await heldWhile(ids.portalA1, (t) => requestIn(t, content), () => requestAs(ids.portalA1Second, content));

    expect(answer).toMatchObject({ code: 'A0062' });
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toEqual([{ body: COMMENT, author_user_id: ids.portalA1 }]);
    expect(await notificationsOf(content)).toEqual([{ kind: 'content_changes_requested' }]);
  });

  it('judges a request that waited for the client undoing the approval as one on a content awaiting approval, which is the old rule and is accepted', async () => {
    const content = await approved(0);

    const answer = await heldWhile(
      ids.portalA1,
      (t) => t.raw('select app_private.withdraw_content_approval(?::uuid, ?::integer)', [content, 1]),
      () => requestAs(ids.portalA1Second, content)
    );

    expect(answer).not.toBeInstanceOf(Error);
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', approved_by: null });
    expect(await commentsOf(content)).toHaveLength(1);
  });

  it('refuses the revision the person saw when the agency edited the caption, which sent the approved content back to waiting with a new revision, and writes nothing', async () => {
    const content = await approved(3);

    const answer = await heldWhile(
      ids.productionA,
      (t) => t('contents').where({ id: content }).update({ caption: 'Legenda nova' }),
      () => requestAs(ids.portalA1, content, 1)
    );

    expect(answer).toMatchObject({ code: 'A0063' });
    expect(await rowOf(content)).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    expect(await threadsOf(content)).toEqual([]);
  });

  it('waits for the archiving of the client, then answers "not found" without moving the approved content or writing the comment', async () => {
    const content = await approved(3, ids.clientA2);

    const answer = await heldWhile(
      ids.adminA,
      (t) => t.raw('select app_private.archive_client(?::uuid)', [ids.clientA2]),
      () => requestAs(ids.portalA2, content)
    );

    try {
      expect(answer).toMatchObject({ code: 'A0060' });
      expect(await rowOf(content)).not.toMatchObject({ status: 'adjusting' });
      expect(await threadsOf(content)).toEqual([]);
      expect(await notificationsOf(content)).toEqual([]);
    } finally {
      await w.reactivateClient(ids.clientA2);
    }
  });
});

describe('the clock of the day is the one of the moment the request gets the lock', () => {
  it('asks the day of São Paulo at an instant after the wait, not at the one the transaction began, so a request that waited across midnight is judged by the new day', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'approved', publishOn: '2031-03-14' });
    const holder = await w.openTransactionAs(ids.productionA);
    const pid = await backendPid(holder);
    let released = '';
    let asking: ReturnType<typeof callAtInstant<boolean>> | undefined;

    try {
      await holder('contents').where({ id: content }).update({ title: 'Título novo' });
      asking = callAtInstant(
        owner(),
        '2031-03-13T12:00:00-03:00',
        ids.portalA1,
        (t) => requestIn(t, content),
        (t) => askedAtOrAfter(t, released)
      );
      void asking.catch(() => undefined);
      await waitForBackendsBlockedBy(owner(), pid);
      released = (await holder.raw<{ rows: Array<{ now: string }> }>('select pg_catalog.clock_timestamp()::pg_catalog.text as now')).rows[0]!.now;
    } finally {
      await holder.commit();
    }

    expect(await asking).toEqual({ ok: true, read: true });
  });

  it('is judged at the clock of the wait for a request that began on the eve and got the lock on the planned day: the day moved while it waited', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'approved', publishOn: '2031-03-14' });
    const holder = await w.openTransactionAs(ids.productionA);
    const pid = await backendPid(holder);
    let asking: Promise<unknown> | undefined;

    try {
      await holder('contents').where({ id: content }).update({ title: 'Título novo' });
      // The stand-in answers the eve for the first 2 seconds after the transaction began and the planned day after that: the instant the
      // function asks is shifted by the time the transaction has been running, so the wait is what moves the day.
      asking = callAtInstant(
        owner(),
        '2031-03-13T23:59:59-03:00',
        ids.portalA1,
        (t) => requestIn(t, content),
        async () => true
      );
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
