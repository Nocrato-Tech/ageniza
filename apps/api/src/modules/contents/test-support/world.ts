import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestAppOptions
} from '../../auth/test-support/harness.js';

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

export type PersonKey =
  | 'admin' | 'manager' | 'production' | 'sales' | 'finance' | 'owner'
  | 'reader' | 'operateOnly' | 'noContent' | 'adminB' | 'dual' | 'approver';

export interface SeedContent {
  readonly status?: 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
  readonly format?: 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';
  readonly title?: string;
  readonly folderId?: string;
  readonly ownerUserId?: string;
  readonly caption?: string | null;
  readonly publishOn?: string;
  readonly publishAtTime?: string | null;
  readonly coverAssetId?: string;
}

const origin = { origin: TEST_APP_PUBLIC_URL };

/**
 * The people, tenants and rows the contents routes are attacked with. Every person holds the permissions of one
 * thing and nothing else (a custom role with one or two keys), because an admin holds every key and would hide a
 * guard on the wrong one. The statements the module sends are recorded, and a test can run an action right before
 * one of them to sequence a race by the statement and never by a sleep.
 */
export const createContentsWorld = (label: string) => {
  let owner: DatabaseClient;
  let app: TestApp;
  const statements: string[] = [];
  let beforeStatement: { readonly matches: RegExp; readonly action: () => Promise<void> } | undefined;

  const createdUserIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdAssetIds: string[] = [];
  const agencyA = randomUUID();
  const agencyB = randomUUID();
  const people = {} as Record<PersonKey, { id: string; cookie: string }>;
  let approverRoleId = '';

  const instrument = (database: DatabaseClient): DatabaseClient => {
    const recording = (transaction: Transaction): Transaction => new Proxy(transaction, {
      get(target, property, receiver) {
        if (property === 'raw') {
          return async (statement: string, bindings?: Parameters<Transaction['raw']>[1]) => {
            statements.push(statement);
            const pending = beforeStatement;
            if (pending !== undefined && pending.matches.test(statement)) {
              beforeStatement = undefined;
              await pending.action();
            }
            return target.raw(statement, bindings ?? []);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (work: (transaction: Transaction) => Promise<unknown>) => target.transaction((transaction) => work(recording(transaction)));
        }
        // Knex is itself a function with properties (`raw`): bound, it would lose them.
        if (property === 'knex') return target.knex;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
  };

  const call = async (method: 'GET' | 'POST' | 'PATCH', cookie: string, url: string, payload?: unknown): Promise<Reply> =>
    (await app.app.inject({
      method,
      url,
      headers: { ...origin, cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
    })) as unknown as Reply;

  const customRole = async (agencyId: string, keys: readonly string[]): Promise<string> => {
    const id = randomUUID();
    createdRoleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `${label}-${id}`, name: keys.join(' + '), is_system: false });
    await owner.knex('role_permissions').insert(keys.map((key) => ({ role_id: id, permission_key: key })));
    return id;
  };

  const login = async (person: { email: string; password: string }): Promise<string> => {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: person.email, password: person.password } });
    if (response.statusCode !== 200) throw new Error(`Login failed with ${response.statusCode}.`);
    return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  };

  const folderOf = async (clientId: string): Promise<string> => {
    const existing = await owner.knex('media_folders').where({ client_id: clientId }).orderBy('created_at').first('id');
    if (existing !== undefined) return existing.id as string;
    const id = randomUUID();
    await owner.knex('media_folders').insert({ id, client_id: clientId, name: 'Vídeos', is_default: false });
    return id;
  };

  const newFolder = async (clientId: string, name: string): Promise<string> => {
    const id = randomUUID();
    await owner.knex('media_folders').insert({ id, client_id: clientId, name, is_default: false });
    return id;
  };

  const newClient = async (clientLabel: string, input: { agencyId?: string; status?: 'active' | 'archived' } = {}): Promise<string> => {
    const id = randomUUID();
    createdClientIds.push(id);
    await owner.knex('clients').insert({
      id,
      agency_id: input.agencyId ?? agencyA,
      name: `Contents ${label} ${clientLabel} ${id}`,
      status: input.status ?? 'active',
      archived_at: input.status === 'archived' ? new Date() : null
    });
    return id;
  };

  const seedAsset = async (
    clientId: string,
    folderId: string,
    extra: { category?: 'image' | 'video'; status?: 'pending' | 'confirmed'; removed?: boolean; video?: 'pending' | 'ready' | 'failed' } = {}
  ): Promise<string> => {
    const id = randomUUID();
    const category = extra.category ?? 'image';
    const agency = await owner.knex('clients').where({ id: clientId }).first('agency_id');
    const agencyId = agency?.agency_id as string;
    const extension = category === 'image' ? 'png' : 'mp4';
    createdAssetIds.push(id);
    await owner.knex('media_assets').insert({
      id,
      agency_id: agencyId,
      client_id: clientId,
      folder_id: folderId,
      category,
      declared_content_type: category === 'image' ? 'image/png' : 'video/mp4',
      extension,
      object_key: `${agencyId}/${id}/original.${extension}`,
      upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
      declared_size_bytes: 1_000,
      created_by_user_id: people.admin.id,
      ...((extra.status ?? 'confirmed') === 'confirmed'
        ? { status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: category === 'image' ? 'image/png' : 'video/mp4', confirmed_at: new Date() }
        : {}),
      ...(extra.removed === true ? { removed_at: new Date() } : {}),
      ...(extra.video === undefined ? {} : { video_processing_status: extra.video }),
      ...(extra.video === 'ready'
        ? { thumbnail_object_key: `${agencyId}/${id}/thumbnail.jpg`, preview_object_key: `${agencyId}/${id}/preview.mp4`, video_duration_seconds: 12 }
        : {}),
      ...(extra.video === 'failed' ? { video_processing_error: 'processing_failed' } : {})
    });
    return id;
  };

  const seedContent = async (clientId: string, extra: SeedContent = {}): Promise<string> => {
    const id = randomUUID();
    const status = extra.status ?? 'in_production';
    await owner.knex('contents').insert({
      id,
      client_id: clientId,
      title: extra.title ?? `Conteúdo ${id.slice(0, 8)}`,
      platform: 'instagram',
      format: extra.format ?? 'reels',
      publish_on: extra.publishOn ?? '2026-10-20',
      publish_at_time: extra.publishAtTime === undefined ? '18:30' : extra.publishAtTime,
      caption: extra.caption === undefined ? 'Legenda original' : extra.caption,
      folder_id: extra.folderId ?? await folderOf(clientId),
      owner_user_id: extra.ownerUserId ?? people.production.id,
      ...(extra.coverAssetId === undefined ? {} : { cover_asset_id: extra.coverAssetId }),
      status,
      ...(status === 'approved' || status === 'published' ? { approved_by: people.admin.id, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {}),
      ...(status === 'published' ? { published_on: '2026-10-06', published_at: new Date('2026-10-06T15:00:00.000Z') } : {}),
      ...(status === 'cancelled' ? { cancelled_at: new Date('2026-10-05T12:00:00.000Z') } : {})
    });
    return id;
  };

  const attach = async (contentId: string, assetIds: readonly string[]): Promise<void> => {
    const content = await owner.knex('contents').where({ id: contentId }).first('client_id', 'folder_id');
    await owner.knex('content_media').insert(assetIds.map((assetId, index) => ({
      content_id: contentId, asset_id: assetId, client_id: content?.client_id as string, folder_id: content?.folder_id as string, position: index + 1
    })));
  };

  const seedTask = async (contentId: string, status: 'pending' | 'delivered' | 'approved' = 'pending'): Promise<string> => {
    const id = randomUUID();
    const content = await owner.knex('contents').where({ id: contentId }).first('client_id');
    await owner.knex('content_tasks').insert({
      id,
      content_id: contentId,
      client_id: content?.client_id as string,
      title: `Subtarefa ${id.slice(0, 8)}`,
      assignee_user_id: people.production.id,
      due_on: '2026-10-15',
      status,
      ...(status === 'approved' ? { approved_by: people.admin.id, approved_at: new Date('2026-10-06T12:00:00.000Z') } : {})
    });
    return id;
  };

  const seedScript = async (clientId: string, scriptOn: string, status: 'draft' | 'sent' | 'recorded' = 'draft'): Promise<string> => {
    const id = randomUUID();
    await owner.knex('story_scripts').insert({
      id,
      client_id: clientId,
      script_on: scriptOn,
      status,
      ...(status === 'recorded' ? { recorded_by: people.admin.id, recorded_at: new Date() } : {})
    });
    return id;
  };

  const contentRow = async (id: string): Promise<Record<string, unknown>> => {
    const row = await owner.knex('contents').where({ id }).first();
    if (row === undefined) throw new Error(`Content ${id} does not exist.`);
    return row as Record<string, unknown>;
  };

  const publishOnOf = async (id: string): Promise<string> => {
    const result = await owner.knex.raw<{ rows: Array<{ day: string }> }>('select publish_on::text as day from public.contents where id = ?::uuid', [id]);
    return result.rows[0]?.day as string;
  };

  const countContents = async (clientId: string): Promise<number> =>
    Number((await owner.knex('contents').where({ client_id: clientId }).count<Array<{ count: string }>>('id as count'))[0]?.count ?? 0);

  return {
    agencyA,
    agencyB,
    people,
    statements,
    call,
    customRole,
    folderOf,
    newFolder,
    newClient,
    seedAsset,
    seedContent,
    attach,
    seedTask,
    seedScript,
    contentRow,
    publishOnOf,
    countContents,
    getApproverRoleId: (): string => approverRoleId,
    getOwner: (): DatabaseClient => owner,
    getApp: (): TestApp => app,
    /** Runs `action` right before the next statement that matches, so a race is ordered by the statement and not by a sleep. */
    runBeforeStatement(matches: RegExp, action: () => Promise<void>): void {
      beforeStatement = { matches, action };
    },
    clearHook(): void {
      beforeStatement = undefined;
    },
    mentionsContents: (): boolean => statements.some((statement) => /public\.contents\b/.test(statement)),

    async setup(options: { readonly contentsClock?: () => Date; readonly wrapMediaStorage?: TestAppOptions['wrapMediaStorage'] } = {}): Promise<void> {
      owner = ownerClient();
      app = await buildTestApp({
        sender: createFakeEmailSender(),
        wrapDatabase: instrument,
        ...(options.contentsClock === undefined ? {} : { contentsClock: options.contentsClock }),
        ...(options.wrapMediaStorage === undefined ? {} : { wrapMediaStorage: options.wrapMediaStorage })
      });

      const system = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
      const systemRole = (key: string): string => {
        const role = system.find((candidate) => candidate.key === key);
        if (role === undefined) throw new Error(`Missing system role ${key}.`);
        return role.id as string;
      };

      const keys: PersonKey[] = ['admin', 'manager', 'production', 'sales', 'finance', 'owner', 'reader', 'operateOnly', 'noContent', 'adminB', 'dual', 'approver'];
      const fixtures = new Map<PersonKey, Awaited<ReturnType<typeof insertTestUser>>>();
      for (const key of keys) {
        const user = await insertTestUser(app.pool, app.auth, { emailLabel: `${label}-${key.toLowerCase()}`, name: `Pessoa ${key}` });
        createdUserIds.push(user.id);
        fixtures.set(key, user);
        people[key] = { id: user.id, cookie: '' };
      }

      await owner.knex('agencies').insert([
        { id: agencyA, name: `Contents ${label} A`, owner_user_id: people.owner.id },
        { id: agencyB, name: `Contents ${label} B`, owner_user_id: null }
      ]);

      const member = (agencyId: string, key: PersonKey, roleId: string) =>
        owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: people[key].id, role_id: roleId });
      await member(agencyA, 'admin', systemRole('admin'));
      await member(agencyA, 'manager', systemRole('account_manager'));
      await member(agencyA, 'production', systemRole('production'));
      await member(agencyA, 'sales', systemRole('sales'));
      await member(agencyA, 'finance', systemRole('finance'));
      await member(agencyA, 'reader', await customRole(agencyA, ['conteudo.visualizar']));
      await member(agencyA, 'operateOnly', await customRole(agencyA, ['conteudo.operar']));
      await member(agencyA, 'noContent', await customRole(agencyA, ['cliente.visualizar']));
      approverRoleId = await customRole(agencyA, ['conteudo.operar', 'conteudo.visualizar', 'conteudo.aprovar_pela_agencia']);
      await member(agencyA, 'approver', approverRoleId);
      await member(agencyA, 'dual', systemRole('admin'));
      await member(agencyB, 'dual', systemRole('admin'));
      await member(agencyB, 'adminB', systemRole('admin'));

      for (const key of keys) people[key].cookie = await login(fixtures.get(key)!);
    },

    async teardown(): Promise<void> {
      const clients = createdClientIds;
      await owner.knex('client_thread_comments').whereIn('client_id', clients).delete();
      await owner.knex('client_threads').whereIn('client_id', clients).delete();
      await owner.knex('content_media').whereIn('client_id', clients).delete();
      await owner.knex('content_tasks').whereIn('client_id', clients).delete();
      await owner.knex('contents').whereIn('client_id', clients).delete();
      await owner.knex('story_script_scenes').whereIn('client_id', clients).delete();
      await owner.knex('story_scripts').whereIn('client_id', clients).delete();
      await owner.knex('media_assets').whereIn('id', createdAssetIds).delete();
      await owner.knex('media_folders').whereIn('client_id', clients).delete();
      await owner.knex('clients').whereIn('id', clients).delete();
      await owner.knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
      await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
      await owner.knex('roles').whereIn('id', createdRoleIds).delete();
      await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).update({ owner_user_id: null });
      await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
      await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
      await app.close();
      await owner.close();
    }
  };
};

export type ContentsWorld = ReturnType<typeof createContentsWorld>;
