import { randomUUID } from 'node:crypto';

import { raw } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { backendPid, archiveBeforeStatement, archiveWhileRouteWaits, waitForBackendBlockedBy } from './test-support/race.js';
import { createPortalFixtures, DUAL_PEOPLE, type PortalPerson } from './test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Issue #257: the contents of a client in the portal, and the two moves of the person of the portal, approve and request
// changes. Every scenario that proves isolation uses a person the policy WOULD let read the row (a collaborator with a link, a
// person with a link to two clients), so a missing filter shows up as a leaked row instead of being hidden by row-level security.
// Each race is sequenced by a lock or by the statement, never by a sleep.
const w = createContentsWorld('portal');
const p = createPortalFixtures(w);
const { people } = w;

type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';

// Invisible characters are spelled as code points so they stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

const listUrl = (clientId: string, query = ''): string => `/clients/${clientId}/contents${query}`;
const awaitingUrl = (clientId: string, query = ''): string => `/clients/${clientId}/contents/awaiting-approval${query}`;
const oneUrl = (clientId: string, contentId: string): string => `/clients/${clientId}/contents/${contentId}`;
const approveUrl = (clientId: string, contentId: string): string => `${oneUrl(clientId, contentId)}/approve`;
const changesUrl = (clientId: string, contentId: string): string => `${oneUrl(clientId, contentId)}/request-changes`;
const agencyUrl = (clientId: string, contentId: string): string => `/agencies/${w.agencyA}/clients/${clientId}/contents/${contentId}`;

const get = (person: PortalPerson, url: string): Promise<Reply> => w.call('GET', p.people[person].cookie, url);
const post = (person: PortalPerson, url: string, body?: unknown): Promise<Reply> => w.call('POST', p.people[person].cookie, url, body);

const errorOf = (reply: Reply): { code?: string; message?: string } => reply.json().error ?? {};

const statusOf = async (contentId: string): Promise<string> => (await w.contentRow(contentId)).status as string;

const threadsOf = (contentId: string): Promise<Array<Record<string, unknown>>> => w.getOwner().knex('client_threads').where({ content_id: contentId });
const commentsOfContent = async (contentId: string): Promise<Array<Record<string, unknown>>> => {
  const thread = (await threadsOf(contentId))[0];
  if (thread === undefined) return [];
  return w.getOwner().knex('client_thread_comments').where({ thread_id: thread.id }).orderBy('created_at', 'asc');
};

/** What a refused move must leave exactly as it was: the state, the approval, the revision and the conversation. */
const snapshotOf = async (contentId: string): Promise<unknown> => {
  const row = await w.contentRow(contentId);
  return {
    status: row.status,
    revision: row.revision,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    threads: (await threadsOf(contentId)).length,
    comments: (await commentsOfContent(contentId)).length
  };
};

const freshClient = async (label: string, members: readonly PortalPerson[] = ['portalOne']): Promise<string> => {
  const clientId = await w.newClient(label);
  for (const member of members) await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people[member].id });
  return clientId;
};

const seedOpen = async (clientId: string, status: Exclude<Status, 'in_production' | 'cancelled'>, extra: { title?: string; publishOn?: string; publishAtTime?: string | null; caption?: string | null } = {}): Promise<string> =>
  w.seedContent(clientId, { status, ...extra });

/** A content with a chosen id, so a test can make the order of the ids the opposite of the order the route must give. */
const seedWithId = async (clientId: string, id: string, status: 'awaiting_approval' | 'approved', extra: { publishOn: string; publishAtTime: string | null }): Promise<string> => {
  await w.getOwner().knex('contents').insert({
    id, client_id: clientId, title: `Conteúdo ${id.slice(0, 4)}`, platform: 'instagram', format: 'image', publish_on: extra.publishOn,
    publish_at_time: extra.publishAtTime, folder_id: await w.folderOf(clientId), owner_user_id: people.production.id, status,
    ...(status === 'approved' ? { approved_by: people.admin.id, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {})
  });
  return id;
};

/** Four ids in ascending order, new for every test: a content id is unique in the whole table. */
const orderedIds = (): [string, string, string, string] => {
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID()).sort();
  return [a!, b!, c!, d!];
};

/** Subtasks and a person in charge the portal must never see, on a content of any state. */
const seedInternal = async (contentId: string): Promise<void> => {
  await w.seedTask(contentId, 'approved');
  await w.seedTask(contentId, 'pending');
};

const FORBIDDEN_KEYS = /task|assignee|owner|responsible|due|deadline|reason|approv|userid|user_id|membership|cancel|folder|comment|thread/i;
const INTERNAL_VALUES = ['Subtarefa', 'Pessoa production', 'Pessoa admin', 'Aprovado fora da plataforma'];

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  return [];
};

/** Nothing of the agency's work in the response, by the keys of the WHOLE body and by the values: no subtask, person in charge, deadline or user id. */
const expectNoInternal = (reply: Reply): void => {
  expect(reply.statusCode).toBe(200);
  const body = reply.json();
  for (const key of keysOf(body)) expect(key, `key ${key}`).not.toMatch(FORBIDDEN_KEYS);
  const serialized = JSON.stringify(body);
  for (const id of p.allUserIds()) expect(serialized).not.toContain(id);
  for (const value of INTERNAL_VALUES) expect(serialized).not.toContain(value);
};

const expectNotFound = (reply: Reply, message?: string): void => {
  expect(reply.statusCode).toBe(404);
  expect(errorOf(reply).code).toBe('NOT_FOUND');
  if (message !== undefined) expect(errorOf(reply).message).toBe(message);
};

const expectNotAwaiting = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(errorOf(reply).code).toBe('CONTENT_NOT_AWAITING_APPROVAL');
};

const dbError = (code: string): Error => Object.assign(new Error(`database ${code}`), { code });

/** The content row held by another transaction; whoever asks for it waits, and the lock queue is the order. */
const holdContent = async (contentId: string): Promise<{ readonly pid: number; release(): Promise<void> }> => {
  const holder = await w.getOwner().knex.transaction();
  const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.contents where id = ?::uuid for update', [contentId]);
  if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one content row.');
  let released = false;
  return {
    pid: await backendPid(holder),
    release: async () => {
      if (released) return;
      released = true;
      await holder.commit();
    }
  };
};

/**
 * Waits until `count` backends of this database wait for a lock. Counted by the wait itself, not by who blocks them: a row lock
 * held by one transaction makes only the first waiter wait for it, and the next ones queue behind that waiter.
 */
