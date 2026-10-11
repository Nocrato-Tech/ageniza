import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { mediaNotComplete } from './transition-errors.js';
import type { TransitionAction } from './transition-errors.js';
import { createTransitionFixtures, type TransitionPerson } from './test-support/transition-fixtures.js';
import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';

// Issue #256 (specs/conteudo.md sections 2, 4 and 6). Every person below holds the permissions of one action and nothing
// else, so a guard on the wrong key does not hide behind an admin. Each test names the mutation of the code that turns it red.
const w = createContentsWorld('transitions');
const f = createTransitionFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;
const TRANSITION_FUNCTION = /app_private\.(submit|approve|publish|unpublish|cancel|reschedule)_content/;
const ACTIONS: readonly TransitionAction[] = ['submit', 'approve-by-agency', 'publish', 'unpublish', 'cancel', 'reschedule'];

let clientA: string;
let clientA2: string;
let clientB: string;
let clock: Date | undefined;

type Person = PersonKey | TransitionPerson;
const cookieOf = (person: Person): string => (person in people ? people[person as PersonKey].cookie : f.people[person as TransitionPerson].cookie);
const idOf = (person: Person): string => (person in people ? people[person as PersonKey].id : f.people[person as TransitionPerson].id);

const act = (person: Person, action: TransitionAction, contentId: string, body?: unknown, clientId = clientA): Promise<Reply> =>
  w.call('POST', cookieOf(person), f.urlOf(clientId, contentId, action), body);

const publishedOnOf = async (contentId: string): Promise<string | null> =>
  (await w.getOwner().knex.raw<{ rows: Array<{ day: string | null }> }>('select published_on::text as day from public.contents where id = ?::uuid', [contentId])).rows[0]?.day ?? null;

const statusOf = async (contentId: string): Promise<string> => (await w.contentRow(contentId)).status as string;

