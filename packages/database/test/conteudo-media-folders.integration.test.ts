import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #247 (specs/conteudo.md §2, §3, §5 rule 3 and §6). Every attack runs as `ageniza_app`; RLS
// filters silently, so a read is checked by the rows it returns and a write by the state left in the
// database. A custom role holding one permission stands in for each guard, because the Admin holds
// every permission and hides a guard written with the wrong one.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const DEFAULT_FOLDERS = ['Carrosséis', 'Ensaio fotográfico', 'Imagens', 'Vídeos'];
const BACKFILL = 'select app_private.create_default_media_folders(id) from public.clients';

const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const deniedByGrant = (table: string) => ({ code: '42501', message: expect.stringContaining(`permission denied for table ${table}`) });
const foreignKey = (constraint: string) => ({ code: '23503', constraint });

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();

const adminA = randomUUID();
const managerA = randomUUID();
const productionA = randomUUID();
const salesA = randomUUID();
const financeA = randomUUID();
const adminB = randomUUID();
const dualUser = randomUUID();
const onlyVisualizar = randomUUID();
const onlyOperar = randomUUID();
const onlyMidia = randomUUID();
const visualizarAndMidia = randomUUID();
const portalA1 = randomUUID();

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();

const allUsers = [adminA, managerA, productionA, salesA, financeA, adminB, dualUser, onlyVisualizar, onlyOperar, onlyMidia, visualizarAndMidia, portalA1];
const allAgencies = [agencyA, agencyB];
const allClients = [clientA1, clientA2, clientArchived, clientB];
const roleIds: string[] = [];
const assetIds: string[] = [];

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

const presetRole = async (key: string): Promise<string> => {
  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key }).first('id');
  if (role === undefined) throw new Error(`System role ${key} is missing.`);
  return role.id as string;
};

const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
  const id = randomUUID();
  roleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
  await getOwner().knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
  return id;
};

const folderNamesOf = async (clientId: string, onlyDefault = true): Promise<string[]> =>
  (await getOwner().knex('media_folders').where({ client_id: clientId, ...(onlyDefault ? { is_default: true } : {}) }).orderBy('name').select('name'))
    .map((row) => row.name as string);

const firstLevelFolderId = async (clientId: string, name: string): Promise<string> => {
  const folder = await getOwner().knex('media_folders').where({ client_id: clientId, name, is_default: true }).first('id');
  return folder?.id as string;
};

const folderRowCount = async (clientId: string): Promise<number> =>
  Number((await getOwner().knex('media_folders').where({ client_id: clientId }).count('* as count').first())?.count);

const mediaRow = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  agency_id: agencyA,
  category: 'image',
  declared_content_type: 'image/png',
  extension: 'png',
  object_key: `${agencyA}/${id}/original.png`,
  upload_object_key: `staging/${agencyA}/${id}/upload.png`,
  declared_size_bytes: 1_000,
  ...extra
});

const seedMedia = async (clientId: string | null, folderId: string | null = null): Promise<string> => {
  const id = randomUUID();
  assetIds.push(id);
  await getOwner().knex('media_assets').insert({ ...mediaRow(id, { client_id: clientId, folder_id: folderId }), created_by_user_id: adminA });
  return id;
};

const insertMediaAs = async (userId: string, extra: Record<string, unknown>): Promise<string> => {
  const id = randomUUID();
  assetIds.push(id);
  await asUser(userId, (transaction) => transaction('media_assets').insert(mediaRow(id, extra)));
  return id;
};

const mediaExists = async (id: string): Promise<boolean> =>
  (await getOwner().knex('media_assets').where({ id }).select('id')).length === 1;

