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
import { createInvitationToken } from '../invitations/tokens.js';

// Issue #711: "Adicionar pessoa" and the link of the access to the account at the login. A person of the portal is an access given
// to an e-mail address; the list never says whether an address has an account, and the account takes the access only when its
// address is verified and it enters. Every permission is held alone by a custom role, and the person of two sides (a collaborator who
// is also a person of the portal) and the person of two agencies attack every route again.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: FakeEmailSender;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, cookie?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const membersUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/members`;
const sessionCount = async (userId: string): Promise<number> =>
  Number((await owner.knex('auth.session').where({ userId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const accessOf = async (clientId: string, email: string) => owner.knex('client_portal_accesses').where({ client_id: clientId, email }).first();
const accessCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_portal_accesses').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const freshEmail = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@portal-access.test`;

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const makeUser = async (key: string, name: string, options: { email?: string } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `pa-${key.toLowerCase()}`, name, ...options });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

const welcomes = async (to: string) => {
  await app.emailService.drain();
  return sender.sent.filter((message) => message.to === to && message.template === 'client-portal-welcome');
};

describe('CLIENTS portal access by e-mail (#711)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['ownerUser', 'Dona da Agência'], ['manager', 'Marta Gestora'], ['inviteOnly', 'Só Convida'],
      ['removeOnly', 'Só Remove'], ['dualBare', 'Duda Dupla Sem Papel'], ['crossDual', 'Cris Dupla de Duas Agências'], ['otherAdmin', 'Admin da Outra']
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
      { id: agencyA, name: 'Acesso Agência A & Co.', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Acesso Agência B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: await customRole('cliente.convidar_usuario') },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: await customRole('cliente.remover_usuario') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: 'Padaria Central <A1>' },
      { id: clientA2, agency_id: agencyA, name: 'Outro Cliente A2' },
      { id: clientB1, agency_id: agencyB, name: 'Cliente B1' }
    ]);
    // The two people of two sides hold a portal link to the client of agency A.
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.crossDual!.id }
    ]);
    for (const key of ['admin', 'ownerUser', 'manager', 'inviteOnly', 'removeOnly', 'dualBare', 'crossDual', 'otherAdmin']) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2, clientB1];
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('invitations').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('audit.events').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  describe('POST .../members (Adicionar pessoa)', () => {
    it('gives the access at once, with no account, and sends the welcome e-mail with the link to the sign-in screen', async () => {
      const email = freshEmail('maria');
      const response = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: `  ${email.toUpperCase()}  ` });
      expect(response.statusCode).toBe(201);
      const row = await accessOf(clientA1, email);
      expect(row).toMatchObject({ user_id: null, status: 'active', generation: 1 });
      expect(response.json()).toEqual({
        accessId: row.id, name: null, email, status: 'active', entered: false, since: new Date(row.created_at).toISOString()
      });

      const [mail] = await welcomes(email);
      expect(mail).toBeDefined();
      expect(mail!.subject).toBe('Você tem acesso ao portal no Ageniza');
      expect(mail!.text).toContain('Padaria Central <A1>');
      expect(mail!.text).toContain('Acesso Agência A & Co.');
      expect(mail!.text).toContain(`${TEST_APP_PUBLIC_URL}/entrar`);
      // Nothing to accept: the mail carries no token and no expiry.
      expect(mail!.text).not.toMatch(/token|expira/i);
      expect(mail!.html).toContain('Padaria Central &lt;A1&gt;');
      expect(await owner.knex('client_memberships').where({ portal_access_id: row.id })).toEqual([]);
    });

    it('answers 409 to an address that already has the access, and writes and sends nothing more', async () => {
      const email = freshEmail('repetida');
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).statusCode).toBe(201);
      const before = await accessCount(clientA1);
      const again = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: email.toUpperCase() });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('ACCESS_EXISTS');
      expect(await accessCount(clientA1)).toBe(before);
      expect(await welcomes(email)).toHaveLength(1);
    });

    it('reactivates the row of a removed address, with the generation the removal left, and welcomes the person again', async () => {
      const email = freshEmail('volta');
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin)).statusCode).toBe(200);
      expect(await accessOf(clientA1, email)).toMatchObject({ status: 'removed', generation: 2 });

      const again = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      expect(again.statusCode).toBe(201);
      expect(again.json()).toMatchObject({ accessId: added.accessId, status: 'active' });
      expect(await accessOf(clientA1, email)).toMatchObject({ id: added.accessId, status: 'active', generation: 2 });
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email }).count<{ count: string }[]>('id as count')).toEqual([{ count: '1' }]);
      expect(await welcomes(email)).toHaveLength(2);
    });

    it('never says, in the response or in the list, whether the address has an account, and never links it', async () => {
      const verified = await makeUser('withAccount', 'Pessoa Com Conta');
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [verified.id]);
      const without = freshEmail('semconta');
      const withAccount = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: verified.email });
      const withoutAccount = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: without });

      for (const response of [withAccount, withoutAccount]) {
        expect(response.statusCode).toBe(201);
        expect(Object.keys(response.json()).sort()).toEqual(['accessId', 'email', 'entered', 'name', 'since', 'status']);
        expect(response.json()).toMatchObject({ name: null, entered: false });
      }
      expect(await accessOf(clientA1, verified.email)).toMatchObject({ user_id: null });
      expect(await owner.knex('client_memberships').where({ client_id: clientA1, user_id: verified.id })).toEqual([]);

      const listed = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin)).json().data as Array<{ email: string; name: string | null; entered: boolean }>;
      const byEmail = (email: string) => listed.find((item) => item.email === email);
      expect(byEmail(verified.email)).toMatchObject({ name: null, entered: false });
      expect(byEmail(without)).toMatchObject({ name: null, entered: false });
      expect(JSON.stringify(listed)).not.toContain('Pessoa Com Conta');
    });

    it('adds a person who is already in the portal of another client of the agency, and leaves that access as it is', async () => {
      const email = freshEmail('outro-cliente');
      const person = await makeUser('inOtherClient', 'Em Outro Cliente', { email });
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: person.id });
      const before = await accessOf(clientA2, email);

      const response = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      expect(response.statusCode).toBe(201);
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null, status: 'active' });
      expect(await accessOf(clientA2, email)).toEqual(before);
    });

    it('is refused to every caller without cliente.convidar_usuario, and answers 404 across agencies, writing nothing', async () => {
      const email = freshEmail('negada');
      for (const key of ['manager', 'removeOnly', 'dualBare']) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies[key], { email })).statusCode, key).toBe(403);
      }
      expect((await call('POST', membersUrl(agencyA, clientA1), undefined, { email })).statusCode).toBe(401);
      // The collaborator of another agency who is also a person of this client's portal: the agency of the URL is not theirs.
      for (const key of ['crossDual', 'otherAdmin']) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies[key], { email })).statusCode, key).toBe(404);
      }
      expect((await call('POST', membersUrl(agencyA, clientB1), cookies.admin, { email })).statusCode).toBe(404);
      expect((await call('POST', membersUrl(agencyA, randomUUID()), cookies.admin, { email })).statusCode).toBe(404);
      expect((await call('POST', membersUrl(agencyA, 'not-a-uuid'), cookies.admin, { email })).statusCode).toBe(404);
      expect(await accessOf(clientA1, email)).toBeUndefined();
      expect(await welcomes(email)).toHaveLength(0);

      // The permission alone, and the owner, who has no membership row, are enough.
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.inviteOnly, { email: freshEmail('so-convida') })).statusCode).toBe(201);
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.ownerUser, { email: freshEmail('dona') })).statusCode).toBe(201);
    });

    it('refuses a body that is not exactly an address', async () => {
      const before = await accessCount(clientA1);
      for (const payload of [{}, { email: 'sem-arroba' }, { email: '' }, { email: freshEmail('x'), role: 'admin' }, { email: 42 }, { email: `${'a'.repeat(330)}@x.test` }]) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin, payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin)).statusCode).toBe(400);
      expect(await accessCount(clientA1)).toBe(before);
    });

    it('keeps the access when the e-mail cannot be delivered, says so with a 502, and the same address is then 409', async () => {
      const failing = await buildTestApp({ sender: createFakeEmailSender(async () => { throw new Error('smtp is down'); }) });
      try {
        const email = freshEmail('smtp');
        const adminCookie = await (async () => {
          const response = await failing.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users.admin!.email, password: users.admin!.password } });
          return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        })();
        const response = await failing.app.inject({
          method: 'POST', url: membersUrl(agencyA, clientA1), headers: { ...origin, cookie: adminCookie }, payload: { email }
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(await accessOf(clientA1, email)).toMatchObject({ status: 'active', user_id: null });
        const again = await failing.app.inject({
          method: 'POST', url: membersUrl(agencyA, clientA1), headers: { ...origin, cookie: adminCookie }, payload: { email }
        });
        expect(again.statusCode).toBe(409);
      } finally {
        await failing.close();
      }
    });

    it('ends the sessions of the account that lost the address, as any removal does, and not those of the caller', async () => {
      const former = await makeUser('former', 'Conta que Mudou');
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [former.id]);
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: former.id });
      const cookie = await login(former);
      expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(200);
      const access = await owner.knex('client_portal_accesses').where({ client_id: clientA2, user_id: former.id }).first();
      await app.pool.query('update auth."user" set email = $2 where id = $1', [former.id, freshEmail('mudou')]);
      const adminSessions = await sessionCount(users.admin!.id);

      const response = await call('POST', membersUrl(agencyA, clientA2), cookies.admin, { email: access.email });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ accessId: access.id, entered: false, name: null });
      expect(await sessionCount(former.id)).toBe(0);
      expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(401);
      expect(await sessionCount(users.admin!.id)).toBe(adminSessions);
      expect(await owner.knex('client_memberships').where({ client_id: clientA2, user_id: former.id }).first('status')).toEqual({ status: 'removed' });
    });
  });

  describe('the plan of the agency (#725)', () => {
    const expire = (): Promise<number> => owner.knex('agencies').where({ id: agencyA }).update({
      plan: 'trial', trial_ends_at: owner.knex.raw("now() - interval '1 minute'"), trial_owner_email_key: owner.knex.raw('coalesce(trial_owner_email_key, id::text)')
    });
    const renew = (): Promise<number> => owner.knex('agencies').where({ id: agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null, daily_email_limit: null });

    it('answers 409 AGENCY_READ_ONLY to Adicionar pessoa and Reativar, and lets Remover through, sending no e-mail', async () => {
      const email = freshEmail('somente-leitura');
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect(await welcomes(email)).toHaveLength(1);
      await expire();
      try {
        const refusedAdd = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: freshEmail('nova') });
        expect(refusedAdd.statusCode).toBe(409);
        expect(refusedAdd.json().error.code).toBe('AGENCY_READ_ONLY');

        // Remover narrows access and stays open, and ends the sessions as ever.
        const removed = await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin);
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toMatchObject({ status: 'removed' });
        expect(await accessOf(clientA1, email)).toMatchObject({ status: 'removed', generation: 2 });

        const refusedBack = await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/reactivate`, cookies.admin);
        expect(refusedBack.statusCode).toBe(409);
        expect(refusedBack.json().error.code).toBe('AGENCY_READ_ONLY');
        const refusedReAdd = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
        expect(refusedReAdd.statusCode).toBe(409);
        expect(await accessOf(clientA1, email)).toMatchObject({ status: 'removed' });
        // The list is readable.
        expect((await call('GET', membersUrl(agencyA, clientA1), cookies.admin)).statusCode).toBe(200);
      } finally {
        await renew();
      }
      expect(await welcomes(email)).toHaveLength(1);
    });

    it('answers 429 DAILY_EMAIL_LIMIT past the limit of the agency, writing nothing and sending nothing, and a removal spends nothing', async () => {
      const spent = await owner.knex('audit.events').where({ agency_id: agencyA }).whereIn('action', ['client_member.added', 'client_member.readded'])
        .whereRaw("app_private.sao_paulo_date(occurred_at) = app_private.sao_paulo_date(now())").count<{ count: string }[]>('id as count');
      const invitationsToday = await owner.knex('invitations').where({ agency_id: agencyA }).whereIn('purpose', ['collaborator_invite', 'client_invite'])
        .whereRaw("app_private.sao_paulo_date(created_at) = app_private.sao_paulo_date(now())").count<{ count: string }[]>('id as count');
      const used = Number(spent[0]!.count) + Number(invitationsToday[0]!.count);
      await owner.knex('agencies').where({ id: agencyA }).update({ daily_email_limit: used + 1 });
      try {
        const first = freshEmail('ultimo-lugar');
        const second = freshEmail('sem-lugar');
        const added = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: first });
        expect(added.statusCode).toBe(201);

        const refused = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: second });
        expect(refused.statusCode).toBe(429);
        expect(refused.json().error.code).toBe('DAILY_EMAIL_LIMIT');
        expect(await accessOf(clientA1, second)).toBeUndefined();
        expect(await welcomes(second)).toHaveLength(0);

        // Removing spends nothing and is open; adding the address back is a new e-mail and is refused at the limit.
        expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.json().accessId}/remove`, cookies.admin)).statusCode).toBe(200);
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: first })).statusCode).toBe(429);
        expect(await accessOf(clientA1, first)).toMatchObject({ status: 'removed' });
        // Reativar sends no e-mail, so the limit does not stop it.
        expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.json().accessId}/reactivate`, cookies.admin)).statusCode).toBe(200);
      } finally {
        await renew();
      }
    });
  });

  describe('what the review of #728 found', () => {
    const verified = async (key: string, name: string, extra: { otherPortal?: boolean } = {}): Promise<TestUserFixture> => {
      const user = await makeUser(key, name);
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [user.id]);
      // Someone who works in another agency, or in the portal of another client: the context that lets the account sign in.
      if (extra.otherPortal !== false) await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: user.id });
      return user;
    };
    const listed = async (email: string) =>
      (await call('GET', `${membersUrl(agencyA, clientA1)}?pageSize=100`, cookies.admin)).json().data.find((item: { email: string }) => item.email === email);

    it('keeps "ainda não entrou" and hides the name of a person linked by a load of the contexts who never opened this portal', async () => {
      const person = await verified('worksElsewhere', 'Pessoa de Outra Agência');
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: person.email });
      const cookie = await login(person);

      // Any load of the app runs the link; the access is the account's now.
      expect((await call('GET', '/me/contexts', cookie)).statusCode).toBe(200);
      expect(await accessOf(clientA1, person.email)).toMatchObject({ user_id: person.id, first_entered_at: null });
      expect(await listed(person.email)).toMatchObject({ entered: false, name: null, email: person.email });
      expect(JSON.stringify(await listed(person.email))).not.toContain('Pessoa de Outra Agência');

      // The same for the resolve that does not enter (two contexts and no preference): it only lists.
      expect((await call('GET', '/me/contexts/resolve', cookie)).json()).toMatchObject({ decision: 'select' });
      expect(await listed(person.email)).toMatchObject({ entered: false, name: null });
    });

    it.each([
      ['opens the portal of the client', (cookie: string) => call('GET', `/clients/${clientA1}`, cookie)],
      ['selects the context of the client as the last used', (cookie: string) => call('PUT', '/me/last-context', cookie, { type: 'client', clientId: clientA1 })]
    ])('shows the name once the person %s', async (_label, enter) => {
      const person = await verified(`enters-${_label.length}`, `Entrou ${_label}`);
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: person.email });
      const cookie = await login(person);
      await call('GET', '/me/contexts', cookie);
      expect(await listed(person.email)).toMatchObject({ entered: false, name: null });

      expect([200, 204]).toContain((await enter(cookie)).statusCode);
      expect(await listed(person.email)).toMatchObject({ entered: true, name: `Entrou ${_label}` });
    });

    it('shows it once the resolve decides to enter the portal of the client', async () => {
      const person = await verified('onlyHere', 'Só Este Portal', { otherPortal: false });
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: person.email });
      const cookie = await login(person);
      expect(await listed(person.email)).toMatchObject({ entered: false, name: null });

      expect((await call('GET', '/me/contexts/resolve', cookie)).json()).toMatchObject({ decision: 'enter', context: { clientId: clientA1 } });
      expect(await listed(person.email)).toMatchObject({ entered: true, name: 'Só Este Portal' });
    });

    it('does not record an entry in a read-only agency, and does not fail the portal either', async () => {
      const person = await verified('readOnlyEntry', 'Entrada Somente Leitura');
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: person.email });
      const cookie = await login(person);
      await call('GET', '/me/contexts', cookie);
      await owner.knex('agencies').where({ id: agencyA }).update({
        plan: 'trial', trial_ends_at: owner.knex.raw("now() - interval '1 minute'"), trial_owner_email_key: owner.knex.raw('coalesce(trial_owner_email_key, id::text)')
      });
      try {
        expect((await call('GET', `/clients/${clientA1}`, cookie)).statusCode).toBe(200);
        expect(await listed(person.email)).toMatchObject({ entered: false, name: null });
      } finally {
        await owner.knex('agencies').where({ id: agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
      }
    });

    it('does not let an old portal invitation bring back a person the agency removed', async () => {
      const person = await verified('oldInvitation', 'Convite Antigo');
      const { token, tokenHash } = (() => { const created = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL }); return { token: created.token, tokenHash: created.tokenHash }; })();
      await owner.knex('invitations').insert({
        agency_id: agencyA, purpose: 'client_invite', email: person.email, client_id: clientA1, token_hash: tokenHash, expires_at: new Date(Date.now() + 86_400_000)
      });
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: person.email })).json();
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin)).statusCode).toBe(200);

      expect(await owner.knex('invitations').where({ token_hash: tokenHash }).first('revoked_at')).toEqual({ revoked_at: expect.any(Date) });
      const cookie = await login(person);
      const accept = await call('POST', `/invitations/${token}/accept`, cookie);
      expect(accept.statusCode).toBe(410);
      expect(await accessOf(clientA1, person.email)).toMatchObject({ status: 'removed', user_id: null });
      expect((await call('GET', `/clients/${clientA1}`, cookie)).statusCode).toBe(404);
    });
  });

  describe('the link at the login', () => {
    it('gives the portal to an account whose address is verified, when it loads its contexts, and to nobody before', async () => {
      const email = freshEmail('entra');
      const person = await makeUser('enters', 'Pessoa que Entra', { email });
      // An account with no context at all cannot sign in; this one is already a person of the portal of another client.
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: person.id });
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect(added.entered).toBe(false);

      // Unconfirmed: logged in, and the portal does not appear.
      const unconfirmed = await login(person);
      const before = (await call('GET', '/me/contexts', unconfirmed)).json();
      expect(before.contexts.filter((context: { type: string }) => context.type === 'client')).toEqual([expect.objectContaining({ clientId: clientA2 })]);
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null });
      expect((await call('GET', `/clients/${clientA1}`, unconfirmed)).statusCode).toBe(404);

      // Confirmed: the next time it loads its contexts, the portal is there.
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      const after = (await call('GET', '/me/contexts', unconfirmed)).json();
      expect(after.contexts.map((context: { clientId: string }) => context.clientId).sort()).toEqual([clientA1, clientA2].sort());
      expect(after.contexts).toContainEqual(expect.objectContaining({ type: 'client', clientId: clientA1, clientName: 'Padaria Central <A1>' }));
      expect(await accessOf(clientA1, email)).toMatchObject({ id: added.accessId, user_id: person.id });
      expect((await call('GET', `/clients/${clientA1}`, unconfirmed)).statusCode).toBe(200);

      // The list now shows the name of the account, and the address as it was recorded.
      const listed = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin)).json().data.find((item: { accessId: string }) => item.accessId === added.accessId);
      expect(listed).toMatchObject({ name: 'Pessoa que Entra', email, entered: true });
    });

    it('lets a verified account with no context but an access sign in, because the link comes before the count of contexts', async () => {
      const email = freshEmail('primeira');
      const person = await makeUser('firstLogin', 'Primeiro Acesso', { email });
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      const cookie = await login(person);
      expect((await call('GET', '/me/contexts/resolve', cookie)).json()).toMatchObject({ decision: 'enter', context: { type: 'client', clientId: clientA1 } });
    });

    it('does not link an access that was removed before the account entered, and shows the person as removed', async () => {
      const email = freshEmail('removida');
      const person = await makeUser('removedBeforeEntering', 'Removida Antes', { email });
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin)).json()).toMatchObject({ status: 'removed', entered: false });
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null, status: 'removed' });
    });
  });
});
