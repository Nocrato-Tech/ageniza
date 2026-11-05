import { randomUUID } from 'node:crypto';

import { encodeContentFeedCursor } from '@ageniza/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPortalFixtures } from './test-support/portal-fixtures.js';
import { createContentsWorld, type PersonKey, type SeedContent } from './test-support/world.js';

// The feed of the phone beside the calendar (specs/conteudo.md section 7): the client's whole feed, nine a page, newest first,
// independent of any period. Every person below holds the permissions of one thing, so a guard on the wrong key does not hide
// behind an admin. Each test names the mutation of the code that turns it red.
const w = createContentsWorld('contents-feed');
const p = createPortalFixtures(w);
const { people } = w;

let clientA: string;
let clientOther: string;
let clientArchived: string;
let clientB: string;

const feedUrl = (clientId: string, agencyId = w.agencyA, query = ''): string => `/agencies/${agencyId}/clients/${clientId}/contents/feed${query}`;

interface FeedBody {
  data: {
    contents: Array<{ id: string; format: string; status: string; publishOn: string; publishAtTime: string | null; title: string }>;
    nextCursor: string | null;
    counters: { posts: number; approved: number; awaitingApproval: number } | null;
  };
  meta: { count: number };
}

const page = async (clientId: string, cursor?: string, cookie = people.admin.cookie): Promise<FeedBody> => {
  const reply = await w.call('GET', cookie, feedUrl(clientId, w.agencyA, cursor === undefined ? '' : `?cursor=${cursor}`));
  expect(reply.statusCode).toBe(200);
  return reply.json<FeedBody>();
};

const walk = async (clientId: string): Promise<{ ids: string[]; pages: FeedBody[] }> => {
  const pages: FeedBody[] = [];
  let cursor: string | undefined;
  do {
    const body = await page(clientId, cursor);
    pages.push(body);
    cursor = body.data.nextCursor ?? undefined;
  } while (cursor !== undefined && pages.length < 50);
  return { ids: pages.flatMap((body) => body.data.contents.map((content) => content.id)), pages };
};

const seed = (clientId: string, extra: SeedContent): Promise<string> => w.seedContent(clientId, extra);

beforeAll(async () => {
  await w.setup();
  await p.setup();
  clientA = await w.newClient('feed-a');
  clientOther = await w.newClient('feed-other');
  clientArchived = await w.newClient('feed-archived');
  clientB = await w.newClient('feed-b', { agencyId: w.agencyB });
}, 90_000);

