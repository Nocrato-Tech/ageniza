import { backendPid, raw, requestLockOnceBlocked, waitForBackendsBlockedBy } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentsWorld, type Reply } from './test-support/world.js';

// Issue #254 and its two review requirements (#384, #386): a content written while the client is being archived is
// answered 409 CLIENT_ARCHIVED, with nothing written, never 500. The race has TWO windows and each is sequenced by a
// lock or by the statement, never by a sleep:
//  - the archive is in course (uncommitted): the route passes its policy on the snapshot where the client is still
//    active and waits on the trigger of 20261007001400 until the archive commits, which raises A0020;
//  - the archive committed after the route checked the client and before its INSERT/UPDATE ran: the policy of the
//    table refuses the row (42501), and the route reads the client again, after the locks, to tell it from a lost
//    permission (403).
const w = createContentsWorld('contents-race');
const { people } = w;

const NO_DATABASE_DETAIL = /A0020|A0061|deadlock|40P01|42501|pg_|relation|process/i;

/** Window 1: the route starts while the archive is uncommitted, waits on the client, and is answered after it commits. */
const archiveWhileRouteWaits = async (clientId: string, start: () => Promise<Reply>): Promise<Reply> => {
  const holder = await w.getOwner().knex.transaction();
  let released = false;
  try {
    const locked = await raw<{ rows: Array<{ id: string }> }>(holder, "update public.clients set status = 'archived', archived_at = now() where id = ?::uuid returning id", [clientId]);
    if (locked.rows.length !== 1) throw new Error('The holder did not archive exactly one client.');
    const holderPid = await backendPid(holder);
    const pending = start();
    await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
    await holder.commit();
    released = true;
    return await pending;
  } finally {
    if (!released) await holder.rollback();
  }
};

/** Window 2: the archive commits right before the statement of the route that writes the row. */
const archiveBeforeStatement = async (clientId: string, statement: RegExp, start: () => Promise<Reply>): Promise<Reply> => {
  w.runBeforeStatement(statement, async () => {
    await w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
  });
  try {
    return await start();
  } finally {
    w.clearHook();
  }
};

const archived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
};

const urlOf = (clientId: string): string => `/agencies/${w.agencyA}/clients/${clientId}/contents`;
const create = (folderId: string) => ({ title: 'Chegou tarde', format: 'reels', publishOn: '2026-10-20', folderId });

beforeAll(async () => {
  await w.setup();
}, 60_000);

afterAll(async () => {
  await w.teardown();
}, 60_000);

describe('a content written while the client is being archived (issue #254)', () => {
  it('answers 409 CLIENT_ARCHIVED to a content created while the archive is in course, and creates none', async () => {
    const clientId = await w.newClient('create-window-1');
    const folderId = await w.folderOf(clientId);

    const reply = await archiveWhileRouteWaits(clientId, () => w.call('POST', people.production.cookie, urlOf(clientId), create(folderId)));

    archived(reply);
    expect(await w.countContents(clientId)).toBe(0);
    expect((await w.getOwner().knex('clients').where({ id: clientId }).first('status'))?.status).toBe('archived');
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a content created after the archive committed and before the insert, and creates none', async () => {
    const clientId = await w.newClient('create-window-2');
    const folderId = await w.folderOf(clientId);

    const reply = await archiveBeforeStatement(clientId, /insert into public\.contents/i, () =>
      w.call('POST', people.production.cookie, urlOf(clientId), create(folderId)));

    archived(reply);
    expect(await w.countContents(clientId)).toBe(0);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a content moved to another day while the archive is in course, and moves none', async () => {
    const clientId = await w.newClient('move-window-1');
    const contentId = await w.seedContent(clientId, { publishOn: '2026-10-20' });

    const reply = await archiveWhileRouteWaits(clientId, () =>
      w.call('PATCH', people.production.cookie, `${urlOf(clientId)}/${contentId}`, { publishOn: '2026-12-01' }));

    archived(reply);
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a content edited after the archive committed and before the update, and edits none', async () => {
    const clientId = await w.newClient('edit-window-2');
    const contentId = await w.seedContent(clientId, { title: 'Original' });

    const reply = await archiveBeforeStatement(clientId, /update public\.contents/i, () =>
      w.call('PATCH', people.production.cookie, `${urlOf(clientId)}/${contentId}`, { title: 'Chegou tarde' }));

    archived(reply);
    expect((await w.contentRow(contentId)).title).toBe('Original');
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a media list written while the archive is in course, and writes none', async () => {
    const clientId = await w.newClient('media-window-1');
    const folderId = await w.folderOf(clientId);
    const contentId = await w.seedContent(clientId, { format: 'image' });
    const image = await w.seedAsset(clientId, folderId, { category: 'image' });

    const reply = await archiveWhileRouteWaits(clientId, () =>
      w.call('PATCH', people.production.cookie, `${urlOf(clientId)}/${contentId}`, { mediaAssetIds: [image] }));

    archived(reply);
    expect(await w.getOwner().knex('content_media').where({ content_id: contentId }).count<Array<{ count: string }>>('asset_id as count')).toEqual([{ count: '0' }]);
  }, 30_000);

  it('answers 403, not 409, when the policy refuses the insert because the permission was taken away and the client is still active', async () => {
    const clientId = await w.newClient('revoked');
    const folderId = await w.folderOf(clientId);
    const roleId = w.getApproverRoleId();

    w.runBeforeStatement(/insert into public\.contents/i, async () => {
      await w.getOwner().knex('role_permissions').where({ role_id: roleId, permission_key: 'conteudo.operar' }).delete();
    });
    try {
      const reply = await w.call('POST', people.approver.cookie, urlOf(clientId), create(folderId));

      expect(reply.statusCode).toBe(403);
      expect(reply.json().error.code).toBe('FORBIDDEN');
      expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
      expect(await w.countContents(clientId)).toBe(0);
    } finally {
      w.clearHook();
      await w.getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'conteudo.operar' }).onConflict().ignore();
    }
  }, 30_000);
});

