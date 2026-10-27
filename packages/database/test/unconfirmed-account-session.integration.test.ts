import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  raw,
  resolveIntegrationDatabaseUrls,
  type DatabaseClient
} from '../src/index.js';

// Issue #706 and the review of PR #722 (findings B1 and B3): the one unconfirmed account that may
// hold a session is the one an invitation created, for as long as the context the invitation gave it
// would still be listed (`contexts/service.ts`). The three purposes are attacked one by one, because a
// branch nobody exercises can be wrong and leave every other test green.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

type Purpose = 'agency_activation' | 'collaborator_invite' | 'client_invite';
const PURPOSES: readonly Purpose[] = ['agency_activation', 'collaborator_invite', 'client_invite'];

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId = '';
const createdUsers: string[] = [];
const createdAgencies: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const newUser = async (emailVerified: boolean): Promise<string> => {
  const id = randomUUID();
  createdUsers.push(id);
  await getOwner().knex('auth.user').insert({ id, name: 'Invited', email: `session-exception-${id}@example.test`, emailVerified });
  return id;
};

interface Scene {
  readonly userId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly invitationId: string;
}

/**
 * The account an invitation of `purpose` created and the link that invitation gave it. Every
 * other link exists too, so the function has to pick the one of the invitation's own purpose.
 */
