import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #249 (specs/conteudo.md §3, §4, §5, §6). Every attack runs as `ageniza_app`; RLS filters silently, so a
// read is checked by the rows it returns and a write by the state left in the database. See support/content-world.ts
// for the people: custom roles holding one permission, and the "dual" people who hold a link to a client.
const w = createContentWorld('conteudo-contents');
const { ids } = w;

const NOT_FOUND = { code: 'A0060' };
const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const deniedByGrant = (table: string) => ({ code: '42501', message: expect.stringContaining(`permission denied for table ${table}`) });
const foreignKey = (constraint: string) => ({ code: '23503', constraint });
const check = (constraint: string) => ({ code: '23514', constraint });

let folderA1: string;
let folderA2: string;
let onlyOperar: string;
let onlyVisualizar: string;
let operarAndVisualizar: string;

beforeAll(async () => {
  await w.setup();
  folderA1 = await w.folderOf(ids.clientA1);
  folderA2 = await w.folderOf(ids.clientA2);
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
});

afterAll(async () => {
  await w.teardown();
});

const fn = (user: string, signature: string, ...args: unknown[]): Promise<unknown> =>
  w.asUser(user, (transaction) => transaction.raw(`select app_private.${signature}`, args as never[]));
const submitAs = (user: string, id: string) => fn(user, 'submit_content(?::uuid)', id);
const approveAs = (user: string, id: string, revision: number) => fn(user, 'approve_content(?::uuid, ?::integer)', id, revision);
const approveByAgencyAs = (user: string, id: string, revision: number, reason: string | null) =>
  fn(user, 'approve_content_by_agency(?::uuid, ?::integer, ?::text)', id, revision, reason);
const publishAs = (user: string, id: string, day: string | null) => fn(user, 'publish_content(?::uuid, ?::date)', id, day);
const unpublishAs = (user: string, id: string) => fn(user, 'unpublish_content(?::uuid)', id);
const cancelAs = (user: string, id: string) => fn(user, 'cancel_content(?::uuid)', id);
const rescheduleAs = (user: string, id: string, day: string | null = null) => fn(user, 'reschedule_content(?::uuid, ?::date)', id, day);
const setMediaAs = (user: string, id: string, assets: readonly string[]) => fn(user, 'set_content_media(?::uuid, ?::uuid[])', id, assets);

const sqlText = async (query: string, bindings: unknown[] = []): Promise<string> => {
  const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ value: string }> }>(query, bindings as never[]);
  return rows[0]?.value as string;
};
const today = (): Promise<string> => sqlText("select ((now() at time zone 'America/Sao_Paulo')::date)::text as value");
const daysFromToday = (days: number): Promise<string> => sqlText("select ((now() at time zone 'America/Sao_Paulo')::date + ?::integer)::text as value", [days]);
const dayOf = (id: string, column: string): Promise<string | null> =>
  sqlText(`select to_char(${column}, 'YYYY-MM-DD') as value from public.contents where id = ?::uuid`, [id]);

const asOwnerWithActor = async (actor: string, work: (transaction: Knex.Transaction) => Promise<unknown>): Promise<void> => {
  await w.getOwner().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    await work(transaction);
  });
};

const insertContent = (user: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('contents').insert({
    id, client_id: ids.clientA1, title: 'Lançamento', platform: 'instagram', format: 'reels', publish_on: '2026-10-20', folder_id: folderA1, ...extra
  })).then(() => id);
};

const updateContent = (user: string, id: string, patch: Record<string, unknown>): Promise<number> =>
  w.asUser(user, (transaction) => transaction('contents').where({ id }).update(patch));

const reelsReady = async (status: ContentStatus = 'in_production'): Promise<string> => {
  const id = await w.seedContent(ids.clientA1, { status });
  await w.attach(id, [await w.seedAsset(ids.clientA1, folderA1, { category: 'video' })]);
  return id;
};

