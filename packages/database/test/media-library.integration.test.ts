import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';
import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Decisions 2026-11-11 (metadata, rename and move; PDF, audio and SVG as a logo). `media_assets` gains `file_name`, `width`, `height` and
// `alt_text`, the category goes from two values to five, `move_media_asset` is the one writer of the folder, and only a photo or a video enters
// a content. Every attack runs as `ageniza_app`; RLS filters silently, so a write is checked by the state it leaves, and a race is two real
// transactions ordered by the lock the first holds, never by a sleep.
const w = createContentWorld('media-library');
const { ids } = w;

type Category = 'image' | 'video' | 'pdf' | 'audio' | 'logo';
type VideoState = 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed';

const EXTENSION: Record<Category, string> = { image: 'png', video: 'mp4', pdf: 'pdf', audio: 'mp3', logo: 'svg' };
const CONTENT_TYPE: Record<Category, string> = { image: 'image/png', video: 'video/mp4', pdf: 'application/pdf', audio: 'audio/mpeg', logo: 'image/svg+xml' };

const NOT_FOUND = { code: 'A0080' };
const MEDIA_NOT_FOUND = { code: 'A0080', message: expect.stringContaining('Media not found.') };
const ARCHIVED = { code: 'A0081' };
const IN_USE = { code: 'A0082' };
const check = (constraint: string) => ({ code: '23514', constraint });
const trigger = (message: string) => ({ code: '42501', message: expect.stringContaining(message) });
const deniedByGrant = { code: '42501', message: expect.stringContaining('permission denied for table media_assets') };

let operarAndVisualizar: string;
let onlyOperar: string;
let onlyVisualizar: string;
let onlyMidia: string;
const mine: string[] = [];

beforeAll(async () => {
  await w.setup();
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  onlyMidia = await w.personWith('midia.enviar');
});

afterAll(async () => {
  try {
    const knex = w.getOwner().knex;
    await knex('content_media').whereIn('asset_id', mine).delete();
    await knex('contents').whereIn('cover_asset_id', mine).update({ cover_asset_id: null });
    await knex('media_assets').whereIn('id', mine).delete();
  } finally {
    await w.teardown();
  }
});

const agencyOf = (clientId: string | null): string => (clientId === ids.clientB ? ids.agencyB : clientId === ids.clientSuspended ? ids.agencySuspended : ids.agencyA);

interface SeedAsset {
  readonly category?: Category;
  readonly status?: 'pending' | 'confirmed' | 'rejected';
  readonly removed?: boolean;
  readonly clientId?: string | null;
  readonly folderId?: string | null;
  readonly fileName?: string | null;
  readonly altText?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly video?: VideoState;
}

