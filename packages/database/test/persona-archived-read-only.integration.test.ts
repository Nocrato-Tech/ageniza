import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #891 (decision 2026-11-13): an archived persona is read-only. Every attack is `ageniza_app` through a person who may write the
// row (admin of the agency, on an active client), so the only thing that can refuse is the trigger, named by its code A0137.
const w = createContentWorld('persona-read-only');
const { ids } = w;
const owner = () => w.getOwner().knex;

const READ_ONLY = { code: 'A0137' };
const personaIds: string[] = [];

beforeAll(async () => {
  await w.setup();
});

afterAll(async () => {
  try {
    await owner()('client_personas').whereIn('id', personaIds).delete();
  } finally {
    await w.teardown();
  }
});

const seedPersona = async (status: 'active' | 'archived', extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  personaIds.push(id);
  await owner()('client_personas').insert({ id, client_id: ids.clientA1, name: 'Persona', updated_by: ids.adminA, status, ...extra });
  return id;
};

const rowOf = async (id: string): Promise<string> =>
  ((await owner().raw('select to_jsonb(p)::text as value from public.client_personas p where id = ?::uuid', [id])).rows[0] as { value: string }).value;

const edit = (id: string, changes: Record<string, unknown>) => (t: Knex.Transaction) =>
  t('client_personas').where({ id }).update({ updated_by: ids.adminA, ...changes });

const changes: ReadonlyArray<readonly [string, unknown]> = [
  ['name', 'Outro nome'],
  ['description', 'Outra descrição'],
  ['pains', 'Outras dores'],
  ['desires', 'Outros desejos'],
  ['objections', 'Outras objeções'],
  ['age', 33],
  ['occupation', 'Padeira'],
  ['location', 'Campinas'],
  ['traits', JSON.stringify(['Prática'])],
  ['where_they_are', 'Instagram'],
  ['tone_that_works', 'Direto']
];

describe('an archived persona is read-only for the application role (issue #891)', () => {
  it.each(changes)('refuses a write of %s and leaves the row as it was', async (column, value) => {
    const id = await seedPersona('archived');
    const before = await rowOf(id);

    await expect(w.asUser(ids.adminA, edit(id, { [column]: value }))).rejects.toMatchObject(READ_ONLY);

    expect(await rowOf(id)).toBe(before);
  });

  it('refuses a write that changes nothing but the stamps, and archiving it again', async () => {
    const id = await seedPersona('archived');
    const before = await rowOf(id);

    await expect(w.asUser(ids.adminA, edit(id, { updated_at: new Date() }))).rejects.toMatchObject(READ_ONLY);
    await expect(w.asUser(ids.adminA, edit(id, { status: 'archived' }))).rejects.toMatchObject(READ_ONLY);

    expect(await rowOf(id)).toBe(before);
  });

  it('refuses a write of a field that comes with the unarchive, and unarchives nothing', async () => {
    const id = await seedPersona('archived');
    const before = await rowOf(id);

    await expect(w.asUser(ids.adminA, edit(id, { status: 'active', name: 'Renomeada ao reativar' }))).rejects.toMatchObject(READ_ONLY);

    expect(await rowOf(id)).toBe(before);
  });

  it('takes the unarchive, and the persona is editable again afterwards', async () => {
    const id = await seedPersona('archived', { name: 'Persona guardada' });

    await expect(w.asUser(ids.adminA, edit(id, { status: 'active' }))).resolves.toBe(1);
    expect(await rowOf(id)).toContain('"status": "active"');

    await expect(w.asUser(ids.adminA, edit(id, { name: 'Persona de volta' }))).resolves.toBe(1);
    expect(await rowOf(id)).toContain('"name": "Persona de volta"');
  });

  it.each(changes)('keeps an active persona editable in %s, and takes the archive in the same write', async (column, value) => {
    const id = await seedPersona('active');

    await expect(w.asUser(ids.adminA, edit(id, { [column]: value }))).resolves.toBe(1);
    await expect(w.asUser(ids.adminA, edit(id, { status: 'archived' }))).resolves.toBe(1);
    await expect(w.asUser(ids.adminA, edit(id, { [column]: value }))).rejects.toMatchObject(READ_ONLY);
  });

  it('does not constrain the owner, like the other locks of the children', async () => {
    const id = await seedPersona('archived');

    await expect(owner()('client_personas').where({ id }).update({ name: 'Corrigida pela operação' })).resolves.toBe(1);
  });

  it('is a security invoker trigger function with an empty search_path', async () => {
    const rows = (await owner().raw(`
      select p.prosecdef as definer, p.proconfig as config, has_function_privilege('public', p.oid, 'execute') as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'refuse_archived_persona_edit'`)).rows;
    expect(rows).toEqual([{ definer: false, config: ['search_path=""'], public_execute: false }]);
  });
});

describe('the edit that was open when the persona was archived (issue #891)', () => {
  it('waits for the archive and is then refused, leaving the persona as the archive left it', async () => {
    const id = await seedPersona('active', { name: 'Antes' });
    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving('client_personas').where({ id }).update({ status: 'archived', updated_by: ids.adminA });
      outcome = w.asUser(ids.adminA, edit(id, { name: 'Depois' })).then(() => 'written' as const, (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject(READ_ONLY);
    expect(await rowOf(id)).toContain('"name": "Antes"');
    expect(await rowOf(id)).toContain('"status": "archived"');
  });

  it('written first, makes the archive wait, and both commit', async () => {
    const id = await seedPersona('active', { name: 'Antes' });
    const writing = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      expect(await edit(id, { name: 'Depois' })(writing)).toBe(1);
      outcome = w.asUser(ids.adminA, edit(id, { status: 'archived' })).then(() => 'archived' as const, (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await writing.commit();
    }

    expect(await outcome).toBe('archived');
    expect(await rowOf(id)).toContain('"name": "Depois"');
    expect(await rowOf(id)).toContain('"status": "archived"');
  });
});
