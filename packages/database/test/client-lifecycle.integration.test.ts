import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #123. This suite proves the acceptance of
// "Funções security definer de arquivar, reativar, encerrar e acesso ao portal" against the real
// schema, always connected as `ageniza_app` and with the user context published by the existing
// helpers. Every assertion checks the final state (row counts, columns), never just "it did not
// throw": `security definer` bypasses RLS, so a silently filtered response would be a failure here.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();

const ownerA = randomUUID();
const adminA = randomUUID();
const managerA = randomUUID();
const singleA = randomUUID();
const dualA = randomUUID();
const inviterA = randomUUID();
const adminB = randomUUID();
const portalA1 = randomUUID();
const portalA2 = randomUUID();
const removedPortal = randomUUID();
const portalArchived = randomUUID();
const portalB = randomUUID();

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientA3 = randomUUID();
const clientA4 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();
const dueYesterday = randomUUID();
const dueToday = randomUUID();
const dueTomorrow = randomUUID();
const dueNoDate = randomUUID();

const conflictName = `Conflict ${randomUUID()}`;

const memA1 = randomUUID();
const memA2 = randomUUID();
const memRemoved = randomUUID();
const memArchived = randomUUID();
const memB = randomUUID();

const invA1 = randomUUID();
const invA2 = randomUUID();
const invA1Used = randomUUID();
const invDue = randomUUID();

const allUsers = [ownerA, adminA, managerA, singleA, dualA, inviterA, adminB, portalA1, portalA2, removedPortal, portalArchived, portalB];
const allAgencies = [agencyA, agencyB];
const allClients = [
  clientA1, clientA2, clientA3, clientA4, clientArchived, clientB,
  dueYesterday, dueToday, dueTomorrow, dueNoDate
];
const allInvitations = [invA1, invA2, invA1Used, invDue];

let roleIds: Record<'admin' | 'account_manager' | 'production', string>;
let singleRoleId: string;
let inviterRoleId: string;

type Rows<T> = { readonly rows: readonly T[] };

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

const archiveClient = (userId: string, clientId: string): Promise<unknown> =>
  asUser(userId, (transaction) => raw(transaction, 'select app_private.archive_client(?)', [clientId]));

const reactivateClient = (userId: string, clientId: string): Promise<unknown> =>
  asUser(userId, (transaction) => raw(transaction, 'select app_private.reactivate_client(?)', [clientId]));

const setClosingDate = (userId: string, clientId: string, date: string | null): Promise<unknown> =>
  asUser(userId, (transaction) => raw(transaction, 'select app_private.set_client_closing_date(?, ?::date)', [clientId, date]));

const setMembershipStatus = (userId: string, membershipId: string, status: string): Promise<unknown> =>
  asUser(userId, (transaction) => raw(transaction, 'select app_private.set_client_membership_status(?, ?)', [membershipId, status]));

// No user context at all: the worker's shape (the job uses the same ageniza_app role as the API).
const archiveDueClients = async (): Promise<number> => {
  const result = await getApplication().transaction((transaction) =>
    raw<Rows<{ archived: number }>>(transaction, 'select app_private.archive_due_clients() as archived', [])
  );
  return result.rows[0]!.archived;
};

