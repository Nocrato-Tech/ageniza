import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PORTAL_MATERIAL_UPLOAD_FOLDER_NAME,
  PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  PORTAL_MATERIAL_UPLOAD_MAX_FILES,
  PORTAL_MATERIAL_UPLOAD_TYPES,
  PortalMaterialUploadRejectionReasonSchema
} from '../../contracts/src/portal-material-uploads.js';
import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';

// Scope redesign-igual, subtask W10-S3 (decision 2026-11-11, "o cliente envia material pelo portal"): the person of the portal sends photos and
// audio to an open request for material of her client, through three functions that walk the cycle of the agency's upload (start, confirm or
// reject), and reads back only what she sent. RLS answers WHO may read, not through WHICH SIDE, so every rule is attacked with the people who
// only hold the link, with the collaborators who also hold it (`dualBare`, `dualFull`), with the Admin of another agency who holds one
// (`crossDual`) and with the people of another client and another agency.
const w = createContentWorld('portal-uploads');
const { ids } = w;

const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const owner = (): Knex => w.getOwner().knex;

const WINDOW = 3_600;
const ROOM = { defaultBytes: 1_099_511_627_776, defaultCount: 1_000_000 } as const;
const MAX_BYTES = PORTAL_MATERIAL_UPLOAD_MAX_BYTES;
const MAX_FILES = PORTAL_MATERIAL_UPLOAD_MAX_FILES;

// ---- the calls -----------------------------------------------------------------------------------------------------------------

interface Started { asset_id: string; agency_id: string; category: string; extension: string; content_type: string; object_key: string; upload_object_key: string }
interface StartArgs {
  client: string; thread: string; type: string | null; size: number | null; name: string | null;
  defaultBytes: number | null; defaultCount: number | null; window: number | null;
}

const startArgs = (thread: string, over: Partial<StartArgs> = {}): StartArgs => ({
  client: ids.clientA1, thread, type: 'image/png', size: 1_000, name: 'foto.png', ...ROOM, window: WINDOW, ...over
});
const START_SQL = 'select * from app_private.start_portal_material_upload(?::uuid, ?::uuid, ?::text, ?::bigint, ?::text, ?::bigint, ?::bigint, ?::integer)';
const startBindings = (a: StartArgs): unknown[] => [a.client, a.thread, a.type, a.size, a.name, a.defaultBytes, a.defaultCount, a.window];
const startIn = async (t: Pick<Knex, 'raw'>, a: StartArgs): Promise<Started> => (await t.raw<{ rows: Started[] }>(START_SQL, startBindings(a))).rows[0]!;
const start = (user: string, a: StartArgs): Promise<Started> => w.asUser(user, (t) => startIn(t, a));

interface ConfirmArgs {
  size: number | null; type: string | null; width: number | null; height: number | null;
  defaultBytes: number | null; defaultCount: number | null; window: number | null;
}
interface Verdict { outcome: string; reason: string | null }
const confirmArgs = (over: Partial<ConfirmArgs> = {}): ConfirmArgs => ({ size: 1_000, type: 'image/png', width: 640, height: 480, ...ROOM, window: WINDOW, ...over });
const CONFIRM_SQL = 'select * from app_private.confirm_portal_material_upload(?::uuid, ?::bigint, ?::text, ?::integer, ?::integer, ?::bigint, ?::bigint, ?::integer)';
const confirmIn = async (t: Pick<Knex, 'raw'>, assetId: string, a: ConfirmArgs): Promise<Verdict> =>
  (await t.raw<{ rows: Verdict[] }>(CONFIRM_SQL, [assetId, a.size, a.type, a.width, a.height, a.defaultBytes, a.defaultCount, a.window])).rows[0]!;
const confirm = (user: string, assetId: string, over: Partial<ConfirmArgs> = {}): Promise<Verdict> =>
  w.asUser(user, (t) => confirmIn(t, assetId, confirmArgs(over)));
const rejectUpload = (user: string, assetId: string, reason: string | null): Promise<unknown> =>
  w.asUser(user, (t) => t.raw('select app_private.reject_portal_material_upload(?::uuid, ?::text)', [assetId, reason]));

interface ListedRow {
  total_count: string; asset_id: string | null; status: string | null; category: string | null; content_type: string | null; size_bytes: string | null;
  file_name: string | null; width: number | null; height: number | null; created_at: Date | null; object_key: string | null;
}
const LIST_SQL = 'select * from app_private.list_portal_material_uploads(?::uuid, ?::uuid, ?::integer, ?::bigint)';
const list = (user: string, client: string, thread: string, limit: number | null = 100, offset: number | null = 0): Promise<ListedRow[]> =>
  w.asUser(user, async (t) => (await t.raw<{ rows: ListedRow[] }>(LIST_SQL, [client, thread, limit, offset])).rows);
const listed = async (user: string, client: string, thread: string): Promise<string[]> =>
  (await list(user, client, thread)).flatMap((row) => (row.asset_id === null ? [] : [row.asset_id]));
/** A page with no file in it still answers the total, in one row with no file. */
const emptyPage = (total: number): ListedRow => ({
  total_count: String(total), asset_id: null, status: null, category: null, content_type: null, size_bytes: null, file_name: null, width: null, height: null,
  created_at: null, object_key: null
});

// ---- the world -------------------------------------------------------------------------------------------------------------------

const requests: string[] = [];
const freshAgencies: string[] = [];
const freshClients: string[] = [];
const freshUsers: string[] = [];

const openRequest = async (clientId = ids.clientA1, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  requests.push(id);
  await owner()('client_threads').insert({ id, client_id: clientId, is_material_request: true, opened_by: ids.adminA, opened_side: 'agency', ...extra });
  return id;
};

interface Fresh { agency: string; client: string; user: string; other: string; thread: string }

/** A client of its own, with two people on its portal and an open request, in an agency of its own (or in agency A). */
const fresh = async (inAgencyA = false): Promise<Fresh> => {
  const agency = inAgencyA ? ids.agencyA : randomUUID();
  const client = randomUUID();
  const [user, other] = [randomUUID(), randomUUID()];
  freshClients.push(client);
  freshUsers.push(user, other);
  await owner().transaction(async (t) => {
    await t('auth.user').insert([user, other].map((id) => ({ id, name: `User ${id}`, email: `${id}@portal-uploads.test`, emailVerified: true })));
    if (!inAgencyA) {
      freshAgencies.push(agency);
      await t('agencies').insert({ id: agency, name: `portal-uploads ${agency}` });
    }
    await t('clients').insert({ id: client, agency_id: agency, name: `Cliente ${client}` });
    await t('client_memberships').insert([user, other].map((id) => ({ client_id: client, user_id: id })));
  });
  return { agency, client, user, other, thread: await openRequest(client) };
};

const setQuota = (agency: string, bytes: number | null, count: number | null): Promise<unknown> =>
  owner().raw(
    `insert into public.agency_storage_quotas (agency_id, quota_bytes, quota_object_count) values (?::uuid, ?::bigint, ?::bigint)
     on conflict (agency_id) do update set quota_bytes = excluded.quota_bytes, quota_object_count = excluded.quota_object_count`,
    [agency, bytes, count]
  );
const makeReadOnly = (agency: string): Promise<unknown> => owner()('agencies').where({ id: agency }).update({
  plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
});
const suspend = (agency: string): Promise<unknown> => owner()('agencies').where({ id: agency }).update({ status: 'suspended' });
const archive = (client: string): Promise<unknown> => owner()('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });
// A person leaves the portal with her access: the two rows change in one transaction, the check of the pair is deferred to its end.
const removeAccess = (client: string, user: string): Promise<unknown> => owner().transaction(async (t) => {
  await t('client_portal_accesses').where({ client_id: client, user_id: user }).update({ status: 'removed', generation: t.raw('generation + 1') });
  await t('client_memberships').where({ client_id: client, user_id: user }).update({ status: 'removed' });
});

interface SeedOptions {
  status?: 'pending' | 'confirmed' | 'rejected'; size?: number; confirmedSize?: number; ageSeconds?: number; removed?: boolean; purged?: boolean;
  side?: 'agency' | 'client'; thread?: string; user?: string; category?: 'image' | 'audio';
}

/** A row as the owner writes it, for the states a test must reach without walking the cycle. */
const seed = async (client: string, agency: string, o: SeedOptions = {}): Promise<string> => {
  const id = randomUUID();
  const status = o.status ?? 'confirmed';
  const side = o.side ?? 'agency';
  const category = o.category ?? 'image';
  const [type, extension] = category === 'image' ? ['image/png', 'png'] : ['audio/mpeg', 'mp3'];
  const size = o.size ?? 1_000;
  await owner()('media_assets').insert({
    id, agency_id: agency, client_id: client, folder_id: await w.folderOf(client), category,
    declared_content_type: type, extension, object_key: `${agency}/${id}/original.${extension}`, upload_object_key: `staging/${agency}/${id}/upload.${extension}`,
    declared_size_bytes: size, created_by_user_id: o.user ?? ids.adminA, uploaded_by_side: side,
    material_request_thread_id: side === 'client' ? o.thread! : null,
    ...(status === 'confirmed' ? { status, confirmed_size_bytes: o.confirmedSize ?? size, confirmed_content_type: type, confirmed_at: new Date() } : {}),
    ...(status === 'rejected' ? { status, rejected_reason: 'too_large' } : {}),
    ...(o.ageSeconds === undefined ? {} : { updated_at: owner().raw(`now() - (?::integer * interval '1 second')`, [o.ageSeconds]) }),
    ...(o.removed === true || o.purged === true ? { removed_at: new Date() } : {}),
    ...(o.purged === true ? { purged_at: new Date() } : {})
  });
  return id;
};
const seedFilesOfRequest = async (f: Fresh, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, size: 10 });
};

const assetRow = async (id: string): Promise<Record<string, unknown>> => (await owner()('media_assets').where({ id }).first()) as Record<string, unknown>;
const filesOf = async (thread: string): Promise<Array<Record<string, unknown>>> =>
  (await owner()('media_assets').where({ material_request_thread_id: thread }).orderBy('created_at')) as Array<Record<string, unknown>>;
