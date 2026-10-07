import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../../src/index.js';

// The people, agencies and clients every Conteúdo test attacks from. "Dual" people are agency collaborators who
// also hold a link to a client: RLS answers WHO may read, not through WHICH SIDE, so each rule of the portal is
// attacked again with a person who has the link and a role of the agency (`dualFull`), a person who has the link
// and a role without any conteudo.* (`dualBare`), and a person of another agency who has a link to a client here
// (`crossDual`). A custom role holding one permission stands in for each guard, because the Admin holds every
// permission and hides a guard written with the wrong one.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

export const CONTENT_PERMISSIONS = [
  'conteudo.visualizar',
  'conteudo.operar',
  'conteudo.publicar',
  'conteudo.aprovar_pela_agencia',
  'conteudo.cancelar'
] as const;

export type ContentStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
export type ContentFormat = 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';

export interface ContentWorld {
  readonly ids: Record<
    | 'agencyA' | 'agencyB' | 'agencySuspended'
    | 'ownerA' | 'adminA' | 'productionA' | 'managerA' | 'salesA' | 'financeA' | 'adminB' | 'adminSuspended'
    | 'dualBare' | 'dualFull' | 'dualRemoved' | 'crossDual'
    | 'portalA1' | 'portalA1Second' | 'portalA2' | 'portalB' | 'portalArchived' | 'portalSuspended'
    | 'clientA1' | 'clientA2' | 'clientArchived' | 'clientB' | 'clientSuspended',
    string
  >;
  getOwner(): DatabaseClient;
  asUser<TResult>(userId: string, work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult>;
  openTransactionAs(userId: string): Promise<Knex.Transaction>;
  /** A person of agency A who holds exactly the permissions given. */
  personWith(...permissions: string[]): Promise<string>;
  /** A person of agency A who holds every conteudo.* permission except the one given. */
  personWithAllBut(permission: string): Promise<string>;
  folderOf(clientId: string, name?: string): Promise<string>;
  seedAsset(clientId: string, folderId: string, extra?: { category?: 'image' | 'video'; status?: 'pending' | 'confirmed' | 'rejected'; removed?: boolean }): Promise<string>;
  seedContent(clientId: string, extra?: SeedContent): Promise<string>;
  attach(contentId: string, assetIds: readonly string[]): Promise<void>;
  contentRow(id: string): Promise<Record<string, unknown>>;
  taskRow(id: string): Promise<Record<string, unknown>>;
  seedTask(contentId: string, extra?: { assignee?: string; status?: 'pending' | 'delivered' | 'approved'; dueOn?: string }): Promise<string>;
  /** A task of a content that is already published or cancelled: the guard refuses to insert one there, so the content is closed after. */
  seedTaskOfClosedContent(clientId: string, closed: 'published' | 'cancelled', taskStatus?: 'pending' | 'delivered' | 'approved'): Promise<string>;
  archiveClient(clientId: string): Promise<void>;
  columnsWithPrivilege(table: string, privilege: 'insert' | 'update'): Promise<string[]>;
  tablePrivileges(table: string): Promise<Record<string, boolean>>;
  waitUntilSomeoneWaitsOnALock(): Promise<void>;
  reactivateClient(clientId: string): Promise<void>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

export interface SeedContent {
  readonly status?: ContentStatus;
  readonly format?: ContentFormat;
  readonly folderId?: string;
  readonly owner?: string;
  readonly caption?: string | null;
  readonly publishOn?: string;
  readonly publishAtTime?: string;
  readonly publishedAt?: Date;
  readonly approvedBy?: string;
  readonly coverAssetId?: string;
}

const uuid = (): string => randomUUID();

export const createContentWorld = (label: string): ContentWorld => {
  let owner: DatabaseClient | undefined;
  let application: DatabaseClient | undefined;

  const ids = {
    agencyA: uuid(), agencyB: uuid(), agencySuspended: uuid(),
    ownerA: uuid(), adminA: uuid(), productionA: uuid(), managerA: uuid(), salesA: uuid(), financeA: uuid(), adminB: uuid(), adminSuspended: uuid(),
    dualBare: uuid(), dualFull: uuid(), dualRemoved: uuid(), crossDual: uuid(),
    portalA1: uuid(), portalA1Second: uuid(), portalA2: uuid(), portalB: uuid(), portalArchived: uuid(), portalSuspended: uuid(),
    clientA1: uuid(), clientA2: uuid(), clientArchived: uuid(), clientB: uuid(), clientSuspended: uuid()
  };
  const clients = [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended];
  const agencies = [ids.agencyA, ids.agencyB, ids.agencySuspended];
  const extraUsers: string[] = [];
  const roleIds: string[] = [];
  const assetIds: string[] = [];
  const contentIds: string[] = [];
  const allUsers = (): string[] => [
    ...Object.entries(ids).filter(([key]) => !/^(agency|client)/.test(key)).map(([, value]) => value),
    ...extraUsers
  ];

  const getOwner = (): DatabaseClient => {
    if (owner === undefined) throw new Error('Owner database client was not initialized.');
    return owner;
  };
  const getApplication = (): DatabaseClient => {
    if (application === undefined) throw new Error('Application database client was not initialized.');
    return application;
  };

  const asUser = <TResult>(userId: string, work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult> =>
    withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

  const openTransactionAs = async (userId: string): Promise<Knex.Transaction> => {
    const transaction = await getApplication().knex.transaction();
    await transaction.raw('select app_private.bind_actor(?::uuid)', [userId]);
    return transaction;
  };

  const presetRole = async (key: string): Promise<string> => {
    const role = await getOwner().knex('roles').whereNull('agency_id').where({ key }).first('id');
    if (role === undefined) throw new Error(`System role ${key} is missing.`);
    return role.id as string;
  };

  const personWith = async (...permissions: string[]): Promise<string> => {
    const roleId = uuid();
    const userId = uuid();
    roleIds.push(roleId);
    extraUsers.push(userId);
    await getOwner().transaction(async (transaction) => {
      await transaction('auth.user').insert({ id: userId, name: `User ${userId}`, email: `${userId}@${label}.test`, emailVerified: true });
      await transaction('roles').insert({ id: roleId, agency_id: ids.agencyA, key: `custom-${roleId.slice(0, 8)}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
      if (permissions.length > 0) {
        await transaction('role_permissions').insert(permissions.map((permission) => ({ role_id: roleId, permission_key: permission })));
      }
      await transaction('agency_memberships').insert({ agency_id: ids.agencyA, user_id: userId, role_id: roleId });
    });
    return userId;
  };

  const personWithAllBut = (permission: string): Promise<string> =>
    personWith(...CONTENT_PERMISSIONS.filter((candidate) => candidate !== permission));

  const folderOf = async (clientId: string, name = 'Vídeos'): Promise<string> => {
    const folder = await getOwner().knex('media_folders').where({ client_id: clientId, name, is_default: true }).first('id');
    if (folder === undefined) throw new Error(`Default folder ${name} is missing for ${clientId}.`);
    return folder.id as string;
  };

  const seedAsset: ContentWorld['seedAsset'] = async (clientId, folderId, extra = {}) => {
    const id = uuid();
    const category = extra.category ?? 'image';
    const confirmed = (extra.status ?? 'confirmed') === 'confirmed';
    const agencyId = clientId === ids.clientB ? ids.agencyB : clientId === ids.clientSuspended ? ids.agencySuspended : ids.agencyA;
    const extension = category === 'image' ? 'png' : 'mp4';
    assetIds.push(id);
    await getOwner().knex('media_assets').insert({
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
      created_by_user_id: ids.adminA,
      ...(confirmed ? { status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: category === 'image' ? 'image/png' : 'video/mp4', confirmed_at: new Date() } : {}),
      ...(extra.status === 'rejected' ? { status: 'rejected', rejected_reason: 'Formato inválido' } : {}),
      ...(extra.removed === true ? { removed_at: new Date() } : {})
    });
    return id;
  };

  const seedContent: ContentWorld['seedContent'] = async (clientId, extra = {}) => {
    const id = uuid();
    const status = extra.status ?? 'in_production';
    const approvedStates: readonly ContentStatus[] = ['approved', 'published'];
    contentIds.push(id);
    await getOwner().knex('contents').insert({
      id,
      client_id: clientId,
      title: `Conteúdo ${id.slice(0, 8)}`,
      platform: 'instagram',
      format: extra.format ?? 'reels',
      publish_on: extra.publishOn ?? '2026-10-20',
      publish_at_time: extra.publishAtTime ?? '18:30',
      caption: extra.caption === undefined ? 'Legenda original' : extra.caption,
      folder_id: extra.folderId ?? await folderOf(clientId),
      owner_user_id: extra.owner ?? ids.productionA,
      ...(extra.coverAssetId === undefined ? {} : { cover_asset_id: extra.coverAssetId }),
      status,
      ...(approvedStates.includes(status) ? { approved_by: extra.approvedBy ?? ids.portalA1, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {}),
      ...(status === 'published' ? { published_on: '2026-10-06', published_at: extra.publishedAt ?? new Date() } : {}),
      ...(status === 'cancelled' ? { cancelled_at: new Date('2026-10-05T12:00:00.000Z') } : {})
    });
    return id;
  };

  const attach: ContentWorld['attach'] = async (contentId, assetIdList) => {
    if (assetIdList.length === 0) return;
    const content = await getOwner().knex('contents').where({ id: contentId }).first('client_id', 'folder_id');
    await getOwner().knex('content_media').insert(assetIdList.map((assetId, index) => ({
      content_id: contentId, asset_id: assetId, client_id: content?.client_id as string, folder_id: content?.folder_id as string, position: index + 1
    })));
  };

  const contentRow: ContentWorld['contentRow'] = async (id) => {
    const row = await getOwner().knex('contents').where({ id }).first();
    if (row === undefined) throw new Error(`Content ${id} does not exist.`);
    return row as Record<string, unknown>;
  };

  const taskRow: ContentWorld['taskRow'] = async (id) => {
    const row = await getOwner().knex('content_tasks').where({ id }).first();
    if (row === undefined) throw new Error(`Task ${id} does not exist.`);
    return row as Record<string, unknown>;
  };

  const seedTask: ContentWorld['seedTask'] = async (contentId, extra = {}) => {
    const id = uuid();
    const content = await getOwner().knex('contents').where({ id: contentId }).first('client_id');
    await getOwner().knex('content_tasks').insert({
      id,
      content_id: contentId,
      client_id: content?.client_id as string,
      title: `Subtarefa ${id.slice(0, 8)}`,
      assignee_user_id: extra.assignee ?? ids.productionA,
      due_on: extra.dueOn ?? '2026-10-15',
      status: extra.status ?? 'pending',
      ...(extra.status === 'approved' ? { approved_by: ids.adminA, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {})
    });
    return id;
  };

  return {
    ids,
    getOwner,
    asUser,
    openTransactionAs,
    personWith,
    personWithAllBut,
    folderOf,
    seedAsset,
    seedContent,
    attach,
    contentRow,
    taskRow,
    seedTask,
    columnsWithPrivilege: async (table, privilege) => {
      const target = `public.${table}`;
      const { rows } = await getOwner().knex.raw<{ rows: Array<{ column_name: string }> }>(`
        select a.attname as column_name
        from pg_catalog.pg_attribute a
        where a.attrelid = ?::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('ageniza_app', ?::regclass, a.attnum, ?)
        order by a.attname
      `, [target, target, privilege]);
      return rows.map((row) => row.column_name);
    },
    tablePrivileges: async (table) => {
      const target = `public.${table}`;
      const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
        select
          has_table_privilege('ageniza_app', ?, 'select') as can_select,
          has_table_privilege('ageniza_app', ?, 'insert') as table_insert,
          has_table_privilege('ageniza_app', ?, 'update') as table_update,
          has_table_privilege('ageniza_app', ?, 'delete') as can_delete,
          has_table_privilege('ageniza_app', ?, 'truncate') as can_truncate
      `, [target, target, target, target, target]);
      return rows[0] ?? {};
    },
    waitUntilSomeoneWaitsOnALock: async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(
          "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"
        );
        if (Number(waiting.rows[0]?.count) >= 1) return;
        if (Date.now() > deadline) throw new Error('Nothing ever queued behind the lock.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    seedTaskOfClosedContent: async (clientId, closed, taskStatus = 'pending') => {
      const contentId = await seedContent(clientId, { status: 'approved' });
      const taskId = await seedTask(contentId, { status: taskStatus });
      await getOwner().transaction(async (transaction) => {
        await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
        await transaction('contents').where({ id: contentId }).update(
          closed === 'published' ? { status: 'published', published_on: transaction.raw("(now() at time zone 'America/Sao_Paulo')::date") } : { status: 'cancelled' }
        );
      });
      return taskId;
    },
    archiveClient: async (clientId) => {
      await getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
    },
    reactivateClient: async (clientId) => {
      await getOwner().knex('clients').where({ id: clientId }).update({ status: 'active', archived_at: null });
    },
    setup: async () => {
      owner = createLocalTestDatabaseClient(ownerUrl);
      application = createLocalTestDatabaseClient(applicationUrl);
      const [admin, production, sales, finance, manager] = await Promise.all(['admin', 'production', 'sales', 'finance', 'account_manager'].map(presetRole));

      await getOwner().transaction(async (transaction) => {
        await transaction('auth.user').insert(
          allUsers().map((id) => ({ id, name: `User ${id}`, email: `${id}@${label}.test`, emailVerified: true }))
        );
        await transaction('agencies').insert([
          { id: ids.agencyA, name: `${label} A ${ids.agencyA}`, owner_user_id: ids.ownerA },
          { id: ids.agencyB, name: `${label} B ${ids.agencyB}` },
          { id: ids.agencySuspended, name: `${label} suspensa ${ids.agencySuspended}` }
        ]);
        await transaction('agency_memberships').insert([
          { agency_id: ids.agencyA, user_id: ids.adminA, role_id: admin },
          { agency_id: ids.agencyA, user_id: ids.productionA, role_id: production },
          { agency_id: ids.agencyA, user_id: ids.managerA, role_id: manager },
          { agency_id: ids.agencyA, user_id: ids.salesA, role_id: sales },
          { agency_id: ids.agencyA, user_id: ids.financeA, role_id: finance },
          { agency_id: ids.agencyB, user_id: ids.adminB, role_id: admin },
          { agency_id: ids.agencySuspended, user_id: ids.adminSuspended, role_id: admin },
          { agency_id: ids.agencyA, user_id: ids.dualBare, role_id: sales },
          { agency_id: ids.agencyA, user_id: ids.dualFull, role_id: production },
          { agency_id: ids.agencyA, user_id: ids.dualRemoved, role_id: admin },
          { agency_id: ids.agencyB, user_id: ids.crossDual, role_id: admin }
        ]);
        await transaction('clients').insert([
          { id: ids.clientA1, agency_id: ids.agencyA, name: `Cliente A1 ${ids.clientA1}` },
          { id: ids.clientA2, agency_id: ids.agencyA, name: `Cliente A2 ${ids.clientA2}` },
          { id: ids.clientArchived, agency_id: ids.agencyA, name: `Cliente arquivado ${ids.clientArchived}` },
          { id: ids.clientB, agency_id: ids.agencyB, name: `Cliente B ${ids.clientB}` },
          { id: ids.clientSuspended, agency_id: ids.agencySuspended, name: `Cliente suspenso ${ids.clientSuspended}` }
        ]);
        await transaction('client_memberships').insert([
          { client_id: ids.clientA1, user_id: ids.portalA1 },
          { client_id: ids.clientA1, user_id: ids.portalA1Second },
          { client_id: ids.clientA1, user_id: ids.dualBare },
          { client_id: ids.clientA1, user_id: ids.dualFull },
          { client_id: ids.clientA1, user_id: ids.dualRemoved, status: 'removed' },
          { client_id: ids.clientA1, user_id: ids.crossDual },
          { client_id: ids.clientA2, user_id: ids.portalA2 },
          { client_id: ids.clientB, user_id: ids.portalB },
          { client_id: ids.clientArchived, user_id: ids.portalArchived },
          { client_id: ids.clientSuspended, user_id: ids.portalSuspended }
        ]);
      });
    },
    teardown: async () => {
      try {
        const knex = getOwner().knex;
        await knex('client_thread_comments').whereIn('client_id', clients).delete();
        await knex('client_threads').whereIn('client_id', clients).delete();
        await knex('content_tasks').whereIn('client_id', clients).delete();
        await knex('content_media').whereIn('client_id', clients).delete();
        await knex('contents').whereIn('client_id', clients).delete();
        await knex('media_assets').whereIn('id', assetIds).delete();
        await knex('media_folders').whereIn('client_id', clients).delete();
        await knex('client_memberships').whereIn('client_id', clients).delete();
        await knex('agency_memberships').whereIn('agency_id', agencies).delete();
        await knex('clients').whereIn('id', clients).delete();
        await knex('role_permissions').whereIn('role_id', roleIds).delete();
        await knex('roles').whereIn('id', roleIds).delete();
        await knex('agencies').whereIn('id', agencies).delete();
        await knex('auth.user').whereIn('id', allUsers()).delete();
      } finally {
        await getApplication().close();
        await getOwner().close();
      }
    }
  };
};
