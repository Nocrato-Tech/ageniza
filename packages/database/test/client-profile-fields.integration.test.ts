import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';

// Scope telas-melhorias, subtask A3 (decisions 2026-11-11): the client gains a city and the persona gains age, occupation, location, traits,
// "onde está" and "tom que funciona". The checks are the database's copy of the contract, so each rule is attacked here as `ageniza_app`
// through a person who is allowed to write the row (the only thing that can refuse is then the CHECK, named by `constraint`), and the
// people who are not allowed attack the same columns to show the policies did not move.
const w = createContentWorld('client-profile-fields');
const f = createApprovalFixtures(w);
const { ids } = w;
const owner = () => w.getOwner().knex;

const CHECK_VIOLATION = '23514';
const repeat = (text: string, times: number): string => text.repeat(times);

let onlyClienteVisualizar: string;
const personaIds: string[] = [];

beforeAll(async () => {
  await w.setup();
  onlyClienteVisualizar = await w.personWith('cliente.visualizar');
});

afterAll(async () => {
  try {
    await owner()('client_personas').whereIn('id', personaIds).delete();
    await f.cleanUp();
  } finally {
    await w.teardown();
  }
});

const clientRow = (id = ids.clientA1): Promise<Record<string, unknown>> => owner()('clients').where({ id }).first() as Promise<Record<string, unknown>>;
const personaRow = (id: string): Promise<Record<string, unknown>> => owner()('client_personas').where({ id }).first() as Promise<Record<string, unknown>>;

const setCity = (user: string, city: string | null, clientId = ids.clientA1): Promise<number> =>
  w.asUser(user, (transaction) => transaction('clients').where({ id: clientId }).update({ city, updated_by: user }));

const seedPersona = async (clientId = ids.clientA1, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  personaIds.push(id);
  await owner()('client_personas').insert({ id, client_id: clientId, name: 'Persona do perfil', updated_by: ids.adminA, ...extra });
  return id;
};

const editPersona = (user: string, id: string, changes: Record<string, unknown>): Promise<number> =>
  w.asUser(user, (transaction) => transaction('client_personas').where({ id }).update({ ...changes, updated_by: user }));

// ---- the validators -------------------------------------------------------------------------------------------------------------

describe('the validators the checks use', () => {
  const valid = async (sql: string, bindings: unknown[]): Promise<boolean | null> =>
    ((await owner().raw(`select ${sql} as ok`, bindings)).rows[0] as { ok: boolean | null }).ok;

  it('are immutable and parallel safe, read no table, have a fixed search_path, and are callable by the application only', async () => {
    const rows = (await owner().raw(`
      select p.proname as name, p.provolatile as volatility, p.proparallel as parallel, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('display_text_valid', 'multiline_text_valid', 'persona_traits_valid')
      order by p.proname collate "C"`)).rows;
    expect(rows).toEqual(['display_text_valid', 'multiline_text_valid', 'persona_traits_valid'].map((name) => ({
      name, volatility: 'i', parallel: 's', definer: false, config: ['search_path=""'], public_execute: false, app_execute: true
    })));
  });

  it('take a missing value as valid, because the column is optional', async () => {
    expect(await valid('app_private.display_text_valid(null::text, 80)', [])).toBe(true);
    expect(await valid('app_private.multiline_text_valid(null::text, 280)', [])).toBe(true);
    expect(await valid('app_private.persona_traits_valid(null::jsonb)', [])).toBe(true);
  });

  it('take one line of up to the limit in characters, with no control character, and a line break is the multiline one only', async () => {
    expect(await valid('app_private.display_text_valid(?::text, 80)', [repeat('a', 80)])).toBe(true);
    expect(await valid('app_private.display_text_valid(?::text, 80)', [repeat('a', 81)])).toBe(false);
    expect(await valid('app_private.display_text_valid(?::text, 80)', [repeat('😀', 80)])).toBe(true);
    for (const value of ['', '   ', ' ', '　', ' ', 'a\nb', 'a\rb', 'a\tb', 'a\u0007b', 'a\u000bb', 'a\u007fb', 'a\u0085b', 'a\u009fb', 'a\u0001b']) {
      expect(await valid('app_private.display_text_valid(?::text, 80)', [value]), JSON.stringify(value)).toBe(false);
    }
    expect(await valid('app_private.multiline_text_valid(?::text, 280)', ['Linha um\nLinha dois\r\n\tTrês'])).toBe(true);
    for (const value of ['', '   ', ' ', 'a\u0007b', 'a\u000bb', 'a\u000cb', 'a\u007fb', 'a\u0085b', 'a\u009fb', 'a\u0001b', repeat('a', 281)]) {
      expect(await valid('app_private.multiline_text_valid(?::text, 280)', [value]), JSON.stringify(value)).toBe(false);
    }
    expect(await valid('app_private.multiline_text_valid(?::text, 280)', [repeat('a', 280)])).toBe(true);
  });

  it('take at most five traits, each one a line of up to 24 characters, and nothing that is not a list of texts', async () => {
    const accepted = [[], ['a'], ['a', 'b', 'c', 'd', 'e'], [repeat('a', 24)], [repeat('😀', 24)]];
    const refused: unknown[] = [['a', 'b', 'c', 'd', 'e', 'f'], [repeat('a', 25)], [''], ['   '], ['a\nb'], ['a\u0007'], [5], [null], [['a']], [{ x: 1 }], 'texto', 5, {}, null];
    for (const traits of accepted) expect(await valid('app_private.persona_traits_valid(?::jsonb)', [JSON.stringify(traits)]), JSON.stringify(traits)).toBe(true);
    for (const traits of refused) expect(await valid('app_private.persona_traits_valid(?::jsonb)', [JSON.stringify(traits)]), JSON.stringify(traits)).toBe(false);
  });
});