const visible = async (user: string, among: readonly string[]): Promise<string[]> =>
  (await w.asUser(user, (t) => t('media_assets').whereIn('id', among).select('id'))).map((row) => row.id as string).sort();

const attempt = async (work: () => Promise<unknown>): Promise<unknown> => work().then(() => 'done', (error: unknown) => error);

// What the portal hears from an agency that does not accept writes: not the words of the trigger of the table, which speak of its trial.
const NEUTRAL_READ_ONLY = { code: 'A0090', message: expect.stringContaining('The agency does not accept writes now.') };

let suspendedThread: string;

beforeAll(async () => {
  await w.setup();
  await w.withSuspendedAgencyActive(async () => { suspendedThread = await openRequest(ids.clientSuspended); });
});

afterAll(async () => {
  try {
    const clients = [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended, ...freshClients];
    await owner()('media_assets').whereIn('client_id', clients).delete();
    await owner()('agency_storage_quotas').whereIn('agency_id', [ids.agencyA, ids.agencyB, ids.agencySuspended, ...freshAgencies]).delete();
    await owner()('client_thread_comments').whereIn('thread_id', requests).delete();
    await owner()('client_threads').whereIn('id', requests).delete();
    await owner()('media_folders').whereIn('client_id', freshClients).delete();
    await owner()('client_memberships').whereIn('client_id', freshClients).orWhereIn('user_id', freshUsers).delete();
    await owner()('clients').whereIn('id', freshClients).delete();
    await owner()('agencies').whereIn('id', freshAgencies).delete();
    await owner()('auth.user').whereIn('id', freshUsers).delete();
  } finally {
    await w.teardown();
  }
});

// The people who hold the link to client A1 and so are the portal of that client, whatever else they are.
const LINKED = [
  ['a person of the portal', () => ids.portalA1],
  ['another person of the portal of the same client', () => ids.portalA1Second],
  ['a collaborator with a link to the client and the Sales role', () => ids.dualBare],
  ['a collaborator with a link to the client and the Production role', () => ids.dualFull],
  ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
] as const;

// ---- the shape ---------------------------------------------------------------------------------------------------------------------

