import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createVerifiedUserClaims,
  integrationDatabaseEnvironment,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

import { ACTIVE_SESSION_SQL } from '../modules/auth/session-validity.js';
import { revokeInsertId } from '../modules/auth/test-support/insert-id-revoked.js';
import {
  buildTestApp,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp
} from '../modules/auth/test-support/harness.js';
import { runSeedDemo, SEED_FLAG, type SeedDemoResult } from './seed-demo.js';

// Issue #183 acceptance tests. Runs the real command twice against the migrated local database and
// then signs every printed profile in through the real API, so a password hash that does not match
// Better Auth or a membership created outside the application path fails here.
const origin = { origin: TEST_APP_PUBLIC_URL };
const silentStdout = { write: () => undefined };

// Random namespace and email domain: the suite must never touch (nor delete) the demo dataset a
// developer created with `pnpm seed:demo` in the same database (security review of PR #188).
const namespace = `seed-test-${randomUUID().slice(0, 8)}`;
const seedEnvironment = {
  ...integrationDatabaseEnvironment(),
  AUTH_TERMS_VERSION: '2026-01-01',
  AUTH_PRIVACY_VERSION: '2026-02-01'
};
const runOptions = {
  env: seedEnvironment,
  argv: [SEED_FLAG],
  stdout: silentStdout,
  namespace,
  emailDomain: `${namespace}.demo.ageniza.test`
} as const;

let app: TestApp;
let owner: DatabaseClient;
let first: SeedDemoResult;
let second: SeedDemoResult;
/** The most recent run, since every run rotates every demo password. */
let latest: SeedDemoResult;
let restoreGrant: () => Promise<void>;

/** No table the seed writes as the application role takes an id chosen in the INSERT (issue #601). */
const TABLES_WITHOUT_INSERT_ID = ['clients', 'client_personas', 'client_threads', 'client_thread_comments'] as const;

// Counts run through the migration owner: most of these tables are behind RLS, and an
// unauthenticated application connection would count zero rows instead of the seed's.
const count = async (query: string, bindings: readonly unknown[]): Promise<number> => {
  const result = await owner.knex.raw<{ rows: { total: string }[] }>(query, Array.from(bindings));
  return Number(result.rows[0]?.total ?? -1);
};

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (email: string, password: string): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });
  expect(response.statusCode, `login for ${email}`).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const catalogKeys = async (): Promise<string[]> => {
  const rows = await owner.knex('permissions').orderBy('key').select('key');
  return rows.map((row) => row.key as string);
};

