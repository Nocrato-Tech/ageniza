import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveIntegrationDatabaseUrls } from '../src/index.js';

// Migration 20261111000102 runs over a library that already exists: the database is built up to the migration before it, filled with
// files as the code of that time left them, and then upgraded. A name or an alternative text that carries a character the new CHECKs
// refuse is cleaned instead of stopping the migration, and every confirmed file is filed at the instant it was confirmed.
const { ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const FIRST_OF_THIS_CHANGE = '20261111000102_media_library_review_fixes.mjs';

const databaseName = `ageniza_backfill_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
let admin: Knex;
let upgrade: Knex;
const workDir = mkdtempSync(join(tmpdir(), 'ageniza-backfill-'));

const user = randomUUID();
const agency = randomUUID();
const activeClient = randomUUID();
const archivedClient = randomUUID();
const assets: Record<string, string> = {};

const day = (n: number): Date => new Date(Date.UTC(2026, 9, 1) - n * 86_400_000);
const rowOf = async (key: string): Promise<Record<string, unknown>> => (await upgrade('media_assets').where({ id: assets[key] }).first()) as Record<string, unknown>;

beforeAll(async () => {
  const earlier = join(workDir, 'earlier');
  mkdirSync(earlier);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs') && name < FIRST_OF_THIS_CHANGE)) {
    cpSync(join(migrationsDir, file), join(earlier, file));
  }

  admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  await admin.raw(`create database "${databaseName}"`);
  const target = new URL(ownerUrl);
  target.pathname = `/${databaseName}`;
  upgrade = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });
  await upgrade.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });
  expect(await upgrade.schema.hasColumn('media_assets', 'filed_at')).toBe(false);

  await upgrade('auth.user').insert({ id: user, name: 'Legado', email: `${user}@legacy.test`, emailVerified: true });
  await upgrade('agencies').insert({ id: agency, name: `Legado ${agency}`, owner_user_id: user });
  await upgrade('clients').insert([
    { id: activeClient, agency_id: agency, name: `Ativo ${activeClient}` },
    { id: archivedClient, agency_id: agency, name: `Arquivado ${archivedClient}` }
  ]);
  const folder = async (clientId: string): Promise<string> => (await upgrade('media_folders').where({ client_id: clientId, name: 'Imagens' }).first('id')).id as string;

  const insert = async (key: string, clientId: string, spec: Record<string, unknown>): Promise<void> => {
    const id = (assets[key] = randomUUID());
    const status = (spec.status as string | undefined) ?? 'confirmed';
    await upgrade('media_assets').insert({
      id, agency_id: agency, client_id: clientId, folder_id: await folder(clientId), category: 'image', declared_content_type: 'image/png', extension: 'png',
      object_key: `${agency}/${id}/original.png`, upload_object_key: `staging/${agency}/${id}/upload.png`, declared_size_bytes: 1_000, created_by_user_id: user,
      created_at: day(60), updated_at: day(10), status,
      ...(status === 'confirmed' ? { confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', confirmed_at: day(40) } : {}),
      ...(status === 'rejected' ? { rejected_reason: 'too_large' } : {}),
      ...spec
    });
  };

  await insert('lineSeparatorName', activeClient, { file_name: 'a\u2028b.png' });
  await insert('paragraphSeparatorAlt', activeClient, { alt_text: 'a\u2029b' });
  await insert('arabicLetterMarkName', activeClient, { file_name: 'a\u061cb.png' });
  await insert('trailingSeparatorName', activeClient, { file_name: 'a.png\u2028' });
  await insert('onlySeparatorsName', activeClient, { file_name: '\u2028\u2029' });
  await insert('onlySeparatorsAlt', activeClient, { alt_text: '\u2029' });
  await insert('clean', activeClient, { file_name: 'limpo.png', alt_text: 'texto limpo' });
  await insert('pending', activeClient, { status: 'pending' });
  await insert('rejected', activeClient, { status: 'rejected' });
  await insert('removed', activeClient, { removed_at: day(5), confirmed_at: day(30) });
  await insert('neverStamped', activeClient, { confirmed_at: null });
  await insert('archivedName', archivedClient, { file_name: 'x\u2028y.png', confirmed_at: day(20) });
  await upgrade('clients').where({ id: archivedClient }).update({ status: 'archived', archived_at: new Date() });

  await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });
}, 240_000);

afterAll(async () => {
  try {
    await upgrade?.destroy();
    await admin?.raw(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin?.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('the name and the alternative text of the files that already exist', () => {
  it('replaces a line or paragraph separator and an Arabic letter mark by a space, and trims what is left', async () => {
    expect(await rowOf('lineSeparatorName')).toMatchObject({ file_name: 'a b.png' });
    expect(await rowOf('paragraphSeparatorAlt')).toMatchObject({ alt_text: 'a b' });
    expect(await rowOf('arabicLetterMarkName')).toMatchObject({ file_name: 'a b.png' });
    expect(await rowOf('trailingSeparatorName')).toMatchObject({ file_name: 'a.png' });
  });

  it('leaves a name or a text that was only separators with nothing, which the CHECKs take as no name', async () => {
    expect(await rowOf('onlySeparatorsName')).toMatchObject({ file_name: null });
    expect(await rowOf('onlySeparatorsAlt')).toMatchObject({ alt_text: null });
  });

  it('cleans the files of an archived client, whose edit lock refuses a write', async () => {
    expect(await rowOf('archivedName')).toMatchObject({ file_name: 'x y.png' });
  });

  it('keeps a name and a text that were clean, byte for byte', async () => {
    expect(await rowOf('clean')).toMatchObject({ file_name: 'limpo.png', alt_text: 'texto limpo' });
  });

  it('refuses the same characters from now on', async () => {
    await expect(upgrade('media_assets').where({ id: assets.clean }).update({ file_name: 'a\u2028b.png' })).rejects.toMatchObject({ constraint: 'media_assets_file_name_shape' });
    await expect(upgrade('media_assets').where({ id: assets.clean }).update({ alt_text: 'a\u061cb' })).rejects.toMatchObject({ constraint: 'media_assets_alt_text_shape' });
  });
});

describe('the instant the existing files were filed', () => {
  it('is the confirmation of a confirmed file, and the removed one too', async () => {
    expect((await rowOf('clean')).filed_at).toEqual(day(40));
    expect((await rowOf('lineSeparatorName')).filed_at).toEqual(day(40));
    expect((await rowOf('removed')).filed_at).toEqual(day(30));
    expect((await rowOf('archivedName')).filed_at).toEqual(day(20));
  });

  it('is the last update of a confirmed file that never had its confirmation stamped', async () => {
    expect(await rowOf('neverStamped')).toMatchObject({ confirmed_at: null, filed_at: day(10) });
  });

  it('is nothing for an upload that was never confirmed', async () => {
    expect((await rowOf('pending')).filed_at).toBeNull();
    expect((await rowOf('rejected')).filed_at).toBeNull();
  });

  it('is kept with the state: a confirmed file with no instant is refused, and an unconfirmed one has none', async () => {
    await expect(upgrade('media_assets').where({ id: assets.clean }).update({ filed_at: null })).rejects.toMatchObject({ constraint: 'media_assets_filed_at_confirmed' });
    await upgrade('media_assets').where({ id: assets.pending }).update({ filed_at: new Date() });
    expect((await rowOf('pending')).filed_at).toBeNull();
  });
});
