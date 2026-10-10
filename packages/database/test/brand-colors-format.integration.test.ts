import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #476. `client_brand_sections.colors` used to accept any JSON array, and one element outside
// the read contract made the whole brand study answer 500. `app_private.brand_colors_valid` mirrors
// `BrandColorSchema` and the 24-item limit of the write contract; apps/api's brand-colors-parity
// test holds the two sides to the same verdicts. Every assertion here names the constraint, because
// 23514 alone would also pass for the older `colors` or section-shape checks.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const CONSTRAINT = 'client_brand_sections_colors_format';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyId = randomUUID();
const managerId = randomUUID();
const clientId = randomUUID();

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asManager = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: managerId }), work);

const verdict = async (colors: unknown): Promise<boolean> => {
  const { rows } = await raw<{ rows: readonly { valid: boolean }[] }>(
    getOwner().knex,
    'select app_private.brand_colors_valid(?::jsonb) as valid',
    [colors === null ? null : JSON.stringify(colors)]
  );
  return rows[0]!.valid;
};

const rejection = async (work: Promise<unknown>): Promise<{ code?: string; constraint?: string }> => {
  try {
    await work;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('Expected the write to be rejected, but it succeeded.');
};

const storedColors = async (): Promise<unknown> => {
  const rows = await getOwner().knex('client_brand_sections').where({ client_id: clientId, section_key: 'colors' }).select('colors');
  return rows[0]?.colors;
};

const COLOR = { name: 'Vermelho terracota', hex: '#B4472F' };

const withoutRow = async (): Promise<void> => {
  await getOwner().knex('client_brand_sections').where({ client_id: clientId, section_key: 'colors' }).delete();
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'account_manager' }).first('id');
  if (role === undefined) throw new Error('System role seeds are missing.');

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert({ id: managerId, name: 'Manager', email: `${managerId}@example.test`, emailVerified: true });
    await transaction('agencies').insert({ id: agencyId, name: `Agency ${agencyId}` });
    await transaction('agency_memberships').insert({ agency_id: agencyId, user_id: managerId, role_id: role.id });
    await transaction('clients').insert({ id: clientId, agency_id: agencyId, name: `Client ${clientId}` });
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('client_brand_sections').where({ client_id: clientId }).delete();
      await transaction('audit.events').where({ agency_id: agencyId }).delete();
      await transaction('agency_memberships').where({ agency_id: agencyId }).delete();
      await transaction('clients').where({ id: clientId }).delete();
      await transaction('agencies').where({ id: agencyId }).delete();
      await transaction('auth.user').where({ id: managerId }).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('brand study colors format at the database (#476)', () => {
  it('accepts what the contract accepts, value by value', async () => {
    expect(await verdict(null)).toBe(true);
    expect(await verdict([])).toBe(true);
    expect(await verdict([COLOR])).toBe(true);
    expect(await verdict([{ name: 'Creme', hex: '#f3e3c3' }])).toBe(true);
    expect(await verdict([{ name: '', hex: '#000000' }])).toBe(true);
    expect(await verdict([{ name: 'Café com leite ☕', hex: '#6F4E37' }])).toBe(true);
    expect(await verdict([{ name: 'com nbsp', hex: '#6F4E37' }])).toBe(true);
    expect(await verdict(Array.from({ length: 24 }, (_, index) => ({ name: `Cor ${index}`, hex: '#112233' })))).toBe(true);
  });

  it('refuses the seed format that broke the study, and each way a color leaves the contract', async () => {
    expect(await verdict([{ nome: 'Vermelho', codigoHexadecimal: '#B4472F' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: 'B4472F' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: '#B4472' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: '#B4472FF' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: '#B4472G' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: '#B4472F\n' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: null }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', hex: 0xb4472f }])).toBe(false);
    expect(await verdict([{ name: null, hex: '#B4472F' }])).toBe(false);
    expect(await verdict([{ name: 7, hex: '#B4472F' }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho' }])).toBe(false);
    expect(await verdict([{ hex: '#B4472F' }])).toBe(false);
    expect(await verdict([{}])).toBe(false);
    expect(await verdict([{ ...COLOR, extra: 1 }])).toBe(false);
    expect(await verdict([{ name: 'Vermelho', Hex: '#B4472F' }])).toBe(false);
    expect(await verdict([null])).toBe(false);
    expect(await verdict(['#B4472F'])).toBe(false);
    expect(await verdict([[COLOR]])).toBe(false);
    expect(await verdict([COLOR, { nome: 'x' }])).toBe(false);
  });

  it('refuses a value that is not an array, JSON null included', async () => {
    const { rows } = await raw<{ rows: readonly { valid: boolean }[] }>(getOwner().knex, "select app_private.brand_colors_valid('null'::jsonb) as valid", []);
    expect(rows[0]!.valid).toBe(false);
    expect(await verdict(COLOR)).toBe(false);
    expect(await verdict('#B4472F')).toBe(false);
    expect(await verdict(7)).toBe(false);
    expect(await verdict(true)).toBe(false);
  });

  it('applies the name limits in bytes and the control-character rule of the contract', async () => {
    expect(await verdict([{ name: 'a'.repeat(60), hex: '#112233' }])).toBe(true);
    expect(await verdict([{ name: 'a'.repeat(61), hex: '#112233' }])).toBe(false);
    expect(await verdict([{ name: 'é'.repeat(30), hex: '#112233' }])).toBe(true);
    expect(await verdict([{ name: 'é'.repeat(31), hex: '#112233' }])).toBe(false);
    expect(await verdict([{ name: '€'.repeat(20), hex: '#112233' }])).toBe(true);
    expect(await verdict([{ name: '€'.repeat(21), hex: '#112233' }])).toBe(false);
    expect(await verdict([{ name: '😀'.repeat(15), hex: '#112233' }])).toBe(true);
    expect(await verdict([{ name: '😀'.repeat(16), hex: '#112233' }])).toBe(false);
    for (const control of ['\u0001', '\t', '\n', '\r', '\u001f', '\u007f']) {
      expect(await verdict([{ name: `a${control}b`, hex: '#112233' }]), JSON.stringify(control)).toBe(false);
    }
    expect(await verdict([{ name: 'a\u0080b c', hex: '#112233' }])).toBe(true);
  });

  it('allows 24 colors and refuses 25', async () => {
    const colors = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `Cor ${index}`, hex: '#112233' }));
    expect(await verdict(colors(24))).toBe(true);
    expect(await verdict(colors(25))).toBe(false);
  });

  it('refuses an INSERT of a color outside the contract, as the application role under RLS, and stores nothing', async () => {
    await withoutRow();
    const insert = (colors: unknown) =>
      asManager((transaction) =>
        transaction('client_brand_sections').insert({ client_id: clientId, section_key: 'colors', colors: JSON.stringify(colors), updated_by: managerId })
      );

    const failure = await rejection(insert([{ nome: 'Vermelho terracota', codigoHexadecimal: '#B4472F' }]));
    expect(failure).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await storedColors()).toBeUndefined();

    expect(await rejection(insert([{ name: 'Vermelho', hex: 'B4472F' }]))).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await rejection(insert([COLOR, { ...COLOR, extra: true }]))).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await storedColors()).toBeUndefined();

    await insert([COLOR]);
    expect(await storedColors()).toEqual([COLOR]);
    await withoutRow();
  });

  it('refuses an UPDATE to a color outside the contract and leaves the stored colors as they were', async () => {
    await withoutRow();
    await getOwner().knex('client_brand_sections').insert({ client_id: clientId, section_key: 'colors', colors: JSON.stringify([COLOR]), updated_by: managerId });
    const update = (colors: unknown) =>
      asManager((transaction) =>
        transaction('client_brand_sections')
          .where({ client_id: clientId, section_key: 'colors' })
          .update({ colors: JSON.stringify(colors), updated_by: managerId })
      );

    expect(await rejection(update([{ name: 'Vermelho', hex: 'red' }]))).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await storedColors()).toEqual([COLOR]);
    expect(await rejection(update([COLOR, { name: 'Sem código' }]))).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await storedColors()).toEqual([COLOR]);

    await expect(update([{ name: 'Creme de trigo', hex: '#F3E3C3' }])).resolves.toBe(1);
    expect(await storedColors()).toEqual([{ name: 'Creme de trigo', hex: '#F3E3C3' }]);
    await withoutRow();
  });

  it('binds the table owner too, so no writer outside the API can store the old format', async () => {
    await withoutRow();
    const failure = await rejection(
      getOwner().knex('client_brand_sections').insert({
        client_id: clientId,
        section_key: 'colors',
        colors: JSON.stringify([{ nome: 'Verde montanha', codigoHexadecimal: '#2F5D50' }])
      })
    );
    expect(failure).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await storedColors()).toBeUndefined();
  });

  it('is added validated, so a row outside the format blocks the migration instead of staying behind', async () => {
    const { rows } = await raw<{ rows: readonly { convalidated: boolean; definition: string }[] }>(getOwner().knex, `
      select convalidated, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.client_brand_sections'::regclass and conname = ?
    `, [CONSTRAINT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.convalidated).toBe(true);
    expect(rows[0]!.definition).toContain('brand_colors_valid(colors)');
  });

  it('keeps the function pure, with a fixed search_path, open to the application role and closed to PUBLIC', async () => {
    const { rows } = await raw<{ rows: readonly { volatility: string; fixed_path: boolean; app: boolean; public_role: boolean; definer: boolean }[] }>(getOwner().knex, `
      select
        provolatile as volatility,
        coalesce(proconfig @> array['search_path=""'], false) as fixed_path,
        has_function_privilege('ageniza_app', oid, 'execute') as app,
        has_function_privilege('public', oid, 'execute') as public_role,
        prosecdef as definer
      from pg_proc
      where oid = 'app_private.brand_colors_valid(jsonb)'::regprocedure
    `);
    expect(rows[0]).toEqual({ volatility: 'i', fixed_path: true, app: true, public_role: false, definer: false });
  });
});
