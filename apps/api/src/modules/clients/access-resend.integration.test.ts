import { randomUUID } from 'node:crypto';

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
import { createInvitationToken, hashInvitationToken } from '../invitations/tokens.js';

// Decision 2026-10-27, "acessos pendentes na aba Acessos podem ser reenviados e removidos": Reenviar e-mail (a person added who has not
// entered) and Reenviar (an old portal invitation, which becomes the access of its address). Every permission is held alone by a
// custom role; every list below has two rows or more, so an action that lands on the wrong row is seen in the e-mail that went out and
// in the row that changed.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: FakeEmailSender;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencyC = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB1 = randomUUID();
const clientC1 = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const membersUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/members`;
const resendAccessUrl = (agencyId: string, clientId: string, accessId: string): string => `${membersUrl(agencyId, clientId)}/${accessId}/resend`;
const resendInvitationUrl = (agencyId: string, clientId: string, invitationId: string): string =>
  `/agencies/${agencyId}/clients/${clientId}/invitations/${invitationId}/resend`;

const freshEmail = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@access-resend.test`;
const sessionCount = async (userId: string): Promise<number> =>
  Number((await owner.knex('auth.session').where({ userId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const auditCount = async (action: string, targetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action, target_id: targetId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const makeUser = async (key: string, name: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `ar-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

const welcomes = async (to: string) => {
  await app.emailService.drain();
  return sender.sent.filter((message) => message.to === to && message.template === 'client-portal-welcome');
};

/** An access nobody has entered, as "Adicionar pessoa" leaves it, but with no event, so the minute of the person is free. */
const seedAccess = async (clientId: string, email = freshEmail('pessoa')): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  await owner.knex('client_portal_accesses').insert({ id, client_id: clientId, email });
  return { id, email };
};

const accessRow = (id: string) => owner.knex('client_portal_accesses').where({ id }).first();

const seedInvitation = async (
  clientId: string,
  email: string,
  extra: Record<string, unknown> = {},
  agencyId = agencyA
): Promise<{ id: string; token: string }> => {
  const id = randomUUID();
  const created = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
  await owner.knex('invitations').insert({
    id, agency_id: agencyId, purpose: 'client_invite', email, client_id: clientId, token_hash: created.tokenHash,
    expires_at: new Date(Date.now() + 5 * 86_400_000), ...extra
  });
  return { id, token: created.token };
};
const invitationRow = (id: string) => owner.knex('invitations').where({ id }).first('used_at', 'revoked_at');
const PENDING = { used_at: null, revoked_at: null };

const expire = (): Promise<number> => owner.knex('agencies').where({ id: agencyA }).update({
  plan: 'trial', trial_ends_at: owner.knex.raw("now() - interval '1 minute'"), trial_owner_email_key: owner.knex.raw('coalesce(trial_owner_email_key, id::text)')
});
const renew = (): Promise<number> => owner.knex('agencies').where({ id: agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });

describe('CLIENTS Reenviar e-mail and Reenviar convite, agency side', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['manager', 'Marta Gestora'], ['inviteOnly', 'Só Convida'], ['removeOnly', 'Só Remove'],
      ['resendCancelOnly', 'Só Reenvia e Cancela'], ['dualBare', 'Duda Dupla Sem Papel'], ['otherAdmin', 'Admin da Outra'], ['limitAdmin', 'Admin do Limite']
    ] as const) await makeUser(key, name);

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => roles.find((candidate) => candidate.key === key)!.id as string;
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Reenvio Agência A', owner_user_id: null },
      { id: agencyB, name: 'Reenvio Agência B', owner_user_id: null },
      { id: agencyC, name: 'Reenvio Agência C', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: await customRole('cliente.convidar_usuario') },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: await customRole('cliente.remover_usuario') },
      { agency_id: agencyA, user_id: users.resendCancelOnly!.id, role_id: await customRole('convite.reenviar', 'convite.cancelar') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyC, user_id: users.limitAdmin!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: 'Padaria Central <A1>' },
      { id: clientA2, agency_id: agencyA, name: 'Outro Cliente A2' },
      { id: clientArchived, agency_id: agencyA, name: 'Cliente Arquivado', status: 'archived', archived_at: new Date() },
      { id: clientB1, agency_id: agencyB, name: 'Cliente B1' },
      { id: clientC1, agency_id: agencyC, name: 'Cliente C1' }
    ]);
    for (const key of ['admin', 'manager', 'inviteOnly', 'removeOnly', 'resendCancelOnly', 'dualBare', 'otherAdmin', 'limitAdmin']) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB, agencyC];
    const clientIds = [clientA1, clientA2, clientArchived, clientB1, clientC1];
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  describe('POST .../members/:accessId/resend (Reenviar e-mail)', () => {
    it('sends the welcome e-mail to the address of THAT row, answers the person, and changes nothing in the access', async () => {
      const first = await seedAccess(clientA1);
      const second = await seedAccess(clientA1);
      const before = await accessRow(second.id);

      const response = await call('POST', resendAccessUrl(agencyA, clientA1, second.id), cookies.admin);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accessId: second.id, name: null, email: second.email, status: 'active', entered: false, since: new Date(before.created_at).toISOString() });
      expect(await welcomes(second.email)).toHaveLength(1);
      expect(await welcomes(first.email)).toHaveLength(0);
      expect(await auditCount('client_member.resent', second.id)).toBe(1);
      expect(await auditCount('client_member.resent', first.id)).toBe(0);
      expect(await accessRow(second.id)).toEqual(before);
    });

    it('names the agency and the client in the e-mail', async () => {
      const person = await seedAccess(clientA1);
      await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin);
      const [message] = await welcomes(person.email);
      expect(JSON.stringify(message)).toContain('Reenvio Agência A');
      expect(JSON.stringify(message)).toContain('Padaria Central');
    });

    it('answers 409 ACCESS_NOT_PENDING to a person who already entered, sends nothing and writes nothing', async () => {
      const account = await makeUser(`entered${randomUUID().slice(0, 6)}`, 'Pessoa que Entrou');
      await owner.knex('client_memberships').insert({ client_id: clientA1, user_id: account.id });
      const access = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: account.id }).first();
      expect(access.first_entered_at).not.toBeNull();

      const response = await call('POST', resendAccessUrl(agencyA, clientA1, access.id), cookies.admin);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('ACCESS_NOT_PENDING');
      expect(await welcomes(access.email)).toHaveLength(0);
      expect(await auditCount('client_member.resent', access.id)).toBe(0);
    });

    it('answers 409 ACCESS_NOT_PENDING to a removed person, sends nothing and writes nothing', async () => {
      const person = await seedAccess(clientA1);
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${person.id}/remove`, cookies.admin)).statusCode).toBe(200);
      const response = await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('ACCESS_NOT_PENDING');
      expect(await welcomes(person.email)).toHaveLength(0);
      expect(await auditCount('client_member.resent', person.id)).toBe(0);
    });

    it('answers 429 RESEND_TOO_SOON to a second resend within the minute, and sends only the first e-mail', async () => {
      const person = await seedAccess(clientA1);
      const other = await seedAccess(clientA1);
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin)).statusCode).toBe(200);
      const again = await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin);
      expect(again.statusCode).toBe(429);
      expect(again.json().error.code).toBe('RESEND_TOO_SOON');
      expect(await welcomes(person.email)).toHaveLength(1);
      expect(await auditCount('client_member.resent', person.id)).toBe(1);
      // The minute is of the person, not of the client.
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, other.id), cookies.admin)).statusCode).toBe(200);
      // Once the minute is over the same person is mailed again.
      await owner.knex('audit.events').where({ target_id: person.id }).update({ occurred_at: owner.knex.raw("now() - interval '61 seconds'") });
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin)).statusCode).toBe(200);
      expect(await welcomes(person.email)).toHaveLength(2);
    });

    it('answers 409 AGENCY_READ_ONLY in a read-only agency, sending nothing, and works again once it renews', async () => {
      const person = await seedAccess(clientA1);
      await expire();
      try {
        const response = await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin);
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('AGENCY_READ_ONLY');
        expect(await welcomes(person.email)).toHaveLength(0);
        expect(await auditCount('client_member.resent', person.id)).toBe(0);
      } finally {
        await renew();
      }
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.admin)).statusCode).toBe(200);
    });

    it('answers 429 DAILY_EMAIL_LIMIT past the limit of the agency, sending nothing and writing nothing', async () => {
      const first = await seedAccess(clientC1);
      const second = await seedAccess(clientC1);
      await owner.knex('agencies').where({ id: agencyC }).update({ daily_email_limit: 1 });
      try {
        expect((await call('POST', resendAccessUrl(agencyC, clientC1, first.id), cookies.limitAdmin)).statusCode).toBe(200);
        const refused = await call('POST', resendAccessUrl(agencyC, clientC1, second.id), cookies.limitAdmin);
        expect(refused.statusCode).toBe(429);
        expect(refused.json().error.code).toBe('DAILY_EMAIL_LIMIT');
        expect(await welcomes(second.email)).toHaveLength(0);
        expect(await auditCount('client_member.resent', second.id)).toBe(0);
        // Adicionar pessoa is in the same budget.
        const add = await call('POST', membersUrl(agencyC, clientC1), cookies.limitAdmin, { email: freshEmail('nova') });
        expect(add.statusCode).toBe(429);
      } finally {
        await owner.knex('agencies').where({ id: agencyC }).update({ daily_email_limit: null });
      }
    });

    it('keeps the place spent and says 502 when the e-mail cannot be delivered', async () => {
      const failing = await buildTestApp({ sender: createFakeEmailSender(async () => { throw new Error('smtp is down'); }) });
      try {
        const person = await seedAccess(clientA1);
        const login502 = await failing.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users.admin!.email, password: users.admin!.password } });
        const cookie = login502.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
        const response = await failing.app.inject({ method: 'POST', url: resendAccessUrl(agencyA, clientA1, person.id), headers: { ...origin, cookie } });
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(await auditCount('client_member.resent', person.id)).toBe(1);
        expect(await accessRow(person.id)).toMatchObject({ status: 'active' });
      } finally {
        await failing.close();
      }
    });

    it('answers 409 CLIENT_ARCHIVED on an archived client', async () => {
      const person = await seedAccess(clientArchived);
      const response = await call('POST', resendAccessUrl(agencyA, clientArchived, person.id), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
      expect(await welcomes(person.email)).toHaveLength(0);
    });

    it('asks cliente.convidar_usuario: held alone it resends, and no other permission of the portal does', async () => {
      const person = await seedAccess(clientA1);
      for (const key of ['removeOnly', 'resendCancelOnly', 'manager']) {
        const refused = await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies[key]);
        expect(refused.statusCode, key).toBe(403);
      }
      expect(await welcomes(person.email)).toHaveLength(0);
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.inviteOnly)).statusCode).toBe(200);
      expect(await welcomes(person.email)).toHaveLength(1);
    });

    it('answers 401 without a session and refuses a cross-site request', async () => {
      const person = await seedAccess(clientA1);
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id))).statusCode).toBe(401);
      const crossSite = await app.app.inject({ method: 'POST', url: resendAccessUrl(agencyA, clientA1, person.id), headers: { origin: 'https://evil.example', cookie: cookies.admin! } });
      expect(crossSite.statusCode).toBe(403);
      expect(await welcomes(person.email)).toHaveLength(0);
    });

    it('answers the same 404 for an access of another client, of another agency, a malformed and an absent one', async () => {
      const ofA2 = await seedAccess(clientA2);
      const ofB1 = await seedAccess(clientB1);
      const targets: Array<[string, string, string]> = [
        [agencyA, clientA1, ofA2.id],
        [agencyA, clientA1, ofB1.id],
        [agencyA, clientB1, ofB1.id],
        [agencyA, clientA1, 'not-a-uuid'],
        [agencyA, clientA1, randomUUID()],
        [agencyA, randomUUID(), ofA2.id]
      ];
      for (const [agencyId, clientId, accessId] of targets) {
        const response = await call('POST', resendAccessUrl(agencyId, clientId, accessId), cookies.admin);
        expect(response.statusCode, `${clientId} ${accessId}`).toBe(404);
      }
      // The admin of another agency gets the same answer for the real ones.
      expect((await call('POST', resendAccessUrl(agencyA, clientA2, ofA2.id), cookies.otherAdmin)).statusCode).toBe(404);
      expect((await call('POST', resendAccessUrl(agencyB, clientA2, ofA2.id), cookies.otherAdmin)).statusCode).toBe(404);
      expect(await welcomes(ofA2.email)).toHaveLength(0);
      expect(await welcomes(ofB1.email)).toHaveLength(0);
      expect(await auditCount('client_member.resent', ofA2.id)).toBe(0);
    });

    it('is not a resend for a person of the portal who has no role in the agency', async () => {
      const person = await seedAccess(clientA1);
      expect((await call('POST', resendAccessUrl(agencyA, clientA1, person.id), cookies.dualBare)).statusCode).toBe(403);
    });
  });

  describe('POST .../invitations/:invitationId/resend (Reenviar convite antigo)', () => {
    it('turns THAT invitation into the access of its address, sends the welcome e-mail, revokes the invitation and kills its link', async () => {
      const first = await seedInvitation(clientA1, freshEmail('convite-um'));
      const second = await seedInvitation(clientA1, freshEmail('convite-dois'));
      const secondEmail = (await owner.knex('invitations').where({ id: second.id }).first('email')).email as string;
      const firstEmail = (await owner.knex('invitations').where({ id: first.id }).first('email')).email as string;
      expect((await call('GET', `/invitations/${second.token}`)).statusCode).toBe(200);

      const response = await call('POST', resendInvitationUrl(agencyA, clientA1, second.id), cookies.admin);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ email: secondEmail, status: 'active', entered: false, name: null });
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email: secondEmail }).first('status')).toEqual({ status: 'active' });
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email: firstEmail }).first()).toBeUndefined();
      expect((await invitationRow(second.id)).revoked_at).toBeInstanceOf(Date);
      expect(await invitationRow(first.id)).toEqual(PENDING);
      expect(await welcomes(secondEmail)).toHaveLength(1);
      expect(await welcomes(firstEmail)).toHaveLength(0);
      expect(await auditCount('invitation.revoked', second.id)).toBe(1);
      const gone = await call('GET', `/invitations/${second.token}`);
      expect(gone.statusCode).toBe(410);
      expect((await call('GET', `/invitations/${first.token}`)).statusCode).toBe(200);
    });

    it('answers 409 ACCESS_EXISTS when the address already has the access, and leaves the invitation pending, with no e-mail', async () => {
      const person = await seedAccess(clientA1);
      const old = await seedInvitation(clientA1, person.email);
      const response = await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('ACCESS_EXISTS');
      expect(await invitationRow(old.id)).toEqual(PENDING);
      expect(await welcomes(person.email)).toHaveLength(0);
    });

    it('answers 409 INVITATION_NOT_PENDING, not ACCESS_EXISTS, when the acceptance of that very invitation wins the race', async () => {
      const account = await makeUser(`acceptor${randomUUID().slice(0, 6)}`, 'Conta que Aceita');
      const old = await seedInvitation(clientA1, account.email);
      // The acceptance has the invitation locked and its access written, but not committed: the conversion starts, passes the
      // check of the invitation, and waits on the access that is being born.
      const acceptance = await owner.knex.transaction();
      try {
        await acceptance.raw('select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', [hashInvitationToken(old.token), account.id]);
        const response = call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.admin);
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const blocked = await owner.knex.raw(
            "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%convert_client_portal_invitation%'"
          );
          waiting = blocked.rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
        await acceptance.commit();

        const answered = await response;
        expect(answered.statusCode).toBe(409);
        expect(answered.json().error.code).toBe('INVITATION_NOT_PENDING');
      } finally {
        if (!acceptance.isCompleted()) await acceptance.rollback();
      }
      expect(await invitationRow(old.id)).toMatchObject({ used_at: expect.any(Date), revoked_at: null });
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email: account.email }).count<{ count: string }[]>('id as count')).toEqual([{ count: '1' }]);
      expect(await welcomes(account.email)).toHaveLength(0);
    });

    it('answers 409 INVITATION_NOT_PENDING to an invitation that was used, revoked or expired, and gives no access', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['used', { used_at: new Date() }],
        ['revoked', { revoked_at: new Date() }],
        ['expired', { expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 86_400_000) }]
      ];
      for (const [label, extra] of cases) {
        const email = freshEmail(label);
        const old = await seedInvitation(clientA1, email, extra);
        const response = await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.admin);
        expect(response.statusCode, label).toBe(409);
        expect(response.json().error.code, label).toBe('INVITATION_NOT_PENDING');
        expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email }).first(), label).toBeUndefined();
      }
    });

    it('answers 409 AGENCY_READ_ONLY in a read-only agency, leaving the invitation pending', async () => {
      const email = freshEmail('somente-leitura');
      const old = await seedInvitation(clientA1, email);
      await expire();
      try {
        const response = await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.admin);
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('AGENCY_READ_ONLY');
      } finally {
        await renew();
      }
      expect(await invitationRow(old.id)).toEqual(PENDING);
      expect(await welcomes(email)).toHaveLength(0);
      // Cancelar, which narrows reach, is still allowed by the existing route; here the conversion works again after the renewal.
      expect((await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.admin)).statusCode).toBe(200);
    });

    it('answers 429 DAILY_EMAIL_LIMIT past the limit, leaving the invitation pending and giving no access', async () => {
      const email = freshEmail('limite');
      const old = await seedInvitation(clientC1, email, {}, agencyC);
      const used = Number((await owner.knex('invitations').where({ agency_id: agencyC }).count<{ count: string }[]>('id as count'))[0]!.count);
      await owner.knex('agencies').where({ id: agencyC }).update({ daily_email_limit: used });
      try {
        const response = await call('POST', resendInvitationUrl(agencyC, clientC1, old.id), cookies.limitAdmin);
        expect(response.statusCode).toBe(429);
        expect(response.json().error.code).toBe('DAILY_EMAIL_LIMIT');
        expect(await invitationRow(old.id)).toEqual(PENDING);
        expect(await owner.knex('client_portal_accesses').where({ client_id: clientC1, email }).first()).toBeUndefined();
        expect(await welcomes(email)).toHaveLength(0);
      } finally {
        await owner.knex('agencies').where({ id: agencyC }).update({ daily_email_limit: null });
      }
    });

    it('keeps the access and the revocation, and says 502, when the e-mail cannot be delivered', async () => {
      const failing = await buildTestApp({ sender: createFakeEmailSender(async () => { throw new Error('smtp is down'); }) });
      try {
        const email = freshEmail('smtp');
        const old = await seedInvitation(clientA1, email);
        const loginResponse = await failing.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users.admin!.email, password: users.admin!.password } });
        const cookie = loginResponse.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
        const response = await failing.app.inject({ method: 'POST', url: resendInvitationUrl(agencyA, clientA1, old.id), headers: { ...origin, cookie } });
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email }).first('status')).toEqual({ status: 'active' });
        expect((await invitationRow(old.id)).revoked_at).toBeInstanceOf(Date);
      } finally {
        await failing.close();
      }
    });

    it('answers 409 CLIENT_ARCHIVED on an archived client', async () => {
      const response = await call('POST', resendInvitationUrl(agencyA, clientArchived, randomUUID()), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
    });

    it('asks cliente.convidar_usuario, which gives the access: convite.reenviar with convite.cancelar and cliente.remover_usuario are 403', async () => {
      const email = freshEmail('permissao');
      const old = await seedInvitation(clientA1, email);
      for (const key of ['removeOnly', 'resendCancelOnly', 'manager', 'dualBare']) {
        const refused = await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies[key]);
        expect(refused.statusCode, key).toBe(403);
      }
      expect(await invitationRow(old.id)).toEqual(PENDING);
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email }).first()).toBeUndefined();
      expect((await call('POST', resendInvitationUrl(agencyA, clientA1, old.id), cookies.inviteOnly)).statusCode).toBe(200);
    });

    it('answers 401 without a session', async () => {
      const old = await seedInvitation(clientA1, freshEmail('sem-sessao'));
      expect((await call('POST', resendInvitationUrl(agencyA, clientA1, old.id))).statusCode).toBe(401);
      expect(await invitationRow(old.id)).toEqual(PENDING);
    });

    it('answers the same 404 for an invitation of another client, of a collaborator, of another agency, malformed or absent', async () => {
      const ofA2 = await seedInvitation(clientA2, freshEmail('do-a2'));
      const ofB1 = await seedInvitation(clientB1, freshEmail('do-b1'), {}, agencyB);
      const collaborator = randomUUID();
      await owner.knex('invitations').insert({
        id: collaborator, agency_id: agencyA, purpose: 'collaborator_invite', email: freshEmail('colaborador'),
        role_id: (await owner.knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id')).id,
        token_hash: createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL }).tokenHash, expires_at: new Date(Date.now() + 86_400_000)
      });
      const targets: Array<[string, string, string]> = [
        [agencyA, clientA1, ofA2.id],
        [agencyA, clientA1, ofB1.id],
        [agencyA, clientA1, collaborator],
        [agencyA, clientA1, 'not-a-uuid'],
        [agencyA, clientA1, randomUUID()],
        [agencyA, clientB1, ofB1.id]
      ];
      for (const [agencyId, clientId, invitationId] of targets) {
        const response = await call('POST', resendInvitationUrl(agencyId, clientId, invitationId), cookies.admin);
        expect(response.statusCode, `${clientId} ${invitationId}`).toBe(404);
      }
      expect((await call('POST', resendInvitationUrl(agencyA, clientA2, ofA2.id), cookies.otherAdmin)).statusCode).toBe(404);
      expect(await invitationRow(ofA2.id)).toEqual(PENDING);
      expect(await invitationRow(ofB1.id)).toEqual(PENDING);
      expect(await invitationRow(collaborator)).toEqual(PENDING);
    });

    it('still answers 409 PORTAL_INVITATION_DISCONTINUED on the route of the collaborator invitations, which `convite.reenviar` guards', async () => {
      const old = await seedInvitation(clientA1, freshEmail('rota-antiga'));
      const response = await call('POST', `/agencies/${agencyA}/invitations/${old.id}/resend`, cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('PORTAL_INVITATION_DISCONTINUED');
      expect(await invitationRow(old.id)).toEqual(PENDING);
    });

    describe('when the address changed hands', () => {
      const formerAccount = async () => {
        const former = await makeUser(`former${randomUUID().slice(0, 6)}`, 'Conta que Mudou');
        await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [former.id]);
        await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: former.id });
        const cookie = await login(former);
        expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(200);
        const access = await owner.knex('client_portal_accesses').where({ client_id: clientA2, user_id: former.id }).first();
        await app.pool.query('update auth."user" set email = $2 where id = $1', [former.id, freshEmail('mudou')]);
        return { former, cookie, access };
      };

      it('ends the sessions of the account that lost the address, as Adicionar pessoa does, and not those of the caller', async () => {
        const { former, cookie, access } = await formerAccount();
        const old = await seedInvitation(clientA2, access.email);
        const adminSessions = await sessionCount(users.admin!.id);

        const response = await call('POST', resendInvitationUrl(agencyA, clientA2, old.id), cookies.admin);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ accessId: access.id, entered: false, name: null });
        expect(await sessionCount(former.id)).toBe(0);
        expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(401);
        expect(await sessionCount(users.admin!.id)).toBe(adminSessions);
        expect((await invitationRow(old.id)).revoked_at).toBeInstanceOf(Date);
      });

      it('is one transaction: if ending the sessions fails, the invitation is still pending and the access still belongs to the account', async () => {
        const { former, cookie, access } = await formerAccount();
        const old = await seedInvitation(clientA2, access.email);
        const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        await owner.knex.raw(`
          create function public.${name}() returns trigger language plpgsql as $$
          begin
            if old."userId" = '${former.id}'::uuid then raise exception 'sessions cannot be deleted' using errcode = '40P01'; end if;
            return old;
          end $$;
          create trigger ${name} before delete on auth."session" for each row execute function public.${name}();
        `);
        try {
          const response = await call('POST', resendInvitationUrl(agencyA, clientA2, old.id), cookies.admin);
          expect(response.statusCode).toBe(409);
          expect(response.json().error.code).toBe('TRY_AGAIN');
        } finally {
          await owner.knex.raw(`drop trigger if exists ${name} on auth."session"; drop function if exists public.${name}();`);
        }
        expect(await invitationRow(old.id)).toEqual(PENDING);
        expect(await accessRow(access.id)).toMatchObject({ user_id: former.id, status: 'active' });
        expect(await welcomes(access.email)).toHaveLength(0);
        expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(200);
      });
    });
  });
});
