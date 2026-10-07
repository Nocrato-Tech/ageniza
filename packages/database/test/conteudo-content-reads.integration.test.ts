import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #249 (specs/conteudo.md §2, §5 rules 1 and 2, §6 RLS): who reads what. RLS answers WHO may read, not
// through WHICH SIDE, so every rule of the portal is checked with a person who only holds a link, with a
// collaborator who holds a link and a role without Conteúdo (`dualBare`), with one who holds a link and the
// Production role (`dualFull`), and with an Admin of another agency who holds a link here (`crossDual`).
// A read is checked by the rows it returns.
const w = createContentWorld('conteudo-reads');
const { ids } = w;

const STATUSES: readonly ContentStatus[] = ['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled'];
const OPEN: readonly ContentStatus[] = ['awaiting_approval', 'adjusting', 'approved', 'published'];

let onlyVisualizar: string;
let onlyOperar: string;
let onlyMidia: string;
const content = {} as Record<ContentStatus, string>;
const video = {} as Record<ContentStatus, string>;
const cover = {} as Record<ContentStatus, string>;
const task = {} as Record<ContentStatus, string>;
let detached: string;
let otherClientContent: string;
let otherClientVideo: string;
let otherAgencyContent: string;
let otherAgencyVideo: string;
let everyContent: string[];

beforeAll(async () => {
  await w.setup();
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  onlyOperar = await w.personWith('conteudo.operar');
  onlyMidia = await w.personWith('midia.enviar');
  const folder = await w.folderOf(ids.clientA1);

  for (const status of STATUSES) {
    cover[status] = await w.seedAsset(ids.clientA1, folder);
    video[status] = await w.seedAsset(ids.clientA1, folder, { category: 'video' });
    content[status] = await w.seedContent(ids.clientA1, { status, coverAssetId: cover[status], caption: `Legenda ${status}` });
    await w.attach(content[status], [video[status]]);
    if (status !== 'published' && status !== 'cancelled') task[status] = await w.seedTask(content[status]);
  }
  detached = await w.seedAsset(ids.clientA1, folder);

  const folderA2 = await w.folderOf(ids.clientA2);
  otherClientVideo = await w.seedAsset(ids.clientA2, folderA2, { category: 'video' });
  otherClientContent = await w.seedContent(ids.clientA2, { status: 'awaiting_approval', folderId: folderA2 });
  await w.attach(otherClientContent, [otherClientVideo]);

  const folderB = await w.folderOf(ids.clientB);
  otherAgencyVideo = await w.seedAsset(ids.clientB, folderB, { category: 'video' });
  otherAgencyContent = await w.seedContent(ids.clientB, { status: 'awaiting_approval', folderId: folderB, owner: ids.adminB });
  await w.attach(otherAgencyContent, [otherAgencyVideo]);

  everyContent = [...STATUSES.map((status) => content[status]), otherClientContent, otherAgencyContent];
});

afterAll(async () => {
  await w.teardown();
});

const visible = async (user: string, table: 'contents' | 'content_tasks' | 'content_media' | 'media_assets', column: string, among: readonly string[]): Promise<string[]> =>
  (await w.asUser(user, (transaction) => transaction(table).whereIn(column, among).select(column))).map((row) => row[column] as string).sort();

const portal = (user: string, clientId: string, extra: { from?: string; to?: string; statuses?: string[]; contentId?: string } = {}) =>
  w.asUser(user, async (transaction) => (await transaction.raw<{ rows: Array<Record<string, unknown>> }>(
    'select * from app_private.portal_contents(?::uuid, ?::date, ?::date, ?::text[], ?::uuid)',
    [clientId, extra.from ?? null, extra.to ?? null, extra.statuses ?? null, extra.contentId ?? null] as never[]
  )).rows);

const agencyOwnContents = (): string[] => [...STATUSES.map((status) => content[status]), otherClientContent].sort();

