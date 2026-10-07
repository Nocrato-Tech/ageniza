import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #296. `agencies`, `agency_storage_quotas`, `roles`, `role_permissions` and `permissions` have
// no UPDATE policy and nothing updates them, yet `ageniza_app` held UPDATE on every column, and
// DELETE on those and on `client_memberships`. Only the RLS stood between the application role and
// the first UPDATE policy somebody writes inheriting a grant that covers `owner_user_id` or
// `permission_key`. Migration 20261007000700 takes the privileges away; `accept_invitation` also
// validates the Terms and Privacy versions as a date. Every attack runs as the agency owner, the
// person for whom the most policies say yes, so a refusal can only come from the privilege layer.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const denied = (table: string) => ({ code: '42501', message: expect.stringContaining(`permission denied for table ${table}`) });

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let productionRoleId: string;

const agencyId = randomUUID();
const ownerUserId = randomUUID();
const roleId = randomUUID();
const clientId = randomUUID();
const memberId = randomUUID();
const userIds = [ownerUserId, memberId];
const invitationIds: string[] = [];
const inviteeIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const insertUser = async (id: string, label: string): Promise<string> => {
  const email = `${label}.${id.slice(0, 8)}@db-integration.test`;
  await getOwner().knex('auth.user').insert({ id, name: label, email, emailVerified: false });
  return email;
};

interface Attack {
  readonly table: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly policy: 'update' | 'delete';
  readonly intact: () => Promise<unknown>;
}

const attacks = (): Attack[] => [
  {
    table: 'agencies', policy: 'update', sql: 'update public.agencies set owner_user_id = ?::uuid where id = ?::uuid', params: [memberId, agencyId],
    intact: () => getOwner().knex('agencies').where({ id: agencyId }).first('owner_user_id')
  },
  {
    table: 'agency_storage_quotas', policy: 'update', sql: 'update public.agency_storage_quotas set quota_bytes = 9 where agency_id = ?::uuid', params: [agencyId],
    intact: () => getOwner().knex('agency_storage_quotas').where({ agency_id: agencyId }).first('quota_bytes')
  },
  {
    table: 'roles', policy: 'update', sql: "update public.roles set name = 'Forjado' where id = ?::uuid", params: [roleId],
    intact: () => getOwner().knex('roles').where({ id: roleId }).first('name')
  },
  {
    table: 'role_permissions', policy: 'update', sql: "update public.role_permissions set permission_key = 'colaborador.atribuir_admin' where role_id = ?::uuid", params: [roleId],
    intact: () => getOwner().knex('role_permissions').where({ role_id: roleId }).select('permission_key')
  },
  {
    table: 'permissions', policy: 'update', sql: "update public.permissions set description = 'Forjada' where key = 'midia.enviar'", params: [],
    intact: () => getOwner().knex('permissions').where({ key: 'midia.enviar' }).first('description')
  },
  {
    table: 'agencies', policy: 'delete', sql: 'delete from public.agencies where id = ?::uuid', params: [agencyId],
    intact: () => getOwner().knex('agencies').where({ id: agencyId }).select('id')
  },
  {
    table: 'agency_storage_quotas', policy: 'delete', sql: 'delete from public.agency_storage_quotas where agency_id = ?::uuid', params: [agencyId],
    intact: () => getOwner().knex('agency_storage_quotas').where({ agency_id: agencyId }).select('agency_id')
  },
  {
    table: 'roles', policy: 'delete', sql: 'delete from public.roles where id = ?::uuid', params: [roleId],
    intact: () => getOwner().knex('roles').where({ id: roleId }).select('id')
  },
  {
    table: 'role_permissions', policy: 'delete', sql: 'delete from public.role_permissions where role_id = ?::uuid', params: [roleId],
    intact: () => getOwner().knex('role_permissions').where({ role_id: roleId }).select('permission_key')
  },
  {
    table: 'permissions', policy: 'delete', sql: "delete from public.permissions where key = 'midia.enviar'", params: [],
    intact: () => getOwner().knex('permissions').where({ key: 'midia.enviar' }).select('key')
  },
  {
    table: 'client_memberships', policy: 'delete', sql: 'delete from public.client_memberships where client_id = ?::uuid', params: [clientId],
    intact: () => getOwner().knex('client_memberships').where({ client_id: clientId }).select('user_id')
  }
];

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  if (role === undefined) throw new Error('System role seeds are missing.');
  productionRoleId = role.id;

  await insertUser(ownerUserId, 'dona');
  await insertUser(memberId, 'cliente');
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Grants mínimos', owner_user_id: ownerUserId, status: 'active' });
  await getOwner().knex('agency_storage_quotas').insert({ agency_id: agencyId, quota_bytes: 1_000_000 });
  await getOwner().knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Papel da agência', is_system: false });
  await getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'midia.enviar' });
  await getOwner().knex('clients').insert({ id: clientId, agency_id: agencyId, name: 'Cliente' });
  await getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: memberId });
});