const waitForBlocked = async (_holderPid: number, count: number): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ pid: number }> }>(w.getOwner().knex, `
      select activity.pid from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database() and activity.wait_event_type = 'Lock'
    `, []);
    if (result.rows.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fewer than ${count} backends ever waited for a lock.`);
};

beforeAll(async () => {
  await w.setup();
  await p.setup();
}, 120_000);

afterAll(async () => {
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('who may read and move the contents of a client in the portal', () => {
  it('refuses a request without a session, before anything is read', async () => {
    const clientId = await freshClient('no-session');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const origin = { origin: TEST_APP_PUBLIC_URL };
    for (const [method, url, payload] of [
      ['GET', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'), undefined],
      ['GET', awaitingUrl(clientId), undefined],
      ['GET', oneUrl(clientId, contentId), undefined],
      ['POST', approveUrl(clientId, contentId), { revision: 1 }],
      ['POST', changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' }]
    ] as const) {
      const reply = await w.getApp().app.inject({ method, url, headers: origin, ...(payload === undefined ? {} : { payload }) });
      expect(reply.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await statusOf(contentId)).toBe('awaiting_approval');
  });

  // A person without an active link to THIS client is the same 404 on every route, whoever else the person is: another client's
  // portal, another agency's, an admin of the agency or of another agency, the Owner, a removed link, an archived client.
  const strangers: ReadonlyArray<[string, () => string]> = [
    ['a person of another client of the same agency', () => p.people.portalOther.cookie],
    ['a person of a client of another agency', () => p.people.portalB.cookie],
    ['a person whose link was removed', () => p.people.removed.cookie],
    ['an Admin of the agency without a link', () => people.admin.cookie],
    ['the Owner of the agency without a link', () => people.owner.cookie],
    ['an Admin of another agency without a link', () => people.adminB.cookie]
  ];

  it.each(strangers)('answers 404 on all five routes to %s, and moves nothing', async (_label, cookieOf) => {
    const clientId = await freshClient('stranger');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);
    const cookie = cookieOf();

    const replies = [
      await w.call('GET', cookie, listUrl(clientId, '?from=2026-10-01&to=2026-10-31')),
      await w.call('GET', cookie, awaitingUrl(clientId)),
      await w.call('GET', cookie, oneUrl(clientId, contentId)),
      await w.call('POST', cookie, approveUrl(clientId, contentId), { revision: 1 }),
      await w.call('POST', cookie, changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' })
    ];
    for (const reply of replies) expectNotFound(reply, 'Client not found.');
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('answers 404 on all five routes for an archived client, and moves nothing', async () => {
    const clientId = await w.newClient('archived', { status: 'archived' });
    await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people.portalOne.id });
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);

    for (const reply of [
      await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31')),
      await get('portalOne', awaitingUrl(clientId)),
      await get('portalOne', oneUrl(clientId, contentId)),
      await post('portalOne', approveUrl(clientId, contentId), { revision: 1 }),
      await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' })
    ]) expectNotFound(reply);
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('answers 404 on all five routes while the agency is suspended, and the same person reads again when it is active', async () => {
    const contentId = await w.seedContent(p.clientB1, { status: 'awaiting_approval', ownerUserId: people.adminB.id });
    const before = await snapshotOf(contentId);
    const reads = async (): Promise<Reply[]> => [
      await get('portalB', listUrl(p.clientB1, '?from=2026-10-01&to=2026-10-31')),
      await get('portalB', awaitingUrl(p.clientB1)),
      await get('portalB', oneUrl(p.clientB1, contentId))
    ];
    expect((await reads()).map((reply) => reply.statusCode)).toEqual([200, 200, 200]);

    await w.getOwner().knex('agencies').where({ id: w.agencyB }).update({ status: 'suspended' });
    try {
      for (const reply of [
        ...await reads(),
        await post('portalB', approveUrl(p.clientB1, contentId), { revision: 1 }),
        await post('portalB', changesUrl(p.clientB1, contentId), { revision: 1, comment: 'Ajustar' })
      ]) expectNotFound(reply, 'Client not found.');
      expect(await snapshotOf(contentId)).toEqual(before);
    } finally {
      await w.getOwner().knex('agencies').where({ id: w.agencyB }).update({ status: 'active' });
    }
  });

  it('answers the same 404 to a malformed id, an absent content and a content of another client the person also reads', async () => {
    const clientA = await freshClient('ids-a', ['portalMulti']);
    const clientB = await freshClient('ids-b', ['portalMulti']);
    const ofB = await seedOpen(clientB, 'awaiting_approval');
    const before = await snapshotOf(ofB);

    for (const id of ['not-a-uuid', randomUUID(), ofB]) {
      expectNotFound(await get('portalMulti', oneUrl(clientA, id)), 'Content not found.');
      expectNotFound(await post('portalMulti', approveUrl(clientA, id), { revision: 1 }), 'Content not found.');
      expectNotFound(await post('portalMulti', changesUrl(clientA, id), { revision: 1, comment: 'Ajustar' }), 'Content not found.');
    }
    // The person may read B and act on it by B's own URL: it was the URL of A that said "no", and nothing of B moved.
    expect(await snapshotOf(ofB)).toEqual(before);
    expect((await get('portalMulti', oneUrl(clientB, ofB))).statusCode).toBe(200);
  });
});

describe('the contents of a period', () => {
  it('lists the period with both ends, oldest day first, in the envelope of the period query', async () => {
    const clientId = await freshClient('period');
    const before = await seedOpen(clientId, 'approved', { title: 'Antes', publishOn: '2026-09-30' });
    const first = await seedOpen(clientId, 'approved', { title: 'Primeiro dia', publishOn: '2026-10-01', publishAtTime: '09:00' });
    const lateSameDay = await seedOpen(clientId, 'awaiting_approval', { title: 'Tarde', publishOn: '2026-10-01', publishAtTime: '17:30' });
    const last = await seedOpen(clientId, 'published', { title: 'Último dia', publishOn: '2026-10-31', publishAtTime: null });
    const after = await seedOpen(clientId, 'approved', { title: 'Depois', publishOn: '2026-11-01' });
    const other = await freshClient('period-other');
    await seedOpen(other, 'approved', { title: 'De outro cliente', publishOn: '2026-10-15' });

    const reply = await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));

    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.map((item: { id: string }) => item.id)).toEqual([first, lateSameDay, last]);
    expect(reply.json().meta).toEqual({ from: '2026-10-01', to: '2026-10-31', count: 3 });
    expect(reply.json().data[0]).toEqual({
      id: first, title: 'Primeiro dia', platform: 'instagram', format: 'reels', publishOn: '2026-10-01', publishAtTime: '09:00',
      status: 'approved', coverAssetId: null, publishedOn: null
    });
    expect(JSON.stringify(reply.json())).not.toContain(before);
    expect(JSON.stringify(reply.json())).not.toContain(after);
  });

  it('orders one day by hour, the content without an hour last, and by id when the hour is the same', async () => {
    const clientId = await freshClient('period-order');
    const [ID_LOW, ID_MID, ID_HIGH, ID_LAST] = orderedIds();
    // Inserted against the order the route must answer, and against the order of the ids for the two of the same hour.
    await seedWithId(clientId, ID_HIGH, 'approved', { publishOn: '2026-10-10', publishAtTime: null });
    await seedWithId(clientId, ID_LOW, 'approved', { publishOn: '2026-10-10', publishAtTime: '17:30' });
    await seedWithId(clientId, ID_LAST, 'approved', { publishOn: '2026-10-10', publishAtTime: '09:00' });
    await seedWithId(clientId, ID_MID, 'approved', { publishOn: '2026-10-10', publishAtTime: '09:00' });
    const nextDay = await seedWithId(clientId, randomUUID(), 'approved', { publishOn: '2026-10-11', publishAtTime: '08:00' });
    const earlierDay = await seedWithId(clientId, randomUUID(), 'approved', { publishOn: '2026-10-09', publishAtTime: '23:00' });

    const reply = await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));

    expect(reply.json().data.map((item: { id: string }) => item.id)).toEqual([earlierDay, ID_MID, ID_LAST, ID_LOW, ID_HIGH, nextDay]);
  });

  it('shows a content in production by its title, its day and its format, and nothing else, and leaves a cancelled one out', async () => {
    const clientId = await freshClient('production-cut', ['portalOne', ...DUAL_PEOPLE]);
    const production = await w.seedContent(clientId, { status: 'in_production', title: 'Em produção', caption: 'Legenda de bastidor', publishAtTime: '08:00' });
    await w.seedContent(clientId, { status: 'cancelled', title: 'Cancelado' });
    await seedInternal(production);

    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      const reply = await get(person, listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));
      expect(reply.json().data, person).toEqual([{ id: production, title: 'Em produção', format: 'reels', publishOn: '2026-10-20', status: 'in_production' }]);
      expect(reply.json().meta.count, person).toBe(1);
      expectNoInternal(reply);
    }
  });

  it('accepts 93 days and refuses 94, refuses what is not a period, and says nothing about another client', async () => {
    const clientId = await freshClient('period-bounds');
    expect((await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2027-01-01'))).statusCode).toBe(200);
    expect((await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-01'))).statusCode).toBe(200);
    for (const query of ['?from=2026-10-01&to=2027-01-02', '?from=2026-10-02&to=2026-10-01', '?from=2026-10-01', '?to=2026-10-01', '',
      '?from=2026-02-30&to=2026-03-01', '?from=2026-10-01&to=2026-10-31&status=approved', '?from=2026-10-01&to=2026-10-31&clientId=x']) {
      const reply = await get('portalOne', listUrl(clientId, query));
      expect(reply.statusCode, query).toBe(400);
      expect(errorOf(reply).code, query).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts 500 items and refuses 501 without truncating', async () => {
    const clientId = await freshClient('period-ceiling');
    const folderId = await w.folderOf(clientId);
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: randomUUID(), client_id: clientId, title: `Item ${index}`, platform: 'instagram', format: 'image', publish_on: '2026-10-10',
      folder_id: folderId, owner_user_id: people.production.id, status: 'in_production'
    }));
    await w.getOwner().knex('contents').insert(rows.slice(0, 500));

    const full = await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));
    expect(full.statusCode).toBe(200);
    expect(full.json().data).toHaveLength(500);
    expect(full.json().meta.count).toBe(500);

    await w.getOwner().knex('contents').insert(rows.slice(500));
    const over = await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));
    expect(over.statusCode).toBe(400);
    expect(errorOf(over).code).toBe('CONTENT_PERIOD_TOO_LARGE');
    expect(over.json().data).toBeUndefined();
  }, 60_000);
});

describe('what waits for the person', () => {
  it('lists only the contents awaiting approval of the client, the nearest day first, paginated with the real total', async () => {
    const clientId = await freshClient('awaiting', ['portalOne', 'portalMulti', ...DUAL_PEOPLE]);
    const other = await freshClient('awaiting-other', ['portalMulti']);
    const late = await seedOpen(clientId, 'awaiting_approval', { title: 'Tarde', publishOn: '2026-10-25' });
    const soon = await seedOpen(clientId, 'awaiting_approval', { title: 'Cedo', publishOn: '2026-10-21', publishAtTime: '10:00' });
    const sameDayLater = await seedOpen(clientId, 'awaiting_approval', { title: 'Mesmo dia depois', publishOn: '2026-10-21', publishAtTime: '16:00' });
    await seedOpen(clientId, 'adjusting');
    await seedOpen(clientId, 'approved');
    await w.seedContent(clientId, { status: 'in_production' });
    await w.seedContent(clientId, { status: 'cancelled' });
    await seedOpen(other, 'awaiting_approval', { title: 'De outro cliente' });

    const all = await get('portalMulti', awaitingUrl(clientId));
    expect(all.statusCode).toBe(200);
    expect(all.json().data.map((item: { id: string }) => item.id)).toEqual([soon, sameDayLater, late]);
    expect(all.json().meta).toEqual({ page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });
    expect(all.json().data[0]).toEqual({
      id: soon, title: 'Cedo', platform: 'instagram', format: 'reels', publishOn: '2026-10-21', publishAtTime: '10:00',
      status: 'awaiting_approval', coverAssetId: null, publishedOn: null
    });

    for (const person of DUAL_PEOPLE) {
      const same = await get(person, awaitingUrl(clientId));
      expect(same.json().data.map((item: { id: string }) => item.id), person).toEqual([soon, sameDayLater, late]);
    }

    const second = await get('portalOne', awaitingUrl(clientId, '?pageSize=1&page=2'));
    expect(second.json().data.map((item: { id: string }) => item.id)).toEqual([sameDayLater]);
    expect(second.json().meta).toEqual({ page: 2, pageSize: 1, totalItems: 3, totalPages: 3 });
    const huge = await get('portalOne', awaitingUrl(clientId, '?pageSize=5000'));
    expect(huge.json().meta).toEqual({ page: 1, pageSize: 100, totalItems: 3, totalPages: 1 });
    const beyond = await get('portalOne', awaitingUrl(clientId, '?pageSize=1&page=9'));
    expect(beyond.statusCode).toBe(200);
    expect(beyond.json()).toMatchObject({ data: [], meta: { page: 9, pageSize: 1, totalItems: 3, totalPages: 3 } });
  });

  it('orders what waits by day, hour and id, and pages in that same order', async () => {
    const clientId = await freshClient('awaiting-order');
    const [ID_LOW, ID_MID, ID_HIGH, ID_LAST] = orderedIds();
    await seedWithId(clientId, ID_HIGH, 'awaiting_approval', { publishOn: '2026-10-10', publishAtTime: null });
    await seedWithId(clientId, ID_LOW, 'awaiting_approval', { publishOn: '2026-10-10', publishAtTime: '17:30' });
    await seedWithId(clientId, ID_LAST, 'awaiting_approval', { publishOn: '2026-10-10', publishAtTime: '09:00' });
    await seedWithId(clientId, ID_MID, 'awaiting_approval', { publishOn: '2026-10-10', publishAtTime: '09:00' });

    const all = await get('portalOne', awaitingUrl(clientId));
    expect(all.json().data.map((item: { id: string }) => item.id)).toEqual([ID_MID, ID_LAST, ID_LOW, ID_HIGH]);
    const pages = [];
    for (const page of [1, 2, 3, 4]) pages.push((await get('portalOne', awaitingUrl(clientId, `?pageSize=1&page=${page}`))).json().data[0].id);
    expect(pages).toEqual([ID_MID, ID_LAST, ID_LOW, ID_HIGH]);
  });

  it('answers an empty list, with the total zero, when nothing waits', async () => {
    const clientId = await freshClient('awaiting-empty');
    const reply = await get('portalOne', awaitingUrl(clientId));
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ data: [], meta: { totalItems: 0, totalPages: 0 } });
    expect((await get('portalOne', awaitingUrl(clientId, '?page=0'))).statusCode).toBe(400);
    expect((await get('portalOne', awaitingUrl(clientId, '?status=approved'))).statusCode).toBe(400);
  });

  it('is the one route of the segment awaiting-approval, never a content id', async () => {
    const clientId = await freshClient('awaiting-route');
    const reply = await get('portalOne', awaitingUrl(clientId));
    expect(reply.statusCode).toBe(200);
    expect(reply.json().meta).toBeDefined();
  });
});

describe('one content', () => {
  it('shows the post with its caption, its revision and its media, in order, from awaiting approval on', async () => {
    const clientId = await freshClient('detail', ['portalOne', ...DUAL_PEOPLE]);
    const folderId = await w.folderOf(clientId);
    const cover = await w.seedAsset(clientId, folderId, { category: 'image' });
    // The first place goes to the asset with the HIGHER id, so an answer ordered by id is the wrong one.
    const ids = [await w.seedAsset(clientId, folderId, { category: 'image' }), await w.seedAsset(clientId, folderId, { category: 'video' })];
    const [lower, higher] = [...ids].sort();
    const kindOf = (id: string): 'image' | 'video' => (id === ids[0] ? 'image' : 'video');
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'carousel', title: 'Carrossel', caption: 'Legenda\ncom quebra', folderId, coverAssetId: cover });
    await w.attach(contentId, [higher, lower]);
    await seedInternal(contentId);

    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      const reply = await get(person, oneUrl(clientId, contentId));
      expect(reply.json(), person).toEqual({
        id: contentId, title: 'Carrossel', platform: 'instagram', format: 'carousel', publishOn: '2026-10-20', publishAtTime: '18:30',
        status: 'awaiting_approval', coverAssetId: cover, publishedOn: null,
        caption: 'Legenda\ncom quebra', revision: 1, media: [{ id: higher, position: 1, kind: kindOf(higher) }, { id: lower, position: 2, kind: kindOf(lower) }]
      });
      expectNoInternal(reply);
    }
  });

  it('shows every state from awaiting approval on the same way, and a published one with its real day', async () => {
    const clientId = await freshClient('detail-states');
    for (const status of ['awaiting_approval', 'adjusting', 'approved', 'published'] as const) {
      const contentId = await seedOpen(clientId, status, { caption: null });
      const reply = await get('portalOne', oneUrl(clientId, contentId));
      expect(reply.json()).toMatchObject({ id: contentId, status, caption: null, revision: 1, media: [], publishedOn: status === 'published' ? '2026-10-06' : null });
      expectNoInternal(reply);
    }
  });

  it('shows a content in production as its title, its day and its format, whatever the person also is', async () => {
    const clientId = await freshClient('detail-production', ['portalOne', ...DUAL_PEOPLE]);
    const contentId = await w.seedContent(clientId, { status: 'in_production', title: 'Em produção', caption: 'Legenda de bastidor' });
    await seedInternal(contentId);
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      const reply = await get(person, oneUrl(clientId, contentId));
      expect(reply.json(), person).toEqual({ id: contentId, title: 'Em produção', format: 'reels', publishOn: '2026-10-20', status: 'in_production' });
      expectNoInternal(reply);
    }
  });

  it('answers 404 for a cancelled content to everyone, including the collaborators whose role reads it', async () => {
    const clientId = await freshClient('detail-cancelled', ['portalOne', ...DUAL_PEOPLE]);
    const contentId = await w.seedContent(clientId, { status: 'cancelled' });
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNotFound(await get(person, oneUrl(clientId, contentId)), 'Content not found.');
    }
  });

  it('leaves out of the media a file that did not finish uploading and one that was removed', async () => {
    const clientId = await freshClient('detail-media');
    const folderId = await w.folderOf(clientId);
    const ready = await w.seedAsset(clientId, folderId, { category: 'image' });
    const pending = await w.seedAsset(clientId, folderId, { category: 'image', status: 'pending' });
    const removed = await w.seedAsset(clientId, folderId, { category: 'image', removed: true });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'carousel', folderId });
    await w.attach(contentId, [ready, pending, removed]);

    const reply = await get('portalOne', oneUrl(clientId, contentId));
    expect(reply.json().media).toEqual([{ id: ready, position: 1, kind: 'image' }]);
  });

  it('never selects from the table of the contents: the portal reads by the function that answers for the link', async () => {
    const clientId = await freshClient('statements');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    w.statements.length = 0;
    await get('portalOne', listUrl(clientId, '?from=2026-10-01&to=2026-10-31'));
    await get('portalOne', awaitingUrl(clientId));
    await get('portalOne', oneUrl(clientId, contentId));
    await post('portalOne', approveUrl(clientId, contentId), { revision: 1 });
    expect(w.statements.length).toBeGreaterThan(0);
    expect(w.mentionsContents()).toBe(false);
  });
});

describe('approving', () => {
  it('approves a content awaiting approval for the person of the session, and the portal answers the approved post', async () => {
    const clientId = await freshClient('approve');
    const folderId = await w.folderOf(clientId);
    const asset = await w.seedAsset(clientId, folderId, { category: 'image' });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'image', folderId, title: 'Post', caption: 'Legenda' });
    await w.attach(contentId, [asset]);
    await seedInternal(contentId);

    const reply = await post('portalOne', approveUrl(clientId, contentId), { revision: 1 });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      id: contentId, title: 'Post', platform: 'instagram', format: 'image', publishOn: '2026-10-20', publishAtTime: '18:30',
      status: 'approved', coverAssetId: null, publishedOn: null, caption: 'Legenda', revision: 1, media: [{ id: asset, position: 1, kind: 'image' }]
    });
    expectNoInternal(reply);
    const row = await w.contentRow(contentId);
    expect(row).toMatchObject({ status: 'approved', approved_by: p.people.portalOne.id, approved_by_agency_reason: null });
    expect(row.approved_at).toBeInstanceOf(Date);
  });

  it('names who approved by the session, to the agency: the name and the side, never a user id', async () => {
    const clientId = await freshClient('approve-name');
    const contentId = await seedOpen(clientId, 'awaiting_approval');

    await post('portalOne', approveUrl(clientId, contentId), { revision: 1 });

    const detail = await w.call('GET', people.admin.cookie, agencyUrl(clientId, contentId));
    expect(detail.json().approvedBy).toEqual({ name: 'Ana do Portal', side: 'client' });
    expect(Object.keys(detail.json().approvedBy)).toEqual(['name', 'side']);
    expect(JSON.stringify(detail.json().approvedBy)).not.toContain(p.people.portalOne.id);
  });

  it.each(DUAL_PEOPLE)('approves as the person of the portal when the person is also %s, with the client side', async (person) => {
    const clientId = p.clientA1;
    const contentId = await seedOpen(clientId, 'awaiting_approval');

    const reply = await post(person, approveUrl(clientId, contentId), { revision: 1 });

    expect(reply.statusCode).toBe(200);
    expectNoInternal(reply);
    expect(await w.contentRow(contentId)).toMatchObject({ status: 'approved', approved_by: p.people[person].id, approved_by_agency_reason: null });
    const detail = await w.call('GET', people.admin.cookie, agencyUrl(clientId, contentId));
    expect(detail.json().approvedBy).toEqual({ name: p.people[person].name, side: 'client' });
  });

  it('takes nobody from the body: a field that names the approver is a 400 and the content stays', async () => {
    const clientId = await freshClient('approve-body');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);
    for (const body of [
      { revision: 1, userId: people.admin.id },
      { revision: 1, approvedBy: { name: 'Outra Pessoa', side: 'agency' } },
      { revision: 1, status: 'published' },
      { revision: 1, reason: 'Aprovado por telefone' },
      {}, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: '1' }, { revision: 2_147_483_648 }, { revision: null }
    ]) {
      const reply = await post('portalOne', approveUrl(clientId, contentId), body);
      expect(reply.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
    }
    expect((await post('portalOne', approveUrl(clientId, contentId))).statusCode).toBe(400);
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('approves with the revision the person read from the post after the agency edited it, and refuses the one read before', async () => {
    const clientId = await freshClient('approve-edited');
    const contentId = await seedOpen(clientId, 'awaiting_approval', { caption: 'Legenda antiga' });
    const readBefore = (await get('portalOne', oneUrl(clientId, contentId))).json().revision;
    expect((await w.call('PATCH', people.manager.cookie, agencyUrl(clientId, contentId), { caption: 'Legenda nova' })).statusCode).toBe(200);
    const readAfter = await get('portalOne', oneUrl(clientId, contentId));
    expect(readAfter.json()).toMatchObject({ caption: 'Legenda nova', revision: readBefore + 1 });

    const stale = await post('portalOne', approveUrl(clientId, contentId), { revision: readBefore });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).code).toBe('CONTENT_REVISION_CHANGED');
    expect(await statusOf(contentId)).toBe('awaiting_approval');

    const fresh = await post('portalOne', approveUrl(clientId, contentId), { revision: readAfter.json().revision });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ status: 'approved', caption: 'Legenda nova', revision: readBefore + 1 });
  });

  it('refuses a revision that is not the one the person read, 409, and approves nothing', async () => {
    const clientId = await freshClient('approve-stale');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);

    const reply = await post('portalOne', approveUrl(clientId, contentId), { revision: 7 });

    expect(reply.statusCode).toBe(409);
    expect(errorOf(reply).code).toBe('CONTENT_REVISION_CHANGED');
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('is idempotent for a second person, and the first approval stays', async () => {
    const clientId = await freshClient('approve-twice', ['portalOne', 'portalMulti']);
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    await post('portalOne', approveUrl(clientId, contentId), { revision: 1 });
    const first = await w.contentRow(contentId);

    const again = await post('portalMulti', approveUrl(clientId, contentId), { revision: 1 });

    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('approved');
    const row = await w.contentRow(contentId);
    expect(row.approved_by).toBe(p.people.portalOne.id);
    expect(row.approved_at).toEqual(first.approved_at);
  });

  // The state the content is in decides, the same for the person of the portal and for a collaborator who is also one.
  it.each(['in_production', 'adjusting', 'published'] as const)('refuses a content %s with 409 CONTENT_NOT_AWAITING_APPROVAL to every kind of person, and moves nothing', async (status) => {
    const clientId = p.clientA1;
    const contentId = await w.seedContent(clientId, { status });
    const before = await snapshotOf(contentId);
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNotAwaiting(await post(person, approveUrl(clientId, contentId), { revision: 1 }));
    }
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('answers 404 for a cancelled content to every kind of person, and moves nothing', async () => {
    const clientId = p.clientA1;
    const contentId = await w.seedContent(clientId, { status: 'cancelled' });
    const before = await snapshotOf(contentId);
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNotFound(await post(person, approveUrl(clientId, contentId), { revision: 1 }), 'Content not found.');
    }
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('keeps the content of the client of the URL: a person who reads two clients cannot approve the other one through the first', async () => {
    const clientA = await freshClient('approve-url-a', ['portalMulti']);
    const clientB = await freshClient('approve-url-b', ['portalMulti']);
    const ofB = await seedOpen(clientB, 'awaiting_approval');
    const before = await snapshotOf(ofB);

    w.statements.length = 0;
    expectNotFound(await post('portalMulti', approveUrl(clientA, ofB), { revision: 1 }), 'Content not found.');
    expect(await snapshotOf(ofB)).toEqual(before);
    // The function never sees an id the portal could not read through the URL: the refusal is the route's, not a rollback's.
    expect(w.statements.some((statement) => /app_private\.approve_content\(/.test(statement))).toBe(false);
    expect((await post('portalMulti', approveUrl(clientB, ofB), { revision: 1 })).statusCode).toBe(200);
  });
});

describe('requesting changes', () => {
  it('moves the content to adjustment and writes the comment into the conversation of the content, as the person of the session', async () => {
    const clientId = await freshClient('changes');
    const contentId = await seedOpen(clientId, 'awaiting_approval', { title: 'Post' });
    await seedInternal(contentId);

    const reply = await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: '  Trocar a foto da capa.  ' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: contentId, status: 'adjusting', revision: 1 });
    expectNoInternal(reply);
    expect(await statusOf(contentId)).toBe('adjusting');
    const threads = await threadsOf(contentId);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ client_id: clientId, content_id: contentId, opened_by: p.people.portalOne.id, opened_side: 'client' });
    const comments = await commentsOfContent(contentId);
    expect(comments.map((comment) => [comment.body, comment.author_side, comment.author_user_id])).toEqual([['Trocar a foto da capa.', 'client', p.people.portalOne.id]]);

    // The conversation is the one the agency and the portal read by the routes of the conversations.
    const agency = await w.call('GET', people.admin.cookie, agencyUrl(clientId, contentId));
    expect(agency.json().conversation).toMatchObject({ threadId: threads[0]?.id, commentCount: 1 });
    const portal = await get('portalOne', `/clients/${clientId}/threads?contentId=${contentId}`);
    expect(portal.json().data).toHaveLength(1);
    expect(portal.json().data[0]).toMatchObject({ id: threads[0]?.id, subject: { contentId }, commentCount: 1 });
  });

  it.each(DUAL_PEOPLE)('writes the comment as the client when the person is also %s', async (person) => {
    const contentId = await seedOpen(p.clientA1, 'awaiting_approval');

    const reply = await post(person, changesUrl(p.clientA1, contentId), { revision: 1, comment: 'Ajustar a legenda' });

    expect(reply.statusCode).toBe(200);
    expectNoInternal(reply);
    const comments = await commentsOfContent(contentId);
    expect(comments.map((comment) => [comment.author_side, comment.author_user_id])).toEqual([['client', p.people[person].id]]);
    expect((await threadsOf(contentId))[0]).toMatchObject({ opened_by: p.people[person].id, opened_side: 'client' });
  });

  it('writes into the conversation the agency already opened, and into the same one when the content comes back', async () => {
    const clientId = await freshClient('changes-same-thread');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const opened = await w.call('POST', people.manager.cookie, `/agencies/${w.agencyA}/clients/${clientId}/threads`, { subject: { contentId }, body: 'Pode ver a legenda?' });
    expect(opened.statusCode).toBe(201);

    expect((await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'Primeiro pedido' })).statusCode).toBe(200);
    const folderId = (await w.contentRow(contentId)).folder_id as string;
    await w.attach(contentId, [await w.seedAsset(clientId, folderId, { category: 'video' })]);
    expect((await w.call('POST', people.manager.cookie, `${agencyUrl(clientId, contentId)}/submit`)).statusCode).toBe(200);
    expect(await statusOf(contentId)).toBe('awaiting_approval');
    expect((await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'Segundo pedido' })).statusCode).toBe(200);

    expect(await threadsOf(contentId)).toHaveLength(1);
    expect((await commentsOfContent(contentId)).map((comment) => [comment.author_side, comment.body])).toEqual([
      ['agency', 'Pode ver a legenda?'], ['client', 'Primeiro pedido'], ['client', 'Segundo pedido']
    ]);
  });

  it('accepts a comment with accents and an emoji, and keeps what the person wrote', async () => {
    const clientId = await freshClient('changes-text');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const comment = `Mais cor, por favor ${text(0x2764, 0xfe0f)}\nObrigada: ação, coração.`;
    expect((await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment })).statusCode).toBe(200);
    expect((await commentsOfContent(contentId))[0]?.body).toBe(comment);
  });

  // The comment is required and says something a person can read: nothing is written when it does not, not even the conversation.
  const refusedComments: ReadonlyArray<[string, unknown]> = [
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['spaces only', '   \t  '],
    ['a zero width space only (U+200B)', text(0x200b)],
    ['a byte order mark only (U+FEFF)', text(0xfeff, 0xfeff)],
    ['a control character only', text(0x07)],
    ['a Braille blank only (U+2800)', text(0x2800)],
    ['a joiner only', text(0x200d)],
    ['a variation selector only', text(0xfe0f)],
    ['a combining grapheme joiner only (U+034F)', text(0x034f)],
    ['a Hangul filler only (U+3164)', text(0x3164)],
    ['a Mongolian free variation selector only (U+180B)', text(0x180b)],
    ['a soft hyphen only (U+00AD)', text(0x00ad)],
    ['an invisible character next to text', `Trocar${text(0x200b)}a foto`],
    ['a right-to-left override inside the text', `Trocar ${text(0x202e)}a foto`],
    ['a control character inside the text', `Trocar${text(0x00)}a foto`],
    ['a line separator', `Trocar${text(0x2028)}a foto`],
    ['more than 5000 bytes', 'a'.repeat(5001)],
    ['more than 5000 bytes of accented letters', 'é'.repeat(2501)],
    ['a number', 12]
  ];

  it.each(refusedComments)('refuses a comment that is %s with 400, and writes nothing', async (_label, comment) => {
    const clientId = await freshClient('changes-refused');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);

    const reply = await post('portalOne', changesUrl(clientId, contentId), comment === undefined ? { revision: 1 } : { revision: 1, comment });

    expect(reply.statusCode).toBe(400);
    expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
    expect(await snapshotOf(contentId)).toEqual(before);
    expect(await threadsOf(contentId)).toEqual([]);
  });

  it('accepts exactly 5000 bytes', async () => {
    const clientId = await freshClient('changes-limit');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    expect((await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'a'.repeat(5000) })).statusCode).toBe(200);
    expect(String((await commentsOfContent(contentId))[0]?.body)).toHaveLength(5000);
  });

  it('takes nobody and no state from the body, and needs the revision', async () => {
    const clientId = await freshClient('changes-body');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);
    for (const body of [
      { revision: 1, comment: 'Ajustar', userId: people.admin.id },
      { revision: 1, comment: 'Ajustar', side: 'agency' },
      { revision: 1, comment: 'Ajustar', status: 'approved' },
      { comment: 'Ajustar' }, { revision: 0, comment: 'Ajustar' }, { revision: '1', comment: 'Ajustar' }
    ]) {
      const reply = await post('portalOne', changesUrl(clientId, contentId), body);
      expect(reply.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await post('portalOne', changesUrl(clientId, contentId))).statusCode).toBe(400);
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('refuses a revision that is not the one the person read, 409, and writes neither the comment nor the conversation', async () => {
    const clientId = await freshClient('changes-stale');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);

    const reply = await post('portalOne', changesUrl(clientId, contentId), { revision: 3, comment: 'Ajustar' });

    expect(reply.statusCode).toBe(409);
    expect(errorOf(reply).code).toBe('CONTENT_REVISION_CHANGED');
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it.each(['in_production', 'adjusting', 'approved', 'published'] as const)('refuses a content %s with 409 CONTENT_NOT_AWAITING_APPROVAL to every kind of person, and writes nothing', async (status) => {
    const clientId = p.clientA1;
    const contentId = await w.seedContent(clientId, { status });
    const before = await snapshotOf(contentId);
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNotAwaiting(await post(person, changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' }));
    }
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('answers 404 for a cancelled content to every kind of person, and writes nothing', async () => {
    const clientId = p.clientA1;
    const contentId = await w.seedContent(clientId, { status: 'cancelled' });
    const before = await snapshotOf(contentId);
    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNotFound(await post(person, changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' }), 'Content not found.');
    }
    expect(await snapshotOf(contentId)).toEqual(before);
  });

  it('keeps the content of the client of the URL, and writes nothing for the other one', async () => {
    const clientA = await freshClient('changes-url-a', ['portalMulti']);
    const clientB = await freshClient('changes-url-b', ['portalMulti']);
    const ofB = await seedOpen(clientB, 'awaiting_approval');
    const before = await snapshotOf(ofB);

    w.statements.length = 0;
    expectNotFound(await post('portalMulti', changesUrl(clientA, ofB), { revision: 1, comment: 'Ajustar' }), 'Content not found.');
    expect(await snapshotOf(ofB)).toEqual(before);
    expect(w.statements.some((statement) => /app_private\.request_content_changes\(/.test(statement))).toBe(false);
  });

  it('leaves neither the conversation nor the comment when the move to adjustment fails after them', async () => {
    const clientId = await freshClient('changes-atomic');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const before = await snapshotOf(contentId);
    const owner = w.getOwner().knex;
    const suffix = contentId.replaceAll('-', '');
    await owner.raw(`
      create function public.fail_adjusting_${suffix}() returns trigger language plpgsql as $$
      begin
        if new.id = '${contentId}'::uuid and new.status = 'adjusting' then raise exception 'injected failure' using errcode = 'P0001'; end if;
        return new;
      end $$;
      create trigger zz_fail_adjusting_${suffix} before update on public.contents for each row execute function public.fail_adjusting_${suffix}();
    `);
    try {
      const reply = await post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' });
      expect(reply.statusCode).toBe(500);
    } finally {
      await owner.raw(`drop trigger zz_fail_adjusting_${suffix} on public.contents; drop function public.fail_adjusting_${suffix}();`);
    }
    expect(await snapshotOf(contentId)).toEqual(before);
  });
});

describe('the portal and the agency at the same time', () => {
  const body = { revision: 1 };

  it('lets exactly one of approve and request changes win the same content, and leaves the state of the winner only', async () => {
    const clientId = await freshClient('race-moves', ['portalOne', 'portalMulti']);
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const held = await holdContent(contentId);
    try {
      const approving = post('portalOne', approveUrl(clientId, contentId), body);
      const asking = post('portalMulti', changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' });
      await waitForBlocked(held.pid, 2);
      await held.release();
      const [approved, asked] = await Promise.all([approving, asking]);

      expect([approved.statusCode, asked.statusCode].sort()).toEqual([200, 409]);
      const row = await w.contentRow(contentId);
      if (approved.statusCode === 200) {
        expectNotAwaiting(asked);
        expect(row).toMatchObject({ status: 'approved', approved_by: p.people.portalOne.id });
        expect(await commentsOfContent(contentId)).toEqual([]);
        expect(await threadsOf(contentId)).toEqual([]);
      } else {
        expectNotAwaiting(approved);
        expect(row).toMatchObject({ status: 'adjusting', approved_by: null });
        expect((await commentsOfContent(contentId)).map((comment) => comment.author_user_id)).toEqual([p.people.portalMulti.id]);
      }
    } finally {
      await held.release();
    }
  }, 30_000);

  it('lets two people approve the same content at once: both are answered 200 and one of them is the approver', async () => {
    const clientId = await freshClient('race-approve', ['portalOne', 'portalMulti']);
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const held = await holdContent(contentId);
    try {
      const first = post('portalOne', approveUrl(clientId, contentId), body);
      const second = post('portalMulti', approveUrl(clientId, contentId), body);
      await waitForBlocked(held.pid, 2);
      await held.release();
      const replies = await Promise.all([first, second]);
      expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
      expect([p.people.portalOne.id, p.people.portalMulti.id]).toContain((await w.contentRow(contentId)).approved_by);
    } finally {
      await held.release();
    }
  }, 30_000);

  it('answers 404, not 409, when the agency cancels the content while the approval waits for it', async () => {
    for (const person of ['portalOne', 'dualAdmin'] as const) {
      const clientId = p.clientA1;
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      const held = await holdContent(contentId);
      try {
        const cancelling = w.call('POST', people.manager.cookie, `${agencyUrl(clientId, contentId)}/cancel`);
        await waitForBlocked(held.pid, 1);
        const approving = post(person, approveUrl(clientId, contentId), body);
        await waitForBlocked(held.pid, 2);
        await held.release();

        expect((await cancelling).statusCode).toBe(200);
        expectNotFound(await approving, 'Content not found.');
        expect(await statusOf(contentId)).toBe('cancelled');
        expect((await w.contentRow(contentId)).approved_by).toBeNull();
      } finally {
        await held.release();
      }
    }
  }, 30_000);

  it('answers 404, not 409, when the agency cancels the content while the request for changes waits for it, and writes nothing', async () => {
    for (const person of ['portalOne', 'dualAdmin'] as const) {
      const clientId = p.clientA1;
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      const held = await holdContent(contentId);
      try {
        const cancelling = w.call('POST', people.manager.cookie, `${agencyUrl(clientId, contentId)}/cancel`);
        await waitForBlocked(held.pid, 1);
        const asking = post(person, changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' });
        await waitForBlocked(held.pid, 2);
        await held.release();

        expect((await cancelling).statusCode).toBe(200);
        expectNotFound(await asking, 'Content not found.');
        expect(await commentsOfContent(contentId)).toEqual([]);
        expect(await threadsOf(contentId)).toEqual([]);
      } finally {
        await held.release();
      }
    }
  }, 30_000);

  it('refuses the approval 409 CONTENT_REVISION_CHANGED when the agency edits the caption while it waits, and approves nothing', async () => {
    const clientId = await freshClient('race-caption');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const held = await holdContent(contentId);
    try {
      const editing = w.call('PATCH', people.manager.cookie, agencyUrl(clientId, contentId), { caption: 'Legenda nova' });
      await waitForBlocked(held.pid, 1);
      const approving = post('portalOne', approveUrl(clientId, contentId), body);
      await waitForBlocked(held.pid, 2);
      await held.release();

      expect((await editing).statusCode).toBe(200);
      const reply = await approving;
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('CONTENT_REVISION_CHANGED');
      expect(await w.contentRow(contentId)).toMatchObject({ status: 'awaiting_approval', caption: 'Legenda nova', approved_by: null });
    } finally {
      await held.release();
    }
  }, 30_000);

  it('refuses the request for changes 409 CONTENT_REVISION_CHANGED when the agency edits the caption while it waits, and writes nothing', async () => {
    const clientId = await freshClient('race-caption-changes');
    const contentId = await seedOpen(clientId, 'awaiting_approval');
    const held = await holdContent(contentId);
    try {
      const editing = w.call('PATCH', people.manager.cookie, agencyUrl(clientId, contentId), { caption: 'Legenda nova' });
      await waitForBlocked(held.pid, 1);
      const asking = post('portalOne', changesUrl(clientId, contentId), { revision: 1, comment: 'Ajustar' });
      await waitForBlocked(held.pid, 2);
      await held.release();

      expect((await editing).statusCode).toBe(200);
      const reply = await asking;
      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('CONTENT_REVISION_CHANGED');
      expect(await commentsOfContent(contentId)).toEqual([]);
      expect(await statusOf(contentId)).toBe('awaiting_approval');
    } finally {
      await held.release();
    }
  }, 30_000);

  it('keeps the approval of the agency when it comes first: the approval of the portal that waited is the same 200, and the request for changes is a 409', async () => {
    const clientId = await freshClient('race-agency-approval', ['portalOne', 'portalMulti']);
    const approvedFirst = await seedOpen(clientId, 'awaiting_approval');
    const held = await holdContent(approvedFirst);
    try {
      const agency = w.call('POST', people.admin.cookie, `${agencyUrl(clientId, approvedFirst)}/approve-by-agency`, { revision: 1, reason: 'Aprovado por telefone' });
      await waitForBlocked(held.pid, 1);
      const approving = post('portalOne', approveUrl(clientId, approvedFirst), body);
      const asking = post('portalMulti', changesUrl(clientId, approvedFirst), { revision: 1, comment: 'Ajustar' });
      await waitForBlocked(held.pid, 3);
      await held.release();

      expect((await agency).statusCode).toBe(200);
      expect((await approving).statusCode).toBe(200);
      expectNotAwaiting(await asking);
      expect(await w.contentRow(approvedFirst)).toMatchObject({ status: 'approved', approved_by: people.admin.id, approved_by_agency_reason: 'Aprovado por telefone' });
      expect(await commentsOfContent(approvedFirst)).toEqual([]);
    } finally {
      await held.release();
    }
  }, 30_000);

  describe.each([
    ['approve', approveUrl, { revision: 1 }, /app_private\.approve_content\(/],
    ['request-changes', changesUrl, { revision: 1, comment: 'Ajustar' }, /app_private\.request_content_changes\(/]
  ] as const)('%s while the client is being archived', (_action, urlOf, requestBody, statement) => {
    it('answers 404 while the archive is in course, and writes nothing', async () => {
      const clientId = await freshClient('race-archive-1');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      const before = await snapshotOf(contentId);

      const reply = await archiveWhileRouteWaits(w, clientId, () => post('portalOne', urlOf(clientId, contentId), requestBody));

      expectNotFound(reply);
      expect(JSON.stringify(reply.json())).not.toMatch(/A0020|A0060|archiv|deadlock|40P01|pg_|relation/i);
      expect(await snapshotOf(contentId)).toEqual(before);
    }, 30_000);

    it('answers 404 when the archive commits between the guard and the function, and writes nothing', async () => {
      const clientId = await freshClient('race-archive-2');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      const before = await snapshotOf(contentId);

      const reply = await archiveBeforeStatement(w, clientId, statement, () => post('portalOne', urlOf(clientId, contentId), requestBody));

      expectNotFound(reply);
      expect(JSON.stringify(reply.json())).not.toMatch(/A0020|A0060|archiv|deadlock|40P01|pg_|relation/i);
      expect(await snapshotOf(contentId)).toEqual(before);
    }, 30_000);

    it('makes the archive wait for the move when the row is held, and the move completes first', async () => {
      const clientId = await freshClient('race-archive-held');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      const held = await holdContent(contentId);
      let archive: Promise<number> | undefined;
      try {
        const pending = post('portalOne', urlOf(clientId, contentId), requestBody);
        const routePid = await waitForBackendBlockedBy(w, held.pid);
        archive = w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() }).then((count) => count);
        await waitForBackendBlockedBy(w, routePid);
        await held.release();

        expect((await pending).statusCode).toBe(200);
        expect(await archive).toBe(1);
        expect(await statusOf(contentId)).toBe(_action === 'approve' ? 'approved' : 'adjusting');
      } finally {
        await held.release();
        await archive;
      }
    }, 30_000);
  });
});

describe('what the database answers is never a 500', () => {
  const moves = [
    ['approve', approveUrl, { revision: 1 }, /app_private\.approve_content\(/],
    ['request-changes', changesUrl, { revision: 1, comment: 'Ajustar' }, /app_private\.request_content_changes\(/]
  ] as const;

  const answers: ReadonlyArray<[string, number, string]> = [
    ['A0060', 404, 'NOT_FOUND'],
    ['A0020', 404, 'NOT_FOUND'],
    ['A0061', 404, 'NOT_FOUND'],
    ['A0063', 409, 'CONTENT_REVISION_CHANGED'],
    ['A0068', 400, 'CONTENT_COMMENT_INVALID'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ];

  describe.each(moves)('%s', (_action, urlOf, requestBody, statement) => {
    it.each(answers)('answers %s with %i %s and no detail of the database', async (code, status, apiCode) => {
      const clientId = await freshClient('db-errors');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      w.runBeforeStatement(statement, async () => { throw dbError(code); });
      let reply: Reply;
      try {
        reply = await post('portalOne', urlOf(clientId, contentId), requestBody);
      } finally {
        w.clearHook();
      }
      expect(reply.statusCode).toBe(status);
      expect(errorOf(reply).code).toBe(apiCode);
      expect(JSON.stringify(reply.json())).not.toMatch(/A00\d\d|40P01|40001|database|pg_|relation/);
    });

    it('answers 409 CONTENT_NOT_AWAITING_APPROVAL for A0062 of a content the portal still reads', async () => {
      const clientId = await freshClient('db-a0062');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      w.runBeforeStatement(statement, async () => { throw dbError('A0062'); });
      try {
        expectNotAwaiting(await post('portalOne', urlOf(clientId, contentId), requestBody));
      } finally {
        w.clearHook();
      }
    });

    it('answers 403 for a refusal by the row-level security of a person whose link holds, and 404 once the link is gone', async () => {
      const clientId = await freshClient('db-42501');
      const contentId = await seedOpen(clientId, 'awaiting_approval');
      w.runBeforeStatement(statement, async () => { throw dbError('42501'); });
      try {
        const holds = await post('portalOne', urlOf(clientId, contentId), requestBody);
        expect(holds.statusCode).toBe(403);
        expect(errorOf(holds).code).toBe('FORBIDDEN');
      } finally {
        w.clearHook();
      }

      w.runBeforeStatement(statement, async () => {
        await w.getOwner().knex('client_memberships').where({ client_id: clientId, user_id: p.people.portalOne.id }).update({ status: 'removed' });
        throw dbError('42501');
      });
      try {
        expectNotFound(await post('portalOne', urlOf(clientId, contentId), requestBody), 'Client not found.');
      } finally {
        w.clearHook();
      }
    });

    it('answers 404 for a content that was cancelled between the read and the function, whoever the person also is', async () => {
      for (const person of ['portalOne', 'dualAdmin'] as const) {
        const clientId = p.clientA1;
        const contentId = await seedOpen(clientId, 'awaiting_approval');
        w.runBeforeStatement(statement, async () => {
          await w.getOwner().knex('contents').where({ id: contentId }).update({ status: 'cancelled', cancelled_at: new Date() });
          throw dbError('A0062');
        });
        try {
          expectNotFound(await post(person, urlOf(clientId, contentId), requestBody), 'Content not found.');
        } finally {
          w.clearHook();
        }
      }
    });
  });
});

describe('every response, whatever the route and the person', () => {
  it('carries no subtask, no person in charge, no internal deadline and no user id in any key or value', async () => {
    const clientId = p.clientA1;
    const production = await w.seedContent(clientId, { status: 'in_production', caption: 'Bastidor' });
    const awaiting = await seedOpen(clientId, 'awaiting_approval');
    const toApprove = await seedOpen(clientId, 'awaiting_approval');
    const toAsk = await seedOpen(clientId, 'awaiting_approval');
    const published = await seedOpen(clientId, 'published');
    // The tasks of a published content are never edited again, so that one is read without them: the others carry them.
    for (const contentId of [production, awaiting, toApprove, toAsk]) await seedInternal(contentId);

    for (const person of ['portalOne', ...DUAL_PEOPLE] as const) {
      expectNoInternal(await get(person, listUrl(clientId, '?from=2026-10-01&to=2026-10-31')));
      expectNoInternal(await get(person, awaitingUrl(clientId)));
      for (const contentId of [production, awaiting, published]) expectNoInternal(await get(person, oneUrl(clientId, contentId)));
    }
    expectNoInternal(await post('portalOne', approveUrl(clientId, toApprove), { revision: 1 }));
    expectNoInternal(await post('dualAdmin', changesUrl(clientId, toAsk), { revision: 1, comment: 'Ajustar' }));
    expectNoInternal(await post('dualRead', approveUrl(clientId, awaiting), { revision: 1 }));
  });

  it('is built from schemas that refuse an extra key, so a field of the work of the agency cannot be added by a handler', async () => {
    const { PortalContentDetailSchema, PortalContentListItemSchema, PortalContentInProductionSchema } = await import('@ageniza/contracts');
    const production = { id: randomUUID(), title: 'T', format: 'reels', publishOn: '2026-10-20', status: 'in_production' };
    expect(PortalContentInProductionSchema.safeParse(production).success).toBe(true);
    for (const extra of [{ caption: 'x' }, { owner: null }, { tasks: [] }, { dueOn: '2026-10-01' }, { approvedBy: null }, { revision: 1 }]) {
      expect(PortalContentListItemSchema.safeParse({ ...production, ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(PortalContentDetailSchema.safeParse({ ...production, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});