describe('what ageniza_app may write on the three tables (issue #249)', () => {
  it('inserts the planning columns of a content, updates the editable ones, and deletes and truncates nothing', async () => {
    expect(await w.columnsWithPrivilege('contents', 'insert')).toEqual(
      ['caption', 'client_id', 'cover_asset_id', 'folder_id', 'format', 'id', 'owner_user_id', 'platform', 'publish_at_time', 'publish_on', 'title']
    );
    expect(await w.columnsWithPrivilege('contents', 'update')).toEqual(
      ['caption', 'cover_asset_id', 'folder_id', 'format', 'owner_user_id', 'publish_at_time', 'publish_on', 'title']
    );
    expect(await w.tablePrivileges('contents')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it('writes nothing on content_media, which only set_content_media changes', async () => {
    expect(await w.columnsWithPrivilege('content_media', 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege('content_media', 'update')).toEqual([]);
    expect(await w.tablePrivileges('content_media')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it('inserts the planning columns of a task, updates the editable ones, and deletes and truncates nothing', async () => {
    expect(await w.columnsWithPrivilege('content_tasks', 'insert')).toEqual(
      ['assignee_user_id', 'client_id', 'content_id', 'description', 'due_on', 'id', 'title']
    );
    expect(await w.columnsWithPrivilege('content_tasks', 'update')).toEqual(['assignee_user_id', 'description', 'due_on', 'title']);
    expect(await w.tablePrivileges('content_tasks')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it.each([
    ['contents', async () => ({ id: await w.seedContent(ids.clientA1) })],
    ['content_media', async () => {
      const contentId = await w.seedContent(ids.clientA1);
      await w.attach(contentId, [await w.seedAsset(ids.clientA1, folderA1)]);
      return { content_id: contentId };
    }],
    ['content_tasks', async () => ({ id: await w.seedTask(await w.seedContent(ids.clientA1)) })]
  ] as const)('refuses a DELETE on %s of a row the actor sees, even when a permissive DELETE policy is created by mistake', async (table, seed) => {
    const rowFilter = await seed();

    await expect(w.asUser(ids.adminA, async (transaction) => {
      expect(await transaction(table).where(rowFilter).select('*')).toHaveLength(1);
      return await transaction(table).where(rowFilter).delete();
    })).rejects.toMatchObject(deniedByGrant(table));

    const transaction = await w.getOwner().knex.transaction();
    try {
      await transaction.raw(`create policy zz_delete_by_mistake on public.${table} for delete to ageniza_app using (true)`);
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await expect(transaction(table).where(rowFilter).delete()).rejects.toMatchObject(deniedByGrant(table));
    } finally {
      await transaction.rollback();
    }

    expect(await w.getOwner().knex(table).where(rowFilter).select('*')).toHaveLength(1);
  });

  it('opens to ageniza_app only the functions the API calls, and none of them to PUBLIC', async () => {
    const callable = [
      'approve_content', 'approve_content_by_agency', 'approve_content_task', 'cancel_content', 'content_open_to_client',
      'deliver_content_task', 'media_asset_open_to_client', 'portal_contents', 'publish_content', 'reschedule_content',
      'return_content_task', 'sao_paulo_date', 'set_content_media', 'submit_content', 'unpublish_content'
    ];
    const internal = ['agency_user_can', 'content_media_is_complete', 'lock_content_for_agency', 'lock_content_task', 'contents_guard', 'content_tasks_guard'];
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; app: boolean; public_execute: boolean }> }>(`
      select p.proname as name,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app,
             has_function_privilege('public', p.oid, 'execute') as public_execute
      from pg_catalog.pg_proc p
      where p.pronamespace = 'app_private'::regnamespace and p.proname = any (?::text[])
      order by 1
    `, [[...callable, ...internal]]);

    expect(rows.map((row) => ({ ...row }))).toEqual(
      [...callable.map((name) => ({ name, app: true, public_execute: false })), ...internal.map((name) => ({ name, app: false, public_execute: false }))]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    );
  });
});

describe('who creates a content, and what the row may carry (issue #249)', () => {
  it.each([
    ['Admin', () => ids.adminA],
    ['Account manager', () => ids.managerA],
    ['Production', () => ids.productionA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s create a content in production, owned by the person who created it', async (_label, user) => {
    const id = await insertContent(user());

    expect(await w.contentRow(id)).toMatchObject({
      status: 'in_production', revision: 1, owner_user_id: user(), approved_by: null, approved_at: null,
      approved_by_agency_reason: null, published_on: null, published_at: null, cancelled_at: null
    });
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['a role with only conteudo.operar, because a write that cannot read its own row is blind', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('refuses %s a content, leaving no row', async (_label, user) => {
    const id = randomUUID();

    await expect(w.asUser(user(), (transaction) => transaction('contents').insert({
      id, client_id: ids.clientA1, title: 'Post', platform: 'instagram', format: 'image', publish_on: '2026-10-20', folder_id: folderA1, owner_user_id: ids.productionA
    }))).rejects.toMatchObject(rlsViolation);

    expect(await w.getOwner().knex('contents').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a content for a client of another agency, for an archived client and for a suspended agency', async () => {
    await w.archiveClient(ids.clientArchived);
    await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });
    try {
      const archivedFolder = await w.folderOf(ids.clientArchived);
      const suspendedFolder = await w.folderOf(ids.clientSuspended);
      await expect(insertContent(ids.adminA, { client_id: ids.clientB, folder_id: await w.folderOf(ids.clientB), owner_user_id: ids.adminB })).rejects.toMatchObject(rlsViolation);
      await expect(insertContent(ids.adminA, { client_id: ids.clientArchived, folder_id: archivedFolder })).rejects.toMatchObject(rlsViolation);
      await expect(insertContent(ids.adminSuspended, { client_id: ids.clientSuspended, folder_id: suspendedFolder, owner_user_id: ids.adminSuspended })).rejects.toBeDefined();
    } finally {
      await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
      await w.reactivateClient(ids.clientArchived);
    }

    expect(await w.getOwner().knex('contents').whereIn('client_id', [ids.clientB, ids.clientArchived, ids.clientSuspended]).select('id')).toHaveLength(0);
  });

  it.each([
    ['status', { status: 'approved' }],
    ['approved_by', { approved_by: ids.portalA1 }],
    ['approved_at', { approved_at: new Date() }],
    ['approved_by_agency_reason', { approved_by_agency_reason: 'combinado' }],
    ['published_on', { published_on: '2026-10-01' }],
    ['published_at', { published_at: new Date() }],
    ['cancelled_at', { cancelled_at: new Date() }],
    ['revision', { revision: 9 }],
    ['created_at', { created_at: new Date(0) }]
  ] as const)('refuses to let the caller choose %s on the INSERT, at the privilege layer', async (_label, extra) => {
    await expect(insertContent(ids.adminA, extra)).rejects.toMatchObject(deniedByGrant('contents'));
  });

  it.each([
    ['Sales, who cannot see Conteúdo', () => ids.salesA],
    ['a person of the portal', () => ids.portalA1],
    ['a person of another agency', () => ids.adminB]
  ] as const)('refuses %s as the person in charge on the INSERT', async (_label, owner) => {
    await expect(insertContent(ids.adminA, { owner_user_id: owner() })).rejects.toMatchObject({ code: 'A0073' });
  });

  it('refuses as the person in charge a collaborator whose link to the agency was removed, and one that does not exist', async () => {
    const removed = await w.personWith('conteudo.visualizar', 'conteudo.operar');
    await w.getOwner().knex('agency_memberships').where({ user_id: removed }).update({ status: 'removed' });

    await expect(insertContent(ids.adminA, { owner_user_id: removed })).rejects.toMatchObject({ code: 'A0073' });
    await expect(insertContent(ids.adminA, { owner_user_id: randomUUID() })).rejects.toMatchObject({ code: 'A0073' });
  });

  it.each([
    ['the Owner of the agency, who holds no membership', () => ids.ownerA],
    ['an Admin whose link to the client was removed, who is still a collaborator', () => ids.dualRemoved]
  ] as const)('accepts %s as the person in charge', async (_label, owner) => {
    const id = await insertContent(ids.adminA, { owner_user_id: owner() });

    expect((await w.contentRow(id)).owner_user_id).toBe(owner());
  });

  it.each([
    ['a platform that is not instagram', { platform: 'tiktok' }, 'contents_platform_format_check'],
    ['a format that does not exist', { format: 'story' }, 'contents_platform_format_check'],
    ['a title longer than 120 characters', { title: 'á'.repeat(121) }, 'contents_title_check'],
    ['a title that is only a no-break space', { title: String.fromCharCode(0xa0, 0x20) }, 'contents_title_check'],
    ['a caption longer than 2200 characters', { caption: 'ã'.repeat(2201) }, 'contents_caption_check']
  ] as const)('refuses %s', async (_label, extra, constraint) => {
    await expect(insertContent(ids.adminA, extra)).rejects.toMatchObject(check(constraint));
  });

  it('accepts a title of 120 characters and a caption of 2200, counted as characters and not as bytes', async () => {
    const id = await insertContent(ids.adminA, { title: 'á'.repeat(120), caption: 'ã'.repeat(2200) });

    expect((await w.contentRow(id)).caption).toHaveLength(2200);
  });

  it('refuses the folder of another client and a cover that is not an image of the folder of the content', async () => {
    const own = await w.seedAsset(ids.clientA1, folderA1, { category: 'video' });
    const elsewhere = await w.seedAsset(ids.clientA1, await w.folderOf(ids.clientA1, 'Imagens'));
    const removed = await w.seedAsset(ids.clientA1, folderA1, { removed: true });
    const otherClient = await w.seedAsset(ids.clientA2, folderA2);

    await expect(insertContent(ids.adminA, { folder_id: folderA2 })).rejects.toMatchObject(foreignKey('contents_folder_fk'));
    await expect(insertContent(ids.adminA, { cover_asset_id: elsewhere })).rejects.toMatchObject(foreignKey('contents_cover_fk'));
    await expect(insertContent(ids.adminA, { cover_asset_id: otherClient })).rejects.toMatchObject(foreignKey('contents_cover_fk'));
    await expect(insertContent(ids.adminA, { cover_asset_id: own })).rejects.toMatchObject({ code: 'A0069' });
    await expect(insertContent(ids.adminA, { cover_asset_id: removed })).rejects.toMatchObject({ code: 'A0069' });
    expect((await w.contentRow(await insertContent(ids.adminA, { cover_asset_id: await w.seedAsset(ids.clientA1, folderA1) }))).status).toBe('in_production');
  });
});

describe('editing a content: what keeps the approval and what annuls it (issue #249, acceptance 3)', () => {
  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const)('lets an operator move the date and change title, hour and owner of a content that is %s, without touching the approval', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const before = await w.contentRow(id);

    expect(await updateContent(ids.productionA, id, { title: 'Outro título', publish_on: '2026-11-02', publish_at_time: '18:30', owner_user_id: ids.managerA })).toBe(1);

    expect(await w.contentRow(id)).toMatchObject({
      status, revision: 1, title: 'Outro título', owner_user_id: ids.managerA, approved_by: before.approved_by, approved_at: before.approved_at
    });
    expect(await dayOf(id, 'publish_on')).toBe('2026-11-02');
  });

  it.each([
    ['caption', () => ({ caption: 'Legenda nova' })],
    ['format', () => ({ format: 'carousel' })],
    ['cover', async () => ({ cover_asset_id: await w.seedAsset(ids.clientA1, folderA1) })]
  ] as const)('returns an approved content to "awaiting approval" when its %s changes, clearing who approved and counting a revision', async (_label, patch) => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });

    expect(await updateContent(ids.productionA, id, await patch())).toBe(1);

    expect(await w.contentRow(id)).toMatchObject({
      status: 'awaiting_approval', revision: 2, approved_by: null, approved_at: null, approved_by_agency_reason: null
    });
  });

  it('clears the reason of an approval outside the platform when the caption of that content changes', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    await approveByAgencyAs(ids.managerA, id, 1, 'O cliente aprovou por mensagem');
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', approved_by: ids.managerA, approved_by_agency_reason: 'O cliente aprovou por mensagem' });

    await updateContent(ids.productionA, id, { caption: 'Mudou' });

    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null, approved_by_agency_reason: null });
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting'] as const)('counts a revision for a changed caption of a content that is %s, and keeps its state', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await updateContent(ids.productionA, id, { caption: 'Legenda nova' });
    await updateContent(ids.productionA, id, { title: 'Só o título' });

    expect(await w.contentRow(id)).toMatchObject({ status, revision: 2 });
  });

  it.each(['published', 'cancelled'] as const)('refuses every edit of a %s content, the date included', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const before = await w.contentRow(id);

    for (const patch of [
      { title: 'x' }, { publish_on: '2026-12-01' }, { publish_at_time: '10:00' }, { caption: 'x' }, { format: 'image' },
      { owner_user_id: ids.managerA }, { folder_id: await w.folderOf(ids.clientA1, 'Imagens') }
    ]) {
      await expect(updateContent(ids.productionA, id, patch), JSON.stringify(patch)).rejects.toMatchObject({ code: 'A0062' });
    }

    expect(await w.contentRow(id)).toEqual(before);
  });

  it.each([
    ['status', { status: 'approved' }],
    ['approved_by', { approved_by: ids.adminA }],
    ['approved_at', { approved_at: new Date() }],
    ['approved_by_agency_reason', { approved_by_agency_reason: 'x' }],
    ['published_on', { published_on: '2026-10-01' }],
    ['published_at', { published_at: new Date() }],
    ['cancelled_at', { cancelled_at: new Date() }],
    ['revision', { revision: 7 }],
    ['client_id', { client_id: ids.clientA2 }],
    ['platform', { platform: 'instagram' }],
    ['id', { id: randomUUID() }],
    ['created_at', { created_at: new Date(0) }]
  ] as const)('refuses an UPDATE of %s at the privilege layer, to an Admin who sees the row', async (_label, patch) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const before = await w.contentRow(id);

    await expect(w.asUser(ids.adminA, async (transaction) => {
      expect(await transaction('contents').where({ id }).select('id')).toHaveLength(1);
      return await transaction('contents').where({ id }).update(patch);
    })).rejects.toMatchObject(deniedByGrant('contents'));

    expect(await w.contentRow(id)).toEqual(before);
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare]
  ] as const)('changes nothing of a content for %s: the UPDATE reaches no row', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const before = await w.contentRow(id);

    expect(await updateContent(user(), id, { title: 'Invadido' })).toBe(0);

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('refuses the edit of a content of an archived client, loudly, and still lets the operator lock the row', async () => {
    const id = await w.seedContent(ids.clientArchived);
    await w.archiveClient(ids.clientArchived);
    const before = await w.contentRow(id);

    try {
      await expect(updateContent(ids.adminA, id, { title: 'Novo' })).rejects.toMatchObject(rlsViolation);
      const locked = await w.asUser(ids.adminA, (transaction) => transaction.raw<{ rows: unknown[] }>('select id from public.contents where id = ?::uuid for update', [id]));
      expect(locked.rows).toHaveLength(1);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('refuses a new person in charge who cannot see Conteúdo, leaving the owner as it was', async () => {
    const id = await w.seedContent(ids.clientA1);

    await expect(updateContent(ids.adminA, id, { owner_user_id: ids.salesA })).rejects.toMatchObject({ code: 'A0073' });
    expect((await w.contentRow(id)).owner_user_id).toBe(ids.productionA);
  });

  it('refuses to move the folder of a content that has media or a cover, and moves it otherwise', async () => {
    const withMedia = await reelsReady();
    const free = await w.seedContent(ids.clientA1);
    const images = await w.folderOf(ids.clientA1, 'Imagens');

    await expect(updateContent(ids.adminA, withMedia, { folder_id: images })).rejects.toMatchObject(foreignKey('content_media_content_fk'));
    expect(await updateContent(ids.adminA, free, { folder_id: images })).toBe(1);
    expect((await w.contentRow(free)).folder_id).toBe(images);
  });

  it('replaces a cover only by an image of the folder of the content', async () => {
    const id = await w.seedContent(ids.clientA1);

    await expect(updateContent(ids.adminA, id, { cover_asset_id: await w.seedAsset(ids.clientA1, folderA1, { category: 'video' }) })).rejects.toMatchObject({ code: 'A0069' });
    await expect(updateContent(ids.adminA, id, { cover_asset_id: await w.seedAsset(ids.clientA2, folderA2) })).rejects.toMatchObject(foreignKey('contents_cover_fk'));
    expect(await updateContent(ids.adminA, id, { cover_asset_id: await w.seedAsset(ids.clientA1, folderA1) })).toBe(1);
  });
});

describe('the trigger holds the transitions of §4 for every writer (issue #249, acceptance 1)', () => {
  const forbidden: Array<[ContentStatus, ContentStatus]> = [
    ['in_production', 'adjusting'], ['in_production', 'approved'], ['in_production', 'published'],
    ['awaiting_approval', 'in_production'], ['awaiting_approval', 'published'],
    ['adjusting', 'in_production'], ['adjusting', 'approved'], ['adjusting', 'published'],
    ['approved', 'in_production'], ['approved', 'adjusting'],
    ['published', 'in_production'], ['published', 'awaiting_approval'], ['published', 'adjusting'], ['published', 'cancelled'],
    ['cancelled', 'awaiting_approval'], ['cancelled', 'adjusting'], ['cancelled', 'approved'], ['cancelled', 'published']
  ];

  it.each(forbidden)('refuses %s -> %s, even to the schema owner with an actor bound, and leaves the row as it was', async (from, to) => {
    const id = await w.seedContent(ids.clientA1, { status: from });
    const before = await w.contentRow(id);

    await expect(asOwnerWithActor(ids.adminA, (transaction) => transaction('contents').where({ id }).update({ status: to })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('life cycle') });

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('refuses a change of state that carries a change of caption, title, owner or folder, and lets only a reschedule carry the date', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'in_production' });
    const cancelled = await w.seedContent(ids.clientA1, { status: 'cancelled' });

    for (const patch of [{ caption: 'x' }, { title: 'x' }, { publish_on: '2026-12-31' }, { owner_user_id: ids.managerA }]) {
      await expect(asOwnerWithActor(ids.adminA, (transaction) => transaction('contents').where({ id }).update({ status: 'awaiting_approval', ...patch })), JSON.stringify(patch))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('no other change') });
    }
    await asOwnerWithActor(ids.adminA, (transaction) => transaction('contents').where({ id: cancelled }).update({ status: 'in_production', publish_on: '2026-12-31' }));

    expect(await w.contentRow(id)).toMatchObject({ status: 'in_production', revision: 1 });
    expect(await dayOf(cancelled, 'publish_on')).toBe('2026-12-31');
  });

  it('stamps who approved and when from the actor and the clock, whatever the statement names', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await asOwnerWithActor(ids.portalA1, (transaction) => transaction('contents').where({ id }).update({
      status: 'approved', approved_by: ids.adminA, approved_at: new Date('2000-01-01T00:00:00.000Z')
    }));

    const row = await w.contentRow(id);
    expect(row.approved_by).toBe(ids.portalA1);
    expect(Math.abs((row.approved_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('does not approve without an actor: nobody is approved by "no one"', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const before = await w.contentRow(id);

    await expect(w.getOwner().knex('contents').where({ id }).update({ status: 'approved' }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('approved by a person') });

    expect(await w.contentRow(id)).toEqual(before);
  });

  it.each([
    ['approved_by', { approved_by: ids.adminA }],
    ['published_at', { published_at: new Date(0) }],
    ['cancelled_at', { cancelled_at: new Date(0) }],
    ['the reason of the approval', { approved_by_agency_reason: 'x' }]
  ] as const)('refuses to rewrite %s without a change of state', async (_label, patch) => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });
    const before = await w.contentRow(id);

    await expect(asOwnerWithActor(ids.adminA, (transaction) => transaction('contents').where({ id }).update(patch)))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('is written with the state') });

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('never changes the identity of a content, for any writer', async () => {
    const id = await w.seedContent(ids.clientA1);

    await expect(w.getOwner().knex('contents').where({ id }).update({ client_id: ids.clientA2, folder_id: folderA2 }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('identity') });
    await expect(w.getOwner().knex('contents').where({ id }).update({ platform: 'instagram', created_at: new Date(0) }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('identity') });
  });
});

interface Guarded {
  readonly name: string;
  readonly permission: string;
  readonly prepare: () => Promise<string>;
  readonly invoke: (user: string, id: string) => Promise<unknown>;
  readonly status: ContentStatus;
}

const guarded: readonly Guarded[] = [
  { name: 'submit_content', permission: 'conteudo.operar', prepare: () => reelsReady(), invoke: submitAs, status: 'awaiting_approval' },
  { name: 'approve_content_by_agency', permission: 'conteudo.aprovar_pela_agencia', prepare: () => w.seedContent(ids.clientA1, { status: 'awaiting_approval' }), invoke: (user, id) => approveByAgencyAs(user, id, 1, 'Aprovado fora'), status: 'approved' },
  { name: 'publish_content', permission: 'conteudo.publicar', prepare: () => w.seedContent(ids.clientA1, { status: 'approved' }), invoke: async (user, id) => publishAs(user, id, await today()), status: 'published' },
  { name: 'unpublish_content', permission: 'conteudo.publicar', prepare: () => w.seedContent(ids.clientA1, { status: 'published' }), invoke: unpublishAs, status: 'approved' },
  { name: 'cancel_content', permission: 'conteudo.cancelar', prepare: () => w.seedContent(ids.clientA1, { status: 'in_production' }), invoke: cancelAs, status: 'cancelled' },
  { name: 'reschedule_content', permission: 'conteudo.operar', prepare: () => w.seedContent(ids.clientA1, { status: 'cancelled' }), invoke: (user, id) => rescheduleAs(user, id), status: 'in_production' },
  { name: 'set_content_media', permission: 'conteudo.operar', prepare: () => w.seedContent(ids.clientA1), invoke: async (user, id) => setMediaAs(user, id, [await w.seedAsset(ids.clientA1, folderA1)]), status: 'in_production' }
];

describe.each(guarded)('$name: who may call it (issue #249)', ({ permission, prepare, invoke, status }) => {
  it.each([
    ['the Owner of the agency, by ownership', async () => ids.ownerA],
    ['the Admin', async () => ids.adminA],
    ['a role with only this permission and conteudo.visualizar', () => w.personWith(permission, 'conteudo.visualizar')]
  ] as const)('lets %s call it', async (_label, user) => {
    const id = await prepare();

    await invoke(await user(), id);

    expect((await w.contentRow(id)).status).toBe(status);
  });

  it.each([
    ['Sales', async () => ids.salesA],
    ['Finance', async () => ids.financeA],
    ['the Admin of another agency', async () => ids.adminB],
    ['a person of the portal of the client', async () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', async () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', async () => ids.crossDual],
    ['a role with every conteudo.* permission but this one', () => w.personWithAllBut(permission)],
    ['a role with only this permission, which cannot read the content it would change', () => w.personWith(permission)]
  ] as const)('answers "not found" to %s, leaving the content as it was', async (_label, user) => {
    const id = await prepare();
    const before = await w.contentRow(id);

    await expect(invoke(await user(), id)).rejects.toMatchObject(NOT_FOUND);

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('answers a content that does not exist exactly like a content the caller may not touch, so it is no existence oracle', async () => {
    const foreign = await w.seedContent(ids.clientB, { status: 'in_production', folderId: await w.folderOf(ids.clientB), owner: ids.adminB });

    const unknown = await invoke(ids.adminA, randomUUID()).catch((error: unknown) => error);
    const other = await invoke(ids.adminA, foreign).catch((error: unknown) => error);

    expect(unknown).toMatchObject(NOT_FOUND);
    expect(other).toMatchObject(NOT_FOUND);
    expect((other as { message: string }).message).toBe((unknown as { message: string }).message);
  });

  it('refuses it, loudly, for a content of an archived client, which is read-only for the agency', async () => {
    const id = await prepare();
    const before = await w.contentRow(id);
    await w.archiveClient(ids.clientA1);

    try {
      await expect(invoke(ids.adminA, id)).rejects.toMatchObject({ code: 'A0061' });
    } finally {
      await w.reactivateClient(ids.clientA1);
    }

    expect(await w.contentRow(id)).toEqual(before);
  });
});

describe('submit: in production or in adjustment to awaiting approval (issue #249, acceptance 2)', () => {
  it.each([
    ['image', 'image', ['image'], true],
    ['image', 'image', ['video'], false],
    ['image', 'image', ['image', 'image'], false],
    ['carousel', 'carousel', ['image', 'video'], true],
    ['carousel', 'carousel', ['image'], false],
    ['reels', 'reels', ['video'], true],
    ['reels', 'reels', ['image'], false],
    ['long_video', 'long_video', ['video'], true],
    ['vsl', 'vsl', ['video'], true],
    ['vsl', 'vsl', ['video', 'video'], false],
    ['reels', 'reels', [], false]
  ] as const)('%s: media of %j is %s', async (_label, format, categories, accepted) => {
    const id = await w.seedContent(ids.clientA1, { format });
    await w.attach(id, await Promise.all(categories.map((category) => w.seedAsset(ids.clientA1, folderA1, { category }))));

    const attempt = submitAs(ids.productionA, id);

    if (accepted) {
      await attempt;
      expect((await w.contentRow(id)).status).toBe('awaiting_approval');
    } else {
      await expect(attempt).rejects.toMatchObject({ code: 'A0065' });
      expect((await w.contentRow(id)).status).toBe('in_production');
    }
  });

  it('accepts a carousel of 20 items and refuses one of 21 at the media selection', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'carousel' });
    const assets = await Promise.all(Array.from({ length: 21 }, () => w.seedAsset(ids.clientA1, folderA1)));

    await setMediaAs(ids.productionA, id, assets.slice(0, 20));
    await submitAs(ids.productionA, id);
    expect((await w.contentRow(id)).status).toBe('awaiting_approval');

    const other = await w.seedContent(ids.clientA1, { format: 'carousel' });
    await expect(setMediaAs(ids.productionA, other, assets)).rejects.toMatchObject({ code: 'A0069' });
  });

  it.each([
    ['not confirmed yet', { status: 'pending' as const }],
    ['removed', { removed: true }]
  ] as const)('refuses to send a content whose only media is %s', async (_label, extra) => {
    const id = await w.seedContent(ids.clientA1, { format: 'image' });
    await w.attach(id, [await w.seedAsset(ids.clientA1, folderA1, extra)]);

    await expect(submitAs(ids.productionA, id)).rejects.toMatchObject({ code: 'A0065' });
    expect((await w.contentRow(id)).status).toBe('in_production');
  });

  it.each(['pending', 'delivered'] as const)('refuses to send a content with a %s subtask, and sends it when every subtask is approved', async (status) => {
    const id = await reelsReady();
    const task = await w.seedTask(id, { status });

    await expect(submitAs(ids.productionA, id)).rejects.toMatchObject({ code: 'A0066' });
    expect((await w.contentRow(id)).status).toBe('in_production');

    for (const next of status === 'pending' ? ['delivered', 'approved'] : ['approved']) {
      await w.getOwner().knex('content_tasks').where({ id: task }).update({ status: next });
    }
    await submitAs(ids.productionA, id);

    expect((await w.contentRow(id)).status).toBe('awaiting_approval');
  });

  it('sends again a content that was in adjustment, and is idempotent for one already waiting', async () => {
    const adjusting = await reelsReady('adjusting');
    const waiting = await reelsReady('awaiting_approval');
    const before = await w.contentRow(waiting);

    await submitAs(ids.productionA, adjusting);
    await submitAs(ids.productionA, waiting);

    expect((await w.contentRow(adjusting)).status).toBe('awaiting_approval');
    expect(await w.contentRow(waiting)).toEqual(before);
  });

  it.each(['approved', 'published', 'cancelled'] as const)('does not send a content that is %s', async (status) => {
    const id = await reelsReady(status);
    const before = await w.contentRow(id);

    await expect(submitAs(ids.productionA, id)).rejects.toMatchObject({ code: 'A0062' });

    expect(await w.contentRow(id)).toEqual(before);
  });
});