const seed = async (extra: SeedAsset = {}): Promise<string> => {
  const id = randomUUID();
  const category = extra.category ?? 'image';
  // A category the table refuses has no extension of its own.
  const extension = EXTENSION[category] ?? 'bin';
  const contentType = CONTENT_TYPE[category] ?? 'application/octet-stream';
  const clientId = extra.clientId === undefined ? ids.clientA1 : extra.clientId;
  const agencyId = agencyOf(clientId);
  const status = extra.status ?? 'confirmed';
  mine.push(id);
  await w.getOwner().knex('media_assets').insert({
    id,
    agency_id: agencyId,
    client_id: clientId,
    folder_id: clientId === null ? null : extra.folderId === undefined ? await w.folderOf(clientId) : extra.folderId,
    category,
    declared_content_type: contentType,
    extension,
    object_key: `${agencyId}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
    declared_size_bytes: 1_000,
    created_by_user_id: ids.adminA,
    status,
    ...(status === 'confirmed' ? { confirmed_size_bytes: 1_000, confirmed_content_type: contentType, confirmed_at: new Date() } : {}),
    ...(status === 'rejected' ? { rejected_reason: 'content_type_mismatch' } : {}),
    ...(extra.removed === true ? { removed_at: new Date() } : {}),
    ...(extra.fileName === undefined ? {} : { file_name: extra.fileName }),
    ...(extra.altText === undefined ? {} : { alt_text: extra.altText }),
    ...(extra.width === undefined ? {} : { width: extra.width }),
    ...(extra.height === undefined ? {} : { height: extra.height }),
    ...(extra.video === undefined ? {} : { video_processing_status: extra.video })
  });
  return id;
};

const newFolder = async (clientId: string, parentId: string | null = null): Promise<string> => {
  const id = randomUUID();
  await w.getOwner().knex('media_folders').insert({
    id, client_id: clientId, name: `Pasta ${id.slice(0, 8)}`, is_default: false, ...(parentId === null ? {} : { parent_id: parentId })
  });
  return id;
};

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const row = await w.getOwner().knex('media_assets').where({ id }).first();
  if (row === undefined) throw new Error(`Media ${id} does not exist.`);
  return row as Record<string, unknown>;
};

const edit = (user: string, id: string, patch: Record<string, unknown>): Promise<number> =>
  w.asUser(user, (transaction) => transaction('media_assets').where({ id }).update(patch));

// A trial that ended: the agency is still active and reads, and every write is refused by the trigger of the table.
const whileReadOnly = async (work: () => Promise<void>): Promise<void> => {
  const agencies = w.getOwner().knex('agencies').where({ id: ids.agencyA });
  const before = await agencies.clone().first('status', 'plan', 'trial_ends_at', 'trial_owner_email_key');
  await agencies.clone().update({
    plan: 'trial', trial_ends_at: w.getOwner().knex.raw("now() - interval '1 minute'"), trial_owner_email_key: w.getOwner().knex.raw('coalesce(trial_owner_email_key, id::text)')
  });
  try {
    await work();
  } finally {
    await agencies.clone().update(before);
  }
};

const moveAs = async (user: string, assetId: string, folderId: string): Promise<boolean> => {
  const result = await w.asUser(user, (transaction) =>
    transaction.raw<{ rows: Array<{ moved: boolean }> }>('select app_private.move_media_asset(?::uuid, ?::uuid) as moved', [assetId, folderId])
  );
  return result.rows[0]!.moved;
};

describe('the category is one of five, and a logo is the only home of an SVG', () => {
  it.each(['image', 'video', 'pdf', 'audio', 'logo'] as const)('accepts %s', async (category) => {
    const id = await seed({ category });
    expect((await rowOf(id)).category).toBe(category);
  });

  it.each(['document', 'svg', 'IMAGE', '', 'zip', 'other', 'text'])('refuses %j', async (category) => {
    await expect(seed({ category: category as Category })).rejects.toMatchObject(check('media_assets_category_check'));
  });
});

describe('the name of a file is a label, never a path, and never more than 255 characters', () => {
  it.each([
    ['foto.png'], ['Foto de capa (1).jpg'], ['ação-ç.png'], ['😀.png'], ['.hidden'], ['a..b'], ['a'.repeat(255)]
  ])('stores %j', async (fileName) => {
    const id = await seed({ fileName });
    expect((await rowOf(id)).file_name).toBe(fileName);
  });

  it.each([
    ['empty', ''],
    ['a leading space', ' foto.png'],
    ['a trailing space', 'foto.png '],
    ['a slash', 'dir/foto.png'],
    ['a path up', '../../foto.png'],
    ['a backslash', 'dir\\foto.png'],
    ['a drive', 'C:\\temp\\foto.png'],
    ['dots only', '..'],
    ['a single dot', '.'],
    ['a newline', 'foto\n.png'],
    ['a tab', 'foto\t.png'],
    ['a bell', 'foto\u0007.png'],
    ['a delete character', 'foto\u007f.png'],
    ['a C1 control', 'foto\u0085.png'],
    ['a right-to-left override', 'foto\u202Egnp.exe'],
    ['a left-to-right mark', 'foto\u200E.png'],
    ['an isolate', 'foto\u2066.png'],
    ['a byte order mark', 'foto\uFEFF.png'],
    ['256 characters', 'a'.repeat(256)]
  ])('refuses %s', async (_label, fileName) => {
    await expect(seed({ fileName })).rejects.toMatchObject(check('media_assets_file_name_shape'));
  });

  it('keeps the object key out of the name: the key is built from the ids and the extension alone', async () => {
    const id = randomUUID();
    mine.push(id);
    await expect(w.getOwner().knex('media_assets').insert({
      id, agency_id: ids.agencyA, client_id: ids.clientA1, folder_id: await w.folderOf(ids.clientA1), category: 'image',
      declared_content_type: 'image/png', extension: 'png', object_key: `${ids.agencyA}/${id}/foto.png`,
      upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 1_000, file_name: 'foto.png', created_by_user_id: ids.adminA
    })).rejects.toMatchObject(check('media_assets_object_key_shape'));
  });
});

describe('the alternative text is up to 500 characters of one line', () => {
  it.each([['Fachada da loja, de manhã'], ['a'.repeat(500)], ['ç'.repeat(500)]])('stores %j', async (altText) => {
    const id = await seed({ altText });
    expect((await rowOf(id)).alt_text).toBe(altText);
  });

  it.each([
    ['empty', ''],
    ['501 characters', 'a'.repeat(501)],
    ['a newline', 'linha\nquebrada'],
    ['a control character', 'texto\u0001'],
    ['a right-to-left override', 'texto\u202Egnp']
  ])('refuses %s', async (_label, altText) => {
    await expect(seed({ altText })).rejects.toMatchObject(check('media_assets_alt_text_shape'));
  });
});

describe('the dimensions are two positive numbers, together, of an image, a video or a logo', () => {
  it.each([[1, 1], [3024, 4032], [100_000, 100_000]])('stores %i x %i', async (width, height) => {
    const id = await seed({ width, height });
    expect(await rowOf(id)).toMatchObject({ width, height });
  });

  it.each([
    ['a width without a height', 100, null],
    ['a height without a width', null, 100],
    ['a zero width', 0, 10],
    ['a zero height', 10, 0],
    ['a negative width', -1, 10],
    ['a width over 100000', 100_001, 10],
    ['a height over 100000', 10, 100_001]
  ])('refuses %s', async (_label, width, height) => {
    await expect(seed({ width, height })).rejects.toMatchObject(check('media_assets_dimensions_shape'));
  });

  it.each(['video', 'logo'] as const)('stores the dimensions of a %s', async (category) => {
    const id = await seed({ category, width: 640, height: 480 });
    expect(await rowOf(id)).toMatchObject({ width: 640, height: 480 });
  });

  it.each(['pdf', 'audio'] as const)('refuses the dimensions of a %s', async (category) => {
    await expect(seed({ category, width: 640, height: 480 })).rejects.toMatchObject(check('media_assets_dimensions_category'));
  });
});

describe('who writes the new columns (grants)', () => {
  it('lets the application insert the name of the file at the upload, and no other new column', async () => {
    const id = randomUUID();
    mine.push(id);
    const folderId = await w.folderOf(ids.clientA1);
    const insert = (extra: Record<string, unknown>) => w.asUser(operarAndVisualizar, (transaction) => transaction('media_assets').insert({
      id: randomUUID(), agency_id: ids.agencyA, client_id: ids.clientA1, folder_id: folderId, category: 'image', declared_content_type: 'image/png',
      extension: 'png', object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`,
      declared_size_bytes: 1_000, ...extra
    }));

    for (const extra of [{ alt_text: 'texto' }, { width: 10, height: 10 }, { width: 10 }]) {
      await expect(insert(extra)).rejects.toMatchObject(deniedByGrant);
    }

    await w.asUser(operarAndVisualizar, (transaction) => transaction('media_assets').insert({
      id, agency_id: ids.agencyA, client_id: ids.clientA1, folder_id: folderId, category: 'pdf', declared_content_type: 'application/pdf',
      extension: 'pdf', object_key: `${ids.agencyA}/${id}/original.pdf`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.pdf`,
      declared_size_bytes: 1_000, file_name: 'Briefing.pdf'
    }));
    expect(await rowOf(id)).toMatchObject({ file_name: 'Briefing.pdf', alt_text: null, width: null, height: null, created_by_user_id: operarAndVisualizar });
  });

  it('refuses to the application the update of the folder and the category, which stay with the function and the upload', async () => {
    const id = await seed();
    const other = await newFolder(ids.clientA1);
    await expect(edit(ids.adminA, id, { folder_id: other })).rejects.toMatchObject(deniedByGrant);
    await expect(edit(ids.adminA, id, { category: 'pdf' })).rejects.toMatchObject(deniedByGrant);
    expect(await rowOf(id)).toMatchObject({ category: 'image' });
  });
});

describe('renaming a media and editing its alternative text', () => {
  it.each([
    ['the Admin', () => ids.adminA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar],
    ['the Owner of the agency, by ownership', () => ids.ownerA]
  ] as const)('lets %s change both', async (_label, user) => {
    const id = await seed({ fileName: 'antes.png' });

    expect(await edit(user(), id, { file_name: 'depois.png', alt_text: 'Texto novo' })).toBe(1);

    expect(await rowOf(id)).toMatchObject({ file_name: 'depois.png', alt_text: 'Texto novo' });
  });

  it('clears the alternative text with null, and names a media that had no name', async () => {
    const id = await seed({ altText: 'Texto' });
    expect(await edit(ids.adminA, id, { alt_text: null, file_name: 'nova.png' })).toBe(1);
    expect(await rowOf(id)).toMatchObject({ alt_text: null, file_name: 'nova.png' });
  });

  it.each([
    ['a role with only conteudo.operar, which cannot read the row it writes', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only midia.enviar, which is the library of the agency and not of a client', () => onlyMidia],
    ['Sales', () => ids.salesA],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('refuses %s, leaving the row', async (_label, user) => {
    const id = await seed({ fileName: 'antes.png', altText: 'Antes' });

    expect(await edit(user(), id, { file_name: 'invadido.png', alt_text: 'Invadido' })).toBe(0);

    expect(await rowOf(id)).toMatchObject({ file_name: 'antes.png', alt_text: 'Antes' });
  });

  it('refuses a name or a text that breaks the shape, leaving the row', async () => {
    const id = await seed({ fileName: 'antes.png', altText: 'Antes' });
    await expect(edit(ids.adminA, id, { file_name: '../x.png' })).rejects.toMatchObject(check('media_assets_file_name_shape'));
    await expect(edit(ids.adminA, id, { file_name: 'a'.repeat(256) })).rejects.toMatchObject(check('media_assets_file_name_shape'));
    await expect(edit(ids.adminA, id, { alt_text: 'a'.repeat(501) })).rejects.toMatchObject(check('media_assets_alt_text_shape'));
    expect(await rowOf(id)).toMatchObject({ file_name: 'antes.png', alt_text: 'Antes' });
  });

  it('refuses the rename of a media of an archived client, with the same code as every other edit of a child', async () => {
    const folder = await w.folderOf(ids.clientArchived);
    const id = await seed({ clientId: ids.clientArchived, folderId: folder, fileName: 'antes.png' });
    await w.archiveClient(ids.clientArchived);
    try {
      await expect(edit(ids.adminA, id, { file_name: 'depois.png' })).rejects.toMatchObject({ code: 'A0020' });
      await expect(edit(ids.adminA, id, { alt_text: 'Texto' })).rejects.toMatchObject({ code: 'A0020' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await rowOf(id)).toMatchObject({ file_name: 'antes.png', alt_text: null });
  });

  it('refuses the rename in an agency that is read-only, and finds nothing to rename in a suspended one', async () => {
    const id = await seed({ fileName: 'antes.png' });
    await whileReadOnly(async () => {
      await expect(edit(ids.adminA, id, { file_name: 'depois.png' })).rejects.toMatchObject({ code: 'A0090' });
      await expect(edit(ids.adminA, id, { alt_text: 'Texto' })).rejects.toMatchObject({ code: 'A0090' });
    });
    const suspended = await seed({ clientId: ids.clientSuspended, folderId: await w.folderOf(ids.clientSuspended), fileName: 'antes.png' });
    expect(await edit(ids.adminSuspended, suspended, { file_name: 'depois.png' })).toBe(0);
    expect(await rowOf(id)).toMatchObject({ file_name: 'antes.png', alt_text: null });
    expect(await rowOf(suspended)).toMatchObject({ file_name: 'antes.png' });
    expect(await edit(ids.adminA, id, { file_name: 'depois.png' })).toBe(1);
  });

  it('serializes with the archive: a rename that holds the client makes the archive wait, and a rename after the archive is refused', async () => {
    const id = await seed({ clientId: ids.clientArchived, folderId: await w.folderOf(ids.clientArchived), fileName: 'antes.png' });
    const renamer = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await renamer('media_assets').where({ id }).update({ file_name: 'depois.png' });
      const holderPid = await backendPid(renamer);

      const archive = w.archiveClient(ids.clientArchived);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await renamer.commit();
      released = true;
      await archive;
    } finally {
      if (!released) await renamer.rollback();
      await w.reactivateClient(ids.clientArchived);
    }
    expect((await rowOf(id)).file_name).toBe('depois.png');
  });

  it('does not let a rename slip in behind an archive that has not committed yet', async () => {
    const id = await seed({ clientId: ids.clientArchived, folderId: await w.folderOf(ids.clientArchived), fileName: 'antes.png' });
    const archiver = await w.getOwner().knex.transaction();
    let released = false;
    try {
      await archiver('clients').where({ id: ids.clientArchived }).update({ status: 'archived', archived_at: new Date() });
      const holderPid = await backendPid(archiver);

      const rename = edit(ids.adminA, id, { file_name: 'depois.png' });
      const outcome = rename.then(() => 'renamed', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await archiver.commit();
      released = true;
      expect(await outcome).toBe('A0020');
    } finally {
      if (!released) await archiver.rollback();
      await w.reactivateClient(ids.clientArchived);
    }
    expect((await rowOf(id)).file_name).toBe('antes.png');
  });
});

describe('the dimensions are written once, with the confirmation of an image or the end of the processing of a video', () => {
  const confirm = (user: string, id: string, extra: Record<string, unknown> = {}) =>
    edit(user, id, { status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', ...extra });

  const finish = (user: string, id: string, extra: Record<string, unknown> = {}) => edit(user, id, {
    video_processing_status: 'ready', thumbnail_object_key: `${ids.agencyA}/${id}/thumbnail.jpg`, preview_object_key: `${ids.agencyA}/${id}/preview.mp4`,
    video_duration_seconds: 12.5, video_thumbnail_size_bytes: 1_000, video_preview_size_bytes: 2_000, video_processed_at: new Date(), ...extra
  });

  it.each(['image', 'logo'] as const)('takes the dimensions of a %s with its confirmation', async (category) => {
    const id = await seed({ category, status: 'pending' });
    expect(await confirm(operarAndVisualizar, id, { width: 3024, height: 4032 })).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: 'confirmed', width: 3024, height: 4032 });
  });

  it('takes the dimensions of a video with the end of its processing', async () => {
    const id = await seed({ category: 'video', video: 'processing' });
    expect(await finish(operarAndVisualizar, id, { width: 1920, height: 1080 })).toBe(1);
    expect(await rowOf(id)).toMatchObject({ video_processing_status: 'ready', width: 1920, height: 1080 });
  });

  it('still confirms an image and finishes a video without any dimension', async () => {
    const image = await seed({ status: 'pending' });
    const video = await seed({ category: 'video', video: 'processing' });
    expect(await confirm(operarAndVisualizar, image)).toBe(1);
    expect(await finish(operarAndVisualizar, video)).toBe(1);
    expect(await rowOf(image)).toMatchObject({ width: null, height: null });
  });

  it('refuses the dimensions of an upload that is still pending, and of one that is rejected', async () => {
    const pending = await seed({ status: 'pending' });
    const rejected = await seed({ status: 'rejected' });
    for (const id of [pending, rejected]) {
      await expect(edit(operarAndVisualizar, id, { width: 10, height: 10 })).rejects.toMatchObject(trigger('written with the confirmation'));
    }
    expect(await rowOf(pending)).toMatchObject({ width: null, height: null });
  });

  it('refuses the dimensions of a confirmed image afterwards, when they were never written', async () => {
    const id = await seed();
    await expect(edit(operarAndVisualizar, id, { width: 10, height: 10 })).rejects.toMatchObject(trigger('written with the confirmation'));
    expect(await rowOf(id)).toMatchObject({ width: null, height: null });
  });

  it('refuses to rewrite or clear dimensions that were written', async () => {
    const id = await seed({ width: 100, height: 200 });
    await expect(edit(operarAndVisualizar, id, { width: 300, height: 400 })).rejects.toMatchObject(trigger('written once'));
    await expect(edit(operarAndVisualizar, id, { width: null, height: null })).rejects.toMatchObject(trigger('written once'));
    expect(await rowOf(id)).toMatchObject({ width: 100, height: 200 });
  });

  it('refuses one of the two on its own, and a clear on a media that had none', async () => {
    const id = await seed({ status: 'pending' });
    await expect(confirm(operarAndVisualizar, id, { width: 10 })).rejects.toMatchObject(trigger('written once, together'));
    await expect(confirm(operarAndVisualizar, id, { height: 10 })).rejects.toMatchObject(trigger('written once, together'));
    expect(await rowOf(id)).toMatchObject({ status: 'pending', width: null });
  });

  it('refuses the dimensions of a video at its confirmation, before it is processed', async () => {
    const id = await seed({ category: 'video', status: 'pending' });
    await expect(confirm(operarAndVisualizar, id, { confirmed_content_type: 'video/mp4', width: 10, height: 10, video_processing_status: 'pending' }))
      .rejects.toMatchObject(trigger('written with the confirmation'));
  });

  it('refuses the dimensions of a video outside the move from processing to ready', async () => {
    const started = await seed({ category: 'video', video: 'processing' });
    const ready = await seed({ category: 'video', video: 'processing' });
    expect(await finish(operarAndVisualizar, ready)).toBe(1);

    await expect(edit(operarAndVisualizar, started, { width: 10, height: 10 })).rejects.toMatchObject(trigger('written with the confirmation'));
    await expect(edit(operarAndVisualizar, ready, { width: 10, height: 10 })).rejects.toMatchObject(trigger('written with the confirmation'));
  });

  it('refuses to confirm a video and to finish its processing in one write, with its dimensions or without', async () => {
    for (const dimensions of [{ width: 10, height: 10 }, {}]) {
      const id = await seed({ category: 'video', status: 'pending', video: 'processing' });
      await expect(finish(operarAndVisualizar, id, { status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'video/mp4', ...dimensions }))
        .rejects.toMatchObject({ code: '42501' });
      expect(await rowOf(id)).toMatchObject({ status: 'pending', video_processing_status: 'processing', width: null });
    }
  });

  it('refuses the dimensions of a pdf or of an audio at the confirmation, which they do not have', async () => {
    for (const category of ['pdf', 'audio'] as const) {
      const id = await seed({ category, status: 'pending' });
      await expect(confirm(operarAndVisualizar, id, { confirmed_content_type: CONTENT_TYPE[category], width: 10, height: 10 }))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
      expect(await rowOf(id)).toMatchObject({ status: 'pending', width: null });
    }
  });
});

describe('moving a media to another folder of the same client', () => {
  const scene = async (extra: SeedAsset = {}) => {
    const from = await newFolder(ids.clientA1);
    const to = await newFolder(ids.clientA1);
    return { from, to, asset: await seed({ folderId: from, ...extra }) };
  };

  it.each([
    ['the Admin', () => ids.adminA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s move it, and says it changed the folder', async (_label, user) => {
    const { asset, to } = await scene({ fileName: 'a.png', altText: 'Texto' });
    const before = await rowOf(asset);

    expect(await moveAs(user(), asset, to)).toBe(true);

    const after = await rowOf(asset);
    expect(after.folder_id).toBe(to);
    expect(after).toMatchObject({ file_name: 'a.png', alt_text: 'Texto', object_key: before.object_key, status: 'confirmed', client_id: ids.clientA1 });
    expect((after.updated_at as Date).getTime()).toBeGreaterThan((before.updated_at as Date).getTime());
  });

  it('moves it to a folder of the second level, and to a default folder', async () => {
    const { asset, from } = await scene();
    const child = await newFolder(ids.clientA1, from);
    expect(await moveAs(ids.adminA, asset, child)).toBe(true);
    const system = await w.folderOf(ids.clientA1, 'Imagens');
    expect(await moveAs(ids.adminA, asset, system)).toBe(true);
    expect((await rowOf(asset)).folder_id).toBe(system);
  });

  it('answers false, and writes nothing, when it is already there', async () => {
    const { asset, from } = await scene();
    const before = await rowOf(asset);
    expect(await moveAs(ids.adminA, asset, from)).toBe(false);
    expect(await rowOf(asset)).toEqual(before);
  });

  it('keeps a pdf, an audio and a logo as they are: moving is for every type', async () => {
    for (const category of ['pdf', 'audio', 'logo'] as const) {
      const { asset, to } = await scene({ category });
      expect(await moveAs(ids.adminA, asset, to)).toBe(true);
      expect(await rowOf(asset)).toMatchObject({ folder_id: to, category });
    }
  });

  it.each([
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only midia.enviar', () => onlyMidia],
    ['Sales', () => ids.salesA],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('refuses %s, with the answer of a media that does not exist', async (_label, user) => {
    const { asset, from, to } = await scene();

    await expect(moveAs(user(), asset, to)).rejects.toMatchObject(MEDIA_NOT_FOUND);
    await expect(moveAs(user(), randomUUID(), to)).rejects.toMatchObject(MEDIA_NOT_FOUND);

    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('refuses a folder of another client of the same agency, of another agency, and one that does not exist, as a media not found', async () => {
    const { asset, from } = await scene();
    const otherClient = await newFolder(ids.clientA2);
    const otherAgency = await w.folderOf(ids.clientB);
    for (const folder of [otherClient, otherAgency, randomUUID()]) {
      await expect(moveAs(ids.adminA, asset, folder)).rejects.toMatchObject(MEDIA_NOT_FOUND);
    }
    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('refuses a media of another agency, whatever the folder, even for a person who holds the same permissions there', async () => {
    const mediaOfB = await seed({ clientId: ids.clientB });
    const folderA = await newFolder(ids.clientA1);
    const folderB = await newFolder(ids.clientB);
    await expect(moveAs(ids.adminA, mediaOfB, folderA)).rejects.toMatchObject(NOT_FOUND);
    await expect(moveAs(ids.adminA, mediaOfB, folderB)).rejects.toMatchObject(NOT_FOUND);
    await expect(moveAs(ids.adminB, mediaOfB, folderA)).rejects.toMatchObject(NOT_FOUND);
  });

  it.each([
    ['an upload that is pending', { status: 'pending' }],
    ['an upload that was rejected', { status: 'rejected' }],
    ['a media that was removed', { removed: true }]
  ] as const)('refuses %s', async (_label, extra) => {
    const { asset, from, to } = await scene(extra);
    await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(NOT_FOUND);
    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('refuses a media of the library of the agency, which has no client and no folder', async () => {
    const asset = await seed({ clientId: null });
    const to = await newFolder(ids.clientA1);
    await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(NOT_FOUND);
    await expect(moveAs(onlyMidia, asset, to)).rejects.toMatchObject(NOT_FOUND);
  });

  it('refuses the media of an archived client', async () => {
    const from = await newFolder(ids.clientArchived);
    const to = await newFolder(ids.clientArchived);
    const asset = await seed({ clientId: ids.clientArchived, folderId: from });
    await w.archiveClient(ids.clientArchived);
    try {
      await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(ARCHIVED);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('refuses the media of an agency that is read-only, and answers a suspended one as a media not found', async () => {
    const { asset, from, to } = await scene();
    await whileReadOnly(async () => {
      await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject({ code: 'A0090' });
    });
    const suspendedFrom = await newFolder(ids.clientSuspended);
    const suspendedTo = await newFolder(ids.clientSuspended);
    const suspended = await seed({ clientId: ids.clientSuspended, folderId: suspendedFrom });
    await expect(moveAs(ids.adminSuspended, suspended, suspendedTo)).rejects.toMatchObject(NOT_FOUND);
    expect((await rowOf(asset)).folder_id).toBe(from);
    expect((await rowOf(suspended)).folder_id).toBe(suspendedFrom);
  });

  it.each([
    ['in production', 'in_production'],
    ['awaiting approval', 'awaiting_approval'],
    ['in adjustment', 'adjusting'],
    ['approved', 'approved'],
    ['published', 'published'],
    ['cancelled', 'cancelled']
  ] as const)('refuses a media that a content %s uses, because the content is tied to the folder', async (_label, status) => {
    const { asset, from, to } = await scene();
    const content = await w.seedContent(ids.clientA1, { status: status as ContentStatus, folderId: from, format: 'image' });
    await w.attach(content, [asset]);

    await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(IN_USE);

    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('refuses a media that a content uses as its cover', async () => {
    const { asset, from, to } = await scene();
    await w.seedContent(ids.clientA1, { folderId: from, format: 'image', coverAssetId: asset });
    await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(IN_USE);
    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('moves it once the content no longer uses it', async () => {
    const { asset, from, to } = await scene();
    const content = await w.seedContent(ids.clientA1, { folderId: from, format: 'image' });
    await w.attach(content, [asset]);
    await expect(moveAs(ids.adminA, asset, to)).rejects.toMatchObject(IN_USE);

    await w.asUser(ids.adminA, (transaction) => transaction.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, '{}']));

    expect(await moveAs(ids.adminA, asset, to)).toBe(true);
  });

  it('waits for a content that holds the media, and refuses once that content is committed', async () => {
    const { asset, from, to } = await scene({ category: 'image' });
    const content = await w.seedContent(ids.clientA1, { folderId: from, format: 'image' });
    const attacher = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await attacher.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, `{${asset}}`]);
      const holderPid = await backendPid(attacher);

      const move = moveAs(ids.adminA, asset, to);
      const outcome = move.then(() => 'moved', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await attacher.commit();
      released = true;
      expect(await outcome).toBe('A0082');
    } finally {
      if (!released) await attacher.rollback();
    }
    expect((await rowOf(asset)).folder_id).toBe(from);
  });

  it('waits for a content that is letting the media go, and moves it once that content is committed', async () => {
    const { asset, from, to } = await scene();
    const content = await w.seedContent(ids.clientA1, { folderId: from, format: 'image' });
    await w.attach(content, [asset]);
    const releaser = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await releaser.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, '{}']);
      const holderPid = await backendPid(releaser);

      const outcome = moveAs(ids.adminA, asset, to).then((moved) => moved, (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await releaser.commit();
      released = true;
      expect(await outcome).toBe(true);
    } finally {
      if (!released) await releaser.rollback();
    }
    expect((await rowOf(asset)).folder_id).toBe(to);
  });

  it('leaves a content that picks the media at the very instant of the move without it: the foreign key refuses and nothing is written', async () => {
    const { asset, from, to } = await scene();
    const content = await w.seedContent(ids.clientA1, { folderId: from, format: 'image' });
    const mover = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await mover.raw('select app_private.move_media_asset(?::uuid, ?::uuid)', [asset, to]);
      const holderPid = await backendPid(mover);

      const pick = w.asUser(ids.adminA, (transaction) => transaction.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, `{${asset}}`]))
        .then(() => 'picked', (error: { code?: string; constraint?: string }) => `${error.code}:${error.constraint}`);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await mover.commit();
      released = true;
      expect(await pick).toBe('23503:content_media_asset_fk');
    } finally {
      if (!released) await mover.rollback();
    }
    expect((await rowOf(asset)).folder_id).toBe(to);
    expect(await w.getOwner().knex('content_media').where({ content_id: content }).select('asset_id')).toEqual([]);
  });

  it('serializes with a removal: a move behind a removal that has not committed finds the media removed', async () => {
    const { asset, from, to } = await scene();
    const remover = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await remover.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [asset, from]);
      const holderPid = await backendPid(remover);

      const outcome = moveAs(ids.adminA, asset, to).then(() => 'moved', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await remover.commit();
      released = true;
      expect(await outcome).toBe('A0080');
    } finally {
      if (!released) await remover.rollback();
    }
    expect(await rowOf(asset)).toMatchObject({ folder_id: from, removed_at: expect.any(Date) });
  });

  it('serializes with a removal the other way: the removal behind a move removes the media where the move left it', async () => {
    const { asset, from, to } = await scene();
    const mover = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await mover.raw('select app_private.move_media_asset(?::uuid, ?::uuid)', [asset, to]);
      const holderPid = await backendPid(mover);

      const removal = w.asUser(ids.adminA, (transaction) => transaction.raw('select app_private.remove_media_asset(?::uuid, ?::uuid) as removed', [asset, from]));
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await mover.commit();
      released = true;
      await removal;
    } finally {
      if (!released) await mover.rollback();
    }
    expect(await rowOf(asset)).toMatchObject({ folder_id: to, removed_at: expect.any(Date) });
  });

  it('serializes with the archive: a move that holds the client makes the archive wait, and a move behind an uncommitted archive is refused', async () => {
    const from = await newFolder(ids.clientArchived);
    const to = await newFolder(ids.clientArchived);
    const asset = await seed({ clientId: ids.clientArchived, folderId: from });
    const mover = await w.openTransactionAs(ids.adminA);
    let released = false;
    try {
      await mover.raw('select app_private.move_media_asset(?::uuid, ?::uuid)', [asset, to]);
      const holderPid = await backendPid(mover);
      const archive = w.archiveClient(ids.clientArchived);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await mover.commit();
      released = true;
      await archive;
    } finally {
      if (!released) await mover.rollback();
    }
    expect((await rowOf(asset)).folder_id).toBe(to);

    const back = await w.getOwner().knex.transaction();
    let archived = false;
    try {
      await back('clients').where({ id: ids.clientArchived }).update({ status: 'active', archived_at: null });
      await back.commit();
      archived = true;
    } finally {
      if (!archived) await back.rollback();
    }
    const archiver = await w.getOwner().knex.transaction();
    let done = false;
    try {
      await archiver('clients').where({ id: ids.clientArchived }).update({ status: 'archived', archived_at: new Date() });
      const holderPid = await backendPid(archiver);
      const late = moveAs(ids.adminA, asset, from).then(() => 'moved', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await archiver.commit();
      done = true;
      expect(await late).toBe('A0081');
    } finally {
      if (!done) await archiver.rollback();
      await w.reactivateClient(ids.clientArchived);
    }
    expect((await rowOf(asset)).folder_id).toBe(to);
  });

  it.each(['repeatable read', 'serializable'] as const)('%s: a lock read again after a wait cannot be trusted, so the move is refused', async (level) => {
    const { asset, from, to } = await scene();
    const stale = await w.openTransactionAs(ids.adminA, level);
    try {
      await expect(stale.raw('select app_private.move_media_asset(?::uuid, ?::uuid)', [asset, to])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await stale.rollback();
    }
    expect((await rowOf(asset)).folder_id).toBe(from);
  });
});

describe('only a photo or a video enters a content', () => {
  const setMedia = (content: string, assets: readonly string[]) =>
    w.asUser(ids.adminA, (transaction) => transaction.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, `{${assets.join(',')}}`]));

  it.each(['pdf', 'audio', 'logo'] as const)('refuses a %s in the media of a carousel, alone or with a photo', async (category) => {
    const folder = await newFolder(ids.clientA1);
    const content = await w.seedContent(ids.clientA1, { folderId: folder, format: 'carousel' });
    const outsider = await seed({ category, folderId: folder });
    const photo = await seed({ folderId: folder });

    await expect(setMedia(content, [outsider])).rejects.toMatchObject({ code: 'A0069' });
    await expect(setMedia(content, [photo, outsider])).rejects.toMatchObject({ code: 'A0069' });

    expect(await w.getOwner().knex('content_media').where({ content_id: content }).select('asset_id')).toEqual([]);
  });

  it('still takes photos and videos', async () => {
    const folder = await newFolder(ids.clientA1);
    const content = await w.seedContent(ids.clientA1, { folderId: folder, format: 'carousel' });
    const photo = await seed({ folderId: folder });
    const video = await seed({ category: 'video', folderId: folder });

    await setMedia(content, [photo, video]);

    expect((await w.getOwner().knex('content_media').where({ content_id: content }).orderBy('position').select('asset_id')).map((row) => row.asset_id)).toEqual([photo, video]);
  });

  it('refuses a logo as the cover of a content, which is a confirmed photo', async () => {
    const folder = await newFolder(ids.clientA1);
    const content = await w.seedContent(ids.clientA1, { folderId: folder, format: 'image' });
    const logo = await seed({ category: 'logo', folderId: folder });

    await expect(w.asUser(ids.adminA, (transaction) => transaction('contents').where({ id: content }).update({ cover_asset_id: logo })))
      .rejects.toMatchObject({ code: 'A0069' });
  });

  it('does not offer a pdf, an audio or a logo to a content born in the folder', async () => {
    const folder = await newFolder(ids.clientA1);
    const photo = await seed({ folderId: folder });
    for (const category of ['pdf', 'audio', 'logo'] as const) await seed({ category, folderId: folder });
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ ids: string[] }> }>(
      'select app_private.folder_media_for(?::uuid, ?::uuid, ?) as ids', [ids.clientA1, folder, 'carousel']
    );
    expect(rows[0]!.ids).toEqual([photo]);
  });
});

describe('what the catalog says about the new objects', () => {
  it('move_media_asset is callable by the application only, security definer, with a fixed search_path', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<Record<string, unknown>> }>(`
      select p.prosecdef as definer, p.proconfig as config,
             coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_execute,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
      from pg_proc p where p.oid = 'app_private.move_media_asset(uuid, uuid)'::regprocedure
    `);
    expect(rows).toEqual([{ definer: true, config: ['search_path=""'], public_execute: false, app_execute: true }]);
  });

  it('the guard of the dimensions is a trigger function the application cannot call', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<Record<string, unknown>> }>(`
      select coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_execute,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
      from pg_proc p where p.oid = 'app_private.media_asset_dimensions_are_written_once()'::regprocedure
    `);
    expect(rows).toEqual([{ public_execute: false, app_execute: false }]);
  });

  it('the guard of the dimensions fires before every UPDATE of a row, enabled', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ enabled: string; before_update_row: boolean }> }>(`
      select t.tgenabled as enabled, (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 as before_update_row
      from pg_trigger t where t.tgrelid = 'public.media_assets'::regclass and t.tgname = 'media_assets_dimensions_written_once' and not t.tgisinternal
    `);
    expect(rows).toEqual([{ enabled: 'O', before_update_row: true }]);
  });

  it('the edit lock covers exactly the two columns of the rename, and fires only when one of them changes', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; definition: string; enabled: string; after_update_row: boolean }> }>(`
      select a.attname as name, pg_get_triggerdef(t.oid) as definition, t.tgenabled as enabled,
             (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) = 16 as after_update_row
      from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
      where t.tgrelid = 'public.media_assets'::regclass and t.tgname = '0_media_assets_edit_lock_active_client' and not t.tgisinternal
      order by a.attname collate "C"
    `);
    expect(rows.map((row) => row.name)).toEqual(['alt_text', 'file_name']);
    expect(rows.every((row) => row.enabled === 'O' && row.after_update_row)).toBe(true);
    const condition = rows[0]!.definition.split(' WHEN ')[1] ?? '';
    for (const column of ['alt_text', 'file_name']) {
      expect({ column, compared: condition.includes(`old.${column}`) && condition.includes(`new.${column}`) }).toEqual({ column, compared: true });
    }
  });

  it('set_content_media keeps its owner, its grants and its fixed search_path after the replacement', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<Record<string, unknown>> }>(`
      select p.prosecdef as definer, p.proconfig as config,
             coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_execute,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
      from pg_proc p where p.oid = 'app_private.set_content_media(uuid, uuid[])'::regprocedure
    `);
    expect(rows).toEqual([{ definer: true, config: ['search_path=""'], public_execute: false, app_execute: true }]);
  });
});
