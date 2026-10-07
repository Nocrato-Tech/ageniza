import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #248 (specs/conteudo.md §3, §4, §5 rules 1, 2 and 4, §6). Every attack runs as `ageniza_app`;
// RLS filters silently, so a read is checked by the rows it returns and a write by the state left in
// the database. A custom role holding one permission stands in for each guard, because the Admin holds
// every permission and hides a guard written with the wrong one. "Dual" people are agency collaborators
// who also hold a link to a client: RLS answers WHO may read, not through WHICH SIDE, so each rule of the
// portal is attacked again with a person who has the link and a person who has the link and a role.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const NOT_FOUND = { code: 'A0050', message: expect.stringContaining('Story script not found.') };
const ARCHIVED = { code: 'A0051' };
const WRONG_STATE = { code: 'A0052' };
const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const deniedByGrant = (table: string) => ({ code: '42501', message: expect.stringContaining(`permission denied for table ${table}`) });
const BLANKS = {
  'empty': '',
  'spaces': '   ',
  'a tab and a line break': '\t\n',
  'a no-break space': String.fromCharCode(0xa0),
  'an em space': String.fromCharCode(0x2003),
  'a figure space, which the locale does not call a space': String.fromCharCode(0x2007),
  'an ideographic space': String.fromCharCode(0x3000),
  'a narrow no-break space': String.fromCharCode(0x202f),
  'mixed spaces': ` ${String.fromCharCode(0xa0)}\t${String.fromCharCode(0x3000)} `
} as const;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencySuspended = randomUUID();

const ownerA = randomUUID();
const adminA = randomUUID();
const productionA = randomUUID();
const salesA = randomUUID();
const financeA = randomUUID();
const adminB = randomUUID();
const adminSuspended = randomUUID();
const operarAndVisualizar = randomUUID();
const onlyOperar = randomUUID();
const onlyVisualizar = randomUUID();
// A collaborator whose role holds no conteudo.* permission and who also has an active link to client A1.
const dualBare = randomUUID();
// A collaborator with the Production preset (operar, visualizar, publicar) who also has the link to A1.
const dualFull = randomUUID();
// An Admin whose link to A1 was removed.
const dualRemoved = randomUUID();
const portalA1 = randomUUID();
const portalA1Second = randomUUID();
const portalA2 = randomUUID();
const portalB = randomUUID();
const portalArchived = randomUUID();
const portalSuspended = randomUUID();

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();
const clientSuspended = randomUUID();

const allUsers = [
  ownerA, adminA, productionA, salesA, financeA, adminB, adminSuspended, operarAndVisualizar, onlyOperar, onlyVisualizar,
  dualBare, dualFull, dualRemoved, portalA1, portalA1Second, portalA2, portalB, portalArchived, portalSuspended
];
const allAgencies = [agencyA, agencyB, agencySuspended];
const allClients = [clientA1, clientA2, clientArchived, clientB, clientSuspended];
const roleIds: string[] = [];
const scriptIds: string[] = [];

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

type ScriptState = 'draft' | 'sent' | 'recorded';
const FIRST_RECORDER_AT = new Date('2026-10-07T12:00:00.000Z');

// Fixtures are written by the schema owner, which is the one role that may insert a script already sent or recorded.
const seedScript = async (clientId: string, status: ScriptState = 'draft', scenes: number | readonly string[] = 0): Promise<string> => {
  const id = randomUUID();
  scriptIds.push(id);
  await getOwner().knex('story_scripts').insert({
    id,
    client_id: clientId,
    script_on: '2026-10-20',
    status,
    ...(status === 'recorded' ? { recorded_by: portalA1, recorded_at: FIRST_RECORDER_AT } : {})
  });
  const texts = typeof scenes === 'number' ? Array.from({ length: scenes }, (_, index) => `Cena ${index + 1}`) : scenes;
  if (texts.length > 0) {
    await getOwner().knex('story_script_scenes').insert(texts.map((text, index) => ({ script_id: id, client_id: clientId, position: index + 1, text })));
  }
  return id;
};

const scriptRow = async (id: string): Promise<Record<string, unknown>> => {
  const row = await getOwner().knex('story_scripts').where({ id }).first();
  if (row === undefined) throw new Error(`Script ${id} does not exist.`);
  return row as Record<string, unknown>;
};

const sceneRows = async (scriptId: string): Promise<Array<Record<string, unknown>>> =>
  await getOwner().knex('story_script_scenes').where({ script_id: scriptId }).orderBy('position').select() as Array<Record<string, unknown>>;

const sendAs = (userId: string, scriptId: string): Promise<unknown> =>
  asUser(userId, (transaction) => transaction.raw('select app_private.send_story_script(?::uuid)', [scriptId]));

const recordAs = (userId: string, scriptId: string): Promise<unknown> =>
  asUser(userId, (transaction) => transaction.raw('select app_private.record_story_script(?::uuid)', [scriptId]));

const visibleScripts = (userId: string, among: readonly string[]): Promise<string[]> =>
  asUser(userId, async (transaction) =>
    (await transaction('story_scripts').whereIn('id', among).select('id')).map((row) => row.id as string).sort());

const visibleSceneCount = (userId: string, scriptId: string): Promise<number> =>
  asUser(userId, async (transaction) => (await transaction('story_script_scenes').where({ script_id: scriptId }).select('id')).length);

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