describe('approve: awaiting approval to approved, by an active person of the portal (issue #249)', () => {
  it.each([
    ['a person of the portal of the client', () => ids.portalA1],
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a collaborator with a link to the client and a role without conteudo.*, who is an active person of the portal', () => ids.dualBare],
    ['a collaborator with the Production role and a link to the client', () => ids.dualFull],
    ['an Admin of another agency who holds a link to this client', () => ids.crossDual]
  ] as const)('lets %s approve, and fixes who approved and when in the database', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const before = await w.contentRow(id);

    await approveAs(user(), id, 1);

    const after = await w.contentRow(id);
    expect(after).toEqual({ ...before, status: 'approved', approved_by: user(), approved_at: after.approved_at });
    expect(Math.abs((after.approved_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it.each([
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['an Admin of the agency, who holds every permission but has no link to the client', () => ids.adminA],
    ['the Owner of the agency, who has no link to the client', () => ids.ownerA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('answers "not found" to %s, leaving the content waiting', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const before = await w.contentRow(id);

    await expect(approveAs(user(), id, 1)).rejects.toMatchObject(NOT_FOUND);

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('keeps the first person who approved: a second person, or the same one again, changes nothing', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    await approveAs(ids.portalA1, id, 1);
    const once = await w.contentRow(id);

    await approveAs(ids.portalA1Second, id, 1);
    await approveAs(ids.portalA1, id, 99);

    expect(await w.contentRow(id)).toEqual(once);
  });

  it('refuses a revision that is not the one the person saw, so a caption edited since is not approved unseen', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    await updateContent(ids.productionA, id, { caption: 'Legenda corrigida' });

    await expect(approveAs(ids.portalA1, id, 1)).rejects.toMatchObject({ code: 'A0063' });
    expect((await w.contentRow(id)).status).toBe('awaiting_approval');

    await approveAs(ids.portalA1, id, 2);
    expect((await w.contentRow(id)).status).toBe('approved');
  });

  it('does not tell the portal that a content in production or a cancelled one exists, and tells the collaborator who reads it the truth', async () => {
    const hidden = [await w.seedContent(ids.clientA1, { status: 'in_production' }), await w.seedContent(ids.clientA1, { status: 'cancelled' })];

    for (const id of hidden) {
      const before = await w.contentRow(id);
      for (const user of [ids.portalA1, ids.dualBare]) {
        const forContent = await approveAs(user, id, 1).catch((error: unknown) => error);
        const forUnknown = await approveAs(user, randomUUID(), 1).catch((error: unknown) => error);
        expect(forContent, String(user)).toMatchObject(NOT_FOUND);
        expect((forContent as { message: string }).message).toBe((forUnknown as { message: string }).message);
      }
      await expect(approveAs(ids.dualFull, id, 1)).rejects.toMatchObject({ code: 'A0062' });
      expect(await w.contentRow(id)).toEqual(before);
    }
  });

  it.each(['adjusting', 'published'] as const)('does not approve a content that is %s', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const before = await w.contentRow(id);

    await expect(approveAs(ids.portalA1, id, 1)).rejects.toMatchObject({ code: 'A0062' });

    expect(await w.contentRow(id)).toEqual(before);
  });

  it('does not approve for a client that is archived, or for an agency that is suspended', async () => {
    const archived = await w.seedContent(ids.clientArchived, { status: 'awaiting_approval' });
    const suspended = await w.seedContent(ids.clientSuspended, { status: 'awaiting_approval', folderId: await w.folderOf(ids.clientSuspended), owner: ids.adminSuspended });
    await w.archiveClient(ids.clientArchived);
    await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });

    try {
      await expect(approveAs(ids.portalArchived, archived, 1)).rejects.toMatchObject(NOT_FOUND);
      await expect(approveAs(ids.portalSuspended, suspended, 1)).rejects.toMatchObject(NOT_FOUND);
    } finally {
      await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
      await w.reactivateClient(ids.clientArchived);
    }

    expect((await w.contentRow(archived)).status).toBe('awaiting_approval');
    expect((await w.contentRow(suspended)).status).toBe('awaiting_approval');
  });

  it('waits for an edit that holds the row, then refuses the revision the person saw', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const editor = await w.openTransactionAs(ids.productionA);
    let approving: Promise<unknown> | undefined;

    try {
      await editor('contents').where({ id }).update({ caption: 'Legenda nova' });
      approving = approveAs(ids.portalA1, id, 1).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await editor.commit();
    }

    expect(await approving).toMatchObject({ code: 'A0063' });
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', revision: 2, approved_by: null });
  });
});

describe('approve by the agency, outside the platform (issue #249)', () => {
  it('records the reason and who approved, from the actor', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await approveByAgencyAs(ids.managerA, id, 1, 'O cliente aprovou por telefone');

    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', approved_by: ids.managerA, approved_by_agency_reason: 'O cliente aprovou por telefone' });
  });

  it.each([
    ['null', null], ['empty', ''], ['spaces', '   '], ['a no-break space', String.fromCharCode(0xa0)],
    ['an ideographic space', String.fromCharCode(0x3000)], ['more than 5000 bytes', 'a'.repeat(5001)]
  ] as const)('refuses a reason that is %s, leaving the content waiting', async (_label, reason) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await expect(approveByAgencyAs(ids.managerA, id, 1, reason)).rejects.toMatchObject({ code: 'A0068' });

    expect((await w.contentRow(id)).status).toBe('awaiting_approval');
  });

  it('refuses a stale revision, is idempotent for an approved content and refuses one in production', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const production = await w.seedContent(ids.clientA1, { status: 'in_production' });

    await expect(approveByAgencyAs(ids.managerA, id, 5, 'x')).rejects.toMatchObject({ code: 'A0063' });
    await approveByAgencyAs(ids.managerA, id, 1, 'primeiro');
    await approveByAgencyAs(ids.adminA, id, 1, 'segundo');
    await expect(approveByAgencyAs(ids.managerA, production, 1, 'x')).rejects.toMatchObject({ code: 'A0062' });

    expect(await w.contentRow(id)).toMatchObject({ approved_by: ids.managerA, approved_by_agency_reason: 'primeiro' });
  });
});