const error = (reply: Reply, status: number, code: string): void => {
  expect(reply.statusCode).toBe(status);
  expect(reply.json().error.code).toBe(code);
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

beforeAll(async () => {
  await w.setup({ contentsClock: () => clock ?? new Date() });
  await f.setup();
  clientA = await w.newClient('a');
  clientA2 = await w.newClient('a2');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
}, 90_000);

afterEach(() => {
  clock = undefined;
});

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe('who may move a content, action by action (issue #256, specs/conteudo.md section 2)', () => {
  // The permission of each action is the SPEC's, and a write also needs `conteudo.visualizar`. The matrix names, for each
  // action, the people who are let through and the people who hold something else or lack the read.
  const SALES: readonly Person[] = ['sales', 'finance', 'noContent', 'reader'];
  const MATRIX: Record<TransitionAction, { readonly allowed: readonly Person[]; readonly denied: readonly Person[] }> = {
    submit: {
      allowed: ['admin', 'manager', 'production', 'owner', 'operateRead', 'approver'],
      denied: [...SALES, 'operateOnly', 'publishRead', 'publishOnly', 'cancelRead', 'cancelOnly', 'approveRead', 'approveOnly']
    },
    'approve-by-agency': {
      allowed: ['admin', 'manager', 'owner', 'approveRead', 'approver'],
      denied: [...SALES, 'production', 'operateOnly', 'operateRead', 'publishRead', 'cancelRead', 'approveOnly']
    },
    publish: {
      allowed: ['admin', 'manager', 'production', 'owner', 'publishRead'],
      denied: [...SALES, 'operateOnly', 'operateRead', 'cancelRead', 'approveRead', 'publishOnly', 'approver']
    },
    unpublish: {
      allowed: ['admin', 'manager', 'production', 'owner', 'publishRead'],
      denied: [...SALES, 'operateOnly', 'operateRead', 'cancelRead', 'approveRead', 'publishOnly', 'approver']
    },
    cancel: {
      allowed: ['admin', 'manager', 'owner', 'cancelRead'],
      denied: [...SALES, 'production', 'operateOnly', 'operateRead', 'publishRead', 'approveRead', 'cancelOnly', 'approver']
    },
    reschedule: {
      allowed: ['admin', 'manager', 'production', 'owner', 'operateRead', 'approver'],
      denied: [...SALES, 'operateOnly', 'publishRead', 'publishOnly', 'cancelRead', 'cancelOnly', 'approveRead', 'approveOnly']
    }
  };

  describe.each(ACTIONS)('%s', (action) => {
    it.each(MATRIX[action].denied)('answers 403 to %s, before any statement of the module, and moves nothing', async (person) => {
      const fixture = await f.fixtureFor(action, clientA);
      const before = await statusOf(fixture.contentId);
      w.statements.length = 0;

      const reply = await act(person, action, fixture.contentId, fixture.body);

      error(reply, 403, 'FORBIDDEN');
      expect(await statusOf(fixture.contentId)).toBe(before);
      expect(w.mentionsContents()).toBe(false);
    });

    it.each(MATRIX[action].allowed)('lets %s through, and the content is left where the action takes it', async (person) => {
      const fixture = await f.fixtureFor(action, clientA);

      const reply = await act(person, action, fixture.contentId, fixture.body);

      expect(reply.statusCode).toBe(200);
      expect(reply.json().status).toBe(f.AFTER[action]);
      expect(await statusOf(fixture.contentId)).toBe(f.AFTER[action]);
    });

    it('answers 401 without a session, and moves nothing', async () => {
      const fixture = await f.fixtureFor(action, clientA);
      const before = await statusOf(fixture.contentId);

      const reply = await w.getApp().app.inject({ method: 'POST', url: f.urlOf(clientA, fixture.contentId, action), headers: { origin: TEST_APP_PUBLIC_URL } });

      expect(reply.statusCode).toBe(401);
      expect(await statusOf(fixture.contentId)).toBe(before);
    });
  });

  it('refuses a person who holds only the permission of the action, because the write asks for the read as well', async () => {
    // publishOnly, cancelOnly and approveOnly are in the denied lists above; this one names why and checks the database was not reached.
    for (const [person, action] of [['publishOnly', 'publish'], ['cancelOnly', 'cancel'], ['approveOnly', 'approve-by-agency'], ['operateOnly', 'submit']] as const) {
      const fixture = await f.fixtureFor(action, clientA);
      w.statements.length = 0;
      const reply = await act(person, action, fixture.contentId, fixture.body);
      error(reply, 403, 'FORBIDDEN');
      expect(w.statements.some((statement) => TRANSITION_FUNCTION.test(statement))).toBe(false);
    }
  });
});

describe('a content is the client\'s and the agency\'s, never another\'s (issue #256)', () => {
  it.each(ACTIONS)('%s answers the same 404 through the wrong client of the same agency, and moves nothing', async (action) => {
    const fixture = await f.fixtureFor(action, clientA2);
    const before = await statusOf(fixture.contentId);

    const reply = await act('admin', action, fixture.contentId, fixture.body, clientA);

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
    expect(await statusOf(fixture.contentId)).toBe(before);
  });

  it.each(ACTIONS)('%s answers 404 to a content that does not exist, to malformed ids and to a client of another agency', async (action) => {
    const fixture = await f.fixtureFor(action, clientA);
    const before = await statusOf(fixture.contentId);

    expect((await act('admin', action, randomUUID(), fixture.body)).json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
    expect((await act('admin', action, 'not-a-uuid', fixture.body)).json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
    const malformedClient = await w.call('POST', people.admin.cookie, f.urlOf('not-a-uuid', fixture.contentId, action), fixture.body);
    expect(malformedClient.statusCode).toBe(404);
    expect(malformedClient.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
    const foreignClient = await act('admin', action, fixture.contentId, fixture.body, clientB);
    expect(foreignClient.statusCode).toBe(404);
    expect(foreignClient.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });

    expect(await statusOf(fixture.contentId)).toBe(before);
  });

  it.each(ACTIONS)('%s: a person of two agencies cannot reach a content of one through the other', async (action) => {
    const fixture = await f.fixtureFor(action, clientA);
    const before = await statusOf(fixture.contentId);

    const reply = await w.call('POST', people.dual.cookie, f.urlOf(clientA, fixture.contentId, action, w.agencyB), fixture.body);

    expect(reply.statusCode).toBe(404);
    expect(reply.json().error.code).toBe('NOT_FOUND');
    expect(await statusOf(fixture.contentId)).toBe(before);
  });

  it.each(ACTIONS)('%s: the admin of another agency is refused on a content of this one, and moves nothing', async (action) => {
    const fixture = await f.fixtureFor(action, clientA);
    const before = await statusOf(fixture.contentId);

    const reply = await w.call('POST', people.adminB.cookie, f.urlOf(clientA, fixture.contentId, action), fixture.body);

    expect([403, 404]).toContain(reply.statusCode);
    expect(await statusOf(fixture.contentId)).toBe(before);
  });
});

describe('submit: sending for approval (issue #256, rules 7 and 11)', () => {
  it('sends a content in production with complete media, and leaves the revision and the approval alone', async () => {
    const fixture = await f.fixtureFor('submit', clientA);

    const reply = await act('production', 'submit', fixture.contentId);

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: fixture.contentId, status: 'awaiting_approval', revision: 1, approvedBy: null, approvedAt: null });
  });

  it('sends a content in adjustment again', async () => {
    const contentId = await w.seedContent(clientA, { status: 'adjusting', format: 'reels' });
    await f.addMedia(contentId, clientA);
    expect((await act('production', 'submit', contentId)).json().status).toBe('awaiting_approval');
  });

  it('answers 200 to a content that already waits, and changes nothing', async () => {
    const fixture = await f.fixtureFor('submit', clientA);
    await act('production', 'submit', fixture.contentId);
    const again = await act('production', 'submit', fixture.contentId);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('awaiting_approval');
  });

  it.each(['approved', 'published', 'cancelled'] as const)('answers 409 CONTENT_STATE to a content that is %s, and moves nothing', async (status) => {
    const contentId = await w.seedContent(clientA, { status, format: 'reels' });
    await f.addMedia(contentId, clientA);

    const reply = await act('production', 'submit', contentId);

    error(reply, 409, 'CONTENT_STATE');
    expect(reply.json().error.message).toBe('Só um conteúdo em produção ou em ajuste é enviado para aprovação.');
    expect(await statusOf(contentId)).toBe(status);
  });

  describe('the media must be complete for the format', () => {
    const cases: ReadonlyArray<readonly [string, 'image' | 'carousel' | 'reels', ReadonlyArray<'image' | 'video'>]> = [
      ['no media at all', 'reels', []],
      ['a video for an image', 'image', ['video']],
      ['an image for a reel', 'reels', ['image']],
      ['one media for a carousel', 'carousel', ['image']],
      ['two videos for a reel', 'reels', ['video', 'video']]
    ];

    it.each(cases)('answers 409 CONTENT_MEDIA_INCOMPLETE with %s, and moves nothing', async (_label, format, media) => {
      const contentId = await w.seedContent(clientA, { format });
      const folderId = (await w.contentRow(contentId)).folder_id as string;
      const assets = [];
      for (const category of media) assets.push(await w.seedAsset(clientA, folderId, { category }));
      if (assets.length > 0) await w.attach(contentId, assets);

      const reply = await act('production', 'submit', contentId);

      error(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
      expect(await statusOf(contentId)).toBe('in_production');
    });

    it('answers a removed cover with the same code and a message that names the cover', async () => {
      const contentId = await w.seedContent(clientA, { format: 'reels' });
      const folderId = (await w.contentRow(contentId)).folder_id as string;
      const video = await w.seedAsset(clientA, folderId, { category: 'video' });
      await w.attach(contentId, [video]);
      const cover = await w.seedAsset(clientA, folderId, { category: 'image' });
      await w.getOwner().knex('contents').where({ id: contentId }).update({ cover_asset_id: cover });
      await w.getOwner().knex('media_assets').where({ id: cover }).update({ removed_at: new Date() });

      const reply = await act('production', 'submit', contentId);

      error(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
      expect(reply.json().error.message).toBe(mediaNotComplete().message);
      expect(reply.json().error.message).toMatch(/capa/);
      expect(await statusOf(contentId)).toBe('in_production');
    });
  });

  describe('a media that has not finished uploading is not media (acceptance added by the maestro)', () => {
    it('answers 409 CONTENT_MEDIA_NOT_CONFIRMED to a reel whose video is still pending, and moves nothing', async () => {
      const contentId = await w.seedContent(clientA, { format: 'reels' });
      await f.addMedia(contentId, clientA, 'video', 'pending');

      const reply = await act('production', 'submit', contentId);

      error(reply, 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
      expect(await statusOf(contentId)).toBe('in_production');
    });

    it('answers it to a carousel with one confirmed media and one pending, and sends it once the pending one is confirmed', async () => {
      const contentId = await w.seedContent(clientA, { format: 'carousel' });
      const folderId = (await w.contentRow(contentId)).folder_id as string;
      const confirmed = await w.seedAsset(clientA, folderId, { category: 'image' });
      const pending = await w.seedAsset(clientA, folderId, { category: 'image', status: 'pending' });
      await w.attach(contentId, [confirmed, pending]);

      error(await act('production', 'submit', contentId), 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
      expect(await statusOf(contentId)).toBe('in_production');

      await w.getOwner().knex('media_assets').where({ id: pending }).update({
        status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', confirmed_at: new Date()
      });
      const reply = await act('production', 'submit', contentId);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().status).toBe('awaiting_approval');
    });
  });

  describe('every subtask must be approved', () => {
    it.each(['pending', 'delivered'] as const)('answers 409 CONTENT_TASKS_NOT_APPROVED to a content with a %s subtask, and moves nothing', async (status) => {
      const fixture = await f.fixtureFor('submit', clientA);
      await w.seedTask(fixture.contentId, 'approved');
      await w.seedTask(fixture.contentId, status);

      const reply = await act('production', 'submit', fixture.contentId);

      error(reply, 409, 'CONTENT_TASKS_NOT_APPROVED');
      expect(await statusOf(fixture.contentId)).toBe('in_production');
    });

    it('sends a content whose subtasks are all approved', async () => {
      const fixture = await f.fixtureFor('submit', clientA);
      await w.seedTask(fixture.contentId, 'approved');
      await w.seedTask(fixture.contentId, 'approved');
      expect((await act('production', 'submit', fixture.contentId)).statusCode).toBe(200);
    });
  });

  describe('the notification queue is written by the transition, once (issue #407, specs/conteudo.md section 8)', () => {
    it('enqueues one item per active person of the portal, never for a removed link, and not twice for a repeated send', async () => {
      const clientId = await w.newClient('queue-submit');
      const first = await f.portalMember(clientId);
      const second = await f.portalMember(clientId);
      await f.portalMember(clientId, 'removed');
      const fixture = await f.fixtureFor('submit', clientId);

      const reply = await w.call('POST', people.production.cookie, f.urlOf(clientId, fixture.contentId, 'submit'));
      expect(reply.statusCode).toBe(200);
      const expected = [first, second].sort().map((recipient) => ({ type: 'content_awaiting_approval', recipient }));
      expect(await f.queueRows(fixture.contentId)).toEqual(expected);

      const again = await w.call('POST', people.production.cookie, f.urlOf(clientId, fixture.contentId, 'submit'));
      expect(again.statusCode).toBe(200);
      expect(await f.queueRows(fixture.contentId)).toEqual(expected);
    });

    it('enqueues nothing when the send is refused', async () => {
      const clientId = await w.newClient('queue-refused');
      await f.portalMember(clientId);
      const contentId = await w.seedContent(clientId, { format: 'reels' });

      error(await w.call('POST', people.production.cookie, f.urlOf(clientId, contentId, 'submit')), 409, 'CONTENT_MEDIA_INCOMPLETE');

      expect(await f.queueRows(contentId)).toEqual([]);
    });
  });
});

describe('approve-by-agency: approving outside the platform (issue #256, rules 4 and 11)', () => {
  const approve = (person: Person, contentId: string, body: unknown): Promise<Reply> => act(person, 'approve-by-agency', contentId, body);

  it('approves with the reason, and the database fixes who approved and when', async () => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);

    const reply = await approve('approver', fixture.contentId, { revision: 1, reason: '  O cliente aprovou por telefone.  ' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      status: 'approved',
      approvedBy: idOf('approver'),
      approvedByAgencyReason: 'O cliente aprovou por telefone.',
      revision: 1
    });
    expect(new Date(reply.json().approvedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const row = await w.contentRow(fixture.contentId);
    expect(row.approved_by).toBe(idOf('approver'));
    expect(row.approved_by_agency_reason).toBe('O cliente aprovou por telefone.');
  });

  it.each([
    ['no reason', { revision: 1 }],
    ['an empty reason', { revision: 1, reason: '' }],
    ['spaces', { revision: 1, reason: '   ' }],
    ['no-break spaces', { revision: 1, reason: '  ' }],
    ['a zero-width space', { revision: 1, reason: '​' }],
    ['a zero-width joiner', { revision: 1, reason: '‍' }],
    ['a word joiner', { revision: 1, reason: '⁠' }],
    ['a byte order mark', { revision: 1, reason: '﻿' }],
    ['a soft hyphen', { revision: 1, reason: '­' }],
    ['a combining grapheme joiner', { revision: 1, reason: '͏' }],
    ['a control character', { revision: 1, reason: '\u0001' }],
    ['a hidden character inside the text', { revision: 1, reason: 'aprovado​ok' }],
    ['a reason that is not text', { revision: 1, reason: 7 }]
  ])('answers 400 VALIDATION_ERROR to %s, and approves nothing', async (_label, body) => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);
    w.statements.length = 0;

    const reply = await approve('approver', fixture.contentId, body);

    error(reply, 400, 'VALIDATION_ERROR');
    expect(await statusOf(fixture.contentId)).toBe('awaiting_approval');
    expect((await w.contentRow(fixture.contentId)).approved_by_agency_reason).toBeNull();
    expect(w.statements.some((statement) => /approve_content_by_agency/.test(statement))).toBe(false);
  });

  it('counts the 5000 bytes of the column: 5000 passes, 5001 and 2501 two-byte letters do not', async () => {
    const passes = await f.fixtureFor('approve-by-agency', clientA);
    expect((await approve('approver', passes.contentId, { revision: 1, reason: 'a'.repeat(5000) })).statusCode).toBe(200);

    for (const reason of ['a'.repeat(5001), 'é'.repeat(2501)]) {
      const refused = await f.fixtureFor('approve-by-agency', clientA);
      error(await approve('approver', refused.contentId, { revision: 1, reason }), 400, 'VALIDATION_ERROR');
      expect(await statusOf(refused.contentId)).toBe('awaiting_approval');
    }
  });

  it.each([
    ['who approved', { approvedBy: randomUUID() }],
    ['the state', { status: 'published' }],
    ['when', { approvedAt: '2020-01-01T00:00:00.000Z' }]
  ])('refuses a body that names %s, which is the database\'s to fix', async (_label, extra) => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);
    error(await approve('approver', fixture.contentId, { revision: 1, reason: 'ok', ...extra }), 400, 'VALIDATION_ERROR');
    expect(await statusOf(fixture.contentId)).toBe('awaiting_approval');
  });

  it.each([[undefined], [0], [1.5], ['1'], [2_147_483_648]])('answers 400 to the revision %s', async (revision) => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);
    error(await approve('approver', fixture.contentId, { revision, reason: 'ok' }), 400, 'VALIDATION_ERROR');
    expect(await statusOf(fixture.contentId)).toBe('awaiting_approval');
  });

  it('answers 409 CONTENT_REVISION_CHANGED to an approval of what was read before the caption changed, and approves it with the new revision', async () => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);
    const edited = await w.call('PATCH', people.production.cookie, `/agencies/${w.agencyA}/clients/${clientA}/contents/${fixture.contentId}`, { caption: 'Legenda nova' });
    expect(edited.json().revision).toBe(2);

    const stale = await approve('approver', fixture.contentId, { revision: 1, reason: 'Aprovado' });
    error(stale, 409, 'CONTENT_REVISION_CHANGED');
    expect(await statusOf(fixture.contentId)).toBe('awaiting_approval');

    expect((await approve('approver', fixture.contentId, { revision: 2, reason: 'Aprovado' })).statusCode).toBe(200);
  });

  it.each(['in_production', 'adjusting', 'cancelled', 'published'] as const)('answers 409 CONTENT_STATE to a content that is %s, and nothing is approved', async (status) => {
    const contentId = await w.seedContent(clientA, { status, format: 'reels' });
    await f.addMedia(contentId, clientA);

    const reply = await approve('approver', contentId, { revision: 1, reason: 'Aprovado' });

    error(reply, 409, 'CONTENT_STATE');
    expect(await statusOf(contentId)).toBe(status);
    expect((await w.contentRow(contentId)).approved_by_agency_reason).toBeNull();
  });

  it('answers 200 to a content that is already approved, and the first who approved stays the one who approved', async () => {
    const fixture = await f.fixtureFor('approve-by-agency', clientA);
    await approve('approver', fixture.contentId, { revision: 1, reason: 'Primeiro motivo' });

    const again = await approve('admin', fixture.contentId, { revision: 1, reason: 'Segundo motivo' });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ approvedBy: idOf('approver'), approvedByAgencyReason: 'Primeiro motivo' });
  });

  it('answers 409 CONTENT_MEDIA_NOT_CONFIRMED to a content whose media has not finished uploading, and approves nothing', async () => {
    const contentId = await w.seedContent(clientA, { status: 'awaiting_approval', format: 'reels' });
    await f.addMedia(contentId, clientA, 'video', 'pending');

    const reply = await approve('approver', contentId, { revision: 1, reason: 'Aprovado' });

    error(reply, 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
    expect(await statusOf(contentId)).toBe('awaiting_approval');
    const row = await w.contentRow(contentId);
    expect(row.approved_by).toBeNull();
    expect(row.approved_by_agency_reason).toBeNull();
  });

  it('enqueues nothing for the client: the approval is not an e-mail', async () => {
    const clientId = await w.newClient('queue-approve');
    await f.portalMember(clientId);
    const fixture = await f.fixtureFor('approve-by-agency', clientId);

    const reply = await w.call('POST', people.approver.cookie, f.urlOf(clientId, fixture.contentId, 'approve-by-agency'), fixture.body);

    expect(reply.statusCode).toBe(200);
    expect(await f.queueRows(fixture.contentId)).toEqual([]);
  });
});

