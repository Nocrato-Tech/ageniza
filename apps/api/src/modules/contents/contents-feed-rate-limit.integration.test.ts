import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { encodeContentFeedCursor } from '@ageniza/contracts';

import { createContentsWorld } from './test-support/world.js';

// The feed of the phone is read page by page while a person scrolls, and each page is a pass over the client's rows: 300 pages a
// minute per person, written out here on purpose (a test that looped over the constant would follow a wrong constant). The store of
// the limit lives in the app, and this file has its own world, so no other file spends these people's budgets.
const w = createContentsWorld('contents-feed-limit');
const { people } = w;

const LIMIT = 300;
const BATCH = 25;

let client: string;

const feedUrl = (query = ''): string => `/agencies/${w.agencyA}/clients/${client}/contents/feed${query}`;

const readMany = async (count: number, cookie: string): Promise<Awaited<ReturnType<typeof w.call>>[]> => {
  const replies: Awaited<ReturnType<typeof w.call>>[] = [];
  for (let sent = 0; sent < count; sent += BATCH) {
    replies.push(...await Promise.all(Array.from({ length: Math.min(BATCH, count - sent) }, () => w.call('GET', cookie, feedUrl()))));
  }
  return replies;
};

beforeAll(async () => {
  await w.setup();
  client = await w.newClient('feed-limit');
  await w.seedContent(client, { publishOn: '2026-10-01', title: 'Um post' });
}, 90_000);

afterAll(async () => {
  await w.teardown();
}, 60_000);

describe('the limit of the feed per person', () => {
  it('answers 300 reads and the 301st with 429 RATE_LIMITED and Retry-After, and the limit of one person does not count for another', async () => {
    const replies = await readMany(LIMIT, people.admin.cookie);
    expect(replies.filter((reply) => reply.statusCode === 200)).toHaveLength(LIMIT);

    const refused = await w.call('GET', people.admin.cookie, feedUrl());
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // A refused request counts for nobody, and it keeps answering 429, never a 500 or a 403.
    expect((await w.call('GET', people.admin.cookie, feedUrl())).statusCode).toBe(429);
    // Another person of the same agency is not held by it.
    expect((await w.call('GET', people.manager.cookie, feedUrl())).statusCode).toBe(200);
  }, 120_000);

  it('does not count a person who is not allowed to read: the guard answers first', async () => {
    const forbidden = await readMany(LIMIT + 5, people.noContent.cookie);
    expect(forbidden.every((reply) => reply.statusCode === 403 || reply.statusCode === 404)).toBe(true);
  }, 120_000);
});

describe('one bucket per person, whatever the reader changes in the request', () => {
  it('spends the same budget on another client, another agency and another cursor, and refuses all of them together', async () => {
    // A key made of the person and the client, or of the person and the cursor, would give a reader a new budget with each change.
    const otherClientOfA = await w.newClient('feed-limit-other');
    const clientOfB = await w.newClient('feed-limit-b', { agencyId: w.agencyB });
    const cursor = (): string => encodeContentFeedCursor({ publishOn: '2026-10-20', time: '18:30:00', id: randomUUID() });
    const urls = (): string[] => [
      feedUrl(),
      feedUrl(`?cursor=${cursor()}`),
      `/agencies/${w.agencyA}/clients/${otherClientOfA}/contents/feed`,
      `/agencies/${w.agencyA}/clients/${otherClientOfA}/contents/feed?cursor=${cursor()}`,
      `/agencies/${w.agencyB}/clients/${clientOfB}/contents/feed`,
      `/agencies/${w.agencyB}/clients/${clientOfB}/contents/feed?cursor=${cursor()}`
    ];
    const cookie = people.dual.cookie;

    const spent: number[] = [];
    for (let sent = 0; sent < LIMIT; sent += BATCH) {
      const batch = await Promise.all(Array.from({ length: Math.min(BATCH, LIMIT - sent) }, (_, index) =>
        w.call('GET', cookie, urls()[(sent + index) % 6] as string)));
      spent.push(...batch.map((reply) => reply.statusCode));
    }
    expect(spent.every((status) => status === 200)).toBe(true);

    // The 301st is refused whichever way it varies: all six shapes land on the one budget.
    for (const url of urls()) {
      const refused = await w.call('GET', cookie, url);
      expect(refused.statusCode, url).toBe(429);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    }
  }, 120_000);
});