afterAll(async () => {
  await getOwner().knex('legal_acceptances').whereIn('user_id', inviteeIds).delete();
  await getOwner().knex('audit.events').where({ agency_id: agencyId }).delete();
  await getOwner().knex('invitations').whereIn('id', invitationIds).delete();
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('client_memberships').where({ client_id: clientId }).delete();
  await getOwner().knex('clients').where({ id: clientId }).delete();
  await getOwner().knex('role_permissions').where({ role_id: roleId }).delete();
  await getOwner().knex('roles').where({ id: roleId }).delete();
  await getOwner().knex('agency_storage_quotas').where({ agency_id: agencyId }).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', [...userIds, ...inviteeIds]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('ageniza_app keeps SELECT and nothing else where no policy writes (issue #296)', () => {
  it.each([
    'agencies', 'agency_storage_quotas', 'roles', 'role_permissions', 'permissions'
  ])('%s: no UPDATE on the table or on any column, no DELETE, no TRUNCATE, SELECT kept', async (table) => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
      select
        has_table_privilege('ageniza_app', ?::regclass, 'select') as can_select,
        has_table_privilege('ageniza_app', ?::regclass, 'update') as table_update,
        has_any_column_privilege('ageniza_app', ?::regclass, 'update') as column_update,
        has_table_privilege('ageniza_app', ?::regclass, 'delete') as can_delete,
        has_table_privilege('ageniza_app', ?::regclass, 'truncate') as can_truncate
    `, Array(5).fill(`public.${table}`));
    expect({ table, ...rows[0] }).toEqual({ table, can_select: true, table_update: false, column_update: false, can_delete: false, can_truncate: false });
  });

  it('client_memberships: no DELETE, and UPDATE only on the two onboarding columns', async () => {
    const { rows: columns } = await getOwner().knex.raw<{ rows: Array<{ column_name: string }> }>(`
      select a.attname as column_name
      from pg_catalog.pg_attribute a
      where a.attrelid = 'public.client_memberships'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('ageniza_app', 'public.client_memberships'::regclass, a.attnum, 'update')
      order by a.attname
    `);
    expect(columns.map((row) => row.column_name)).toEqual(['onboarding_seen_at', 'updated_at']);

    const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
      select
        has_table_privilege('ageniza_app', 'public.client_memberships', 'select') as can_select,
        has_table_privilege('ageniza_app', 'public.client_memberships', 'update') as table_update,
        has_table_privilege('ageniza_app', 'public.client_memberships', 'delete') as can_delete,
        has_table_privilege('ageniza_app', 'public.client_memberships', 'truncate') as can_truncate
    `);
    expect(rows[0]).toEqual({ can_select: true, table_update: false, can_delete: false, can_truncate: false });
  });

  it.each(attacks().map((attack) => [`${attack.policy} ${attack.table}`, attack.table, attack.policy] as const))(
    'refuses %s by the agency owner at the privilege layer, leaving the row',
    async (label, table, policy) => {
      const attack = attacks().find((candidate) => candidate.table === table && candidate.policy === policy)!;
      const before = JSON.stringify(await attack.intact());

      await expect(asUser(ownerUserId, (transaction) => raw(transaction, attack.sql, attack.params))).rejects.toMatchObject(denied(table));

      expect(JSON.stringify(await attack.intact()), label).toBe(before);
    }
  );

  it.each(attacks().map((attack) => [`${attack.policy} ${attack.table}`, attack.table, attack.policy] as const))(
    'still refuses %s when a permissive policy for it is created by mistake',
    async (label, table, policy) => {
      const attack = attacks().find((candidate) => candidate.table === table && candidate.policy === policy)!;
      const before = JSON.stringify(await attack.intact());

      // Same transaction, rolled back: the owner adds the policy, then acts as ageniza_app under it.
      const transaction = await getOwner().knex.transaction();
      try {
        await transaction.raw(`create policy zz_by_mistake on public.${table} for ${policy} to ageniza_app using (true)${policy === 'update' ? ' with check (true)' : ''}`);
        await transaction.raw('set local role ageniza_app');
        await transaction.raw('select app_private.bind_actor(?::uuid)', [ownerUserId]);
        await expect(transaction.raw(attack.sql, [...attack.params])).rejects.toMatchObject(denied(table));
      } finally {
        await transaction.rollback();
      }

      expect(JSON.stringify(await attack.intact()), label).toBe(before);
    }
  );

  it('refuses a row lock on agencies: SELECT ... FOR UPDATE needs the UPDATE privilege that is gone', async () => {
    await expect(asUser(ownerUserId, (transaction) => raw(transaction, 'select id from public.agencies where id = ?::uuid for update', [agencyId])))
      .rejects.toMatchObject(denied('agencies'));
  });

  it('leaves what the application does need: reading, and the column UPDATE of the onboarding', async () => {
    await expect(asUser(ownerUserId, (transaction) => transaction('agencies').where({ id: agencyId }).select('id'))).resolves.toHaveLength(1);
    await expect(asUser(ownerUserId, (transaction) => transaction('agency_storage_quotas').where({ agency_id: agencyId }).select('agency_id'))).resolves.toHaveLength(1);
    await expect(asUser(memberId, (transaction) => transaction('client_memberships').where({ client_id: clientId, user_id: memberId })
      .update({ onboarding_seen_at: new Date() }))).resolves.toBe(1);
  });
});