describe('publish and undo: the day rules, in America/Sao_Paulo (issue #249, acceptance 4)', () => {
  it('lets an approved content be published today or on a day before, and fixes the instant of the publication', async () => {
    const [onToday, onYesterday] = [await w.seedContent(ids.clientA1, { status: 'approved' }), await w.seedContent(ids.clientA1, { status: 'approved' })];

    await publishAs(ids.productionA, onToday, await today());
    await publishAs(ids.productionA, onYesterday, await daysFromToday(-1));

    const row = await w.contentRow(onToday);
    expect(row).toMatchObject({ status: 'published', approved_by: ids.portalA1 });
    expect(Math.abs((row.published_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
    expect(await dayOf(onToday, 'published_on')).toBe(await today());
    expect(await dayOf(onYesterday, 'published_on')).toBe(await daysFromToday(-1));
  });

  it.each([
    ['tomorrow', () => daysFromToday(1)],
    ['a year ahead', () => daysFromToday(365)],
    ['no date at all', async () => null]
  ] as const)('refuses to publish with %s as the real date', async (_label, day) => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });

    await expect(publishAs(ids.productionA, id, await day())).rejects.toMatchObject({ code: 'A0067' });

    expect((await w.contentRow(id)).status).toBe('approved');
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'cancelled'] as const)('does not publish a content that is %s, and publishing again a published one changes nothing', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const published = await w.seedContent(ids.clientA1, { status: 'published' });
    const before = await w.contentRow(published);

    await expect(publishAs(ids.productionA, id, await today())).rejects.toMatchObject({ code: 'A0062' });
    await publishAs(ids.productionA, published, await daysFromToday(-3));

    expect(await w.contentRow(published)).toEqual(before);
  });

  it('computes the day in America/Sao_Paulo, at fixed instants around its midnight', async () => {
    const dayAt = (instant: string) => sqlText('select app_private.sao_paulo_date(?::timestamptz)::text as value', [instant]);

    expect(await dayAt('2026-10-07T02:59:59.999Z')).toBe('2026-10-06');
    expect(await dayAt('2026-10-07T03:00:00.000Z')).toBe('2026-10-07');
    expect(await dayAt('2026-10-08T02:59:59.999Z')).toBe('2026-10-07');
    expect(await dayAt('2026-10-08T02:30:00.000Z')).toBe('2026-10-07');
    expect(await dayAt('2026-10-08T03:00:00.000Z')).toBe('2026-10-08');
  });

  it('asks the day of the database from that function only, never from the clock of the server zone', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; source: string }> }>(`
      select p.proname as name, pg_get_functiondef(p.oid) as source
      from pg_catalog.pg_proc p
      where p.pronamespace = 'app_private'::regnamespace and p.proname in ('contents_guard', 'publish_content', 'unpublish_content')
    `);

    expect(rows.map((row) => row.name).sort()).toEqual(['contents_guard', 'publish_content', 'unpublish_content']);
    for (const row of rows) {
      expect(row.source, row.name).not.toMatch(/time zone|current_date|localtimestamp|::date/i);
    }
    expect(rows.find((row) => row.name === 'contents_guard')?.source).toContain('app_private.sao_paulo_date(pg_catalog.now())');
  });

  it('undoes a publication made today, restoring "approved" with its approval and no publication', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });
    await publishAs(ids.productionA, id, await today());
    const published = await w.contentRow(id);

    await unpublishAs(ids.productionA, id);

    expect(await w.contentRow(id)).toMatchObject({
      status: 'approved', approved_by: published.approved_by, approved_at: published.approved_at, published_on: null, published_at: null
    });
  });

  it('refuses to undo a publication of another day, and allows the first and the last instant of today', async () => {
    const epoch = await sqlText("select extract(epoch from ((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')::text as value");
    const startOfToday = new Date(Number(epoch) * 1000);
    const justBefore = new Date(startOfToday.getTime() - 1);
    const lastInstant = new Date(startOfToday.getTime() + 86_400_000 - 1);
    const make = (publishedAt: Date) => w.seedContent(ids.clientA1, { status: 'published', publishedAt });

    const [yesterday, oldOne, first, last] = [await make(justBefore), await make(new Date(Date.now() - 3 * 86_400_000)), await make(startOfToday), await make(lastInstant)];

    await expect(unpublishAs(ids.productionA, yesterday)).rejects.toMatchObject({ code: 'A0064' });
    await expect(unpublishAs(ids.productionA, oldOne)).rejects.toMatchObject({ code: 'A0064' });
    await unpublishAs(ids.productionA, first);
    await unpublishAs(ids.productionA, last);

    expect((await w.contentRow(yesterday)).status).toBe('published');
    expect((await w.contentRow(oldOne)).status).toBe('published');
    expect((await w.contentRow(first)).status).toBe('approved');
    expect((await w.contentRow(last)).status).toBe('approved');
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'cancelled'] as const)('does not undo a publication of a content that is %s', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await expect(unpublishAs(ids.productionA, id)).rejects.toMatchObject({ code: 'A0062' });
  });

  it('is idempotent: undoing a publication already undone changes nothing', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });
    const before = await w.contentRow(id);

    await unpublishAs(ids.productionA, id);

    expect(await w.contentRow(id)).toEqual(before);
  });
});

