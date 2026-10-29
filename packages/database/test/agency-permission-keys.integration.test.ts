import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #189. `app_private.agency_permission_keys(agency)` is the one reading of what the person bound to the
// transaction holds in an agency, the one the API reads. `app_private.has_agency_permission`, which RLS calls once
// per row, keeps a direct body of its own (a function calling a function made RLS 4.5x to 12.6x slower; see the
// decision file), so this suite is what holds the two to the same answer, key by key. Each scenario below
// is a person whose answer a copy of the old resolution could get wrong: the owner with and without a membership
// row, a role scoped out by another agency, a removed membership, a suspended agency, someone who belongs to two
// agencies. The expected keys are written down by value for the custom roles; the catalog is read from the table
// because the owner holds exactly the catalog, whatever it grows to.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId: string;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencySuspended = randomUUID();
const ownerMember = randomUUID();
const ownerB = randomUUID();
const ownerSuspended = randomUUID();
const admin = randomUUID();
const adminSuspended = randomUUID();
const oneKey = randomUUID();
const twoKeys = randomUUID();
const foreignRole = randomUUID();
const dual = randomUUID();
const removed = randomUUID();
const outsider = randomUUID();
const roleIds: string[] = [];
const peopleIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const customRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const id = randomUUID();
  roleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  await getOwner().knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: id, permission_key })));
  return id;
};

const link = async (agencyId: string, userId: string, roleId: string, status: 'active' | 'removed' = 'active'): Promise<void> => {
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status });
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const keysOf = (userId: string, agencyId: string): Promise<string[]> =>
  asUser(userId, async (transaction) => {
    const result = await transaction.raw('select key from app_private.agency_permission_keys(?::uuid) as held(key) order by key', [agencyId]);
    return (result.rows as { key: string }[]).map((row) => row.key);
  });

const holds = (userId: string, agencyId: string, permission: string): Promise<boolean> =>
  asUser(userId, async (transaction) => {
    const result = await transaction.raw('select app_private.has_agency_permission(?::uuid, ?) as held', [agencyId, permission]);
    return (result.rows as { held: boolean }[])[0]?.held === true;
  });

let catalog: string[];
// No preset carries them: the Owner holds them by possession, and nobody else can.
const OWNER_ONLY_KEYS = ['assinatura.gerenciar', 'colaborador.atribuir_admin'];

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const adminRole = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
  if (adminRole === undefined) throw new Error('System role seeds are missing.');
  adminRoleId = adminRole.id;
  catalog = (await getOwner().knex('permissions').orderBy('key').select('key')).map((row) => row.key as string);

  const people = [
    [ownerMember, 'dona-com-vinculo'], [ownerB, 'dona-b'], [ownerSuspended, 'dona-suspensa'],
    [admin, 'admin'], [adminSuspended, 'admin-suspensa'], [oneKey, 'uma-chave'], [twoKeys, 'duas-chaves'],
    [foreignRole, 'papel-de-outra'], [dual, 'duplo'], [removed, 'removido'], [outsider, 'de-fora']
  ] as const;
  for (const [id, label] of people) {
    peopleIds.push(id);
    await getOwner().knex('auth.user').insert({ id, name: label, email: `${label}.${id.slice(0, 8)}@db-integration.test`, emailVerified: false });
  }
  await getOwner().knex('agencies').insert([
    { id: agencyA, name: 'Agência A', owner_user_id: ownerMember, status: 'active' },
    { id: agencyB, name: 'Agência B', owner_user_id: ownerB, status: 'active' },
    { id: agencySuspended, name: 'Agência suspensa', owner_user_id: ownerSuspended, status: 'suspended' }
  ]);

  const productionRole = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  await link(agencyA, admin, adminRoleId);
  await link(agencyA, oneKey, await customRole(agencyA, ['midia.enviar']));
  await link(agencyA, twoKeys, await customRole(agencyA, ['convite.reenviar', 'colaborador.visualizar']));
  // Another agency's role handed to a membership of A: the scope clause is the whole defence.
  await link(agencyA, foreignRole, await customRole(agencyB, ['colaborador.convidar']));
  await link(agencyA, removed, adminRoleId, 'removed');
  // A person of two agencies holds a different thing in each.
  await link(agencyA, dual, await customRole(agencyA, ['midia.enviar']));
  await link(agencyB, dual, adminRoleId);
  await link(agencySuspended, adminSuspended, adminRoleId);
  // The owner of A has a membership row with a role that carries little: ownership still holds everything.
  // The owner of B has no row at all.
  await link(agencyA, ownerMember, productionRole.id);
});