afterAll(async () => {
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('the order and the pages', () => {
  let expectedOrder: string[] = [];
  let total = 0;

  beforeAll(async () => {
    // 20 posts: three tied on day and time, one with no time, a run of days, and two far from the rest (more than 93 days apart).
    const created: Array<{ id: string; on: string; at: string | null }> = [];
    for (let index = 0; index < 3; index += 1) created.push({ id: await seed(clientA, { publishOn: '2026-10-20', publishAtTime: '18:30', format: 'image' }), on: '2026-10-20', at: '18:30' });
    created.push({ id: await seed(clientA, { publishOn: '2026-10-20', publishAtTime: null, format: 'carousel' }), on: '2026-10-20', at: null });
    created.push({ id: await seed(clientA, { publishOn: '2026-10-20', publishAtTime: '09:00', format: 'reels' }), on: '2026-10-20', at: '09:00' });
    for (let day = 1; day <= 12; day += 1) {
      const on = `2026-09-${String(day).padStart(2, '0')}`;
      created.push({ id: await seed(clientA, { publishOn: on, publishAtTime: '12:00', format: 'image' }), on, at: '12:00' });
    }
    created.push({ id: await seed(clientA, { publishOn: '2026-12-31', publishAtTime: '08:00', format: 'reels' }), on: '2026-12-31', at: '08:00' });
    created.push({ id: await seed(clientA, { publishOn: '2025-01-15', publishAtTime: '08:00', format: 'image' }), on: '2025-01-15', at: '08:00' });
    created.push({ id: await seed(clientA, { publishOn: '2026-11-03', publishAtTime: '23:59', format: 'image', status: 'published' }), on: '2026-11-03', at: '23:59' });
    total = created.length;
    // Day, then time (none is the end of the day), then id: all of them from the largest to the smallest.
    expectedOrder = [...created]
      .sort((a, b) => {
        if (a.on !== b.on) return a.on < b.on ? 1 : -1;
        const ta = a.at ?? '99:99';
        const tb = b.at ?? '99:99';
        if (ta !== tb) return ta < tb ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      })
      .map((entry) => entry.id);
  });

  it('walks the whole feed in more than two pages of nine, without repeating or skipping a post, ties and posts far apart included', async () => {
    const { ids: walked, pages } = await walk(clientA);
    expect(total).toBe(20);
    expect(pages.map((body) => body.data.contents.length)).toEqual([9, 9, 2]);
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(expectedOrder);
    expect(pages.map((body) => body.data.nextCursor === null)).toEqual([false, false, true]);
    expect(pages.map((body) => body.meta.count)).toEqual([9, 9, 2]);
  });

  it('opens on the latest post and keeps a post with no time first among those of its day', async () => {
    const first = await page(clientA);
    expect(first.data.contents[0]?.publishOn).toBe('2026-12-31');
    const day = first.data.contents.filter((content) => content.publishOn === '2026-10-20');
    expect(day[0]?.publishAtTime).toBeNull();
  });

  it('counts the whole feed on the first page, not the page, and leaves the counters null on the others', async () => {
    const { pages } = await walk(clientA);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.data.counters).toEqual({ posts: 20, approved: 0, awaitingApproval: 0 });
    for (const body of pages.slice(1)) expect(body.data.counters).toBeNull();
  });

  it('answers an empty feed with no cursor and zeroes', async () => {
    const body = await page(clientOther);
    expect(body.data).toEqual({ contents: [], nextCursor: null, counters: { posts: 0, approved: 0, awaitingApproval: 0 } });
  });

  it('describes an item as the period query does', async () => {
    const client = await w.newClient('feed-shape');
    const id = await seed(client, { publishOn: '2026-10-01', title: 'Mesmo formato' });
    const feed = (await page(client)).data.contents[0];
    const period = (await w.call('GET', people.admin.cookie, `/agencies/${w.agencyA}/clients/${client}/contents?from=2026-10-01&to=2026-10-31`)).json().data.contents[0];
    expect(feed).toEqual(period);
    expect(feed?.id).toBe(id);
  });
});

describe('what enters the feed and the counters', () => {
  let client: string;

  beforeAll(async () => {
    client = await w.newClient('feed-filters');
    await seed(client, { format: 'image', status: 'approved', publishOn: '2026-10-01' });
    await seed(client, { format: 'carousel', status: 'awaiting_approval', publishOn: '2026-10-02' });
    await seed(client, { format: 'reels', status: 'awaiting_approval', publishOn: '2026-10-03' });
    await seed(client, { format: 'image', status: 'in_production', publishOn: '2026-10-04' });
    await seed(client, { format: 'long_video', status: 'approved', publishOn: '2026-10-05' });
    await seed(client, { format: 'vsl', status: 'awaiting_approval', publishOn: '2026-10-06' });
    await seed(client, { format: 'image', status: 'cancelled', publishOn: '2026-10-07' });
    await seed(client, { format: 'reels', status: 'cancelled', publishOn: '2026-10-08' });
    await w.seedScript(client, '2026-10-09');
  });

  it('leaves out stories, long videos, VSLs and cancelled posts, and counts only what it shows', async () => {
    const body = await page(client);
    expect(body.data.contents.map((content) => content.format).sort()).toEqual(['carousel', 'image', 'image', 'reels']);
    expect(body.data.contents.some((content) => content.status === 'cancelled')).toBe(false);
    expect(body.data.counters).toEqual({ posts: 4, approved: 1, awaitingApproval: 2 });
    expect(body.data.nextCursor).toBeNull();
  });
});

describe('isolation', () => {
  beforeAll(async () => {
    await seed(clientOther, { publishOn: '2026-10-10', title: 'Do outro cliente' });
    await seed(clientOther, { publishOn: '2026-10-11', title: 'Do outro cliente 2', status: 'approved' });
    await seed(clientB, { publishOn: '2026-10-12', title: 'De outra agência', ownerUserId: people.adminB.id });
  });

  it('never shows the posts of another client of the same agency, nor counts them', async () => {
    const mine = await walk(clientA);
    const owners = new Set((await Promise.all(mine.ids.map((id) => w.contentRow(id)))).map((row) => row.client_id));
    expect(owners).toEqual(new Set([clientA]));
    expect(mine.pages[0]?.data.counters?.posts).toBe(20);
    expect(mine.pages[0]?.data.counters?.approved).toBe(0);
    const other = await page(clientOther);
    expect(other.data.counters).toEqual({ posts: 2, approved: 1, awaitingApproval: 0 });
    expect(other.data.contents.map((content) => content.title).sort()).toEqual(['Do outro cliente', 'Do outro cliente 2']);
  });

  it('answers 404 to a client of another agency, with the path of the person and with the path of the client', async () => {
    const wrong = await w.call('GET', people.admin.cookie, feedUrl(clientB));
    const dualWrongAgency = await w.call('GET', people.dual.cookie, feedUrl(clientB, w.agencyA));
    const own = await w.call('GET', people.adminB.cookie, feedUrl(clientB, w.agencyB));
    expect(wrong.statusCode).toBe(404);
    expect(dualWrongAgency.statusCode).toBe(404);
    expect(wrong.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.contents).toHaveLength(1);
  });

  it('answers 404, never 400, to a client that is not a UUID or does not exist', async () => {
    const malformed = await w.call('GET', people.admin.cookie, feedUrl('nao-e-uuid'));
    const unknown = await w.call('GET', people.admin.cookie, feedUrl(randomUUID()));
    expect([malformed.statusCode, unknown.statusCode]).toEqual([404, 404]);
  });

  it('still answers for an archived client: its content is read only', async () => {
    await seed(clientArchived, { publishOn: '2026-10-14' });
    await w.getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'archived', archived_at: new Date() });
    const reply = await w.call('GET', people.admin.cookie, feedUrl(clientArchived));
    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.contents).toHaveLength(1);
  });
});

