import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createTransitionFixtures, type TransitionPerson } from './test-support/transition-fixtures.js';
import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';

// Scope telas-melhorias, subtask S4: sending for approval opens a round with a deadline and a note, one content at a time or a batch of
// one client's. The database checks the deadline, the note and the batch (migration 20261110000100); what these tests prove is what the
// routes add: the bodies they take, the client they hold a batch to, the permission, the answers by name, and `approval` where it is read.
// Each test names the change to the code that turns it red.
const w = createContentsWorld('rounds');
const f = createTransitionFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A0\d\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;
const NOTE = 'Preciso da resposta até sexta para publicar na segunda.';

let clientA: string;
let clientA2: string;
let clientB: string;

type Person = PersonKey | TransitionPerson;
const cookieOf = (person: Person): string => (person in people ? people[person as PersonKey].cookie : f.people[person as TransitionPerson].cookie);

const submit = (contentId: string, body?: unknown, person: Person = 'manager', clientId = clientA): Promise<Reply> =>
  w.call('POST', cookieOf(person), f.urlOf(clientId, contentId, 'submit'), body);
const batchUrl = (clientId: string, agencyId = w.agencyA): string => `/agencies/${agencyId}/clients/${clientId}/contents/submit`;
const submitBatch = (clientId: string, body: unknown, person: Person = 'manager'): Promise<Reply> => w.call('POST', cookieOf(person), batchUrl(clientId), body);

const knex = () => w.getOwner().knex;
const statusOf = async (id: string): Promise<string> => (await w.contentRow(id)).status as string;
const roundsOf = (id: string) => knex()('content_approval_rounds').where({ content_id: id }).orderBy('sequence').select(
  'sequence', 'note', 'sent_by', 'batch_id', 'client_id', knex().raw('due_on::text as due_on'), knex().raw("to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at")
);

const dayFrom = async (offset: number): Promise<string> =>
  (await knex().raw<{ rows: Array<{ day: string }> }>('select (app_private.sao_paulo_date(now()) + ?::int)::text as day', [offset])).rows[0]?.day as string;

/** The instant the database gives a deadline given as a day: the end of that day in São Paulo, from the one function that converts days. */
const endOfDay = async (day: string): Promise<string> =>
  new Date((await knex().raw<{ rows: Array<{ at: Date }> }>('select app_private.sao_paulo_end_of_day(?::date) as at', [day])).rows[0]?.at as Date).toISOString();

/** The São Paulo day of an instant, by the one function that converts days. */
const dayOf = async (instant: string): Promise<string> =>
  (await knex().raw<{ rows: Array<{ day: string }> }>('select app_private.sao_paulo_date(?::timestamptz)::text as day', [instant])).rows[0]?.day as string;

/** An instant `hours` from the real clock: the routes read the database's `now()`, so the margins of these tests are minutes, never seconds. */
const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

const error = (reply: Reply, status: number, code: string): void => {
  expect(reply.statusCode).toBe(status);
  expect(reply.json().error.code).toBe(code);
  expect(JSON.stringify(reply.json().error)).not.toMatch(NO_DATABASE_DETAIL);
};

/** A content that can be sent: in production, with the media its format needs. */
const sendable = async (clientId = clientA, extra: { status?: 'in_production' | 'adjusting'; title?: string; publishOn?: string } = {}): Promise<string> => {
  const id = await w.seedContent(clientId, { format: 'reels', ...extra });
  await f.addMedia(id, clientId);
  return id;
};

