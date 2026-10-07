import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// This suite is intentionally database-only. API acceptance tests can exercise the same functions
// through the HTTP routes, while these tests prove the RLS boundary when connected as ageniza_app.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const userA = randomUUID();
const userB = randomUUID();
const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const invitationA = randomUUID();
const invitationB = randomUUID();
const activationAgency = randomUUID();
const activationInvitation = randomUUID();
const activationUser = randomUUID();
const collaboratorUser = randomUUID();
const collaboratorInvitation = randomUUID();
const clientInvitation = randomUUID();

let adminRoleId: string;
let productionRoleId: string;
let rollbackInvitationId: string | undefined;

interface InvitationLookup {
  readonly id: string;
  readonly purpose: string;
  readonly email: string;
  readonly agency_id: string;
  readonly agency_name: string;
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly role_id: string | null;
  readonly valid: boolean;
}

interface AcceptanceResult {
  readonly status: string;
  readonly agency_id: string;
  readonly client_id: string | null;
}

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

const lookupInvitation = async (tokenHash: string): Promise<InvitationLookup[]> => {
  const result = await getApplication().transaction((transaction) =>
    raw<{ rows: InvitationLookup[] }>(
      transaction,
      'select * from app_private.invitation_by_token_hash(?)',
      [tokenHash]
    )
  );
  return result.rows;
};

