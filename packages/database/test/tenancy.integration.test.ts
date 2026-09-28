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
    await expect(asUser(userA, (transaction) => transaction('permissions').select('key'))).resolves.toHaveLength(10);
    await expect(asUser(userA, (transaction) => transaction('roles').whereNull('agency_id').select('key'))).resolves.toHaveLength(5);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').select('permission_key'))).resolves.toHaveLength(14);

    await expect(asUser(userA, (transaction) => transaction('agencies').insert({ id: randomUUID(), name: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('clients').insert({ id: randomUUID(), agency_id: agencyB, name: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('agency_memberships').insert({ id: randomUUID(), agency_id: agencyB, user_id: userA, role_id: adminRoleId }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('client_memberships').insert({ id: randomUUID(), client_id: clientB, user_id: userA }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('invitations').insert({
      id: randomUUID(), agency_id: agencyB, purpose: 'collaborator_invite', email: `denied-${randomUUID()}@example.test`, role_id: productionRoleId,
      token_hash: `denied-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000)
    }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('legal_acceptances').insert({ id: randomUUID(), user_id: userA, document: 'terms', version: `denied-${randomUUID()}` }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('permissions').insert({ key: `denied.${randomUUID()}`, description: 'Denied' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('roles').insert({ id: randomUUID(), agency_id: agencyB, key: `denied-${randomUUID()}`, name: 'Denied', is_system: false }))).rejects.toThrow(/row-level security/);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').insert({ role_id: randomUUID(), permission_key: 'colaborador.convidar' }))).rejects.toThrow(/row-level security/);

    await expect(asUser(userA, (transaction) => transaction('agencies').where({ id: agencyB }).update({ name: 'Should not change' }))).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('clients').where({ id: clientB }).delete())).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('agency_memberships').where({ agency_id: agencyB }).delete())).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('client_memberships').where({ client_id: clientB }).delete())).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('invitations').where({ id: invitationB }).delete())).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('legal_acceptances').where({ user_id: userB }).delete())).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('permissions').where({ key: 'colaborador.convidar' }).update({ description: 'Should not change' }))).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('roles').where({ key: 'admin' }).whereNull('agency_id').update({ name: 'Should not change' }))).resolves.toBe(0);
    await expect(asUser(userA, (transaction) => transaction('role_permissions').where({ role_id: adminRoleId }).delete())).resolves.toBe(0);
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
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: adminRoleId }))).rejects.toThrow(/row-level security/);
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
      .where({ agency_id: agencyC, user_id: targetC }).update({ role_id: accountManagerRoleId }))).rejects.toThrow(/row-level security/);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
      .resolves.toEqual({ role_id: productionRoleId });
  });

  it("denies production any update on another collaborator's row", async () => {
    await expect(asUser(productionC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ job_title: 'Should not change' }))).resolves.toBe(0);
  });

  it('lets an admin remove and reactivate a collaborator, each gated by its own permission', async () => {
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'removed' }))).rejects.toThrow(/row-level security/);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'removed' }))).resolves.toBe(1);
    await expect(asUser(managerC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'active', role_id: productionRoleId }))).rejects.toThrow(/row-level security/);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: targetC }).update({ status: 'active', role_id: productionRoleId }))).resolves.toBe(1);
  });

  it('never lets the Owner be the target of a role or status change', async () => {
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ role_id: productionRoleId }))).resolves.toBe(0);
    await expect(asUser(adminC, (transaction) => transaction('agency_memberships')
      .where({ agency_id: agencyC, user_id: ownerC }).update({ status: 'removed' }))).resolves.toBe(0);
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
});