describe('cancel and reschedule (issue #249)', () => {
  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const)('cancels a %s content, stamps the instant and clears any approval, keeping the row', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await cancelAs(ids.managerA, id);

    const row = await w.contentRow(id);
    expect(row).toMatchObject({ status: 'cancelled', approved_by: null, approved_at: null });
    expect(Math.abs((row.cancelled_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('does not cancel a published content, and cancelling a cancelled one changes nothing', async () => {
    const published = await w.seedContent(ids.clientA1, { status: 'published' });
    const cancelled = await w.seedContent(ids.clientA1, { status: 'cancelled' });
    const before = await w.contentRow(cancelled);

    await expect(cancelAs(ids.managerA, published)).rejects.toMatchObject({ code: 'A0062' });
    await cancelAs(ids.managerA, cancelled);

    expect((await w.contentRow(published)).status).toBe('published');
    expect(await w.contentRow(cancelled)).toEqual(before);
  });

  it('reschedules a cancelled content back to production, with a new date or the old one, and no cancellation or approval left', async () => {
    const [withDate, withoutDate] = [await w.seedContent(ids.clientA1, { status: 'cancelled' }), await w.seedContent(ids.clientA1, { status: 'cancelled', publishOn: '2026-10-22' })];

    await rescheduleAs(ids.productionA, withDate, '2026-12-01');
    await rescheduleAs(ids.productionA, withoutDate);

    expect(await w.contentRow(withDate)).toMatchObject({ status: 'in_production', cancelled_at: null, approved_by: null });
    expect(await dayOf(withDate, 'publish_on')).toBe('2026-12-01');
    expect(await dayOf(withoutDate, 'publish_on')).toBe('2026-10-22');
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published'] as const)('does not reschedule a content that is %s', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await expect(rescheduleAs(ids.productionA, id, '2026-12-01')).rejects.toMatchObject({ code: 'A0062' });
  });
});

describe('the media of a content (issue #249: a content selects only media of its own folder)', () => {
  const orderOf = async (id: string): Promise<string[]> =>
    (await w.getOwner().knex('content_media').where({ content_id: id }).orderBy('position').select('asset_id')).map((row) => row.asset_id as string);

  it('replaces the whole ordered list: adds, reorders and takes media out, without a DELETE for the application', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'carousel' });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => w.seedAsset(ids.clientA1, folderA1)));

    await setMediaAs(ids.productionA, id, [a, b, c]);
    expect(await orderOf(id)).toEqual([a, b, c]);
    await setMediaAs(ids.productionA, id, [c, a]);
    expect(await orderOf(id)).toEqual([c, a]);
    await setMediaAs(ids.productionA, id, []);
    expect(await orderOf(id)).toEqual([]);
  });

  it('counts a revision for a change and none for the same list again', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'image' });
    const asset = await w.seedAsset(ids.clientA1, folderA1);

    await setMediaAs(ids.productionA, id, [asset]);
    await setMediaAs(ids.productionA, id, [asset]);

    expect((await w.contentRow(id)).revision).toBe(2);
  });

  it('returns an approved content to "awaiting approval" when its media changes, clearing the approval', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved', format: 'image' });

    await setMediaAs(ids.productionA, id, [await w.seedAsset(ids.clientA1, folderA1)]);

    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null, approved_at: null, revision: 2 });
  });

  it.each([
    ['of another folder of the same client', async () => w.seedAsset(ids.clientA1, await w.folderOf(ids.clientA1, 'Imagens'))],
    ['of another client of the same agency', () => w.seedAsset(ids.clientA2, folderA2)],
    ['of a client of another agency', async () => w.seedAsset(ids.clientB, await w.folderOf(ids.clientB))],
    ['removed', () => w.seedAsset(ids.clientA1, folderA1, { removed: true })],
    ['that does not exist', async () => randomUUID()]
  ] as const)('refuses a media %s, leaving the list as it was', async (_label, asset) => {
    const id = await w.seedContent(ids.clientA1, { format: 'carousel' });
    const own = await w.seedAsset(ids.clientA1, folderA1);
    await setMediaAs(ids.productionA, id, [own]);

    await expect(setMediaAs(ids.productionA, id, [own, await asset()])).rejects.toMatchObject({ code: 'A0069' });

    expect(await orderOf(id)).toEqual([own]);
  });

  it('refuses the same media twice, a null in the list, no list, and more than one media for a content that is not a carousel', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'reels' });
    const [a, b] = await Promise.all([1, 2].map(() => w.seedAsset(ids.clientA1, folderA1, { category: 'video' })));

    await expect(setMediaAs(ids.productionA, id, [a, a])).rejects.toMatchObject({ code: 'A0069' });
    await expect(setMediaAs(ids.productionA, id, [a, b])).rejects.toMatchObject({ code: 'A0069' });
    await expect(fn(ids.productionA, 'set_content_media(?::uuid, ?::uuid[])', id, null)).rejects.toMatchObject({ code: 'A0069' });
    await expect(fn(ids.productionA, "set_content_media(?::uuid, array[?::uuid, null])", id, a)).rejects.toMatchObject({ code: 'A0069' });
    expect(await orderOf(id)).toEqual([]);
  });

  it.each(['published', 'cancelled'] as const)('does not change the media of a %s content', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await expect(setMediaAs(ids.productionA, id, [await w.seedAsset(ids.clientA1, folderA1)])).rejects.toMatchObject({ code: 'A0062' });
  });

  it('refuses the media of a content of an archived client, and leaves it as it was', async () => {
    const id = await w.seedContent(ids.clientArchived);
    const asset = await w.seedAsset(ids.clientArchived, await w.folderOf(ids.clientArchived));
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(setMediaAs(ids.adminA, id, [asset])).rejects.toMatchObject({ code: 'A0061' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await orderOf(id)).toEqual([]);
  });

  it('holds the folder of the media by foreign keys too, for a writer that does not go through the function', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'carousel' });
    const elsewhere = await w.seedAsset(ids.clientA1, await w.folderOf(ids.clientA1, 'Imagens'));
    const otherClient = await w.seedAsset(ids.clientA2, folderA2);

    for (const asset of [elsewhere, otherClient]) {
      await expect(w.getOwner().knex('content_media').insert({ content_id: id, asset_id: asset, client_id: ids.clientA1, folder_id: folderA1, position: 1 }))
        .rejects.toMatchObject(foreignKey('content_media_asset_fk'));
    }
    const images = await w.folderOf(ids.clientA1, 'Imagens');
    await expect(w.getOwner().knex('content_media').insert({ content_id: id, asset_id: await w.seedAsset(ids.clientA1, images), client_id: ids.clientA1, folder_id: images, position: 1 }))
      .rejects.toMatchObject(foreignKey('content_media_content_fk'));
  });

  it('refuses two media at the same position and a position outside 1 to 20', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'carousel' });
    const [a, b] = await Promise.all([1, 2].map(() => w.seedAsset(ids.clientA1, folderA1)));
    await w.attach(id, [a]);

    await expect(w.getOwner().knex('content_media').insert({ content_id: id, asset_id: b, client_id: ids.clientA1, folder_id: folderA1, position: 1 }))
      .rejects.toMatchObject({ code: '23505', constraint: 'content_media_position_key' });
    await expect(w.getOwner().knex('content_media').insert({ content_id: id, asset_id: b, client_id: ids.clientA1, folder_id: folderA1, position: 21 }))
      .rejects.toMatchObject(check('content_media_position_check'));
  });

  it('does not let the application write the list directly, even an Admin who sees it', async () => {
    const id = await w.seedContent(ids.clientA1, { format: 'image' });
    const asset = await w.seedAsset(ids.clientA1, folderA1);

    await expect(w.asUser(ids.adminA, (transaction) => transaction('content_media').insert({ content_id: id, asset_id: asset, client_id: ids.clientA1, folder_id: folderA1, position: 1 })))
      .rejects.toMatchObject(deniedByGrant('content_media'));
  });
});

describe('a content cannot be sent while a task slips in (issue #249, concurrency)', () => {
  it('waits for the transaction that adds a pending task, then refuses to send', async () => {
    const id = await reelsReady();
    const editor = await w.openTransactionAs(ids.productionA);
    let sending: Promise<unknown> | undefined;

    try {
      await editor('content_tasks').insert({ content_id: id, client_id: ids.clientA1, title: 'Nova', assignee_user_id: ids.productionA, due_on: '2026-10-30' });
      sending = submitAs(ids.productionA, id).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await editor.commit();
    }

    expect(await sending).toMatchObject({ code: 'A0066' });
    expect((await w.contentRow(id)).status).toBe('in_production');
  });
});
