import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';

// Issue #254 (specs/conteudo.md section 6; decision 2026-10-01 "Conteúdo: impacto estrutural", point 4). Every
// person below holds one or two permissions and nothing else, so a guard on the wrong key does not hide behind an
// admin. Each test names the mutation of the code that turns it red.
const w = createContentsWorld('contents');
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;

let clientA: string;
let clientA2: string;
let clientB: string;
let folderA: string;
let folderA2: string;
let folderB: string;

const base = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/contents`;
const urlA = (clientId = clientA): string => base(w.agencyA, clientId);

const create = { title: 'Lançamento da coleção', format: 'reels', publishOn: '2026-10-20' };

beforeAll(async () => {
  await w.setup();
  clientA = await w.newClient('a');
  clientA2 = await w.newClient('a2');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
  folderA = await w.folderOf(clientA);
  folderA2 = await w.folderOf(clientA2);
  folderB = await w.folderOf(clientB);
}, 60_000);

afterAll(async () => {
  await w.teardown();
}, 60_000);

describe('authorization of each route (issue #254)', () => {
  const denied: readonly PersonKey[] = ['sales', 'finance', 'noContent'];
  const writers: readonly PersonKey[] = ['admin', 'manager', 'production', 'owner'];

  it.each(denied)('answers 403 to %s on the period query, with nothing read', async (key) => {
    const reply = await w.call('GET', people[key].cookie, `${urlA()}?from=2026-10-01&to=2026-10-31`);
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
  });

  it.each(denied)('answers 403 to %s on the content detail', async (key) => {
    const contentId = await w.seedContent(clientA);
    const reply = await w.call('GET', people[key].cookie, `${urlA()}/${contentId}`);
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
  });

  it.each([...denied, 'reader' as const])('answers 403 to %s on create, and creates nothing', async (key) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people[key].cookie, urlA(), { ...create, folderId: folderA });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it.each([...denied, 'reader' as const])('answers 403 to %s on edit, and changes nothing', async (key) => {
    const contentId = await w.seedContent(clientA, { title: 'Original' });
    const reply = await w.call('PATCH', people[key].cookie, `${urlA()}/${contentId}`, { title: 'Trocado' });
    expect(reply.statusCode).toBe(403);
    expect((await w.contentRow(contentId)).title).toBe('Original');
  });

  it('refuses a person who can operate and cannot read before any statement of the module reaches the database', async () => {
    // The policy asks for both keys, so this person would fail late and in the database; the route fails first.
    const contentId = await w.seedContent(clientA, { title: 'Original' });
    w.statements.length = 0;

    const created = await w.call('POST', people.operateOnly.cookie, urlA(), { ...create, folderId: folderA });
    const edited = await w.call('PATCH', people.operateOnly.cookie, `${urlA()}/${contentId}`, { title: 'Trocado' });

    expect(created.statusCode).toBe(403);
    expect(edited.statusCode).toBe(403);
    expect(w.mentionsContents()).toBe(false);
    expect(w.statements.some((statement) => /public\.clients\b/.test(statement))).toBe(false);
  });

  it('refuses a person who can read and cannot operate before any statement of the module reaches the database', async () => {
    const contentId = await w.seedContent(clientA, { title: 'Original' });
    w.statements.length = 0;

    const created = await w.call('POST', people.reader.cookie, urlA(), { ...create, folderId: folderA });
    const edited = await w.call('PATCH', people.reader.cookie, `${urlA()}/${contentId}`, { title: 'Trocado' });

    expect(created.statusCode).toBe(403);
    expect(edited.statusCode).toBe(403);
    expect(w.mentionsContents()).toBe(false);
  });

  it('lets a person who can only read list and open a content', async () => {
    const contentId = await w.seedContent(clientA);
    const period = await w.call('GET', people.reader.cookie, `${urlA()}?from=2026-10-01&to=2026-10-31`);
    const detail = await w.call('GET', people.reader.cookie, `${urlA()}/${contentId}`);
    expect(period.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
  });

  it.each(writers)('lets %s create and edit', async (key) => {
    const created = await w.call('POST', people[key].cookie, urlA(), { ...create, folderId: folderA });
    expect(created.statusCode).toBe(201);
    const edited = await w.call('PATCH', people[key].cookie, `${urlA()}/${created.json().id}`, { title: 'Trocado' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().title).toBe('Trocado');
  });

  it('answers 401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: `${urlA()}?from=2026-10-01&to=2026-10-31` });
    expect(reply.statusCode).toBe(401);
  });
});

describe('a content is the client\'s and the agency\'s, never another\'s (issue #254)', () => {
  it('answers the same 404 to a content opened through the wrong client of the same agency', async () => {
    const contentId = await w.seedContent(clientA2);
    const reply = await w.call('GET', people.admin.cookie, `${urlA(clientA)}/${contentId}`);
    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
  });

  it('answers the same 404 to an edit through the wrong client, and changes nothing', async () => {
    const contentId = await w.seedContent(clientA2, { title: 'Do outro cliente' });
    const reply = await w.call('PATCH', people.admin.cookie, `${urlA(clientA)}/${contentId}`, { title: 'Invadido', publishOn: '2026-11-01' });
    expect(reply.statusCode).toBe(404);
    const row = await w.contentRow(contentId);
    expect(row.title).toBe('Do outro cliente');
  });

  it('answers 404 to a content of another agency\'s client through its own client in the path', async () => {
    const contentId = await w.seedContent(clientB, { ownerUserId: people.adminB.id });
    const reply = await w.call('GET', people.adminB.cookie, `${base(w.agencyB, clientA)}/${contentId}`);
    expect(reply.statusCode).toBe(404);
    const own = await w.call('GET', people.adminB.cookie, `${base(w.agencyB, clientB)}/${contentId}`);
    expect(own.statusCode).toBe(200);
  });

  it('answers 404 to a person of two agencies who asks for a client in the agency of the path that is not its own', async () => {
    // `dual` is an admin of both agencies, so row-level security alone would let the row through: the route scopes by agency.
    const contentId = await w.seedContent(clientB, { ownerUserId: people.adminB.id });
    const countBefore = await w.countContents(clientB);
    const wrongAgency = await w.call('GET', people.dual.cookie, `${base(w.agencyA, clientB)}/${contentId}`);
    const wrongAgencyPeriod = await w.call('GET', people.dual.cookie, `${base(w.agencyA, clientB)}?from=2026-10-01&to=2026-10-31`);
    const wrongAgencyCreate = await w.call('POST', people.dual.cookie, base(w.agencyA, clientB), { ...create, folderId: folderB });
    const wrongAgencyEdit = await w.call('PATCH', people.dual.cookie, `${base(w.agencyA, clientB)}/${contentId}`, { title: 'Invadido' });

    expect(wrongAgency.statusCode).toBe(404);
    expect(wrongAgencyPeriod.statusCode).toBe(404);
    expect(wrongAgencyCreate.statusCode).toBe(404);
    expect(wrongAgencyEdit.statusCode).toBe(404);
    expect(wrongAgencyCreate.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
    expect(await w.countContents(clientB)).toBe(countBefore);
    expect((await w.contentRow(contentId)).title).not.toBe('Invadido');
  });

  it('answers 404 to a client of another agency on the period query and on create', async () => {
    const countBefore = await w.countContents(clientB);
    const period = await w.call('GET', people.admin.cookie, `${base(w.agencyA, clientB)}?from=2026-10-01&to=2026-10-31`);
    const created = await w.call('POST', people.admin.cookie, base(w.agencyA, clientB), { ...create, folderId: folderB });
    expect(period.statusCode).toBe(404);
    expect(created.statusCode).toBe(404);
    expect(await w.countContents(clientB)).toBe(countBefore);
  });

  it('answers 404, never 400, to an id that is not a UUID or that does not exist', async () => {
    const malformedContent = await w.call('GET', people.admin.cookie, `${urlA()}/nao-e-uuid`);
    const unknownContent = await w.call('GET', people.admin.cookie, `${urlA()}/${randomUUID()}`);
    const malformedClient = await w.call('GET', people.admin.cookie, `${base(w.agencyA, 'nao-e-uuid')}?from=2026-10-01&to=2026-10-31`);
    const unknownClient = await w.call('GET', people.admin.cookie, `${base(w.agencyA, randomUUID())}?from=2026-10-01&to=2026-10-31`);
    const patchMalformed = await w.call('PATCH', people.admin.cookie, `${urlA()}/nao-e-uuid`, { title: 'x' });
    expect([malformedContent.statusCode, unknownContent.statusCode, malformedClient.statusCode, unknownClient.statusCode, patchMalformed.statusCode])
      .toEqual([404, 404, 404, 404, 404]);
  });

  it('never shows a content to a person who belongs to the client only through the portal', async () => {
    const reply = await w.call('GET', people.noContent.cookie, `${urlA()}?from=2026-10-01&to=2026-10-31`);
    expect(reply.statusCode).toBe(403);
  });
});

describe('the period query (issue #254)', () => {
  let periodClient: string;

  beforeAll(async () => {
    periodClient = await w.newClient('period');
  });

  const query = (from: string, to: string, clientId = periodClient): Promise<Reply> =>
    w.call('GET', people.admin.cookie, `${urlA(clientId)}?from=${from}&to=${to}`);

  it('accepts a period of 93 days and refuses 94, counting both ends', async () => {
    const accepted = await query('2026-01-01', '2026-04-03');
    const refused = await query('2026-01-01', '2026-04-04');

    expect(accepted.statusCode).toBe(200);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_ERROR');
    expect(refused.json().error.details.issues).toEqual([{ path: 'to', code: 'custom', message: 'the period must span at most 93 days' }]);
  });

  it('counts a leap day in the 93 days', async () => {
    expect((await query('2028-01-01', '2028-04-02')).statusCode).toBe(200);
    expect((await query('2028-01-01', '2028-04-03')).statusCode).toBe(400);
  });

  it.each([
    ['a period that ends before it starts', 'from=2026-10-31&to=2026-10-01'],
    ['a period that ends the day before it starts', 'from=2026-10-11&to=2026-10-10'],
    ['no bounds', ''],
    ['no end', 'from=2026-10-01'],
    ['a day that does not exist', 'from=2026-02-30&to=2026-03-01'],
    ['an instant instead of a day', 'from=2026-10-01T00:00:00Z&to=2026-10-31'],
    ['a page, because the query does not paginate', 'from=2026-10-01&to=2026-10-31&page=1'],
    ['an unknown parameter', 'from=2026-10-01&to=2026-10-31&status=approved']
  ])('answers 400 to %s', async (_label, queryString) => {
    const reply = await w.call('GET', people.admin.cookie, `${urlA(periodClient)}?${queryString}`);
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns both kinds of item in the envelope, both ends inclusive, ordered by day, time and id', async () => {
    const day = (value: string): string => value;
    const dayBefore = await w.seedContent(periodClient, { publishOn: day('2026-09-30'), title: 'Antes' });
    const first = await w.seedContent(periodClient, { publishOn: day('2026-10-01'), publishAtTime: '09:00', title: 'Primeiro dia' });
    const noTime = await w.seedContent(periodClient, { publishOn: day('2026-10-10'), publishAtTime: null, title: 'Sem hora' });
    const late = await w.seedContent(periodClient, { publishOn: day('2026-10-10'), publishAtTime: '20:00', title: 'Noite' });
    const early = await w.seedContent(periodClient, { publishOn: day('2026-10-10'), publishAtTime: '08:00', title: 'Manhã' });
    const last = await w.seedContent(periodClient, { publishOn: day('2026-10-31'), publishAtTime: '23:59', title: 'Último dia' });
    const dayAfter = await w.seedContent(periodClient, { publishOn: day('2026-11-01'), title: 'Depois' });
    const scriptFirst = await w.seedScript(periodClient, '2026-10-01', 'draft');
    const scriptLast = await w.seedScript(periodClient, '2026-10-31', 'recorded');
    await w.seedScript(periodClient, '2026-09-30');
    await w.seedScript(periodClient, '2026-11-01');

    const reply = await query('2026-10-01', '2026-10-31');

    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.data.contents.map((item: { id: string }) => item.id)).toEqual([first, early, late, noTime, last]);
    expect(body.data.contents.map((item: { id: string }) => item.id)).not.toContain(dayBefore);
    expect(body.data.contents.map((item: { id: string }) => item.id)).not.toContain(dayAfter);
    expect(body.data.storyScripts).toEqual([
      { id: scriptFirst, scriptOn: '2026-10-01', status: 'draft' },
      { id: scriptLast, scriptOn: '2026-10-31', status: 'recorded' }
    ]);
    expect(body.meta).toEqual({ from: '2026-10-01', to: '2026-10-31', count: 7 });
    expect(Object.keys(body)).toEqual(['data', 'meta']);
  });

  it('orders contents of the same day and time by id', async () => {
    const orderClient = await w.newClient('order');
    const ids = [await w.seedContent(orderClient, { publishOn: '2026-10-05', publishAtTime: '10:00' }), await w.seedContent(orderClient, { publishOn: '2026-10-05', publishAtTime: '10:00' }), await w.seedContent(orderClient, { publishOn: '2026-10-05', publishAtTime: '10:00' })];
    const reply = await query('2026-10-05', '2026-10-05', orderClient);
    expect(reply.json().data.contents.map((item: { id: string }) => item.id)).toEqual([...ids].sort());
  });

  it('describes a content with the calendar\'s fields only, and counts its subtasks', async () => {
    const taskClient = await w.newClient('tasks');
    const contentId = await w.seedContent(taskClient, { publishOn: '2026-10-12', status: 'approved', title: 'Com subtarefas' });
    await w.seedTask(contentId, 'approved');
    await w.seedTask(contentId, 'approved');
    await w.seedTask(contentId, 'delivered');
    await w.seedTask(contentId, 'pending');
    const bare = await w.seedContent(taskClient, { publishOn: '2026-10-13', title: 'Sem subtarefas' });

    const reply = await query('2026-10-12', '2026-10-13', taskClient);

    const [withTasks, withoutTasks] = reply.json().data.contents;
    expect(withTasks).toEqual({
      id: contentId,
      title: 'Com subtarefas',
      platform: 'instagram',
      format: 'reels',
      publishOn: '2026-10-12',
      publishAtTime: '18:30',
      status: 'approved',
      ownerUserId: people.production.id,
      coverAssetId: null,
      revision: 1,
      publishedOn: null,
      tasksTotal: 4,
      tasksApproved: 2
    });
    expect(withoutTasks.id).toBe(bare);
    expect(withoutTasks.tasksTotal).toBe(0);
    expect(withoutTasks.tasksApproved).toBe(0);
    expect(Object.keys(withTasks)).not.toContain('caption');
    expect(Object.keys(withTasks)).not.toContain('media');
  });

  it('lists the cancelled and the published too, with their state', async () => {
    const stateClient = await w.newClient('states');
    await w.seedContent(stateClient, { publishOn: '2026-10-02', status: 'cancelled' });
    await w.seedContent(stateClient, { publishOn: '2026-10-03', status: 'published' });
    const reply = await query('2026-10-01', '2026-10-31', stateClient);
    expect(reply.json().data.contents.map((item: { status: string }) => item.status)).toEqual(['cancelled', 'published']);
    expect(reply.json().data.contents[1].publishedOn).toBe('2026-10-06');
  });

  it('never lists the items of another client', async () => {
    const mine = await w.newClient('mine');
    const theirs = await w.newClient('theirs');
    const own = await w.seedContent(mine, { publishOn: '2026-10-05' });
    await w.seedContent(theirs, { publishOn: '2026-10-05' });
    await w.seedScript(theirs, '2026-10-05');
    const reply = await query('2026-10-01', '2026-10-31', mine);
    expect(reply.json().data.contents.map((item: { id: string }) => item.id)).toEqual([own]);
    expect(reply.json().data.storyScripts).toEqual([]);
  });

  it('answers a period with nothing in it with empty lists', async () => {
    const reply = await query('2030-01-01', '2030-01-31');
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ data: { contents: [], storyScripts: [] }, meta: { from: '2030-01-01', to: '2030-01-31', count: 0 } });
  });

  it('reads the period of an archived client, whose content is read only', async () => {
    const archived = await w.newClient('archived-period', { status: 'archived' });
    const contentId = await w.seedContent(archived, { publishOn: '2026-10-05' });
    const reply = await query('2026-10-01', '2026-10-31', archived);
    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.contents.map((item: { id: string }) => item.id)).toEqual([contentId]);
  });

  describe('the ceiling of items', () => {
    let capClient: string;

    beforeAll(async () => {
      capClient = await w.newClient('cap');
      const folderId = await w.folderOf(capClient);
      const rows = Array.from({ length: 400 }, (_, index) => ({
        id: randomUUID(),
        client_id: capClient,
        title: `Cap ${index}`,
        platform: 'instagram',
        format: 'reels',
        publish_on: '2026-10-10',
        folder_id: folderId,
        owner_user_id: people.production.id
      }));
      await w.getOwner().knex('contents').insert(rows);
      await w.getOwner().knex('story_scripts').insert(Array.from({ length: 100 }, () => ({ id: randomUUID(), client_id: capClient, script_on: '2026-10-11' })));
    }, 60_000);

    it('answers 200 at 500 items, counting contents and scripts together', async () => {
      const reply = await query('2026-10-01', '2026-10-31', capClient);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().meta.count).toBe(500);
      expect(reply.json().data.contents).toHaveLength(400);
      expect(reply.json().data.storyScripts).toHaveLength(100);
    });

    it('answers 400 CONTENT_PERIOD_TOO_LARGE at 501 items, whatever the kind of the last one, and sends none of them', async () => {
      await w.getOwner().knex('story_scripts').insert({ id: randomUUID(), client_id: capClient, script_on: '2026-10-12' });
      const reply = await query('2026-10-01', '2026-10-31', capClient);
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('CONTENT_PERIOD_TOO_LARGE');
      expect(reply.json().data).toBeUndefined();

      const narrower = await query('2026-10-01', '2026-10-10', capClient);
      expect(narrower.statusCode).toBe(200);
      expect(narrower.json().meta.count).toBe(400);
    });

    it('answers 400 when contents alone pass the ceiling', async () => {
      const onlyContents = await w.newClient('cap-contents');
      const folderId = await w.folderOf(onlyContents);
      await w.getOwner().knex('contents').insert(Array.from({ length: 501 }, (_, index) => ({
        id: randomUUID(), client_id: onlyContents, title: `Cap ${index}`, platform: 'instagram', format: 'reels',
        publish_on: '2026-10-10', folder_id: folderId, owner_user_id: people.production.id
      })));
      const reply = await query('2026-10-01', '2026-10-31', onlyContents);
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('CONTENT_PERIOD_TOO_LARGE');
    });
  });
});

describe('create (issue #254)', () => {
  it('creates a content in production, whose responsible is who created it, and returns it whole', async () => {
    const reply = await w.call('POST', people.production.cookie, urlA(), {
      ...create, platform: 'instagram', publishAtTime: '18:30', caption: 'Chegou a coleção.', folderId: folderA
    });

    expect(reply.statusCode).toBe(201);
    const body = reply.json();
    expect(body).toMatchObject({
      clientId: clientA,
      title: 'Lançamento da coleção',
      platform: 'instagram',
      format: 'reels',
      publishOn: '2026-10-20',
      publishAtTime: '18:30',
      caption: 'Chegou a coleção.',
      folderId: folderA,
      coverAssetId: null,
      ownerUserId: people.production.id,
      status: 'in_production',
      revision: 1,
      approvedBy: null,
      approvedAt: null,
      approvedByAgencyReason: null,
      publishedOn: null,
      cancelledAt: null,
      media: [],
      tasks: [],
      conversation: { threadId: null, commentCount: 0, lastCommentAt: null }
    });
    expect((await w.contentRow(body.id)).status).toBe('in_production');
  });

  it('creates a content for another responsible when asked, and lets the creator choose without the approval permission', async () => {
    const reply = await w.call('POST', people.production.cookie, urlA(), { ...create, folderId: folderA, ownerUserId: people.manager.id });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().ownerUserId).toBe(people.manager.id);
  });

  it('defaults the platform to instagram and the optional fields to none', async () => {
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ platform: 'instagram', publishAtTime: null, caption: null, coverAssetId: null });
  });

  it('takes a cover that is a confirmed image of the folder', async () => {
    const cover = await w.seedAsset(clientA, folderA, { category: 'image' });
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, coverAssetId: cover });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().coverAssetId).toBe(cover);
  });

  it.each([
    ['a video', { category: 'video' as const }],
    ['an upload that was not confirmed', { status: 'pending' as const }],
    ['a media that was removed', { removed: true }]
  ])('answers 400 CONTENT_MEDIA_INVALID to a cover that is %s, and creates nothing', async (_label, asset) => {
    const before = await w.countContents(clientA);
    const cover = await w.seedAsset(clientA, folderA, asset);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, coverAssetId: cover });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_MEDIA_INVALID');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it('answers 400 CONTENT_MEDIA_INVALID to a cover of another folder, and creates nothing', async () => {
    const before = await w.countContents(clientA);
    const otherFolder = await w.newFolder(clientA, 'Outra pasta');
    const cover = await w.seedAsset(clientA, otherFolder, { category: 'image' });
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, coverAssetId: cover });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_MEDIA_INVALID');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it.each([
    ['a folder of another client', () => folderA2],
    ['a folder of another agency', () => folderB],
    ['a folder that does not exist', () => randomUUID()]
  ])('answers 400 CONTENT_FOLDER_INVALID to %s, and creates nothing', async (_label, folder) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folder() });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_FOLDER_INVALID');
    expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
    expect(await w.countContents(clientA)).toBe(before);
  });

  it.each([
    ['a person who cannot see Conteúdo', () => people.sales.id],
    ['a person of another agency', () => people.adminB.id],
    ['a person that does not exist', () => randomUUID()]
  ])('answers 400 CONTENT_OWNER_INVALID to a responsible that is %s, and creates nothing', async (_label, owner) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, ownerUserId: owner() });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_OWNER_INVALID');
    expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
    expect(await w.countContents(clientA)).toBe(before);
  });

  it('answers 409 CLIENT_ARCHIVED to a client that is archived, and creates nothing', async () => {
    const archived = await w.newClient('archived-create', { status: 'archived' });
    const folderId = await w.folderOf(archived);
    w.statements.length = 0;
    const reply = await w.call('POST', people.admin.cookie, urlA(archived), { ...create, folderId });
    expect(w.statements.some((statement) => /insert into public\.contents/i.test(statement))).toBe(false);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(await w.countContents(archived)).toBe(0);
  });

  it.each([
    ['the state', { status: 'approved' }],
    ['who approved', { approvedBy: '5b241101-e2bb-4255-8caf-4136c566a962' }],
    ['the revision', { revision: 7 }],
    ['the client', { clientId: '5b241101-e2bb-4255-8caf-4136c566a962' }],
    ['an unknown format', { format: 'story' }],
    ['an unknown platform', { platform: 'tiktok' }],
    ['a missing title', { title: undefined }],
    ['a missing folder', { folderId: undefined }]
  ])('answers 400 to a body that carries %s', async (_label, extra) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, ...extra });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it.each([
    ['a NUL byte', 'a\u0000b'],
    ['a control character', 'a\u0007b'],
    ['a line break', 'a\nb'],
    ['a bidi override', 'a‮b'],
    ['a zero-width space', 'a​b'],
    ['a combining grapheme joiner', 'a͏b'],
    ['a variation selector after a letter', 'a️b'],
    ['a Braille blank', 'a⠀b'],
    ['more than 120 characters', 'a'.repeat(121)],
    ['only blanks', '   ']
  ])('answers 400 to a title with %s, and creates nothing', async (_label, title) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, title, folderId: folderA });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it.each([
    ['a NUL byte', 'a\u0000b'],
    ['an escape', 'a\u001Bb'],
    ['a combining grapheme joiner', 'a͏b'],
    ['a variation selector after a letter', 'a️b'],
    ['a Braille blank', 'a⠀b'],
    ['more than 2200 characters', 'a'.repeat(2201)]
  ])('answers 400 to a caption with %s, and creates nothing', async (_label, caption) => {
    const before = await w.countContents(clientA);
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, caption, folderId: folderA });
    expect(reply.statusCode).toBe(400);
    expect(await w.countContents(clientA)).toBe(before);
  });

  it('keeps the line breaks and the emoji of a caption', async () => {
    const caption = 'Primeira linha\nSegunda ❤️\n\tTerceira';
    const reply = await w.call('POST', people.admin.cookie, urlA(), { ...create, caption, folderId: folderA });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().caption).toBe(caption);
  });
});

describe('read one content (issue #254)', () => {
  it('returns the content with its media in order, its subtasks and the summary of its conversation', async () => {
    const folderId = folderA;
    const contentId = await w.seedContent(clientA, { format: 'carousel', folderId, title: 'Carrossel' });
    const first = await w.seedAsset(clientA, folderId, { category: 'image' });
    const second = await w.seedAsset(clientA, folderId, { category: 'video' });
    // Inserted in the opposite order of the positions, so only the ORDER BY puts them right.
    await w.getOwner().knex('content_media').insert([
      { content_id: contentId, asset_id: first, client_id: clientA, folder_id: folderId, position: 2 },
      { content_id: contentId, asset_id: second, client_id: clientA, folder_id: folderId, position: 1 }
    ]);
    const approvedTask = await w.seedTask(contentId, 'approved');
    const pendingTask = await w.seedTask(contentId, 'pending');
    const threadId = randomUUID();
    await w.getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA, content_id: contentId, opened_by: people.admin.id, opened_side: 'agency' });
    await w.getOwner().knex('client_thread_comments').insert([
      { thread_id: threadId, client_id: clientA, author_user_id: people.admin.id, author_side: 'agency', body: 'Primeiro', created_at: new Date('2026-10-08T12:00:00.000Z') },
      { thread_id: threadId, client_id: clientA, author_user_id: people.admin.id, author_side: 'agency', body: 'Segundo', created_at: new Date('2026-10-09T15:30:00.000Z') }
    ]);

    const reply = await w.call('GET', people.reader.cookie, `${urlA()}/${contentId}`);

    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.id).toBe(contentId);
    expect(body.media).toEqual([{ id: second, position: 1 }, { id: first, position: 2 }]);
    expect(body.tasks.map((task: { id: string; status: string }) => [task.id, task.status]).sort()).toEqual([[approvedTask, 'approved'], [pendingTask, 'pending']].sort());
    expect(body.tasks.find((task: { id: string }) => task.id === approvedTask)).toMatchObject({ approvedBy: people.admin.id, assigneeUserId: people.production.id, dueOn: '2026-10-15' });
    expect(body.conversation).toEqual({ threadId, commentCount: 2, lastCommentAt: '2026-10-09T15:30:00.000Z' });
  });

  it('returns no media, no subtasks and no thread for a content without them', async () => {
    const contentId = await w.seedContent(clientA);
    const reply = await w.call('GET', people.admin.cookie, `${urlA()}/${contentId}`);
    expect(reply.json()).toMatchObject({ media: [], tasks: [], conversation: { threadId: null, commentCount: 0, lastCommentAt: null } });
  });

  it('reads the content of an archived client', async () => {
    const archived = await w.newClient('archived-read', { status: 'archived' });
    const contentId = await w.seedContent(archived);
    const reply = await w.call('GET', people.admin.cookie, `${urlA(archived)}/${contentId}`);
    expect(reply.statusCode).toBe(200);
  });

  it('answers a thread of a thread-less content with the summary of its own, not another content\'s', async () => {
    const withThread = await w.seedContent(clientA);
    const without = await w.seedContent(clientA);
    const threadId = randomUUID();
    await w.getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA, content_id: withThread, opened_by: people.admin.id, opened_side: 'agency' });
    await w.getOwner().knex('client_thread_comments').insert({ thread_id: threadId, client_id: clientA, author_user_id: people.admin.id, author_side: 'agency', body: 'Só deste' });
    const reply = await w.call('GET', people.admin.cookie, `${urlA()}/${without}`);
    expect(reply.json().conversation).toEqual({ threadId: null, commentCount: 0, lastCommentAt: null });
  });
});

describe('edit and move (issue #254)', () => {
  const patch = (cookie: string, contentId: string, payload: Record<string, unknown>, clientId = clientA) =>
    w.call('PATCH', cookie, `${urlA(clientId)}/${contentId}`, payload);

  it('moves the date with PATCH and keeps the approval, the state and the revision', async () => {
    const contentId = await w.seedContent(clientA, { status: 'approved', publishOn: '2026-10-20' });
    const before = await w.contentRow(contentId);

    const reply = await patch(people.production.cookie, contentId, { publishOn: '2026-10-25', publishAtTime: '09:15' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ publishOn: '2026-10-25', publishAtTime: '09:15', status: 'approved', revision: 1, approvedBy: people.admin.id });
    const after = await w.contentRow(contentId);
    expect(after.approved_by).toBe(before.approved_by);
    expect(after.approved_at).toEqual(before.approved_at);
  });

  it('moves the date of a content in every state but published and cancelled', async () => {
    for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const) {
      const contentId = await w.seedContent(clientA, { status });
      const reply = await patch(people.production.cookie, contentId, { publishOn: '2026-12-01' });
      expect(reply.statusCode, status).toBe(200);
      expect(reply.json().publishOn, status).toBe('2026-12-01');
      expect(reply.json().status, status).toBe(status);
    }
  });

  it('clears the time of a content with null, and the caption, and the cover', async () => {
    const cover = await w.seedAsset(clientA, folderA, { category: 'image' });
    const contentId = await w.seedContent(clientA, { publishAtTime: '10:00', caption: 'Legenda', coverAssetId: cover });
    const reply = await patch(people.admin.cookie, contentId, { publishAtTime: null, caption: null, coverAssetId: null });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ publishAtTime: null, caption: null, coverAssetId: null });
  });

  it('turns a blank caption into none', async () => {
    const contentId = await w.seedContent(clientA, { caption: 'Legenda' });
    const reply = await patch(people.admin.cookie, contentId, { caption: '   ' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().caption).toBeNull();
  });

  it('sends an approved content back to "aguardando aprovação" when its caption changes', async () => {
    const contentId = await w.seedContent(clientA, { status: 'approved', caption: 'Legenda original' });

    const reply = await patch(people.production.cookie, contentId, { caption: 'Legenda nova' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      status: 'awaiting_approval',
      caption: 'Legenda nova',
      revision: 2,
      approvedBy: null,
      approvedAt: null,
      approvedByAgencyReason: null
    });
    expect((await w.contentRow(contentId)).status).toBe('awaiting_approval');
  });

  it('sends an approved content back to "aguardando aprovação" when its cover changes', async () => {
    const contentId = await w.seedContent(clientA, { status: 'approved' });
    const cover = await w.seedAsset(clientA, folderA, { category: 'image' });
    const reply = await patch(people.production.cookie, contentId, { coverAssetId: cover });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'awaiting_approval', revision: 2, coverAssetId: cover });
  });

  it('keeps the approval when only the title or the responsible-neutral fields change', async () => {
    const contentId = await w.seedContent(clientA, { status: 'approved' });
    const reply = await patch(people.production.cookie, contentId, { title: 'Novo título' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'approved', title: 'Novo título', revision: 1 });
  });

  it('raises the revision of a content in production when the caption changes, without any state change', async () => {
    const contentId = await w.seedContent(clientA, { caption: 'A' });
    const reply = await patch(people.production.cookie, contentId, { caption: 'B' });
    expect(reply.json()).toMatchObject({ status: 'in_production', revision: 2 });
  });

  it.each(['published', 'cancelled'] as const)('answers 409 CONTENT_NOT_EDITABLE to an edit, a move and a media list of a %s content, and changes nothing', async (status) => {
    const contentId = await w.seedContent(clientA, { status, title: 'Fechado' });
    const asset = await w.seedAsset(clientA, folderA, { category: 'video' });

    const title = await patch(people.admin.cookie, contentId, { title: 'Aberto' });
    const move = await patch(people.admin.cookie, contentId, { publishOn: '2026-12-31' });
    const media = await patch(people.admin.cookie, contentId, { mediaAssetIds: [asset] });

    for (const reply of [title, move, media]) {
      expect(reply.statusCode).toBe(409);
      expect(reply.json().error.code).toBe('CONTENT_NOT_EDITABLE');
      expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
    }
    const row = await w.contentRow(contentId);
    expect(row.title).toBe('Fechado');
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
    expect(await w.getOwner().knex('content_media').where({ content_id: contentId }).count<Array<{ count: string }>>('asset_id as count')).toEqual([{ count: '0' }]);
  });

  it('answers 409 CLIENT_ARCHIVED to an edit of an archived client\'s content, and changes nothing', async () => {
    const archived = await w.newClient('archived-patch', { status: 'archived' });
    const contentId = await w.seedContent(archived, { title: 'Guardado' });
    w.statements.length = 0;
    const reply = await patch(people.admin.cookie, contentId, { title: 'Editado' }, archived);
    expect(w.statements.some((statement) => /update public\.contents/i.test(statement))).toBe(false);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CLIENT_ARCHIVED');
    expect((await w.contentRow(contentId)).title).toBe('Guardado');
  });

  it('answers 404 to an edit of a content that does not exist', async () => {
    const reply = await patch(people.admin.cookie, randomUUID(), { title: 'x' });
    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Content not found.' });
  });

  it.each([
    ['an empty body', {}],
    ['the state', { status: 'approved' }],
    ['the approval', { approvedAt: '2026-10-11T00:00:00Z' }],
    ['the revision', { revision: 9 }],
    ['the platform', { platform: 'instagram' }],
    ['a null title', { title: null }],
    ['a null date', { publishOn: null }],
    ['a day that does not exist', { publishOn: '2026-02-30' }],
    ['a time with seconds', { publishAtTime: '10:30:00' }],
    ['21 media', { mediaAssetIds: Array.from({ length: 21 }, () => randomUUID()) }]
  ])('answers 400 to an edit that carries %s', async (_label, payload) => {
    const contentId = await w.seedContent(clientA, { title: 'Intacto' });
    const reply = await patch(people.admin.cookie, contentId, payload as Record<string, unknown>);
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    expect((await w.contentRow(contentId)).title).toBe('Intacto');
  });

  it.each([
    ['a NUL byte', { title: 'a\u0000b' }],
    ['a control character', { title: 'a\u0007b' }],
    ['a combining grapheme joiner', { title: 'a͏b' }],
    ['a variation selector after a letter', { title: 'a️b' }],
    ['a Braille blank', { title: 'a⠀b' }],
    ['a NUL byte in the caption', { caption: 'a\u0000b' }],
    ['a combining grapheme joiner in the caption', { caption: 'a͏b' }],
    ['a variation selector in the caption', { caption: 'a️b' }],
    ['a Braille blank in the caption', { caption: 'a⠀b' }]
  ])('answers 400 to an edit with %s, and changes nothing', async (_label, payload) => {
    const contentId = await w.seedContent(clientA, { title: 'Intacto', caption: 'Legenda' });
    const reply = await patch(people.admin.cookie, contentId, payload);
    expect(reply.statusCode).toBe(400);
    const row = await w.contentRow(contentId);
    expect([row.title, row.caption]).toEqual(['Intacto', 'Legenda']);
  });

  describe('the person in charge', () => {
    it('answers 403 to who operates and does not approve for the agency, and changes nothing', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      w.statements.length = 0;
      const reply = await patch(people.production.cookie, contentId, { ownerUserId: people.manager.id });
      expect(reply.statusCode).toBe(403);
      expect(reply.json().error.code).toBe('FORBIDDEN');
      expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
      // The route refuses before it writes: the trigger of the database is the second barrier, not the first.
      expect(w.statements.some((statement) => /update public\.contents/i.test(statement))).toBe(false);
    });

    it('does not apply the other fields of a request that asks for the responsible without the permission', async () => {
      const contentId = await w.seedContent(clientA, { title: 'Intacto', ownerUserId: people.production.id });
      const reply = await patch(people.production.cookie, contentId, { title: 'Trocado', ownerUserId: people.manager.id });
      expect(reply.statusCode).toBe(403);
      expect((await w.contentRow(contentId)).title).toBe('Intacto');
    });

    it('lets who approves for the agency change the responsible', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const reply = await patch(people.manager.cookie, contentId, { ownerUserId: people.admin.id });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().ownerUserId).toBe(people.admin.id);
    });

    it('lets the Owner of the agency change the responsible, by ownership', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const reply = await patch(people.owner.cookie, contentId, { ownerUserId: people.manager.id });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().ownerUserId).toBe(people.manager.id);
    });

    it('lets who only operates send the responsible it already is, which changes nothing', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const reply = await patch(people.production.cookie, contentId, { ownerUserId: people.production.id, title: 'Mesmo responsável' });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().title).toBe('Mesmo responsável');
    });

    it('answers 400 CONTENT_OWNER_INVALID to a responsible who cannot see Conteúdo', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const reply = await patch(people.manager.cookie, contentId, { ownerUserId: people.sales.id });
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('CONTENT_OWNER_INVALID');
      expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
    });

    it('is refused by the database itself when the permission is gone by the time the row is written, and the route answers 403', async () => {
      // The route read the permission with the request and lets the change through; the trigger reads it again.
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const roleId = w.getApproverRoleId();

      w.runBeforeStatement(/update public\.contents/i, async () => {
        await w.getOwner().knex('role_permissions').where({ role_id: roleId, permission_key: 'conteudo.aprovar_pela_agencia' }).delete();
      });
      try {
        const reply = await patch(people.approver.cookie, contentId, { ownerUserId: people.manager.id });

        expect(reply.statusCode).toBe(403);
        expect(reply.json().error.code).toBe('FORBIDDEN');
        expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
        expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
      } finally {
        w.clearHook();
        await w.getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'conteudo.aprovar_pela_agencia' }).onConflict().ignore();
      }
    });

    it('is refused by the database for the application role itself, with 42501 and nothing written', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      await expect(withAuthenticatedUserTransaction(w.getApp().database, createVerifiedUserClaims({ userId: people.production.id }), (transaction) =>
        transaction.raw('update public.contents set owner_user_id = ?::uuid where id = ?::uuid', [people.manager.id, contentId])
      )).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('Only who approves for the agency changes the person in charge of a content.') });
      expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
    });
  });
});

describe('format, folder, cover and media in one request (issue #254)', () => {
  const patch = (contentId: string, payload: Record<string, unknown>, cookie = people.production.cookie) =>
    w.call('PATCH', cookie, `${urlA()}/${contentId}`, payload);
  const mediaOf = async (contentId: string): Promise<string[]> =>
    (await w.getOwner().knex('content_media').where({ content_id: contentId }).orderBy('position').select('asset_id')).map((row) => row.asset_id as string);

  it('changes the format and the whole media list in the one request, for a content in production', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels' });
    const video = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [video]);
    const image = await w.seedAsset(clientA, folderA, { category: 'image' });
    const second = await w.seedAsset(clientA, folderA, { category: 'video' });

    const reply = await patch(contentId, { format: 'carousel', mediaAssetIds: [second, image, video] });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().format).toBe('carousel');
    expect(reply.json().media).toEqual([{ id: second, position: 1 }, { id: image, position: 2 }, { id: video, position: 3 }]);
    expect(await mediaOf(contentId)).toEqual([second, image, video]);
  });

  it('writes the format and the media in one transaction: a media that is refused leaves the format as it was', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', title: 'Intacto' });
    const foreign = await w.seedAsset(clientA2, folderA2, { category: 'image' });
    const image = await w.seedAsset(clientA, folderA, { category: 'image' });

    const reply = await patch(contentId, { format: 'carousel', title: 'Não vale', mediaAssetIds: [image, foreign] });

    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_MEDIA_INVALID');
    const row = await w.contentRow(contentId);
    expect([row.format, row.title, row.revision]).toEqual(['reels', 'Intacto', 1]);
    expect(await mediaOf(contentId)).toEqual([]);
  });

  it('replaces the media list alone, without any other column', async () => {
    const contentId = await w.seedContent(clientA, { format: 'carousel' });
    const first = await w.seedAsset(clientA, folderA, { category: 'image' });
    const second = await w.seedAsset(clientA, folderA, { category: 'image' });
    const third = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [first, second]);

    const reply = await patch(contentId, { mediaAssetIds: [third, second] });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().media).toEqual([{ id: third, position: 1 }, { id: second, position: 2 }]);
    expect(reply.json().revision).toBe(2);
  });

  it('clears the media of a content in production with an empty list', async () => {
    const contentId = await w.seedContent(clientA, { format: 'image' });
    const image = await w.seedAsset(clientA, folderA, { category: 'image' });
    await w.attach(contentId, [image]);
    const reply = await patch(contentId, { mediaAssetIds: [] });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().media).toEqual([]);
  });

  it('does not count a revision, and does not take back an approval, when the list sent is the one already there', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', status: 'approved' });
    const video = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [video]);
    const reply = await patch(contentId, { mediaAssetIds: [video] });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'approved', revision: 1 });
  });

  it('sends an approved content back to "aguardando aprovação" when its media changes', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', status: 'approved' });
    const video = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [video]);
    const other = await w.seedAsset(clientA, folderA, { category: 'video' });

    const reply = await patch(contentId, { mediaAssetIds: [other] });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'awaiting_approval', revision: 2, approvedBy: null });
    expect(reply.json().media).toEqual([{ id: other, position: 1 }]);
  });

  it('answers 409 CONTENT_MEDIA_INCOMPLETE to an approved content left without media, and keeps it as it was', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', status: 'approved' });
    const video = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [video]);

    const reply = await patch(contentId, { mediaAssetIds: [] });

    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CONTENT_MEDIA_INCOMPLETE');
    expect((await w.contentRow(contentId)).status).toBe('approved');
    expect(await mediaOf(contentId)).toEqual([video]);
  });

  it('keeps an approved reels from becoming a carousel in place: 409 CONTENT_MEDIA_INCOMPLETE, with or without the list', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', status: 'approved' });
    const video = await w.seedAsset(clientA, folderA, { category: 'video' });
    const other = await w.seedAsset(clientA, folderA, { category: 'video' });
    await w.attach(contentId, [video]);

    const withoutList = await patch(contentId, { format: 'carousel' });
    const withList = await patch(contentId, { format: 'carousel', mediaAssetIds: [video, other] });

    for (const reply of [withoutList, withList]) {
      expect(reply.statusCode).toBe(409);
      expect(reply.json().error.code).toBe('CONTENT_MEDIA_INCOMPLETE');
      expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
    }
    const row = await w.contentRow(contentId);
    expect([row.format, row.status, row.revision]).toEqual(['reels', 'approved', 1]);
    expect(await mediaOf(contentId)).toEqual([video]);
  });

  it('lets an approved reels become a long video, which the same media covers, and sends it back to approval', async () => {
    const contentId = await w.seedContent(clientA, { format: 'reels', status: 'approved' });
    await w.attach(contentId, [await w.seedAsset(clientA, folderA, { category: 'video' })]);
    const reply = await patch(contentId, { format: 'long_video' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ format: 'long_video', status: 'awaiting_approval', revision: 2 });
  });

  it('lets a content in production change between a carousel and one media freely', async () => {
    const contentId = await w.seedContent(clientA, { format: 'carousel' });
    const first = await w.seedAsset(clientA, folderA, { category: 'image' });
    const second = await w.seedAsset(clientA, folderA, { category: 'image' });
    await w.attach(contentId, [first, second]);
    const reply = await patch(contentId, { format: 'image', mediaAssetIds: [first] });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ format: 'image', media: [{ id: first, position: 1 }] });
  });

  it.each([
    ['the same media twice', async () => { const a = await w.seedAsset(clientA, folderA, { category: 'image' }); return [a, a]; }],
    ['a media of another client', async () => [await w.seedAsset(clientA2, folderA2, { category: 'image' })]],
    ['a media of another folder', async () => [await w.seedAsset(clientA, await w.newFolder(clientA, 'Outra'), { category: 'image' })]],
    ['a media that was removed', async () => [await w.seedAsset(clientA, folderA, { category: 'image', removed: true })]],
    ['a media that does not exist', async () => [randomUUID()]],
    ['two media in a format of one', async () => [await w.seedAsset(clientA, folderA), await w.seedAsset(clientA, folderA)]]
  ])('answers 400 CONTENT_MEDIA_INVALID to %s, and changes nothing', async (_label, list) => {
    const contentId = await w.seedContent(clientA, { format: 'image' });
    const reply = await patch(contentId, { mediaAssetIds: await list() });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_MEDIA_INVALID');
    expect(await mediaOf(contentId)).toEqual([]);
  });

  it('moves the folder of a content that holds no media and no cover', async () => {
    const contentId = await w.seedContent(clientA);
    const otherFolder = await w.newFolder(clientA, 'Nova pasta');
    const reply = await patch(contentId, { folderId: otherFolder });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().folderId).toBe(otherFolder);
  });

  it('answers 409 CONTENT_FOLDER_IN_USE to a move of the folder of a content with media', async () => {
    const contentId = await w.seedContent(clientA);
    await w.attach(contentId, [await w.seedAsset(clientA, folderA, { category: 'video' })]);
    const reply = await patch(contentId, { folderId: await w.newFolder(clientA, 'Outra pasta') });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CONTENT_FOLDER_IN_USE');
    expect((await w.contentRow(contentId)).folder_id).toBe(folderA);
  });

  it('answers 409 CONTENT_FOLDER_IN_USE to a move of the folder of a content with a cover, and 400 when the cover is the one that does not fit', async () => {
    const cover = await w.seedAsset(clientA, folderA, { category: 'image' });
    const contentId = await w.seedContent(clientA, { coverAssetId: cover });
    const moved = await patch(contentId, { folderId: await w.newFolder(clientA, 'Outra pasta') });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe('CONTENT_FOLDER_IN_USE');

    const foreignCover = await w.seedAsset(clientA, await w.newFolder(clientA, 'Pasta da capa'), { category: 'image' });
    const wrongCover = await patch(contentId, { coverAssetId: foreignCover });
    expect(wrongCover.statusCode).toBe(400);
    expect(wrongCover.json().error.code).toBe('CONTENT_MEDIA_INVALID');
    expect((await w.contentRow(contentId)).cover_asset_id).toBe(cover);
  });

  it.each([
    ['of another client', () => folderA2],
    ['of another agency', () => folderB],
    ['that does not exist', () => randomUUID()]
  ])('answers 400 CONTENT_FOLDER_INVALID to a move to a folder %s', async (_label, folder) => {
    const contentId = await w.seedContent(clientA);
    const reply = await patch(contentId, { folderId: folder() });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('CONTENT_FOLDER_INVALID');
    expect((await w.contentRow(contentId)).folder_id).toBe(folderA);
  });
});
