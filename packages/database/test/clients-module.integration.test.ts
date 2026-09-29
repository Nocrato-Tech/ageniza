import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #122. This suite proves the invariants of docs/business/decisions.md
// ("Regras invioláveis de clientes, garantidas pelo banco", 2026-09-26) and specs/clientes.md §5
// against the real schema, connected as ageniza_app. RLS filters silently, so every assertion here
// checks either an affected row count or a thrown error, never a bare resolved value.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();

const adminA = randomUUID();
const managerA = randomUUID();
const productionA = randomUUID();
const salesA = randomUUID();
const financeA = randomUUID();
const adminB = randomUUID();

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();

const portalA1 = randomUUID();
const portalA2 = randomUUID();
const portalB = randomUUID();

const allUsers = [adminA, managerA, productionA, salesA, financeA, adminB, portalA1, portalA2, portalB];
const allAgencies = [agencyA, agencyB];
const allClients = [clientA1, clientA2, clientArchived, clientB];

let roleIds: Record<'admin' | 'account_manager' | 'production' | 'sales' | 'finance', string>;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(
  userId: string,
  work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]
): Promise<TResult> => withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const roles = await getOwner()
    .knex('roles')
    .whereNull('agency_id')
    .whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance'])
    .select('id', 'key');
  const byKey = new Map(roles.map((role) => [role.key as string, role.id as string]));
  roleIds = {
    admin: byKey.get('admin')!,
    account_manager: byKey.get('account_manager')!,
    production: byKey.get('production')!,
    sales: byKey.get('sales')!,
    finance: byKey.get('finance')!
  };
  if (Object.values(roleIds).some((id) => id === undefined)) throw new Error('System role seeds are missing.');

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(
      allUsers.map((id) => ({ id, name: `User ${id}`, email: `${id}@example.test`, emailVerified: true }))
    );

    await transaction('agencies').insert([
      { id: agencyA, name: `Agency A ${agencyA}` },
      { id: agencyB, name: `Agency B ${agencyB}` }
    ]);

    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: adminA, role_id: roleIds.admin },
      { agency_id: agencyA, user_id: managerA, role_id: roleIds.account_manager },
      { agency_id: agencyA, user_id: productionA, role_id: roleIds.production },
      { agency_id: agencyA, user_id: salesA, role_id: roleIds.sales },
      { agency_id: agencyA, user_id: financeA, role_id: roleIds.finance },
      { agency_id: agencyB, user_id: adminB, role_id: roleIds.admin }
    ]);

    await transaction('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Client A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Client A2 ${clientA2}` },
      { id: clientArchived, agency_id: agencyA, name: `Client Archived ${clientArchived}`, status: 'archived', archived_at: new Date() },
      { id: clientB, agency_id: agencyB, name: `Client B ${clientB}` }
    ]);

    await transaction('client_memberships').insert([
      { client_id: clientA1, user_id: portalA1 },
      { client_id: clientA2, user_id: portalA2 },
      { client_id: clientB, user_id: portalB }
    ]);
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('client_thread_comments').whereIn('client_id', allClients).delete();
      await transaction('client_threads').whereIn('client_id', allClients).delete();
      await transaction('client_personas').whereIn('client_id', allClients).delete();
      await transaction('client_brand_sections').whereIn('client_id', allClients).delete();
      await transaction('audit.events').whereIn('agency_id', allAgencies).delete();
      await transaction('client_memberships').whereIn('client_id', allClients).delete();
      await transaction('agency_memberships').whereIn('agency_id', allAgencies).delete();
      await transaction('clients').whereIn('id', allClients).delete();
      await transaction('agencies').whereIn('id', allAgencies).delete();
      await transaction('auth.user').whereIn('id', allUsers).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('CLIENTS module database schema, RLS and permissions (#122)', () => {
  it('grants exactly the five presets that specs/clientes.md §2 lists', async () => {
    const rows = await getOwner()
      .knex('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .whereNull('roles.agency_id')
      .whereIn('role_permissions.permission_key', [
        'cliente.visualizar',
        'cliente.operar',
        'cliente.cadastrar',
        'cliente.arquivar',
        'cliente.remover_usuario'
      ])
      .select('roles.key as role', 'role_permissions.permission_key as permission');

    const byPermission = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byPermission.get(row.permission) ?? new Set<string>();
      set.add(row.role);
      byPermission.set(row.permission, set);
    }

    expect(byPermission.get('cliente.visualizar')).toEqual(new Set(['admin', 'account_manager', 'production', 'sales', 'finance']));
    expect(byPermission.get('cliente.operar')).toEqual(new Set(['admin', 'account_manager']));
    expect(byPermission.get('cliente.cadastrar')).toEqual(new Set(['admin', 'account_manager']));
    expect(byPermission.get('cliente.arquivar')).toEqual(new Set(['admin']));
    expect(byPermission.get('cliente.remover_usuario')).toEqual(new Set(['admin']));
  });

  it('lets cliente.cadastrar create a client and blocks a role without it', async () => {
    const newClientId = randomUUID();
    await expect(
      asUser(adminA, (transaction) =>
        transaction('clients').insert({ id: newClientId, agency_id: agencyA, name: `New Client ${newClientId}` }).returning('id')
      )
    ).resolves.toHaveLength(1);
    await getOwner().knex('clients').where({ id: newClientId }).delete();

    await expect(
      asUser(productionA, (transaction) =>
        transaction('clients').insert({ id: randomUUID(), agency_id: agencyA, name: 'Denied by production' })
      )
    ).rejects.toThrow(/row-level security/);
  });

  it('enforces the unique active name per agency under concurrent inserts, and lets an archived duplicate coexist', async () => {
    const suffix = randomUUID();
    const canonical = `Padaria Central ${suffix}`;
    const variant = ` padaria central ${suffix} `;
    const idA = randomUUID();
    const idB = randomUUID();

    const results = await Promise.allSettled([
      asUser(adminA, (transaction) => transaction('clients').insert({ id: idA, agency_id: agencyA, name: canonical })),
      asUser(adminA, (transaction) => transaction('clients').insert({ id: idB, agency_id: agencyA, name: variant }))
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });

    const survivingId = (await getOwner().knex('clients').whereIn('id', [idA, idB]).first('id'))?.id as string;
    expect(survivingId).toBeDefined();

    // Archiving the surviving row through the owner connection (the security definer function that
    // performs this in production is issue #123's scope) frees the name for a genuine second insert.
    await getOwner().knex('clients').where({ id: survivingId }).update({ status: 'archived', archived_at: new Date() });
    const secondId = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('clients').insert({ id: secondId, agency_id: agencyA, name: variant }).returning('id'))
    ).resolves.toHaveLength(1);

    await getOwner().knex('clients').whereIn('id', [idA, idB, secondId]).delete();
  });

  it('accepts an http(s) website and rejects one without a scheme', async () => {
    // The check constraint once read '^https$1://' because knex.raw rewrote the regex's question
    // mark as a bind placeholder, which rejected every real site. Both http and https are valid
    // per specs/clientes.md §3 ("URL http(s)").
    const httpsId = randomUUID();
    await expect(
      asUser(adminA, (transaction) =>
        transaction('clients')
          .insert({ id: httpsId, agency_id: agencyA, name: `Website https ${httpsId}`, website: 'https://example.test' })
          .returning('id')
      )
    ).resolves.toHaveLength(1);
    await expect(getOwner().knex('clients').where({ id: httpsId }).first('website')).resolves.toMatchObject({ website: 'https://example.test' });

    const httpId = randomUUID();
    await expect(
      asUser(adminA, (transaction) =>
        transaction('clients')
          .insert({ id: httpId, agency_id: agencyA, name: `Website http ${httpId}`, website: 'http://example.test' })
          .returning('id')
      )
    ).resolves.toHaveLength(1);

    await expect(
      asUser(adminA, (transaction) =>
        transaction('clients').insert({ id: randomUUID(), agency_id: agencyA, name: `Website bad ${randomUUID()}`, website: 'example.test' })
      )
    ).rejects.toThrow(/check constraint/);

    await getOwner().knex('clients').whereIn('id', [httpsId, httpId]).delete();
  });

  it('normalizes tabs, repeated spaces and NBSP in the active-name index while distinct names coexist', async () => {
    // The real index must collapse any run of whitespace, not just trim ASCII spaces at the ends,
    // and it must not collapse the letter "s" -- the buggy expression was 's+', which made
    // "Class"/"Cla" and "Casa Nova"/"Ca a Nova" collide as if they were the same name.
    const base = `Nav ${randomUUID()}`;
    const variants = [base, `${base}\t`, `${base}  `, `${base}${String.fromCharCode(160)}`];
    const variantIds = variants.map(() => randomUUID());

    await expect(
      asUser(adminA, (transaction) => transaction('clients').insert({ id: variantIds[0], agency_id: agencyA, name: variants[0] }).returning('id'))
    ).resolves.toHaveLength(1);
    for (let index = 1; index < variants.length; index += 1) {
      await expect(
        asUser(adminA, (transaction) => transaction('clients').insert({ id: variantIds[index], agency_id: agencyA, name: variants[index] }))
      ).rejects.toMatchObject({ code: '23505' });
    }

    const indexDef = await getOwner().knex.raw(`select pg_get_indexdef('public.clients_active_name_unique'::regclass) as def`);
    expect(indexDef.rows[0].def).toContain('[[:space:]]+');

    const suffix = randomUUID();
    const coexisting = [`Class ${suffix}`, `Cla ${suffix}`, `Casa Nova ${suffix}`, `Ca a Nova ${suffix}`];
    const coexistingIds = coexisting.map(() => randomUUID());
    for (let index = 0; index < coexisting.length; index += 1) {
      await expect(
        asUser(adminA, (transaction) =>
          transaction('clients').insert({ id: coexistingIds[index], agency_id: agencyA, name: coexisting[index] }).returning('id')
        )
      ).resolves.toHaveLength(1);
    }

    await getOwner().knex('clients').whereIn('id', [...variantIds, ...coexistingIds]).delete();
  });

  it('lets account_manager edit contact_phone but not status, by column privilege', async () => {
    await expect(
      asUser(managerA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ contact_phone: '+55 11 90000-0000', updated_by: managerA }))
    ).resolves.toBe(1);

    await expect(
      asUser(managerA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ status: 'archived' }))
    ).rejects.toThrow(/permission denied/);

    await getOwner().knex('clients').where({ id: clientA1 }).update({ contact_phone: null, updated_by: null });
  });

  it('pins updated_by to the caller on clients, brand sections and personas', async () => {
    // The column stays writable (it is how "quem alterou por último" gets recorded), so without a
    // WITH CHECK pinning it to the caller, an editor could attribute their own change to anyone --
    // a user in another agency, or the client's own portal member.
    await expect(
      asUser(managerA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ contact_phone: '1', updated_by: adminB }))
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(managerA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ contact_phone: '1', updated_by: portalA1 }))
    ).rejects.toThrow(/row-level security/);

    const sectionKey = 'positioning' as const;
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_brand_sections').insert({ client_id: clientA1, section_key: sectionKey, body: 'x', updated_by: adminB })
      )
    ).rejects.toThrow(/row-level security/);
    await getOwner().knex('client_brand_sections').insert({ client_id: clientA1, section_key: sectionKey, body: 'own', updated_by: managerA });
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).update({ body: 'y', updated_by: portalA1 })
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).update({ body: 'y', updated_by: managerA })
      )
    ).resolves.toBe(1);
    await getOwner().knex('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).delete();

    const personaId = randomUUID();
    await expect(
      asUser(managerA, (transaction) => transaction('client_personas').insert({ id: personaId, client_id: clientA1, name: 'x', updated_by: adminB }))
    ).rejects.toThrow(/row-level security/);
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'own', updated_by: managerA });
    await expect(
      asUser(managerA, (transaction) => transaction('client_personas').where({ id: personaId }).update({ name: 'y', updated_by: portalA1 }))
    ).rejects.toThrow(/row-level security/);
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('never lets an UPDATE move a row to another client or agency by rewriting its tenant columns', async () => {
    // A table-wide UPDATE grant combined with a WITH CHECK that reads the identity columns off the
    // *new* row would let a caller with cliente.operar on both clients rewrite client_id/agency_id
    // and move the row instead of editing it. The column grant has to make that impossible on its
    // own, independent of what any policy checks.
    await expect(
      asUser(adminA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ agency_id: agencyB }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(adminA, (transaction) => transaction('clients').where({ id: clientA1 }).update({ id: randomUUID() }))
    ).rejects.toThrow(/permission denied/);

    const sectionKey = 'observations' as const;
    await getOwner().knex('client_brand_sections').insert({ client_id: clientA1, section_key: sectionKey, body: 'Immovable' });
    await expect(
      asUser(managerA, (transaction) => transaction('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).update({ client_id: clientA2 }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(managerA, (transaction) => transaction('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).update({ section_key: 'branding' }))
    ).rejects.toThrow(/permission denied/);
    await getOwner().knex('client_brand_sections').where({ client_id: clientA1, section_key: sectionKey }).delete();

    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Immovable persona' });
    await expect(
      asUser(managerA, (transaction) => transaction('client_personas').where({ id: personaId }).update({ client_id: clientA2 }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(managerA, (transaction) => transaction('client_personas').where({ id: personaId }).update({ id: randomUUID() }))
    ).rejects.toThrow(/permission denied/);
    await getOwner().knex('client_personas').where({ id: personaId }).delete();

    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency' });
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ client_id: clientA2 }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ section_key: 'branding' }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ opened_side: 'client' }))
    ).rejects.toThrow(/permission denied/);
    await getOwner().knex('client_threads').where({ id: threadId }).delete();
  });

  it('rejects every write on clients, brand sections, personas, threads and comments once the client is archived', async () => {
    await expect(
      asUser(adminA, (transaction) => transaction('clients').where({ id: clientArchived }).update({ contact_phone: '+55 11 91111-1111' }))
    ).resolves.toBe(0);

    await expect(
      asUser(adminA, (transaction) =>
        transaction('client_brand_sections').insert({ client_id: clientArchived, section_key: 'branding', body: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);

    await expect(
      asUser(adminA, (transaction) =>
        transaction('client_personas').insert({ id: randomUUID(), client_id: clientArchived, name: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);

    await expect(
      asUser(adminA, (transaction) =>
        transaction('client_threads').insert({
          id: randomUUID(), client_id: clientArchived, section_key: 'branding', opened_by: adminA, opened_side: 'agency'
        })
      )
    ).rejects.toThrow(/row-level security/);

    // A comment needs a thread row to reference (the composite FK trigger requires it), created
    // directly through the owner connection since no route creates one on an archived client.
    const archivedThreadId = randomUUID();
    await getOwner().knex('client_threads').insert({
      id: archivedThreadId, client_id: clientArchived, section_key: 'branding', opened_by: adminA, opened_side: 'agency'
    });
    await expect(
      asUser(adminA, (transaction) =>
        transaction('client_thread_comments').insert({
          id: randomUUID(), thread_id: archivedThreadId, client_id: clientArchived, author_user_id: adminA, author_side: 'agency', body: 'Denied'
        })
      )
    ).rejects.toThrow(/row-level security/);
    await getOwner().knex('client_threads').where({ id: archivedThreadId }).delete();
  });

  it('hides a sibling client of the same agency from a portal member, and blocks their writes on it', async () => {
    const sectionId = { client_id: clientA2, section_key: 'branding' as const };
    await getOwner().knex('client_brand_sections').insert({ ...sectionId, body: 'Client A2 branding', updated_by: adminA });
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA2, name: 'A2 persona' });
    const threadId = randomUUID();
    const commentId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA2, section_key: 'branding', opened_by: adminA, opened_side: 'agency' });
    await getOwner().knex('client_thread_comments').insert({ id: commentId, thread_id: threadId, client_id: clientA2, author_user_id: adminA, author_side: 'agency', body: 'A2 only' });

    await expect(asUser(portalA1, (transaction) => transaction('client_brand_sections').where(sectionId).select('client_id'))).resolves.toEqual([]);
    await expect(asUser(portalA1, (transaction) => transaction('client_personas').where({ client_id: clientA2 }).select('id'))).resolves.toEqual([]);
    await expect(asUser(portalA1, (transaction) => transaction('client_threads').where({ client_id: clientA2 }).select('id'))).resolves.toEqual([]);
    await expect(asUser(portalA1, (transaction) => transaction('client_thread_comments').where({ client_id: clientA2 }).select('id'))).resolves.toEqual([]);

    await expect(
      asUser(portalA1, (transaction) => transaction('client_brand_sections').insert({ client_id: clientA2, section_key: 'observations', body: 'Denied' }))
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portalA1, (transaction) => transaction('client_personas').insert({ id: randomUUID(), client_id: clientA2, name: 'Denied' }))
    ).rejects.toThrow(/row-level security/);

    // Regra 3 (o portal não escreve no estudo) also has to hold on the member's OWN client, not
    // just a sibling they have no vínculo with at all -- a policy of "operar OR is_client_member"
    // would pass every assertion above yet still let this pair through. A real row is inserted
    // first so the UPDATE denial below is a genuine 0-rows-matched, not a vacuous "nothing there".
    const ownSectionId = { client_id: clientA1, section_key: 'observations' as const };
    await getOwner().knex('client_brand_sections').insert({ ...ownSectionId, body: 'A1 own section' });
    await expect(
      asUser(portalA1, (transaction) => transaction('client_brand_sections').insert({ client_id: clientA1, section_key: 'colors', body: 'Denied' }))
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portalA1, (transaction) => transaction('client_brand_sections').where(ownSectionId).update({ body: 'Denied' }))
    ).resolves.toBe(0);
    await expect(
      asUser(portalA1, (transaction) => transaction('client_personas').insert({ id: randomUUID(), client_id: clientA1, name: 'Denied' }))
    ).rejects.toThrow(/row-level security/);
    await getOwner().knex('client_brand_sections').where(ownSectionId).delete();

    await getOwner().knex('client_thread_comments').where({ id: commentId }).delete();
    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
    await getOwner().knex('client_brand_sections').where(sectionId).delete();
  });

  it('hides an archived persona from the portal, while writes to it stay agency-only regardless', async () => {
    const activePersonaId = randomUUID();
    const archivedPersonaId = randomUUID();
    await getOwner().knex('client_personas').insert([
      { id: activePersonaId, client_id: clientA1, name: 'Active persona' },
      { id: archivedPersonaId, client_id: clientA1, name: 'Archived persona', status: 'archived' }
    ]);

    await expect(asUser(portalA1, (transaction) => transaction('client_personas').where({ client_id: clientA1 }).orderBy('name').select('id'))).resolves.toEqual([
      { id: activePersonaId }
    ]);
    await expect(asUser(adminA, (transaction) => transaction('client_personas').where({ client_id: clientA1 }).select('id'))).resolves.toEqual(
      expect.arrayContaining([{ id: activePersonaId }, { id: archivedPersonaId }])
    );

    // client_personas' UPDATE grant is column-restricted (name/description/pains/desires/
    // objections/status/updated_by/updated_at), but the portal fails earlier than that: the USING
    // clause requires cliente.operar, which no vínculo de cliente ever satisfies, so this is a
    // policy denial (0 matching rows), not a column privilege one.
    await expect(
      asUser(portalA1, (transaction) => transaction('client_personas').where({ id: activePersonaId }).update({ name: 'Renamed by portal' }))
    ).resolves.toBe(0);

    await getOwner().knex('client_personas').whereIn('id', [activePersonaId, archivedPersonaId]).delete();
  });

  it('lets threads and comments open only on the side the credential actually holds', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Thread persona' });

    // Portal member opens as 'client': succeeds, and the first comment on it as 'client' succeeds too.
    const clientSideThreadId = randomUUID();
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_threads').insert({ id: clientSideThreadId, client_id: clientA1, persona_id: personaId, opened_by: portalA1, opened_side: 'client' }).returning('id')
      )
    ).resolves.toHaveLength(1);
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: clientSideThreadId, client_id: clientA1, author_user_id: portalA1, author_side: 'client', body: 'From the client' }).returning('id')
      )
    ).resolves.toHaveLength(1);

    // The same member cannot claim the 'agency' side.
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_threads').insert({ id: randomUUID(), client_id: clientA1, persona_id: personaId, opened_by: portalA1, opened_side: 'agency' })
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: clientSideThreadId, client_id: clientA1, author_user_id: portalA1, author_side: 'agency', body: 'Forged side' })
      )
    ).rejects.toThrow(/row-level security/);

    // production holds cliente.visualizar but not cliente.operar, and has no client vínculo: neither side works.
    await expect(
      asUser(productionA, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: clientSideThreadId, client_id: clientA1, author_user_id: productionA, author_side: 'agency', body: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(productionA, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: clientSideThreadId, client_id: clientA1, author_user_id: productionA, author_side: 'client', body: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);

    await getOwner().knex('client_thread_comments').where({ thread_id: clientSideThreadId }).delete();
    await getOwner().knex('client_threads').where({ id: clientSideThreadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('never lets INSERT plant resolved_at/resolved_by on a thread, or a forged created_at on either table', async () => {
    // The table's own INSERT grant, inherited from the foundation's default privileges, covered
    // every column until this fix: a portal member could open a thread already "resolved" (skipping
    // "aguardando a agência" and crediting the resolution to someone else), and either side could
    // forge created_at, which the derived open/resolved state and "most recent first" ordering both
    // depend on comparing.
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_threads').insert({
          id: randomUUID(), client_id: clientA1, section_key: 'observations', opened_by: portalA1, opened_side: 'client',
          resolved_at: new Date('2999-01-01'), resolved_by: adminA
        })
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(adminA, (transaction) =>
        transaction('client_threads').insert({
          id: randomUUID(), client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency',
          created_at: new Date('2000-01-01')
        })
      )
    ).rejects.toThrow(/permission denied/);

    const forgeThreadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: forgeThreadId, client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency' });
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_thread_comments').insert({
          id: randomUUID(), thread_id: forgeThreadId, client_id: clientA1, author_user_id: portalA1, author_side: 'client', body: 'From the future',
          created_at: new Date('2999-01-01')
        })
      )
    ).rejects.toThrow(/permission denied/);
    await getOwner().knex('client_threads').where({ id: forgeThreadId }).delete();
  });

  it('rejects caller-supplied updated_at, status and created_at on a section or persona INSERT', async () => {
    // The inherited table-wide INSERT let the caller forge the row's own stamps, and a persona could
    // be created already archived by the very statement that creates it. The column grant now leaves
    // them to their defaults.
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_brand_sections').insert({
          client_id: clientA1, section_key: 'observations', body: 'Forged stamp', updated_by: managerA, updated_at: new Date('2001-01-01')
        })
      )
    ).rejects.toThrow(/permission denied/);

    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_personas').insert({ id: randomUUID(), client_id: clientA1, name: 'Born archived', updated_by: managerA, status: 'archived' })
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_personas').insert({
          id: randomUUID(), client_id: clientA1, name: 'Backdated', updated_by: managerA, created_at: new Date('2001-01-01')
        })
      )
    ).rejects.toThrow(/permission denied/);

    // The legitimate column set still inserts, and the defaults are applied.
    const personaId = randomUUID();
    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Legitimate', updated_by: managerA }).returning('id')
      )
    ).resolves.toHaveLength(1);
    const created = await getOwner().knex('client_personas').where({ id: personaId }).first('status', 'created_at');
    expect(created?.status).toBe('active');
    expect(created?.created_at).not.toBeNull();

    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('does not resolve an open thread on an UPDATE outside resolved_at/resolved_by', async () => {
    // The stamping trigger is scoped to a resolve. An ordinary column update -- including one made by
    // the schema owner, whom no grant can hide it from -- must leave an open thread open; otherwise a
    // future backfill (Content will add content_id here) silently resolves every thread it touches.
    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency' });

    await getOwner().knex('client_threads').where({ id: threadId }).update({ section_key: 'observations' });
    const untouched = await getOwner().knex('client_threads').where({ id: threadId }).first('resolved_at', 'resolved_by');
    expect(untouched?.resolved_at).toBeNull();
    expect(untouched?.resolved_by).toBeNull();

    await getOwner().knex('client_threads').where({ id: threadId }).delete();
  });

  it('lets only cliente.operar resolve a thread, pins resolved_at/resolved_by, and never lets it be unresolved', async () => {
    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, section_key: 'observations', opened_by: portalA1, opened_side: 'client' });

    await expect(
      asUser(portalA1, (transaction) => transaction('client_threads').where({ id: threadId }).update({ resolved_at: new Date(), resolved_by: portalA1 }))
    ).resolves.toBe(0);

    // resolved_by has to be the resolver: WITH CHECK rejects an attempt to attribute the
    // resolution to someone else, even another agency collaborator.
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ resolved_at: new Date(), resolved_by: adminA }))
    ).rejects.toThrow(/row-level security/);

    // A forged future resolved_at is silently overwritten by the stamping trigger: the row that
    // lands is resolved now, not in 2999.
    const beforeResolve = new Date();
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ resolved_at: new Date('2999-01-01'), resolved_by: managerA }))
    ).resolves.toBe(1);
    const resolvedRow = await getOwner().knex('client_threads').where({ id: threadId }).first('resolved_at', 'resolved_by');
    expect(resolvedRow?.resolved_by).toBe(managerA);
    expect(new Date(resolvedRow?.resolved_at).getTime()).toBeGreaterThanOrEqual(beforeResolve.getTime());
    expect(new Date(resolvedRow?.resolved_at).getTime()).toBeLessThan(new Date('2999-01-01').getTime());

    // There is no "unresolve": every UPDATE this grant allows is stamped resolved_at = now(), so
    // resolved_at can never be forced back to null.
    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ resolved_at: null, resolved_by: managerA }))
    ).resolves.toBe(1);
    const afterAttemptedUnresolve = await getOwner().knex('client_threads').where({ id: threadId }).first('resolved_at');
    expect(afterAttemptedUnresolve?.resolved_at).not.toBeNull();

    await getOwner().knex('client_threads').where({ id: threadId }).delete();
  });

  it('refuses to resolve a thread whose persona has been archived', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Will be archived before resolve' });
    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, persona_id: personaId, opened_by: adminA, opened_side: 'agency' });
    await getOwner().knex('client_personas').where({ id: personaId }).update({ status: 'archived' });

    await expect(
      asUser(managerA, (transaction) => transaction('client_threads').where({ id: threadId }).update({ resolved_at: new Date(), resolved_by: managerA }))
    ).resolves.toBe(0);

    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('refuses a new thread opened on an already-archived persona, from either side', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Already archived', status: 'archived' });

    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_threads').insert({ id: randomUUID(), client_id: clientA1, persona_id: personaId, opened_by: managerA, opened_side: 'agency' })
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_threads').insert({ id: randomUUID(), client_id: clientA1, persona_id: personaId, opened_by: portalA1, opened_side: 'client' })
      )
    ).rejects.toThrow(/row-level security/);

    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('hides the portal from a thread and its comments once their persona is archived', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Persona for read visibility' });
    const threadId = randomUUID();
    const commentId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, persona_id: personaId, opened_by: portalA1, opened_side: 'client' });
    await getOwner().knex('client_thread_comments').insert({ id: commentId, thread_id: threadId, client_id: clientA1, author_user_id: portalA1, author_side: 'client', body: 'Before archiving' });

    await expect(asUser(portalA1, (transaction) => transaction('client_threads').where({ id: threadId }).select('id'))).resolves.toEqual([{ id: threadId }]);
    await expect(asUser(portalA1, (transaction) => transaction('client_thread_comments').where({ id: commentId }).select('id'))).resolves.toEqual([{ id: commentId }]);

    await getOwner().knex('client_personas').where({ id: personaId }).update({ status: 'archived' });

    await expect(asUser(portalA1, (transaction) => transaction('client_threads').where({ id: threadId }).select('id'))).resolves.toEqual([]);
    await expect(asUser(portalA1, (transaction) => transaction('client_thread_comments').where({ id: commentId }).select('id'))).resolves.toEqual([]);
    // The agency side keeps the full history regardless of persona status.
    await expect(asUser(adminA, (transaction) => transaction('client_threads').where({ id: threadId }).select('id'))).resolves.toEqual([{ id: threadId }]);
    await expect(asUser(adminA, (transaction) => transaction('client_thread_comments').where({ id: commentId }).select('id'))).resolves.toEqual([{ id: commentId }]);

    await getOwner().knex('client_thread_comments').where({ id: commentId }).delete();
    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('rejects a thread persona from another client (A0010) and a comment client mismatched with its thread (A0011)', async () => {
    const foreignPersonaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: foreignPersonaId, client_id: clientA2, name: 'Belongs to A2' });

    await expect(
      getOwner()
        .knex('client_threads')
        .insert({ id: randomUUID(), client_id: clientA1, persona_id: foreignPersonaId, opened_by: adminA, opened_side: 'agency' })
    ).rejects.toMatchObject({ code: 'A0010' });

    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency' });
    await expect(
      getOwner()
        .knex('client_thread_comments')
        .insert({ id: randomUUID(), thread_id: threadId, client_id: clientA2, author_user_id: adminA, author_side: 'agency', body: 'Mismatched client' })
    ).rejects.toMatchObject({ code: 'A0011' });

    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: foreignPersonaId }).delete();
  });

  it('never grants UPDATE or DELETE on client_thread_comments to ageniza_app', async () => {
    const threadId = randomUUID();
    const commentId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, section_key: 'observations', opened_by: adminA, opened_side: 'agency' });
    await getOwner().knex('client_thread_comments').insert({ id: commentId, thread_id: threadId, client_id: clientA1, author_user_id: adminA, author_side: 'agency', body: 'Immutable' });

    await expect(
      asUser(adminA, (transaction) => transaction('client_thread_comments').where({ id: commentId }).update({ body: 'Edited' }))
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(adminA, (transaction) => transaction('client_thread_comments').where({ id: commentId }).delete())
    ).rejects.toThrow(/permission denied/);

    await getOwner().knex('client_thread_comments').where({ id: commentId }).delete();
    await getOwner().knex('client_threads').where({ id: threadId }).delete();
  });

  it('rejects a thread with both a section and a persona, or with neither', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Subject check persona' });

    await expect(
      getOwner()
        .knex('client_threads')
        .insert({ id: randomUUID(), client_id: clientA1, section_key: 'branding', persona_id: personaId, opened_by: adminA, opened_side: 'agency' })
    ).rejects.toThrow(/violates check constraint/);

    await expect(
      getOwner()
        .knex('client_threads')
        .insert({ id: randomUUID(), client_id: clientA1, opened_by: adminA, opened_side: 'agency' })
    ).rejects.toThrow(/violates check constraint/);

    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('rejects a comment on a thread whose persona was archived, from both sides', async () => {
    const personaId = randomUUID();
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientA1, name: 'Will be archived' });
    const threadId = randomUUID();
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientA1, persona_id: personaId, opened_by: portalA1, opened_side: 'client' });
    await getOwner().knex('client_personas').where({ id: personaId }).update({ status: 'archived' });

    await expect(
      asUser(managerA, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: threadId, client_id: clientA1, author_user_id: managerA, author_side: 'agency', body: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(portalA1, (transaction) =>
        transaction('client_thread_comments').insert({ id: randomUUID(), thread_id: threadId, client_id: clientA1, author_user_id: portalA1, author_side: 'client', body: 'Denied' })
      )
    ).rejects.toThrow(/row-level security/);

    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
  });

  it('isolates agency A entirely from agency B across every new table', async () => {
    const sectionId = { client_id: clientB, section_key: 'branding' as const };
    const personaId = randomUUID();
    const threadId = randomUUID();
    const commentId = randomUUID();
    await getOwner().knex('client_brand_sections').insert({ ...sectionId, body: 'Agency B secret' });
    await getOwner().knex('client_personas').insert({ id: personaId, client_id: clientB, name: 'Agency B persona' });
    await getOwner().knex('client_threads').insert({ id: threadId, client_id: clientB, section_key: 'observations', opened_by: adminB, opened_side: 'agency' });
    await getOwner().knex('client_thread_comments').insert({ id: commentId, thread_id: threadId, client_id: clientB, author_user_id: adminB, author_side: 'agency', body: 'Agency B only' });

    await expect(asUser(adminA, (transaction) => transaction('clients').where({ id: clientB }).select('id'))).resolves.toEqual([]);
    await expect(asUser(adminA, (transaction) => transaction('client_brand_sections').where(sectionId).select('client_id'))).resolves.toEqual([]);
    await expect(asUser(productionA, (transaction) => transaction('client_personas').where({ client_id: clientB }).select('id'))).resolves.toEqual([]);
    await expect(asUser(productionA, (transaction) => transaction('client_threads').where({ client_id: clientB }).select('id'))).resolves.toEqual([]);
    await expect(asUser(productionA, (transaction) => transaction('client_thread_comments').where({ client_id: clientB }).select('id'))).resolves.toEqual([]);

    await getOwner().knex('client_thread_comments').where({ id: commentId }).delete();
    await getOwner().knex('client_threads').where({ id: threadId }).delete();
    await getOwner().knex('client_personas').where({ id: personaId }).delete();
    await getOwner().knex('client_brand_sections').where(sectionId).delete();
  });
});