const scene = async (purpose: Purpose, others: { readonly withLinks: boolean } = { withLinks: false }): Promise<Scene> => {
  const knex = getOwner().knex;
  const userId = await newUser(false);
  const agencyId = randomUUID();
  const clientId = randomUUID();
  createdAgencies.push(agencyId);
  await knex('agencies').insert({ id: agencyId, name: `Session exception ${agencyId}`, status: 'active', owner_user_id: purpose === 'agency_activation' ? userId : null });
  await knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Session exception ${clientId}`, status: 'active' });

  const linkOf: Record<Purpose, () => Promise<unknown>> = {
    agency_activation: () => knex('agencies').where({ id: agencyId }).update({ owner_user_id: userId }),
    collaborator_invite: () => knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: adminRoleId, status: 'active' }),
    client_invite: () => knex('client_memberships').insert({ client_id: clientId, user_id: userId, status: 'active' })
  };
  await linkOf[purpose]();
  if (others.withLinks) {
    for (const other of PURPOSES.filter((candidate) => candidate !== purpose)) await linkOf[other]();
  }

  const invitationId = randomUUID();
  await knex('invitations').insert({
    id: invitationId,
    agency_id: agencyId,
    purpose,
    email: `session-exception-${invitationId}@example.test`,
    role_id: purpose === 'collaborator_invite' ? adminRoleId : null,
    client_id: purpose === 'client_invite' ? clientId : null,
    token_hash: createHash('sha256').update(invitationId).digest('hex'),
    expires_at: new Date(Date.now() + 86_400_000),
    used_at: new Date(),
    accepted_by_user_id: userId
  });
  return { userId, agencyId, clientId, invitationId };
};

const mayHold = async (userId: string): Promise<boolean> => {
  const { rows } = await raw<{ rows: readonly { allowed: boolean }[] }>(
    getApplication().knex, 'select app_private.unconfirmed_account_may_hold_session(?::uuid) as allowed', [userId]
  );
  return rows[0]?.allowed ?? false;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const admin = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'admin' }).first<{ id: string }>('id');
  if (admin === undefined) throw new Error('The system admin role is missing.');
  adminRoleId = admin.id;
});

afterAll(async () => {
  const knex = getOwner().knex;
  await knex('invitations').whereIn('agency_id', createdAgencies).delete();
  await knex('client_memberships').whereIn('user_id', createdUsers).delete();
  await knex('agency_memberships').whereIn('user_id', createdUsers).delete();
  await knex('clients').whereIn('agency_id', createdAgencies).delete();
  await knex('agencies').whereIn('id', createdAgencies).delete();
  await knex('auth.user').whereIn('id', createdUsers).delete();
  await application?.close();
  await owner?.close();
});

describe.each(PURPOSES)('app_private.unconfirmed_account_may_hold_session, invitation of %s (issue #706)', (purpose) => {
  it('is yes while the invitation was accepted and its link stands', async () => {
    const { userId } = await scene(purpose);
    await expect(mayHold(userId)).resolves.toBe(true);
  });

  it('is no for a confirmed account, which needs no exception', async () => {
    const { userId } = await scene(purpose);
    await getOwner().knex('auth.user').where({ id: userId }).update({ emailVerified: true });
    await expect(mayHold(userId)).resolves.toBe(false);
  });

  it('is no while the invitation was not used, or was accepted by another account', async () => {
    const unused = await scene(purpose);
    await getOwner().knex('invitations').where({ id: unused.invitationId }).update({ used_at: null });
    await expect(mayHold(unused.userId)).resolves.toBe(false);

    const stolen = await scene(purpose);
    const other = await newUser(false);
    await getOwner().knex('invitations').where({ id: stolen.invitationId }).update({ accepted_by_user_id: other });
    await expect(mayHold(stolen.userId)).resolves.toBe(false);
  });

  it('is no once the link of the invitation is gone, whatever else the account holds', async () => {
    const { userId, agencyId, clientId } = await scene(purpose, { withLinks: true });
    await expect(mayHold(userId)).resolves.toBe(true);

    const knex = getOwner().knex;
    const lose: Record<Purpose, () => Promise<unknown>> = {
      agency_activation: () => knex('agencies').where({ id: agencyId }).update({ owner_user_id: null }),
      collaborator_invite: () => knex('agency_memberships').where({ agency_id: agencyId, user_id: userId }).update({ status: 'removed' }),
      client_invite: () => knex('client_memberships').where({ client_id: clientId, user_id: userId }).update({ status: 'removed' })
    };
    await lose[purpose]();
    await expect(mayHold(userId)).resolves.toBe(false);
  });

  it('is no when the agency is suspended, as the account would list no context (finding B1)', async () => {
    const { userId, agencyId } = await scene(purpose);
    await getOwner().knex('agencies').where({ id: agencyId }).update({ status: 'suspended' });
    await expect(mayHold(userId)).resolves.toBe(false);

    await getOwner().knex('agencies').where({ id: agencyId }).update({ status: 'active' });
    await expect(mayHold(userId)).resolves.toBe(true);
  });
});

describe('app_private.unconfirmed_account_may_hold_session, the client of a portal invitation (finding B1)', () => {
  it('is no while the client is archived, and yes again when it is active', async () => {
    const { userId, clientId } = await scene('client_invite');
    await getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
    await expect(mayHold(userId)).resolves.toBe(false);

    await getOwner().knex('clients').where({ id: clientId }).update({ status: 'active', archived_at: null });
    await expect(mayHold(userId)).resolves.toBe(true);
  });

  it('is not changed by the status of a client the invitation did not give', async () => {
    const { userId, clientId } = await scene('collaborator_invite');
    await getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
    await expect(mayHold(userId)).resolves.toBe(true);
  });
});

describe('app_private.unconfirmed_account_may_hold_session, who may call it', () => {
  it('is security definer with a fixed search_path, and only ageniza_app and its owner execute it, never PUBLIC', async () => {
    const { rows } = await raw<{ rows: readonly { definer: boolean; config: readonly string[] | null; grantees: readonly string[] }[] }>(getOwner().knex, `
      select p.prosecdef as definer, p.proconfig as config,
        array(
          select (case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee)::text end)
          from pg_catalog.aclexplode(p.proacl) acl where acl.privilege_type = 'EXECUTE'
          order by 1
        )::text[] as grantees
      from pg_catalog.pg_proc p
      where p.oid = 'app_private.unconfirmed_account_may_hold_session(uuid)'::regprocedure
    `, []);
    expect(rows[0]?.definer).toBe(true);
    expect(rows[0]?.config).toEqual(['search_path=""']);
    expect(rows[0]?.grantees).toEqual(['ageniza_app', 'postgres']);
  });
});

describe('app_private.unconfirmed_account_may_hold_session, an account nobody invited', () => {
  it('is no for an account that signed up on its own', async () => {
    await expect(mayHold(await newUser(false))).resolves.toBe(false);
  });

  it('is no for an id that is not an account', async () => {
    await expect(mayHold(randomUUID())).resolves.toBe(false);
  });
});