describe('authorization', () => {
  const denied: readonly PersonKey[] = ['sales', 'finance', 'noContent', 'operateOnly'];
  const allowed: readonly PersonKey[] = ['admin', 'manager', 'production', 'owner', 'reader'];

  it.each(denied)('answers 403 to %s, before any statement reaches the contents', async (key) => {
    w.statements.length = 0;
    const reply = await w.call('GET', people[key].cookie, feedUrl(clientA));
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
    expect(w.mentionsContents()).toBe(false);
  });

  it.each(allowed)('lets %s read the feed', async (key) => {
    const reply = await w.call('GET', people[key].cookie, feedUrl(clientA));
    expect(reply.statusCode).toBe(200);
  });

  it('answers 401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: feedUrl(clientA) });
    expect(reply.statusCode).toBe(401);
  });

  it('refuses a person who only belongs to the portal of the client, a removed link, and a collaborator with no content key who is also a client', async () => {
    const portal = await w.call('GET', p.people.portalOne.cookie, feedUrl(p.clientA1));
    const removed = await w.call('GET', p.people.removed.cookie, feedUrl(p.clientA1));
    const bare = await w.call('GET', p.people.dualBare.cookie, feedUrl(p.clientA1));
    // The agency of the path is not theirs, so the guard of the agency answers before any permission: the same 404 as an agency that does not exist.
    expect(portal.statusCode).toBe(404);
    expect(removed.statusCode).toBe(404);
    expect(bare.statusCode).toBe(403);
  });

  it('lets a collaborator who is also a client read through the agency key alone, and refuses an admin of another agency', async () => {
    await seed(p.clientA1, { publishOn: '2026-10-15' });
    const ok = await w.call('GET', p.people.dualRead.cookie, feedUrl(p.clientA1));
    const cross = await w.call('GET', p.people.crossDual.cookie, feedUrl(p.clientA1));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.contents).toHaveLength(1);
    // He is an admin of agency B only: client A1 through the path of agency A is not his, whatever his portal link says.
    expect(cross.statusCode).toBe(404);
  });
});

describe('the cursor', () => {
  it.each([
    ['not base64', '%25%25%25'],
    ['empty', ''],
    ['base64 of text that is not JSON', Buffer.from('oi').toString('base64url')],
    ['a JSON that is not a triple', Buffer.from('{"a":1}').toString('base64url')],
    ['a triple with a day that does not exist', Buffer.from(JSON.stringify(['2026-02-31', '10:00:00', randomUUID()])).toString('base64url')],
    ['a triple with an id that is not a UUID', Buffer.from(JSON.stringify(['2026-10-01', '10:00:00', 'x'])).toString('base64url')],
    ['a triple with a time that is not one', Buffer.from(JSON.stringify(['2026-10-01', 'tarde', randomUUID()])).toString('base64url')],
    ['too long', 'A'.repeat(500)]
  ])('answers 400, never 500, to a cursor that is %s', async (_name, cursor) => {
    const reply = await w.call('GET', people.admin.cookie, feedUrl(clientA, w.agencyA, `?cursor=${cursor}`));
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 400 to a query key the route does not know', async () => {
    const reply = await w.call('GET', people.admin.cookie, feedUrl(clientA, w.agencyA, '?from=2026-10-01'));
    expect(reply.statusCode).toBe(400);
  });

  it('takes a well-formed cursor of a post that does not exist as a position, and answers from there', async () => {
    const cursor = encodeContentFeedCursor({ publishOn: '2026-10-20', time: '18:30:00', id: randomUUID() });
    const body = await page(clientA, cursor);
    expect(body.data.contents.length).toBeGreaterThan(0);
    expect(body.data.contents.every((content) => content.publishOn <= '2026-10-20')).toBe(true);
  });

  it('does not let a cursor made for one client read another: the client is always the path\'s', async () => {
    const first = await page(clientA);
    const body = await page(clientOther, first.data.nextCursor ?? undefined);
    for (const content of body.data.contents) expect((await w.contentRow(content.id)).client_id).toBe(clientOther);
  });
});