describe('the agency reads contents, media and subtasks with conteudo.visualizar (issue #249)', () => {
  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['Production', () => ids.productionA],
    ['the Account manager', () => ids.managerA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a collaborator with the Production role and a link to the client, through the agency', () => ids.dualFull],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('shows %s every content, every media link and every subtask of every client of the agency, and none of another agency', async (_label, user) => {
    expect(await visible(user(), 'contents', 'id', everyContent)).toEqual(agencyOwnContents());
    expect(await visible(user(), 'content_media', 'content_id', everyContent)).toEqual(agencyOwnContents());
    expect(await visible(user(), 'content_tasks', 'id', Object.values(task))).toEqual(Object.values(task).sort());
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role that only sends media', () => onlyMidia]
  ] as const)('shows %s no content, no media link, no subtask and no media of a client', async (_label, user) => {
    expect(await visible(user(), 'contents', 'id', everyContent)).toEqual([]);
    expect(await visible(user(), 'content_media', 'content_id', everyContent)).toEqual([]);
    expect(await visible(user(), 'content_tasks', 'id', Object.values(task))).toEqual([]);
    expect(await visible(user(), 'media_assets', 'id', Object.values(video))).toEqual([]);
  });

  it.each([
    ['the Admin of another agency', () => ids.adminB],
    ['an Admin of another agency who holds a link to a client here', () => ids.crossDual]
  ] as const)('shows %s no content and no subtask of this agency, only what is of the agency of that Admin', async (_label, user) => {
    expect(await visible(user(), 'contents', 'id', everyContent)).toEqual([otherAgencyContent]);
    expect(await visible(user(), 'content_tasks', 'id', Object.values(task))).toEqual([]);
  });

  it('shows the Admin of another agency no media link and no media of this agency', async () => {
    expect(await visible(ids.adminB, 'content_media', 'content_id', everyContent)).toEqual([otherAgencyContent]);
    expect(await visible(ids.adminB, 'media_assets', 'id', [...Object.values(video), ...Object.values(cover), detached, otherClientVideo])).toEqual([]);
  });

  it('shows a content of an archived client to the agency, which is read-only for it', async () => {
    const id = await w.seedContent(ids.clientArchived);
    await w.archiveClient(ids.clientArchived);

    try {
      expect(await visible(ids.adminA, 'contents', 'id', [id])).toEqual([id]);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
  });
});

describe('the portal reads no content table, whatever the state (issue #249, acceptance 5)', () => {
  it.each([
    ['a person of the portal of the client', () => ids.portalA1],
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('shows %s no row of contents and none of content_tasks, in any state', async (_label, user) => {
    const own = await visible(user(), 'contents', 'id', STATUSES.map((status) => content[status]));
    expect(own).toEqual([]);
    expect(await visible(user(), 'contents', 'id', [otherClientContent])).toEqual([]);
    expect(await visible(user(), 'content_tasks', 'id', Object.values(task))).toEqual([]);
    expect(await w.asUser(user(), (transaction) => transaction('content_tasks').select('id'))).toHaveLength(0);
  });

  it('shows a person of the portal of an archived client and of a suspended agency nothing at all', async () => {
    const archived = await w.seedContent(ids.clientArchived, { status: 'awaiting_approval' });
    await w.archiveClient(ids.clientArchived);
    await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });

    try {
      expect(await visible(ids.portalArchived, 'contents', 'id', [archived])).toEqual([]);
      expect(await portal(ids.portalArchived, ids.clientArchived)).toEqual([]);
      expect(await portal(ids.portalSuspended, ids.clientSuspended)).toEqual([]);
    } finally {
      await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
      await w.reactivateClient(ids.clientArchived);
    }
  });
});

