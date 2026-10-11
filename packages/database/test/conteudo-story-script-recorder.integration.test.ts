import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #258. `app_private.story_script_recorder` names the person who recorded a script, by the link of that
// person to the client, for the two sides: the agency that reads Conteúdo and the active people of the client's
// portal, who cannot read each other's link. Every call runs as `ageniza_app`; a caller who may not read the script
// gets zero rows, exactly like a script that does not exist, so each refusal is checked by the rows it returns.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();

const ownerA = randomUUID();
const recorder = randomUUID();
const recorderRemoved = randomUUID();
const recorderOnlyOtherClient = randomUUID();
const recorderNoLink = randomUUID();
const portalReader = randomUUID();
const portalRemoved = randomUUID();
const portalA2 = randomUUID();
const portalB = randomUUID();
const onlyVisualizar = randomUUID();
const onlyOperar = randomUUID();
const sales = randomUUID();
const dualFull = randomUUID();
const adminB = randomUUID();
const stranger = randomUUID();

const names: Record<string, string> = {};
const allUsers = [
  ownerA, recorder, recorderRemoved, recorderOnlyOtherClient, recorderNoLink, portalReader, portalRemoved, portalA2, portalB,
  onlyVisualizar, onlyOperar, sales, dualFull, adminB, stranger
];
const allAgencies = [agencyA, agencyB];
const allClients = [clientA1, clientA2, clientB];
const roleIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

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

// Fixtures are written by the schema owner, the one role that may insert a script already recorded.
const seedScript = async (clientId: string, status: 'draft' | 'sent' | 'recorded', recordedBy?: string): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('story_scripts').insert({
    id,
    client_id: clientId,
    script_on: '2026-10-20',
    status,
    ...(status === 'recorded' ? { recorded_by: recordedBy, recorded_at: new Date('2026-10-07T12:00:00.000Z') } : {})
  });
  return id;
};

const recorderAs = (userId: string, scriptId: string): Promise<Array<{ recorded_by: string; name: string }>> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), async (transaction) => {
    const result = await transaction.raw<{ rows: Array<{ recorded_by: string; name: string }> }>(
      'select * from app_private.story_script_recorder(?::uuid)', [scriptId]
    );
    return result.rows;
  });