const tablePrivileges = async (table: string): Promise<Record<string, boolean>> => {
  const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
    select
      has_table_privilege('ageniza_app', ?, 'select') as can_select,
      has_table_privilege('ageniza_app', ?, 'insert') as table_insert,
      has_table_privilege('ageniza_app', ?, 'update') as table_update,
      has_table_privilege('ageniza_app', ?, 'delete') as can_delete,
      has_table_privilege('ageniza_app', ?, 'truncate') as can_truncate
  `, [`public.${table}`, `public.${table}`, `public.${table}`, `public.${table}`, `public.${table}`]);
  return rows[0] ?? {};
};

const waitUntilSomeoneWaitsOnALock = async (): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(
      "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"
    );
    if (Number(waiting.rows[0]?.count) >= 1) return;
    if (Date.now() > deadline) throw new Error('Nothing ever queued behind the lock.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const asOwnerWithActor = <TResult>(actor: string, work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult> =>
  getOwner().transaction(async (transaction) => {
    await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    return await work(transaction);
  });

const openTransactionAs = async (userId: string): Promise<Knex.Transaction> => {
  const transaction = await getApplication().knex.transaction();
  await transaction.raw('select app_private.bind_actor(?::uuid)', [userId]);
  return transaction;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const [admin, production, sales, finance] = await Promise.all(['admin', 'production', 'sales', 'finance'].map(presetRole));

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(
      allUsers.map((id) => ({ id, name: `User ${id}`, email: `${id}@conteudo-roteiro.test`, emailVerified: true }))
    );
    await transaction('agencies').insert([
      { id: agencyA, name: `Roteiro A ${agencyA}`, owner_user_id: ownerA },
      { id: agencyB, name: `Roteiro B ${agencyB}` },
      { id: agencySuspended, name: `Roteiro suspensa ${agencySuspended}` }
    ]);
  });

  const operarAndVisualizarRole = await customRole(agencyA, 'conteudo.operar', 'conteudo.visualizar');
  const operarRole = await customRole(agencyA, 'conteudo.operar');
  const visualizarRole = await customRole(agencyA, 'conteudo.visualizar');

  await getOwner().transaction(async (transaction) => {
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: adminA, role_id: admin },
      { agency_id: agencyA, user_id: productionA, role_id: production },
      { agency_id: agencyA, user_id: salesA, role_id: sales },
      { agency_id: agencyA, user_id: financeA, role_id: finance },
      { agency_id: agencyB, user_id: adminB, role_id: admin },
      { agency_id: agencySuspended, user_id: adminSuspended, role_id: admin },
      { agency_id: agencyA, user_id: operarAndVisualizar, role_id: operarAndVisualizarRole },
      { agency_id: agencyA, user_id: onlyOperar, role_id: operarRole },
      { agency_id: agencyA, user_id: onlyVisualizar, role_id: visualizarRole },
      { agency_id: agencyA, user_id: dualBare, role_id: sales },
      { agency_id: agencyA, user_id: dualFull, role_id: production },
      { agency_id: agencyA, user_id: dualRemoved, role_id: admin }
    ]);
    await transaction('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Cliente A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
      { id: clientArchived, agency_id: agencyA, name: `Cliente arquivado ${clientArchived}` },
      { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` },
      { id: clientSuspended, agency_id: agencySuspended, name: `Cliente suspenso ${clientSuspended}` }
    ]);
    await transaction('client_memberships').insert([
      { client_id: clientA1, user_id: portalA1 },
      { client_id: clientA1, user_id: portalA1Second },
      { client_id: clientA1, user_id: dualBare },
      { client_id: clientA1, user_id: dualFull },
      { client_id: clientA1, user_id: dualRemoved, status: 'removed' },
      { client_id: clientA2, user_id: portalA2 },
      { client_id: clientB, user_id: portalB },
      { client_id: clientArchived, user_id: portalArchived },
      { client_id: clientSuspended, user_id: portalSuspended }
    ]);
  });
});

afterAll(async () => {
  try {
    await getOwner().knex('story_script_scenes').whereIn('client_id', allClients).delete();
    await getOwner().knex('story_scripts').whereIn('client_id', allClients).delete();
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

// Two clients stay archived or suspended for the whole file, set only now that the fixtures have their scripts.
const archiveClient = async (clientId: string): Promise<void> => {
  await getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
};

describe('what ageniza_app may write on the two tables (issue #248)', () => {
  it('inserts only id, client_id and script_on of a script, updates only script_on, and deletes and truncates nothing', async () => {
    expect(await columnsWithPrivilege('story_scripts', 'insert')).toEqual(['client_id', 'id', 'script_on']);
    expect(await columnsWithPrivilege('story_scripts', 'update')).toEqual(['script_on']);
    expect(await tablePrivileges('story_scripts')).toEqual({
      can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false
    });
  });

  it('inserts the writable columns of a scene, updates only position, text and guidance, and deletes and truncates nothing', async () => {
    expect(await columnsWithPrivilege('story_script_scenes', 'insert')).toEqual(['client_id', 'guidance', 'id', 'position', 'script_id', 'text']);
    expect(await columnsWithPrivilege('story_script_scenes', 'update')).toEqual(['guidance', 'position', 'text']);
    expect(await tablePrivileges('story_script_scenes')).toEqual({
      can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false
    });
  });

  it.each([
    ['story_scripts', () => seedScript(clientA1, 'draft')],
    ['story_script_scenes', () => seedScript(clientA1, 'draft', 1)]
  ] as const)('refuses a DELETE on %s of a row the actor sees, even when a permissive DELETE policy is created by mistake', async (table, seed) => {
    const scriptId = await seed();
    const rowFilter = table === 'story_scripts' ? { id: scriptId } : { script_id: scriptId };

    await expect(asUser(adminA, async (transaction) => {
      expect(await transaction(table).where(rowFilter).select('id')).toHaveLength(1);
      return await transaction(table).where(rowFilter).delete();
    })).rejects.toMatchObject(deniedByGrant(table));

    const transaction = await getOwner().knex.transaction();
    try {
      await transaction.raw(`create policy zz_delete_by_mistake on public.${table} for delete to ageniza_app using (true)`);
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [adminA]);
      await expect(transaction(table).where(rowFilter).delete()).rejects.toMatchObject(deniedByGrant(table));
    } finally {
      await transaction.rollback();
    }

    expect(await getOwner().knex(table).where(rowFilter).select('id')).toHaveLength(1);
  });

  it('closes the two state functions to PUBLIC and opens them to ageniza_app only', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ signature: string; app: boolean; public_execute: boolean; definer: boolean }> }>(`
      select p.oid::regprocedure::text as signature,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             p.prosecdef as definer
      from pg_catalog.pg_proc p
      where p.pronamespace = 'app_private'::regnamespace and p.proname in ('send_story_script', 'record_story_script')
      order by 1
    `);

    expect(rows).toEqual([
      { signature: 'app_private.record_story_script(uuid)', app: true, public_execute: false, definer: true },
      { signature: 'app_private.send_story_script(uuid)', app: true, public_execute: false, definer: true }
    ]);
  });
});