const columnsWithPrivilege = async (table: string, privilege: 'insert' | 'update'): Promise<string[]> => {
  const { rows } = await getOwner().knex.raw<{ rows: Array<{ column_name: string }> }>(`
    select a.attname as column_name
    from pg_catalog.pg_attribute a
    where a.attrelid = ?::regclass
      and a.attnum > 0
      and not a.attisdropped
      and has_column_privilege('ageniza_app', ?::regclass, a.attnum, ?)
    order by a.attname
  `, [`public.${table}`, `public.${table}`, privilege]);
  return rows.map((row) => row.column_name);
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const [admin, manager, production, sales, finance] = await Promise.all(
    ['admin', 'account_manager', 'production', 'sales', 'finance'].map(presetRole)
  );

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(
      allUsers.map((id) => ({ id, name: `User ${id}`, email: `${id}@conteudo-folders.test`, emailVerified: true }))
    );
    await transaction('agencies').insert([
      { id: agencyA, name: `Conteúdo A ${agencyA}` },
      { id: agencyB, name: `Conteúdo B ${agencyB}` }
    ]);
  });

  const visualizarRole = await customRole(agencyA, 'conteudo.visualizar');
  const operarRole = await customRole(agencyA, 'conteudo.operar');
  const midiaRole = await customRole(agencyA, 'midia.enviar');
  const visualizarAndMidiaRole = await customRole(agencyA, 'conteudo.visualizar', 'midia.enviar');

  await getOwner().transaction(async (transaction) => {
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: adminA, role_id: admin },
      { agency_id: agencyA, user_id: managerA, role_id: manager },
      { agency_id: agencyA, user_id: productionA, role_id: production },
      { agency_id: agencyA, user_id: salesA, role_id: sales },
      { agency_id: agencyA, user_id: financeA, role_id: finance },
      { agency_id: agencyB, user_id: adminB, role_id: admin },
      { agency_id: agencyA, user_id: dualUser, role_id: admin },
      { agency_id: agencyB, user_id: dualUser, role_id: sales },
      { agency_id: agencyA, user_id: onlyVisualizar, role_id: visualizarRole },
      { agency_id: agencyA, user_id: onlyOperar, role_id: operarRole },
      { agency_id: agencyA, user_id: onlyMidia, role_id: midiaRole },
      { agency_id: agencyA, user_id: visualizarAndMidia, role_id: visualizarAndMidiaRole }
    ]);
    await transaction('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Cliente A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
      { id: clientArchived, agency_id: agencyA, name: `Cliente arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() },
      { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` }
    ]);
    await transaction('client_memberships').insert({ client_id: clientA1, user_id: portalA1 });
  });
});