describe('the link of a file to its request and the side of who sent it', () => {
  it('is born the agency\'s with no request for the media that exists, and the application role can only read the two columns', async () => {
    const asset = await seed(ids.clientA1, ids.agencyA);
    expect(await assetRow(asset)).toMatchObject({ uploaded_by_side: 'agency', material_request_thread_id: null });

    for (const privilege of ['insert', 'update'] as const) {
      const granted = await w.columnsWithPrivilege('media_assets', privilege);
      expect(granted, privilege).not.toContain('uploaded_by_side');
      expect(granted, privilege).not.toContain('material_request_thread_id');
    }
    expect(await w.tablePrivileges('media_assets')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it('keeps the two columns together: a file of the client has its request and a file with a request is the client\'s', async () => {
    const thread = await openRequest();
    const row = (extra: Record<string, unknown>) => {
      const id = randomUUID();
      return {
        id, agency_id: ids.agencyA, client_id: ids.clientA1, category: 'image', declared_content_type: 'image/png', extension: 'png',
        object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 10,
        created_by_user_id: ids.adminA, ...extra
      };
    };
    const shape = { code: '23514', constraint: 'media_assets_client_upload_shape' };

    await expect(owner()('media_assets').insert(row({ uploaded_by_side: 'client' }))).rejects.toMatchObject(shape);
    await expect(owner()('media_assets').insert(row({ uploaded_by_side: 'agency', material_request_thread_id: thread }))).rejects.toMatchObject(shape);
    await expect(owner()('media_assets').insert(row({ uploaded_by_side: 'somebody' }))).rejects.toMatchObject({ code: '23514', constraint: 'media_assets_uploaded_by_side_check' });
    await expect(owner()('media_assets').insert(row({ uploaded_by_side: 'client', material_request_thread_id: thread, client_id: null }))).rejects.toMatchObject({ code: '23514' });
    const kept = row({ uploaded_by_side: 'client', material_request_thread_id: thread });
    await owner()('media_assets').insert(kept);
    expect(await assetRow(kept.id)).toMatchObject({ uploaded_by_side: 'client', material_request_thread_id: thread });
  });

  it('ties the file to a request of the same client: the request of another client is refused by the foreign key', async () => {
    const elsewhere = await openRequest(ids.clientA2);
    const id = randomUUID();
    await expect(owner()('media_assets').insert({
      id, agency_id: ids.agencyA, client_id: ids.clientA1, category: 'image', declared_content_type: 'image/png', extension: 'png',
      object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 10,
      created_by_user_id: ids.adminA, uploaded_by_side: 'client', material_request_thread_id: elsewhere
    })).rejects.toMatchObject({ code: '23503', constraint: 'media_assets_request_thread_fk' });
  });

  it('does not let a person write the side or the request: a collaborator cannot mark a file the client\'s, nor the portal insert one', async () => {
    const thread = await openRequest();
    const asset = await seed(ids.clientA1, ids.agencyA);
    const id = randomUUID();
    const born = {
      id, agency_id: ids.agencyA, client_id: ids.clientA1, category: 'image', declared_content_type: 'image/png', extension: 'png',
      object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 10
    };

    await expect(w.asUser(ids.adminA, (t) => t('media_assets').insert({ ...born, uploaded_by_side: 'client', material_request_thread_id: thread }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t('media_assets').where({ id: asset }).update({ uploaded_by_side: 'client' }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t('media_assets').where({ id: asset }).update({ material_request_thread_id: thread }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.portalA1, (t) => t('media_assets').insert({ ...born, uploaded_by_side: 'client', material_request_thread_id: thread }))).rejects.toMatchObject({ code: '42501' });
    expect(await assetRow(asset)).toMatchObject({ uploaded_by_side: 'agency', material_request_thread_id: null });
    expect(await filesOf(thread)).toHaveLength(0);
  });
});

// ---- the types and the ceiling of a file -------------------------------------------------------------------------------------

describe('what the portal may send: the types and the size of a file, as the contract says', () => {
  it.each(Object.entries(PORTAL_MATERIAL_UPLOAD_TYPES))('takes %s as %j and builds the keys from what the database knows', async (type, kind) => {
    const thread = await openRequest();

    const started = await start(ids.portalA1, startArgs(thread, { type, name: 'arquivo' }));

    expect(started).toMatchObject({ agency_id: ids.agencyA, category: kind.category, extension: kind.extension, content_type: type });
    expect(started.object_key).toBe(`${ids.agencyA}/${started.asset_id}/original.${kind.extension}`);
    expect(started.upload_object_key).toBe(`staging/${ids.agencyA}/${started.asset_id}/upload.${kind.extension}`);
    expect(await assetRow(started.asset_id)).toMatchObject({
      status: 'pending', category: kind.category, declared_content_type: type, extension: kind.extension, object_key: started.object_key,
      upload_object_key: started.upload_object_key, declared_size_bytes: '1000', file_name: 'arquivo', client_id: ids.clientA1,
      material_request_thread_id: thread, uploaded_by_side: 'client', created_by_user_id: ids.portalA1, confirmed_at: null, filed_at: null
    });
  });

  it.each([
    ['upper case', 'IMAGE/PNG', 'image/png'],
    ['padded with spaces', '  image/jpeg  ', 'image/jpeg'],
    ['with the codecs of a recording', 'audio/webm;codecs=opus', 'audio/webm'],
    ['with a space before the parameter', 'audio/ogg ; codecs=opus', 'audio/ogg']
  ])('reads the type %s without its parameters', async (_label, sent, recorded) => {
    const started = await start(ids.portalA1, startArgs(await openRequest(), { type: sent }));

    expect(started.content_type).toBe(recorded);
    expect(await assetRow(started.asset_id)).toMatchObject({ declared_content_type: recorded });
  });

  it.each([
    'image/svg+xml', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'image/bmp', 'image/tiff', 'image/heic', 'image/avif',
    'audio/aac', 'audio/flac', 'application/octet-stream', 'text/html', 'image', 'image/', '*/*', 'text/html; image/png', 'image/svg+xml; image/png', '', '  '
  ])('refuses the type %j with A0133 and leaves no row', async (type) => {
    const thread = await openRequest();

    await expect(start(ids.portalA1, startArgs(thread, { type }))).rejects.toMatchObject({ code: 'A0133' });

    expect(await filesOf(thread)).toHaveLength(0);
  });

  it('refuses a missing type with A0133', async () => {
    await expect(start(ids.portalA1, startArgs(await openRequest(), { type: null }))).rejects.toMatchObject({ code: 'A0133' });
  });

  it('takes the file at the ceiling and refuses one byte more with A0132, and a size that is not a size with 22023', async () => {
    const thread = await openRequest();

    expect((await start(ids.portalA1, startArgs(thread, { size: MAX_BYTES }))).asset_id).toBeDefined();
    await expect(start(ids.portalA1, startArgs(thread, { size: MAX_BYTES + 1 }))).rejects.toMatchObject({ code: 'A0132' });
    await expect(start(ids.portalA1, startArgs(thread, { size: 10 * 1024 * 1024 * 1024 }))).rejects.toMatchObject({ code: 'A0132' });
    for (const size of [0, -1, null]) {
      await expect(start(ids.portalA1, startArgs(thread, { size })), String(size)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await filesOf(thread)).toHaveLength(1);
    expect((await start(ids.portalA1, startArgs(thread, { size: 1 }))).asset_id).toBeDefined();
  });

  it('answers who the person is before it says anything about the file: a stranger with an SVG of any size gets the same answer as with a PNG', async () => {
    const thread = await openRequest();

    for (const over of [{ type: 'image/svg+xml' }, { size: MAX_BYTES + 1 }, { size: 0 }]) {
      await expect(start(ids.portalA2, startArgs(thread, over)), JSON.stringify(over)).rejects.toMatchObject({ code: 'A0130' });
    }
  });
});

// ---- who may send, and to what -----------------------------------------------------------------------------------------------

describe('who may send, and to which request', () => {
  it.each(LINKED)('lets %s send to an open request of the client, stamped with her and the client\'s side', async (_label, user) => {
    const thread = await openRequest();

    const started = await start(user(), startArgs(thread));

    expect(await assetRow(started.asset_id)).toMatchObject({ created_by_user_id: user(), uploaded_by_side: 'client', status: 'pending', client_id: ids.clientA1 });
  });

  it.each([
    ['a person of another client of the same agency', () => ids.portalA2],
    ['a person of another agency', () => ids.portalB],
    ['the Admin of the agency, who holds no link to the client', () => ids.adminA],
    ['the Production role, who holds no link to the client', () => ids.productionA],
    ['the Owner of the agency, who holds no link to the client', () => ids.ownerA],
    ['the Admin of another agency, who holds no link here', () => ids.adminB],
    ['a collaborator whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('refuses %s with the one answer of a request that is not there, and leaves no row', async (_label, user) => {
    const thread = await openRequest();

    await expect(start(user(), startArgs(thread))).rejects.toMatchObject({ code: 'A0130' });

    expect(await filesOf(thread)).toHaveLength(0);
  });

  it('refuses a person with every permission of the media and none of the link', async () => {
    const everything = await w.personWith('midia.enviar', 'conteudo.operar', 'conteudo.visualizar', 'cliente.operar', 'cliente.visualizar');
    const thread = await openRequest();

    await expect(start(everything, startArgs(thread))).rejects.toMatchObject({ code: 'A0130' });
  });

  it('refuses the request of another client: the link is to the client the request belongs to, whichever pair of ids is sent', async () => {
    const own = await openRequest(ids.clientA1);
    const elsewhere = await openRequest(ids.clientA2);

    await expect(start(ids.portalA1, startArgs(elsewhere))).rejects.toMatchObject({ code: 'A0130' });
    await expect(start(ids.portalA1, startArgs(elsewhere, { client: ids.clientA2 }))).rejects.toMatchObject({ code: 'A0130' });
    await expect(start(ids.portalA2, startArgs(own, { client: ids.clientA2 }))).rejects.toMatchObject({ code: 'A0130' });
    await expect(start(ids.portalA1, startArgs(randomUUID()))).rejects.toMatchObject({ code: 'A0130' });
    expect(await filesOf(own)).toHaveLength(0);
    expect(await filesOf(elsewhere)).toHaveLength(0);
  });

  it('refuses a conversation that is not a request for material: a section, a persona, a content', async () => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const [section, onContent] = [randomUUID(), randomUUID()];
    requests.push(section, onContent);
    await owner()('client_threads').insert([
      { id: section, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' },
      { id: onContent, client_id: ids.clientA1, content_id: content, opened_by: ids.adminA, opened_side: 'agency' }
    ]);

    await expect(start(ids.portalA1, startArgs(section))).rejects.toMatchObject({ code: 'A0130' });
    await expect(start(ids.portalA1, startArgs(onContent))).rejects.toMatchObject({ code: 'A0130' });
    expect(await owner()('media_assets').whereIn('material_request_thread_id', [section, onContent])).toHaveLength(0);
  });

  it('refuses a resolved request with A0131 and takes files again once a comment of the client reopens it', async () => {
    const thread = await openRequest(ids.clientA1, { resolved_by: ids.adminA, resolved_at: new Date() });

    await expect(start(ids.portalA1, startArgs(thread))).rejects.toMatchObject({ code: 'A0131' });
    expect(await filesOf(thread)).toHaveLength(0);

    await w.asUser(ids.portalA1, (t) => t('client_thread_comments').insert({
      id: randomUUID(), thread_id: thread, client_id: ids.clientA1, author_user_id: ids.portalA1, author_side: 'client', body: 'Mais uma foto'
    }));
    expect((await start(ids.portalA1, startArgs(thread))).asset_id).toBeDefined();
  });

  it('refuses a person whose access to the portal was removed, and still takes the files of the people who kept theirs', async () => {
    const f = await fresh();
    await removeAccess(f.client, f.user);

    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0130' });
    expect((await start(f.other, startArgs(f.thread, { client: f.client }))).asset_id).toBeDefined();
    expect(await filesOf(f.thread)).toHaveLength(1);
  });

  it('refuses the person of an archived client with the one answer of a request that is not there', async () => {
    const f = await fresh();
    await start(f.user, startArgs(f.thread, { client: f.client }));
    await archive(f.client);

    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0130' });
    expect(await filesOf(f.thread)).toHaveLength(1);
  });

  it('refuses the person of a suspended agency, whichever way the suspension came', async () => {
    await expect(start(ids.portalSuspended, startArgs(suspendedThread, { client: ids.clientSuspended }))).rejects.toMatchObject({ code: 'A0130' });

    const f = await fresh();
    await suspend(f.agency);
    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0130' });
    expect(await filesOf(f.thread)).toHaveLength(0);
  });

  it('refuses an agency that does not accept writes with A0090 before it says anything about the room it has', async () => {
    const f = await fresh();
    await setQuota(f.agency, 1, 1);
    await makeReadOnly(f.agency);

    expect(await attempt(() => start(f.user, startArgs(f.thread, { client: f.client })))).toMatchObject(NEUTRAL_READ_ONLY);
    expect(await filesOf(f.thread)).toHaveLength(0);
  });

  it('is called by a person: with no actor bound it refuses with 42501, and under any isolation but READ COMMITTED with 40001', async () => {
    const thread = await openRequest();

    await expect(owner().raw(START_SQL, startBindings(startArgs(thread)))).rejects.toMatchObject({ code: '42501' });

    const transaction = await w.openTransactionAs(ids.portalA1, 'repeatable read');
    try {
      await expect(startIn(transaction, startArgs(thread))).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    expect(await filesOf(thread)).toHaveLength(0);
  });

  it('takes a window of no seconds: a reservation then counts for nothing', async () => {
    const f = await fresh();
    await setQuota(f.agency, MAX_BYTES, null);
    await start(f.user, startArgs(f.thread, { client: f.client, size: MAX_BYTES, window: 0 }));

    expect((await start(f.user, startArgs(f.thread, { client: f.client, size: MAX_BYTES, window: 0 }))).asset_id).toBeDefined();
    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 1_000 }))).rejects.toMatchObject({ code: 'A0136' });
  });

  it.each([
    ['no default for the bytes', { defaultBytes: null }],
    ['a default of no bytes', { defaultBytes: 0 }],
    ['no default for the count', { defaultCount: null }],
    ['a default of no files', { defaultCount: 0 }],
    ['no window', { window: null }],
    ['a window of minus one second', { window: -1 }]
  ] as const)('refuses %s with 22023 before anything else is looked at: a missing setting is not a limit nobody set', async (_label, over) => {
    // A resolved request, so that no later guard of the same call could answer the same code or another one first.
    const thread = await openRequest(ids.clientA1, { resolved_by: ids.adminA, resolved_at: new Date() });

    await expect(start(ids.portalA1, startArgs(thread, over))).rejects.toMatchObject({ code: '22023' });
    await expect(start(ids.portalA2, startArgs(thread, over))).rejects.toMatchObject({ code: '22023' });
    expect(await filesOf(thread)).toHaveLength(0);
  });
});

// ---- the folder of the client ------------------------------------------------------------------------------------------------

describe('the folder "Enviados pelo cliente"', () => {
  it('is born with the first upload, once, in the client that received it, and is the folder of every upload after it', async () => {
    const f = await fresh();
    const named = () => owner()('media_folders').where({ client_id: f.client, name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME });
    expect(await named()).toHaveLength(0);

    const first = await start(f.user, startArgs(f.thread, { client: f.client }));
    const second = await start(f.other, startArgs(f.thread, { client: f.client }));

    const folders = await named();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ is_default: true, parent_id: null });
    expect(await assetRow(first.asset_id)).toMatchObject({ folder_id: folders[0].id });
    expect(await assetRow(second.asset_id)).toMatchObject({ folder_id: folders[0].id });
    expect(await owner()('media_folders').where({ client_id: ids.clientA2, name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME })).toHaveLength(0);
  });

  it('is not the agency\'s to break: it cannot be created by hand, renamed or deleted', async () => {
    const f = await fresh(true);
    await start(f.user, startArgs(f.thread, { client: f.client }));
    const folder = (await owner()('media_folders').where({ client_id: f.client, name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME }).first('id'))!.id as string;

    expect(await w.asUser(ids.adminA, (t) => t('media_folders').where({ id: folder }).update({ name: 'Outro nome' }))).toBe(0);
    await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.delete_media_folder(?::uuid)', [folder]))).rejects.toMatchObject({ code: 'A0086' });
    await expect(w.asUser(ids.adminA, (t) => t('media_folders').where({ id: folder }).delete())).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t('media_folders').insert({ client_id: f.client, name: 'Outra', is_default: true }))).rejects.toMatchObject({ code: '42501' });

    expect(await owner()('media_folders').where({ id: folder }).first()).toMatchObject({ name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME, is_default: true });
  });

  it('is not made again when the agency made a folder of its own with that name: the upload still finds the one of the system', async () => {
    const f = await fresh(true);
    await owner()('media_folders').insert({ client_id: f.client, name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME, is_default: false });

    const started = await start(f.user, startArgs(f.thread, { client: f.client }));

    const system = await owner()('media_folders').where({ client_id: f.client, name: PORTAL_MATERIAL_UPLOAD_FOLDER_NAME, is_default: true });
    expect(system).toHaveLength(1);
    expect(await assetRow(started.asset_id)).toMatchObject({ folder_id: system[0].id });
  });
});

// ---- the ceilings of the request and of the agency ---------------------------------------------------------------------------

describe('how many files a request takes', () => {
  it('takes the twentieth file and refuses the twenty-first with A0134, counting pending and confirmed ones of everybody', async () => {
    const f = await fresh();
    await seedFilesOfRequest(f, MAX_FILES - 2);
    const last = await start(f.other, startArgs(f.thread, { client: f.client }));
    await confirm(f.other, last.asset_id);
    await start(f.user, startArgs(f.thread, { client: f.client }));

    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0134' });
    await expect(start(f.other, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0134' });
    expect(await filesOf(f.thread)).toHaveLength(MAX_FILES);
  });

  it('counts the files of one request only: another request of the same client still takes its own', async () => {
    const f = await fresh();
    await seedFilesOfRequest(f, MAX_FILES);
    const another = await openRequest(f.client);

    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0134' });
    expect((await start(f.user, startArgs(another, { client: f.client }))).asset_id).toBeDefined();
  });

  it('gives a place back for a file rejected, removed or abandoned beyond the window, and holds the place of one still within it', async () => {
    const f = await fresh();
    await seedFilesOfRequest(f, MAX_FILES - 4);
    await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, status: 'rejected' });
    await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, removed: true });
    await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, status: 'pending', ageSeconds: WINDOW + 60 });
    await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, status: 'pending', ageSeconds: WINDOW - 60 });
    await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user });
    // Sixteen confirmed, one confirmed more and one pending within the window: eighteen places taken, so two are left.
    await start(f.user, startArgs(f.thread, { client: f.client }));
    await start(f.user, startArgs(f.thread, { client: f.client }));

    await expect(start(f.user, startArgs(f.thread, { client: f.client }))).rejects.toMatchObject({ code: 'A0134' });
  });
});