// ---- the city -----------------------------------------------------------------------------------------------------------------

describe('the city of the client', () => {
  it('is a column the application may insert and update, and is born without a value', async () => {
    expect(await w.columnsWithPrivilege('clients', 'insert')).toContain('city');
    expect(await w.columnsWithPrivilege('clients', 'update')).toContain('city');
    expect((await clientRow(ids.clientA2)).city).toBeNull();
  });

  it('is written by who edits the client, as one line up to 80 characters, and may be cleared', async () => {
    for (const city of ['Campinas', 'São José do Rio Preto', repeat('ç', 80), repeat('😀', 80), 'a']) {
      expect(await setCity(ids.adminA, city), city.slice(0, 12)).toBe(1);
      expect((await clientRow()).city).toBe(city);
    }
    expect(await setCity(ids.adminA, null)).toBe(1);
    expect((await clientRow()).city).toBeNull();
  });

  it('refuses a city that is empty, blank, long, in several lines or with a control character, and leaves the row as it was', async () => {
    await setCity(ids.adminA, 'Original');
    const before = await clientRow();
    for (const city of ['', '   ', ' ', repeat('a', 81), 'Duas\nlinhas', 'Com\ttab', 'Sino\u0007', 'Del\u007f', 'Next\u0085', 'Nulo\u0001']) {
      await expect(setCity(ids.adminA, city), JSON.stringify(city)).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'clients_city_check' });
      expect(await clientRow(), JSON.stringify(city)).toEqual(before);
    }
    await expect(owner()('clients').where({ id: ids.clientA1 }).update({ city: repeat('a', 81) })).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'clients_city_check' });
  });

  it.each([
    ['Sales, who cannot edit a client', () => ids.salesA],
    ['a role with only cliente.visualizar', () => onlyClienteVisualizar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and the Sales role', () => ids.dualBare]
  ] as const)('is not written by %s: no row changes', async (_label, user) => {
    await setCity(ids.adminA, 'Intocada');
    expect(await setCity(user(), 'Invadida')).toBe(0);
    expect((await clientRow()).city).toBe('Intocada');
  });
});

// ---- the profile of the persona ------------------------------------------------------------------------------------------------------