describe('publish: marking as published, with the real day (issue #256, rule 7)', () => {
  // The day comes from the instant the route reads through `app_private.sao_paulo_date`, so the fixed instants sit on
  // both sides of the midnight of São Paulo (03:00 UTC), in days that are already past.
  it.each([
    ['the last millisecond of the 9th in São Paulo', '2026-10-10T02:59:59.999Z', '2026-10-09'],
    ['the first millisecond of the 10th in São Paulo', '2026-10-10T03:00:00.000Z', '2026-10-10'],
    ['the evening of the 10th in São Paulo, already the 11th in UTC', '2026-10-11T01:30:00.000Z', '2026-10-10']
  ])('records the day of São Paulo when the body carries none: %s', async (_label, instant, day) => {
    clock = new Date(instant);
    const fixture = await f.fixtureFor('publish', clientA);

    const reply = await act('production', 'publish', fixture.contentId);

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'published', publishedOn: day });
    expect(await publishedOnOf(fixture.contentId)).toBe(day);
  });

  it('records today, in São Paulo, with the clock of the server, and stamps the instant of the marking', async () => {
    const fixture = await f.fixtureFor('publish', clientA);
    const today = await f.today();

    const reply = await act('production', 'publish', fixture.contentId, {});

    expect(reply.statusCode).toBe(200);
    if (await f.today() === today) expect(reply.json().publishedOn).toBe(today);
    const row = await w.contentRow(fixture.contentId);
    expect(Math.abs((row.published_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('takes a day before today from the body, and the undo is still of the day of the marking', async () => {
    const fixture = await f.fixtureFor('publish', clientA);

    const published = await act('production', 'publish', fixture.contentId, { publishedOn: '2026-10-01' });
    expect(published.json()).toMatchObject({ status: 'published', publishedOn: '2026-10-01' });

    const undone = await act('production', 'unpublish', fixture.contentId);
    expect(undone.statusCode).toBe(200);
    expect(undone.json()).toMatchObject({ status: 'approved', publishedOn: null });
  });

  it('refuses a day after today, in São Paulo, with 400 CONTENT_PUBLISHED_ON_INVALID, and publishes nothing', async () => {
    const today = await f.today();
    const tomorrow = (await w.getOwner().knex.raw<{ rows: Array<{ day: string }> }>("select (?::date + 1)::text as day", [today])).rows[0]?.day as string;
    for (const publishedOn of [tomorrow, '2099-01-01']) {
      const fixture = await f.fixtureFor('publish', clientA);
      const reply = await act('production', 'publish', fixture.contentId, { publishedOn });
      error(reply, 400, 'CONTENT_PUBLISHED_ON_INVALID');
      expect(await statusOf(fixture.contentId)).toBe('approved');
    }
    const fixture = await f.fixtureFor('publish', clientA);
    expect((await act('production', 'publish', fixture.contentId, { publishedOn: today })).statusCode).toBe(200);
  });

  it.each([
    ['a date that does not exist', { publishedOn: '2026-02-30' }],
    ['a null day', { publishedOn: null }],
    ['an instant', { publishedOn: '2026-10-10T10:00:00Z' }],
    ['a field that is not the body\'s', { publishedAt: '2026-10-10T10:00:00Z' }]
  ])('answers 400 VALIDATION_ERROR to %s, and the database is not asked', async (_label, body) => {
    const fixture = await f.fixtureFor('publish', clientA);
    w.statements.length = 0;
    error(await act('production', 'publish', fixture.contentId, body), 400, 'VALIDATION_ERROR');
    expect(await statusOf(fixture.contentId)).toBe('approved');
    expect(w.statements.some((statement) => /publish_content/.test(statement))).toBe(false);
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'cancelled'] as const)('answers 409 CONTENT_STATE to a content that is %s: nothing goes from there to published', async (status) => {
    const contentId = await w.seedContent(clientA, { status, format: 'reels' });
    await f.addMedia(contentId, clientA);

    const reply = await act('production', 'publish', contentId, {});

    error(reply, 409, 'CONTENT_STATE');
    expect(reply.json().error.message).toBe('Só um conteúdo aprovado é marcado como publicado.');
    expect(await statusOf(contentId)).toBe(status);
  });

  it('answers 200 to a content that is already published, and keeps the day it was published on', async () => {
    const fixture = await f.fixtureFor('publish', clientA);
    await act('production', 'publish', fixture.contentId, { publishedOn: '2026-10-01' });

    const again = await act('production', 'publish', fixture.contentId, { publishedOn: '2026-10-02' });

    expect(again.statusCode).toBe(200);
    expect(again.json().publishedOn).toBe('2026-10-01');
  });

  it('checks the media again: an approved content with a pending media or none is not published', async () => {
    const pending = await w.seedContent(clientA, { status: 'approved', format: 'reels' });
    await f.addMedia(pending, clientA, 'video', 'pending');
    error(await act('production', 'publish', pending, {}), 409, 'CONTENT_MEDIA_NOT_CONFIRMED');
    expect(await statusOf(pending)).toBe('approved');

    const none = await w.seedContent(clientA, { status: 'approved', format: 'reels' });
    error(await act('production', 'publish', none, {}), 409, 'CONTENT_MEDIA_INCOMPLETE');
    expect(await statusOf(none)).toBe('approved');
  });

  it('enqueues the summary of the day once per active person, and not again when the marking is repeated or undone and done again', async () => {
    const clientId = await w.newClient('queue-publish');
    const person = await f.portalMember(clientId);
    const fixture = await f.fixtureFor('publish', clientId);
    const url = (action: TransitionAction): string => f.urlOf(clientId, fixture.contentId, action);
    const expected = [{ type: 'content_published', recipient: person }];

    expect((await w.call('POST', people.production.cookie, url('publish'), {})).statusCode).toBe(200);
    expect(await f.queueRows(fixture.contentId)).toEqual(expected);

    expect((await w.call('POST', people.production.cookie, url('publish'), {})).statusCode).toBe(200);
    expect(await f.queueRows(fixture.contentId)).toEqual(expected);

    expect((await w.call('POST', people.production.cookie, url('unpublish'))).statusCode).toBe(200);
    expect((await w.call('POST', people.production.cookie, url('publish'), {})).statusCode).toBe(200);
    expect(await f.queueRows(fixture.contentId)).toEqual(expected);
  });
});

describe('unpublish: undoing a publication on the same day only (issue #256, rule 7)', () => {
  const today = async (): Promise<{ day: string; start: Date; end: Date }> => {
    const day = await f.today();
    return { day, ...await f.dayBounds(day) };
  };

  it('undoes a publication marked in the first millisecond and in the last millisecond of today in São Paulo, and keeps the approval', async () => {
    const { day, start, end } = await today();
    const clientId = await w.newClient('unpublish-same-day');
    for (const instant of [start, end]) {
      const contentId = await f.seedPublished(clientId, instant, day);

      const reply = await act('production', 'unpublish', contentId, undefined, clientId);

      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ status: 'approved', publishedOn: null, approvedBy: idOf('admin') });
      expect(reply.json().approvedAt).not.toBeNull();
      const row = await w.contentRow(contentId);
      expect(row.published_at).toBeNull();
    }
    expect(await f.today()).toBe(day);
  });

  it('answers 409 CONTENT_UNPUBLISH_EXPIRED to a publication marked in the last millisecond of yesterday, and the content stays published', async () => {
    const { day, start } = await today();
    const clientId = await w.newClient('unpublish-yesterday');
    const contentId = await f.seedPublished(clientId, new Date(start.getTime() - 1), day);

    const reply = await act('production', 'unpublish', contentId, undefined, clientId);

    error(reply, 409, 'CONTENT_UNPUBLISH_EXPIRED');
    expect(await statusOf(contentId)).toBe('published');
    expect((await w.contentRow(contentId)).published_at).not.toBeNull();
    expect(await f.today()).toBe(day);
  });

  it('counts the day the marking was made, not the real day that was informed', async () => {
    const { start, end } = await today();
    const clientId = await w.newClient('unpublish-informed-day');

    const markedTodayForLongAgo = await f.seedPublished(clientId, end, '2026-01-05');
    expect((await act('production', 'unpublish', markedTodayForLongAgo, undefined, clientId)).statusCode).toBe(200);

    const markedYesterdayForToday = await f.seedPublished(clientId, new Date(start.getTime() - 1), (await today()).day);
    error(await act('production', 'unpublish', markedYesterdayForToday, undefined, clientId), 409, 'CONTENT_UNPUBLISH_EXPIRED');
  });

  it('answers 200 to a content that is already approved, and 409 CONTENT_STATE to one that was never published', async () => {
    const approved = await w.seedContent(clientA, { status: 'approved' });
    const again = await act('production', 'unpublish', approved);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('approved');

    for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'cancelled'] as const) {
      const contentId = await w.seedContent(clientA, { status });
      error(await act('production', 'unpublish', contentId), 409, 'CONTENT_STATE');
      expect(await statusOf(contentId)).toBe(status);
    }
  });
});