describe('how much the agency can store, and what the portal is told when it cannot', () => {
  it('takes the file while the agency has room for one of the ceiling and refuses with A0136 when it has less, a code that says nothing of plans, quotas or billing', async () => {
    const f = await fresh();
    await setQuota(f.agency, 2 * MAX_BYTES, null);
    await start(f.user, startArgs(f.thread, { client: f.client, size: MAX_BYTES }));
    await start(f.other, startArgs(f.thread, { client: f.client, size: MAX_BYTES }));

    const refusal = await attempt(() => start(f.user, startArgs(f.thread, { client: f.client, size: 1 })));

    expect(refusal).toMatchObject({ code: 'A0136' });
    expect((refusal as { message: string }).message).not.toMatch(/quota|plan|billing|storage|limit|full|space|upgrade|pay/i);
    expect(await filesOf(f.thread)).toHaveLength(2);
  });

  // The answer must not depend on a number the person controls: with less than the ceiling of one file free, every size is refused, the
  // room left itself included, and with that much or more, every size up to the ceiling is taken.
  it.each([1, 1_000, MAX_BYTES - 1])('refuses every size at the start when the agency has %i bytes left, the room left and the byte above it included', async (room) => {
    const f = await fresh();
    await setQuota(f.agency, 4 * MAX_BYTES, null);
    await seed(f.client, f.agency, { size: 4 * MAX_BYTES - room });

    for (const size of new Set([1, room, room + 1, MAX_BYTES])) {
      expect(await attempt(() => start(f.user, startArgs(f.thread, { client: f.client, size }))), `size ${size}`).toMatchObject({ code: 'A0136' });
    }
    expect(await filesOf(f.thread)).toHaveLength(0);
  });

  it.each([MAX_BYTES, MAX_BYTES + 1, 3 * MAX_BYTES])('takes every size at the start up to the ceiling when the agency has %i bytes left', async (room) => {
    const f = await fresh();
    await setQuota(f.agency, 4 * MAX_BYTES, null);
    await seed(f.client, f.agency, { size: 4 * MAX_BYTES - room });

    // A window of no seconds so that a reservation counts for nothing and every size meets the same room.
    for (const size of [1, 1_000, MAX_BYTES / 2, MAX_BYTES]) {
      expect((await start(f.user, startArgs(f.thread, { client: f.client, size, window: 0 }))).asset_id, `size ${size}`).toBeDefined();
    }
    expect(await filesOf(f.thread)).toHaveLength(4);
  });

  it('takes the file that lands exactly on the ceiling of files', async () => {
    const count = await fresh();
    await setQuota(count.agency, null, 2);
    await start(count.user, startArgs(count.thread, { client: count.client }));
    expect((await start(count.user, startArgs(count.thread, { client: count.client }))).asset_id).toBeDefined();
    await expect(start(count.user, startArgs(count.thread, { client: count.client }))).rejects.toMatchObject({ code: 'A0136' });
  });

  it('counts the whole agency, the media of the agency included, and not what is not in use: rejected, purged or abandoned', async () => {
    const f = await fresh();
    await setQuota(f.agency, 3 * MAX_BYTES, null);
    await seed(f.client, f.agency, { size: MAX_BYTES });
    await seed(f.client, f.agency, { size: MAX_BYTES, status: 'rejected' });
    await seed(f.client, f.agency, { size: MAX_BYTES, purged: true });
    await seed(f.client, f.agency, { size: MAX_BYTES, status: 'pending', ageSeconds: WINDOW + 60 });
    // A removed file still sits in the storage until the retention purges it.
    await seed(f.client, f.agency, { size: MAX_BYTES, removed: true });

    // Two files in use leave exactly the room of one file of the ceiling; the one that is taken leaves less.
    expect((await start(f.user, startArgs(f.thread, { client: f.client, size: 1 }))).asset_id).toBeDefined();
    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 1 }))).rejects.toMatchObject({ code: 'A0136' });
  });

  it('counts the media of another agency for nothing', async () => {
    const [full, empty] = [await fresh(), await fresh()];
    await setQuota(full.agency, MAX_BYTES, null);
    await setQuota(empty.agency, MAX_BYTES, null);
    await seed(full.client, full.agency, { size: MAX_BYTES });

    await expect(start(full.user, startArgs(full.thread, { client: full.client }))).rejects.toMatchObject({ code: 'A0136' });
    expect((await start(empty.user, startArgs(empty.thread, { client: empty.client }))).asset_id).toBeDefined();
  });

  it('takes the default of the deployment for the count of files too, when the agency has no ceiling of its own', async () => {
    const f = await fresh();
    const oneFile = { defaultBytes: 100 * MAX_BYTES, defaultCount: 1 };

    expect((await start(f.user, startArgs(f.thread, { client: f.client, size: 10, ...oneFile }))).asset_id).toBeDefined();
    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 10, ...oneFile }))).rejects.toMatchObject({ code: 'A0136' });
  });

  it('uses the ceiling of the agency when it has one and the default of the deployment when it has none or has it empty', async () => {
    const f = await fresh();
    const tight = { defaultBytes: MAX_BYTES - 1, defaultCount: 1 };

    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 600, ...tight }))).rejects.toMatchObject({ code: 'A0136' });
    await setQuota(f.agency, null, null);
    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 600, ...tight }))).rejects.toMatchObject({ code: 'A0136' });
    await setQuota(f.agency, 10 * MAX_BYTES, 10);
    expect((await start(f.user, startArgs(f.thread, { client: f.client, size: 600, ...tight }))).asset_id).toBeDefined();
    expect((await start(f.user, startArgs(f.thread, { client: f.client, size: 600, ...tight }))).asset_id).toBeDefined();
    await setQuota(f.agency, null, null);
    await expect(start(f.user, startArgs(f.thread, { client: f.client, size: 100, ...tight }))).rejects.toMatchObject({ code: 'A0136' });
  });
});

// ---- confirming and rejecting -----------------------------------------------------------------------------------------------

