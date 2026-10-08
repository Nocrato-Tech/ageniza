import { createHash, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type FakeEmailSender,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import type { DatabaseClient } from '@ageniza/database';
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';

// Issue #132: the agency's side of a client's portal access. `invitations_select` lets whoever holds
// `cliente.convidar_usuario` read invitations of every kind of the agency, and `client_memberships_select`
// lets every member of the agency read every link of its clients; neither says which client or which
// kind a route means. Every list below is therefore checked against rows that are readable and
// must not be listed, and every permission is held alone by a custom role.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: FakeEmailSender;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdCustomRoleIds: string[] = [];

const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const clientArchived = randomUUID();
const clientPaged = randomUUID();
const clientBare = randomUUID();

const sessionCookieHeader = (cookiesList: readonly { name: string; value: string }[]): string =>
  cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `access-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const membersUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/members`;
const invitationsUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/invitations`;
const removeUrl = (agencyId: string, clientId: string, membershipId: string): string => `${membersUrl(agencyId, clientId)}/${membershipId}/remove`;
const reactivateUrl = (agencyId: string, clientId: string, membershipId: string): string => `${membersUrl(agencyId, clientId)}/${membershipId}/reactivate`;
const portalClient = (clientId: string): string => `/clients/${clientId}`;

const membershipOf = async (clientId: string, userKey: string): Promise<{ id: string; status: string; updated_at: Date; created_at: Date }> => {
  const row = await owner.knex('client_memberships').where({ client_id: clientId, user_id: users[userKey]!.id }).first();
  if (row === undefined) throw new Error(`No link of ${userKey} to ${clientId}.`);
  return row;
};

const statusOf = async (membershipId: string): Promise<string> =>
  (await owner.knex('client_memberships').where({ id: membershipId }).first('status')).status as string;

const auditCount = async (action: string, targetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action, target_id: targetId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const sessionCount = async (userId: string): Promise<number> =>
  Number((await owner.knex('auth.session').where({ userId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

/**
 * A trigger that makes the DELETE of one person's sessions fail with the given SQLSTATE, as a deadlock or
 * a broken connection would: the proof that ending the sessions and removing the link are one transaction.
 */
const withFailingSessionDelete = async (userId: string, errcode: string, run: () => Promise<void>): Promise<void> => {
  const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await owner.knex.raw(`
    create function public.${name}() returns trigger language plpgsql as $$
    begin
      if old."userId" = '${userId}'::uuid then raise exception 'sessions of this person cannot be deleted' using errcode = '${errcode}'; end if;
      return old;
    end $$;
    create trigger ${name} before delete on auth."session" for each row execute function public.${name}();
  `);
  try {
    await run();
  } finally {
    await owner.knex.raw(`drop trigger if exists ${name} on auth."session"; drop function if exists public.${name}();`);
  }
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000);

interface SeedInvitation {
  readonly id?: string;
  readonly purpose: 'client_invite' | 'collaborator_invite' | 'agency_activation';
  readonly agencyId: string;
  readonly clientId?: string;
  readonly roleId?: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
  readonly revokedAt?: Date;
}

const seedInvitation = async (invitation: SeedInvitation): Promise<string> => {
  const id = invitation.id ?? randomUUID();
  await owner.knex('invitations').insert({
    id,
    agency_id: invitation.agencyId,
    purpose: invitation.purpose,
    email: invitation.email,
    client_id: invitation.clientId ?? null,
    role_id: invitation.roleId ?? null,
    token_hash: hash(`${id}:token`),
    expires_at: invitation.expiresAt,
    used_at: invitation.usedAt ?? null,
    revoked_at: invitation.revokedAt ?? null
  });
  return id;
};

/**
 * An app whose database lets the test change the world just before the statement that calls the
 * membership function runs: the client is archived, the link vanishes or the caller loses the
 * permission between the route's checks and the function, which is what the function's refusal reads as.
 */
const withRacingApp = async <T>(beforeFunction: () => Promise<void>, run: (racingApp: FastifyInstance) => Promise<T>): Promise<T> => {
  const racingApp = Fastify();
  registerClientModule(racingApp, {
    database: {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const racing = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return async (statement: string, bindings?: readonly unknown[]) => {
                  if (statement.trim().startsWith('select app_private.set_client_membership_status')) await beforeFunction();
                  return target.raw(statement, bindings as never);
                };
              }
              return Reflect.get(target, property, receiver);
            }
          });
          return work(racing as typeof transaction);
        })
    } as DatabaseClient,
    auth: app.auth,
    requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
    requirePermission,
    requireClientAccess: createRequireClientAccess({ database: app.database }),
    photoUrlExpirySeconds: 300
  });
  await racingApp.ready();
  try {
    return await run(racingApp);
  } finally {
    await racingApp.close();
  }
};

const postOn = async (target: FastifyInstance, url: string, cookie: string): Promise<Reply> =>
  (await target.inject({ method: 'POST', url, headers: { ...origin, cookie } })) as unknown as Reply;

const MEMBER_KEYS = ['membershipId', 'name', 'email', 'status', 'since'];

describe('CLIENTS portal access, agency side (#132)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });

    await makeUser('admin', 'Adriana Admin');
    await makeUser('manager', 'Marta Gestora');
    await makeUser('production', 'Paulo Produção');
    await makeUser('sales', 'Vera Vendas');
    await makeUser('finance', 'Fábio Financeiro');
    await makeUser('ownerUser', 'Dona da Agência');
    await makeUser('inviteOnly', 'Só Convida');
    await makeUser('removeOnly', 'Só Remove');
    await makeUser('resendCancelOnly', 'Só Reenvia e Cancela');
    await makeUser('collabInviteOnly', 'Só Convida Colaborador');
    await makeUser('racer', 'Admin da Corrida');
    await makeUser('twoAgencies', 'Admin das Duas');
    await makeUser('otherAdmin', 'Admin da Outra');
    await makeUser('alvaro', 'Álvaro Portal');
    await makeUser('ana', 'Ana Portal');
    await makeUser('bruna', 'bruna portal');
    await makeUser('anaMaria', 'Ana Maria Portal');
    await makeUser('anabela', 'Anabela Portal');
    await makeUser('zelia', 'Zélia Portal');
    await makeUser('dual', 'Duda Dupla');
    await makeUser('dualBare', 'Eva Dupla Sem Papel');
    await makeUser('removed', 'Removido Portal');
    await makeUser('portalOther', 'Portal do A2');
    await makeUser('portalB', 'Portal do B1');
    await makeUser('archivedMember', 'Membro do Arquivado');

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Acessos Agency A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Acessos Agency B', owner_user_id: null }
    ]);

    // Custom roles holding ONE permission each: the Admin holds them all and hides a guard with the wrong key.
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdCustomRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };
    const inviteOnlyRole = await customRole('cliente.convidar_usuario');
    const removeOnlyRole = await customRole('cliente.remover_usuario');
    const resendCancelRole = await customRole('convite.reenviar', 'convite.cancelar');
    const collabInviteRole = await customRole('colaborador.convidar');
    const unrelatedRole = await customRole('midia.enviar');

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.production!.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: users.sales!.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: users.finance!.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: inviteOnlyRole },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: removeOnlyRole },
      { agency_id: agencyA, user_id: users.resendCancelOnly!.id, role_id: resendCancelRole },
      { agency_id: agencyA, user_id: users.collabInviteOnly!.id, role_id: collabInviteRole },
      { agency_id: agencyA, user_id: users.racer!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: unrelatedRole }
    ]);

    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Acessos A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Acessos A2 ${clientA2}` },
      { id: clientB1, agency_id: agencyB, name: `Acessos B1 ${clientB1}` },
      { id: clientArchived, agency_id: agencyA, name: `Acessos Arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() },
      { id: clientPaged, agency_id: agencyA, name: `Acessos Paginado ${clientPaged}` },
      { id: clientBare, agency_id: agencyA, name: `Acessos Vazio ${clientBare}` }
    ]);

    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.alvaro!.id },
      { client_id: clientA1, user_id: users.ana!.id },
      { client_id: clientA1, user_id: users.bruna!.id },
      { client_id: clientA1, user_id: users.anaMaria!.id },
      { client_id: clientA1, user_id: users.anabela!.id },
      { client_id: clientA1, user_id: users.zelia!.id },
      { client_id: clientA1, user_id: users.dual!.id },
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.removed!.id },
      { client_id: clientA2, user_id: users.ana!.id },
      { client_id: clientA2, user_id: users.portalOther!.id },
      { client_id: clientB1, user_id: users.portalB!.id },
      { client_id: clientArchived, user_id: users.archivedMember!.id }
    ]);

    // 23 people without a login, for the paging: six share a name, so only the id tie-break orders them.
    for (let index = 1; index <= 23; index += 1) {
      const id = randomUUID();
      createdUserIds.push(id);
      const number = String(index <= 6 ? 1 : index).padStart(2, '0');
      await app.pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)', [id, `Membro ${number}`, `membro-${index}.${id.slice(0, 8)}@access-integration.test`]);
      await owner.knex('client_memberships').insert({ client_id: clientPaged, user_id: id });
    }

    const loginKeys = [
      'admin', 'manager', 'production', 'sales', 'finance', 'ownerUser', 'inviteOnly', 'removeOnly', 'resendCancelOnly',
      'collabInviteOnly', 'racer', 'twoAgencies', 'otherAdmin', 'ana', 'alvaro', 'dual', 'dualBare', 'portalOther'
    ];
    for (const key of loginKeys) cookies[key] = await login(users[key]!);
    // A person whose only link is removed has no context to log in with: it is removed after the logins.
    await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.removed!.id }).update({ status: 'removed' });
  });

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdCustomRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdCustomRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  describe('GET .../members', () => {
    it('lists the active people of the client by name, folded of case and accent, with the name and email of the link', async () => {
      const response = await call('GET', membersUrl(agencyA, clientA1), cookies.admin!);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.data.map((item: { name: string }) => item.name)).toEqual([
        'Álvaro Portal', 'Ana Maria Portal', 'Ana Portal', 'Anabela Portal', 'bruna portal', 'Duda Dupla', 'Eva Dupla Sem Papel', 'Zélia Portal'
      ]);
      expect(body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 8, totalPages: 1 });
      for (const item of body.data) expect(Object.keys(item).sort()).toEqual([...MEMBER_KEYS].sort());

      const ana = await membershipOf(clientA1, 'ana');
      expect(body.data.find((item: { name: string }) => item.name === 'Ana Portal')).toEqual({
        membershipId: ana.id,
        name: 'Ana Portal',
        email: users.ana!.email,
        status: 'active',
        since: new Date(ana.created_at).toISOString()
      });
    });

    it('lists the removed on request, and never mixes the two', async () => {
      const removed = await call('GET', `${membersUrl(agencyA, clientA1)}?status=removed`, cookies.admin!);
      expect(removed.statusCode).toBe(200);
      expect(removed.json().data).toEqual([expect.objectContaining({ name: 'Removido Portal', email: users.removed!.email, status: 'removed' })]);
      expect(removed.json().meta.totalItems).toBe(1);

      const active = (await call('GET', `${membersUrl(agencyA, clientA1)}?status=active`, cookies.admin!)).json();
      expect(active.data.map((item: { name: string }) => item.name)).not.toContain('Removido Portal');
      expect(active.data.every((item: { status: string }) => item.status === 'active')).toBe(true);
    });

    it('lists only the people of the client of the route, although the agency reads every link', async () => {
      const a2 = (await call('GET', membersUrl(agencyA, clientA2), cookies.admin!)).json();
      expect(a2.data.map((item: { name: string }) => item.name)).toEqual(['Ana Portal', 'Portal do A2']);
      const a1Names = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin!)).json().data.map((item: { name: string }) => item.name);
      expect(a1Names).not.toContain('Portal do A2');
      expect(a1Names).not.toContain('Portal do B1');
      expect(a1Names).not.toContain('Membro do Arquivado');
      expect((await call('GET', membersUrl(agencyA, clientBare), cookies.admin!)).json()).toEqual({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    });

    it('pages by twenty with a stable order, limits the page size and refuses what it cannot serve', async () => {
      const first = (await call('GET', membersUrl(agencyA, clientPaged), cookies.admin!)).json();
      const second = (await call('GET', `${membersUrl(agencyA, clientPaged)}?page=2`, cookies.admin!)).json();
      expect(first.data).toHaveLength(20);
      expect(second.data).toHaveLength(3);
      expect(first.meta).toEqual({ page: 1, pageSize: 20, totalItems: 23, totalPages: 2 });
      expect(second.meta).toEqual({ page: 2, pageSize: 20, totalItems: 23, totalPages: 2 });
      const ids = [...first.data, ...second.data].map((item: { membershipId: string }) => item.membershipId);
      expect(new Set(ids).size).toBe(23);
      const names = [...first.data, ...second.data].map((item: { name: string }) => item.name);
      expect(names).toEqual([...names].sort());
      const sameName = first.data.slice(0, 6).map((item: { membershipId: string }) => item.membershipId);
      expect(first.data.slice(0, 6).map((item: { name: string }) => item.name)).toEqual(Array(6).fill('Membro 01'));
      expect(sameName).toEqual([...sameName].sort());

      const all = (await call('GET', `${membersUrl(agencyA, clientPaged)}?pageSize=1000`, cookies.admin!)).json();
      expect(all.meta).toEqual({ page: 1, pageSize: 100, totalItems: 23, totalPages: 1 });
      expect(all.data).toHaveLength(23);

      const beyond = (await call('GET', `${membersUrl(agencyA, clientPaged)}?page=99`, cookies.admin!)).json();
      expect(beyond.data).toEqual([]);
      expect(beyond.meta).toEqual({ page: 99, pageSize: 20, totalItems: 23, totalPages: 2 });

      expect((await call('GET', `${membersUrl(agencyA, clientPaged)}?page=1e20`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${membersUrl(agencyA, clientPaged)}?page=0`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${membersUrl(agencyA, clientPaged)}?status=pending`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${membersUrl(agencyA, clientPaged)}?search=a`, cookies.admin!)).statusCode).toBe(400);
    });

    it('is readable on an archived client, which is read-only and not unreadable', async () => {
      const response = await call('GET', membersUrl(agencyA, clientArchived), cookies.admin!);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((item: { name: string }) => item.name)).toEqual(['Membro do Arquivado']);
    });
  });

  describe('GET .../invitations', () => {
    const emails = {
      soon: 'expira-primeiro@access-integration.test',
      later: 'expira-depois@access-integration.test',
      expired: 'expirado@access-integration.test',
      revoked: 'revogado@access-integration.test',
      used: 'aceito@access-integration.test',
      collaborator: 'colaborador@access-integration.test',
      activation: 'ativacao@access-integration.test',
      otherClient: 'outro-cliente@access-integration.test',
      otherAgency: 'outra-agencia@access-integration.test'
    };
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const productionRole = (await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
      ids.later = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA1, email: emails.later, expiresAt: daysFromNow(5) });
      ids.soon = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA1, email: emails.soon, expiresAt: daysFromNow(2) });
      ids.expired = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA1, email: emails.expired, expiresAt: daysFromNow(-1) });
      ids.revoked = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA1, email: emails.revoked, expiresAt: daysFromNow(3), revokedAt: new Date() });
      ids.used = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA1, email: emails.used, expiresAt: daysFromNow(3), usedAt: new Date() });
      ids.collaborator = await seedInvitation({ purpose: 'collaborator_invite', agencyId: agencyA, roleId: productionRole, email: emails.collaborator, expiresAt: daysFromNow(1) });
      ids.activation = await seedInvitation({ purpose: 'agency_activation', agencyId: agencyA, email: emails.activation, expiresAt: daysFromNow(1) });
      ids.otherClient = await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientA2, email: emails.otherClient, expiresAt: daysFromNow(1) });
      ids.otherAgency = await seedInvitation({ purpose: 'client_invite', agencyId: agencyB, clientId: clientB1, email: emails.otherAgency, expiresAt: daysFromNow(1) });
      // Twenty-two pending on another client, six of them expiring at the same instant.
      const shared = daysFromNow(9);
      for (let index = 1; index <= 22; index += 1) {
        await seedInvitation({ purpose: 'client_invite', agencyId: agencyA, clientId: clientPaged, email: `paginado-${index}@access-integration.test`, expiresAt: index <= 6 ? shared : daysFromNow(10 + index) });
      }
    });

    it('lists only the pending portal invitations of this client, the one that expires first on top', async () => {
      const response = await call('GET', invitationsUrl(agencyA, clientA1), cookies.admin!);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.map((item: { email: string }) => item.email)).toEqual([emails.soon, emails.later]);
      expect(body.data[0]).toEqual({ invitationId: ids.soon, email: emails.soon, expiresAt: expect.any(String) });
      expect(Object.keys(body.data[0]).sort()).toEqual(['email', 'expiresAt', 'invitationId']);
      expect(new Date(body.data[0].expiresAt).getTime()).toBeLessThan(new Date(body.data[1].expiresAt).getTime());
      expect(body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
      expect(JSON.stringify(body)).not.toMatch(/token/i);
    });

    it('never lists a collaborator invitation, an activation or another client\'s, to the people allowed to read them by policy', async () => {
      // The precondition that gives the assertion its meaning: the collaborator invitation is pending and in the agency.
      expect(await owner.knex('invitations').where({ id: ids.collaborator }).first()).toMatchObject({ purpose: 'collaborator_invite', agency_id: agencyA, used_at: null, revoked_at: null });

      for (const key of ['admin', 'inviteOnly', 'ownerUser']) {
        const listed = (await call('GET', invitationsUrl(agencyA, clientA1), cookies[key]!)).json().data.map((item: { email: string }) => item.email);
        expect(listed, key).toEqual([emails.soon, emails.later]);
        for (const hidden of [emails.collaborator, emails.activation, emails.otherClient, emails.otherAgency, emails.expired, emails.revoked, emails.used]) {
          expect(listed, `${key} ${hidden}`).not.toContain(hidden);
        }
      }
      expect((await call('GET', invitationsUrl(agencyA, clientA2), cookies.admin!)).json().data.map((item: { email: string }) => item.email)).toEqual([emails.otherClient]);
      expect((await call('GET', invitationsUrl(agencyA, clientBare), cookies.admin!)).json().data).toEqual([]);
    });

    it('drops an invitation the moment it is revoked, expires or is replaced by a resend, and a cancel removes it', async () => {
      const resend = await call('POST', `/agencies/${agencyA}/invitations/${ids.later}/resend`, cookies.admin!);
      expect(resend.statusCode).toBe(200);
      const resentId = resend.json().invitationId as string;
      expect(resentId).not.toBe(ids.later);
      const afterResend = (await call('GET', invitationsUrl(agencyA, clientA1), cookies.admin!)).json().data;
      expect(afterResend.map((item: { invitationId: string }) => item.invitationId)).toEqual([ids.soon, resentId]);

      const cancel = await call('DELETE', `/agencies/${agencyA}/invitations/${resentId}`, cookies.admin!);
      expect(cancel.statusCode).toBe(204);
      expect((await call('GET', invitationsUrl(agencyA, clientA1), cookies.admin!)).json().data.map((item: { invitationId: string }) => item.invitationId)).toEqual([ids.soon]);

      await owner.knex('invitations').where({ id: ids.soon }).update({ expires_at: daysFromNow(-1) });
      expect((await call('GET', invitationsUrl(agencyA, clientA1), cookies.admin!)).json().data).toEqual([]);
    });

    it('pages by twenty ordered by expiry with the id as the tie-break', async () => {
      const first = (await call('GET', invitationsUrl(agencyA, clientPaged), cookies.admin!)).json();
      const second = (await call('GET', `${invitationsUrl(agencyA, clientPaged)}?page=2`, cookies.admin!)).json();
      expect(first.data).toHaveLength(20);
      expect(second.data).toHaveLength(2);
      expect(first.meta).toEqual({ page: 1, pageSize: 20, totalItems: 22, totalPages: 2 });
      const all = [...first.data, ...second.data] as { invitationId: string; expiresAt: string }[];
      expect(new Set(all.map((item) => item.invitationId)).size).toBe(22);
      const times = all.map((item) => new Date(item.expiresAt).getTime());
      expect(times).toEqual([...times].sort((left, right) => left - right));
      // The six that expire together are in id order.
      const together = all.slice(0, 6).map((item) => item.invitationId);
      expect(new Set(all.slice(0, 6).map((item) => item.expiresAt)).size).toBe(1);
      expect(together).toEqual([...together].sort());

      expect((await call('GET', `${invitationsUrl(agencyA, clientPaged)}?page=1e20`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${invitationsUrl(agencyA, clientPaged)}?status=pending`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${invitationsUrl(agencyA, clientPaged)}?pageSize=500`, cookies.admin!)).json().meta.pageSize).toBe(100);
    });
  });

  describe('authorization', () => {
    const everyRoute = (membershipId: string): { method: 'GET' | 'POST'; url: string; label: string; permission: string }[] => [
      { method: 'GET', url: membersUrl(agencyA, clientA1), label: 'list members', permission: 'cliente.convidar_usuario' },
      { method: 'GET', url: invitationsUrl(agencyA, clientA1), label: 'list invitations', permission: 'cliente.convidar_usuario' },
      { method: 'POST', url: removeUrl(agencyA, clientA1, membershipId), label: 'remove', permission: 'cliente.remover_usuario' },
      { method: 'POST', url: reactivateUrl(agencyA, clientA1, membershipId), label: 'reactivate', permission: 'cliente.remover_usuario' }
    ];

    it('answers 403 on every route to the account manager and to every role without the portal permissions, changing nothing', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const removedLink = await membershipOf(clientA1, 'removed');
      for (const key of ['manager', 'production', 'sales', 'finance', 'resendCancelOnly', 'collabInviteOnly', 'dualBare']) {
        for (const route of everyRoute(ana.id)) {
          const response = await call(route.method, route.url, cookies[key]!);
          expect(response.statusCode, `${key} ${route.label}`).toBe(403);
        }
        const onRemoved = await call('POST', reactivateUrl(agencyA, clientA1, removedLink.id), cookies[key]!);
        expect(onRemoved.statusCode, `${key} reactivate removed`).toBe(403);
      }
      expect(await statusOf(ana.id)).toBe('active');
      expect(await statusOf(removedLink.id)).toBe('removed');
    });

    it('holds the read permission and the change permission apart, each alone', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      // cliente.convidar_usuario alone: reads yes, changes no.
      expect((await call('GET', membersUrl(agencyA, clientA1), cookies.inviteOnly!)).statusCode).toBe(200);
      expect((await call('GET', invitationsUrl(agencyA, clientA1), cookies.inviteOnly!)).statusCode).toBe(200);
      expect((await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.inviteOnly!)).statusCode).toBe(403);
      expect((await call('POST', reactivateUrl(agencyA, clientA1, ana.id), cookies.inviteOnly!)).statusCode).toBe(403);
      expect(await statusOf(ana.id)).toBe('active');

      // cliente.remover_usuario alone: changes yes, reads no.
      expect((await call('GET', membersUrl(agencyA, clientA1), cookies.removeOnly!)).statusCode).toBe(403);
      expect((await call('GET', invitationsUrl(agencyA, clientA1), cookies.removeOnly!)).statusCode).toBe(403);
      const removed = await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.removeOnly!);
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ membershipId: ana.id, status: 'removed' });
      expect(await statusOf(ana.id)).toBe('removed');
      expect(await sessionCount(users.ana!.id)).toBe(0);
      const reactivated = await call('POST', reactivateUrl(agencyA, clientA1, ana.id), cookies.removeOnly!);
      expect(reactivated.statusCode).toBe(200);
      expect(await statusOf(ana.id)).toBe('active');
      cookies.ana = await login(users.ana!);
    });

    it('lets the agency owner, who has no membership row, do everything', async () => {
      expect((await call('GET', membersUrl(agencyA, clientA1), cookies.ownerUser!)).statusCode).toBe(200);
      expect((await call('GET', invitationsUrl(agencyA, clientA1), cookies.ownerUser!)).statusCode).toBe(200);
      const zelia = await membershipOf(clientA1, 'zelia');
      expect((await call('POST', removeUrl(agencyA, clientA1, zelia.id), cookies.ownerUser!)).statusCode).toBe(200);
      expect((await call('POST', reactivateUrl(agencyA, clientA1, zelia.id), cookies.ownerUser!)).statusCode).toBe(200);
    });

    it('answers 401 without a session and 404 to a person of the portal, who is not in the agency', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      for (const route of everyRoute(ana.id)) {
        expect((await call(route.method, route.url)).statusCode, `no session ${route.label}`).toBe(401);
        // The portal person has a link to this very client, and still reads nothing of the agency's side.
        expect((await call(route.method, route.url, cookies.alvaro!)).statusCode, `portal ${route.label}`).toBe(404);
      }
      expect(await statusOf(ana.id)).toBe('active');
    });

    it('takes the status from the route and never from a body', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const removed = await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.admin!, { status: 'active' });
      expect(removed.json()).toMatchObject({ status: 'removed' });
      expect(await statusOf(ana.id)).toBe('removed');
      const reactivated = await call('POST', reactivateUrl(agencyA, clientA1, ana.id), cookies.admin!, { status: 'removed' });
      expect(reactivated.json()).toMatchObject({ status: 'active' });
      expect(await statusOf(ana.id)).toBe('active');
      cookies.ana = await login(users.ana!);
    });
  });

  describe('isolation', () => {
    it('answers the same 404 for a client of another agency, an absent one and a malformed one, on all four routes', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const portalB = await membershipOf(clientB1, 'portalB');
      const targets = [
        { clientId: clientB1, label: 'client of another agency under my agency' },
        { clientId: randomUUID(), label: 'absent client' },
        { clientId: 'not-a-uuid', label: 'malformed client' }
      ];
      for (const target of targets) {
        for (const key of ['admin', 'twoAgencies']) {
          expect((await call('GET', membersUrl(agencyA, target.clientId), cookies[key]!)).statusCode, `${key} members ${target.label}`).toBe(404);
          expect((await call('GET', invitationsUrl(agencyA, target.clientId), cookies[key]!)).statusCode, `${key} invitations ${target.label}`).toBe(404);
          expect((await call('POST', removeUrl(agencyA, target.clientId, ana.id), cookies[key]!)).statusCode, `${key} remove ${target.label}`).toBe(404);
          expect((await call('POST', reactivateUrl(agencyA, target.clientId, ana.id), cookies[key]!)).statusCode, `${key} reactivate ${target.label}`).toBe(404);
        }
      }
      // A person who belongs to both agencies still gets only the agency in the URL.
      expect((await call('GET', membersUrl(agencyB, clientA1), cookies.twoAgencies!)).statusCode).toBe(404);
      expect((await call('GET', invitationsUrl(agencyB, clientA1), cookies.twoAgencies!)).statusCode).toBe(404);
      expect((await call('GET', membersUrl(agencyB, clientB1), cookies.twoAgencies!)).json().data.map((item: { name: string }) => item.name)).toEqual(['Portal do B1']);
      // The admin of another agency reaches nothing of this one.
      expect((await call('GET', membersUrl(agencyA, clientA1), cookies.otherAdmin!)).statusCode).toBe(404);
      expect(await statusOf(ana.id)).toBe('active');
      expect(await statusOf(portalB.id)).toBe('active');
    });

    it('answers 404 for a link of another client, of another agency, a malformed or an absent one, changing nothing', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const otherClient = await membershipOf(clientA2, 'portalOther');
      const otherAgency = await membershipOf(clientB1, 'portalB');
      const anaOnA2 = await membershipOf(clientA2, 'ana');
      for (const [label, membershipId] of [
        ['link of another client of the agency', otherClient.id],
        ['the same person\'s link to another client', anaOnA2.id],
        ['link of another agency', otherAgency.id],
        ['absent link', randomUUID()],
        ['malformed link', 'not-a-uuid']
      ] as const) {
        const removed = await call('POST', removeUrl(agencyA, clientA1, membershipId), cookies.admin!);
        expect(removed.statusCode, `remove ${label}`).toBe(404);
        expect(removed.json().error.code).toBe('NOT_FOUND');
        expect((await call('POST', reactivateUrl(agencyA, clientA1, membershipId), cookies.admin!)).statusCode, `reactivate ${label}`).toBe(404);
      }
      expect(await statusOf(otherClient.id)).toBe('active');
      expect(await statusOf(anaOnA2.id)).toBe('active');
      expect(await statusOf(otherAgency.id)).toBe('active');
      expect(await statusOf(ana.id)).toBe('active');
      expect(await auditCount('client_member.removed', otherClient.id)).toBe(0);
    });
  });

  describe('remove and reactivate', () => {
    it('removes the person at once, only from this client, and brings them back without a new invitation', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const removedAuditBefore = await auditCount('client_member.removed', ana.id);
      const reactivatedAuditBefore = await auditCount('client_member.reactivated', ana.id);
      const invitationsBefore = Number((await owner.knex('invitations').where({ agency_id: agencyA }).count<{ count: string }[]>('id as count'))[0]?.count);
      expect((await call('GET', portalClient(clientA1), cookies.ana!)).statusCode).toBe(200);
      expect((await call('GET', `${portalClient(clientA1)}/brand-study`, cookies.ana!)).statusCode).toBe(200);

      const removed = await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.admin!);
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({
        membershipId: ana.id,
        name: 'Ana Portal',
        email: users.ana!.email,
        status: 'removed',
        since: new Date(ana.created_at).toISOString()
      });
      expect(await statusOf(ana.id)).toBe('removed');
      expect(await auditCount('client_member.removed', ana.id)).toBe(removedAuditBefore + 1);

      // #411: the session is global, so every session of the person ends, the other client included;
      // the next request of the old cookie is a 401, and the remover and the others keep theirs.
      expect(await sessionCount(users.ana!.id)).toBe(0);
      for (const url of [portalClient(clientA1), `${portalClient(clientA1)}/brand-study`, portalClient(clientA2)]) {
        const gone = await call('GET', url, cookies.ana!);
        expect(gone.statusCode, url).toBe(401);
        expect(gone.json().error.code).toBe('UNAUTHENTICATED');
      }
      expect((await call('GET', portalClient(clientA1), cookies.alvaro!)).statusCode).toBe(200);
      const listed = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin!)).json().data.map((item: { name: string }) => item.name);
      expect(listed).not.toContain('Ana Portal');
      expect((await call('GET', `${membersUrl(agencyA, clientA1)}?status=removed`, cookies.admin!)).json().data.map((item: { name: string }) => item.name)).toContain('Ana Portal');

      // Signing in again is allowed: the person has no access to this client, and still has the other one.
      cookies.ana = await login(users.ana!);
      expect((await call('GET', portalClient(clientA1), cookies.ana)).statusCode).toBe(404);
      expect((await call('GET', portalClient(clientA2), cookies.ana)).statusCode).toBe(200);
      const sessionsAfterLogin = await sessionCount(users.ana!.id);
      expect(sessionsAfterLogin).toBe(1);

      const reactivated = await call('POST', reactivateUrl(agencyA, clientA1, ana.id), cookies.admin!);
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json()).toMatchObject({ membershipId: ana.id, status: 'active' });
      expect(await statusOf(ana.id)).toBe('active');
      expect(await auditCount('client_member.reactivated', ana.id)).toBe(reactivatedAuditBefore + 1);
      // Reactivating creates no session and ends none: the session of the new login is the one that serves it.
      expect(await sessionCount(users.ana!.id)).toBe(sessionsAfterLogin);
      expect((await call('GET', portalClient(clientA1), cookies.ana)).statusCode).toBe(200);
      expect(Number((await owner.knex('invitations').where({ agency_id: agencyA }).count<{ count: string }[]>('id as count'))[0]?.count)).toBe(invitationsBefore);
    });

    it('ends every session of the person, however many, and not those of anybody else; repeating the removal ends none more (#411)', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      const second = await login(users.ana!);
      const third = await login(users.ana!);
      expect(await sessionCount(users.ana!.id)).toBeGreaterThanOrEqual(3);
      const othersBefore = await sessionCount(users.alvaro!.id);

      expect((await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.admin!)).statusCode).toBe(200);

      expect(await sessionCount(users.ana!.id)).toBe(0);
      for (const cookie of [cookies.ana!, second, third]) expect((await call('GET', portalClient(clientA2), cookie)).statusCode).toBe(401);
      expect(await sessionCount(users.alvaro!.id)).toBe(othersBefore);
      expect((await call('GET', portalClient(clientA1), cookies.alvaro!)).statusCode).toBe(200);

      // A session opened after the removal is not ended by repeating it: only the transition does.
      const reopened = await login(users.ana!);
      const repeated = await call('POST', removeUrl(agencyA, clientA1, ana.id), cookies.admin!);
      expect(repeated.statusCode).toBe(200);
      expect(await sessionCount(users.ana!.id)).toBe(1);
      expect((await call('GET', portalClient(clientA2), reopened)).statusCode).toBe(200);

      expect((await call('POST', reactivateUrl(agencyA, clientA1, ana.id), cookies.admin!)).statusCode).toBe(200);
      expect(await sessionCount(users.ana!.id)).toBe(1);
      cookies.ana = reopened;
    });

    it('does not end the session of whoever removes, not even when they remove their own portal link (#411)', async () => {
      const own = await owner.knex('client_memberships').insert({ client_id: clientA1, user_id: users.removeOnly!.id }).returning('id');
      const ownId = own[0].id as string;
      try {
        const otherDevice = await login(users.removeOnly!);
        const before = await sessionCount(users.removeOnly!.id);
        expect(before).toBeGreaterThanOrEqual(2);

        const removed = await call('POST', removeUrl(agencyA, clientA1, ownId), cookies.removeOnly!);
        expect(removed.statusCode).toBe(200);
        expect(await statusOf(ownId)).toBe('removed');

        // The current session survives and keeps working; the others of the same person are gone.
        expect((await call('GET', '/me/contexts', cookies.removeOnly!)).statusCode).toBe(200);
        expect(await sessionCount(users.removeOnly!.id)).toBe(1);
        expect((await call('GET', '/me/contexts', otherDevice)).statusCode).toBe(401);
      } finally {
        await owner.knex('client_memberships').where({ id: ownId }).delete();
      }
    });

    it('removes the client link of a collaborator without touching their place in the agency, but ends their sessions (#411)', async () => {
      const dual = await membershipOf(clientA1, 'dual');
      expect((await call('GET', portalClient(clientA1), cookies.dual!)).statusCode).toBe(200);
      expect((await call('POST', removeUrl(agencyA, clientA1, dual.id), cookies.admin!)).statusCode).toBe(200);
      try {
        // The session is global: the portal link ends it for the agency workspace too.
        expect((await call('GET', portalClient(clientA1), cookies.dual!)).statusCode).toBe(401);
        expect((await call('GET', `/agencies/${agencyA}/clients/${clientA1}`, cookies.dual!)).statusCode).toBe(401);
        expect(await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.dual!.id }).first('status')).toEqual({ status: 'active' });
        // After signing in again they work as a collaborator; the portal of this client is closed.
        cookies.dual = await login(users.dual!);
        expect((await call('GET', `/agencies/${agencyA}/clients/${clientA1}`, cookies.dual)).statusCode).toBe(200);
        expect((await call('GET', portalClient(clientA1), cookies.dual)).statusCode).toBe(404);
      } finally {
        await call('POST', reactivateUrl(agencyA, clientA1, dual.id), cookies.admin!);
      }
      expect((await call('GET', portalClient(clientA1), cookies.dual!)).statusCode).toBe(200);
    });

    it.each([['40P01', 409, 'TRY_AGAIN'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
      'ending the sessions is part of the removal: when it fails (%s) the link stays active, the sessions stay, nothing is audited, and repeating works (#411)',
      async (errcode, status, code) => {
        const maria = await membershipOf(clientA1, 'anaMaria');
        const cookie = await login(users.anaMaria!);
        const second = await login(users.anaMaria!);
        const sessions = await sessionCount(users.anaMaria!.id);
        expect(sessions).toBeGreaterThanOrEqual(2);
        const removedEvents = await auditCount('client_member.removed', maria.id);
        const before = await membershipOf(clientA1, 'anaMaria');

        await withFailingSessionDelete(users.anaMaria!.id, errcode, async () => {
          const failed = await call('POST', removeUrl(agencyA, clientA1, maria.id), cookies.admin!);
          expect(failed.statusCode).toBe(status);
          expect(failed.json().error.code).toBe(code);
        });

        expect(await statusOf(maria.id)).toBe('active');
        expect(new Date((await membershipOf(clientA1, 'anaMaria')).updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
        expect(await auditCount('client_member.removed', maria.id)).toBe(removedEvents);
        expect(await sessionCount(users.anaMaria!.id)).toBe(sessions);
        for (const each of [cookie, second]) expect((await call('GET', portalClient(clientA1), each)).statusCode).toBe(200);

        expect((await call('POST', removeUrl(agencyA, clientA1, maria.id), cookies.admin!)).statusCode).toBe(200);
        expect(await auditCount('client_member.removed', maria.id)).toBe(removedEvents + 1);
        expect(await sessionCount(users.anaMaria!.id)).toBe(0);
        expect((await call('POST', reactivateUrl(agencyA, clientA1, maria.id), cookies.admin!)).statusCode).toBe(200);
      }
    );

    it('a reactivation that lands between the route\'s reading and the function still ends the sessions: the transaction decides by what it wrote (#411)', async () => {
      const ana = await membershipOf(clientA1, 'ana');
      // Ana is removed from this client and still works in the other one, with a session.
      await owner.knex('client_memberships').where({ id: ana.id }).update({ status: 'removed' });
      const sessionsBefore = await sessionCount(users.ana!.id);
      expect(sessionsBefore).toBeGreaterThanOrEqual(1);
      const removedEvents = await auditCount('client_member.removed', ana.id);
      try {
        // The route reads the link as removed; a reactivation commits before the function runs; the
        // function then finds it active, removes it and audits it.
        const response = await withRacingApp(
          async () => { await owner.knex('client_memberships').where({ id: ana.id }).update({ status: 'active' }); },
          (racingApp) => postOn(racingApp, removeUrl(agencyA, clientA1, ana.id), cookies.admin!)
        );
        expect(response.statusCode).toBe(200);
        expect(await statusOf(ana.id)).toBe('removed');
        expect(await auditCount('client_member.removed', ana.id)).toBe(removedEvents + 1);
        expect(await sessionCount(users.ana!.id)).toBe(0);
        expect((await call('GET', portalClient(clientA2), cookies.ana!)).statusCode).toBe(401);
      } finally {
        await owner.knex('client_memberships').where({ id: ana.id }).update({ status: 'active' });
        cookies.ana = await login(users.ana!);
      }
    });

    it('is idempotent: repeating a removal or a reactivation answers the link as it is and writes nothing', async () => {
      const bruna = await membershipOf(clientA1, 'bruna');
      const first = await call('POST', removeUrl(agencyA, clientA1, bruna.id), cookies.admin!);
      expect(first.statusCode).toBe(200);
      const afterFirst = await membershipOf(clientA1, 'bruna');
      const second = await call('POST', removeUrl(agencyA, clientA1, bruna.id), cookies.admin!);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(new Date((await membershipOf(clientA1, 'bruna')).updated_at).getTime()).toBe(new Date(afterFirst.updated_at).getTime());
      expect(await auditCount('client_member.removed', bruna.id)).toBe(1);

      expect((await call('POST', reactivateUrl(agencyA, clientA1, bruna.id), cookies.admin!)).statusCode).toBe(200);
      const again = await call('POST', reactivateUrl(agencyA, clientA1, bruna.id), cookies.admin!);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: 'active' });
      expect(await auditCount('client_member.reactivated', bruna.id)).toBe(1);
    });

    it('answers 409 on an archived client, for both routes, and changes nothing', async () => {
      const member = await membershipOf(clientArchived, 'archivedMember');
      const removed = await call('POST', removeUrl(agencyA, clientArchived, member.id), cookies.admin!);
      expect(removed.statusCode).toBe(409);
      expect(removed.json().error.code).toBe('CLIENT_ARCHIVED');
      expect((await call('POST', reactivateUrl(agencyA, clientArchived, member.id), cookies.admin!)).statusCode).toBe(409);
      expect(await statusOf(member.id)).toBe('active');
      expect(await auditCount('client_member.removed', member.id)).toBe(0);

      // A removed link of an archived client cannot come back either: the only action there is to reactivate the client.
      await owner.knex('client_memberships').where({ id: member.id }).update({ status: 'removed' });
      try {
        expect((await call('POST', reactivateUrl(agencyA, clientArchived, member.id), cookies.admin!)).statusCode).toBe(409);
        expect(await statusOf(member.id)).toBe('removed');
      } finally {
        await owner.knex('client_memberships').where({ id: member.id }).update({ status: 'active' });
      }
    });

    it('answers what the function refused when the world changed after the route\'s checks', async () => {
      const racing = await membershipOf(clientA1, 'zelia');

      // The client is archived in between: 409, as the route would have answered a moment later.
      await withRacingApp(async () => { await owner.knex('clients').where({ id: clientA1 }).update({ status: 'archived', archived_at: new Date() }); }, async (racingApp) => {
        const response = await postOn(racingApp, removeUrl(agencyA, clientA1, racing.id), cookies.racer!);
        expect(response.statusCode).toBe(409);
        expect(response.json().message).toMatch(/arquivado/);
      });
      await owner.knex('clients').where({ id: clientA1 }).update({ status: 'active', archived_at: null });
      expect(await statusOf(racing.id)).toBe('active');

      // The link vanishes in between: 404.
      const target = await membershipOf(clientA1, 'removed');
      await withRacingApp(async () => { await owner.knex('client_memberships').where({ id: target.id }).delete(); }, async (racingApp) => {
        const response = await postOn(racingApp, reactivateUrl(agencyA, clientA1, target.id), cookies.racer!);
        expect(response.statusCode).toBe(404);
        expect(response.json().message).toBe('Member not found.');
      });
      await owner.knex('client_memberships').insert({ id: target.id, client_id: clientA1, user_id: users.removed!.id, status: 'removed', created_at: target.created_at });

      // The caller loses the permission in between: 403.
      const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
      const adminRole = roles.find((role) => role.key === 'admin')!.id as string;
      const productionRole = roles.find((role) => role.key === 'production')!.id as string;
      await withRacingApp(async () => { await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.racer!.id }).update({ role_id: productionRole }); }, async (racingApp) => {
        const response = await postOn(racingApp, removeUrl(agencyA, clientA1, racing.id), cookies.racer!);
        expect(response.statusCode).toBe(403);
      });
      await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.racer!.id }).update({ role_id: adminRole });
      expect(await statusOf(racing.id)).toBe('active');
    });
  });

  describe('POST .../invitations on an archived client', () => {
    it('answers 409 and neither stores an invitation nor sends an e-mail', async () => {
      const email = `convite-arquivado@access-integration.test`;
      await app.emailService.drain();
      const sentBefore = sender.sent.length;
      const response = await call('POST', invitationsUrl(agencyA, clientArchived), cookies.admin!, { email });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
      await app.emailService.drain();
      expect(sender.sent.length).toBe(sentBefore);
      expect(await owner.knex('invitations').where({ client_id: clientArchived }).first()).toBeUndefined();
    });

    it('still answers 404, and not 409, for an archived client of another agency', async () => {
      await owner.knex('clients').where({ id: clientB1 }).update({ status: 'archived', archived_at: new Date() });
      try {
        const response = await call('POST', invitationsUrl(agencyA, clientB1), cookies.twoAgencies!, { email: 'x@access-integration.test' });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('NOT_FOUND');
      } finally {
        await owner.knex('clients').where({ id: clientB1 }).update({ status: 'active', archived_at: null });
      }
    });

    it('invites normally once the client is active, and the invitation then shows in the list', async () => {
      const email = `convite-normal@access-integration.test`;
      const response = await call('POST', invitationsUrl(agencyA, clientBare), cookies.admin!, { email });
      expect(response.statusCode).toBe(201);
      const listed = (await call('GET', invitationsUrl(agencyA, clientBare), cookies.admin!)).json().data;
      expect(listed).toEqual([{ invitationId: response.json().invitationId, email, expiresAt: response.json().expiresAt }]);
    });
  });
});