describe('accept_invitation validates the Terms and Privacy versions as a real date (issue #296)', () => {
  const today = async (offsetDays = 0): Promise<string> => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ day: string }> }>(
      "select ((now() at time zone 'America/Sao_Paulo')::date + ?::integer)::text as day", [offsetDays]
    );
    return rows[0]!.day;
  };

  const invite = async (): Promise<{ tokenHash: string; userId: string; invitationId: string }> => {
    const userId = randomUUID();
    inviteeIds.push(userId);
    const email = await insertUser(userId, 'convidada');
    const invitationId = randomUUID();
    invitationIds.push(invitationId);
    const tokenHash = `hash-${invitationId}`;
    await getOwner().knex('invitations').insert({
      id: invitationId, agency_id: agencyId, purpose: 'collaborator_invite', email, role_id: productionRoleId,
      token_hash: tokenHash, expires_at: new Date(Date.now() + 86_400_000)
    });
    return { tokenHash, userId, invitationId };
  };

  const accept = (invitation: { tokenHash: string; userId: string }, terms: string, privacy: string, record = true) =>
    asUser(invitation.userId, (transaction) =>
      raw<{ rows: Array<{ status: string }> }>(transaction, 'select * from app_private.accept_invitation(?, ?::uuid, ?, ?, ?)', [invitation.tokenHash, invitation.userId, terms, privacy, record]));

  const untouched = async (invitation: { userId: string; invitationId: string }): Promise<void> => {
    expect((await getOwner().knex('invitations').where({ id: invitation.invitationId }).first('used_at'))?.used_at).toBeNull();
    expect(await getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: invitation.userId }).select('id')).toHaveLength(0);
    expect(await getOwner().knex('legal_acceptances').where({ user_id: invitation.userId }).select('id')).toHaveLength(0);
  };

  it.each([
    ['a date that does not exist', '2026-02-30'],
    ['month 99', '2026-99-99'],
    ['no date at all', 'v1'],
    ['a month without its zero', '2026-1-1'],
    ['leading space', ' 2026-01-01'],
    ['trailing space', '2026-01-01 '],
    ['a timestamp', '2026-01-01T00:00:00Z']
  ])('refuses %s in either document, creating nothing', async (_label, version) => {
    const valid = await today();
    for (const [terms, privacy] of [[version, valid], [valid, version]] as const) {
      const invitation = await invite();
      await expect(accept(invitation, terms, privacy), `${terms} / ${privacy}`).rejects.toMatchObject({ code: 'A0031' });
      await untouched(invitation);
    }
  });

  it('refuses a version later than today in São Paulo, and accepts today', async () => {
    const tomorrow = await today(1);
    const valid = await today();
    for (const [terms, privacy] of [[tomorrow, valid], [valid, tomorrow], ['9999-12-31', valid]] as const) {
      const invitation = await invite();
      await expect(accept(invitation, terms, privacy), `${terms} / ${privacy}`).rejects.toMatchObject({ code: 'A0031' });
      await untouched(invitation);
    }

    const invitation = await invite();
    const yesterday = await today(-1);
    await expect(accept(invitation, valid, yesterday)).resolves.toMatchObject({ rows: [{ status: 'accepted' }] });
    expect(await getOwner().knex('legal_acceptances').where({ user_id: invitation.userId }).orderBy('document').select('document', 'version'))
      .toEqual([{ document: 'privacy', version: yesterday }, { document: 'terms', version: valid }]);
  });

  it('still answers a blank version with its own code, before it looks at the date', async () => {
    const invitation = await invite();

    await expect(accept(invitation, await today(), '')).rejects.toMatchObject({ code: 'A0003' });

    await untouched(invitation);
  });

  it('does not look at the versions when the call records no acceptance', async () => {
    const invitation = await invite();

    await expect(accept(invitation, 'not-a-date', 'not-a-date', false)).resolves.toMatchObject({ rows: [{ status: 'accepted' }] });

    expect(await getOwner().knex('legal_acceptances').where({ user_id: invitation.userId }).select('id')).toHaveLength(0);
  });
});