describe('finishing the upload', () => {
  it('confirms what the bytes turned out to be, stamps the moment and files it, and leaves the person the one who sent it', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest(), { size: 2_000 }));
    const pending = await assetRow(started.asset_id);

    expect(await confirm(ids.portalA1, started.asset_id, { size: 1_900, width: 800, height: 600 })).toEqual({ outcome: 'confirmed', reason: null });

    const row = await assetRow(started.asset_id);
    expect(row).toMatchObject({
      status: 'confirmed', confirmed_size_bytes: '1900', confirmed_content_type: 'image/png', width: 800, height: 600,
      rejected_reason: null, created_by_user_id: ids.portalA1, uploaded_by_side: 'client'
    });
    expect(row.confirmed_at).toBeInstanceOf(Date);
    expect(row.filed_at).toBeInstanceOf(Date);
    expect((row.updated_at as Date).getTime()).toBeGreaterThan((pending.updated_at as Date).getTime());
  });

  it('records the type of the bytes as the database spells it, without the case or the parameters the reader gave', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest()));

    expect(await confirm(ids.portalA1, started.asset_id, { type: ' IMAGE/PNG; charset=binary ' })).toEqual({ outcome: 'confirmed', reason: null });
    expect(await assetRow(started.asset_id)).toMatchObject({ confirmed_content_type: 'image/png' });
  });

  it('confirms an audio, which has no dimensions', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest(), { type: 'audio/mpeg' }));

    expect(await confirm(ids.portalA1, started.asset_id, { type: 'audio/mpeg', width: null, height: null })).toEqual({ outcome: 'confirmed', reason: null });
    expect(await assetRow(started.asset_id)).toMatchObject({ status: 'confirmed', width: null, height: null, category: 'audio' });
  });

  it.each([
    ['an empty object', { size: 0 }, 'empty_object'],
    ['no size', { size: null }, 'empty_object'],
    ['a type that is not the one declared', { type: 'image/jpeg' }, 'content_type_mismatch'],
    ['a type that is not accepted at all', { type: 'image/svg+xml' }, 'content_type_mismatch'],
    ['an audio where an image was declared', { type: 'audio/mpeg' }, 'content_type_mismatch'],
    ['no type', { type: null }, 'content_type_mismatch'],
    ['a file above the ceiling', { size: MAX_BYTES + 1 }, 'too_large'],
    ['a width with no height', { height: null }, 'invalid_dimensions'],
    ['a height with no width', { width: null }, 'invalid_dimensions'],
    ['a width of zero', { width: 0 }, 'invalid_dimensions'],
    ['a height of zero', { height: 0 }, 'invalid_dimensions'],
    ['a width beyond a hundred thousand', { width: 100_001 }, 'invalid_dimensions'],
    ['a height beyond a hundred thousand', { height: 100_001 }, 'invalid_dimensions']
  ] as const)('turns down %s and records why, so the reservation does not hang', async (_label, over, reason) => {
    const started = await start(ids.portalA1, startArgs(await openRequest()));

    expect(await confirm(ids.portalA1, started.asset_id, over)).toEqual({ outcome: 'rejected', reason });

    expect(await assetRow(started.asset_id)).toMatchObject({ status: 'rejected', rejected_reason: reason, confirmed_at: null, filed_at: null });
  });

  it('turns down an audio that came with dimensions', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest(), { type: 'audio/ogg' }));

    expect(await confirm(ids.portalA1, started.asset_id, { type: 'audio/ogg', width: 10, height: 10 })).toEqual({ outcome: 'rejected', reason: 'invalid_dimensions' });
  });

  it('takes a size at the ceiling and a dimension at a hundred thousand', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest(), { size: MAX_BYTES }));

    expect(await confirm(ids.portalA1, started.asset_id, { size: MAX_BYTES, width: 100_000, height: 1 })).toEqual({ outcome: 'confirmed', reason: null });
  });

  it('looks again at the room of the request and of the agency, which the agency\'s own files shrank after the start', async () => {
    const full = await fresh();
    await seedFilesOfRequest(full, MAX_FILES - 1);
    const lastOne = await start(full.user, startArgs(full.thread, { client: full.client }));
    expect(await confirm(full.user, lastOne.asset_id)).toEqual({ outcome: 'confirmed', reason: null });

    const crowded = await fresh();
    const abandoned = await start(crowded.user, startArgs(crowded.thread, { client: crowded.client }));
    await owner()('media_assets').where({ id: abandoned.asset_id }).update({ updated_at: owner().raw(`now() - interval '2 hours'`) });
    await seedFilesOfRequest(crowded, MAX_FILES);
    expect(await confirm(crowded.user, abandoned.asset_id)).toEqual({ outcome: 'rejected', reason: 'request_full' });

    const tight = await fresh();
    await setQuota(tight.agency, 2 * MAX_BYTES, null);
    const declaredSmall = await start(tight.user, startArgs(tight.thread, { client: tight.client, size: 100 }));
    await seed(tight.client, tight.agency, { size: MAX_BYTES + 1 });
    expect(await confirm(tight.user, declaredSmall.asset_id, { size: 2_000 })).toEqual({ outcome: 'rejected', reason: 'agency_unavailable' });
  });

  it('takes a confirmation that lands exactly on the ceiling of bytes or of files, the agency\'s own files counted and its own reservation not', async () => {
    const bytes = await fresh();
    await setQuota(bytes.agency, 2 * MAX_BYTES, null);
    const reserved = await start(bytes.user, startArgs(bytes.thread, { client: bytes.client, size: MAX_BYTES }));
    await seed(bytes.client, bytes.agency, { size: MAX_BYTES });
    expect(await confirm(bytes.user, reserved.asset_id, { size: MAX_BYTES })).toEqual({ outcome: 'confirmed', reason: null });

    const count = await fresh();
    await setQuota(count.agency, null, 2);
    const one = await start(count.user, startArgs(count.thread, { client: count.client }));
    await seed(count.client, count.agency);
    expect(await confirm(count.user, one.asset_id)).toEqual({ outcome: 'confirmed', reason: null });

    const over = await fresh();
    await setQuota(over.agency, null, 1);
    const crowded = await start(over.user, startArgs(over.thread, { client: over.client }));
    await owner()('media_assets').where({ id: crowded.asset_id }).update({ updated_at: owner().raw(`now() - interval '2 hours'`) });
    await seed(over.client, over.agency);
    expect(await confirm(over.user, crowded.asset_id)).toEqual({ outcome: 'rejected', reason: 'agency_unavailable' });
  });

  // The answer must not depend on the real size of the bytes either: the person chooses what she uploads, and then lets the reservation go.
  it.each([1, 1_000, MAX_BYTES - 1])('turns down every size at the confirmation when the agency has %i bytes left, the room left and the byte above it included', async (room) => {
    const f = await fresh();
    await setQuota(f.agency, 4 * MAX_BYTES, null);
    const sizes = [...new Set([1, room, room + 1, MAX_BYTES])];
    // A window of no seconds so that the other reservations count for nothing and every size meets the same room.
    const reserved = await Promise.all(sizes.map(() => start(f.user, startArgs(f.thread, { client: f.client, size: 1, window: 0 }))));
    await seed(f.client, f.agency, { size: 4 * MAX_BYTES - room });

    for (const [index, size] of sizes.entries()) {
      expect(await confirm(f.user, reserved[index]!.asset_id, { size, window: 0 }), `size ${size}`).toEqual({ outcome: 'rejected', reason: 'agency_unavailable' });
      expect(await assetRow(reserved[index]!.asset_id)).toMatchObject({ status: 'rejected', rejected_reason: 'agency_unavailable' });
    }
  });

  it.each([MAX_BYTES, MAX_BYTES + 1, 3 * MAX_BYTES])('takes every size at the confirmation up to the ceiling when the agency has %i bytes left, its own reservation not counted', async (room) => {
    for (const size of [1, MAX_BYTES]) {
      const f = await fresh();
      await setQuota(f.agency, 4 * MAX_BYTES, null);
      const reserved = await start(f.user, startArgs(f.thread, { client: f.client, size: 1 }));
      await seed(f.client, f.agency, { size: 4 * MAX_BYTES - room });

      expect(await confirm(f.user, reserved.asset_id, { size }), `size ${size}`).toEqual({ outcome: 'confirmed', reason: null });
    }
  });

  it('gives the reason of every refusal in words that say nothing of the plan or the storage of the agency, and the contract names the same reasons', async () => {
    const refusals: Array<{ verdict: Verdict; row: Record<string, unknown> }> = [];
    const refused = async (f: Fresh, assetId: string, over: Partial<ConfirmArgs> = {}): Promise<void> => {
      refusals.push({ verdict: await confirm(f.user, assetId, over), row: await assetRow(assetId) });
    };
    const startFor = (f: Fresh, size = 1_000): Promise<Started> => start(f.user, startArgs(f.thread, { client: f.client, size }));

    const bytes = await fresh();
    await refused(bytes, (await startFor(bytes)).asset_id, { size: 0 });
    const type = await fresh();
    await refused(type, (await startFor(type)).asset_id, { type: 'image/jpeg' });
    const large = await fresh();
    await refused(large, (await startFor(large)).asset_id, { size: MAX_BYTES + 1 });
    const dimensions = await fresh();
    await refused(dimensions, (await startFor(dimensions)).asset_id, { width: 0, height: 10 });

    const full = await fresh();
    const abandoned = await startFor(full);
    await owner()('media_assets').where({ id: abandoned.asset_id }).update({ updated_at: owner().raw(`now() - interval '2 hours'`) });
    await seedFilesOfRequest(full, MAX_FILES);
    await refused(full, abandoned.asset_id);

    const tight = await fresh();
    await setQuota(tight.agency, 2 * MAX_BYTES, null);
    const small = await startFor(tight, 100);
    await seed(tight.client, tight.agency, { size: MAX_BYTES + 1 });
    await refused(tight, small.asset_id, { size: 2_000 });

    expect(refusals.map(({ verdict }) => verdict.outcome)).toEqual(Array(6).fill('rejected'));
    const reasons = refusals.map(({ verdict }) => verdict.reason as string);
    expect([...reasons].sort()).toEqual([...PortalMaterialUploadRejectionReasonSchema.options].sort());
    for (const { verdict, row } of refusals) {
      expect(verdict.reason).not.toMatch(/quota|plan|storage|limit/i);
      expect(row.rejected_reason).toBe(verdict.reason);
    }
  });

  it('is finished by the person who sent it and by nobody else, with the one answer of a file that is not there', async () => {
    const thread = await openRequest();
    const sent = await start(ids.portalA1, startArgs(thread));
    const agencyMedia = await seed(ids.clientA1, ids.agencyA, { status: 'pending' });

    for (const user of [ids.portalA1Second, ids.dualBare, ids.dualFull, ids.crossDual, ids.portalA2, ids.portalB, ids.adminA, ids.ownerA, ids.dualRemoved]) {
      await expect(confirm(user, sent.asset_id), `confirm ${user}`).rejects.toMatchObject({ code: 'A0130' });
      await expect(rejectUpload(user, sent.asset_id, 'abandoned'), `reject ${user}`).rejects.toMatchObject({ code: 'A0130' });
    }
    // A collaborator who also holds the link is the creator of an agency upload of the same client: it is still not a file of the portal.
    const collaboratorMedia = await seed(ids.clientA1, ids.agencyA, { status: 'pending', user: ids.dualFull });
    await expect(confirm(ids.adminA, agencyMedia)).rejects.toMatchObject({ code: 'A0130' });
    await expect(confirm(ids.portalA1, agencyMedia)).rejects.toMatchObject({ code: 'A0130' });
    await expect(confirm(ids.dualFull, collaboratorMedia)).rejects.toMatchObject({ code: 'A0130' });
    await expect(rejectUpload(ids.dualFull, collaboratorMedia, 'abandoned')).rejects.toMatchObject({ code: 'A0130' });
    await expect(confirm(ids.portalA1, randomUUID())).rejects.toMatchObject({ code: 'A0130' });
    expect(await assetRow(sent.asset_id)).toMatchObject({ status: 'pending' });
    expect(await assetRow(agencyMedia)).toMatchObject({ status: 'pending' });
    expect(await assetRow(collaboratorMedia)).toMatchObject({ status: 'pending' });
  });

  it('is finished once: a file that was confirmed or rejected answers A0135, and keeps what it was', async () => {
    const thread = await openRequest();
    const confirmed = await start(ids.portalA1, startArgs(thread));
    await confirm(ids.portalA1, confirmed.asset_id);
    const rejected = await start(ids.portalA1, startArgs(thread));
    await rejectUpload(ids.portalA1, rejected.asset_id, 'object_missing');

    for (const asset of [confirmed.asset_id, rejected.asset_id]) {
      await expect(confirm(ids.portalA1, asset)).rejects.toMatchObject({ code: 'A0135' });
      await expect(rejectUpload(ids.portalA1, asset, 'abandoned')).rejects.toMatchObject({ code: 'A0135' });
    }
    expect(await assetRow(confirmed.asset_id)).toMatchObject({ status: 'confirmed', rejected_reason: null });
    expect(await assetRow(rejected.asset_id)).toMatchObject({ status: 'rejected', rejected_reason: 'object_missing' });
  });

  it('is refused for a request resolved meanwhile, an archived client, a suspended or a read-only agency, and the file stays pending', async () => {
    const resolved = await fresh(true);
    const resolvedFile = await start(resolved.user, startArgs(resolved.thread, { client: resolved.client }));
    await owner()('client_threads').where({ id: resolved.thread }).update({ resolved_by: ids.adminA, resolved_at: new Date() });
    await expect(confirm(resolved.user, resolvedFile.asset_id)).rejects.toMatchObject({ code: 'A0131' });

    const archived = await fresh();
    const archivedFile = await start(archived.user, startArgs(archived.thread, { client: archived.client }));
    await archive(archived.client);
    await expect(confirm(archived.user, archivedFile.asset_id)).rejects.toMatchObject({ code: 'A0130' });
    await expect(rejectUpload(archived.user, archivedFile.asset_id, 'abandoned')).rejects.toMatchObject({ code: 'A0130' });

    const suspended = await fresh();
    const suspendedFile = await start(suspended.user, startArgs(suspended.thread, { client: suspended.client }));
    await suspend(suspended.agency);
    await expect(confirm(suspended.user, suspendedFile.asset_id)).rejects.toMatchObject({ code: 'A0130' });

    const readOnly = await fresh();
    const readOnlyFile = await start(readOnly.user, startArgs(readOnly.thread, { client: readOnly.client }));
    await makeReadOnly(readOnly.agency);
    // The trigger of the read-only agency would refuse the write too, in words that speak of its trial: each function answers first, in neutral ones.
    expect(await attempt(() => confirm(readOnly.user, readOnlyFile.asset_id))).toMatchObject(NEUTRAL_READ_ONLY);
    expect(await attempt(() => rejectUpload(readOnly.user, readOnlyFile.asset_id, 'abandoned'))).toMatchObject(NEUTRAL_READ_ONLY);

    for (const asset of [resolvedFile, archivedFile, suspendedFile, readOnlyFile]) expect(await assetRow(asset.asset_id)).toMatchObject({ status: 'pending' });
  });

  it('lets the person let her reservation go with a short code, and nothing else as a reason', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest()));

    // Each class and each end of each range, refused by what is just outside it: the digit, the dot, the dash, the space, the line break and the neighbours of a and z.
    const notACode = [
      null, '', 'Bad Reason', 'Abandoned', '1abandoned', '_abandoned', 'abandoned1', 'abandoned.', 'abandoned-x', 'with space', 'upload-failed', 'abandoned\n',
      '`abandoned', '{abandoned', 'abandoned`', 'abandoned{', 'a'.repeat(41)
    ];
    for (const reason of notACode) {
      await expect(rejectUpload(ids.portalA1, started.asset_id, reason), String(reason)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await assetRow(started.asset_id)).toMatchObject({ status: 'pending' });

    const shortest = await start(ids.portalA1, startArgs(await openRequest()));
    const letters = await start(ids.portalA1, startArgs(await openRequest()));
    await rejectUpload(ids.portalA1, shortest.asset_id, 'a');
    await rejectUpload(ids.portalA1, letters.asset_id, 'az_za');
    expect(await assetRow(shortest.asset_id)).toMatchObject({ rejected_reason: 'a' });
    expect(await assetRow(letters.asset_id)).toMatchObject({ rejected_reason: 'az_za' });

    const pending = await assetRow(started.asset_id);
    await rejectUpload(ids.portalA1, started.asset_id, 'a'.repeat(40));
    const row = await assetRow(started.asset_id);
    expect(row).toMatchObject({ status: 'rejected', rejected_reason: 'a'.repeat(40), confirmed_at: null });
    expect((row.updated_at as Date).getTime()).toBeGreaterThan((pending.updated_at as Date).getTime());
  });

  it('refuses a confirmation with no actor, and the confirmation of a file under another isolation', async () => {
    const started = await start(ids.portalA1, startArgs(await openRequest()));

    await expect(owner().raw(CONFIRM_SQL, [started.asset_id, 1_000, 'image/png', 1, 1, ROOM.defaultBytes, ROOM.defaultCount, WINDOW])).rejects.toMatchObject({ code: '42501' });
    await expect(owner().raw('select app_private.reject_portal_material_upload(?::uuid, ?::text)', [started.asset_id, 'abandoned'])).rejects.toMatchObject({ code: '42501' });
    const transaction = await w.openTransactionAs(ids.portalA1, 'serializable');
    try {
      await expect(confirmIn(transaction, started.asset_id, confirmArgs())).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    const reading = await w.openTransactionAs(ids.portalA1, 'repeatable read');
    try {
      await expect(reading.raw('select app_private.reject_portal_material_upload(?::uuid, ?::text)', [started.asset_id, 'abandoned'])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await reading.rollback();
    }
    for (const over of [{ defaultBytes: null }, { defaultCount: 0 }, { window: null }]) {
      await expect(confirm(ids.portalA1, started.asset_id, over), JSON.stringify(over)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await assetRow(started.asset_id)).toMatchObject({ status: 'pending' });
  });
});

// ---- what the portal reads ---------------------------------------------------------------------------------------------------

describe('what the person of the portal reads of the media', () => {
  it('lists the files she sent to a request, pending or confirmed, and nothing else of the client, oldest first', async () => {
    const thread = await openRequest();
    const pending = await start(ids.portalA1, startArgs(thread));
    const confirmed = await start(ids.portalA1, startArgs(thread));
    await confirm(ids.portalA1, confirmed.asset_id);
    const rejected = await start(ids.portalA1, startArgs(thread));
    await rejectUpload(ids.portalA1, rejected.asset_id, 'abandoned');
    await seed(ids.clientA1, ids.agencyA, { side: 'client', thread, user: ids.portalA1, removed: true });
    await seed(ids.clientA1, ids.agencyA);
    await seed(ids.clientA1, ids.agencyA, { user: ids.portalA1 });
    await start(ids.portalA1, startArgs(await openRequest()));

    expect(await listed(ids.portalA1, ids.clientA1, thread)).toEqual([pending.asset_id, confirmed.asset_id]);
    expect((await list(ids.portalA1, ids.clientA1, thread)).map((row) => row.total_count)).toEqual(['2', '2']);
  });

  it('answers what a listing needs, with the final key of a confirmed file only, and nothing that the staging, the upload or the agency keeps', async () => {
    const thread = await openRequest();
    const pending = await start(ids.portalA1, startArgs(thread, { size: 2_000, name: 'pendente.png' }));
    const confirmed = await start(ids.portalA1, startArgs(thread, { size: 2_000, name: 'pronta.png' }));
    await confirm(ids.portalA1, confirmed.asset_id, { size: 1_900, width: 800, height: 600 });
    const recording = await start(ids.portalA1, startArgs(thread, { type: 'audio/mpeg', size: 5_000, name: 'depoimento.mp3' }));
    await confirm(ids.portalA1, recording.asset_id, { size: 4_800, type: 'audio/mpeg', width: null, height: null });
    await owner()('media_assets').whereIn('id', [pending.asset_id, confirmed.asset_id, recording.asset_id]).update({ alt_text: 'texto-da-agencia', multipart_upload_id: 'multipart-secreto' });

    const rows = await list(ids.portalA1, ids.clientA1, thread);

    expect(rows).toEqual([
      {
        total_count: '3', asset_id: pending.asset_id, status: 'pending', category: 'image', content_type: 'image/png', size_bytes: '2000', file_name: 'pendente.png',
        width: null, height: null, created_at: expect.any(Date), object_key: null
      },
      {
        total_count: '3', asset_id: confirmed.asset_id, status: 'confirmed', category: 'image', content_type: 'image/png', size_bytes: '1900', file_name: 'pronta.png',
        width: 800, height: 600, created_at: expect.any(Date), object_key: confirmed.object_key
      },
      {
        total_count: '3', asset_id: recording.asset_id, status: 'confirmed', category: 'audio', content_type: 'audio/mpeg', size_bytes: '4800', file_name: 'depoimento.mp3',
        width: null, height: null, created_at: expect.any(Date), object_key: recording.object_key
      }
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/staging|upload\.(png|mp3)|texto-da-agencia|multipart-secreto/);
  });

  it.each([
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a collaborator with a link and the Sales role', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('lists nothing of what another person sent: %s gets an empty page', async (_label, user) => {
    const thread = await openRequest();
    await start(ids.portalA1, startArgs(thread));

    expect(await list(user(), ids.clientA1, thread)).toEqual([emptyPage(0)]);
  });

  it.each([
    ['a person of another client of the same agency', () => ids.portalA2],
    ['a person of another agency', () => ids.portalB],
    ['the Admin of the agency, who holds no link to the client', () => ids.adminA],
    ['the Owner of the agency, who holds no link to the client', () => ids.ownerA],
    ['the Admin of another agency, who holds no link here', () => ids.adminB],
    ['a collaborator whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('refuses %s with the one answer of a request that is not there', async (_label, user) => {
    const thread = await openRequest();
    await start(ids.portalA1, startArgs(thread));

    await expect(list(user(), ids.clientA1, thread)).rejects.toMatchObject({ code: 'A0130' });
  });

  it('refuses a request that is not hers to list: another client\'s, a section, one that does not exist', async () => {
    const elsewhere = await openRequest(ids.clientA2);
    const section = randomUUID();
    requests.push(section);
    await owner()('client_threads').insert({ id: section, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });

    await expect(list(ids.portalA1, ids.clientA1, elsewhere)).rejects.toMatchObject({ code: 'A0130' });
    await expect(list(ids.portalA1, ids.clientA2, elsewhere)).rejects.toMatchObject({ code: 'A0130' });
    await expect(list(ids.portalA1, ids.clientA1, section)).rejects.toMatchObject({ code: 'A0130' });
    await expect(list(ids.portalA1, ids.clientA1, randomUUID())).rejects.toMatchObject({ code: 'A0130' });
    await expect(list(ids.portalA1, randomUUID(), elsewhere)).rejects.toMatchObject({ code: 'A0130' });
  });

  it('keeps listing the files she sent while she holds the link to the client, and refuses her with the link gone', async () => {
    const f = await fresh();
    const sent = await start(f.user, startArgs(f.thread, { client: f.client }));
    expect(await listed(f.user, f.client, f.thread)).toEqual([sent.asset_id]);

    // The link that counts is the one to this client: another live link of the same person does not keep the files in sight.
    await owner()('client_memberships').insert({ client_id: ids.clientA2, user_id: f.user });
    await removeAccess(f.client, f.user);
    await expect(list(f.user, f.client, f.thread)).rejects.toMatchObject({ code: 'A0130' });
    expect(await listed(f.other, f.client, f.thread)).toEqual([]);
  });

  it('refuses the person when the client is archived or the agency suspended', async () => {
    const archived = await fresh();
    await start(archived.user, startArgs(archived.thread, { client: archived.client }));
    const suspended = await fresh();
    await start(suspended.user, startArgs(suspended.thread, { client: suspended.client }));
    expect(await listed(archived.user, archived.client, archived.thread)).toHaveLength(1);
    expect(await listed(suspended.user, suspended.client, suspended.thread)).toHaveLength(1);

    await archive(archived.client);
    await suspend(suspended.agency);

    await expect(list(archived.user, archived.client, archived.thread)).rejects.toMatchObject({ code: 'A0130' });
    await expect(list(suspended.user, suspended.client, suspended.thread)).rejects.toMatchObject({ code: 'A0130' });
  });

  it('keeps listing on a resolved request, and on an agency that does not accept writes: reading is not sending', async () => {
    const f = await fresh();
    const sent = await start(f.user, startArgs(f.thread, { client: f.client }));
    await owner()('client_threads').where({ id: f.thread }).update({ resolved_by: ids.adminA, resolved_at: new Date() });
    await makeReadOnly(f.agency);

    expect(await listed(f.user, f.client, f.thread)).toEqual([sent.asset_id]);
  });

  it('pages by the order of arrival with the id as the tie, and the total of her files comes with every page, past the end too', async () => {
    const f = await fresh();
    const byId: string[] = [];
    for (let index = 0; index < 6; index += 1) byId.push(await seed(f.client, f.agency, { side: 'client', thread: f.thread, user: f.user, size: 10 }));
    byId.sort();
    // Arrival does not follow the ids, and two pairs arrived together: the third file came first, the pairs are told apart by their ids. The
    // rows are rewritten from the last id to the first, so a tie left to the physical order would show up reversed.
    const [now, day] = [Date.now(), 86_400_000];
    const daysAgo = [2, 2, 3, 1, 1, 0.5];
    for (const index of [5, 4, 3, 2, 1, 0]) {
      await owner()('media_assets').where({ id: byId[index] }).update({ created_at: new Date(now - daysAgo[index]! * day) });
    }
    const expected = [byId[2]!, byId[0]!, byId[1]!, byId[3]!, byId[4]!, byId[5]!];

    const pages = [await list(f.user, f.client, f.thread, 2, 0), await list(f.user, f.client, f.thread, 2, 2), await list(f.user, f.client, f.thread, 2, 4)];

    expect(pages.map((page) => page.map((row) => row.asset_id))).toEqual([expected.slice(0, 2), expected.slice(2, 4), expected.slice(4)]);
    expect(pages.flat().map((row) => row.total_count)).toEqual(Array(6).fill('6'));
    expect(await list(f.user, f.client, f.thread, 2, 6)).toEqual([emptyPage(6)]);
    expect(await list(f.user, f.client, f.thread, 100, 1_000_000_000_000)).toEqual([emptyPage(6)]);
    expect((await list(f.user, f.client, f.thread, 100, 5)).map((row) => row.asset_id)).toEqual([expected[5]]);
    expect((await list(f.user, f.client, f.thread, 1, 0)).map((row) => row.asset_id)).toEqual([expected[0]]);
    expect((await list(f.user, f.client, f.thread, 100, 0)).map((row) => row.asset_id)).toEqual(expected);
  });

  it('refuses a page that is not one to a hundred files from a position of zero or more, and a call with no actor bound', async () => {
    const thread = await openRequest();
    for (const [limit, offset] of [[0, 0], [101, 0], [-1, 0], [null, 0], [10, -1], [10, null]] as const) {
      await expect(list(ids.portalA1, ids.clientA1, thread, limit, offset), `${limit} ${offset}`).rejects.toMatchObject({ code: '22023' });
    }
    expect(await list(ids.portalA1, ids.clientA1, thread, 100, 0)).toEqual([emptyPage(0)]);
    await expect(owner().raw(LIST_SQL, [ids.clientA1, thread, 10, 0])).rejects.toMatchObject({ code: '42501' });
  });

  it('is the only way in: the table of the media shows the portal no row at all, not even the files she sent, and no column of them', async () => {
    const thread = await openRequest();
    const pending = await start(ids.portalA1, startArgs(thread));
    const confirmed = await start(ids.portalA1, startArgs(thread));
    await confirm(ids.portalA1, confirmed.asset_id);

    expect(await visible(ids.portalA1, [pending.asset_id, confirmed.asset_id])).toEqual([]);
    expect(await w.asUser(ids.portalA1, (t) => t('media_assets').whereIn('id', [pending.asset_id, confirmed.asset_id]).select('upload_object_key', 'object_key', 'multipart_upload_id'))).toEqual([]);
    expect(await w.asUser(ids.portalA1, async (t) => (await t.raw<{ rows: Array<{ n: string }> }>('select count(*)::text as n from public.media_assets where client_id = ?::uuid', [ids.clientA1])).rows[0])).toEqual({ n: '0' });
  });

  it('reads the media of the agency as the agency does: the files of the client are seen by who sees the rest of that client\'s library', async () => {
    const sent = await start(ids.portalA1, startArgs(await openRequest()));
    await confirm(ids.portalA1, sent.asset_id);
    const agencyMedia = await seed(ids.clientA1, ids.agencyA);
    const readers = [
      ids.adminA, ids.ownerA, ids.productionA, ids.managerA, ids.salesA, ids.financeA, ids.adminB, ids.portalA2,
      await w.personWith('conteudo.visualizar'), await w.personWith('midia.enviar'), await w.personWith('conteudo.operar')
    ];

    const seen = new Set<string>();
    for (const user of readers) {
      const theirs = await visible(user, [sent.asset_id, agencyMedia]);
      expect(theirs.includes(sent.asset_id), user).toBe(theirs.includes(agencyMedia));
      if (theirs.includes(sent.asset_id)) seen.add(user);
    }
    expect(seen.has(ids.adminA)).toBe(true);
    expect(seen.has(ids.adminB)).toBe(false);
    expect(seen.has(readers[9]!)).toBe(false);
    expect(seen.has(readers[8]!)).toBe(true);
  });

  it('writes nothing: the update reaches no row, the delete is not granted, and the insert is refused by the row-level policy', async () => {
    const sent = await start(ids.portalA1, startArgs(await openRequest()));
    await confirm(ids.portalA1, sent.asset_id);
    const before = await assetRow(sent.asset_id);
    const id = randomUUID();

    expect(await w.asUser(ids.portalA1, (t) => t('media_assets').where({ id: sent.asset_id }).update({ file_name: 'trocado.png' }))).toBe(0);
    expect(await w.asUser(ids.portalA1, (t) => t('media_assets').where({ id: sent.asset_id }).update({ status: 'rejected', rejected_reason: 'abandoned' }))).toBe(0);
    expect(await w.asUser(ids.portalA1, (t) => t('media_assets').where({ id: sent.asset_id }).update({ alt_text: 'texto' }))).toBe(0);
    await expect(w.asUser(ids.portalA1, (t) => t('media_assets').where({ id: sent.asset_id }).delete())).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.portalA1, (t) => t('media_assets').insert({
      id, agency_id: ids.agencyA, client_id: ids.clientA1, folder_id: before.folder_id, category: 'image', declared_content_type: 'image/png', extension: 'png',
      object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 10, file_name: 'x.png'
    }))).rejects.toMatchObject(rlsViolation);
    expect(await assetRow(sent.asset_id)).toEqual(before);
  });
});

// ---- the storage usage the agency's routes read ------------------------------------------------------------------------------

describe('the storage usage, counted in one place', () => {
  const usageOf = async (agency: string, window = WINDOW, exclude: string | null = null): Promise<{ used_bytes: string; used_object_count: string }> =>
    (await owner().raw<{ rows: Array<{ used_bytes: string; used_object_count: string }> }>(
      'select * from app_private.agency_storage_in_use(?::uuid, ?::integer, ?::uuid)', [agency, window, exclude]
    )).rows[0]!;

  it('sums the confirmed files and the reservations within the window, and leaves out the rest', async () => {
    const f = await fresh();
    // A confirmed file weighs what its bytes weighed, not what was declared; a pending one weighs what was declared.
    await seed(f.client, f.agency, { size: 1_000, confirmedSize: 1_100 });
    await seed(f.client, f.agency, { size: 2_000, status: 'pending' });
    const old = await seed(f.client, f.agency, { size: 4_000, status: 'pending', ageSeconds: WINDOW + 60 });
    await seed(f.client, f.agency, { size: 8_000, status: 'rejected' });
    await seed(f.client, f.agency, { size: 16_000, purged: true });
    await seed(f.client, f.agency, { size: 32_000, removed: true });
    const one = await seed(f.client, f.agency, { size: 64_000 });

    expect(await usageOf(f.agency)).toEqual({ used_bytes: '99100', used_object_count: '4' });
    expect(await usageOf(f.agency, WINDOW, one)).toEqual({ used_bytes: '35100', used_object_count: '3' });
    expect(await usageOf(f.agency, WINDOW * 2)).toEqual({ used_bytes: '103100', used_object_count: '5' });
    expect(await usageOf(f.agency, 0)).toEqual({ used_bytes: '97100', used_object_count: '3' });
    expect(await assetRow(old)).toMatchObject({ status: 'pending' });
    expect(await usageOf((await fresh()).agency)).toEqual({ used_bytes: '0', used_object_count: '0' });
  });

  it('is the one number the agency\'s own route reads, through the permission to upload', async () => {
    const asAgency = async (user: string, window: number | null = WINDOW) => w.asUser(user, async (t) =>
      (await t.raw<{ rows: Array<{ used_bytes: string; used_object_count: string }> }>('select * from app_private.agency_media_usage(?::uuid, ?::integer, null)', [ids.agencyA, window])).rows[0]);
    const expected = await usageOf(ids.agencyA);

    expect(await asAgency(ids.adminA)).toEqual(expected);
    expect(await asAgency(await w.personWith('midia.enviar'))).toEqual(expected);
    expect(await asAgency(await w.personWith('conteudo.operar'))).toEqual(expected);
    for (const user of [ids.portalA1, ids.crossDual, ids.adminB, await w.personWith('conteudo.visualizar')]) {
      await expect(asAgency(user), user).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asAgency(ids.adminA, null)).rejects.toMatchObject({ code: '22023' });
    await expect(asAgency(ids.adminA, -1)).rejects.toMatchObject({ code: '22023' });
    await expect(usageOf(ids.agencyA, -1)).rejects.toMatchObject({ code: '22023' });
  });

  it('is not for the application role to call: the helpers of the portal\'s functions are closed to it', async () => {
    const closed = [
      'app_private.agency_storage_in_use(uuid, integer, uuid)',
      'app_private.portal_upload_refusal(uuid, uuid, uuid, bigint, bigint, integer)',
      'app_private.lock_own_pending_portal_upload(uuid)',
      'app_private.require_portal_material_request(uuid, uuid)',
      'app_private.require_portal_upload_settings(bigint, bigint, integer)',
      'app_private.portal_upload_type(text)',
      'app_private.portal_upload_max_bytes()',
      'app_private.portal_upload_max_files()'
    ];
    const open = [
      'app_private.start_portal_material_upload(uuid, uuid, text, bigint, text, bigint, bigint, integer)',
      'app_private.confirm_portal_material_upload(uuid, bigint, text, integer, integer, bigint, bigint, integer)',
      'app_private.reject_portal_material_upload(uuid, text)',
      'app_private.list_portal_material_uploads(uuid, uuid, integer, bigint)'
    ];
    const privileges = async (signature: string) => (await owner().raw<{ rows: Array<{ app: boolean; pub: boolean; definer: boolean; config: string[] | null }> }>(
      `select has_function_privilege('ageniza_app', ?::regprocedure, 'execute') as app, has_function_privilege('public', ?::regprocedure, 'execute') as pub,
              p.prosecdef as definer, p.proconfig as config
       from pg_catalog.pg_proc p where p.oid = ?::regprocedure`, [signature, signature, signature]
    )).rows[0]!;

    for (const signature of closed) expect(await privileges(signature), signature).toMatchObject({ app: false, pub: false });
    for (const signature of open) expect(await privileges(signature), signature).toMatchObject({ app: true, pub: false, definer: true, config: ['search_path=""'] });
    await expect(w.asUser(ids.portalA1, (t) => t.raw('select * from app_private.agency_storage_in_use(?::uuid, 3600, null)', [ids.agencyA]))).rejects.toMatchObject({ code: '42501' });
  });
});

// ---- the races ---------------------------------------------------------------------------------------------------------------

describe('two transactions at once', () => {
  it('lets one file in when the agency has room for one: the second waits for the first, then sees what it took', async () => {
    const f = await fresh();
    await setQuota(f.agency, MAX_BYTES + 500, null);
    const first = await w.openTransactionAs(f.user);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await startIn(first, startArgs(f.thread, { client: f.client, size: 1_000 }));
      second = attempt(() => start(f.other, startArgs(f.thread, { client: f.client, size: 1_000 })));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0136' });
    expect(await filesOf(f.thread)).toHaveLength(1);
  });

  it('queues behind the agency\'s own upload, which holds the same quota lock, for a start and for a confirmation alike', async () => {
    const f = await fresh();
    await setQuota(f.agency, 3 * MAX_BYTES, null);
    const reserved = await start(f.user, startArgs(f.thread, { client: f.client, size: 1_000 }));
    const agencyUpload = await w.openTransactionAs(f.user);
    const agencyUploadPid = await backendPid(agencyUpload);
    let started: Promise<unknown> | undefined;
    let confirmed: Promise<unknown> | undefined;
    try {
      await agencyUpload.raw(`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(('media-quota:' || (?::uuid)::text), 0))`, [f.agency]);
      started = attempt(() => start(f.other, startArgs(f.thread, { client: f.client, size: 100 })));
      confirmed = attempt(() => confirm(f.user, reserved.asset_id));
      await waitForBackendsBlockedBy(owner(), agencyUploadPid, { waiters: 2 });
    } finally {
      await agencyUpload.commit();
    }

    expect(await started).toBe('done');
    expect(await confirmed).toBe('done');
    expect(await filesOf(f.thread)).toHaveLength(2);
    expect(await assetRow(reserved.asset_id)).toMatchObject({ status: 'confirmed' });
  });

  it('lets one file in when the request has room for one', async () => {
    const f = await fresh();
    await seedFilesOfRequest(f, MAX_FILES - 1);
    const first = await w.openTransactionAs(f.user);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await startIn(first, startArgs(f.thread, { client: f.client }));
      second = attempt(() => start(f.other, startArgs(f.thread, { client: f.client })));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0134' });
    expect(await filesOf(f.thread)).toHaveLength(MAX_FILES);
  });

  it('keeps the ceilings under a burst of starts and confirmations that all go for the last places, with no deadlock', async () => {
    const f = await fresh();
    // Room for three more files of a thousand bytes beyond the two reserved: a start is taken while the room left holds one file of the ceiling.
    await setQuota(f.agency, MAX_BYTES + 4_500, null);
    const reserved = [
      await start(f.user, startArgs(f.thread, { client: f.client })),
      await start(f.other, startArgs(f.thread, { client: f.client }))
    ];
    const users = [f.user, f.other];

    const results = await Promise.all([
      ...reserved.map((asset, index) => attempt(() => confirm(users[index]!, asset.asset_id))),
      ...Array.from({ length: 8 }, (_, index) => attempt(() => start(users[index % 2]!, startArgs(f.thread, { client: f.client }))))
    ]);

    const failures = results.filter((result) => typeof result === 'object' && result !== null && 'code' in result);
    expect(failures.map((failure) => (failure as { code: string }).code)).toEqual(Array(5).fill('A0136'));
    expect((await filesOf(f.thread)).filter((file) => file.status === 'confirmed')).toHaveLength(2);
    expect(await filesOf(f.thread)).toHaveLength(5);
  });

  it('keeps the ceiling of the request under a burst, with no deadlock', async () => {
    const f = await fresh();
    await seedFilesOfRequest(f, MAX_FILES - 2);
    const users = [f.user, f.other];

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => attempt(() => start(users[index % 2]!, startArgs(f.thread, { client: f.client })))));

    const failures = results.filter((result) => typeof result === 'object' && result !== null && 'code' in result);
    expect(failures.map((failure) => (failure as { code: string }).code)).toEqual(Array(6).fill('A0134'));
    expect(await filesOf(f.thread)).toHaveLength(MAX_FILES);
  });

  it('waits for the resolution of the request that is in flight, then refuses with A0131, and writes nothing', async () => {
    const f = await fresh(true);
    const resolving = await w.openTransactionAs(ids.adminA);
    const resolvingPid = await backendPid(resolving);
    let outcome: Promise<unknown> | undefined;
    try {
      await resolving('client_threads').where({ id: f.thread }).update({ resolved_by: ids.adminA, resolved_at: new Date() });
      outcome = attempt(() => start(f.user, startArgs(f.thread, { client: f.client })));
      await waitForBackendsBlockedBy(owner(), resolvingPid);
    } finally {
      await resolving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0131' });
    expect(await filesOf(f.thread)).toHaveLength(0);
  });

  it('waits for the archiving of the client that is in flight, then refuses with the answer of a request that is not there', async () => {
    const f = await fresh(true);
    const archiving = await w.openTransactionAs(ids.adminA);
    const archivingPid = await backendPid(archiving);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [f.client]);
      outcome = attempt(() => start(f.user, startArgs(f.thread, { client: f.client })));
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0130' });
    expect(await filesOf(f.thread)).toHaveLength(0);
  });

  it('waits for the resolution and for the archiving that are in flight before it confirms, and the file stays pending', async () => {
    const resolved = await fresh(true);
    const resolvedFile = await start(resolved.user, startArgs(resolved.thread, { client: resolved.client }));
    const resolving = await w.openTransactionAs(ids.adminA);
    const resolvingPid = await backendPid(resolving);
    let resolution: Promise<unknown> | undefined;
    try {
      await resolving('client_threads').where({ id: resolved.thread }).update({ resolved_by: ids.adminA, resolved_at: new Date() });
      resolution = attempt(() => confirm(resolved.user, resolvedFile.asset_id));
      await waitForBackendsBlockedBy(owner(), resolvingPid);
    } finally {
      await resolving.commit();
    }
    expect(await resolution).toMatchObject({ code: 'A0131' });

    const archived = await fresh(true);
    const archivedFile = await start(archived.user, startArgs(archived.thread, { client: archived.client }));
    const archiving = await w.openTransactionAs(ids.adminA);
    const archivingPid = await backendPid(archiving);
    let archival: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [archived.client]);
      archival = attempt(() => confirm(archived.user, archivedFile.asset_id));
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }
    expect(await archival).toMatchObject({ code: 'A0130' });
    for (const file of [resolvedFile, archivedFile]) expect(await assetRow(file.asset_id)).toMatchObject({ status: 'pending' });
  });

  it('finishes a file once when two confirmations come together: the second waits for the file, then finds it finished', async () => {
    const f = await fresh();
    const started = await start(f.user, startArgs(f.thread, { client: f.client }));
    const first = await w.openTransactionAs(f.user);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      expect(await confirmIn(first, started.asset_id, confirmArgs())).toEqual({ outcome: 'confirmed', reason: null });
      second = attempt(() => confirm(f.user, started.asset_id));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0135' });
    expect(await assetRow(started.asset_id)).toMatchObject({ status: 'confirmed' });
  });
});
