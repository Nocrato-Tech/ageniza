import { randomUUID } from 'node:crypto';

import { insertTestUser, TEST_APP_PUBLIC_URL } from '../../auth/test-support/harness.js';
import type { TransitionAction } from '../transition-errors.js';
import type { ContentsWorld } from './world.js';

export type TransitionPerson =
  | 'operateRead' | 'publishRead' | 'publishOnly' | 'cancelRead' | 'cancelOnly' | 'approveRead' | 'approveOnly';

/** Each of these holds one action's permission, with or without `conteudo.visualizar`, and nothing else. */
const ROLES: Record<TransitionPerson, readonly string[]> = {
  operateRead: ['conteudo.operar', 'conteudo.visualizar'],
  publishRead: ['conteudo.publicar', 'conteudo.visualizar'],
  publishOnly: ['conteudo.publicar'],
  cancelRead: ['conteudo.cancelar', 'conteudo.visualizar'],
  cancelOnly: ['conteudo.cancelar'],
  approveRead: ['conteudo.aprovar_pela_agencia', 'conteudo.visualizar'],
  approveOnly: ['conteudo.aprovar_pela_agencia']
};

export interface Fixture {
  readonly contentId: string;
  readonly body?: Record<string, unknown>;
}

/**
 * What the transitions of #256 are attacked with, on top of the world of #254: one person per single permission of the
 * six actions (with and without the read), the people of a client's portal for the queue, and a content in the state each
 * action starts from, with the media its rule needs, so that without the thing a test removes the action would succeed.
 */
