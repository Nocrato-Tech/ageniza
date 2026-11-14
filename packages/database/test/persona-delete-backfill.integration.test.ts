import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveIntegrationDatabaseUrls } from '../src/index.js';

// Issue #891: the personas that were archived come back as normal ones, with their conversations, and the stamps are left as they were.
// The database is built with the migrations before this change, filled the way the old code filled it, and then upgraded.
const { ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const THIS_CHANGE = '20261113000400_persona_is_deleted_with_its_conversation.mjs';

const databaseName = `ageniza_backfill_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
let admin: Knex;
let upgrade: Knex;
const workDir = mkdtempSync(join(tmpdir(), 'w13s1-backfill-'));

const ids = {
  user: randomUUID(), agency: randomUUID(), client: randomUUID(), archivedClient: randomUUID(),
  archived: randomUUID(), active: randomUUID(), ofArchivedClient: randomUUID(),
  threadArchived: randomUUID(), commentArchived: randomUUID()
};
const stamp = new Date('2026-10-20T12:00:00.000Z');
let before: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const earlier = join(workDir, 'earlier');
  mkdirSync(earlier);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs') && name < THIS_CHANGE)) {
    cpSync(join(migrationsDir, file), join(earlier, file));
  }

  admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  await admin.raw(`create database "${databaseName}"`);
  const target = new URL(ownerUrl);
  target.pathname = `/${databaseName}`;
  upgrade = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });
  await upgrade.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });

  await upgrade('auth.user').insert({ id: ids.user, name: 'Autora', email: `${ids.user}@backfill.test`, emailVerified: true });
  await upgrade('agencies').insert({ id: ids.agency, name: `Backfill ${ids.agency}`, owner_user_id: null });
  await upgrade('clients').insert([
    { id: ids.client, agency_id: ids.agency, name: `Cliente ${ids.client}` },
    { id: ids.archivedClient, agency_id: ids.agency, name: `Cliente arquivado ${ids.archivedClient}`, status: 'archived', archived_at: new Date() }
  ]);
  await upgrade('client_personas').insert([
    { id: ids.archived, client_id: ids.client, name: 'Arquivada', status: 'archived', updated_by: ids.user, updated_at: stamp },
    { id: ids.active, client_id: ids.client, name: 'Ativa', status: 'active', updated_by: ids.user, updated_at: stamp },
    { id: ids.ofArchivedClient, client_id: ids.archivedClient, name: 'Do cliente arquivado', status: 'archived', updated_by: ids.user, updated_at: stamp }
  ]);
  await upgrade('client_threads').insert({ id: ids.threadArchived, client_id: ids.client, persona_id: ids.archived, opened_by: ids.user, opened_side: 'agency' });
  await upgrade('client_thread_comments').insert({
    id: ids.commentArchived, thread_id: ids.threadArchived, client_id: ids.client, author_user_id: ids.user, author_side: 'agency', body: 'Antes de arquivar'
  });
  before = await upgrade('client_personas').orderBy('id');

  await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });
});

afterAll(async () => {
  try {
    await upgrade?.destroy();
    await admin?.raw(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin?.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('the personas that were archived (issue #891)', () => {
  it('come back as active, the ones of an archived client too, and nothing else of the row changes', async () => {
    const after = await upgrade('client_personas').orderBy('id');

    expect(after).toHaveLength(3);
    expect(after.map((row) => row.status)).toEqual(['active', 'active', 'active']);
    const withoutStatus = (rows: Array<Record<string, unknown>>) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'status')));
    expect(withoutStatus(after)).toEqual(withoutStatus(before));
  });

  it('keep their conversation', async () => {
    expect(await upgrade('client_threads').where({ id: ids.threadArchived, persona_id: ids.archived }).first('id')).toBeDefined();
    expect(await upgrade('client_thread_comments').where({ id: ids.commentArchived, body: 'Antes de arquivar' }).first('id')).toBeDefined();
  });

  it('can no longer be archived', async () => {
    await expect(upgrade('client_personas').where({ id: ids.active }).update({ status: 'archived' })).rejects.toMatchObject({ code: '23514' });
  });
});