describe('cancel: cancelling keeps the content (issue #256, rule 9)', () => {
  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const)('cancels a content that is %s, clears the approval and deletes nothing', async (status) => {
    const contentId = await w.seedContent(clientA, { status });

    const reply = await act('manager', 'cancel', contentId);

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'cancelled', approvedBy: null, approvedAt: null, approvedByAgencyReason: null });
    expect(reply.json().cancelledAt).not.toBeNull();
    const row = await w.contentRow(contentId);
    expect(row.status).toBe('cancelled');
    expect(row.title).toBeTruthy();
  });

  it('answers 409 CONTENT_STATE to a published content, and keeps it published', async () => {
    const contentId = await w.seedContent(clientA, { status: 'published' });

    const reply = await act('manager', 'cancel', contentId);

    error(reply, 409, 'CONTENT_STATE');
    expect(reply.json().error.message).toBe('Um conteúdo publicado não é cancelado.');
    expect(await statusOf(contentId)).toBe('published');
  });

  it('answers 200 to a content that is already cancelled, and keeps the instant of the first cancellation', async () => {
    const contentId = await w.seedContent(clientA, { status: 'approved' });
    const first = await act('manager', 'cancel', contentId);

    const again = await act('manager', 'cancel', contentId);

    expect(again.statusCode).toBe(200);
    expect(again.json().cancelledAt).toBe(first.json().cancelledAt);
  });
});

