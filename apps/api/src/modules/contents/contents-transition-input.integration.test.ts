import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTransitionFixtures } from './test-support/transition-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';
import type { TransitionAction } from './transition-errors.js';

// Issue #563, items 1 to 3: what the moves of a content take as input and where the day of a publication comes from. This world has no
// injected clock: the app runs as in production, with the database's own `now()`. Each test names the mutation that turns it red.
const w = createContentsWorld('transition-input');
const f = createTransitionFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;
const FLOOR = '2000-01-01';
const BELOW_THE_FLOOR = ['1999-12-31', '0001-01-01'] as const;

let clientA: string;
let folderA: string;

const urlA = (): string => `/agencies/${w.agencyA}/clients/${clientA}/contents`;
const act = (action: TransitionAction, contentId: string, body?: unknown): Promise<Reply> =>
  w.call('POST', people.admin.cookie, f.urlOf(clientA, contentId, action), body);
const statusOf = async (contentId: string): Promise<string> => (await w.contentRow(contentId)).status as string;
const publishedOnOf = async (contentId: string): Promise<string | null> =>
  (await w.getOwner().knex.raw<{ rows: Array<{ day: string | null }> }>('select published_on::text as day from public.contents where id = ?::uuid', [contentId])).rows[0]?.day ?? null;

const refusedAsInput = (reply: Reply): void => {
  expect(reply.statusCode).toBe(400);
  expect(reply.json().error.code).toBe('VALIDATION_ERROR');
  expect(JSON.stringify(reply.json().error)).not.toMatch(NO_DATABASE_DETAIL);
};

beforeAll(async () => {
  await w.setup();
  await f.setup();
  clientA = await w.newClient('a');
  folderA = await w.folderOf(clientA);
}, 90_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe('the floor of the day of a content: 2000-01-01 (issue #563, item 1)', () => {
  it.each(BELOW_THE_FLOOR)('refuses publishedOn %s with 400 VALIDATION_ERROR, and publishes nothing', async (day) => {
    const fixture = await f.fixtureFor('publish', clientA);
    w.statements.length = 0;

    refusedAsInput(await act('publish', fixture.contentId, { publishedOn: day }));

    expect(await statusOf(fixture.contentId)).toBe('approved');
    expect(w.statements.some((statement) => /publish_content/.test(statement))).toBe(false);
  });

  it('accepts publishedOn on the floor itself', async () => {
    const fixture = await f.fixtureFor('publish', clientA);
    const reply = await act('publish', fixture.contentId, { publishedOn: FLOOR });
    expect(reply.statusCode).toBe(200);
    expect(await publishedOnOf(fixture.contentId)).toBe(FLOOR);
  });

  it.each(BELOW_THE_FLOOR)('refuses publishOn %s on reschedule, and moves nothing', async (day) => {
    const contentId = await w.seedContent(clientA, { status: 'cancelled', publishOn: '2026-10-20' });

    refusedAsInput(await act('reschedule', contentId, { publishOn: day }));

    expect(await statusOf(contentId)).toBe('cancelled');
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
  });

  it('accepts publishOn on the floor itself on reschedule', async () => {
    const contentId = await w.seedContent(clientA, { status: 'cancelled', publishOn: '2026-10-20' });
    expect((await act('reschedule', contentId, { publishOn: FLOOR })).statusCode).toBe(200);
    expect(await w.publishOnOf(contentId)).toBe(FLOOR);
  });

  it.each(BELOW_THE_FLOOR)('refuses publishOn %s on create, and writes no content', async (day) => {
    const before = await w.countContents(clientA);

    refusedAsInput(await w.call('POST', people.admin.cookie, urlA(), { title: 'Antigo', format: 'reels', publishOn: day, folderId: folderA }));

    expect(await w.countContents(clientA)).toBe(before);
  });

  it('accepts publishOn on the floor itself on create', async () => {
    const reply = await w.call('POST', people.admin.cookie, urlA(), { title: 'No piso', format: 'reels', publishOn: FLOOR, folderId: folderA });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().publishOn).toBe(FLOOR);
  });

  it.each(BELOW_THE_FLOOR)('refuses publishOn %s on edit, and changes nothing', async (day) => {
    const contentId = await w.seedContent(clientA, { publishOn: '2026-10-20' });

    refusedAsInput(await w.call('PATCH', people.admin.cookie, `${urlA()}/${contentId}`, { publishOn: day }));

    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
  });

  it('accepts publishOn on the floor itself on edit', async () => {
    const contentId = await w.seedContent(clientA, { publishOn: '2026-10-20' });
    expect((await w.call('PATCH', people.admin.cookie, `${urlA()}/${contentId}`, { publishOn: FLOOR })).statusCode).toBe(200);
    expect(await w.publishOnOf(contentId)).toBe(FLOOR);
  });
});

describe('a move that takes no body does not take one (issue #563, item 2)', () => {
  it.each(['submit', 'unpublish', 'cancel'] as const)('%s answers 400 VALIDATION_ERROR to a body with a field, and the database is not asked', async (action) => {
    const fixture = await f.fixtureFor(action, clientA);
    const before = await statusOf(fixture.contentId);
    w.statements.length = 0;

    refusedAsInput(await act(action, fixture.contentId, { status: 'approved' }));

    expect(await statusOf(fixture.contentId)).toBe(before);
    expect(w.statements.some((statement) => new RegExp(`${action}_content`).test(statement))).toBe(false);
  });

  it.each(['submit', 'unpublish', 'cancel'] as const)('%s still takes no body and an empty one', async (action) => {
    const empty = await f.fixtureFor(action, clientA);
    const none = await f.fixtureFor(action, clientA);

    expect((await act(action, empty.contentId, {})).statusCode).toBe(200);
    expect((await act(action, none.contentId)).statusCode).toBe(200);
  });
});

describe('the day of a publication is the database\'s, not the API\'s (issue #563, item 3)', () => {
  it('records today in São Paulo by the clock of the database even when the clock of the API is years behind', async () => {
    const fixture = await f.fixtureFor('publish', clientA);
    const before = await f.today();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-06-01T12:00:00.000Z'));

    const reply = await act('publish', fixture.contentId);

    vi.useRealTimers();
    const after = await f.today();
    expect(reply.statusCode).toBe(200);
    expect([before, after]).toContain(reply.json().publishedOn);
    expect([before, after]).toContain(await publishedOnOf(fixture.contentId));
    expect(reply.json().publishedOn).not.toBe('2020-06-01');
  });

  it('asks the database for the day, with no instant of the API in the statement', async () => {
    const fixture = await f.fixtureFor('publish', clientA);
    w.statements.length = 0;

    expect((await act('publish', fixture.contentId)).statusCode).toBe(200);

    expect(w.statements.some((statement) => /sao_paulo_date\(pg_catalog\.now\(\)\)/.test(statement))).toBe(true);
  });
});