afterAll(async () => {
  const agencies = [agencyA, agencyB, agencySuspended];
  await getOwner().knex('agency_memberships').whereIn('agency_id', agencies).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
  await getOwner().knex('agencies').whereIn('id', agencies).delete();
  await getOwner().knex('auth.user').whereIn('id', peopleIds).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('app_private.agency_permission_keys (issue #189)', () => {
  it('the owner holds the whole catalog, including the key no preset carries', async () => {
    expect(catalog).toEqual(expect.arrayContaining(OWNER_ONLY_KEYS));
    expect(await keysOf(ownerMember, agencyA)).toEqual(catalog);
  });

  it('an owner without any membership row holds the whole catalog too', async () => {
    // agencyB's owner has no row in agency_memberships.
    expect(await getOwner().knex('agency_memberships').where({ agency_id: agencyB, user_id: ownerB }).select('id')).toHaveLength(0);
    expect(await keysOf(ownerB, agencyB)).toEqual(catalog);
  });

  it('the Admin preset holds every key except the two only the owner holds', async () => {
    expect(await keysOf(admin, agencyA)).toEqual(catalog.filter((key) => !OWNER_ONLY_KEYS.includes(key)));
  });

  it('a custom role of one key, and one of two, hold exactly those keys', async () => {
    expect(await keysOf(oneKey, agencyA)).toEqual(['midia.enviar']);
    expect(await keysOf(twoKeys, agencyA)).toEqual(['colaborador.visualizar', 'convite.reenviar']);
  });

  it('a membership pointing at another agency\'s role holds nothing', async () => {
    expect(await keysOf(foreignRole, agencyA)).toEqual([]);
  });

  it('a removed membership holds nothing, even with the Admin role', async () => {
    expect(await keysOf(removed, agencyA)).toEqual([]);
  });

  it('a person of two agencies holds in each only what that agency gave', async () => {
    expect(await keysOf(dual, agencyA)).toEqual(['midia.enviar']);
    expect(await keysOf(dual, agencyB)).toEqual(catalog.filter((key) => !OWNER_ONLY_KEYS.includes(key)));
  });

  it('the owner and an Admin of a suspended agency hold nothing there', async () => {
    expect(await keysOf(ownerSuspended, agencySuspended)).toEqual([]);
    expect(await keysOf(adminSuspended, agencySuspended)).toEqual([]);
  });

  it('suspending an agency takes the keys away at once, and reactivating gives them back', async () => {
    await getOwner().knex('agencies').where({ id: agencyA }).update({ status: 'suspended' });
    try {
      expect(await keysOf(admin, agencyA)).toEqual([]);
      expect(await keysOf(ownerMember, agencyA)).toEqual([]);
      expect(await holds(admin, agencyA, 'midia.enviar')).toBe(false);
      expect(await holds(ownerMember, agencyA, 'midia.enviar')).toBe(false);
    } finally {
      await getOwner().knex('agencies').where({ id: agencyA }).update({ status: 'active' });
    }
    expect(await keysOf(admin, agencyA)).toHaveLength(catalog.length - OWNER_ONLY_KEYS.length);
    expect(await holds(admin, agencyA, 'midia.enviar')).toBe(true);
    expect(await holds(ownerMember, agencyA, 'midia.enviar')).toBe(true);
  });

  it('a person with no tie to the agency, and an agency that does not exist, get the empty set', async () => {
    expect(await keysOf(outsider, agencyA)).toEqual([]);
    expect(await keysOf(admin, randomUUID())).toEqual([]);
  });

  it('answers for the person bound to the transaction only: a transaction with nobody bound gets the empty set', async () => {
    const result = await getApplication().knex.raw('select key from app_private.agency_permission_keys(?::uuid) as held(key)', [agencyA]);
    expect(result.rows).toEqual([]);
  });

  it('has no parameter that names a person, so nobody can ask what someone else holds', async () => {
    const [row] = (await getOwner().knex.raw(`
      select pg_get_function_arguments(oid) as arguments
      from pg_proc
      where pronamespace = 'app_private'::regnamespace and proname = 'agency_permission_keys'
    `)).rows as { arguments: string }[];
    expect(row?.arguments).toBe('p_agency_id uuid');
  });

  it('is security definer with a fixed search_path, callable by the application role and not by PUBLIC', async () => {
    const [row] = (await getOwner().knex.raw(`
      select prosecdef, provolatile, proconfig, proretset,
             has_function_privilege('ageniza_app', oid, 'execute') as app_can,
             has_function_privilege('public', oid, 'execute') as public_can
      from pg_proc
      where pronamespace = 'app_private'::regnamespace and proname = 'agency_permission_keys'
    `)).rows as { prosecdef: boolean; provolatile: string; proconfig: string[]; proretset: boolean; app_can: boolean; public_can: boolean }[];
    expect(row).toMatchObject({ prosecdef: true, provolatile: 's', proretset: true, app_can: true, public_can: false });
    expect(row?.proconfig).toContain('search_path=""');
  });
});

describe('app_private.has_agency_permission agrees with the keys, key by key (issue #189)', () => {
  // [label, person, agency]
  const people: readonly (readonly [string, string, string])[] = [
    ['the owner with a membership row', ownerMember, agencyA],
    ['the owner without one', ownerB, agencyB],
    ['the Admin', admin, agencyA],
    ['a custom role of one key', oneKey, agencyA],
    ['a custom role of two keys', twoKeys, agencyA],
    ['a role of another agency', foreignRole, agencyA],
    ['a removed membership', removed, agencyA],
    ['someone with no tie', outsider, agencyA],
    // A suspended agency authorizes nobody, the owner included; and a person of two agencies is compared in each.
    ['the owner of a suspended agency', ownerSuspended, agencySuspended],
    ['an Admin of a suspended agency', adminSuspended, agencySuspended],
    ['a person of two agencies, in A', dual, agencyA],
    ['a person of two agencies, in B', dual, agencyB]
  ];

  it.each(people)('%s: has_agency_permission is true for exactly the keys the function returns, for every key of the catalog', async (_label, person, agencyId) => {
    const keys = await keysOf(person, agencyId);
    for (const key of catalog) {
      expect(await holds(person, agencyId, key), key).toBe(keys.includes(key));
    }
  });

  // `agency_user_can` (20261007001200_contents.mjs) is a third SQL copy of the same resolution, for a person passed by
  // argument: the contents triggers use it to check that an owner or an assignee is a collaborator who can see Conteúdo.
  // It is not edited here (an applied migration is not), so this is what holds it to the keys when someone changes the rule.
  it.each(people)('%s: agency_user_can answers like the keys, for every key of the catalog', async (_label, person, agencyId) => {
    const keys = await keysOf(person, agencyId);
    for (const key of catalog) {
      const result = await getOwner().knex.raw('select app_private.agency_user_can(?::uuid, ?::uuid, ?) as held', [agencyId, person, key]);
      expect((result.rows as { held: boolean }[])[0]?.held, key).toBe(keys.includes(key));
    }
  });

  it('keeps the answers the policies were written against: the one-key role holds its key and nothing else', async () => {
    expect(await holds(oneKey, agencyA, 'midia.enviar')).toBe(true);
    expect(await holds(oneKey, agencyA, 'convite.reenviar')).toBe(false);
    expect(await holds(admin, agencyA, 'colaborador.atribuir_admin')).toBe(false);
    expect(await holds(ownerMember, agencyA, 'colaborador.atribuir_admin')).toBe(true);
    expect(await holds(admin, agencyA, 'assinatura.gerenciar')).toBe(false);
    expect(await holds(ownerMember, agencyA, 'assinatura.gerenciar')).toBe(true);
  });

  it('fails closed for a key outside the catalog, even for the owner (it used to answer true for any text)', async () => {
    expect(catalog).not.toContain('cliente.nao_existe');
    expect(await holds(ownerMember, agencyA, 'cliente.nao_existe')).toBe(false);
    expect(await holds(ownerB, agencyB, 'cliente.nao_existe')).toBe(false);
    expect(await holds(admin, agencyA, 'cliente.nao_existe')).toBe(false);
  });

  it.each(people)('%s: the three functions agree that nobody holds a key outside the catalog (#508)', async (_label, person, agencyId) => {
    const outside = 'cliente.nao_existe';
    expect(await keysOf(person, agencyId)).not.toContain(outside);
    expect(await holds(person, agencyId, outside)).toBe(false);
    const result = await getOwner().knex.raw('select app_private.agency_user_can(?::uuid, ?::uuid, ?) as held', [agencyId, person, outside]);
    expect((result.rows as { held: boolean }[])[0]?.held).toBe(false);
  });

  it('agency_user_can keeps its signature, security definer, stability and search_path, and stays out of reach of the application role and PUBLIC (#508)', async () => {
    const [row] = (await getOwner().knex.raw(`
      select prosecdef, provolatile, proconfig, prorettype::regtype::text as returns, pg_get_function_arguments(oid) as arguments,
             has_function_privilege('ageniza_app', oid, 'execute') as app_can,
             has_function_privilege('public', oid, 'execute') as public_can
      from pg_proc
      where pronamespace = 'app_private'::regnamespace and proname = 'agency_user_can'
    `)).rows as { prosecdef: boolean; provolatile: string; proconfig: string[]; returns: string; arguments: string; app_can: boolean; public_can: boolean }[];
    expect(row).toMatchObject({
      prosecdef: true, provolatile: 's', returns: 'boolean', app_can: false, public_can: false,
      arguments: 'p_agency_id uuid, p_user_id uuid, p_permission text'
    });
    expect(row?.proconfig).toContain('search_path=""');
  });

  it('answers false with nobody bound, and for an agency that does not exist', async () => {
    const unbound = await getApplication().knex.raw('select app_private.has_agency_permission(?::uuid, ?) as held', [agencyA, 'midia.enviar']);
    expect(unbound.rows[0].held).toBe(false);
    expect(await holds(ownerMember, randomUUID(), 'midia.enviar')).toBe(false);
  });

  it('does not call the keys function: RLS runs it once per row, and a definer calling a definer cannot be inlined (4.5x to 12.6x slower)', async () => {
    const [row] = (await getOwner().knex.raw(`
      select prosrc
      from pg_proc
      where pronamespace = 'app_private'::regnamespace and proname = 'has_agency_permission'
    `)).rows as { prosrc: string }[];
    expect(row?.prosrc).not.toContain('agency_permission_keys');
    expect(row?.prosrc).toContain('public.agency_memberships');
  });

  it('keeps its signature, security definer, stability and search_path, so every policy that calls it is untouched', async () => {
    const [row] = (await getOwner().knex.raw(`
      select prosecdef, provolatile, proconfig, prorettype::regtype::text as returns,
             has_function_privilege('ageniza_app', oid, 'execute') as app_can,
             has_function_privilege('public', oid, 'execute') as public_can
      from pg_proc
      where pronamespace = 'app_private'::regnamespace and proname = 'has_agency_permission'
    `)).rows as { prosecdef: boolean; provolatile: string; proconfig: string[]; returns: string; app_can: boolean; public_can: boolean }[];
    expect(row).toMatchObject({ prosecdef: true, provolatile: 's', returns: 'boolean', app_can: true, public_can: false });
    expect(row?.proconfig).toContain('search_path=""');
  });

  it('is the function the RLS policies read: invitations_select shows an invitation to the holder of convite.reenviar and hides it from the holder of an unrelated key', async () => {
    const invitationId = randomUUID();
    const adminRole = adminRoleId;
    await getOwner().knex('invitations').insert({
      id: invitationId, agency_id: agencyA, purpose: 'collaborator_invite', email: `keys-${invitationId}@db-integration.test`,
      role_id: adminRole, token_hash: `hash-${invitationId}`, expires_at: new Date(Date.now() + 86_400_000)
    });
    try {
      const seenByHolder = await asUser(twoKeys, (transaction) => transaction('invitations').where({ id: invitationId }).select('id'));
      const seenByOther = await asUser(oneKey, (transaction) => transaction('invitations').where({ id: invitationId }).select('id'));
      expect(seenByHolder).toHaveLength(1);
      expect(seenByOther).toHaveLength(0);
    } finally {
      await getOwner().knex('invitations').where({ id: invitationId }).delete();
    }
  });

  it('every key a policy or a function asks for by literal exists in the catalog, so failing closed for unknown keys closes nothing that was open', async () => {
    // Read in JS, not in SQL: the pattern holds `?`, which knex would take for a binding.
    // The first argument may be a call (`app_private.client_agency_id(client_id)`), so it allows one level of parentheses.
    const callWithLiteral = /(?:has_agency_permission|lock_content_for_agency|agency_user_can)\((?:[^()]|\([^()]*\))*?,\s*'([^']+)'/g;
    const policies = (await getOwner().knex.raw(
      "select coalesce(qual, '') || ' ' || coalesce(with_check, '') as body from pg_policies"
    )).rows as { body: string }[];
    const functions = (await getOwner().knex.raw(
      "select prosrc as body from pg_proc where pronamespace in ('public'::regnamespace, 'app_private'::regnamespace)"
    )).rows as { body: string }[];

    // A policy always names the key: if one call has no literal extracted, the pattern missed it and this fails.
    const policyCalls = policies.reduce((count, row) => count + (row.body.match(/has_agency_permission\(/g)?.length ?? 0), 0);
    const policyLiterals = policies.reduce((count, row) => count + [...row.body.matchAll(callWithLiteral)].length, 0);
    expect(policyCalls).toBeGreaterThanOrEqual(80);
    expect(policyLiterals).toBe(policyCalls);

    const asked = [...new Set([...policies, ...functions].flatMap((row) => [...row.body.matchAll(callWithLiteral)].map((match) => match[1] as string)))].sort();
    expect(asked).toContain('midia.enviar');
    expect(asked).toContain('conteudo.operar');
    expect(asked.length).toBeGreaterThanOrEqual(16);
    expect(asked.filter((key) => !catalog.includes(key))).toEqual([]);
  });
});