let recordedByRecorder: string;
let recordedByRemoved: string;
let recordedByOtherClient: string;
let recordedByNoLink: string;
let sentScript: string;
let draftScript: string;
let recordedOfA2: string;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const [admin, production, salesRole] = await Promise.all(['admin', 'production', 'sales'].map(presetRole));
  for (const id of allUsers) names[id] = `Nome ${id.slice(0, 8)}`;

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert(allUsers.map((id) => ({ id, name: names[id], email: `${id}@gravou-roteiro.test`, emailVerified: true })));
    await transaction('agencies').insert([
      { id: agencyA, name: `Gravou A ${agencyA}`, owner_user_id: ownerA },
      { id: agencyB, name: `Gravou B ${agencyB}` }
    ]);
  });
  const visualizarRole = await customRole(agencyA, 'conteudo.visualizar');
  const operarRole = await customRole(agencyA, 'conteudo.operar');
  await getOwner().transaction(async (transaction) => {
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: onlyVisualizar, role_id: visualizarRole },
      { agency_id: agencyA, user_id: onlyOperar, role_id: operarRole },
      { agency_id: agencyA, user_id: sales, role_id: salesRole },
      { agency_id: agencyA, user_id: dualFull, role_id: production },
      { agency_id: agencyB, user_id: adminB, role_id: admin }
    ]);
    await transaction('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Cliente A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
      { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` }
    ]);
    await transaction('client_memberships').insert([
      { client_id: clientA1, user_id: recorder },
      { client_id: clientA1, user_id: recorderRemoved, status: 'removed' },
      { client_id: clientA2, user_id: recorderOnlyOtherClient },
      { client_id: clientA1, user_id: portalReader },
      { client_id: clientA1, user_id: portalRemoved, status: 'removed' },
      { client_id: clientA1, user_id: dualFull },
      { client_id: clientA2, user_id: portalA2 },
      { client_id: clientB, user_id: portalB }
    ]);
  });

  recordedByRecorder = await seedScript(clientA1, 'recorded', recorder);
  recordedByRemoved = await seedScript(clientA1, 'recorded', recorderRemoved);
  recordedByOtherClient = await seedScript(clientA1, 'recorded', recorderOnlyOtherClient);
  recordedByNoLink = await seedScript(clientA1, 'recorded', recorderNoLink);
  sentScript = await seedScript(clientA1, 'sent');
  draftScript = await seedScript(clientA1, 'draft');
  recordedOfA2 = await seedScript(clientA2, 'recorded', recorderOnlyOtherClient);
});

afterAll(async () => {
  try {
    await getOwner().knex('story_scripts').whereIn('client_id', allClients).delete();
    await getOwner().knex('client_memberships').whereIn('client_id', allClients).delete();
    await getOwner().knex('agency_memberships').whereIn('agency_id', allAgencies).delete();
    await getOwner().knex('clients').whereIn('id', allClients).delete();
    await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
    await getOwner().knex('roles').whereIn('id', roleIds).delete();
    await getOwner().knex('agencies').whereIn('id', allAgencies).update({ owner_user_id: null });
    await getOwner().knex('agencies').whereIn('id', allAgencies).delete();
    await getOwner().knex('auth.user').whereIn('id', allUsers).delete();
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('who recorded a story script (issue #258)', () => {
  it('names the person by their link to the client, to every active person of the portal of that client', async () => {
    for (const reader of [portalReader, recorder, dualFull]) {
      expect({ reader, rows: await recorderAs(reader, recordedByRecorder) }).toEqual({ reader, rows: [{ recorded_by: recorder, name: names[recorder] }] });
    }
  });

  it('names the person to the agency that reads Conteúdo, whichever the role: the Owner, one with only conteudo.visualizar and the Production preset', async () => {
    for (const reader of [ownerA, onlyVisualizar, dualFull]) {
      expect({ reader, rows: await recorderAs(reader, recordedByRecorder) }).toEqual({ reader, rows: [{ recorded_by: recorder, name: names[recorder] }] });
    }
  });

  it('keeps the name of a person whose link was removed afterwards: the recording is history', async () => {
    expect(await recorderAs(portalReader, recordedByRemoved)).toEqual([{ recorded_by: recorderRemoved, name: names[recorderRemoved] }]);
    expect(await recorderAs(onlyVisualizar, recordedByRemoved)).toEqual([{ recorded_by: recorderRemoved, name: names[recorderRemoved] }]);
  });

  it('answers nothing for a script that was only sent, a draft and an absent one, to anyone who may read them', async () => {
    for (const reader of [portalReader, onlyVisualizar, ownerA, dualFull]) {
      for (const script of [sentScript, draftScript, randomUUID()]) {
        expect({ reader, script, rows: await recorderAs(reader, script) }).toEqual({ reader, script, rows: [] });
      }
    }
  });

  it('answers nothing for who may not read the script: no link, a removed link, the wrong client, another agency, a role without conteudo.visualizar', async () => {
    for (const reader of [stranger, portalRemoved, portalA2, portalB, adminB, onlyOperar, sales]) {
      expect({ reader, rows: await recorderAs(reader, recordedByRecorder) }).toEqual({ reader, rows: [] });
    }
    expect(await recorderAs(portalReader, recordedOfA2)).toEqual([]);
  });

  it('answers nothing when the person who recorded has no link to THIS client: a link to another client names nobody here', async () => {
    expect(await recorderAs(portalReader, recordedByOtherClient)).toEqual([]);
    expect(await recorderAs(onlyVisualizar, recordedByOtherClient)).toEqual([]);
    expect(await recorderAs(portalReader, recordedByNoLink)).toEqual([]);
    expect(await recorderAs(onlyVisualizar, recordedByNoLink)).toEqual([]);
    expect(await recorderAs(portalA2, recordedOfA2)).toEqual([{ recorded_by: recorderOnlyOtherClient, name: names[recorderOnlyOtherClient] }]);
  });

  it('gives only the person and the name: nothing else of the account', async () => {
    const result = await withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: portalReader }), (transaction) =>
      transaction.raw<{ rows: Array<Record<string, unknown>> }>('select * from app_private.story_script_recorder(?::uuid)', [recordedByRecorder]));

    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['name', 'recorded_by']);
  });

  it('is a security definer with an empty search_path, closed to public and open to ageniza_app only', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ definer: boolean; config: string[] | null; public_execute: boolean; app_execute: boolean }> }>(`
      select p.prosecdef as definer, p.proconfig as config,
        has_function_privilege('public', p.oid, 'execute') as public_execute,
        has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'story_script_recorder'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ definer: true, config: ['search_path=""'], public_execute: false, app_execute: true });
  });
});