describe('the profile of the persona', () => {
  const COLUMNS = ['age', 'occupation', 'location', 'traits', 'where_they_are', 'tone_that_works'];

  it('has six columns the application may insert and update, and no more than before', async () => {
    const inserts = await w.columnsWithPrivilege('client_personas', 'insert');
    const updates = await w.columnsWithPrivilege('client_personas', 'update');
    for (const column of COLUMNS) {
      expect(inserts, column).toContain(column);
      expect(updates, column).toContain(column);
    }
    expect(updates).not.toContain('client_id');
    expect(updates).not.toContain('id');
  });

  it('starts empty, and is written by who edits the client with the values at the limit', async () => {
    const empty = await seedPersona();
    expect(await personaRow(empty)).toMatchObject({ age: null, occupation: null, location: null, traits: null, where_they_are: null, tone_that_works: null });

    const full = {
      age: 120, occupation: repeat('o', 80), location: repeat('😀', 80), traits: [repeat('a', 24), 'b', 'c', 'd', 'e'],
      where_they_are: `Linha um\nLinha dois\t${repeat('x', 250)}`, tone_that_works: repeat('t', 280)
    };
    expect(await editPersona(ids.adminA, empty, { ...full, traits: JSON.stringify(full.traits) })).toBe(1);
    expect(await personaRow(empty)).toMatchObject(full);

    const inserted = randomUUID();
    personaIds.push(inserted);
    await w.asUser(ids.adminA, (transaction) => transaction('client_personas').insert({
      id: inserted, client_id: ids.clientA1, name: 'Inserida pela agência', updated_by: ids.adminA, ...full, traits: JSON.stringify(full.traits)
    }));
    expect(await personaRow(inserted)).toMatchObject(full);

    expect(await editPersona(ids.adminA, empty, { age: 1, traits: null, occupation: null })).toBe(1);
    expect(await personaRow(empty)).toMatchObject({ age: 1, traits: null, occupation: null, location: full.location });
  });

  it.each([
    ['age 0', 'client_personas_age_check', { age: 0 }],
    ['age 121', 'client_personas_age_check', { age: 121 }],
    ['age negative', 'client_personas_age_check', { age: -1 }],
    ['an occupation of 81 characters', 'client_personas_occupation_check', { occupation: repeat('a', 81) }],
    ['an empty occupation', 'client_personas_occupation_check', { occupation: '' }],
    ['an occupation with a line break', 'client_personas_occupation_check', { occupation: 'duas\nlinhas' }],
    ['a location of 81 characters', 'client_personas_location_check', { location: repeat('a', 81) }],
    ['a location with a control character', 'client_personas_location_check', { location: 'sino\u0007' }],
    ['six traits', 'client_personas_traits_check', { traits: JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']) }],
    ['a trait of 25 characters', 'client_personas_traits_check', { traits: JSON.stringify([repeat('a', 25)]) }],
    ['a trait with a line break', 'client_personas_traits_check', { traits: JSON.stringify(['a\nb']) }],
    ['an empty trait', 'client_personas_traits_check', { traits: JSON.stringify(['']) }],
    ['a trait that is not text', 'client_personas_traits_check', { traits: JSON.stringify([5]) }],
    ['traits that are not a list', 'client_personas_traits_check', { traits: JSON.stringify('Prática') }],
    ['a where-they-are of 281 characters', 'client_personas_where_they_are_check', { where_they_are: repeat('a', 281) }],
    ['a where-they-are with a control character', 'client_personas_where_they_are_check', { where_they_are: 'sino\u0007' }],
    ['an empty where-they-are', 'client_personas_where_they_are_check', { where_they_are: '' }],
    ['a tone of 281 characters', 'client_personas_tone_that_works_check', { tone_that_works: repeat('a', 281) }],
    ['a tone of only blanks', 'client_personas_tone_that_works_check', { tone_that_works: '   ' }]
  ] as const)('refuses %s with its own CHECK and leaves the row as it was', async (_label, constraint, changes) => {
    const id = await seedPersona(ids.clientA1, { age: 40, occupation: 'Original', traits: JSON.stringify(['a']) });
    const before = await personaRow(id);
    await expect(editPersona(ids.adminA, id, { ...changes })).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
    expect(await personaRow(id)).toEqual(before);
    await expect(owner()('client_personas').insert({ client_id: ids.clientA1, name: 'Recusada', ...changes })).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
  });

  it.each([
    ['Sales, who cannot edit a client', () => ids.salesA],
    ['a role with only cliente.visualizar', () => onlyClienteVisualizar],
    ['the Admin of another agency', () => ids.adminB],
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and the Sales role', () => ids.dualBare]
  ] as const)('is not written by %s: no row changes', async (_label, user) => {
    const id = await seedPersona(ids.clientA1, { age: 33 });
    for (const column of COLUMNS) {
      const value = column === 'age' ? 99 : column === 'traits' ? JSON.stringify(['x']) : 'Invadida';
      expect(await editPersona(user(), id, { [column]: value }), column).toBe(0);
    }
    expect(await personaRow(id)).toMatchObject({ age: 33, occupation: null, location: null, traits: null, where_they_are: null, tone_that_works: null });
  });

  it('is read by the person of the portal of the client and by nobody of another client or agency', async () => {
    const id = await seedPersona(ids.clientA1, { age: 41, occupation: 'Lida pelo portal' });
    const read = (user: string) => w.asUser(user, (transaction) => transaction('client_personas').where({ id }).select('age', 'occupation'));
    expect(await read(ids.portalA1)).toEqual([{ age: 41, occupation: 'Lida pelo portal' }]);
    expect(await read(ids.adminA)).toHaveLength(1);
    for (const user of [ids.portalA2, ids.portalB, ids.adminB]) expect(await read(user), user).toEqual([]);
  });

  it('is not written for the persona of an archived client, and the lock of the archive race is in client-archive.integration.test.ts', async () => {
    const closing = await f.freshClient([]);
    const id = await seedPersona(closing, { age: 30 });
    await w.archiveClient(closing);
    for (const column of COLUMNS) {
      const value = column === 'age' ? 50 : column === 'traits' ? JSON.stringify(['nova']) : 'Novo valor';
      expect(await editPersona(ids.adminA, id, { [column]: value }), column).toBe(0);
    }
    expect(await personaRow(id)).toMatchObject({ age: 30, occupation: null, traits: null });
  });
});