beforeAll(async () => {
  await w.setup();
  await f.setup();
  clientA = await w.newClient('a');
  clientA2 = await w.newClient('a2');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
}, 90_000);

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe('the individual send with a deadline and a note', () => {
  it('opens a round with the deadline and the note, and every place that reads the content tells it', async () => {
    const id = await sendable();
    const dueOn = await dayFrom(3);

    const reply = await submit(id, { dueOn, note: NOTE });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().status).toBe('awaiting_approval');
    expect(reply.json().approval).toEqual({ sentAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), dueAt: await endOfDay(dueOn), dueOn, note: NOTE });
    const [round, ...rest] = await roundsOf(id);
    expect(rest).toEqual([]);
    expect(round).toMatchObject({ sequence: 1, note: NOTE, due_on: dueOn, due_at: await endOfDay(dueOn), sent_by: people.manager.id, client_id: clientA });

    const approval = reply.json().approval;
    const detail = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${id}`);
    expect(detail.json().approval).toEqual(approval);
    const period = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents?from=2026-10-01&to=2026-10-31`);
    expect(period.json().data.contents.find((item: { id: string }) => item.id === id)?.approval).toEqual(approval);
    const feed = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/feed`);
    expect(feed.json().data.contents.find((item: { id: string }) => item.id === id)?.approval).toEqual(approval);
  });

  it('sends with neither, with an empty body and with no body, and the round has no deadline and no note', async () => {
    for (const body of [undefined, {}, { dueOn: undefined }]) {
      const id = await sendable();

      const reply = await submit(id, body);

      expect(reply.statusCode).toBe(200);
      expect(reply.json().approval).toEqual({ sentAt: expect.any(String), dueAt: null, dueOn: null, note: null });
      expect(await roundsOf(id)).toMatchObject([{ sequence: 1, note: null, due_on: null, due_at: null }]);
    }
  });

  it('takes the deadline as an instant with its offset, keeps the hour, and tells the São Paulo day of that instant', async () => {
    const dueAt = inHours(48);
    const offsets = [dueAt, new Date(dueAt).toISOString().replace('Z', '+00:00'), inHours(30)];
    for (const [index, instant] of offsets.entries()) {
      const id = await sendable();

      const reply = await submit(id, { dueAt: instant, note: NOTE });

      expect(reply.statusCode, instant).toBe(200);
      const expected = new Date(instant).toISOString();
      expect(reply.json().approval, instant).toEqual({ sentAt: expect.any(String), dueAt: expected, dueOn: await dayOf(expected), note: NOTE });
      expect(await roundsOf(id), String(index)).toMatchObject([{ sequence: 1, due_at: expected, due_on: await dayOf(expected) }]);
    }
  });

  it('reads the same instant in the detail, in the period, in the feed and in "Parado no cliente", whatever offset it was sent with', async () => {
    const id = await sendable(clientA, { publishOn: '2026-10-24' });
    const instant = inHours(52);
    const withOffset = `${new Date(new Date(instant).getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
    expect((await submit(id, { dueAt: withOffset })).statusCode).toBe(200);
    const expected = new Date(withOffset).toISOString();

    const detail = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${id}`);
    const period = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents?from=2026-10-01&to=2026-10-31`);
    const feed = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/feed`);
    const awaiting = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/contents/awaiting-client`);

    expect(detail.json().approval.dueAt).toBe(expected);
    expect(period.json().data.contents.find((item: { id: string }) => item.id === id)?.approval.dueAt).toBe(expected);
    expect(feed.json().data.contents.find((item: { id: string }) => item.id === id)?.approval.dueAt).toBe(expected);
    const waiting = awaiting.json().data.flatMap((group: { contents: Array<{ id: string; dueAt: string | null }> }) => group.contents).find((item: { id: string }) => item.id === id);
    expect(waiting?.dueAt).toBe(expected);
  });

  it.each([
    ['an instant with no offset', { dueAt: '2026-11-20T18:00:00' }],
    ['a day as the instant', { dueAt: '2026-11-20' }],
    ['a null instant', { dueAt: null }],
    ['a number as the instant', { dueAt: 1_800_000_000_000 }],
    ['the instant and the day together', { dueAt: '2026-11-20T18:00:00-03:00', dueOn: '2026-11-20' }]
  ])('answers 400 VALIDATION_ERROR to %s, and the database is not asked', async (_name, body) => {
    const id = await sendable();
    w.statements.length = 0;

    error(await submit(id, body), 400, 'VALIDATION_ERROR');

    expect(w.statements.some((statement) => /app_private\.submit_content/.test(statement))).toBe(false);
    expect(await statusOf(id)).toBe('in_production');
  });

  it('refuses an instant that has passed or that is more than 90 days ahead as a 400 that leaves the content in production, and accepts one minute from now and 89 days', async () => {
    for (const [instant, accepted] of [
      [inHours(1 / 60 + 4 / 60), true],
      [inHours(89 * 24), true],
      [inHours(-1 / 60), false],
      [inHours(-48), false],
      [inHours(91 * 24), false],
      [inHours(90 * 24 + 1), false]
    ] as const) {
      const id = await sendable();

      const reply = await submit(id, { dueAt: instant });

      if (accepted) {
        expect(reply.statusCode, instant).toBe(200);
        expect(await statusOf(id)).toBe('awaiting_approval');
      } else {
        error(reply, 400, 'CONTENT_APPROVAL_DUE_INVALID');
        expect(await statusOf(id)).toBe('in_production');
        expect(await roundsOf(id)).toEqual([]);
      }
    }
  });

  it('refuses the year the database has no instant for as a 400 VALIDATION_ERROR and not a 500, and moves nothing', async () => {
    const id = await sendable();

    error(await submit(id, { dueAt: '0000-01-01T00:00:00Z' }), 400, 'VALIDATION_ERROR');
    error(await submitBatch(clientA, { contentIds: [id], dueAt: '0000-06-15T12:00:00-03:00' }), 400, 'VALIDATION_ERROR');

    expect(await statusOf(id)).toBe('in_production');
  });

  it('takes a deadline given as the day as the end of that day in São Paulo, and refuses the day 90 days ahead, whose end is past the 90 days from now', async () => {
    for (const [offset, accepted] of [[1, true], [89, true], [-1, false], [90, false], [91, false]] as const) {
      const id = await sendable();
      const dueOn = await dayFrom(offset);

      const reply = await submit(id, { dueOn });

      if (accepted) {
        expect(reply.statusCode, `day ${offset}`).toBe(200);
        expect(reply.json().approval, `day ${offset}`).toMatchObject({ dueOn, dueAt: await endOfDay(dueOn) });
      } else {
        error(reply, 400, 'CONTENT_APPROVAL_DUE_INVALID');
        expect(await statusOf(id)).toBe('in_production');
        expect(await roundsOf(id)).toEqual([]);
      }
    }
  });

  it('sends the deadline alone and the note alone, and trims the note', async () => {
    const dueOn = await dayFrom(1);
    const onlyDue = await sendable();
    const onlyNote = await sendable();

    expect((await submit(onlyDue, { dueOn })).json().approval).toMatchObject({ dueOn, note: null });
    expect((await submit(onlyNote, { note: `  ${NOTE}  ` })).json().approval).toMatchObject({ dueOn: null, note: NOTE });
  });

  it('counts the day in São Paulo, not in UTC: the database day is the limit of both ends', async () => {
    const id = await sendable();

    // The day the database calls "yesterday" is refused whatever the hour of the server is.
    error(await submit(id, { dueOn: await dayFrom(-1) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');
    expect((await submit(id, { dueOn: await dayFrom(1) })).statusCode).toBe(200);
  });

  it.each([
    ['a note of 501 characters', { note: 'a'.repeat(501) }],
    ['a note of only spaces', { note: '   ' }],
    ['an empty note', { note: '' }],
    ['a null note', { note: null }],
    ['a note with an invisible character', { note: `Oi${String.fromCodePoint(0x200b)}` }],
    ['a deadline that is not a day', { dueOn: '2026-13-45' }],
    ['a deadline that is an instant', { dueOn: '2026-10-20T10:00:00Z' }],
    ['a null deadline', { dueOn: null }],
    ['a field that is not the body\'s', { dueOn: '2099-01-01', status: 'approved' }]
  ])('answers 400 VALIDATION_ERROR to %s, and the database is not asked', async (_name, body) => {
    const id = await sendable();
    w.statements.length = 0;

    const reply = await submit(id, body);

    error(reply, 400, 'VALIDATION_ERROR');
    expect(w.statements.some((statement) => /app_private\.submit_content/.test(statement))).toBe(false);
    expect(await statusOf(id)).toBe('in_production');
  });

  it('accepts a note of exactly 500 characters, counted as characters and not as bytes', async () => {
    const id = await sendable();
    const note = 'ã'.repeat(500);

    const reply = await submit(id, { note });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().approval.note).toBe(note);
  });

  it('opens a new round when the content is resent after an adjustment, and reads the latest', async () => {
    const id = await sendable();
    expect((await submit(id, { note: 'Primeira' })).statusCode).toBe(200);
    await knex()('contents').where({ id }).update({ status: 'adjusting' });
    const dueOn = await dayFrom(5);

    const reply = await submit(id, { dueOn, note: 'Segunda' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().approval).toMatchObject({ dueOn, note: 'Segunda' });
    expect(await roundsOf(id)).toMatchObject([{ sequence: 1, note: 'Primeira' }, { sequence: 2, note: 'Segunda', due_on: dueOn }]);
  });

  it('repeats the same send without a second round, and refuses another deadline or note for a content that already waits', async () => {
    const id = await sendable();
    const dueOn = await dayFrom(2);
    expect((await submit(id, { dueOn, note: NOTE })).statusCode).toBe(200);

    expect((await submit(id, { dueOn, note: NOTE })).statusCode).toBe(200);
    error(await submit(id, { dueOn: await dayFrom(4), note: NOTE }), 409, 'CONTENT_STATE');
    error(await submit(id, { dueOn, note: 'Outro recado' }), 409, 'CONTENT_STATE');
    error(await submit(id, {}), 409, 'CONTENT_STATE');

    expect(await roundsOf(id)).toMatchObject([{ sequence: 1, note: NOTE, due_on: dueOn }]);
  });

  it('shows the round only while the content awaits approval: not in adjustment, approved or cancelled, with the round still there', async () => {
    const moves = {
      adjusting: (id: string) => knex()('contents').where({ id }).update({ status: 'adjusting' }),
      approved: (id: string) => w.call('POST', people.approver.cookie, f.urlOf(clientA, id, 'approve-by-agency'), { revision: 1, reason: 'Aprovado por telefone.' }),
      cancelled: (id: string) => w.call('POST', people.manager.cookie, f.urlOf(clientA, id, 'cancel'))
    };
    for (const [status, move] of Object.entries(moves)) {
      const id = await sendable();
      expect((await submit(id, { note: NOTE })).statusCode).toBe(200);
      const read = async (): Promise<unknown> =>
        (await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${id}`)).json().approval;
      expect(await read(), 'while it waits').toMatchObject({ note: NOTE });

      await move(id);

      expect(await statusOf(id)).toBe(status);
      expect(await read(), status).toBeNull();
      expect(await roundsOf(id)).toHaveLength(1);
    }
  });

  it('reads no round for a content that waited before the rounds existed', async () => {
    const id = await w.seedContent(clientA, { status: 'awaiting_approval' });

    const detail = await w.call('GET', people.reader.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${id}`);

    expect(detail.json().approval).toBeNull();
  });

  it('keeps the body of cancel and unpublish empty: the deadline and the note are the send\'s alone', async () => {
    const id = await w.seedContent(clientA, { status: 'approved' });
    await f.addMedia(id, clientA);

    for (const action of ['cancel', 'unpublish'] as const) {
      const reply = await w.call('POST', people.manager.cookie, f.urlOf(clientA, id, action), { dueOn: await dayFrom(1), note: NOTE });
      error(reply, 400, 'VALIDATION_ERROR');
    }
    expect(await statusOf(id)).toBe('approved');
  });
});

describe('the batch send', () => {
  it('sends the contents of one client together, all with the same deadline, note and batch', async () => {
    const ids = [await sendable(clientA, { publishOn: '2026-10-22' }), await sendable(clientA, { publishOn: '2026-10-21' }), await sendable(clientA, { publishOn: '2026-10-23' })];
    const outsider = await sendable(clientA);
    const dueOn = await dayFrom(7);

    const reply = await submitBatch(clientA, { contentIds: ids, dueOn, note: NOTE });

    expect(reply.statusCode).toBe(200);
    const { batchId, contents } = reply.json().data;
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(contents.map((item: { id: string }) => item.id)).toEqual([ids[1], ids[0], ids[2]]);
    for (const item of contents) {
      expect(item.status).toBe('awaiting_approval');
      expect(item.approval).toEqual({ sentAt: expect.any(String), dueAt: await endOfDay(dueOn), dueOn, note: NOTE });
    }
    for (const id of ids) {
      expect(await statusOf(id)).toBe('awaiting_approval');
      expect(await roundsOf(id)).toMatchObject([{ sequence: 1, batch_id: batchId, note: NOTE, due_on: dueOn, due_at: await endOfDay(dueOn), sent_by: people.manager.id }]);
    }
    expect(await statusOf(outsider)).toBe('in_production');
  });

  it('sends the batch with one instant, and every content of it keeps that hour to the second', async () => {
    const ids = [await sendable(), await sendable()];
    const dueAt = inHours(48);

    const reply = await submitBatch(clientA, { contentIds: ids, dueAt, note: NOTE });

    expect(reply.statusCode).toBe(200);
    for (const item of reply.json().data.contents) expect(item.approval).toEqual({ sentAt: expect.any(String), dueAt, dueOn: await dayOf(dueAt), note: NOTE });
    for (const id of ids) expect(await roundsOf(id)).toMatchObject([{ due_at: dueAt, due_on: await dayOf(dueAt) }]);
  });

  it('refuses the instant and the day together, an instant that passed and one beyond 90 days, and sends none', async () => {
    const ids = [await sendable(), await sendable()];

    error(await submitBatch(clientA, { contentIds: ids, dueAt: inHours(24), dueOn: await dayFrom(2) }), 400, 'VALIDATION_ERROR');
    error(await submitBatch(clientA, { contentIds: ids, dueAt: inHours(-1) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');
    error(await submitBatch(clientA, { contentIds: ids, dueAt: inHours(91 * 24) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');

    expect(await Promise.all(ids.map(statusOf))).toEqual(['in_production', 'in_production']);
    for (const id of ids) expect(await roundsOf(id)).toEqual([]);
  });

  it('sends with neither a deadline nor a note, and a batch of one', async () => {
    const id = await sendable();

    const reply = await submitBatch(clientA, { contentIds: [id] });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.contents).toHaveLength(1);
    expect(reply.json().data.contents[0].approval).toEqual({ sentAt: expect.any(String), dueAt: null, dueOn: null, note: null });
  });

  it('accepts exactly 30 contents, and refuses 31 as a 400 that sends none', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 31; index += 1) {
      const id = await w.seedContent(clientA2, { format: 'image' });
      await f.addMedia(id, clientA2, 'image');
      ids.push(id);
    }

    error(await submitBatch(clientA2, { contentIds: ids }), 400, 'VALIDATION_ERROR');
    expect(await Promise.all(ids.map(statusOf))).toEqual(ids.map(() => 'in_production'));

    const reply = await submitBatch(clientA2, { contentIds: ids.slice(0, 30) });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.contents).toHaveLength(30);
    expect(await statusOf(ids[30]!)).toBe('in_production');
  }, 60_000);

  it('answers 404 and sends none when one content is of another client of the same agency', async () => {
    const mine = [await sendable(clientA), await sendable(clientA)];
    const other = await sendable(clientA2);

    const reply = await submitBatch(clientA, { contentIds: [mine[0]!, other, mine[1]!] });

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
    expect(await Promise.all([...mine, other].map(statusOf))).toEqual(['in_production', 'in_production', 'in_production']);
    for (const id of [...mine, other]) expect(await roundsOf(id)).toEqual([]);
  });

  it('answers 404 when every content is of another client, and sends none', async () => {
    const other = [await sendable(clientA2), await sendable(clientA2)];

    error(await submitBatch(clientA, { contentIds: other }), 404, 'NOT_FOUND');

    expect(await Promise.all(other.map(statusOf))).toEqual(['in_production', 'in_production']);
  });

  it('answers 404 for a content of another agency, an absent one, and a client of another agency, and sends none', async () => {
    const mine = await sendable(clientA);
    const foreign = await w.seedContent(clientB, { format: 'reels', ownerUserId: people.adminB.id });

    error(await submitBatch(clientA, { contentIds: [mine, foreign] }), 404, 'NOT_FOUND');
    error(await submitBatch(clientA, { contentIds: [mine, randomUUID()] }), 404, 'NOT_FOUND');
    error(await submitBatch(clientB, { contentIds: [foreign] }), 404, 'NOT_FOUND');
    error(await submitBatch(randomUUID(), { contentIds: [mine] }), 404, 'NOT_FOUND');
    error(await submitBatch('not-a-uuid', { contentIds: [mine] }), 404, 'NOT_FOUND');

    expect(await statusOf(mine)).toBe('in_production');
    expect(await statusOf(foreign)).toBe('in_production');
  });

  it('is all or nothing: one content that cannot be sent leaves the others in production, with its own code', async () => {
    const ready = await sendable();
    const noMedia = await w.seedContent(clientA, { format: 'reels' });
    const waiting = await w.seedContent(clientA, { status: 'awaiting_approval' });
    const pendingMedia = await w.seedContent(clientA, { format: 'reels' });
    await f.addMedia(pendingMedia, clientA, 'video', 'pending');
    const withTask = await sendable();
    await w.seedTask(withTask, 'pending');

    error(await submitBatch(clientA, { contentIds: [ready, noMedia] }), 409, 'CONTENT_MEDIA_INCOMPLETE');
    error(await submitBatch(clientA, { contentIds: [ready, waiting] }), 409, 'CONTENT_STATE');
    error(await submitBatch(clientA, { contentIds: [ready, pendingMedia] }), 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
    error(await submitBatch(clientA, { contentIds: [ready, withTask] }), 409, 'CONTENT_TASKS_NOT_APPROVED');

    expect(await statusOf(ready)).toBe('in_production');
    expect(await roundsOf(ready)).toEqual([]);
  });

  it('refuses a deadline out of range at both ends and a note that is too long, and sends none', async () => {
    const ids = [await sendable(), await sendable()];

    error(await submitBatch(clientA, { contentIds: ids, dueOn: await dayFrom(-1) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');
    error(await submitBatch(clientA, { contentIds: ids, dueOn: await dayFrom(91) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');
    error(await submitBatch(clientA, { contentIds: ids, dueOn: await dayFrom(90) }), 400, 'CONTENT_APPROVAL_DUE_INVALID');
    error(await submitBatch(clientA, { contentIds: ids, note: 'a'.repeat(501) }), 400, 'VALIDATION_ERROR');
    error(await submitBatch(clientA, { contentIds: ids, note: '   ' }), 400, 'VALIDATION_ERROR');

    expect(await Promise.all(ids.map(statusOf))).toEqual(['in_production', 'in_production']);
    for (const [offset] of [[1], [89]] as const) {
      const id = await sendable();
      expect((await submitBatch(clientA, { contentIds: [id], dueOn: await dayFrom(offset) })).statusCode, `day ${offset}`).toBe(200);
    }
  });

  it.each([
    ['no list', {}],
    ['an empty list', { contentIds: [] }],
    ['a list that repeats a content', { contentIds: ['REPEAT', 'REPEAT'] }],
    ['an id that is not a UUID', { contentIds: ['abc'] }],
    ['a null id', { contentIds: [null] }],
    ['a list that is not a list', { contentIds: 'x' }],
    ['a field that is not the body\'s', { contentIds: ['ONE'], status: 'approved' }]
  ])('answers 400 VALIDATION_ERROR to %s, and the database is not asked', async (_name, template) => {
    const id = await sendable();
    const body = JSON.parse(JSON.stringify(template).replaceAll('REPEAT', id).replaceAll('ONE', id));
    w.statements.length = 0;

    error(await submitBatch(clientA, body), 400, 'VALIDATION_ERROR');

    expect(w.statements.some((statement) => /app_private\.submit_contents/.test(statement))).toBe(false);
    expect(await statusOf(id)).toBe('in_production');
  });

  it('refuses the same content in two spellings of its id, once', async () => {
    const id = await sendable();

    error(await submitBatch(clientA, { contentIds: [id, id.toUpperCase()] }), 400, 'VALIDATION_ERROR');

    expect(await statusOf(id)).toBe('in_production');
  });

  it('answers 409 CLIENT_ARCHIVED for a client that was archived, and sends none', async () => {
    const archived = await w.newClient('archived');
    const id = await w.seedContent(archived, { format: 'reels' });
    await f.addMedia(id, archived);
    await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });

    error(await submitBatch(archived, { contentIds: [id] }), 409, 'CLIENT_ARCHIVED');

    expect(await statusOf(id)).toBe('in_production');
  });

  const SENDERS: readonly Person[] = ['admin', 'manager', 'production', 'owner', 'operateRead', 'approver'];
  const OTHERS: readonly Person[] = ['sales', 'finance', 'noContent', 'reader', 'operateOnly', 'publishRead', 'cancelRead', 'approveRead'];

  it.each(OTHERS)('answers 403 to %s, before any statement of the module, and sends none', async (person) => {
    const id = await sendable();
    w.statements.length = 0;

    error(await submitBatch(clientA, { contentIds: [id] }, person), 403, 'FORBIDDEN');

    expect(w.mentionsContents()).toBe(false);
    expect(await statusOf(id)).toBe('in_production');
  });

  it.each(SENDERS)('lets %s send a batch, as it lets them send one content', async (person) => {
    const id = await sendable();

    const reply = await submitBatch(clientA, { contentIds: [id] }, person);

    expect(reply.statusCode).toBe(200);
    expect(await statusOf(id)).toBe('awaiting_approval');
  });

  it('answers 401 without a session, and sends none', async () => {
    const id = await sendable();

    const reply = await w.getApp().app.inject({ method: 'POST', url: batchUrl(clientA), headers: { origin: TEST_APP_PUBLIC_URL }, payload: { contentIds: [id] } });

    expect(reply.statusCode).toBe(401);
    expect(await statusOf(id)).toBe('in_production');
  });

  it('answers 403 to a person of another agency, and sends none', async () => {
    const id = await sendable();

    const reply = await w.call('POST', people.adminB.cookie, batchUrl(clientA), { contentIds: [id] });

    expect(reply.statusCode).toBeGreaterThanOrEqual(403);
    expect(reply.statusCode).toBeLessThan(500);
    expect(await statusOf(id)).toBe('in_production');
  });

  it('reads the agency of the path for a person who belongs to two: the batch of agency A is not sent from agency B', async () => {
    const id = await sendable();

    const reply = await w.call('POST', people.dual.cookie, batchUrl(clientA, w.agencyB), { contentIds: [id] });

    error(reply, 404, 'NOT_FOUND');
    expect(await statusOf(id)).toBe('in_production');
    expect((await w.call('POST', people.dual.cookie, batchUrl(clientA), { contentIds: [id] })).statusCode).toBe(200);
  });
});

describe('what the database refuses is answered by name, never a 500', () => {
  const databaseRefusal = (code: string): Error => Object.assign(new Error('database detail that never leaves'), { code });

  it.each([
    ['A0120', 400, 'CONTENT_APPROVAL_DUE_INVALID'],
    ['A0068', 400, 'CONTENT_APPROVAL_NOTE_INVALID'],
    ['A0062', 409, 'CONTENT_STATE'],
    ['A0060', 404, 'NOT_FOUND'],
    ['A0061', 409, 'CLIENT_ARCHIVED'],
    ['A0066', 409, 'CONTENT_TASKS_NOT_APPROVED'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s of the individual send with %i %s and moves nothing', async (code, status, name) => {
    const id = await sendable();
    w.runBeforeStatement(/app_private\.submit_content\b/, async () => {
      throw databaseRefusal(code);
    });
    try {
      error(await submit(id, { note: NOTE }), status, name);
      expect(await statusOf(id)).toBe('in_production');
    } finally {
      w.clearHook();
    }
  });

  it.each([
    ['A0120', 400, 'CONTENT_APPROVAL_DUE_INVALID'],
    ['A0121', 400, 'CONTENT_BATCH_INVALID'],
    ['A0122', 400, 'CONTENT_BATCH_MIXED_CLIENTS'],
    ['A0068', 400, 'CONTENT_APPROVAL_NOTE_INVALID'],
    ['A0062', 409, 'CONTENT_STATE'],
    ['A0060', 404, 'NOT_FOUND'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s of the batch send with %i %s and moves nothing', async (code, status, name) => {
    const id = await sendable();
    w.runBeforeStatement(/app_private\.submit_contents\b/, async () => {
      throw databaseRefusal(code);
    });
    try {
      error(await submitBatch(clientA, { contentIds: [id] }), status, name);
      expect(await statusOf(id)).toBe('in_production');
    } finally {
      w.clearHook();
    }
  });

  it('answers 403 to a refusal of the policy while the client is active, and 409 CLIENT_ARCHIVED once it was archived, for the batch', async () => {
    const id = await sendable();
    w.runBeforeStatement(/app_private\.submit_contents\b/, async () => {
      throw databaseRefusal('42501');
    });
    try {
      error(await submitBatch(clientA, { contentIds: [id] }), 403, 'FORBIDDEN');
    } finally {
      w.clearHook();
    }

    const archived = await w.newClient('archived-meanwhile');
    const other = await w.seedContent(archived, { format: 'reels' });
    await f.addMedia(other, archived);
    w.runBeforeStatement(/app_private\.submit_contents\b/, async () => {
      await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
      throw databaseRefusal('42501');
    });
    try {
      error(await submitBatch(archived, { contentIds: [other] }), 409, 'CLIENT_ARCHIVED');
    } finally {
      w.clearHook();
    }
  });

  it('refuses a missing media as 409 CONTENT_MEDIA_INCOMPLETE and a pending one as CONTENT_MEDIA_NOT_CONFIRMED, for the batch too', async () => {
    const noMedia = await w.seedContent(clientA, { format: 'reels' });
    const pending = await w.seedContent(clientA, { format: 'reels' });
    await f.addMedia(pending, clientA, 'video', 'pending');

    error(await submitBatch(clientA, { contentIds: [noMedia] }), 409, 'CONTENT_MEDIA_INCOMPLETE');
    error(await submitBatch(clientA, { contentIds: [pending] }), 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
    error(await submit(noMedia), 409, 'CONTENT_MEDIA_INCOMPLETE');
    error(await submit(pending), 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
  });
});