const clientState = async (clientId: string): Promise<{ status: string; archived_at: Date | null; closing_date: string | null; name: string }> => {
  const result = await getOwner().knex.raw<Rows<{ status: string; archived_at: Date | null; closing_date: string | null; name: string }>>(
    'select status, archived_at, closing_date::text as closing_date, name from public.clients where id = ?',
    [clientId]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Client ${clientId} not found.`);
  return row;
};

const membershipStatus = async (membershipId: string): Promise<string | undefined> => {
  const row = await getOwner().knex('client_memberships').where({ id: membershipId }).first<{ status: string }>('status');
  return row?.status;
};

const invitationState = async (invitationId: string): Promise<{ revoked_at: Date | null; used_at: Date | null } | undefined> =>
  getOwner().knex('invitations').where({ id: invitationId }).first<{ revoked_at: Date | null; used_at: Date | null }>('revoked_at', 'used_at');

const auditEvents = async (targetId: string): Promise<{ action: string; actor_user_id: string | null; request_id: string | null; target_type: string }[]> =>
  getOwner().knex('audit.events').where({ target_id: targetId }).orderBy('id').select('action', 'actor_user_id', 'request_id', 'target_type');

const isClientMember = async (userId: string, clientId: string): Promise<boolean> => {
  const result = await asUser(userId, (transaction) =>
    raw<Rows<{ member: boolean }>>(transaction, 'select app_private.is_client_member(?) as member', [clientId])
  );
  return result.rows[0]!.member;
};

const createClient = async (options: { agencyId?: string; name?: string; status?: string } = {}): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('clients').insert({
    id,
    agency_id: options.agencyId ?? agencyA,
    name: options.name ?? `Fresh Client ${id}`,
    status: options.status ?? 'active'
  });
  return id;
};

const deleteClient = (clientId: string): Promise<number> => getOwner().knex('clients').where({ id: clientId }).delete();

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const roles = await getOwner()
    .knex('roles')
    .whereNull('agency_id')
    .whereIn('key', ['admin', 'account_manager', 'production'])
    .select('id', 'key');
  const byKey = new Map(roles.map((role) => [role.key as string, role.id as string]));
  roleIds = { admin: byKey.get('admin')!, account_manager: byKey.get('account_manager')!, production: byKey.get('production')! };
  if (Object.values(roleIds).some((id) => id === undefined)) throw new Error('System role seeds are missing.');

  singleRoleId = randomUUID();
  inviterRoleId = randomUUID();

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(
      allUsers.map((id) => ({ id, name: `User ${id}`, email: `${id}@example.test`, emailVerified: true }))
    );

    await transaction('agencies').insert([
      { id: agencyA, name: `Agency A ${agencyA}`, owner_user_id: ownerA },
      { id: agencyB, name: `Agency B ${agencyB}` }
    ]);

    // A custom role holding exactly one permission, the BFLA probe docs/security-review.md asks for.
    await transaction('roles').insert({ id: singleRoleId, agency_id: agencyA, key: `only-operar-${singleRoleId}`, name: 'Só operar', is_system: false });
    await transaction('role_permissions').insert({ role_id: singleRoleId, permission_key: 'cliente.operar' });

    // Holds only the invite permission, so it can insert a portal invite but has no write on `clients`.
    await transaction('roles').insert({ id: inviterRoleId, agency_id: agencyA, key: `only-convidar-${inviterRoleId}`, name: 'Só convidar', is_system: false });
    await transaction('role_permissions').insert({ role_id: inviterRoleId, permission_key: 'cliente.convidar_usuario' });

    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: adminA, role_id: roleIds.admin },
      { agency_id: agencyA, user_id: managerA, role_id: roleIds.account_manager },
      { agency_id: agencyA, user_id: singleA, role_id: singleRoleId },
      { agency_id: agencyA, user_id: inviterA, role_id: inviterRoleId },
      { agency_id: agencyA, user_id: dualA, role_id: roleIds.admin },
      { agency_id: agencyB, user_id: dualA, role_id: roleIds.production },
      { agency_id: agencyB, user_id: adminB, role_id: roleIds.admin }
    ]);

    await transaction('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Client A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Client A2 ${clientA2}` },
      { id: clientA3, agency_id: agencyA, name: conflictName },
      { id: clientA4, agency_id: agencyA, name: conflictName, status: 'archived', archived_at: new Date() },
      { id: clientArchived, agency_id: agencyA, name: `Client Archived ${clientArchived}`, status: 'archived', archived_at: new Date() },
      { id: clientB, agency_id: agencyB, name: `Client B ${clientB}` }
    ]);

    await transaction('client_memberships').insert([
      { id: memA1, client_id: clientA1, user_id: portalA1 },
      { id: memA2, client_id: clientA1, user_id: portalA2 },
      { id: memRemoved, client_id: clientA1, user_id: removedPortal, status: 'removed' },
      { id: memArchived, client_id: clientArchived, user_id: portalArchived },
      { id: memB, client_id: clientB, user_id: portalB }
    ]);

    await transaction('invitations').insert([
      { id: invA1, agency_id: agencyA, purpose: 'client_invite', email: `a1-${invA1}@example.test`, client_id: clientA1, token_hash: `hash-${invA1}`, expires_at: new Date(Date.now() + 86_400_000) },
      { id: invA2, agency_id: agencyA, purpose: 'client_invite', email: `a2-${invA2}@example.test`, client_id: clientA2, token_hash: `hash-${invA2}`, expires_at: new Date(Date.now() + 86_400_000) },
      { id: invA1Used, agency_id: agencyA, purpose: 'client_invite', email: `a1-used-${invA1Used}@example.test`, client_id: clientA1, token_hash: `hash-${invA1Used}`, expires_at: new Date(Date.now() + 86_400_000), used_at: new Date() }
    ]);
  });

  // Due-date fixtures are computed by the database in the same timezone the function uses, so the
  // test does not depend on the runner's clock.
  await getOwner().knex.raw(`
    insert into public.clients (id, agency_id, name, closing_date) values
      (?, ?, ?, (now() at time zone 'America/Sao_Paulo')::date - 1),
      (?, ?, ?, (now() at time zone 'America/Sao_Paulo')::date),
      (?, ?, ?, (now() at time zone 'America/Sao_Paulo')::date + 1)
  `, [dueYesterday, agencyA, `Due yesterday ${dueYesterday}`, dueToday, agencyA, `Due today ${dueToday}`, dueTomorrow, agencyA, `Due tomorrow ${dueTomorrow}`]);
  await getOwner().knex('clients').insert({ id: dueNoDate, agency_id: agencyA, name: `Due no date ${dueNoDate}`, closing_date: null });
  await getOwner().knex('invitations').insert({
    id: invDue, agency_id: agencyA, purpose: 'client_invite', email: `due-${invDue}@example.test`,
    client_id: dueYesterday, token_hash: `hash-${invDue}`, expires_at: new Date(Date.now() + 86_400_000)
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('audit.events').whereIn('agency_id', allAgencies).delete();
      await transaction('invitations').whereIn('id', allInvitations).delete();
      await transaction('client_memberships').whereIn('client_id', allClients).delete();
      await transaction('agency_memberships').whereIn('agency_id', allAgencies).delete();
      await transaction('role_permissions').whereIn('role_id', [singleRoleId, inviterRoleId]).delete();
      await transaction('roles').whereIn('agency_id', allAgencies).delete();
      await transaction('clients').whereIn('id', allClients).delete();
      await transaction('agencies').whereIn('id', allAgencies).delete();
      await transaction('auth.user').whereIn('id', allUsers).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('CLIENT lifecycle functions (#123)', () => {
  it('hardens all five functions as security definer with a fixed search_path and no PUBLIC execute', async () => {
    const names = ['archive_client', 'archive_due_clients', 'reactivate_client', 'set_client_closing_date', 'set_client_membership_status'];
    const routines = await getOwner().knex.raw<Rows<{ proname: string; prosecdef: boolean; config: string }>>(`
      select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = any(?)
    `, [names]);

    expect(routines.rows).toHaveLength(5);
    for (const routine of routines.rows) {
      expect(routine.prosecdef).toBe(true);
      // `set search_path = ''` lands as `search_path=`, so the qualifier is the empty string.
      expect(routine.config).toContain('search_path=');
    }

    const publicGrants = await getOwner().knex.raw<Rows<{ routine_name: string }>>(`
      select routine_name from information_schema.routine_privileges
      where grantee = 'PUBLIC' and routine_schema = 'app_private' and routine_name = any(?)
    `, [names]);
    expect(publicGrants.rows).toEqual([]);

    const appGrants = await getOwner().knex.raw<Rows<{ routine_name: string }>>(`
      select distinct routine_name from information_schema.routine_privileges
      where grantee = 'ageniza_app' and routine_schema = 'app_private' and routine_name = any(?)
    `, [names]);
    expect(new Set(appGrants.rows.map((row) => row.routine_name))).toEqual(new Set(names));
  });

  it('keeps clients.status and client_memberships.status (and the lifecycle stamps) out of the ageniza_app UPDATE grant', async () => {
    const columns = [
      { table: 'clients', column: 'status' },
      { table: 'clients', column: 'archived_at' },
      { table: 'clients', column: 'closing_date' },
      { table: 'client_memberships', column: 'status' }
    ];
    for (const { table, column } of columns) {
      const rows = await getOwner().knex.raw<Rows<{ privilege_type: string }>>(`
        select privilege_type from information_schema.column_privileges
        where grantee = 'ageniza_app' and table_schema = 'public' and table_name = ?
          and column_name = ? and privilege_type = 'UPDATE'
      `, [table, column]);
      expect(rows.rows).toEqual([]);
    }
  });

  it('archives as admin: stamps the row, clears closing_date, revokes only its pending invites, keeps memberships, audits; reactivate restores access without restoring invites', async () => {
    await getOwner().knex('clients').where({ id: clientA1 }).update({ closing_date: '2026-12-31' });
    await archiveClient(adminA, clientA1);

    const archived = await clientState(clientA1);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).not.toBeNull();
    expect(archived.closing_date).toBeNull();

    const ownInvite = await invitationState(invA1);
    expect(ownInvite?.revoked_at).not.toBeNull();
    // Only that client's pending invitations: the sibling's and the already-used one are untouched.
    expect((await invitationState(invA2))?.revoked_at).toBeNull();
    expect((await invitationState(invA1Used))?.revoked_at).toBeNull();

    // Memberships are preserved, so the portal access is only gated by the client status.
    expect(await membershipStatus(memA1)).toBe('active');
    expect(await isClientMember(portalA1, clientA1)).toBe(false);

    const archiveAudit = await auditEvents(clientA1);
    expect(archiveAudit).toContainEqual(expect.objectContaining({ action: 'client.archived', actor_user_id: adminA, target_type: 'client' }));

    await reactivateClient(adminA, clientA1);
    const reactivated = await clientState(clientA1);
    expect(reactivated.status).toBe('active');
    expect(reactivated.archived_at).toBeNull();
    // No other write: the invite revoked by the archive stays revoked (SPEC rule 15).
    expect((await invitationState(invA1))?.revoked_at).not.toBeNull();
    expect(await membershipStatus(memA1)).toBe('active');
    // The vínculo alone restores portal access, with no extra write.
    expect(await isClientMember(portalA1, clientA1)).toBe(true);

    const reactivateAudit = await auditEvents(clientA1);
    expect(reactivateAudit).toContainEqual(expect.objectContaining({ action: 'client.reactivated', actor_user_id: adminA, target_type: 'client' }));
  });

  it('lets the Owner archive by ownership, and refuses the account_manager and a one-permission custom role without any effect', async () => {
    const ownerClient = await createClient({ agencyId: agencyA });
    await archiveClient(ownerA, ownerClient);
    expect((await clientState(ownerClient)).status).toBe('archived');
    await deleteClient(ownerClient);

    for (const actor of [managerA, singleA]) {
      const target = await createClient({ agencyId: agencyA, name: `Denied archive ${randomUUID()}` });
      await getOwner().knex('invitations').insert({
        agency_id: agencyA, purpose: 'client_invite', email: `denied-${target}@example.test`,
        client_id: target, token_hash: `denied-${target}`, expires_at: new Date(Date.now() + 86_400_000)
      });
      const invite = await getOwner().knex('invitations').where({ client_id: target }).first<{ id: string }>('id');

      await expect(archiveClient(actor, target)).rejects.toMatchObject({ code: 'A0020' });

      const state = await clientState(target);
      expect(state.status).toBe('active');
      expect(state.archived_at).toBeNull();
      expect((await invitationState(invite!.id))?.revoked_at).toBeNull();

      await getOwner().knex('invitations').where({ client_id: target }).delete();
      await deleteClient(target);
    }
  });

  it('answers "not found" (A0020) for a client of another agency, even for a user who belongs to both agencies', async () => {
    // dualA is admin in A and production in B: a vínculo alone must never suffice, the permission
    // has to hold in the client's own agency.
    await expect(archiveClient(dualA, clientB)).rejects.toMatchObject({ code: 'A0020' });
    await expect(reactivateClient(adminA, clientB)).rejects.toMatchObject({ code: 'A0020' });
    await expect(setClosingDate(adminA, clientB, null)).rejects.toMatchObject({ code: 'A0020' });
    await expect(setMembershipStatus(adminA, memB, 'removed')).rejects.toMatchObject({ code: 'A0020' });

    // The same dualA can act in agency A, where it does hold cliente.arquivar.
    const ownAgency = await createClient({ agencyId: agencyA });
    await archiveClient(dualA, ownAgency);
    expect((await clientState(ownAgency)).status).toBe('archived');
    await deleteClient(ownAgency);

    const b = await clientState(clientB);
    expect(b.status).toBe('active');
    expect(await membershipStatus(memB)).toBe('active');
  });

  it('is idempotent when archiving an already-archived client', async () => {
    const before = await auditEvents(clientArchived);
    await expect(archiveClient(adminA, clientArchived)).resolves.toBeDefined();
    const after = await auditEvents(clientArchived);
    expect(after).toHaveLength(before.length);
    expect((await clientState(clientArchived)).status).toBe('archived');
  });

  it('archive_due_clients archives only yesterday, for any caller and with no other effect', async () => {
    const archivedCount = await archiveDueClients();
    expect(archivedCount).toBe(1);

    const yesterday = await clientState(dueYesterday);
    expect(yesterday.status).toBe('archived');
    expect(yesterday.archived_at).not.toBeNull();
    expect(yesterday.closing_date).toBeNull();
    expect((await invitationState(invDue))?.revoked_at).not.toBeNull();

    expect((await clientState(dueToday)).status).toBe('active');
    expect((await clientState(dueToday)).closing_date).not.toBeNull();
    expect((await clientState(dueTomorrow)).status).toBe('active');
    expect((await clientState(dueTomorrow)).closing_date).not.toBeNull();
    expect((await clientState(dueNoDate)).status).toBe('active');

    const event = (await auditEvents(dueYesterday))[0];
    expect(event).toMatchObject({ action: 'client.archived', actor_user_id: null, request_id: 'job:clients.archive-due', target_type: 'client' });

    // A user holding no lifecycle permission calling the function has exactly the same effect.
    const secondDue = randomUUID();
    await getOwner().knex.raw(
      `insert into public.clients (id, agency_id, name, closing_date)
       values (?, ?, ?, (now() at time zone 'America/Sao_Paulo')::date - 1)`,
      [secondDue, agencyA, `Second due ${secondDue}`]
    );
    try {
      expect(await asUser(singleA, (transaction) =>
        raw<Rows<{ archived: number }>>(transaction, 'select app_private.archive_due_clients() as archived', [])
      )).toMatchObject({ rows: [{ archived: 1 }] });
      expect((await clientState(secondDue)).status).toBe('archived');
      // Nothing else became archived on the second pass.
      expect((await clientState(dueToday)).status).toBe('active');
      expect((await clientState(dueTomorrow)).status).toBe('active');
    } finally {
      await getOwner().knex('audit.events').where({ target_id: secondDue }).delete();
      await deleteClient(secondDue);
    }
  });

  it('reactivate_client refuses a name already in use among active clients (A0021) and changes nothing', async () => {
    await expect(reactivateClient(adminA, clientA4)).rejects.toMatchObject({ code: 'A0021' });

    const stillArchived = await clientState(clientA4);
    expect(stillArchived.status).toBe('archived');
    expect(stillArchived.name).toBe(conflictName);
    expect((await clientState(clientA3)).status).toBe('active');
  });

  it('refuses reactivation without permission and across agencies', async () => {
    await expect(reactivateClient(managerA, clientArchived)).rejects.toMatchObject({ code: 'A0020' });
    await expect(reactivateClient(singleA, clientArchived)).rejects.toMatchObject({ code: 'A0020' });
    await expect(reactivateClient(adminA, clientB)).rejects.toMatchObject({ code: 'A0020' });
    expect((await clientState(clientArchived)).status).toBe('archived');
  });

  it('set_client_closing_date schedules and clears as admin, rejects yesterday (A0022) and unauthorized callers', async () => {
    const client = await createClient({ agencyId: agencyA });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    try {
      await setClosingDate(adminA, client, today);
      expect((await clientState(client)).closing_date).toBe(today);
      expect(await auditEvents(client)).toContainEqual(expect.objectContaining({ action: 'client.closing_scheduled', actor_user_id: adminA }));

      await setClosingDate(adminA, client, null);
      expect((await clientState(client)).closing_date).toBeNull();
      expect(await auditEvents(client)).toContainEqual(expect.objectContaining({ action: 'client.closing_cleared', actor_user_id: adminA }));

      await expect(setClosingDate(adminA, client, yesterday)).rejects.toMatchObject({ code: 'A0022' });
      expect((await clientState(client)).closing_date).toBeNull();

      await expect(setClosingDate(managerA, client, today)).rejects.toMatchObject({ code: 'A0020' });
      await expect(setClosingDate(singleA, client, today)).rejects.toMatchObject({ code: 'A0020' });
      expect((await clientState(client)).closing_date).toBeNull();

      // An archived client is read-only.
      await expect(setClosingDate(adminA, clientArchived, today)).rejects.toMatchObject({ code: 'A0020' });
    } finally {
      await deleteClient(client);
    }
  });

  it('set_client_membership_status removes and reactivates as admin; refuses unauthorized, archived clients, invalid status; is idempotent', async () => {
    const client = await createClient({ agencyId: agencyA });
    const member = randomUUID();
    const membershipId = randomUUID();
    await getOwner().knex('auth.user').insert({ id: member, name: 'Fresh member', email: `fresh-${member}@example.test`, emailVerified: true });
    await getOwner().knex('client_memberships').insert({ id: membershipId, client_id: client, user_id: member });

    try {
      await setMembershipStatus(adminA, membershipId, 'removed');
      expect(await membershipStatus(membershipId)).toBe('removed');
      expect(await auditEvents(membershipId)).toContainEqual(expect.objectContaining({ action: 'client_member.removed', actor_user_id: adminA, target_type: 'client_membership' }));

      await setMembershipStatus(adminA, membershipId, 'removed');
      expect((await auditEvents(membershipId)).filter((event) => event.action === 'client_member.removed')).toHaveLength(1);

      await setMembershipStatus(adminA, membershipId, 'active');
      expect(await membershipStatus(membershipId)).toBe('active');
      expect(await auditEvents(membershipId)).toContainEqual(expect.objectContaining({ action: 'client_member.reactivated', actor_user_id: adminA }));

      await expect(setMembershipStatus(managerA, membershipId, 'removed')).rejects.toMatchObject({ code: 'A0020' });
      await expect(setMembershipStatus(singleA, membershipId, 'removed')).rejects.toMatchObject({ code: 'A0020' });
      await expect(setMembershipStatus(adminA, membershipId, 'paused')).rejects.toMatchObject({ code: 'A0023' });
      expect(await membershipStatus(membershipId)).toBe('active');

      // A membership of an archived client is not manageable: the client is read-only.
      await expect(setMembershipStatus(adminA, memArchived, 'removed')).rejects.toMatchObject({ code: 'A0020' });
      expect(await membershipStatus(memArchived)).toBe('active');

      await expect(setMembershipStatus(adminA, randomUUID(), 'removed')).rejects.toMatchObject({ code: 'A0020' });
    } finally {
      await getOwner().knex('client_memberships').where({ id: membershipId }).delete();
      await getOwner().knex('auth.user').where({ id: member }).delete();
      await deleteClient(client);
    }
  });

  it('never lets a removed portal member put their own status back to active through the existing policy', async () => {
    await expect(
      asUser(removedPortal, (transaction) => transaction('client_memberships').where({ id: memRemoved }).update({ status: 'active' }))
    ).rejects.toThrow(/permission denied/);
    expect(await membershipStatus(memRemoved)).toBe('removed');

    // And the legitimate onboarding update on their own row still passes.
    await expect(
      asUser(removedPortal, (transaction) => transaction('client_memberships').where({ id: memRemoved }).update({ onboarding_seen_at: new Date() }))
    ).resolves.toBe(1);
    await getOwner().knex('client_memberships').where({ id: memRemoved }).update({ onboarding_seen_at: null });
  });

  it('invitations_insert refuses a portal invite for an archived client, accepts an active one, and keeps the collaborator admin-grant rule', async () => {
    const archivedInvite = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('invitations').insert({
        id: archivedInvite, agency_id: agencyA, purpose: 'client_invite', client_id: clientArchived,
        email: `archived-invite-${archivedInvite}@example.test`, token_hash: `hash-${archivedInvite}`, expires_at: new Date(Date.now() + 86_400_000)
      }))
    ).rejects.toThrow(/row-level security/);
    expect(await getOwner().knex('invitations').where({ id: archivedInvite }).select('id')).toEqual([]);

    const activeInvite = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('invitations').insert({
        id: activeInvite, agency_id: agencyA, purpose: 'client_invite', client_id: clientA1,
        email: `active-invite-${activeInvite}@example.test`, token_hash: `hash-${activeInvite}`, expires_at: new Date(Date.now() + 86_400_000)
      }))
    ).resolves.toBeDefined();
    await getOwner().knex('invitations').where({ id: activeInvite }).delete();

    // The admin-grant gate is not lost in the replacement: a non-Owner admin cannot invite as admin...
    const adminInvite = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('invitations').insert({
        id: adminInvite, agency_id: agencyA, purpose: 'collaborator_invite', role_id: roleIds.admin,
        email: `admin-invite-${adminInvite}@example.test`, token_hash: `hash-${adminInvite}`, expires_at: new Date(Date.now() + 86_400_000)
      }))
    ).rejects.toThrow(/row-level security/);

    // ...but can invite with a non-admin role.
    const collabInvite = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('invitations').insert({
        id: collabInvite, agency_id: agencyA, purpose: 'collaborator_invite', role_id: roleIds.production,
        email: `collab-invite-${collabInvite}@example.test`, token_hash: `hash-${collabInvite}`, expires_at: new Date(Date.now() + 86_400_000)
      }))
    ).resolves.toBeDefined();
    await getOwner().knex('invitations').whereIn('id', [adminInvite, collabInvite]).delete();
  });

  it('cannot be redirected by a hijacked search_path', async () => {
    const schema = `hijack_${randomUUID().replace(/-/g, '')}`;
    const decoy = randomUUID();
    const realDue = randomUUID();
    await getOwner().knex.raw(`create schema ${schema}`);
    await getOwner().knex.raw(`
      create table ${schema}.clients (
        id uuid, agency_id uuid, name text, status text, closing_date date, archived_at timestamptz, updated_at timestamptz
      );
      create function ${schema}.archive_client(p_client_id uuid) returns void language sql
        as $fn$ insert into audit.events (action, target_type, target_id) values ('hijack.attempt', 'client', p_client_id) $fn$;
      grant usage on schema ${schema} to ageniza_app;
      grant execute on function ${schema}.archive_client(uuid) to ageniza_app;
    `);
    await getOwner().knex.raw(
      `insert into ${schema}.clients (id, agency_id, name, status, closing_date) values (?, ?, 'decoy', 'active', (now() at time zone 'America/Sao_Paulo')::date - 1)`,
      [decoy, agencyA]
    );
    await getOwner().knex.raw(
      `insert into public.clients (id, agency_id, name, closing_date) values (?, ?, ?, (now() at time zone 'America/Sao_Paulo')::date - 1)`,
      [realDue, agencyA, `Hijack real due ${realDue}`]
    );

    try {
      await asUser(adminA, async (transaction) => {
        await raw(transaction, "select set_config('search_path', ?, true)", [schema]);
        await raw(transaction, 'select app_private.archive_client(?)', [realDue]);
      });
      // The real client was archived, and the decoy table in the hijacked schema was never read.
      expect((await clientState(realDue)).status).toBe('archived');
      const decoyRow = await getOwner().knex.raw<Rows<{ status: string }>>(`select status from ${schema}.clients where id = ?`, [decoy]);
      expect(decoyRow.rows[0]!.status).toBe('active');
      expect(await getOwner().knex('audit.events').where({ action: 'hijack.attempt' }).select('id')).toEqual([]);
    } finally {
      await getOwner().knex('audit.events').where({ target_id: realDue }).delete();
      await getOwner().knex.raw(`drop schema ${schema} cascade`);
      await deleteClient(realDue);
    }
  });

  it('serializes a concurrent archive and reactivate of the same client', async () => {
    const client = await createClient({ agencyId: agencyA });

    let archiveReachedLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { archiveReachedLock = resolve; });
    let releaseArchive!: () => void;
    const archiveMayFinish = new Promise<void>((resolve) => { releaseArchive = resolve; });

    const archive = getApplication().transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
      await raw(transaction, 'select app_private.archive_client(?)', [client]);
      archiveReachedLock();
      await archiveMayFinish;
    });
    await lockAcquired;

    const reactivate = getApplication().transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
      await raw(transaction, 'select app_private.reactivate_client(?)', [client]);
    });

    releaseArchive();
    await Promise.all([archive, reactivate]);

    // The row lock forces one serial order: archive commits first, so reactivet sees 'archived'.
    const row = await clientState(client);
    expect(row.status).toBe('active');
    expect(row.archived_at).toBeNull();
    expect((await auditEvents(client)).map((event) => event.action)).toEqual(['client.archived', 'client.reactivated']);

    await getOwner().knex('audit.events').where({ target_id: client }).delete();
    await deleteClient(client);
  });

  it('refuses a portal invite whose client belongs to another agency, and writes no row', async () => {
    const inviteId = randomUUID();
    await expect(
      asUser(adminA, (transaction) => transaction('invitations').insert({
        id: inviteId, agency_id: agencyA, purpose: 'client_invite', client_id: clientB,
        email: `cross-agency-${inviteId}@example.test`, token_hash: `hash-${inviteId}`, expires_at: new Date(Date.now() + 86_400_000)
      }))
    ).rejects.toThrow(/row-level security/);
    expect(await getOwner().knex('invitations').where({ id: inviteId }).select('id')).toEqual([]);
  });

  it('checks permission before locking, so an unauthorized caller never waits on the row lock', async () => {
    const client = await createClient({ agencyId: agencyA });

    let reachedLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { reachedLock = resolve; });
    let releaseLock!: () => void;
    const lockMayFinish = new Promise<void>((resolve) => { releaseLock = resolve; });

    // A concurrent transaction holds the client row lock for the whole test.
    // The concurrent transaction needs a user context too: without a bound actor, RLS hides the row
    // and the FOR UPDATE would lock nothing.
    const locker = getApplication().transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
      await raw(transaction, 'select id from public.clients where id = ?::uuid for update', [client]);
      reachedLock();
      await lockMayFinish;
    });
    await lockAcquired;

    try {
      // adminB belongs to agency B only, so it has no permission on A's client. The function must
      // answer A0020 without ever touching the locked row; a 250ms lock_timeout makes a lock-first
      // implementation fail as 55P03 instead.
      await expect(getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminB]);
        await raw(transaction, "set local lock_timeout = '250ms'", []);
        await raw(transaction, 'select app_private.archive_client(?)', [client]);
      })).rejects.toMatchObject({ code: 'A0020' });
      expect((await clientState(client)).status).toBe('active');
    } finally {
      releaseLock();
      await locker;
      await deleteClient(client);
    }
  });

  it('translates the concurrent reactivation of two same-named clients into A0021, never a raw 23505', async () => {
    const name = `Corrida reativação ${randomUUID()}`;
    const firstClient = await createClient({ agencyId: agencyA, name, status: 'archived' });
    const secondClient = await createClient({ agencyId: agencyA, name, status: 'archived' });

    let firstUpdated!: () => void;
    const firstCommitted = new Promise<void>((resolve) => { firstUpdated = resolve; });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    // The first reactivation holds its uncommitted index entry while the second runs.
    const first = getApplication().transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
      await raw(transaction, 'select app_private.reactivate_client(?)', [firstClient]);
      firstUpdated();
      await firstMayFinish;
    });
    await firstCommitted;

    const second = getApplication().transaction(async (transaction) => {
      await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
      await raw(transaction, 'select app_private.reactivate_client(?)', [secondClient]);
    });

    // Let the second reach its UPDATE and block on the first's uncommitted unique-index entry.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseFirst();

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    expect((secondResult as PromiseRejectedResult).reason).toMatchObject({ code: 'A0021' });

    const states = await Promise.all([clientState(firstClient), clientState(secondClient)]);
    expect(states.filter((state) => state.status === 'active')).toHaveLength(1);

    await getOwner().knex('audit.events').whereIn('target_id', [firstClient, secondClient]).delete();
    await deleteClient(firstClient);
    await deleteClient(secondClient);
  });

  describe('portal invite racing the archive of its client', () => {
    // True once some backend of this database waits on a lock, so a test only moves on when the
    // second transaction is really blocked behind the first, not after a guessed delay.
    const waitForLockWait = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await getOwner().knex.raw<Rows<{ pid: number }>>(
          "select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"
        );
        if (waiting.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('No backend ever blocked on a lock.');
    };

    const pendingInvites = async (clientId: string): Promise<number> => {
      const rows = await getOwner().knex('invitations')
        .where({ client_id: clientId, purpose: 'client_invite' })
        .whereNull('used_at').whereNull('revoked_at')
        .count<{ count: string }[]>('id as count');
      return Number(rows[0]!.count);
    };

    const insertPortalInvite = (transaction: Knex.Transaction, clientId: string, inviteId: string) =>
      transaction('invitations').insert({
        id: inviteId, agency_id: agencyA, purpose: 'client_invite', client_id: clientId,
        email: `race-${inviteId}@example.test`, token_hash: `hash-${inviteId}`, expires_at: new Date(Date.now() + 86_400_000)
      });

    const cleanup = async (clientId: string): Promise<void> => {
      await getOwner().knex('audit.events').where({ target_id: clientId }).delete();
      await getOwner().knex('invitations').where({ client_id: clientId }).delete();
      await deleteClient(clientId);
    };

    it('refuses an invite whose insert was already past the policy when the archive committed, leaving no pending invite', async () => {
      const client = await createClient({ agencyId: agencyA });
      const inviteId = randomUUID();

      let archived!: () => void;
      const archiveDone = new Promise<void>((resolve) => { archived = resolve; });
      let commitArchive!: () => void;
      const archiveMayCommit = new Promise<void>((resolve) => { commitArchive = resolve; });

      // T1 archives and holds the transaction open: the row lock and the new status are uncommitted.
      const archive = getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
        await raw(transaction, 'select app_private.archive_client(?)', [client]);
        archived();
        await archiveMayCommit;
      });
      await archiveDone;

      // T2 still sees the client as active, so the policy lets the row in and the insert then waits
      // on the reference to the client that T1 holds locked.
      const invite = getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
        await insertPortalInvite(transaction, client, inviteId);
      });
      const inviteOutcome = invite.then(() => 'inserted' as const, (error: unknown) => error);

      try {
        await waitForLockWait();
        commitArchive();
        await archive;

        const outcome = await inviteOutcome;
        expect(outcome).toMatchObject({ code: 'A0020' });
        expect((await clientState(client)).status).toBe('archived');
        expect(await getOwner().knex('invitations').where({ id: inviteId }).select('id')).toEqual([]);
        expect(await pendingInvites(client)).toBe(0);
      } finally {
        commitArchive();
        await archive.catch(() => undefined);
        await inviteOutcome;
        await cleanup(client);
      }
    });

    it('revokes an invite that was inserted first and committed after the archive began, so none stays pending', async () => {
      const client = await createClient({ agencyId: agencyA });
      const inviteId = randomUUID();

      let inserted!: () => void;
      const insertDone = new Promise<void>((resolve) => { inserted = resolve; });
      let commitInvite!: () => void;
      const inviteMayCommit = new Promise<void>((resolve) => { commitInvite = resolve; });

      const invite = getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
        await insertPortalInvite(transaction, client, inviteId);
        inserted();
        await inviteMayCommit;
      });
      await insertDone;

      const archive = getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
        await raw(transaction, 'select app_private.archive_client(?)', [client]);
      });
      const archiveOutcome = archive.then(() => 'archived' as const, (error: unknown) => error);

      try {
        await waitForLockWait();
        commitInvite();
        await invite;

        expect(await archiveOutcome).toBe('archived');
        expect((await clientState(client)).status).toBe('archived');
        expect((await invitationState(inviteId))?.revoked_at).not.toBeNull();
        expect(await pendingInvites(client)).toBe(0);
      } finally {
        commitInvite();
        await invite.catch(() => undefined);
        await archiveOutcome;
        await cleanup(client);
      }
    });

    it('lets a role holding only cliente.convidar_usuario invite an active client, which a lock taken as the caller would break', async () => {
      const client = await createClient({ agencyId: agencyA });
      const inviteId = randomUUID();

      try {
        await asUser(inviterA, (transaction) => insertPortalInvite(transaction, client, inviteId));
        expect(await getOwner().knex('invitations').where({ id: inviteId }).select('id')).toHaveLength(1);
        expect(await pendingInvites(client)).toBe(1);
      } finally {
        await cleanup(client);
      }
    });

    it('still checks authorization before it waits: an unauthorized insert fails on the policy even while the client row is locked', async () => {
      const client = await createClient({ agencyId: agencyA });

      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void;
      const lockMayEnd = new Promise<void>((resolve) => { release = resolve; });

      const locker = getApplication().transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [adminA]);
        await raw(transaction, 'select id from public.clients where id = ?::uuid for update', [client]);
        locked();
        await lockMayEnd;
      });
      await lockHeld;

      try {
        for (const actor of [managerA, singleA]) {
          const inviteId = randomUUID();
          // Neither holds cliente.convidar_usuario or convite.reenviar: the policy must refuse before
          // the insert reaches the locked reference, or lock_timeout would surface as 55P03.
          await expect(getApplication().transaction(async (transaction) => {
            await raw(transaction, 'select app_private.bind_actor(?::uuid)', [actor]);
            await raw(transaction, "set local lock_timeout = '250ms'", []);
            await insertPortalInvite(transaction, client, inviteId);
          })).rejects.toThrow(/row-level security/);
          expect(await getOwner().knex('invitations').where({ id: inviteId }).select('id')).toEqual([]);
        }
      } finally {
        release();
        await locker;
        await cleanup(client);
      }
    });
  });
});