const presetKeys = async (roleKey: string): Promise<string[]> => {
  const rows = await owner.knex('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .where('roles.key', roleKey)
    .whereNull('roles.agency_id')
    .orderBy('role_permissions.permission_key')
    .select('permission_key');
  return rows.map((row) => row.permission_key as string);
};

const roleKeyFor = async (agencyId: string, userId: string): Promise<string | undefined> => {
  const row = await owner.knex('agency_memberships')
    .join('roles', 'roles.id', 'agency_memberships.role_id')
    .where({ 'agency_memberships.agency_id': agencyId, 'agency_memberships.user_id': userId, 'agency_memberships.status': 'active' })
    .first('roles.key');
  return row?.key as string | undefined;
};

const userIdFor = async (email: string): Promise<string> => {
  const row = await owner.knex('auth.user').where({ email }).first('id');
  if (row === undefined) throw new Error(`Seed user not found: ${email}`);
  return row.id as string;
};

interface ContextJson {
  readonly type: 'agency' | 'client';
  readonly agencyId?: string;
  readonly clientId?: string;
  readonly roleKey?: string;
  readonly isOwner?: boolean;
}

const contextsFor = async (cookie: string): Promise<ContextJson[]> => {
  const response = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<{ contexts: ContextJson[] }>().contexts;
};

/** Every decision `app_private.has_agency_permission` makes for one user and agency, key by key. */
const permissionVerdicts = async (userId: string, agencyId: string): Promise<Map<string, boolean>> => {
  const claims = createVerifiedUserClaims({ userId });
  const result = await withAuthenticatedUserTransaction(app.database, claims, (transaction) =>
    raw<{ rows: readonly { key: string; allowed: boolean }[] }>(transaction, `
      select permission.key, app_private.has_agency_permission(?::uuid, permission.key) as allowed
      from public.permissions as permission
      order by permission.key
    `, [agencyId])
  );
  return new Map(result.rows.map((row) => [row.key, row.allowed === true]));
};

const expectSamePermissions = (verdicts: ReadonlyMap<string, boolean>, expected: readonly string[]): void => {
  const allowed = [...verdicts.entries()].filter(([, value]) => value).map(([key]) => key).sort();
  expect(allowed).toEqual([...expected].sort());
};

describe('seed:demo (issue #183)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp();
    // The whole suite runs with the INSERT of the id taken away: a seed that still chooses one fails here, before any assertion.
    restoreGrant = await revokeInsertId(owner, TABLES_WITHOUT_INSERT_ID);
    first = await runSeedDemo(runOptions);
    second = await runSeedDemo(runOptions);
    latest = second;
  });

  afterAll(async () => {
    await restoreGrant();
    const agencyIds = first.agencyIds;
    const userIds = first.userIds;
    const clientIds = first.clientIds;
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('media_assets').whereIn('client_id', clientIds).whereNotNull('material_request_thread_id').delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('notification_queue').whereIn('client_id', clientIds).delete();
    await owner.knex('content_media').whereIn('client_id', clientIds).delete();
    await owner.knex('content_tasks').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('client_id', clientIds).delete();
    await owner.knex('story_script_scenes').whereIn('client_id', clientIds).delete();
    await owner.knex('story_scripts').whereIn('client_id', clientIds).delete();
    await owner.knex('media_assets').whereIn('agency_id', agencyIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('legal_acceptances').whereIn('user_id', userIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    await app.close();
    await owner.close();
  });

  it('running twice neither duplicates nor fails', async () => {
    expect(second.agencyIds).toEqual(first.agencyIds);
    expect(second.userIds).toEqual(first.userIds);
    expect(second.clientIds).toEqual(first.clientIds);
    expect(first.agencyIds).toHaveLength(2);
    expect(first.userIds).toHaveLength(9);
    expect(first.clientIds).toHaveLength(7);
    expect(first.pendingInvitations).toHaveLength(2);

    const agencyIds = first.agencyIds;
    const userIds = first.userIds;
    const clientIds = first.clientIds;
    expect(await count('select count(*)::text as total from public.agencies where id = any(?::uuid[])', [agencyIds])).toBe(2);
    expect(await count('select count(*)::text as total from auth."user" where id = any(?::uuid[])', [userIds])).toBe(9);
    expect(await count('select count(*)::text as total from public.clients where id = any(?::uuid[])', [clientIds])).toBe(7);
    expect(await count("select count(*)::text as total from public.agency_memberships where agency_id = any(?::uuid[]) and status = 'active'", [agencyIds])).toBe(8);
    expect(await count("select count(*)::text as total from public.client_memberships where client_id = any(?::uuid[]) and status = 'active'", [clientIds])).toBe(1);
    expect(await count('select count(*)::text as total from public.client_threads where client_id = any(?::uuid[]) and content_id is null', [clientIds])).toBe(7);
    expect(await count(`select count(*)::text as total from public.client_thread_comments comment
      join public.client_threads thread on thread.id = comment.thread_id
      where comment.client_id = any(?::uuid[]) and thread.content_id is null`, [clientIds])).toBe(10);
    expect(await count('select count(*)::text as total from public.client_personas where client_id = any(?::uuid[])', [clientIds])).toBe(3);
    expect(await count('select count(*)::text as total from public.client_brand_sections where client_id = any(?::uuid[])', [clientIds])).toBe(11);
    expect(await count("select count(*)::text as total from public.invitations where agency_id = any(?::uuid[]) and used_at is null and revoked_at is null", [agencyIds])).toBe(2);
    // Every membership came through the database function the application uses, not a raw insert.
    expect(await count("select count(*)::text as total from audit.events where agency_id = any(?::uuid[]) and action = 'invitation.accepted'", [agencyIds])).toBe(9);
    // Every seeded account accepted both documents, like the real new-account route records.
    expect(await count("select count(*)::text as total from public.legal_acceptances where user_id = any(?::uuid[]) and document = 'terms' and version = '2026-01-01'", [userIds])).toBe(9);
    expect(await count("select count(*)::text as total from public.legal_acceptances where user_id = any(?::uuid[]) and document = 'privacy' and version = '2026-02-01'", [userIds])).toBe(9);
    // Job titles come through the application path too (the Owner holds colaborador.alterar_funcao).
    expect(await count('select count(*)::text as total from public.agency_memberships where agency_id = any(?::uuid[]) and job_title is not null', [agencyIds])).toBe(8);
  });

  it('seeds Conteúdo: contents in every state, subtasks, scripts, media, folders and conversations, and running again changes none of it (issue #608)', async () => {
    const clientIds = first.clientIds;
    const byStatus = await owner.knex('contents').whereIn('client_id', clientIds).groupBy('status').select('status').count<Array<{ status: string; count: string }>>('id as count');
    expect(Object.fromEntries(byStatus.map((row) => [row.status, Number(row.count)]))).toEqual({
      in_production: 3, awaiting_approval: 4, adjusting: 1, approved: 4, published: 1, cancelled: 1
    });
    const tasks = await owner.knex('content_tasks').whereIn('client_id', clientIds).groupBy('status').select('status').count<Array<{ status: string; count: string }>>('id as count');
    expect(Object.fromEntries(tasks.map((row) => [row.status, Number(row.count)]))).toEqual({ pending: 1, delivered: 1, approved: 1 });
    const scripts = await owner.knex('story_scripts').whereIn('client_id', clientIds).groupBy('status').select('status').count<Array<{ status: string; count: string }>>('id as count');
    expect(Object.fromEntries(scripts.map((row) => [row.status, Number(row.count)]))).toEqual({ draft: 1, sent: 1, recorded: 1 });
    expect(await count('select count(*)::text as total from public.story_script_scenes where client_id = any(?::uuid[])', [clientIds])).toBe(7);
    expect(await count("select count(*)::text as total from public.media_assets where agency_id = any(?::uuid[]) and status = 'confirmed' and client_id is not null", [first.agencyIds])).toBe(20);
    expect(await count('select count(*)::text as total from public.content_media where client_id = any(?::uuid[])', [clientIds])).toBe(14);
    expect(await count('select count(*)::text as total from public.media_folders where client_id = any(?::uuid[]) and is_default = false', [clientIds])).toBe(2);
    expect(await count('select count(*)::text as total from public.client_threads where client_id = any(?::uuid[]) and content_id is not null', [clientIds])).toBe(5);
    expect(await count(`select count(*)::text as total from public.client_thread_comments comment
      join public.client_threads thread on thread.id = comment.thread_id
      where comment.client_id = any(?::uuid[]) and thread.content_id is not null`, [clientIds])).toBe(6);
    // Two runs, and the counts are the same: a content is found again by its client and title, a script by its client and day.
    expect(await count('select count(*)::text as total from public.contents where client_id = any(?::uuid[])', [clientIds])).toBe(14);
    expect(await count('select count(distinct (client_id, title))::text as total from public.contents where client_id = any(?::uuid[])', [clientIds])).toBe(14);
  });

  it('fills the fields the redesigned screens read: client, persona, request for material, round, media, portal access and sessions', async () => {
    const clientIds = first.clientIds;
    const one = async (query: string, bindings: readonly unknown[]): Promise<Record<string, any>> => // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped rows
      (await owner.knex.raw<{ rows: Record<string, any>[] }>(query, Array.from(bindings))).rows[0]!; // eslint-disable-line @typescript-eslint/no-explicit-any

    // Client: a city and an Instagram handle on every one.
    expect(await count('select count(*)::text as total from public.clients where id = any(?::uuid[]) and city is not null and instagram_handle is not null', [clientIds])).toBe(7);
    expect((await one("select city from public.clients where id = any(?::uuid[]) and name = 'Padaria Central'", [clientIds])).city).toBe('São Paulo');

    // Persona: the six fields of the profile.
    expect(await count(`select count(*)::text as total from public.client_personas
      where client_id = any(?::uuid[]) and age between 1 and 120 and occupation is not null and location is not null
        and jsonb_array_length(traits) between 1 and 5 and where_they_are is not null and tone_that_works is not null`, [clientIds])).toBe(3);

    // Request for material: a title and a deadline that is still to come.
    expect(await count(`select count(*)::text as total from public.client_threads
      where client_id = any(?::uuid[]) and is_material_request and title is not null and due_on >= app_private.sao_paulo_date(now())`, [clientIds])).toBe(3);

    // Rounds: sender, note and an hour. Two waiting contents are overdue and two are not, and the day of the deadline follows the instant.
    const rounds = `from public.content_approval_rounds round
      join public.contents content on content.id = round.content_id
      where round.client_id = any(?::uuid[]) and content.status = 'awaiting_approval'
        and round.sequence = (select max(latest.sequence) from public.content_approval_rounds latest where latest.content_id = content.id)`;
    expect(await count(`select count(*)::text as total ${rounds} and round.due_at < now()`, [clientIds])).toBe(2);
    expect(await count(`select count(*)::text as total ${rounds} and round.due_at > now() and round.due_at <= now() + interval '49 hours'`, [clientIds])).toBe(2);
    expect(await count(`select count(*)::text as total ${rounds} and round.sent_by is not null and round.due_on = app_private.sao_paulo_date(round.due_at)`, [clientIds])).toBe(4);
    expect(await count(`select count(*)::text as total ${rounds} and round.note is not null`, [clientIds])).toBe(3);
    // Approved with a word from the client, written as a comment of the content by the person of the portal.
    expect(await count(`select count(*)::text as total from public.client_thread_comments comment
      join public.client_threads thread on thread.id = comment.thread_id
      join public.contents content on content.id = thread.content_id
      where comment.client_id = any(?::uuid[]) and comment.author_side = 'client' and content.status = 'approved'`, [clientIds])).toBe(3);

    // The derived states: scheduled (approved, future day and hour) and late (past day, never approved).
    expect(await count(`select count(*)::text as total from public.contents
      where client_id = any(?::uuid[]) and status = 'approved' and publish_at_time is not null and publish_on > app_private.sao_paulo_date(now())`, [clientIds])).toBe(3);
    expect(await count(`select count(*)::text as total from public.contents
      where client_id = any(?::uuid[]) and status in ('in_production', 'adjusting', 'awaiting_approval') and publish_on < app_private.sao_paulo_date(now())`, [clientIds])).toBe(3);

    // Media: name, dimensions of the images, alternative text, who sent it and the folder.
    const media = "from public.media_assets where agency_id = any(?::uuid[]) and client_id is not null and status = 'confirmed'";
    expect(await count(`select count(*)::text as total ${media} and file_name is not null and alt_text is not null and created_by_user_id is not null and folder_id is not null and uploaded_by_side = 'agency'`, [first.agencyIds])).toBe(17);
    expect(await count(`select count(*)::text as total ${media} and category in ('image', 'logo') and width > 0 and height > 0 and uploaded_by_side = 'agency'`, [first.agencyIds])).toBe(13);
    expect(await count(`select count(distinct created_by_user_id)::text as total ${media} and uploaded_by_side = 'agency'`, [first.agencyIds])).toBe(2);
    expect(await count(`select count(*)::text as total ${media} and category in ('logo', 'pdf')`, [first.agencyIds])).toBe(2);

    // Portal access: added with a typed name, the person has not entered.
    expect(await count(`select count(*)::text as total from public.client_portal_accesses
      where client_id = any(?::uuid[]) and invited_name is not null and user_id is null and first_entered_at is null and status = 'active'`, [clientIds])).toBe(3);

    // Sessions: the owner of the demo agency has two open, one with a city.
    const ownerProfile = latest.profiles.find((profile) => profile.label === 'Owner' && profile.agencyId === first.agencyIds[0])!;
    const ownerId = await userIdFor(ownerProfile.email);
    expect(await count('select count(*)::text as total from auth."session" where "userId" = ?::uuid and "expiresAt" > now()', [ownerId])).toBeGreaterThanOrEqual(2);
    expect(await count(`select count(*)::text as total from auth."session" where "userId" = ?::uuid and city = 'São Paulo'`, [ownerId])).toBe(1);
    // Three sessions are active by the rule of the guard (made after the last replacement of the credential), on different devices, and
    // one expired more than 30 days ago, which the daily cleanup deletes.
    expect(await count(`select count(*)::text as total from auth."session" "session" where "userId" = ?::uuid and ${ACTIVE_SESSION_SQL}`, [ownerId])).toBe(3);
    expect(await count('select count(distinct "userAgent")::text as total from auth."session" where "userId" = ?::uuid and "expiresAt" > now()', [ownerId])).toBe(3);
    expect(await count(`select count(*)::text as total from auth."session" where "userId" = ?::uuid and "expiresAt" < now() - interval '30 days'`, [ownerId])).toBe(1);

    // Notifications: the owner and a person of the production read their own, some read and some not, of every kind.
    const ownerNotifications = await owner.knex('notifications').where({ recipient_user_id: ownerId }).select('kind', 'read_at');
    expect([...new Set(ownerNotifications.map((row) => row.kind))].sort()).toEqual([
      'approval_deadline_passed', 'content_approved', 'content_changes_requested', 'invitation_accepted', 'material_request_answered'
    ]);
    expect(ownerNotifications.some((row) => row.read_at === null)).toBe(true);
    expect(ownerNotifications.some((row) => row.read_at !== null)).toBe(true);
    const productionProfile = latest.profiles.find((profile) => profile.email.startsWith('producao@') && profile.agencyId === first.agencyIds[0])!;
    const productionNotifications = await owner.knex('notifications').where({ recipient_user_id: await userIdFor(productionProfile.email) }).select('read_at');
    expect(productionNotifications.length).toBeGreaterThanOrEqual(3);
    expect(productionNotifications.some((row) => row.read_at === null)).toBe(true);
    expect(productionNotifications.some((row) => row.read_at !== null)).toBe(true);

    // The person of the portal sent three confirmed files to an open request, in the folder "Enviados pelo cliente", and said so.
    const sent = await owner.knex('media_assets as asset')
      .join('client_threads as thread', 'thread.id', 'asset.material_request_thread_id')
      .join('media_folders as folder', 'folder.id', 'asset.folder_id')
      .whereIn('asset.client_id', clientIds).where({ 'asset.uploaded_by_side': 'client', 'asset.status': 'confirmed' })
      .select('thread.resolved_at', 'folder.name as folder');
    expect(sent).toHaveLength(3);
    expect(sent.every((row) => row.resolved_at === null && row.folder === 'Enviados pelo cliente')).toBe(true);
    expect(await count(`select count(*)::text as total from public.client_thread_comments where client_id = any(?::uuid[]) and author_side = 'client' and body = 'enviou 3 fotos'`, [clientIds])).toBe(1);

    // Personas: none archived (archiving is gone), and one has a conversation with messages, for the confirmation to count.
    expect(await count("select count(*)::text as total from public.client_personas where client_id = any(?::uuid[]) and status <> 'active'", [clientIds])).toBe(0);
    expect(await count(`select count(*)::text as total from public.client_threads thread
      join public.client_thread_comments comment on comment.thread_id = thread.id
      where thread.client_id = any(?::uuid[]) and thread.persona_id is not null`, [clientIds])).toBeGreaterThanOrEqual(2);

    // Approved contents: one still some days from its publication (the portal offers "Pedir ajuste") and one for today (it does not).
    expect(await count(`select count(*)::text as total from public.contents
      where client_id = any(?::uuid[]) and status = 'approved' and publish_on >= app_private.sao_paulo_date(now()) + 2`, [clientIds])).toBeGreaterThanOrEqual(1);
    expect(await count(`select count(*)::text as total from public.contents
      where client_id = any(?::uuid[]) and status = 'approved' and publish_on = app_private.sao_paulo_date(now())`, [clientIds])).toBe(1);
  });

  it('serves the seeded Conteúdo through the agency and the portal routes, as each person may read it (issue #608)', async () => {
    const profile = (label: string): SeedDemoResult['profiles'][number] => latest.profiles.find((candidate) => candidate.label === label)!;
    const [padaria] = await owner.knex('clients').whereIn('id', first.clientIds).where('name', 'Padaria Central').select('id', 'agency_id');
    const clientId = padaria!.id as string;
    const agencyId = padaria!.agency_id as string;
    const today = (await owner.knex.raw<{ rows: Array<{ day: string }> }>('select app_private.sao_paulo_date(now())::text as day')).rows[0]!.day;
    const around = (days: number): string => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const period = `from=${around(-30)}&to=${around(30)}`;
    const get = async (cookie: string, url: string): Promise<{ status: number; body: any }> => { // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
      const response = await app.app.inject({ method: 'GET', url, headers: { ...origin, cookie } });
      return { status: response.statusCode, body: response.json() };
    };
    const admin = await loginCookie(profile('Admin').email, profile('Admin').password);
    const manager = await loginCookie(profile('Gestor de conta').email, profile('Gestor de conta').password);
    const sales = await loginCookie(profile('Vendas').email, profile('Vendas').password);
    const portal = await loginCookie(profile('Portal').email, profile('Portal').password);

    const month = await get(admin, `/agencies/${agencyId}/clients/${clientId}/contents?${period}`);
    expect(month.status).toBe(200);
    expect(month.body.data.contents.map((content: { status: string }) => content.status).sort()).toEqual([
      'adjusting', 'approved', 'approved', 'approved', 'awaiting_approval', 'awaiting_approval', 'cancelled', 'in_production', 'in_production', 'published'
    ]);
    expect(month.body.data.storyScripts).toHaveLength(3);
    const withTasks = month.body.data.contents.find((content: { title: string }) => content.title === 'O segredo da fermentação natural');
    expect(withTasks).toMatchObject({ tasksTotal: 3, tasksApproved: 1 });
    const detail = await get(admin, `/agencies/${agencyId}/clients/${clientId}/contents/${withTasks.id as string}`);
    expect(detail.body.tasks.map((task: { status: string }) => task.status).sort()).toEqual(['approved', 'delivered', 'pending']);

    const folders = await get(admin, `/agencies/${agencyId}/clients/${clientId}/media-folders`);
    expect(folders.status).toBe(200);
    expect(folders.body.data.map((folder: { name: string }) => folder.name)).toEqual(expect.arrayContaining(['Imagens', 'Vídeos', 'Carrosséis', 'Ensaio fotográfico', 'Campanha de Natal', 'Bastidores']));

    // The carteira shows the signals of what was seeded, to who reads Conteúdo, and none to Vendas.
    const carteira = await get(manager, `/agencies/${agencyId}/clients`);
    const indicatorsOf = (name: string): unknown => carteira.body.data.find((client: { name: string }) => client.name === name).contentIndicators;
    expect(indicatorsOf('Padaria Central')).toEqual({ pending: 3, inReview: 2, overdue: 2, adjusting: 1, dueSoon: 3 });
    expect(indicatorsOf('Clínica Viver Bem')).toEqual({ pending: 1, inReview: 1, overdue: 1, adjusting: 0, dueSoon: 2 });
    expect(indicatorsOf('Café do Alto')).toEqual({ pending: 0, inReview: 1, overdue: 0, adjusting: 0, dueSoon: 1 });
    expect((await get(sales, `/agencies/${agencyId}/clients/${clientId}/contents?${period}`)).status).toBe(403);

    // The portal: what waits for the person, the month without the cancelled one, and the script that was sent (never the draft).
    const awaiting = await get(portal, `/clients/${clientId}/contents/awaiting-approval`);
    expect(awaiting.status).toBe(200);
    expect(awaiting.body.data.map((content: { title: string }) => content.title).sort()).toEqual(['O pão de ontem vira torrada', 'Receita de sábado: pão de queijo']);
    const portalMonth = await get(portal, `/clients/${clientId}/contents?${period}`);
    expect(portalMonth.status).toBe(200);
    expect(portalMonth.body.data).toHaveLength(9);
    expect(JSON.stringify(portalMonth.body)).not.toContain('Campanha de aniversário');
    const scripts = await get(portal, `/clients/${clientId}/story-scripts?${period}`);
    expect(scripts.status).toBe(200);
    expect(scripts.body.data.map((script: { status: string }) => script.status).sort()).toEqual(['recorded', 'sent']);
  });

  it('every printed profile signs in and sees only what its role allows', async () => {
    const catalog = await catalogKeys();
    expect(latest.profiles).toHaveLength(9);
    for (const profile of latest.profiles) {
      const cookie = await loginCookie(profile.email, profile.password);
      const userId = await userIdFor(profile.email);
      const contexts = await contextsFor(cookie);

      if (profile.agencyId !== null) {
        const context = contexts.find((entry) => entry.type === 'agency' && entry.agencyId === profile.agencyId);
        expect(context, `agency context for ${profile.email}`).toBeDefined();
        const ownerRow = await owner.knex('agencies').where({ id: profile.agencyId }).first('owner_user_id');
        const verdicts = await permissionVerdicts(userId, profile.agencyId);
        if (ownerRow?.owner_user_id === userId) {
          expect(context!.isOwner).toBe(true);
          expectSamePermissions(verdicts, catalog);
        } else {
          const roleKey = await roleKeyFor(profile.agencyId, userId);
          expect(roleKey, `role for ${profile.email}`).toBeDefined();
          expect(context!.roleKey).toBe(roleKey);
          expectSamePermissions(verdicts, await presetKeys(roleKey!));
        }
      } else {
        // The portal profile has exactly its client context and no agency permission at all.
        expect(contexts).toEqual([expect.objectContaining({ type: 'client', clientId: profile.clientId })]);
        const client = await owner.knex('clients').where({ id: profile.clientId! }).first('agency_id');
        const verdicts = await permissionVerdicts(userId, client!.agency_id as string);
        expectSamePermissions(verdicts, []);
      }
    }
  });

  it('serves the seeded brand study through the agency and the portal routes (issue #471)', async () => {
    // The seeded colors once used Portuguese keys, which the strict `BrandColorSchema` refuses: the
    // study answered 500 for every seeded client that has the colors section. Reading it through the
    // real routes (not counting rows) is what catches a seed shape the contract does not accept.
    const portalProfile = latest.profiles.find((profile) => profile.agencyId === null)!;
    const portalCookie = await loginCookie(portalProfile.email, portalProfile.password);

    const portal = await app.app.inject({ method: 'GET', url: `/clients/${portalProfile.clientId!}/brand-study`, headers: { ...origin, cookie: portalCookie } });
    expect(portal.statusCode).toBe(200);
    const portalStudy = portal.json<{ filled: number; sections: { key: string; colors: unknown }[] }>();
    expect(portalStudy.filled).toBe(7);
    expect(portalStudy.sections.find((section) => section.key === 'colors')?.colors).toEqual([
      { name: 'Vermelho terracota', hex: '#B4472F' },
      { name: 'Creme de trigo', hex: '#F3E3C3' }
    ]);

    // The agency side, for the portal client and for the second seeded client that has colors.
    const colorRows = await owner.knex('client_brand_sections')
      .join('clients', 'clients.id', 'client_brand_sections.client_id')
      .whereIn('client_brand_sections.client_id', first.clientIds)
      .where('client_brand_sections.section_key', 'colors')
      .select('client_brand_sections.client_id', 'clients.agency_id', 'clients.name');
    expect(colorRows.map((row) => row.name as string).sort()).toEqual(['Café do Alto', 'Padaria Central']);
    for (const row of colorRows) {
      const adminProfile = latest.profiles.find((profile) => profile.agencyId === row.agency_id && profile.label === 'Owner')!;
      const adminCookie = await loginCookie(adminProfile.email, adminProfile.password);
      const response = await app.app.inject({
        method: 'GET',
        url: `/agencies/${row.agency_id as string}/clients/${row.client_id as string}/brand-study`,
        headers: { ...origin, cookie: adminCookie }
      });
      expect(response.statusCode, `brand study of ${row.name as string}`).toBe(200);
      const colors = response.json<{ sections: { key: string; colors: unknown[] | null }[] }>().sections.find((section) => section.key === 'colors')?.colors;
      expect(colors, `colors of ${row.name as string}`).toHaveLength(2);
      for (const color of colors!) expect(Object.keys(color as object).sort()).toEqual(['hex', 'name']);
    }
  });

  it('running the seed again repairs colors that drifted from the seed, deleting nothing (issues #471 and #476)', async () => {
    const [padaria] = await owner.knex('client_brand_sections')
      .whereIn('client_id', first.clientIds)
      .where('section_key', 'colors')
      .join('clients', 'clients.id', 'client_brand_sections.client_id')
      .where('clients.name', 'Padaria Central')
      .select('client_brand_sections.client_id');
    const clientId = padaria!.client_id as string;
    // The old { nome, codigoHexadecimal } shape can no longer be stored (client_brand_sections_colors_format, #476),
    // so the stale row is one in the contract's shape whose values the seed no longer writes.
    await owner.knex.raw(
      `update public.client_brand_sections set colors = '[{"name":"Antiga","hex":"#000000"}]'::jsonb where client_id = ? and section_key = 'colors'`,
      [clientId]
    );
    const rowsBefore = await count('select count(*)::text as total from public.client_brand_sections where client_id = any(?::uuid[])', [first.clientIds]);

    latest = await runSeedDemo(runOptions);

    const repaired = await owner.knex('client_brand_sections').where({ client_id: clientId, section_key: 'colors' }).first('colors');
    expect(repaired?.colors).toEqual([
      { name: 'Vermelho terracota', hex: '#B4472F' },
      { name: 'Creme de trigo', hex: '#F3E3C3' }
    ]);
    expect(await count('select count(*)::text as total from public.client_brand_sections where client_id = any(?::uuid[])', [first.clientIds])).toBe(rowsBefore);
  });

  it('running again after a content was moved through the route leaves it where it is, and adds nothing (issue #608)', async () => {
    const [content] = await owner.knex('contents').whereIn('client_id', first.clientIds).where('title', 'Promoção da semana: combo café e pão').select('id', 'client_id');
    const [client] = await owner.knex('clients').where('id', content!.client_id as string).select('agency_id');
    const admin = latest.profiles.find((candidate) => candidate.label === 'Admin')!;
    const cookie = await loginCookie(admin.email, admin.password);
    const cancelled = await app.app.inject({
      method: 'POST',
      url: `/agencies/${client!.agency_id as string}/clients/${content!.client_id as string}/contents/${content!.id as string}/cancel`,
      headers: { ...origin, cookie }
    });
    expect(cancelled.statusCode).toBe(200);
    const before = await count('select count(*)::text as total from public.contents where client_id = any(?::uuid[])', [first.clientIds]);

    latest = await runSeedDemo(runOptions);

    expect(await count('select count(*)::text as total from public.contents where client_id = any(?::uuid[])', [first.clientIds])).toBe(before);
    expect((await owner.knex('contents').where({ id: content!.id }).first('status'))?.status).toBe('cancelled');
  });

  it('running the seed again finds a persona by its name and brings its text back, without a second one (issue #601)', async () => {
    const before = await count('select count(*)::text as total from public.client_personas where client_id = any(?::uuid[])', [first.clientIds]);
    const [persona] = await owner.knex('client_personas').whereIn('client_id', first.clientIds).where({ name: 'Moradora do bairro' }).select('id', 'description');
    expect(persona?.description).toBe('Trabalha perto, passa a pé todos os dias e compra para levar.');
    await owner.knex('client_personas').where({ id: persona!.id }).update({ description: 'Texto que a demonstração não escreve' });

    latest = await runSeedDemo(runOptions);

    const repaired = await owner.knex('client_personas').where({ id: persona!.id }).first('description');
    expect(repaired?.description).toBe('Trabalha perto, passa a pé todos os dias e compra para levar.');
    expect(await count('select count(*)::text as total from public.client_personas where client_id = any(?::uuid[])', [first.clientIds])).toBe(before);
  });

  it('rotating a demo password ends the previous session', async () => {
    const profile = latest.profiles[0]!;
    const staleCookie = await loginCookie(profile.email, profile.password);

    latest = await runSeedDemo(runOptions);

    const stale = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie: staleCookie } });
    expect(stale.statusCode).toBe(401);
    const refreshed = latest.profiles.find((candidate) => candidate.email === profile.email)!;
    expect(refreshed.password).not.toBe(profile.password);
    await loginCookie(refreshed.email, refreshed.password);
  });

  it('recreates a membership removed by hand instead of colliding on the invitation hash', async () => {
    // The old deterministic token hash made this fail with a unique violation: the used invitation
    // kept the same hash. Random hashes let the seed invite the person again, like a resend does.
    const profile = latest.profiles.find((candidate) => candidate.email.startsWith('producao@'))!;
    const userId = await userIdFor(profile.email);
    await owner.knex('agency_memberships').where({ agency_id: profile.agencyId!, user_id: userId }).update({ status: 'removed' });

    latest = await runSeedDemo(runOptions);

    const membership = await owner.knex('agency_memberships').where({ agency_id: profile.agencyId!, user_id: userId }).first('status');
    expect(membership?.status).toBe('active');
    const refreshed = latest.profiles.find((candidate) => candidate.email === profile.email)!;
    await loginCookie(refreshed.email, refreshed.password);
  });
});