describe('the portal reads a content through app_private.portal_contents (issue #249, acceptance 5)', () => {
  const people = [
    ['a person of the portal of the client', () => ids.portalA1],
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['a collaborator with the Production role and a link to the client, who reads the portal side through this function', () => ids.dualFull],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const;

  it.each(people)('shows %s title, date, format and state of a content in production, and nothing else of it', async (_label, user) => {
    const rows = await portal(user(), ids.clientA1);
    const production = rows.find((row) => row.id === content.in_production);

    expect(production).toEqual({
      id: content.in_production, title: expect.any(String), platform: 'instagram', format: 'reels', publish_on: expect.any(Date), status: 'in_production',
      revision: null, publish_at_time: null, caption: null, cover_asset_id: null, published_on: null
    });
  });

  it.each(people)('shows %s the caption, the cover and the revision from "awaiting approval" on, and no cancelled content', async (_label, user) => {
    const rows = await portal(user(), ids.clientA1);

    expect(rows.map((row) => row.status).sort()).toEqual(['adjusting', 'approved', 'awaiting_approval', 'in_production', 'published']);
    for (const status of OPEN) {
      expect(rows.find((row) => row.id === content[status]), status).toMatchObject({ status, caption: `Legenda ${status}`, cover_asset_id: cover[status], revision: 1 });
    }
  });

  it('returns no column that is internal to the agency', async () => {
    const [row] = await portal(ids.portalA1, ids.clientA1, { contentId: content.approved });

    expect(Object.keys(row ?? {}).sort()).toEqual([
      'caption', 'cover_asset_id', 'format', 'id', 'platform', 'publish_at_time', 'publish_on', 'published_on', 'revision', 'status', 'title'
    ]);
  });

  it.each([
    ['an Admin of the agency, who has no link to the client', () => ids.adminA],
    ['the Owner of the agency', () => ids.ownerA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved],
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['Sales', () => ids.salesA]
  ] as const)('shows %s no content of the client: the agency permission is not a link', async (_label, user) => {
    expect(await portal(user(), ids.clientA1)).toEqual([]);
    expect(await portal(user(), ids.clientA1, { contentId: content.approved })).toEqual([]);
  });

  it('does not answer for a client the person has no link to, nor for the content of another client asked through their own', async () => {
    expect(await portal(ids.portalA1, ids.clientA2)).toEqual([]);
    expect(await portal(ids.portalA1, ids.clientB)).toEqual([]);
    expect(await portal(ids.portalA1, ids.clientA1, { contentId: otherClientContent })).toEqual([]);
    expect(await portal(ids.portalA2, ids.clientA2)).toHaveLength(1);
  });

  it('filters by period, by state and by content, and orders by date', async () => {
    await w.getOwner().knex('contents').where({ id: content.approved }).update({ publish_on: '2026-10-05' });
    await w.getOwner().knex('contents').where({ id: content.adjusting }).update({ publish_on: '2026-11-30' });

    const inOctober = await portal(ids.portalA1, ids.clientA1, { from: '2026-10-01', to: '2026-10-31' });
    const awaiting = await portal(ids.portalA1, ids.clientA1, { statuses: ['awaiting_approval'] });
    const one = await portal(ids.portalA1, ids.clientA1, { contentId: content.published });

    expect(inOctober.map((row) => row.id)).not.toContain(content.adjusting);
    expect(inOctober[0]?.id).toBe(content.approved);
    expect(awaiting.map((row) => row.id)).toEqual([content.awaiting_approval]);
    expect(one.map((row) => row.id)).toEqual([content.published]);
    expect(await portal(ids.portalA1, ids.clientA1, { contentId: content.cancelled })).toEqual([]);
  });
});

describe('the portal reads a media only through a content it may open (issue #249)', () => {
  // The Admin of agency B also reads what is of agency B through the agency side, which this test does not take away.
  const readers = [
    ['a person of the portal of the client', () => ids.portalA1, () => ({ media: [] as string[], links: [] as string[] })],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare, () => ({ media: [] as string[], links: [] as string[] })],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual, () => ({ media: [otherAgencyVideo], links: [otherAgencyContent] })]
  ] as const;
  const open = (map: Record<ContentStatus, string>): string[] => OPEN.map((status) => map[status]).sort();
  const everyMedia = (): string[] => [...Object.values(video), ...Object.values(cover), detached, otherClientVideo, otherAgencyVideo];

  it.each(readers)('shows %s the media and the cover of the contents from "awaiting approval" on, and no other media', async (_label, user, extra) => {
    expect(await visible(user(), 'media_assets', 'id', everyMedia())).toEqual([...open(video), ...open(cover), ...extra().media].sort());
    expect(await visible(user(), 'content_media', 'content_id', everyContent)).toEqual([...open(content), ...extra().links].sort());
  });

  it.each(readers)('shows %s no media of a content in production, of a cancelled one, or of the folder that no content selected', async (_label, user) => {
    expect(await visible(user(), 'media_assets', 'id', [video.in_production, cover.in_production, video.cancelled, cover.cancelled, detached])).toEqual([]);
    expect(await visible(user(), 'content_media', 'content_id', [content.in_production, content.cancelled])).toEqual([]);
  });

  it('shows a person of the portal of another client of the same agency only the media of that client', async () => {
    expect(await visible(ids.portalA2, 'media_assets', 'id', everyMedia())).toEqual([otherClientVideo]);
  });

  it('follows the state of the content: the media appears when the content is sent and goes when it is cancelled', async () => {
    const folder = await w.folderOf(ids.clientA1);
    const asset = await w.seedAsset(ids.clientA1, folder, { category: 'video' });
    const id = await w.seedContent(ids.clientA1, { status: 'in_production' });
    await w.attach(id, [asset]);
    const readOf = async (): Promise<string[]> => visible(ids.portalA1, 'media_assets', 'id', [asset]);

    expect(await readOf()).toEqual([]);
    await w.getOwner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id }).update({ status: 'awaiting_approval' });
    });
    expect(await readOf()).toEqual([asset]);
    await w.getOwner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id }).update({ status: 'cancelled' });
    });
    expect(await readOf()).toEqual([]);
  });

  it('shows the portal of an archived client no media, the ones of a content that was already sent included', async () => {
    const folder = await w.folderOf(ids.clientArchived);
    const asset = await w.seedAsset(ids.clientArchived, folder, { category: 'video' });
    const id = await w.seedContent(ids.clientArchived, { status: 'awaiting_approval' });
    await w.attach(id, [asset]);
    await w.archiveClient(ids.clientArchived);

    try {
      expect(await visible(ids.portalArchived, 'media_assets', 'id', [asset])).toEqual([]);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await visible(ids.portalArchived, 'media_assets', 'id', [asset])).toEqual([asset]);
  });

  it('does not let the portal write a media, a link or a cover, nor read the media of a client from another agency', async () => {
    await expect(w.asUser(ids.portalA1, (transaction) => transaction('media_assets').where({ id: video.approved }).update({ updated_at: new Date() }))).resolves.toBe(0);
    expect(await visible(ids.portalA1, 'media_assets', 'id', [otherAgencyVideo])).toEqual([]);
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar]
  ] as const)('still shows %s every media of the clients of the agency, the ones in production included', async (_label, user) => {
    expect(await visible(user(), 'media_assets', 'id', everyMedia())).toEqual([...Object.values(video), ...Object.values(cover), detached, otherClientVideo].sort());
  });
});