const acceptInvitation = async (
  tokenHash: string,
  userId: string,
  termsVersion = '2026-09-19',
  privacyVersion = '2026-09-19',
  recordAcceptance = true
): Promise<AcceptanceResult> => {
  const result = await asUser(userId, (transaction) =>
    raw<{ rows: AcceptanceResult[] }>(
      transaction,
      'select * from app_private.accept_invitation(?, ?, ?, ?, ?)',
      [tokenHash, userId, termsVersion, privacyVersion, recordAcceptance]
    )
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Acceptance function returned no row.');
  return row;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const database = getOwner();
  await database.transaction(async (transaction) => {
    await transaction('auth.user').insert([
      { id: userA, name: 'Agency A User', email: `tenant-a-${userA}@example.test`, emailVerified: true },
      { id: userB, name: 'Agency B User', email: `tenant-b-${userB}@example.test`, emailVerified: true },
      { id: activationUser, name: 'Activation User', email: `activation-${activationUser}@example.test`, emailVerified: true },
      { id: collaboratorUser, name: 'Collaborator User', email: `collaborator-${collaboratorUser}@example.test`, emailVerified: true }
    ]);

    const roles = await transaction('roles').whereNull('agency_id').whereIn('key', ['admin', 'production']).select('id', 'key');
    adminRoleId = roles.find((role) => role.key === 'admin')?.id;
    productionRoleId = roles.find((role) => role.key === 'production')?.id;
    if (adminRoleId === undefined || productionRoleId === undefined) throw new Error('System role seeds are missing.');

    await transaction('agencies').insert([
      { id: agencyA, name: 'Agency A', owner_user_id: userA },
      { id: agencyB, name: 'Agency B', owner_user_id: userB },
      { id: activationAgency, name: 'Agency Activation', owner_user_id: null }
    ]);
    await transaction('clients').insert([
      { id: clientA, agency_id: agencyA, name: 'Client A' },
      { id: clientB, agency_id: agencyB, name: 'Client B' }
    ]);
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: userA, role_id: adminRoleId },
      { agency_id: agencyB, user_id: userB, role_id: adminRoleId }
    ]);
    await transaction('client_memberships').insert([
      { client_id: clientA, user_id: userA },
      { client_id: clientB, user_id: userB }
    ]);
    await transaction('invitations').insert([
      {
        id: invitationA,
        agency_id: agencyA,
        purpose: 'collaborator_invite',
        email: `invited-a-${invitationA}@example.test`,
        role_id: productionRoleId,
        token_hash: `hash-${invitationA}`,
        expires_at: new Date(Date.now() + 86_400_000)
      },
      {
        id: invitationB,
        agency_id: agencyB,
        purpose: 'collaborator_invite',
        email: `invited-b-${invitationB}@example.test`,
        role_id: productionRoleId,
        token_hash: `hash-${invitationB}`,
        expires_at: new Date(Date.now() + 86_400_000)
      },
      {
        id: activationInvitation,
        agency_id: activationAgency,
        purpose: 'agency_activation',
        email: `activation-${activationUser}@example.test`,
        token_hash: `hash-${activationInvitation}`,
        expires_at: new Date(Date.now() + 86_400_000)
      },
      {
        id: collaboratorInvitation,
        agency_id: agencyA,
        purpose: 'collaborator_invite',
        email: `collaborator-${collaboratorUser}@example.test`,
        role_id: productionRoleId,
        token_hash: `hash-${collaboratorInvitation}`,
        expires_at: new Date(Date.now() + 86_400_000)
      },
      {
        id: clientInvitation,
        agency_id: agencyA,
        purpose: 'client_invite',
        email: `collaborator-${collaboratorUser}@example.test`,
        client_id: clientA,
        token_hash: `hash-${clientInvitation}`,
        expires_at: new Date(Date.now() + 86_400_000)
      }
    ]);
    await transaction('legal_acceptances').insert([
      { user_id: userA, document: 'terms', version: '2026-09-19' },
      { user_id: userA, document: 'privacy', version: '2026-09-19' },
      { user_id: userB, document: 'terms', version: '2026-09-19' },
      { user_id: userB, document: 'privacy', version: '2026-09-19' }
    ]);
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('audit.events').whereIn('agency_id', [agencyA, agencyB, activationAgency]).delete();
      await transaction('legal_acceptances').whereIn('user_id', [userA, userB, activationUser, collaboratorUser]).delete();
      await transaction('invitations').whereIn('id', [invitationA, invitationB, activationInvitation, collaboratorInvitation, clientInvitation]).delete();
      if (rollbackInvitationId !== undefined) await transaction('invitations').where({ id: rollbackInvitationId }).delete();
      await transaction('client_memberships').whereIn('client_id', [clientA, clientB]).delete();
      await transaction('agency_memberships').whereIn('agency_id', [agencyA, agencyB, activationAgency]).delete();
      await transaction('clients').whereIn('id', [clientA, clientB]).delete();
      await transaction('agencies').whereIn('id', [agencyA, agencyB, activationAgency]).update({ owner_user_id: null });
      await transaction('agencies').whereIn('id', [agencyA, agencyB, activationAgency]).delete();
      await transaction('auth.user').whereIn('id', [userA, userB, activationUser, collaboratorUser]).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

// PR #159 (issue #94): the value-dependent half of the agency_memberships UPDATE rule now lives in
// a BEFORE UPDATE trigger (app_private.check_agency_membership_update), not in WITH CHECK, so a
// denial there raises this custom message instead of Postgres's own "row-level security" wording.
const membershipRuleDenied = /colaborador\.\w+ is required|Owner's role and status cannot be changed|role_id must be a system role/;

describe('AUTH-20B database RLS and invitation functions', () => {
  it('hides every tenant table without app.user_id', async () => {
    const rows = await getApplication().transaction(async (transaction) => ({
      agencies: await transaction('agencies').select('id'),
      clients: await transaction('clients').select('id'),
      agencyMemberships: await transaction('agency_memberships').select('id'),
      clientMemberships: await transaction('client_memberships').select('id'),
      invitations: await transaction('invitations').select('id'),
      legalAcceptances: await transaction('legal_acceptances').select('id')
    }));

    expect(rows).toEqual({
      agencies: [],
      clients: [],
      agencyMemberships: [],
      clientMemberships: [],
      invitations: [],
      legalAcceptances: []
    });
  });

  it('isolates agency A from agency B across the new tables', async () => {
    await expect(asUser(userA, (transaction) => transaction('agencies').select('id'))).resolves.toEqual([{ id: agencyA }]);
    await expect(asUser(userA, (transaction) => transaction('clients').select('id'))).resolves.toEqual([{ id: clientA }]);
    await expect(asUser(userA, (transaction) => transaction('agency_memberships').select('agency_id'))).resolves.toEqual([{ agency_id: agencyA }]);
    await expect(asUser(userA, (transaction) => transaction('client_memberships').select('client_id'))).resolves.toEqual([{ client_id: clientA }]);
    await expect(asUser(userA, (transaction) => transaction('invitations').select('id'))).resolves.toEqual(
      expect.arrayContaining([{ id: invitationA }, { id: collaboratorInvitation }, { id: clientInvitation }])
    );
    await expect(asUser(userA, (transaction) => transaction('invitations').where({ id: invitationB }).select('id'))).resolves.toEqual([]);
    await expect(asUser(userA, (transaction) => transaction('legal_acceptances').select('user_id'))).resolves.toEqual([{ user_id: userA }, { user_id: userA }]);
    // Permissions and system roles are global authorization metadata. They are intentionally
    // readable by every authenticated user, while all tenant-bearing rows remain RLS-scoped.
    // These counts include both migration sets: the collaborator permissions and admin grant
    // (#94 review) plus the CLIENTS module catalog (#122): cliente.visualizar, cliente.operar,
    // cliente.cadastrar, cliente.arquivar and cliente.remover_usuario, with their preset grants.
    await expect(asUser(userA, (transaction) => transaction('permissions').select('key'))).resolves.toHaveLength(15);
    await expect(asUser(userA, (transaction) => transaction('roles').whereNull('agency_id').select('key'))).resolves.toHaveLength(5);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').select('permission_key'))).resolves.toHaveLength(25);

    await expect(asUser(userA, (transaction) => transaction('agencies').insert({ id: randomUUID(), name: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('clients').insert({ id: randomUUID(), agency_id: agencyB, name: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('agency_memberships').insert({ id: randomUUID(), agency_id: agencyB, user_id: userA, role_id: adminRoleId }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('client_memberships').insert({ id: randomUUID(), client_id: clientB, user_id: userA }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('invitations').insert({
      id: randomUUID(), agency_id: agencyB, purpose: 'collaborator_invite', email: `denied-${randomUUID()}@example.test`, role_id: productionRoleId,
      token_hash: `denied-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000)
    }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('legal_acceptances').insert({ id: randomUUID(), user_id: userA, document: 'terms', version: `denied-${randomUUID()}` }))).rejects.toThrow(/permission denied for table legal_acceptances/);
    await expect(asUser(userA, (transaction) => transaction('permissions').insert({ key: `denied.${randomUUID()}`, description: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('roles').insert({ id: randomUUID(), agency_id: agencyB, key: `denied-${randomUUID()}`, name: 'Denied', is_system: false }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').insert({ role_id: randomUUID(), permission_key: 'colaborador.convidar' }))).rejects.toThrow(/row-level security/);

    // Issue #296 revokes UPDATE and DELETE on the tables without an UPDATE policy, and DELETE on client_memberships: the privilege layer answers before the RLS.
    await expect(asUser(userA, (transaction) => transaction('agencies').where({ id: agencyB }).update({ name: 'Should not change' }))).rejects.toThrow(/permission denied for table agencies/);
    // CLIENTS module (#122) revokes DELETE on clients outright: no route deletes a business entity.
    await expect(asUser(userA, (transaction) => transaction('clients').where({ id: clientB }).delete())).rejects.toThrow(/permission denied/);
    // Issue #356 revokes DELETE on agency_memberships and invitations: the privilege layer answers before the RLS.
    await expect(asUser(userA, (transaction) => transaction('agency_memberships').where({ agency_id: agencyB }).delete())).rejects.toThrow(/permission denied for table agency_memberships/);
    await expect(asUser(userA, (transaction) => transaction('client_memberships').where({ client_id: clientB }).delete())).rejects.toThrow(/permission denied for table client_memberships/);
    await expect(asUser(userA, (transaction) => transaction('invitations').where({ id: invitationB }).delete())).rejects.toThrow(/permission denied for table invitations/);
    // Issue #343 revokes INSERT, UPDATE and DELETE on legal_acceptances: the privilege layer answers before the RLS.
    await expect(asUser(userA, (transaction) => transaction('legal_acceptances').where({ user_id: userB }).delete())).rejects.toThrow(/permission denied for table legal_acceptances/);
    await expect(asUser(userA, (transaction) => transaction('permissions').where({ key: 'colaborador.convidar' }).update({ description: 'Should not change' }))).rejects.toThrow(/permission denied for table permissions/);
    await expect(asUser(userA, (transaction) => transaction('roles').where({ key: 'admin' }).whereNull('agency_id').update({ name: 'Should not change' }))).rejects.toThrow(/permission denied for table roles/);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').where({ role_id: adminRoleId }).delete())).rejects.toThrow(/permission denied for table role_permissions/);
  });

  it('lets a client member touch only their onboarding column, never their status or tenant', async () => {
    // The onboarding write (AUTH-20C) is the one update a member may perform on their own row.
    await expect(asUser(userA, (transaction) => transaction('client_memberships')
      .where({ client_id: clientA, user_id: userA }).update({ onboarding_seen_at: new Date() }))).resolves.toBe(1);

    // Everything else on that same row is denied by the column grant: without it, a removed member
    // could reactivate themselves, or move the membership to another tenant's client.
    await expect(asUser(userA, (transaction) => transaction('client_memberships')
      .where({ client_id: clientA, user_id: userA }).update({ status: 'removed' }))).rejects.toThrow(/permission denied/);
    await expect(asUser(userA, (transaction) => transaction('client_memberships')
      .where({ client_id: clientA, user_id: userA }).update({ client_id: clientB }))).rejects.toThrow(/permission denied/);
    await expect(asUser(userA, (transaction) => transaction('client_memberships')
      .where({ client_id: clientA, user_id: userA }).update({ user_id: userB }))).rejects.toThrow(/permission denied/);
    // Another member's row stays untouchable even on the allowed column.
    await expect(asUser(userA, (transaction) => transaction('client_memberships')
      .where({ client_id: clientB }).update({ onboarding_seen_at: new Date() }))).resolves.toBe(0);

    await getOwner().knex('client_memberships').where({ client_id: clientA, user_id: userA }).update({ onboarding_seen_at: null });
  });

  it('lets a role holding only convite.cancelar see and revoke an invitation', async () => {
    // Issue #39: the route requires convite.cancelar, so the policy must recognise it. Before this
    // the UPDATE was keyed on colaborador.convidar alone and such a role saw no rows.
    const cancelUser = randomUUID();
    const cancelRole = randomUUID();
    await getOwner().knex('auth.user').insert({ id: cancelUser, name: 'Cancel Only', email: `cancel-${cancelUser}@example.test`, emailVerified: true });
    await getOwner().knex('roles').insert({ id: cancelRole, agency_id: agencyA, key: `cancel-only-${cancelRole}`, name: 'Cancel Only', is_system: false });
    await getOwner().knex('role_permissions').insert({ role_id: cancelRole, permission_key: 'convite.cancelar' });
    await getOwner().knex('agency_memberships').insert({ agency_id: agencyA, user_id: cancelUser, role_id: cancelRole });

    try {
      await expect(asUser(cancelUser, (transaction) => transaction('invitations').where({ id: invitationA }).select('id'))).resolves.toEqual([{ id: invitationA }]);
      await expect(asUser(cancelUser, (transaction) => transaction('invitations').where({ id: invitationA }).update({ revoked_at: new Date() }))).resolves.toBe(1);
      // Another agency stays invisible: the new permission widens which roles act, never which tenant.
      await expect(asUser(cancelUser, (transaction) => transaction('invitations').where({ id: invitationB }).select('id'))).resolves.toEqual([]);
      // The column grant confines that role to revocation; it cannot rewrite the invitation.
      await expect(asUser(cancelUser, (transaction) => transaction('invitations').where({ id: invitationA }).update({ role_id: adminRoleId }))).rejects.toThrow(/permission denied/);
      await expect(asUser(cancelUser, (transaction) => transaction('invitations').where({ id: invitationA }).update({ purpose: 'client_invite' }))).rejects.toThrow(/permission denied/);
    } finally {
      // Without this the shared invitationA stays revoked and the custom role blocks the teardown's
      // delete on agencies, taking the whole fixture down with it.
      await getOwner().knex('invitations').where({ id: invitationA }).update({ revoked_at: null });
      await getOwner().knex('agency_memberships').where({ user_id: cancelUser }).delete();
      await getOwner().knex('role_permissions').where({ role_id: cancelRole }).delete();
      await getOwner().knex('roles').where({ id: cancelRole }).delete();
      await getOwner().knex('auth.user').where({ id: cancelUser }).delete();
    }
  });

  it('returns only the public invitation projection and marks inactive links invalid', async () => {
    await expect(lookupInvitation(`hash-${invitationA}`)).resolves.toEqual([
      expect.objectContaining({
        id: invitationA,
        purpose: 'collaborator_invite',
        agency_id: agencyA,
        agency_name: 'Agency A',
        client_id: null,
        client_name: null,
        role_id: productionRoleId,
        valid: true
      })
    ]);
    await expect(lookupInvitation(`missing-${randomUUID()}`)).resolves.toEqual([]);

    await getOwner().knex('invitations').where({ id: invitationA }).update({ expires_at: new Date(Date.now() - 1_000) });
    await expect(lookupInvitation(`hash-${invitationA}`)).resolves.toEqual([
      expect.objectContaining({ id: invitationA, valid: false })
    ]);
    await getOwner().knex('invitations').where({ id: invitationA }).update({ expires_at: new Date(Date.now() + 86_400_000) });
  });

  it('accepts an activation atomically, creates owner/admin/legal rows, and audits it', async () => {
    await expect(acceptInvitation(`hash-${activationInvitation}`, activationUser)).resolves.toEqual({
      status: 'accepted',
      agency_id: activationAgency,
      client_id: null
    });

    await expect(getOwner().knex('agencies').where({ id: activationAgency }).first('owner_user_id', 'status')).resolves.toEqual({
      owner_user_id: activationUser,
      status: 'active'
    });
    await expect(getOwner().knex('agency_memberships').where({ agency_id: activationAgency, user_id: activationUser }).first('role_id', 'status')).resolves.toEqual({
      role_id: adminRoleId,
      status: 'active'
    });
    await expect(getOwner().knex('legal_acceptances').where({ user_id: activationUser }).orderBy('document').select('document', 'version')).resolves.toEqual([
      { document: 'privacy', version: '2026-09-19' },
      { document: 'terms', version: '2026-09-19' }
    ]);
    await expect(getOwner().knex('invitations').where({ id: activationInvitation }).first('used_at', 'accepted_by_user_id')).resolves.toEqual({
      used_at: expect.any(Date),
      accepted_by_user_id: activationUser
    });
    await expect(getOwner().knex('audit.events').where({ agency_id: activationAgency }).orderBy('action').select('action', 'actor_user_id', 'target_id')).resolves.toEqual([
      { action: 'agency.activated', actor_user_id: activationUser, target_id: activationAgency },
      { action: 'invitation.accepted', actor_user_id: activationUser, target_id: activationInvitation }
    ]);
  });

  it('accepts collaborator and client invitations, is idempotent for existing members, and rejects mismatches', async () => {
    await expect(acceptInvitation(`hash-${collaboratorInvitation}`, collaboratorUser)).resolves.toEqual({
      status: 'accepted',
      agency_id: agencyA,
      client_id: null
    });
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: collaboratorUser }).first('role_id', 'status')).resolves.toEqual({
      role_id: productionRoleId,
      status: 'active'
    });

    await expect(acceptInvitation(`hash-${clientInvitation}`, collaboratorUser)).resolves.toEqual({
      status: 'accepted',
      agency_id: agencyA,
      client_id: clientA
    });
    await expect(getOwner().knex('client_memberships').where({ client_id: clientA, user_id: collaboratorUser }).first('status')).resolves.toEqual({ status: 'active' });

    const alreadyInvitation = randomUUID();
    const alreadyHash = `hash-${alreadyInvitation}`;
    await getOwner().knex('invitations').insert({
      id: alreadyInvitation,
      agency_id: agencyA,
      purpose: 'collaborator_invite',
      email: `tenant-a-${userA}@example.test`,
      role_id: productionRoleId,
      token_hash: alreadyHash,
      expires_at: new Date(Date.now() + 86_400_000)
    });
    await expect(acceptInvitation(alreadyHash, userA)).resolves.toEqual({ status: 'already_member', agency_id: agencyA, client_id: null });
    await expect(getOwner().knex('invitations').where({ id: alreadyInvitation }).first('used_at')).resolves.toEqual({ used_at: null });
    await getOwner().knex('invitations').where({ id: alreadyInvitation }).delete();

    const mismatchError = await acceptInvitation(`hash-${invitationA}`, userB).catch((error: unknown) => error);
    expect(mismatchError).toMatchObject({ code: 'A0002' });
  });

  it('allows one global user to hold legitimate memberships in two agencies', async () => {
    const secondAgency = randomUUID();
    const secondInvitation = randomUUID();
    const secondHash = `hash-${secondInvitation}`;
    const collaboratorEmail = `collaborator-${collaboratorUser}@example.test`;
    await getOwner().knex('agencies').insert({ id: secondAgency, name: 'Agency B Coexistence', owner_user_id: userB });
    await getOwner().knex('invitations').insert({
      id: secondInvitation,
      agency_id: secondAgency,
      purpose: 'collaborator_invite',
      email: collaboratorEmail,
      role_id: productionRoleId,
      token_hash: secondHash,
      expires_at: new Date(Date.now() + 86_400_000)
    });

    await expect(acceptInvitation(secondHash, collaboratorUser)).resolves.toEqual({
      status: 'accepted',
      agency_id: secondAgency,
      client_id: null
    });
    await expect(getOwner().knex('agency_memberships').where({ user_id: collaboratorUser }).whereIn('agency_id', [agencyA, secondAgency]).select('agency_id')).resolves.toEqual(
      expect.arrayContaining([{ agency_id: agencyA }, { agency_id: secondAgency }])
    );

    await getOwner().knex('invitations').where({ id: secondInvitation }).delete();
    await getOwner().knex('agency_memberships').where({ agency_id: secondAgency }).delete();
    await getOwner().knex('agencies').where({ id: secondAgency }).delete();
  });

  it('rolls back a user inserted before an acceptance failure', async () => {
    const rollbackUser = randomUUID();
    const rollbackInvitation = randomUUID();
    rollbackInvitationId = rollbackInvitation;
    const rollbackHash = `hash-${rollbackInvitation}`;
    const rollbackEmail = `rollback-${rollbackUser}@example.test`;
    await getOwner().knex('invitations').insert({
      id: rollbackInvitation,
      agency_id: agencyA,
      purpose: 'collaborator_invite',
      email: rollbackEmail,
      role_id: productionRoleId,
      token_hash: rollbackHash,
      expires_at: new Date(Date.now() + 86_400_000)
    });

    await expect(getApplication().transaction(async (transaction) => {
      await transaction('auth.user').insert({ id: rollbackUser, name: 'Rollback User', email: rollbackEmail, emailVerified: true });
      await raw(transaction, 'select * from app_private.accept_invitation(?, ?, ?, ?, ?)', [rollbackHash, rollbackUser, '2026-09-19', '', true]);
    })).rejects.toMatchObject({ code: 'A0003' });

    await expect(getOwner().knex('auth.user').where({ id: rollbackUser }).select('id')).resolves.toEqual([]);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: rollbackUser }).select('id')).resolves.toEqual([]);
    await expect(getOwner().knex('invitations').where({ id: rollbackInvitation }).first('used_at')).resolves.toEqual({ used_at: null });
    await getOwner().knex('invitations').where({ id: rollbackInvitation }).delete();
  });
});

describe('COLAB-94 agency_memberships UPDATE policy and the admin-grant rule', () => {
  // A dedicated agency keeps this fixture independent from the row counts the suite above asserts
  // on agencyA/agencyB.
  const agencyC = randomUUID();
  const ownerC = randomUUID();
  const adminC = randomUUID();
  const managerC = randomUUID();
  const productionC = randomUUID();
  const targetC = randomUUID();

  let accountManagerRoleId: string;

  beforeAll(async () => {
    const database = getOwner();
    const accountManagerRole = await database.knex('roles').whereNull('agency_id').where({ key: 'account_manager' }).first('id');
    if (accountManagerRole === undefined) throw new Error('account_manager system role seed is missing.');
    accountManagerRoleId = accountManagerRole.id;

    await database.transaction(async (transaction) => {
      await transaction('auth.user').insert([
        { id: ownerC, name: 'Owner C', email: `owner-c-${ownerC}@example.test`, emailVerified: true },
        { id: adminC, name: 'Admin C', email: `admin-c-${adminC}@example.test`, emailVerified: true },
        { id: managerC, name: 'Manager C', email: `manager-c-${managerC}@example.test`, emailVerified: true },
        { id: productionC, name: 'Production C', email: `production-c-${productionC}@example.test`, emailVerified: true },
        { id: targetC, name: 'Target C', email: `target-c-${targetC}@example.test`, emailVerified: true }
      ]);
      await transaction('agencies').insert({ id: agencyC, name: 'Agency C', owner_user_id: ownerC });
      await transaction('agency_memberships').insert([
        { agency_id: agencyC, user_id: ownerC, role_id: adminRoleId },
        { agency_id: agencyC, user_id: adminC, role_id: adminRoleId },
        { agency_id: agencyC, user_id: managerC, role_id: accountManagerRoleId },
        { agency_id: agencyC, user_id: productionC, role_id: productionRoleId },
        { agency_id: agencyC, user_id: targetC, role_id: productionRoleId, job_title: 'Original' }
      ]);
    });
  });

  afterAll(async () => {
    const database = getOwner();
    await database.knex('agency_memberships').where({ agency_id: agencyC }).delete();
    await database.knex('agencies').where({ id: agencyC }).update({ owner_user_id: null });
    await database.knex('agencies').where({ id: agencyC }).delete();
    await database.knex('auth.user').whereIn('id', [ownerC, adminC, managerC, productionC, targetC]).delete();
  });

  afterEach(async () => {
    await getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC })
      .update({ role_id: productionRoleId, job_title: 'Original', status: 'active' });
    await getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: ownerC })
      .update({ role_id: adminRoleId, job_title: null, status: 'active' });
  });

  it('grants the new permissions exactly as the module preset table requires', async () => {
    const systemRoleIds = await getOwner().knex('roles').whereNull('agency_id').pluck('id');
    const visualizarRoles = await getOwner().knex('role_permissions').where({ permission_key: 'colaborador.visualizar' }).pluck('role_id');
    expect([...visualizarRoles].sort()).toEqual([...systemRoleIds].sort());

    // Nobody may hold this preset: only the Owner passes it, by ownership.
    await expect(getOwner().knex('role_permissions').where({ permission_key: 'colaborador.atribuir_admin' }).select()).resolves.toEqual([]);

    await expect(getOwner().knex('role_permissions').where({ permission_key: 'colaborador.remover' }).pluck('role_id')).resolves.toEqual([adminRoleId]);
    await expect(getOwner().knex('role_permissions').where({ permission_key: 'colaborador.alterar_papel' }).pluck('role_id')).resolves.toEqual([adminRoleId]);

    const alterarFuncaoRoles = await getOwner().knex('role_permissions').where({ permission_key: 'colaborador.alterar_funcao' }).pluck('role_id');
    expect([...alterarFuncaoRoles].sort()).toEqual([accountManagerRoleId, adminRoleId].sort());
  });

  // Postgres semantics, not a choice: USING already admitted the row (the actor holds a module
  // permission and the target isn't the Owner), so a WITH CHECK failure past that point raises a
  // row-security error instead of returning 0 -- there is no proposed-value-dependent rule that can
  // be expressed in USING alone, since USING only ever sees the row as it stood before the
  // statement. Every case below that depends on the *new* role_id/job_title/status value is
  // asserted by the thrown error, then double-checked with a plain read that nothing moved.
  it('lets an admin change a role to a non-administrative role but never to admin', async () => {
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: accountManagerRoleId }))).resolves.toBe(1);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: adminRoleId }))).rejects.toThrow(membershipRuleDenied);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
      .resolves.toEqual({ role_id: accountManagerRoleId });
  });

  it('lets only the Owner grant the admin role, by ownership rather than a preset', async () => {
    await expect(asUser(ownerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: adminRoleId }))).resolves.toBe(1);
  });

  it('confines the account manager to job_title, never role_id', async () => {
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ job_title: 'Renamed' }))).resolves.toBe(1);
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: accountManagerRoleId }))).rejects.toThrow(membershipRuleDenied);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
      .resolves.toEqual({ role_id: productionRoleId });
  });

  it("denies production any update on another collaborator's row", async () => {
    await expect(asUser(productionC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ job_title: 'Should not change' }))).resolves.toBe(0);
  });

  it('lets an admin remove and reactivate a collaborator, each gated by its own permission', async () => {
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'removed' }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'removed' }))).resolves.toBe(1);
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'active', role_id: productionRoleId }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'active', role_id: productionRoleId }))).resolves.toBe(1);
  });

  // job_title on the Owner's own row is not covered by rule 4 of the SPEC (seção 4/5): only
  // removing the Owner or changing their role_id is forbidden. Admin and the account manager both
  // hold colaborador.alterar_funcao, so USING admits the Owner's row for them, and WITH CHECK lets
  // the job_title branch through -- exactly like editing anyone else's job_title.
  it("lets an admin and the account manager edit the Owner's job_title", async () => {
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ job_title: 'Renamed by admin' }))).resolves.toBe(1);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: ownerC }).first('job_title'))
      .resolves.toEqual({ job_title: 'Renamed by admin' });

    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ job_title: 'Renamed by manager' }))).resolves.toBe(1);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: ownerC }).first('job_title'))
      .resolves.toEqual({ job_title: 'Renamed by manager' });
  });

  // role_id and status on the Owner's row stay unconditionally immovable, for anyone, including the
  // Owner themselves. USING cannot see which column a statement targets (it only ever sees the row
  // as it stood before the UPDATE), so it admits or rejects the whole row per actor: it admits the
  // Owner's row for whoever holds colaborador.alterar_funcao (admin, the account manager, and the
  // Owner by ownership) so job_title edits can succeed, which means a role_id/status attempt by one
  // of those actors is admitted too and then fails WITH CHECK -- a row-security error, not 0 rows.
  // An actor without colaborador.alterar_funcao (production here) never gets past USING at all, so
  // the same attempt returns 0 rows silently. Either way the final state must not move.
  it('never lets the Owner be the target of a role or status change', async () => {
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ role_id: productionRoleId }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ status: 'removed' }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(ownerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ role_id: productionRoleId }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ status: 'removed' }))).rejects.toThrow(membershipRuleDenied);
    await expect(asUser(productionC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ role_id: productionRoleId }))).resolves.toBe(0);
    await expect(asUser(productionC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ status: 'removed' }))).resolves.toBe(0);

    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: ownerC }).first('role_id', 'status'))
      .resolves.toEqual({ role_id: adminRoleId, status: 'active' });
  });

  it('keeps every update scoped to its own agency', async () => {
    await expect(asUser(userA, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ job_title: 'Cross agency' }))).resolves.toBe(0);
  });

  it('requires colaborador.atribuir_admin to invite someone as admin, which only the Owner passes', async () => {
    const adminInvite = randomUUID();
    const email = `admin-invite-${adminInvite}@example.test`;
    const inviteRow = {
      id: adminInvite,
      agency_id: agencyC,
      purpose: 'collaborator_invite',
      email,
      role_id: adminRoleId,
      token_hash: `admin-invite-${adminInvite}`,
      expires_at: new Date(Date.now() + 86_400_000)
    };

    await expect(asUser(adminC, (transaction) => transaction('invitations').insert(inviteRow))).rejects.toThrow(/row-level security/);

    await expect(asUser(ownerC, (transaction) => transaction('invitations').insert(inviteRow))).resolves.toBeDefined();
    await expect(getOwner().knex('invitations').where({ id: adminInvite }).first('role_id')).resolves.toEqual({ role_id: adminRoleId });

    await getOwner().knex('invitations').where({ id: adminInvite }).delete();
  });

  // PR #159 review, finding 1: the table-wide UPDATE grant let any actor who passed USING move a
  // membership between agencies or users by setting agency_id/user_id/id, bypassing the
  // admin-grant gate entirely (role_id/job_title/status compared equal to themselves). The grant
  // is now column-scoped, so this fails before RLS or the trigger ever run, for every actor.
  it('refuses to move a membership between agencies or users, regardless of who asks', async () => {
    for (const actor of [adminC, managerC, ownerC]) {
      await expect(asUser(actor, (transaction) => transaction('agency_memberships')
        .where({ agency_id: agencyC, user_id: targetC }).update({ agency_id: agencyA }))).rejects.toThrow(/permission denied/);
      await expect(asUser(actor, (transaction) => transaction('agency_memberships')
        .where({ agency_id: agencyC, user_id: targetC }).update({ user_id: userA }))).rejects.toThrow(/permission denied/);
      await expect(asUser(actor, (transaction) => transaction('agency_memberships')
        .where({ agency_id: agencyC, user_id: targetC }).update({ id: randomUUID() }))).rejects.toThrow(/permission denied/);
    }

    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('agency_id', 'user_id'))
      .resolves.toEqual({ agency_id: agencyC, user_id: targetC });
  });

  // The exact attack proven in the review: the account manager (only colaborador.alterar_funcao)
  // took the Owner's row, whose role_id already reads 'admin', and reassigned user_id to an
  // unrelated account -- handing out admin without ever touching colaborador.atribuir_admin.
  it("rejects the reviewer's attack: the account manager cannot move the Owner's row to another user", async () => {
    const looseUser = randomUUID();
    await getOwner().knex('auth.user').insert({ id: looseUser, name: 'Loose User', email: `loose-${looseUser}@example.test`, emailVerified: true });

    try {
      await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
        .where({ agency_id: agencyC, user_id: ownerC }).update({ user_id: looseUser }))).rejects.toThrow(/permission denied/);

      await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: ownerC }).first('user_id'))
        .resolves.toEqual({ user_id: ownerC });
      await expect(getOwner().knex('agency_memberships').where({ user_id: looseUser }).select('id')).resolves.toEqual([]);
    } finally {
      await getOwner().knex('auth.user').where({ id: looseUser }).delete();
    }
  });

  // Finding 3: is_admin_role's own agency filter makes it return false for a role from another
  // agency, so the admin-grant gate never sees it -- but nothing else stopped the assignment
  // itself. Both places a role is handed out must recognise "not mine, and not a system role" on
  // their own.
  it('refuses a role_id belonging to another agency, on UPDATE and on invite', async () => {
    const foreignRoleId = randomUUID();
    await getOwner().knex('roles').insert({ id: foreignRoleId, agency_id: agencyA, key: `foreign-${foreignRoleId}`, name: 'Foreign Role', is_system: false });

    try {
      await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
        .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: foreignRoleId }))).rejects.toThrow(membershipRuleDenied);
      await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
        .resolves.toEqual({ role_id: productionRoleId });

      const foreignInvite = randomUUID();
      const inviteRow = {
        id: foreignInvite,
        agency_id: agencyC,
        purpose: 'collaborator_invite',
        email: `foreign-invite-${foreignInvite}@example.test`,
        role_id: foreignRoleId,
        token_hash: `foreign-invite-${foreignInvite}`,
        expires_at: new Date(Date.now() + 86_400_000)
      };
      await expect(asUser(adminC, (transaction) => transaction('invitations').insert(inviteRow))).rejects.toThrow(/row-level security/);
      await expect(getOwner().knex('invitations').where({ id: foreignInvite }).select('id')).resolves.toEqual([]);
    } finally {
      await getOwner().knex('roles').where({ id: foreignRoleId }).delete();
    }
  });

  it('lets a non-Owner admin invite with a non-admin role, and keeps resend working', async () => {
    const collaboratorInviteId = randomUUID();
    const email = `admin-c-collab-invite-${collaboratorInviteId}@example.test`;
    const inviteRow = {
      id: collaboratorInviteId,
      agency_id: agencyC,
      purpose: 'collaborator_invite',
      email,
      role_id: productionRoleId,
      token_hash: `admin-c-collab-invite-${collaboratorInviteId}`,
      expires_at: new Date(Date.now() + 86_400_000)
    };
    await expect(asUser(adminC, (transaction) => transaction('invitations').insert(inviteRow))).resolves.toBeDefined();

    // Resend, as convite.reenviar does in the API: revoke, then insert a replacement.
    await expect(asUser(adminC, (transaction) => transaction('invitations').where({ id: collaboratorInviteId }).update({ revoked_at: new Date() }))).resolves.toBe(1);
    const resendId = randomUUID();
    await expect(asUser(adminC, (transaction) => transaction('invitations').insert({
      ...inviteRow,
      id: resendId,
      token_hash: `admin-c-collab-resend-${resendId}`
    }))).resolves.toBeDefined();

    await getOwner().knex('invitations').whereIn('id', [collaboratorInviteId, resendId]).delete();
  });

  it('keeps client invitations and their resend unaffected by the admin-grant gate', async () => {
    const clientId = randomUUID();
    await getOwner().knex('clients').insert({ id: clientId, agency_id: agencyC, name: 'Client C' });

    try {
      const clientInviteId = randomUUID();
      const email = `client-invite-${clientInviteId}@example.test`;
      await expect(asUser(adminC, (transaction) => transaction('invitations').insert({
        id: clientInviteId,
        agency_id: agencyC,
        purpose: 'client_invite',
        client_id: clientId,
        email,
        token_hash: `client-invite-${clientInviteId}`,
        expires_at: new Date(Date.now() + 86_400_000)
      }))).resolves.toBeDefined();

      await expect(asUser(adminC, (transaction) => transaction('invitations').where({ id: clientInviteId }).update({ revoked_at: new Date() }))).resolves.toBe(1);
      const resendId = randomUUID();
      await expect(asUser(adminC, (transaction) => transaction('invitations').insert({
        id: resendId,
        agency_id: agencyC,
        purpose: 'client_invite',
        client_id: clientId,
        email,
        token_hash: `client-invite-resend-${resendId}`,
        expires_at: new Date(Date.now() + 86_400_000)
      }))).resolves.toBeDefined();

      await getOwner().knex('invitations').whereIn('id', [clientInviteId, resendId]).delete();
    } finally {
      await getOwner().knex('clients').where({ id: clientId }).delete();
    }
  });

  // Finding 2: under READ COMMITTED, a sub-select's snapshot goes stale the moment a concurrent
  // writer commits. T1 (the Owner) demotes the target and holds the row lock past its own commit
  // via pg_sleep; T2 (a plain Admin, who never holds colaborador.atribuir_admin) tries to re-grant
  // admin on the very same row and blocks on the lock. Once T1 commits, Postgres's EvalPlanQual
  // reapplies T2's UPDATE against the row T1 just committed, and the trigger's OLD is that fresh
  // row -- not a stale sub-select -- so the re-grant is still refused.
  it('closes the concurrent-update race: a re-grant of admin cannot outlive a committed demotion', async () => {
    await getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).update({ role_id: adminRoleId });

    try {
      const ownerDemotion = asUser(ownerC, async (transaction) => {
        await transaction('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).update({ role_id: productionRoleId });
        await raw(transaction, 'select pg_sleep(0.4)', []);
      });

      const adminReGrant = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return asUser(adminC, (transaction) => transaction('agency_memberships')
          .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: adminRoleId, job_title: 'Re-grant attempt' }));
      })();

      const [demotionResult, reGrantResult] = await Promise.allSettled([ownerDemotion, adminReGrant]);
      expect(demotionResult.status).toBe('fulfilled');
      expect(reGrantResult.status).toBe('rejected');
      if (reGrantResult.status === 'rejected') {
        expect(String(reGrantResult.reason)).toMatch(membershipRuleDenied);
      }

      await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id', 'job_title'))
        .resolves.toEqual({ role_id: productionRoleId, job_title: 'Original' });
    } finally {
      await getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).update({ role_id: productionRoleId, job_title: 'Original' });
    }
  });

  // Re-review finding N1: app_private.accept_invitation is security definer and reactivates a
  // removed membership via INSERT ... ON CONFLICT DO UPDATE, which fires this trigger while
  // app.user_id is the invitee -- not an actor holding colaborador.alterar_papel. The trigger must
  // let that statement through as the schema owner (current_user, not app.user_id, decides the
  // bypass) or accepting a re-invitation as a removed collaborator regresses into an error.
  it('accepts a re-invitation for a removed collaborator despite the trigger', async () => {
    await getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).update({ status: 'removed' });

    const reInvite = randomUUID();
    const tokenHash = `re-invite-${reInvite}`;
    await getOwner().knex('invitations').insert({
      id: reInvite,
      agency_id: agencyC,
      purpose: 'collaborator_invite',
      email: `target-c-${targetC}@example.test`,
      role_id: accountManagerRoleId,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 86_400_000)
    });

    try {
      // recordAcceptance: false -- this fixture's users never seed legal_acceptances, and the
      // outer suite's afterAll does not clean that table for them.
      await expect(acceptInvitation(tokenHash, targetC, '2026-09-19', '2026-09-19', false)).resolves.toEqual({
        status: 'accepted',
        agency_id: agencyC,
        client_id: null
      });
      await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id', 'status'))
        .resolves.toEqual({ role_id: accountManagerRoleId, status: 'active' });
    } finally {
      await getOwner().knex('invitations').where({ id: reInvite }).delete();
    }
  });

  // Re-review finding N1 (agency_activation branch): accept_invitation sets agencies.owner_user_id
  // to the new owner *before* the ON CONFLICT DO UPDATE on agency_memberships, in the same
  // transaction -- so by the time this trigger fires, is_agency_owner already reads true for that
  // row, and it must not then treat the very update that grants ownership as forbidden.
  it('accepts an agency activation despite an existing membership row for the new Owner', async () => {
    const activationAgencyD = randomUUID();
    const activationUserD = randomUUID();
    const activationInvitationD = randomUUID();
    const tokenHash = `activation-d-${activationInvitationD}`;

    await getOwner().knex('auth.user').insert({
      id: activationUserD, name: 'Activation D', email: `activation-d-${activationUserD}@example.test`, emailVerified: true
    });
    await getOwner().knex('agencies').insert({ id: activationAgencyD, name: 'Agency D', owner_user_id: null });
    // The invitee already has a row on this not-yet-activated agency, e.g. a removed
    // collaborator from before it was ever owned -- the exact shape accept_invitation's
    // ON CONFLICT DO UPDATE reactivates.
    await getOwner().knex('agency_memberships').insert({
      agency_id: activationAgencyD, user_id: activationUserD, role_id: productionRoleId, status: 'removed'
    });
    await getOwner().knex('invitations').insert({
      id: activationInvitationD,
      agency_id: activationAgencyD,
      purpose: 'agency_activation',
      email: `activation-d-${activationUserD}@example.test`,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 86_400_000)
    });

    try {
      await expect(acceptInvitation(tokenHash, activationUserD, '2026-09-19', '2026-09-19', false)).resolves.toEqual({
        status: 'accepted',
        agency_id: activationAgencyD,
        client_id: null
      });
      await expect(getOwner().knex('agency_memberships').where({ agency_id: activationAgencyD, user_id: activationUserD }).first('role_id', 'status'))
        .resolves.toEqual({ role_id: adminRoleId, status: 'active' });
    } finally {
      await getOwner().knex('audit.events').where({ agency_id: activationAgencyD }).delete();
      await getOwner().knex('invitations').where({ id: activationInvitationD }).delete();
      await getOwner().knex('agency_memberships').where({ agency_id: activationAgencyD }).delete();
      await getOwner().knex('agencies').where({ id: activationAgencyD }).update({ owner_user_id: null });
      await getOwner().knex('agencies').where({ id: activationAgencyD }).delete();
      await getOwner().knex('auth.user').where({ id: activationUserD }).delete();
    }
  });

  // Issue #166: app.user_id is no longer read. The actor of the transaction is bound once by
  // app_private.bind_actor and read through app_private.current_user_id(). set_config still runs
  // (it is PUBLIC), set inside the SET expression's subquery -- evaluated after USING and before
  // this trigger -- but the trigger authorizes the bound actor, here an Admin without
  // colaborador.atribuir_admin. Forging the Owner's id must not grant admin.
  it('ignores a mid-statement app.user_id forced to the Owner: the bound actor decides', async () => {
    const attack = asUser(adminC, (transaction) => raw(
      transaction,
      `update agency_memberships
          set role_id = (
            select id from roles
             where agency_id is null and key = 'admin'
               and set_config('app.user_id', ?::text, true) is not null
          )
        where agency_id = ? and user_id = ?`,
      [ownerC, agencyC, targetC]
    ));

    // The set_config runs inside the SET expression's subquery, which Postgres evaluates before
    // this BEFORE UPDATE trigger fires. It now changes nothing: has_agency_permission reads the
    // actor bound at the top of the transaction (adminC), reaches the atribuir_admin branch and
    // denies there -- not because a GUC was empty. The final state must not move.
    await expect(attack).rejects.toThrow(membershipRuleDenied);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
      .resolves.toEqual({ role_id: productionRoleId });
  });
});