afterAll(async () => {
  try {
    await getOwner().knex('media_assets').whereIn('id', assetIds).delete();
    await getOwner().knex('media_folders').whereIn('client_id', allClients).whereNotNull('parent_id').delete();
    await getOwner().knex('media_folders').whereIn('client_id', allClients).delete();
    await getOwner().knex('client_memberships').whereIn('client_id', allClients).delete();
    await getOwner().knex('agency_memberships').whereIn('agency_id', allAgencies).delete();
    await getOwner().knex('clients').whereIn('id', allClients).delete();
    await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
    await getOwner().knex('roles').whereIn('id', roleIds).delete();
    await getOwner().knex('agencies').whereIn('id', allAgencies).delete();
    await getOwner().knex('auth.user').whereIn('id', allUsers).delete();
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('the conteudo.* permissions and their presets (issue #247)', () => {
  it('adds exactly the five permissions of specs/conteudo.md §2 to the catalog', async () => {
    const rows = await getOwner().knex('permissions').where('key', 'like', 'conteudo.%').orderBy('key').select('key');

    expect(rows.map((row) => row.key)).toEqual([
      'conteudo.aprovar_pela_agencia', 'conteudo.cancelar', 'conteudo.operar', 'conteudo.publicar', 'conteudo.visualizar'
    ]);
  });

  it('gives each system role the permissions of the table in §2, and Sales and Finance none', async () => {
    const rows = await getOwner().knex('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .whereNull('roles.agency_id')
      .where('role_permissions.permission_key', 'like', 'conteudo.%')
      .orderBy(['roles.key', 'role_permissions.permission_key'])
      .select('roles.key as role', 'role_permissions.permission_key as permission');
    const byRole: Record<string, string[]> = {};
    for (const row of rows) (byRole[row.role as string] ??= []).push(row.permission as string);

    expect(byRole).toEqual({
      account_manager: ['conteudo.aprovar_pela_agencia', 'conteudo.cancelar', 'conteudo.operar', 'conteudo.publicar', 'conteudo.visualizar'],
      admin: ['conteudo.aprovar_pela_agencia', 'conteudo.cancelar', 'conteudo.operar', 'conteudo.publicar', 'conteudo.visualizar'],
      production: ['conteudo.operar', 'conteudo.publicar', 'conteudo.visualizar']
    });
    expect(byRole.sales).toBeUndefined();
    expect(byRole.finance).toBeUndefined();
  });
});

describe('the default folders (issue #247)', () => {
  it('gives a client registered through the application its four default folders, at the first level', async () => {
    const id = randomUUID();
    allClients.push(id);

    await asUser(adminA, (transaction) => transaction('clients').insert({ id, agency_id: agencyA, name: `Cliente novo ${id}` }));

    expect(await folderNamesOf(id)).toEqual(DEFAULT_FOLDERS);
    expect(await folderRowCount(id)).toBe(4);
    expect(await getOwner().knex('media_folders').where({ client_id: id }).whereNotNull('parent_id').select('id')).toHaveLength(0);
  });

  it('gives every client in the database the four folders, archived ones included', async () => {
    for (const id of [clientA1, clientA2, clientArchived, clientB]) {
      expect(await folderNamesOf(id), id).toEqual(DEFAULT_FOLDERS);
    }

    const { rows } = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(`
      select count(*) as count
      from public.clients client
      where (select count(*) from public.media_folders folder where folder.client_id = client.id and folder.is_default) <> 4
    `);
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('backfills a client that predates the folders, and running the backfill again duplicates nothing', async () => {
    const id = randomUUID();
    allClients.push(id);
    await getOwner().transaction(async (transaction) => {
      // The replica role skips the trigger, which is how a client that exists before the migration looks.
      await transaction.raw('set local session_replication_role = replica');
      await transaction('clients').insert({ id, agency_id: agencyA, name: `Cliente antigo ${id}` });
    });
    expect(await folderRowCount(id)).toBe(0);

    await getOwner().knex.raw(BACKFILL);
    expect(await folderNamesOf(id)).toEqual(DEFAULT_FOLDERS);

    await getOwner().knex.raw(BACKFILL);
    await getOwner().knex.raw(BACKFILL);
    expect(await folderNamesOf(id)).toEqual(DEFAULT_FOLDERS);
    expect(await folderRowCount(id)).toBe(4);
    expect(await folderNamesOf(clientA1)).toEqual(DEFAULT_FOLDERS);
  });

  it('completes the folders of a client that has only some of them, leaving its own folders alone', async () => {
    const id = randomUUID();
    allClients.push(id);
    await getOwner().transaction(async (transaction) => {
      await transaction.raw('set local session_replication_role = replica');
      await transaction('clients').insert({ id, agency_id: agencyA, name: `Cliente parcial ${id}` });
      await transaction('media_folders').insert([
        { client_id: id, name: 'Vídeos', is_default: true },
        { client_id: id, name: 'Campanha de verão', is_default: false }
      ]);
    });

    await getOwner().knex.raw(BACKFILL);

    expect(await folderNamesOf(id)).toEqual(DEFAULT_FOLDERS);
    expect(await folderNamesOf(id, false)).toEqual(['Campanha de verão', 'Carrosséis', 'Ensaio fotográfico', 'Imagens', 'Vídeos']);
  });

  it('does not let the application create the folders itself: no execute on the function, and is_default is not insertable', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ can_execute: boolean }> }>(
      "select has_function_privilege('ageniza_app', 'app_private.create_default_media_folders(uuid)', 'execute') as can_execute"
    );
    expect(rows[0]?.can_execute).toBe(false);

    await expect(asUser(adminA, (transaction) => transaction.raw('select app_private.create_default_media_folders(?::uuid)', [clientA1])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for function create_default_media_folders') });

    await expect(asUser(adminA, (transaction) => transaction('media_folders').insert({ client_id: clientA1, name: 'Falsa padrão', is_default: true })))
      .rejects.toMatchObject(deniedByGrant('media_folders'));
    expect(await folderRowCount(clientA1)).toBe(4);
  });
});

describe('the grants on media_folders (issue #247)', () => {
  it('lets ageniza_app select, insert only client_id, parent_id and name, update only name, and delete nothing', async () => {
    expect(await columnsWithPrivilege('media_folders', 'insert')).toEqual(['client_id', 'id', 'name', 'parent_id']);
    expect(await columnsWithPrivilege('media_folders', 'update')).toEqual(['name']);

    const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
      select
        has_table_privilege('ageniza_app', 'public.media_folders', 'select') as can_select,
        has_table_privilege('ageniza_app', 'public.media_folders', 'insert') as table_insert,
        has_table_privilege('ageniza_app', 'public.media_folders', 'update') as table_update,
        has_table_privilege('ageniza_app', 'public.media_folders', 'delete') as can_delete,
        has_table_privilege('ageniza_app', 'public.media_folders', 'truncate') as can_truncate
    `);
    expect(rows[0]).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it('refuses a DELETE of a folder the actor can see, even when a permissive DELETE policy is created by mistake', async () => {
    const folder = await firstLevelFolderId(clientA1, 'Vídeos');

    await expect(asUser(adminA, async (transaction) => {
      expect(await transaction('media_folders').where({ id: folder }).select('id')).toHaveLength(1);
      return await transaction('media_folders').where({ id: folder }).delete();
    })).rejects.toMatchObject(deniedByGrant('media_folders'));

    const transaction = await getOwner().knex.transaction();
    try {
      await transaction.raw('create policy zz_delete_by_mistake on public.media_folders for delete to ageniza_app using (true)');
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [adminA]);
      await expect(transaction('media_folders').where({ id: folder }).delete()).rejects.toMatchObject(deniedByGrant('media_folders'));
    } finally {
      await transaction.rollback();
    }

    expect(await folderNamesOf(clientA1)).toEqual(DEFAULT_FOLDERS);
  });

  it.each([
    ['client_id', () => clientA2],
    ['parent_id', () => null],
    ['is_default', () => true],
    ['created_at', () => new Date(0)],
    ['id', () => randomUUID()]
  ] as const)('refuses an UPDATE of %s at the privilege layer, leaving the folder', async (column, value) => {
    const id = randomUUID();
    await getOwner().knex('media_folders').insert({ id, client_id: clientA1, name: `Própria ${id}` });
    const before = await getOwner().knex('media_folders').where({ id }).first();

    await expect(asUser(adminA, async (transaction) => {
      expect(await transaction('media_folders').where({ id }).select('id')).toHaveLength(1);
      return await transaction('media_folders').where({ id }).update({ [column]: value() });
    })).rejects.toMatchObject(deniedByGrant('media_folders'));

    expect(await getOwner().knex('media_folders').where({ id }).first()).toEqual(before);
  });
});

describe('the two levels, and the folder of the same client (issue #247)', () => {
  it('lets an operator create an own first-level folder and a working folder inside it', async () => {
    const parent = randomUUID();
    const child = randomUUID();

    await asUser(managerA, async (transaction) => {
      await transaction('media_folders').insert({ id: parent, client_id: clientA1, name: 'Campanha de inverno' });
      await transaction('media_folders').insert({ id: child, client_id: clientA1, parent_id: parent, name: 'Ensaio da loja' });
    });

    expect(await getOwner().knex('media_folders').where({ id: child }).first('parent_id', 'client_id', 'is_default'))
      .toEqual({ parent_id: parent, client_id: clientA1, is_default: false });
  });

  it('lets a working folder live inside a default folder', async () => {
    const parent = await firstLevelFolderId(clientA1, 'Imagens');
    const child = randomUUID();

    await asUser(adminA, (transaction) => transaction('media_folders').insert({ id: child, client_id: clientA1, parent_id: parent, name: 'Fotos da loja' }));

    expect(await getOwner().knex('media_folders').where({ id: child }).first('parent_id')).toEqual({ parent_id: parent });
  });

  it('refuses a third level, as the application and as the schema owner, leaving no row', async () => {
    const top = randomUUID();
    const second = randomUUID();
    await asUser(adminA, async (transaction) => {
      await transaction('media_folders').insert({ id: top, client_id: clientA1, name: `Nível 1 ${top}` });
      await transaction('media_folders').insert({ id: second, client_id: clientA1, parent_id: top, name: `Nível 2 ${second}` });
    });
    const third = randomUUID();

    await expect(asUser(adminA, (transaction) => transaction('media_folders').insert({ id: third, client_id: clientA1, parent_id: second, name: 'Nível 3' })))
      .rejects.toMatchObject(foreignKey('media_folders_parent_fk'));
    await expect(getOwner().knex('media_folders').insert({ id: third, client_id: clientA1, parent_id: second, name: 'Nível 3' }))
      .rejects.toMatchObject(foreignKey('media_folders_parent_fk'));

    expect(await getOwner().knex('media_folders').where({ id: third }).select('id')).toHaveLength(0);
  });

  it('refuses a parent that belongs to another client of the same agency, and to a client of another agency', async () => {
    const otherClientParent = await firstLevelFolderId(clientA2, 'Vídeos');
    const otherAgencyParent = await firstLevelFolderId(clientB, 'Vídeos');
    const id = randomUUID();

    for (const parent of [otherClientParent, otherAgencyParent]) {
      await expect(asUser(adminA, (transaction) => transaction('media_folders').insert({ id, client_id: clientA1, parent_id: parent, name: 'Sequestrada' })), parent)
        .rejects.toMatchObject(foreignKey('media_folders_parent_fk'));
      await expect(getOwner().knex('media_folders').insert({ id, client_id: clientA1, parent_id: parent, name: 'Sequestrada' }), parent)
        .rejects.toMatchObject(foreignKey('media_folders_parent_fk'));
    }

    expect(await getOwner().knex('media_folders').where({ id }).select('id')).toHaveLength(0);
  });

  it.each([
    ['blank', '   '],
    ['only a tab', String.fromCharCode(9)],
    ['only a no-break space', String.fromCharCode(160)],
    ['empty', ''],
    ['over 256 bytes', 'x'.repeat(257)]
  ] as const)('refuses a folder name that is %s', async (_label, name) => {
    await expect(asUser(adminA, (transaction) => transaction('media_folders').insert({ client_id: clientA1, name })))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a second default folder with the same name for a client, and an own folder cannot be marked default', async () => {
    await expect(getOwner().knex('media_folders').insert({ client_id: clientA1, name: 'Vídeos', is_default: true }))
      .rejects.toMatchObject({ code: '23505', constraint: 'media_folders_default_name_key' });
    await expect(getOwner().knex('media_folders').insert({ client_id: clientA1, name: 'Aninhada padrão', is_default: true, parent_id: await firstLevelFolderId(clientA1, 'Vídeos') }))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('who reads and writes folders (issue #247)', () => {
  it.each([
    ['Admin', () => adminA],
    ['Gestor de conta', () => managerA],
    ['Produção', () => productionA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar]
  ] as const)('shows the four folders of every client of the agency to %s, and none of another agency', async (_label, user) => {
    const seen = await asUser(user(), (transaction) =>
      transaction('media_folders').where({ is_default: true }).whereIn('client_id', allClients).orderBy('name').select('client_id', 'name'));

    const byClient = (clientId: string) => seen.filter((row) => row.client_id === clientId).map((row) => row.name);
    for (const client of [clientA1, clientA2, clientArchived]) expect(byClient(client), client).toEqual(DEFAULT_FOLDERS);
    expect(byClient(clientB)).toEqual([]);
  });

  it.each([
    ['Vendas', () => salesA],
    ['Financeiro', () => financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role with only midia.enviar', () => onlyMidia],
    ['the admin of another agency', () => adminB],
    ['a person of the portal of the client', () => portalA1]
  ] as const)('shows no folder to %s', async (_label, user) => {
    const seen = await asUser(user(), (transaction) => transaction('media_folders').whereIn('client_id', [clientA1, clientA2, clientArchived]).select('id'));

    expect(seen).toHaveLength(0);
  });

  it('shows a person with a link in two agencies the folders of the agency that allows it and none of the other', async () => {
    const seen = await asUser(dualUser, (transaction) => transaction('media_folders').whereIn('client_id', [clientA1, clientB]).select('client_id'));

    expect([...new Set(seen.map((row) => row.client_id))]).toEqual([clientA1]);
  });

  it.each([
    ['Admin', () => adminA],
    ['Gestor de conta', () => managerA],
    ['Produção', () => productionA],
    ['a role with only conteudo.operar', () => onlyOperar]
  ] as const)('lets %s create a folder', async (_label, user) => {
    const id = randomUUID();

    await asUser(user(), (transaction) => transaction('media_folders').insert({ id, client_id: clientA2, name: `Pasta ${id}` }));

    expect(await getOwner().knex('media_folders').where({ id }).select('id')).toHaveLength(1);
  });

  it.each([
    ['Vendas', () => salesA],
    ['Financeiro', () => financeA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only midia.enviar', () => onlyMidia],
    ['the admin of another agency', () => adminB],
    ['a person of the portal of the client', () => portalA1]
  ] as const)('refuses %s a folder', async (_label, user) => {
    const id = randomUUID();

    await expect(asUser(user(), (transaction) => transaction('media_folders').insert({ id, client_id: clientA1, name: `Pasta ${id}` })))
      .rejects.toMatchObject(rlsViolation);

    expect(await getOwner().knex('media_folders').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a folder for an archived client', async () => {
    const id = randomUUID();

    await expect(asUser(adminA, (transaction) => transaction('media_folders').insert({ id, client_id: clientArchived, name: `Pasta ${id}` })))
      .rejects.toMatchObject(rlsViolation);

    expect(await getOwner().knex('media_folders').where({ id }).select('id')).toHaveLength(0);
  });

  it('lets an operator rename an own folder, and changes nothing for a default folder, an archived client or another role', async () => {
    const own = randomUUID();
    const ownArchived = randomUUID();
    await getOwner().knex('media_folders').insert([
      { id: own, client_id: clientA1, name: 'Antes' },
      { id: ownArchived, client_id: clientArchived, name: 'Antes' }
    ]);
    const defaultFolder = await firstLevelFolderId(clientA1, 'Vídeos');

    expect(await asUser(adminA, async (transaction) => {
      expect(await transaction('media_folders').where({ id: own }).select('id')).toHaveLength(1);
      return await transaction('media_folders').where({ id: own }).update({ name: 'Depois' });
    })).toBe(1);
    expect(await asUser(adminA, (transaction) => transaction('media_folders').where({ id: defaultFolder }).update({ name: 'Renomeada' }))).toBe(0);
    expect(await asUser(adminA, (transaction) => transaction('media_folders').where({ id: ownArchived }).update({ name: 'Depois' }))).toBe(0);
    for (const user of [salesA, onlyVisualizar, onlyMidia, adminB]) {
      expect(await asUser(user, (transaction) => transaction('media_folders').where({ id: own }).update({ name: 'Invasão' })), user).toBe(0);
    }

    expect((await getOwner().knex('media_folders').where({ id: own }).first('name'))?.name).toBe('Depois');
    expect((await getOwner().knex('media_folders').where({ id: defaultFolder }).first('name'))?.name).toBe('Vídeos');
    expect((await getOwner().knex('media_folders').where({ id: ownArchived }).first('name'))?.name).toBe('Antes');
  });
});

describe('the media of a client (issue #247)', () => {
  it('lets a media carry a client of its agency and a folder of that client', async () => {
    const folder = await firstLevelFolderId(clientA1, 'Imagens');

    const id = await insertMediaAs(onlyOperar, { client_id: clientA1, folder_id: folder });

    expect(await getOwner().knex('media_assets').where({ id }).first('client_id', 'folder_id', 'removed_at', 'created_by_user_id'))
      .toEqual({ client_id: clientA1, folder_id: folder, removed_at: null, created_by_user_id: onlyOperar });
  });

  it('refuses a folder of another client of the same agency, and of a client of another agency, as the application and as the owner', async () => {
    const otherClientFolder = await firstLevelFolderId(clientA2, 'Imagens');
    const otherAgencyFolder = await firstLevelFolderId(clientB, 'Imagens');

    for (const folder of [otherClientFolder, otherAgencyFolder]) {
      const id = randomUUID();
      assetIds.push(id);
      await expect(asUser(adminA, (transaction) => transaction('media_assets').insert(mediaRow(id, { client_id: clientA1, folder_id: folder }))), folder)
        .rejects.toMatchObject(foreignKey('media_assets_folder_client_fk'));
      await expect(getOwner().knex('media_assets').insert({ ...mediaRow(id, { client_id: clientA1, folder_id: folder }), created_by_user_id: adminA }), folder)
        .rejects.toMatchObject(foreignKey('media_assets_folder_client_fk'));
      expect(await mediaExists(id)).toBe(false);
    }
  });

  it('refuses a folder with no client, so the client check cannot be skipped by leaving it null', async () => {
    const id = randomUUID();
    assetIds.push(id);
    const folder = await firstLevelFolderId(clientA1, 'Imagens');

    await expect(asUser(adminA, (transaction) => transaction('media_assets').insert(mediaRow(id, { folder_id: folder }))))
      .rejects.toMatchObject({ code: '23514', constraint: 'media_assets_folder_needs_client' });

    expect(await mediaExists(id)).toBe(false);
  });

  it('refuses a client of another agency on a media of this agency, and a media of another agency for this agency\'s client', async () => {
    const crossed = randomUUID();
    assetIds.push(crossed);
    await expect(asUser(adminA, (transaction) => transaction('media_assets').insert(mediaRow(crossed, { client_id: clientB }))))
      .rejects.toMatchObject(foreignKey('media_assets_client_agency_fk'));
    expect(await mediaExists(crossed)).toBe(false);

    const foreign = randomUUID();
    assetIds.push(foreign);
    await expect(asUser(adminA, (transaction) => transaction('media_assets').insert(mediaRow(foreign, {
      agency_id: agencyB,
      client_id: clientB,
      object_key: `${agencyB}/${foreign}/original.png`,
      upload_object_key: `staging/${agencyB}/${foreign}/upload.png`
    })))).rejects.toMatchObject(rlsViolation);
    expect(await mediaExists(foreign)).toBe(false);
  });

  it('refuses a media for an archived client', async () => {
    const id = randomUUID();
    assetIds.push(id);

    await expect(asUser(adminA, (transaction) => transaction('media_assets').insert(mediaRow(id, { client_id: clientArchived }))))
      .rejects.toMatchObject(rlsViolation);

    expect(await mediaExists(id)).toBe(false);
  });

  it('writes a media of a client only with conteudo.operar, and a media with no client only with midia.enviar', async () => {
    for (const [user, withClient, allowed] of [
      [onlyOperar, true, true],
      [onlyMidia, true, false],
      [onlyVisualizar, true, false],
      [salesA, true, false],
      [onlyMidia, false, true],
      [onlyOperar, false, false],
      [onlyVisualizar, false, false]
    ] as const) {
      const id = randomUUID();
      assetIds.push(id);
      const attempt = asUser(user, (transaction) => transaction('media_assets').insert(mediaRow(id, withClient ? { client_id: clientA1 } : {})));

      if (allowed) await attempt;
      else await expect(attempt, `${user} withClient=${String(withClient)}`).rejects.toMatchObject(rlsViolation);
      expect(await mediaExists(id), `${user} withClient=${String(withClient)}`).toBe(allowed);
    }
  });

  it('reads a media of a client only with conteudo.visualizar, and a media with no client only with midia.enviar', async () => {
    const withClient = await seedMedia(clientA1);
    const legacy = await seedMedia(null);

    const idsSeenBy = async (user: string): Promise<string[]> =>
      (await asUser(user, (transaction) => transaction('media_assets').whereIn('id', [withClient, legacy]).orderBy('id').select('id')))
        .map((row) => row.id as string);

    expect(await idsSeenBy(onlyVisualizar)).toEqual([withClient]);
    expect(await idsSeenBy(onlyMidia)).toEqual([legacy]);
    expect(await idsSeenBy(onlyOperar)).toEqual([]);
    expect(await idsSeenBy(salesA)).toEqual([]);
    expect(await idsSeenBy(financeA)).toEqual([]);
    expect(await idsSeenBy(adminB)).toEqual([]);
    expect(await idsSeenBy(portalA1)).toEqual([]);
    expect((await idsSeenBy(adminA)).sort()).toEqual([withClient, legacy].sort());
  });

  it('updates a media of a client only with conteudo.operar, even for someone who can see it and holds midia.enviar', async () => {
    const id = await seedMedia(clientA1);

    for (const user of [onlyMidia, onlyVisualizar, visualizarAndMidia, salesA, adminB]) {
      expect(await asUser(user, (transaction) => transaction('media_assets').where({ id }).update({ updated_at: new Date() })), user).toBe(0);
    }
    expect(await asUser(onlyVisualizar, (transaction) => transaction('media_assets').where({ id }).select('id'))).toHaveLength(1);
    expect(await asUser(visualizarAndMidia, (transaction) => transaction('media_assets').where({ id }).select('id'))).toHaveLength(1);
    expect(await asUser(adminA, (transaction) => transaction('media_assets').where({ id }).update({ updated_at: new Date() }))).toBe(1);
  });

  it('still gives a media with no client to the people that had it before: midia.enviar reads and writes it', async () => {
    const id = await seedMedia(null);

    expect(await asUser(onlyMidia, (transaction) => transaction('media_assets').where({ id }).select('id'))).toHaveLength(1);
    expect(await asUser(onlyMidia, (transaction) => transaction('media_assets').where({ id }).update({ updated_at: new Date() }))).toBe(1);
    expect(await asUser(onlyOperar, (transaction) => transaction('media_assets').where({ id }).update({ updated_at: new Date() }))).toBe(0);
    expect(await asUser(visualizarAndMidia, (transaction) => transaction('media_assets').where({ id }).update({ updated_at: new Date() }))).toBe(1);
  });
});

describe('the migration itself (issue #247)', () => {
  it('backfills the clients that exist when it runs, with the statement this suite repeats above', () => {
    const migration = readFileSync(new URL('../migrations/20261007000900_content_permissions_media_folders.mjs', import.meta.url), 'utf8');

    expect(migration).toContain(`${BACKFILL};`);
  });
});