describe('the portal does not read a draft (issue #248, acceptance 1)', () => {
  let draft: string;
  let sent: string;
  let recorded: string;
  let otherClientSent: string;
  let otherAgencySent: string;
  let everything: string[];

  beforeAll(async () => {
    draft = await seedScript(clientA1, 'draft', ['Rascunho cena 1', 'Rascunho cena 2']);
    sent = await seedScript(clientA1, 'sent', ['Enviada cena 1']);
    recorded = await seedScript(clientA1, 'recorded', ['Gravada cena 1']);
    otherClientSent = await seedScript(clientA2, 'sent', ['Outro cliente']);
    otherAgencySent = await seedScript(clientB, 'sent', ['Outra agência']);
    everything = [draft, sent, recorded, otherClientSent, otherAgencySent];
  });

  it.each([
    ['a person of the portal of the client', () => portalA1],
    ['another person of the portal of the same client', () => portalA1Second],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('shows %s the sent and the recorded script of the client, and not the draft', async (_label, user) => {
    expect(await visibleScripts(user(), everything)).toEqual([sent, recorded].sort());
  });

  it.each([
    ['a person of the portal of the client', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('shows %s the scenes of a sent script, and none of a draft', async (_label, user) => {
    expect(await visibleSceneCount(user(), draft)).toBe(0);
    expect(await visibleSceneCount(user(), sent)).toBe(1);
    expect(await visibleSceneCount(user(), recorded)).toBe(1);
  });

  it('shows a person of the portal of another client of the same agency only the scripts of that client', async () => {
    expect(await visibleScripts(portalA2, everything)).toEqual([otherClientSent]);
    expect(await visibleSceneCount(portalA2, sent)).toBe(0);
    expect(await visibleSceneCount(portalA2, draft)).toBe(0);
  });

  it('shows a person of the portal of a client of another agency only the scripts of that client', async () => {
    expect(await visibleScripts(portalB, everything)).toEqual([otherAgencySent]);
  });

  it.each([
    ['an Admin', () => adminA],
    ['the Owner of the agency, by ownership', () => ownerA],
    ['Production', () => productionA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a collaborator with the Production role and a link to the client', () => dualFull],
    ['an Admin whose link to the client was removed', () => dualRemoved]
  ] as const)('shows %s every script of every client of the agency, the draft included, and none of another agency', async (_label, user) => {
    expect(await visibleScripts(user(), everything)).toEqual([draft, sent, recorded, otherClientSent].sort());
    expect(await visibleSceneCount(user(), draft)).toBe(2);
  });

  it.each([
    ['Sales', () => salesA],
    ['Finance', () => financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['the Admin of another agency', () => adminB]
  ] as const)('shows %s no script and no scene of the agency', async (_label, user) => {
    expect(await visibleScripts(user(), [draft, sent, recorded, otherClientSent])).toEqual([]);
    expect(await visibleSceneCount(user(), sent)).toBe(0);
  });

  it('shows the portal person of an archived client and of a suspended agency nothing, scripts that were already sent included', async () => {
    const archivedSent = await seedScript(clientArchived, 'sent', 1);
    const suspendedSent = await seedScript(clientSuspended, 'sent', 1);
    await archiveClient(clientArchived);
    await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'suspended' });

    try {
      expect(await visibleScripts(portalArchived, [archivedSent])).toEqual([]);
      expect(await visibleScripts(portalSuspended, [suspendedSent])).toEqual([]);
      expect(await visibleScripts(adminSuspended, [suspendedSent])).toEqual([]);
    } finally {
      await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'active' });
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }
  });
});

describe('who creates a script (issue #248)', () => {
  const create = (userId: string, clientId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    scriptIds.push(id);
    return asUser(userId, (transaction) => transaction('story_scripts').insert({ id, client_id: clientId, script_on: '2026-10-21', ...extra })).then(() => id);
  };

  it.each([
    ['Admin', () => adminA],
    ['Production', () => productionA],
    ['the Owner, by ownership', () => ownerA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s create a draft with no recording', async (_label, user) => {
    const id = await create(user(), clientA1);

    expect(await scriptRow(id)).toMatchObject({ client_id: clientA1, status: 'draft', recorded_by: null, recorded_at: null });
  });

  it.each([
    ['Sales', () => salesA],
    ['Finance', () => financeA],
    ['a role with only conteudo.operar, because a write that cannot read its own row is blind', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['the Admin of another agency', () => adminB],
    ['a person of the portal of the client', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('refuses %s a script, leaving no row', async (_label, user) => {
    const id = randomUUID();
    const before = Number((await getOwner().knex('story_scripts').where({ client_id: clientA1 }).count('* as count').first())?.count);

    await expect(asUser(user(), (transaction) => transaction('story_scripts').insert({ id, client_id: clientA1, script_on: '2026-10-21' })))
      .rejects.toMatchObject(rlsViolation);

    expect(await getOwner().knex('story_scripts').where({ id }).select('id')).toHaveLength(0);
    expect(Number((await getOwner().knex('story_scripts').where({ client_id: clientA1 }).count('* as count').first())?.count)).toBe(before);
  });

  it('refuses a script for a client of another agency, even to an Admin of the agency that owns the permission', async () => {
    const id = randomUUID();

    await expect(asUser(adminA, (transaction) => transaction('story_scripts').insert({ id, client_id: clientB, script_on: '2026-10-21' })))
      .rejects.toMatchObject(rlsViolation);

    expect(await getOwner().knex('story_scripts').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a script for an archived client (acceptance 4), and for a client of a suspended agency', async () => {
    const id = randomUUID();
    const suspendedId = randomUUID();
    await archiveClient(clientArchived);
    await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'suspended' });

    try {
      await expect(asUser(adminA, (transaction) => transaction('story_scripts').insert({ id, client_id: clientArchived, script_on: '2026-10-21' })))
        .rejects.toMatchObject(rlsViolation);
      await expect(asUser(adminSuspended, (transaction) => transaction('story_scripts').insert({ id: suspendedId, client_id: clientSuspended, script_on: '2026-10-21' })))
        .rejects.toMatchObject(rlsViolation);
    } finally {
      await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'active' });
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }

    expect(await getOwner().knex('story_scripts').whereIn('id', [id, suspendedId]).select('id')).toHaveLength(0);
  });

  it.each([
    ['status', { status: 'sent' }],
    ['status recorded with who and when', { status: 'recorded', recorded_by: portalA1, recorded_at: new Date() }],
    ['recorded_by', { recorded_by: adminA }],
    ['recorded_at', { recorded_at: new Date() }],
    ['created_at', { created_at: new Date(0) }]
  ] as const)('refuses to let the caller choose %s on the INSERT, at the privilege layer', async (_label, extra) => {
    const id = randomUUID();

    await expect(asUser(adminA, (transaction) => transaction('story_scripts').insert({ id, client_id: clientA1, script_on: '2026-10-21', ...extra })))
      .rejects.toMatchObject(deniedByGrant('story_scripts'));

    expect(await getOwner().knex('story_scripts').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a script with no day, and a day that is not a date', async () => {
    await expect(asUser(adminA, (transaction) => transaction('story_scripts').insert({ client_id: clientA1 }))).rejects.toMatchObject({ code: '23502' });
    await expect(asUser(adminA, (transaction) => transaction('story_scripts').insert({ client_id: clientA1, script_on: '2026-02-30' }))).rejects.toMatchObject({ code: '22008' });
  });
});

describe('send: draft to sent, by conteudo.operar (issue #248)', () => {
  it.each([
    ['Admin', () => adminA],
    ['Production', () => productionA],
    ['the Owner, by ownership', () => ownerA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s send a draft, changing the state and nothing else', async (_label, user) => {
    const id = await seedScript(clientA1, 'draft', 2);
    const before = await scriptRow(id);

    await sendAs(user(), id);

    expect(await scriptRow(id)).toEqual({ ...before, status: 'sent' });
    expect(await sceneRows(id)).toHaveLength(2);
  });

  it.each([
    ['Sales', () => salesA],
    ['Finance', () => financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['the Admin of another agency', () => adminB],
    ['a person of the portal of the client', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('answers "not found" to %s, leaving the script a draft', async (_label, user) => {
    const id = await seedScript(clientA1, 'draft', 1);
    const before = await scriptRow(id);

    await expect(sendAs(user(), id)).rejects.toMatchObject(NOT_FOUND);

    expect(await scriptRow(id)).toEqual(before);
  });

  it('lets an Admin whose link to the client was removed send, because the agency side does not depend on the link', async () => {
    const id = await seedScript(clientA1, 'draft');

    await sendAs(dualRemoved, id);

    expect((await scriptRow(id)).status).toBe('sent');
  });

  it('answers a script that does not exist exactly like a script the caller may not send, so it is no existence oracle', async () => {
    const forbidden = await seedScript(clientB, 'draft');

    const unknown = await sendAs(adminA, randomUUID()).catch((error: unknown) => error);
    const other = await sendAs(adminA, forbidden).catch((error: unknown) => error);

    expect(unknown).toMatchObject(NOT_FOUND);
    expect(other).toMatchObject(NOT_FOUND);
    expect((other as { code: string; message: string }).message).toBe((unknown as { message: string }).message);
    expect((await scriptRow(forbidden)).status).toBe('draft');
  });

  it('is idempotent: sending a script that was already sent changes nothing', async () => {
    const id = await seedScript(clientA1, 'draft');
    await sendAs(adminA, id);
    const once = await scriptRow(id);

    await sendAs(productionA, id);

    expect(await scriptRow(id)).toEqual(once);
  });

  it('does not send a script that was already recorded', async () => {
    const id = await seedScript(clientA1, 'recorded');
    const before = await scriptRow(id);

    await expect(sendAs(adminA, id)).rejects.toMatchObject(WRONG_STATE);

    expect(await scriptRow(id)).toEqual(before);
  });

  it('does not send a draft of an archived client, which is read-only for the agency', async () => {
    const id = await seedScript(clientArchived, 'draft', 1);
    await archiveClient(clientArchived);

    try {
      await expect(sendAs(adminA, id)).rejects.toMatchObject(ARCHIVED);
    } finally {
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }

    expect((await scriptRow(id)).status).toBe('draft');
  });

  it('does not send for an agency that is suspended', async () => {
    const id = await seedScript(clientSuspended, 'draft');
    await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'suspended' });

    try {
      await expect(sendAs(adminSuspended, id)).rejects.toMatchObject(NOT_FOUND);
    } finally {
      await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'active' });
    }

    expect((await scriptRow(id)).status).toBe('draft');
  });
});

describe('record: sent to recorded, by an active person of the portal (issue #248, acceptance 2 and 3)', () => {
  it('fixes recorded_by and recorded_at in the database: the person who called and the time of the call', async () => {
    const id = await seedScript(clientA1, 'sent', 1);
    const before = await scriptRow(id);
    const startedAt = Date.now();

    await recordAs(portalA1, id);

    const after = await scriptRow(id);
    expect(after).toEqual({ ...before, status: 'recorded', recorded_by: portalA1, recorded_at: after.recorded_at });
    expect(Math.abs((after.recorded_at as Date).getTime() - startedAt)).toBeLessThan(10_000);
    expect(await sceneRows(id)).toHaveLength(1);
  });

  it('ignores what a caller writes: the trigger stamps who and when even for a statement that names other values', async () => {
    const id = await seedScript(clientA1, 'sent');
    const transaction = await getOwner().knex.transaction();
    try {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [portalA1]);
      await transaction('story_scripts').where({ id }).update({ status: 'recorded', recorded_by: adminA, recorded_at: new Date('2000-01-01T00:00:00.000Z') });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }

    const after = await scriptRow(id);
    expect(after.recorded_by).toBe(portalA1);
    expect(Math.abs((after.recorded_at as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('does not record without an actor: nobody is recorded as "no one"', async () => {
    const id = await seedScript(clientA1, 'sent');
    const before = await scriptRow(id);

    await expect(getOwner().knex('story_scripts').where({ id }).update({ status: 'recorded' }))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('recorded by a person') });

    expect(await scriptRow(id)).toEqual(before);
  });

  it.each([
    ['a person of the portal of another client of the same agency', () => portalA2],
    ['a person of the portal of a client of another agency', () => portalB],
    ['an Admin of the agency, who holds every permission but has no link to the client', () => adminA],
    ['the Owner of the agency, who has no link to the client', () => ownerA],
    ['Production, who has no link to the client', () => productionA],
    ['an Admin whose link to the client was removed', () => dualRemoved],
    ['the Admin of another agency', () => adminB]
  ] as const)('answers "not found" to %s, leaving the script sent', async (_label, user) => {
    const id = await seedScript(clientA1, 'sent', 1);
    const before = await scriptRow(id);

    await expect(recordAs(user(), id)).rejects.toMatchObject(NOT_FOUND);

    expect(await scriptRow(id)).toEqual(before);
  });

  it.each([
    ['a person of the portal of the client', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*, who is an active person of the portal', () => dualBare],
    ['a collaborator with the Production role and a link to the client', () => dualFull]
  ] as const)('lets %s record a sent script', async (_label, user) => {
    const id = await seedScript(clientA1, 'sent');

    await recordAs(user(), id);

    expect(await scriptRow(id)).toMatchObject({ status: 'recorded', recorded_by: user() });
  });

  it('keeps the first person who recorded: a second person, or the same one again, changes nothing', async () => {
    const id = await seedScript(clientA1, 'sent');
    await recordAs(portalA1, id);
    const once = await scriptRow(id);

    await recordAs(portalA1Second, id);
    await recordAs(portalA1, id);

    expect(await scriptRow(id)).toEqual(once);
  });

  it('does not tell the portal that a draft exists: the answer is the one of a script that does not exist', async () => {
    const draft = await seedScript(clientA1, 'draft', 1);
    const before = await scriptRow(draft);

    for (const user of [portalA1, dualBare]) {
      const forDraft = await recordAs(user, draft).catch((error: unknown) => error);
      const forUnknown = await recordAs(user, randomUUID()).catch((error: unknown) => error);
      expect(forDraft, String(user)).toMatchObject(NOT_FOUND);
      expect((forDraft as { message: string }).message).toBe((forUnknown as { message: string }).message);
    }

    expect(await scriptRow(draft)).toEqual(before);
  });

  it('tells a collaborator who may read the draft the truth: it is not recorded from a draft', async () => {
    const draft = await seedScript(clientA1, 'draft');

    await expect(recordAs(dualFull, draft)).rejects.toMatchObject(WRONG_STATE);

    expect((await scriptRow(draft)).status).toBe('draft');
  });

  it('does not record for a client that is archived, or for an agency that is suspended', async () => {
    const archived = await seedScript(clientArchived, 'sent');
    const suspended = await seedScript(clientSuspended, 'sent');
    await archiveClient(clientArchived);
    await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'suspended' });

    try {
      await expect(recordAs(portalArchived, archived)).rejects.toMatchObject(NOT_FOUND);
      await expect(recordAs(portalSuspended, suspended)).rejects.toMatchObject(NOT_FOUND);
    } finally {
      await getOwner().knex('agencies').where({ id: agencySuspended }).update({ status: 'active' });
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }

    expect((await scriptRow(archived)).status).toBe('sent');
    expect((await scriptRow(suspended)).status).toBe('sent');
  });
});

describe('the state and the actor are not writable by the application (issue #248)', () => {
  it.each([
    ['status', () => ({ status: 'sent' })],
    ['status to recorded', () => ({ status: 'recorded' })],
    ['recorded_by', () => ({ recorded_by: portalA1 })],
    ['recorded_at', () => ({ recorded_at: new Date() })],
    ['client_id', () => ({ client_id: clientA2 })],
    ['id', () => ({ id: randomUUID() })],
    ['created_at', () => ({ created_at: new Date(0) })]
  ] as const)('refuses an UPDATE of %s at the privilege layer, to an Admin who sees the row', async (_label, change) => {
    const id = await seedScript(clientA1, 'draft');
    const before = await scriptRow(id);

    await expect(asUser(adminA, async (transaction) => {
      expect(await transaction('story_scripts').where({ id }).select('id')).toHaveLength(1);
      return await transaction('story_scripts').where({ id }).update(change());
    })).rejects.toMatchObject(deniedByGrant('story_scripts'));

    expect(await scriptRow(id)).toEqual(before);
  });

  it('lets an operator change the day of a draft', async () => {
    const id = await seedScript(clientA1, 'draft');

    expect(await asUser(operarAndVisualizar, (transaction) => transaction('story_scripts').where({ id }).update({ script_on: '2026-11-02' }))).toBe(1);

    const { rows } = await getOwner().knex.raw<{ rows: Array<{ day: string; status: string }> }>(
      "select to_char(script_on, 'YYYY-MM-DD') as day, status from public.story_scripts where id = ?::uuid", [id]
    );
    expect(rows).toEqual([{ day: '2026-11-02', status: 'draft' }]);
  });

  it.each(['sent', 'recorded'] as const)('refuses the edit of the day of a %s script, even to an operator who sees it', async (status) => {
    const id = await seedScript(clientA1, status, 1);
    const before = await scriptRow(id);

    await expect(asUser(operarAndVisualizar, (transaction) => transaction('story_scripts').where({ id }).update({ script_on: '2026-11-03' })))
      .rejects.toMatchObject(WRONG_STATE);

    expect(await scriptRow(id)).toEqual(before);
  });

  it.each([
    ['Sales', () => salesA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['the Admin of another agency', () => adminB],
    ['a person of the portal that reads the sent script', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('changes no day of a script for %s: the UPDATE reaches no row', async (_label, user) => {
    const draft = await seedScript(clientA1, 'draft');
    const sent = await seedScript(clientA1, 'sent');
    const before = [await scriptRow(draft), await scriptRow(sent)];

    for (const id of [draft, sent]) {
      expect(await asUser(user(), (transaction) => transaction('story_scripts').where({ id }).update({ script_on: '2026-11-04' }))).toBe(0);
    }

    expect([await scriptRow(draft), await scriptRow(sent)]).toEqual(before);
  });

  it('changes nothing for a role with only conteudo.operar even by an UPDATE with no WHERE, which needs no right to read', async () => {
    const draft = await seedScript(clientA1, 'draft', 1);
    const before = await scriptRow(draft);

    for (const user of [onlyOperar, onlyVisualizar]) {
      const result = await asUser(user, (transaction) => transaction.raw<{ rowCount: number }>("update public.story_scripts set script_on = '2031-01-01'::date"));
      expect(result.rowCount, String(user)).toBe(0);
    }

    expect(await scriptRow(draft)).toEqual(before);
    expect(await getOwner().knex('story_scripts').where({ script_on: '2031-01-01' }).select('id')).toHaveLength(0);
  });

  it('refuses the edit of the day of a draft of an archived client, loudly, and still lets the operator lock the row', async () => {
    const id = await seedScript(clientArchived, 'draft');
    await archiveClient(clientArchived);
    const before = await scriptRow(id);

    try {
      await expect(asUser(operarAndVisualizar, (transaction) => transaction('story_scripts').where({ id }).update({ script_on: '2026-11-05' })))
        .rejects.toMatchObject(rlsViolation);
      const locked = await asUser(operarAndVisualizar, (transaction) => transaction.raw<{ rows: unknown[] }>('select id from public.story_scripts where id = ?::uuid for update', [id]));
      expect(locked.rows).toHaveLength(1);
    } finally {
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }

    expect(await scriptRow(id)).toEqual(before);
  });

  it('lets an operator take the row lock of a sent script, and gives a portal person no row to lock', async () => {
    const id = await seedScript(clientA1, 'sent');

    const forOperator = await asUser(operarAndVisualizar, (transaction) => transaction.raw<{ rows: unknown[] }>('select id from public.story_scripts where id = ?::uuid for update', [id]));
    const forPortal = await asUser(portalA1, (transaction) => transaction.raw<{ rows: unknown[] }>('select id from public.story_scripts where id = ?::uuid for update', [id]));

    expect(forOperator.rows).toHaveLength(1);
    expect(forPortal.rows).toHaveLength(0);
  });
});

describe('the trigger holds the direction of the state for every writer (issue #248)', () => {
  it.each([
    ['draft', 'recorded'],
    ['sent', 'draft'],
    ['recorded', 'sent'],
    ['recorded', 'draft']
  ] as const)('refuses %s -> %s, even to the schema owner', async (from, to) => {
    const id = await seedScript(clientA1, from);
    const before = await scriptRow(id);

    // An actor is bound, so a refusal for "no one recorded" cannot stand in for the refusal of the direction.
    await expect(asOwnerWithActor(portalA1, (transaction) => transaction('story_scripts').where({ id }).update({ status: to, recorded_by: null, recorded_at: null })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('only moves from draft to sent and from sent to recorded') });

    expect(await scriptRow(id)).toEqual(before);
  });

  it('refuses a state change that carries a recording, or another change', async () => {
    const id = await seedScript(clientA1, 'draft');
    const before = await scriptRow(id);

    await expect(getOwner().knex('story_scripts').where({ id }).update({ status: 'sent', recorded_by: portalA1, recorded_at: new Date() }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(getOwner().knex('story_scripts').where({ id }).update({ status: 'sent', script_on: '2027-01-01' }))
      .rejects.toMatchObject({ code: '42501' });

    expect(await scriptRow(id)).toEqual(before);
  });

  it.each([
    ['client_id', () => ({ client_id: clientA2 })],
    ['id', () => ({ id: randomUUID() })],
    ['created_at', () => ({ created_at: new Date(0) })]
  ] as const)('never changes %s, even for the schema owner', async (_label, change) => {
    const id = await seedScript(clientA1, 'sent');
    const before = await scriptRow(id);

    await expect(getOwner().knex('story_scripts').where({ id }).update(change())).rejects.toMatchObject({ code: '42501' });

    expect(await scriptRow(id)).toEqual(before);
  });

  it('never rewrites who recorded, or when, without a state change', async () => {
    const id = await seedScript(clientA1, 'recorded');
    const before = await scriptRow(id);

    await expect(getOwner().knex('story_scripts').where({ id }).update({ recorded_by: adminA })).rejects.toMatchObject({ code: '42501' });
    await expect(getOwner().knex('story_scripts').where({ id }).update({ recorded_at: new Date() })).rejects.toMatchObject({ code: '42501' });

    expect(await scriptRow(id)).toEqual(before);
  });

  it.each([
    ['a recorded script with nobody recorded', { status: 'recorded', recorded_by: null, recorded_at: null }],
    ['a recorded script with no time', { status: 'recorded', recorded_by: portalA1, recorded_at: null }],
    ['a sent script that carries a recorder', { status: 'sent', recorded_by: portalA1, recorded_at: FIRST_RECORDER_AT }],
    ['a draft that carries a recorder', { status: 'draft', recorded_by: portalA1, recorded_at: FIRST_RECORDER_AT }],
    ['a recorder without a time', { status: 'draft', recorded_by: portalA1, recorded_at: null }],
    ['an unknown state', { status: 'published', recorded_by: null, recorded_at: null }]
  ] as const)('does not store %s', async (_label, row) => {
    const id = randomUUID();

    await expect(getOwner().knex('story_scripts').insert({ id, client_id: clientA1, script_on: '2026-10-20', ...row }))
      .rejects.toMatchObject({ code: '23514' });

    expect(await getOwner().knex('story_scripts').where({ id }).select('id')).toHaveLength(0);
  });
});

describe('the scenes (issue #248)', () => {
  const addScene = (userId: string, scriptId: string, clientId: string, scene: Record<string, unknown>): Promise<number[]> =>
    asUser(userId, (transaction) => transaction('story_script_scenes').insert({ script_id: scriptId, client_id: clientId, ...scene }));

  it('keeps the scenes of a draft in order, with an optional guidance', async () => {
    const script = await seedScript(clientA1, 'draft');

    await addScene(operarAndVisualizar, script, clientA1, { position: 2, text: 'Segunda', guidance: 'Mostre o balcão' });
    await addScene(operarAndVisualizar, script, clientA1, { position: 1, text: 'Primeira' });

    expect((await sceneRows(script)).map((row) => [row.position, row.text, row.guidance])).toEqual([[1, 'Primeira', null], [2, 'Segunda', 'Mostre o balcão']]);
  });

  it.each([
    ['Admin', () => adminA],
    ['Production', () => productionA],
    ['the Owner, by ownership', () => ownerA],
    ['a role with conteudo.operar and conteudo.visualizar', () => operarAndVisualizar]
  ] as const)('lets %s add and edit a scene of a draft', async (_label, user) => {
    const script = await seedScript(clientA1, 'draft', 1);

    await addScene(user(), script, clientA1, { position: 2, text: 'Nova' });
    const edited = await asUser(user(), (transaction) => transaction('story_script_scenes').where({ script_id: script, position: 2 }).update({ text: 'Editada', guidance: 'Dica' }));

    expect(edited).toBe(1);
    expect((await sceneRows(script)).map((row) => [row.position, row.text, row.guidance])).toEqual([[1, 'Cena 1', null], [2, 'Editada', 'Dica']]);
  });

  it.each([
    ['Sales', () => salesA],
    ['Finance', () => financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['the Admin of another agency', () => adminB],
    ['a person of the portal of the client', () => portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => dualBare]
  ] as const)('refuses %s a scene, adds none and changes none', async (_label, user) => {
    const script = await seedScript(clientA1, 'draft', 1);
    const before = await sceneRows(script);

    await expect(addScene(user(), script, clientA1, { position: 2, text: 'Intrusa' })).rejects.toMatchObject(rlsViolation);
    expect(await asUser(user(), (transaction) => transaction('story_script_scenes').where({ script_id: script }).update({ text: 'Trocada' }))).toBe(0);

    expect(await sceneRows(script)).toEqual(before);
  });

  it('changes no scene for a role with only conteudo.operar even by an UPDATE with no WHERE, which needs no right to read', async () => {
    const script = await seedScript(clientA1, 'draft', 1);
    const before = await sceneRows(script);

    for (const user of [onlyOperar, onlyVisualizar]) {
      const result = await asUser(user, (transaction) => transaction.raw<{ rowCount: number }>("update public.story_script_scenes set text = 'Cega'"));
      expect(result.rowCount, String(user)).toBe(0);
    }

    expect(await sceneRows(script)).toEqual(before);
  });

  it('keeps the scene on the client of its script: another client of the agency, or of another agency, is refused by the foreign key', async () => {
    const script = await seedScript(clientA1, 'draft');

    await expect(addScene(adminA, script, clientA2, { position: 1, text: 'Cliente trocado' })).rejects.toMatchObject({ code: '23503', constraint: 'story_script_scenes_script_fk' });
    await expect(addScene(adminA, script, clientB, { position: 1, text: 'Agência trocada' })).rejects.toMatchObject(rlsViolation);
    await expect(getOwner().knex('story_script_scenes').insert({ script_id: script, client_id: clientB, position: 1, text: 'Dono do schema' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'story_script_scenes_script_fk' });

    expect(await sceneRows(script)).toHaveLength(0);
  });

  it.each(['script_id', 'client_id', 'id', 'created_at'] as const)('refuses an UPDATE of %s of a scene, at the privilege layer', async (column) => {
    const script = await seedScript(clientA1, 'draft', 1);
    const before = await sceneRows(script);
    const value = { script_id: () => randomUUID(), client_id: () => clientA2, id: () => randomUUID(), created_at: () => new Date(0) }[column]();

    await expect(asUser(adminA, async (transaction) => {
      expect(await transaction('story_script_scenes').where({ script_id: script }).select('id')).toHaveLength(1);
      return await transaction('story_script_scenes').where({ script_id: script }).update({ [column]: value });
    })).rejects.toMatchObject(deniedByGrant('story_script_scenes'));

    expect(await sceneRows(script)).toEqual(before);
  });

  it('refuses two scenes in the same position, and lets one UPDATE swap two positions', async () => {
    const script = await seedScript(clientA1, 'draft', 2);

    await expect(addScene(adminA, script, clientA1, { position: 1, text: 'Repetida' })).rejects.toMatchObject({ code: '23505', constraint: 'story_script_scenes_position_key' });
    await expect(asUser(adminA, (transaction) => transaction('story_script_scenes').where({ script_id: script, position: 2 }).update({ position: 1 })))
      .rejects.toMatchObject({ code: '23505' });

    await asUser(adminA, (transaction) => transaction.raw(
      'update public.story_script_scenes set position = 3 - position where script_id = ?::uuid', [script]
    ));

    expect((await sceneRows(script)).map((row) => [row.position, row.text])).toEqual([[1, 'Cena 2'], [2, 'Cena 1']]);
  });

  it.each([0, -1])('refuses position %i', async (position) => {
    const script = await seedScript(clientA1, 'draft');

    await expect(addScene(adminA, script, clientA1, { position, text: 'Fora' })).rejects.toMatchObject({ code: '23514' });
  });

  it.each(Object.entries(BLANKS))('refuses a scene text that is %s', async (_label, text) => {
    const script = await seedScript(clientA1, 'draft', 1);

    await expect(addScene(adminA, script, clientA1, { position: 2, text })).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(adminA, (transaction) => transaction('story_script_scenes').where({ script_id: script }).update({ text }))).rejects.toMatchObject({ code: '23514' });

    expect((await sceneRows(script)).map((row) => row.text)).toEqual(['Cena 1']);
  });

  it.each(Object.entries(BLANKS))('refuses a guidance that is %s, and accepts none', async (_label, guidance) => {
    const script = await seedScript(clientA1, 'draft');

    await expect(addScene(adminA, script, clientA1, { position: 1, text: 'Com dica', guidance })).rejects.toMatchObject({ code: '23514' });
    await addScene(adminA, script, clientA1, { position: 1, text: 'Sem dica', guidance: null });

    expect((await sceneRows(script)).map((row) => row.guidance)).toEqual([null]);
  });

  it('keeps the spaces around a text that has content, and refuses a text or a guidance over 20000 bytes', async () => {
    const script = await seedScript(clientA1, 'draft');

    await addScene(adminA, script, clientA1, { position: 1, text: '  Olá, mundo  ', guidance: ' Sorria ' });
    expect((await sceneRows(script)).map((row) => [row.text, row.guidance])).toEqual([['  Olá, mundo  ', ' Sorria ']]);

    await addScene(adminA, script, clientA1, { position: 2, text: 'é'.repeat(10_000) });
    await expect(addScene(adminA, script, clientA1, { position: 3, text: 'é'.repeat(10_001) })).rejects.toMatchObject({ code: '23514' });
    await expect(addScene(adminA, script, clientA1, { position: 3, text: 'ok', guidance: 'x'.repeat(20_001) })).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['sent', 'recorded'] as const)('refuses to add, edit or move a scene of a %s script, to an operator who sees it', async (status) => {
    const script = await seedScript(clientA1, status, 2);
    const before = await sceneRows(script);

    await expect(addScene(operarAndVisualizar, script, clientA1, { position: 3, text: 'Atrasada' })).rejects.toMatchObject(WRONG_STATE);
    await expect(asUser(operarAndVisualizar, (transaction) => transaction('story_script_scenes').where({ script_id: script, position: 1 }).update({ text: 'Trocada' })))
      .rejects.toMatchObject(WRONG_STATE);
    await expect(asUser(operarAndVisualizar, (transaction) => transaction('story_script_scenes').where({ script_id: script, position: 1 }).update({ position: 9 })))
      .rejects.toMatchObject(WRONG_STATE);

    expect(await sceneRows(script)).toEqual(before);
  });

  it('refuses a scene for a draft of an archived client, loudly', async () => {
    const script = await seedScript(clientArchived, 'draft', 1);
    await archiveClient(clientArchived);
    const before = await sceneRows(script);

    try {
      await expect(addScene(adminA, script, clientArchived, { position: 2, text: 'Tarde demais' })).rejects.toMatchObject(rlsViolation);
      await expect(asUser(adminA, (transaction) => transaction('story_script_scenes').where({ script_id: script }).update({ text: 'Trocada' }))).rejects.toMatchObject(rlsViolation);
    } finally {
      await getOwner().knex('clients').where({ id: clientArchived }).update({ status: 'active', archived_at: null });
    }

    expect(await sceneRows(script)).toEqual(before);
  });

  it('does not govern the schema owner, whose fixtures may add scenes to a sent script', async () => {
    const script = await seedScript(clientA1, 'sent', 1);

    await getOwner().knex('story_script_scenes').insert({ script_id: script, client_id: clientA1, position: 2, text: 'Do dono' });

    expect(await sceneRows(script)).toHaveLength(2);
  });
});

describe('two transactions at the same time (issue #248)', () => {
  it('does not let a scene slip into a script that is being sent: the scene waits, then is refused', async () => {
    const script = await seedScript(clientA1, 'draft', 1);

    const sending = await openTransactionAs(operarAndVisualizar);
    const adding = await openTransactionAs(productionA);
    let queued: Promise<unknown> | undefined;
    try {
      await sending.raw('select app_private.send_story_script(?::uuid)', [script]);

      queued = adding('story_script_scenes').insert({ script_id: script, client_id: clientA1, position: 2, text: 'No meio do envio' }).then(
        () => 'inserted',
        (error: unknown) => error
      );
      await waitUntilSomeoneWaitsOnALock();
      await sending.commit();
    } catch (error) {
      await sending.rollback().catch(() => undefined);
      await adding.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    expect(await queued).toMatchObject(WRONG_STATE);
    await adding.rollback().catch(() => undefined);
    expect((await scriptRow(script)).status).toBe('sent');
    expect((await sceneRows(script)).map((row) => row.text)).toEqual(['Cena 1']);
  });

  it('makes a send wait for the scene being added, and sends the script with that scene', async () => {
    const script = await seedScript(clientA1, 'draft', 1);

    const adding = await openTransactionAs(productionA);
    const sending = await openTransactionAs(operarAndVisualizar);
    let queued: Promise<unknown> | undefined;
    try {
      await adding('story_script_scenes').insert({ script_id: script, client_id: clientA1, position: 2, text: 'Antes do envio' });

      queued = sending.raw('select app_private.send_story_script(?::uuid)', [script]).then(() => 'sent', (error: unknown) => error);
      await waitUntilSomeoneWaitsOnALock();
      await adding.commit();
    } catch (error) {
      await adding.rollback().catch(() => undefined);
      await sending.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    expect(await queued).toBe('sent');
    await sending.commit();
    expect((await scriptRow(script)).status).toBe('sent');
    expect((await sceneRows(script)).map((row) => row.text)).toEqual(['Cena 1', 'Antes do envio']);
  });

  it('lets two people of the portal record at the same time: one recording, by the first', async () => {
    const script = await seedScript(clientA1, 'sent');

    const first = await openTransactionAs(portalA1);
    const second = await openTransactionAs(portalA1Second);
    let queued: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.record_story_script(?::uuid)', [script]);

      queued = second.raw('select app_private.record_story_script(?::uuid)', [script]).then(() => 'done', (error: unknown) => error);
      await waitUntilSomeoneWaitsOnALock();
      await first.commit();
    } catch (error) {
      await first.rollback().catch(() => undefined);
      await second.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    expect(await queued).toBe('done');
    await second.commit();
    expect(await scriptRow(script)).toMatchObject({ status: 'recorded', recorded_by: portalA1 });
  });
});
