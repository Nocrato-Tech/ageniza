import { insertTestUser, TEST_APP_PUBLIC_URL } from '../../auth/test-support/harness.js';
import type { ContentsWorld } from './world.js';

/**
 * The people of the portal of #257, on top of the world of #254. Every person who is also a collaborator holds ONE thing, so
 * a guard on the wrong key cannot hide behind an admin:
 *  - `dualAdmin`: an Admin of agency A (every key) with a link to client A1 — the agency branch of the policy shows him everything;
 *  - `dualRead`: only `conteudo.visualizar` in agency A, with a link to A1 — the one key that reads a draft, a caption and a cancelled content;
 *  - `dualBare`: a role of agency A with an unrelated key and a link to A1;
 *  - `crossDual`: an Admin of agency B with a link to A1 — he reads agency B's clients through the policy and A1 through the link.
 * `portalMulti` has links to A1 and A2, so a row of A2 read through the URL of A1 is shown by the policy and only the route stops it.
 */
export type PortalPerson =
  | 'portalOne' | 'portalMulti' | 'portalOther' | 'portalB' | 'dualAdmin' | 'dualRead' | 'dualBare' | 'crossDual' | 'removed';

export const DUAL_PEOPLE = ['dualAdmin', 'dualRead', 'dualBare', 'crossDual'] as const satisfies readonly PortalPerson[];
export const LINKED_PEOPLE = ['portalOne', 'portalMulti', ...DUAL_PEOPLE] as const satisfies readonly PortalPerson[];

const NAMES: Record<PortalPerson, string> = {
  portalOne: 'Ana do Portal',
  portalMulti: 'Bia dos Dois Clientes',
  portalOther: 'Carla Outro Cliente',
  portalB: 'Dani Outra Agência',
  dualAdmin: 'Eva Admin e Cliente',
  dualRead: 'Fábio Lê e Cliente',
  dualBare: 'Gabi Sem Papel e Cliente',
  crossDual: 'Hugo Admin da Outra',
  removed: 'Iara Vínculo Removido'
};

export const createPortalFixtures = (w: ContentsWorld) => {
  const people = {} as Record<PortalPerson, { id: string; cookie: string; name: string }>;
  const userIds: string[] = [];
  let clientA1 = '';
  let clientA2 = '';
  let clientB1 = '';

  const login = async (email: string, password: string): Promise<string> => {
    const response = await w.getApp().app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: TEST_APP_PUBLIC_URL },
      payload: { email, password }
    });
    if (response.statusCode !== 200) throw new Error(`Login failed with ${response.statusCode}.`);
    return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  };

  return {
    people,
    get clientA1(): string { return clientA1; },
    get clientA2(): string { return clientA2; },
    get clientB1(): string { return clientB1; },
    /** Every user id the portal must never send, whoever's: the agency's people and the portal's own. */
    allUserIds: (): string[] => [...Object.values(w.people).map((person) => person.id), ...userIds],

    async setup(): Promise<void> {
      const owner = w.getOwner().knex;
      clientA1 = await w.newClient('portal-A1');
      clientA2 = await w.newClient('portal-A2');
      clientB1 = await w.newClient('portal-B1', { agencyId: w.agencyB });

      const readRole = await w.customRole(w.agencyA, ['conteudo.visualizar']);
      const bareRole = await w.customRole(w.agencyA, ['midia.enviar']);
      const adminRole = (await owner('roles').whereNull('agency_id').where({ key: 'admin' }).first('id'))?.id as string;

      const fixtures = new Map<PortalPerson, Awaited<ReturnType<typeof insertTestUser>>>();
      for (const key of Object.keys(NAMES) as PortalPerson[]) {
        const user = await insertTestUser(w.getApp().pool, w.getApp().auth, { emailLabel: `portal-${key.toLowerCase()}`, name: NAMES[key] });
        userIds.push(user.id);
        fixtures.set(key, user);
        people[key] = { id: user.id, cookie: '', name: NAMES[key] };
      }

      await owner('agency_memberships').insert([
        { agency_id: w.agencyA, user_id: people.dualAdmin.id, role_id: adminRole },
        { agency_id: w.agencyA, user_id: people.dualRead.id, role_id: readRole },
        { agency_id: w.agencyA, user_id: people.dualBare.id, role_id: bareRole },
        { agency_id: w.agencyB, user_id: people.crossDual.id, role_id: adminRole }
      ]);
      await owner('client_memberships').insert([
        { client_id: clientA1, user_id: people.portalOne.id },
        { client_id: clientA1, user_id: people.portalMulti.id },
        { client_id: clientA2, user_id: people.portalMulti.id },
        { client_id: clientA2, user_id: people.portalOther.id },
        { client_id: clientB1, user_id: people.portalB.id },
        { client_id: clientA1, user_id: people.dualAdmin.id },
        { client_id: clientA1, user_id: people.dualRead.id },
        { client_id: clientA1, user_id: people.dualBare.id },
        { client_id: clientA1, user_id: people.crossDual.id },
        { client_id: clientA1, user_id: people.removed.id, status: 'removed' },
        // A person with no valid context cannot log in: the removed link is the one of A1, and this one keeps the session.
        { client_id: clientA2, user_id: people.removed.id }
      ]);

      for (const [key, user] of fixtures) people[key].cookie = await login(user.email, user.password);
    },

    /** Runs before the world's teardown: what these people wrote and the links and accounts they own go first. */
    async cleanup(): Promise<void> {
      const owner = w.getOwner().knex;
      const clients = (await owner('clients').whereIn('agency_id', [w.agencyA, w.agencyB]).select('id')).map((row) => row.id as string);
      await owner('client_portal_approval_links').whereIn('client_id', clients).delete();
      await owner('client_thread_comments').whereIn('client_id', clients).delete();
      await owner('client_threads').whereIn('client_id', clients).delete();
      await owner('content_media').whereIn('client_id', clients).delete();
      await owner('content_tasks').whereIn('client_id', clients).delete();
      await owner('notification_queue').whereIn('client_id', clients).delete();
      await owner('contents').whereIn('client_id', clients).delete();
      await owner('client_memberships').whereIn('user_id', userIds).delete();
      await owner('agency_memberships').whereIn('user_id', userIds).delete();
      await w.getApp().pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    }
  };
};

export type PortalFixtures = ReturnType<typeof createPortalFixtures>;