export const createTransitionFixtures = (w: ContentsWorld) => {
  const people = {} as Record<TransitionPerson, { id: string; cookie: string; roleId: string }>;
  const extraUserIds: string[] = [];
  const fixturePersonIds: string[] = [];
  const origin = { origin: TEST_APP_PUBLIC_URL };

  const login = async (email: string, password: string): Promise<string> => {
    const response = await w.getApp().app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });
    if (response.statusCode !== 200) throw new Error(`Login failed with ${response.statusCode}.`);
    return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  };

  const newUser = async (label: string): Promise<{ id: string; email: string; password: string }> => {
    const user = await insertTestUser(w.getApp().pool, w.getApp().auth, { emailLabel: `transitions-${label}`, name: `Pessoa ${label}` });
    extraUserIds.push(user.id);
    return user;
  };

  const today = async (): Promise<string> => {
    const result = await w.getOwner().knex.raw<{ rows: Array<{ day: string }> }>('select app_private.sao_paulo_date(now())::text as day');
    return result.rows[0]?.day as string;
  };

  /** The first and the last millisecond of the day in America/Sao_Paulo that holds `day`, as instants. */
  const dayBounds = async (day: string): Promise<{ start: Date; end: Date }> => {
    const result = await w.getOwner().knex.raw<{ rows: Array<{ start: Date; end: Date }> }>(`
      select (?::date)::timestamp at time zone 'America/Sao_Paulo' as start,
        ((?::date + 1)::timestamp at time zone 'America/Sao_Paulo') - interval '1 millisecond' as "end"
    `, [day, day]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('The bounds of the day could not be read.');
    return { start: new Date(row.start), end: new Date(row.end) };
  };

  const addMedia = async (contentId: string, clientId: string, category: 'image' | 'video' = 'video', status: 'confirmed' | 'pending' = 'confirmed'): Promise<string> => {
    const folderId = (await w.contentRow(contentId)).folder_id as string;
    const asset = await w.seedAsset(clientId, folderId, { category, status });
    await w.attach(contentId, [asset]);
    return asset;
  };

  const seedPublished = async (clientId: string, publishedAt: Date, publishedOn: string): Promise<string> => {
    const id = randomUUID();
    await w.getOwner().knex('contents').insert({
      id,
      client_id: clientId,
      title: `Publicado ${id.slice(0, 8)}`,
      platform: 'instagram',
      format: 'reels',
      publish_on: '2026-10-20',
      caption: 'Legenda original',
      folder_id: await w.folderOf(clientId),
      owner_user_id: w.people.production.id,
      status: 'published',
      approved_by: w.people.admin.id,
      approved_at: new Date('2026-10-05T12:00:00.000Z'),
      approved_by_agency_reason: 'Aprovado fora da plataforma',
      published_on: publishedOn,
      published_at: publishedAt
    });
    await addMedia(id, clientId);
    return id;
  };

  /** A content in the state the action starts from, with the media that action needs, so that it would succeed. */
  const fixtureFor = async (action: TransitionAction, clientId: string): Promise<Fixture> => {
    switch (action) {
      case 'submit': {
        const contentId = await w.seedContent(clientId, { status: 'in_production', format: 'reels' });
        await addMedia(contentId, clientId);
        return { contentId };
      }
      case 'approve-by-agency': {
        const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'reels' });
        await addMedia(contentId, clientId);
        return { contentId, body: { revision: 1, reason: 'O cliente aprovou por telefone.' } };
      }
      case 'publish': {
        const contentId = await w.seedContent(clientId, { status: 'approved', format: 'reels' });
        await addMedia(contentId, clientId);
        return { contentId, body: {} };
      }
      case 'unpublish': {
        const { start } = await dayBounds(await today());
        return { contentId: await seedPublished(clientId, new Date(start.getTime() + 1000), await today()) };
      }
      case 'cancel': {
        const contentId = await w.seedContent(clientId, { status: 'approved', format: 'reels' });
        await addMedia(contentId, clientId);
        return { contentId };
      }
      case 'reschedule':
        return { contentId: await w.seedContent(clientId, { status: 'cancelled' }), body: { publishOn: '2026-11-03' } };
    }
  };

  /** The status each action leaves a content in, for the happy path. */
  const AFTER: Record<TransitionAction, string> = {
    submit: 'awaiting_approval',
    'approve-by-agency': 'approved',
    publish: 'published',
    unpublish: 'approved',
    cancel: 'cancelled',
    reschedule: 'in_production'
  };

  const urlOf = (clientId: string, contentId: string, action: TransitionAction, agencyId = w.agencyA): string =>
    `/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/${action}`;

  const portalMember = async (clientId: string, status: 'active' | 'removed' = 'active'): Promise<string> => {
    const user = await newUser(`portal-${status}`);
    await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: user.id, status });
    return user.id;
  };

  const queueRows = async (contentId: string): Promise<Array<{ type: string; recipient: string }>> => {
    // The queue names the access of the person (#711); the tests talk about the account the access is linked to.
    const rows = await w.getOwner().knex('notification_queue as item')
      .join('client_portal_accesses as access', 'access.id', 'item.recipient_portal_access_id')
      .where('item.content_id', contentId)
      .orderBy(['item.type', 'access.user_id'])
      .select('item.type', 'access.user_id as recipient_user_id');
    return rows.map((row) => ({ type: row.type as string, recipient: row.recipient_user_id as string }));
  };

  return {
    people,
    fixtureFor,
    seedPublished,
    addMedia,
    today,
    dayBounds,
    AFTER,
    urlOf,
    portalMember,
    queueRows,
    /** Every user id of the scenario, whoever's: the world's people, the fixture people and the portal members made so far. */
    allUserIds: (): string[] => [...Object.values(w.people).map((person) => person.id), ...extraUserIds],

    async setup(): Promise<void> {
      for (const key of Object.keys(ROLES) as TransitionPerson[]) {
        const user = await newUser(key.toLowerCase());
        fixturePersonIds.push(user.id);
        const roleId = await w.customRole(w.agencyA, ROLES[key]);
        await w.getOwner().knex('agency_memberships').insert({ agency_id: w.agencyA, user_id: user.id, role_id: roleId });
        people[key] = { id: user.id, cookie: await login(user.email, user.password), roleId };
      }
    },

    /** Runs before the world's teardown: the queue rows of these people, their links and their accounts go first. */
    async cleanup(): Promise<void> {
      const owner = w.getOwner().knex;
      // The contents these people approved go first: the world deletes them again, and finds nothing left of them.
      const clients = (await owner('clients').whereIn('agency_id', [w.agencyA, w.agencyB]).select('id')).map((row) => row.id as string);
      await owner('client_thread_comments').whereIn('client_id', clients).delete();
      await owner('client_threads').whereIn('client_id', clients).delete();
      await owner('content_media').whereIn('client_id', clients).delete();
      await owner('content_tasks').whereIn('client_id', clients).delete();
      await owner('contents').whereIn('client_id', clients).delete();
      await owner('notification_queue').whereIn('client_id', clients).delete();
      await owner('client_memberships').whereIn('user_id', extraUserIds).delete();
      await owner('agency_memberships').whereIn('user_id', fixturePersonIds).delete();
      await w.getApp().pool.query('delete from auth."user" where id = any($1::uuid[])', [extraUserIds]);
    }
  };
};

export type TransitionFixtures = ReturnType<typeof createTransitionFixtures>;