describe('reschedule: a cancelled content goes back to production (issue #256)', () => {
  it('moves a cancelled content to the day given, and to production', async () => {
    const contentId = await w.seedContent(clientA, { status: 'cancelled', publishOn: '2026-10-20' });

    const reply = await act('production', 'reschedule', contentId, { publishOn: '2026-11-03' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'in_production', publishOn: '2026-11-03', cancelledAt: null });
    expect(await w.publishOnOf(contentId)).toBe('2026-11-03');
  });

  it('keeps the day the content had when the body is empty or absent', async () => {
    for (const body of [{}, undefined]) {
      const contentId = await w.seedContent(clientA, { status: 'cancelled', publishOn: '2026-10-20' });
      const reply = await act('production', 'reschedule', contentId, body);
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ status: 'in_production', publishOn: '2026-10-20' });
    }
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published'] as const)('answers 409 CONTENT_STATE to a content that is %s, and does not move its day', async (status) => {
    const contentId = await w.seedContent(clientA, { status, publishOn: '2026-10-20' });

    const reply = await act('production', 'reschedule', contentId, { publishOn: '2026-11-03' });

    error(reply, 409, 'CONTENT_STATE');
    expect(reply.json().error.message).toBe('Só um conteúdo cancelado é reagendado.');
    expect(await statusOf(contentId)).toBe(status);
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
  });

  it.each([
    ['a date that does not exist', { publishOn: '2026-02-30' }],
    ['a null day', { publishOn: null }],
    ['a field that is not the body\'s', { status: 'in_production' }]
  ])('answers 400 VALIDATION_ERROR to %s, and moves nothing', async (_label, body) => {
    const contentId = await w.seedContent(clientA, { status: 'cancelled', publishOn: '2026-10-20' });
    error(await act('production', 'reschedule', contentId, body), 400, 'VALIDATION_ERROR');
    expect(await statusOf(contentId)).toBe('cancelled');
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
  });
});