describe('a content written while another transaction holds the client (issue #254)', () => {
  it('answers 409 TRY_AGAIN to a move that loses a deadlock against a transaction that holds the client, and moves nothing', async () => {
    // The route holds the content row and waits for the client to share it; the holder holds the client and then asks for
    // the content row. The route started waiting first, so it is the one the database aborts (40P01).
    const clientId = await w.newClient('deadlock');
    const contentId = await w.seedContent(clientId, { publishOn: '2026-10-20', title: 'Original' });

    const holder = await w.getOwner().knex.transaction();
    let pending: Promise<Reply> | undefined;
    let holderAsks: Promise<void> | undefined;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.clients where id = ?::uuid for update', [clientId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one client.');

      holderAsks = requestLockOnceBlocked(holder, "update public.contents set title = 'Holder' where id = %L::uuid", [contentId]);
      pending = w.call('PATCH', people.production.cookie, `${urlOf(clientId)}/${contentId}`, { publishOn: '2026-12-01' });
      const [reply] = await Promise.all([pending, holderAsks]);

      expect(reply.statusCode).toBe(409);
      expect(reply.json().error).toEqual({ code: 'TRY_AGAIN', message: 'Houve um conflito momentâneo. Tente de novo.' });
      expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
    } finally {
      await holder.rollback();
      await Promise.allSettled([pending, holderAsks]);
    }
    expect(await w.publishOnOf(contentId)).toBe('2026-10-20');
    expect((await w.contentRow(contentId)).title).toBe('Original');
  }, 30_000);
});

describe('a content edited while the client is archived behind the row the edit waits for (issue #254, trigger of #538)', () => {
  // The route has read the client (active) and its UPDATE waits for the row, held by another transaction. The archive
  // commits in that wait, then the row is released: only the trigger `0_contents_edit_lock_active_client` can still
  // tell the statement that the client is gone, because its policy and its WHERE were evaluated before the wait.
  it.each([
    ['title', { title: 'Chegou depois do arquivamento' }, 'title', 'Original'],
    ['caption', { caption: 'Legenda depois do arquivamento' }, 'caption', 'Legenda original']
  ] as const)('answers 409 CLIENT_ARCHIVED to a %s edit that waits for the row while the archive commits, and edits none', async (_label, body, column, original) => {
    const clientId = await w.newClient(`edit-held-${column}`);
    const contentId = await w.seedContent(clientId, { title: 'Original', caption: 'Legenda original' });

    const holder = await w.getOwner().knex.transaction();
    let released = false;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.contents where id = ?::uuid for update', [contentId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one content row.');
      const holderPid = await backendPid(holder);

      const pending = w.call('PATCH', people.production.cookie, `${urlOf(clientId)}/${contentId}`, body);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      const archive = await w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
      expect(archive).toBe(1);
      await holder.rollback();
      released = true;

      archived(await pending);
    } finally {
      if (!released) await holder.rollback();
    }
    expect((await w.contentRow(contentId))[column]).toBe(original);
  }, 30_000);
});