describe('a client that is archived takes no move of its contents (issue #256, rule 14)', () => {
  it.each(ACTIONS)('%s answers 409 CLIENT_ARCHIVED, and the content is left as it was', async (action) => {
    const clientId = await w.newClient(`archived-${action}`, { status: 'archived' });
    await f.portalMember(clientId);
    const fixture = await f.fixtureFor(action, clientId);
    const before = await statusOf(fixture.contentId);

    const reply = await w.call('POST', people.admin.cookie, f.urlOf(clientId, fixture.contentId, action), fixture.body);

    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(await statusOf(fixture.contentId)).toBe(before);
    expect(await f.queueRows(fixture.contentId)).toEqual([]);
  });
});

describe('what the database refuses is answered by name, never a 500 (issue #256)', () => {
  it('answers 404 to a person who loses the permission between the guard and the function, and moves nothing', async () => {
    const fixture = await f.fixtureFor('submit', clientA);
    const roleId = f.people.operateRead.roleId;
    w.runBeforeStatement(/app_private\.submit_content/, async () => {
      await w.getOwner().knex('role_permissions').where({ role_id: roleId, permission_key: 'conteudo.operar' }).delete();
    });
    try {
      const reply = await act('operateRead', 'submit', fixture.contentId);

      expect(reply.statusCode).toBe(404);
      expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
      expect(await statusOf(fixture.contentId)).toBe('in_production');
    } finally {
      w.clearHook();
      await w.getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'conteudo.operar' }).onConflict().ignore();
    }
  });

  it('answers 409 CONTENT_STATE to a content that another request moved after this one read it', async () => {
    const fixture = await f.fixtureFor('cancel', clientA);
    w.runBeforeStatement(/app_private\.cancel_content/, async () => {
      await w.getOwner().knex('contents').where({ id: fixture.contentId }).update({ status: 'published', published_on: '2026-10-06', published_at: new Date() });
    });
    try {
      const reply = await act('manager', 'cancel', fixture.contentId);
      error(reply, 409, 'CONTENT_STATE');
      expect(await statusOf(fixture.contentId)).toBe('published');
    } finally {
      w.clearHook();
    }
  });
});
