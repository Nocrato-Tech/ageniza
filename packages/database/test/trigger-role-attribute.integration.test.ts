import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';
import { createContentWorld } from './support/content-world.js';

// Issue #397. The triggers that govern the application role decided who that is by a login name, so a new login that
// is not `ageniza_app` and has no bypass (a pooler, a worker with another login) was skipped: its `session_user` is not
// the application role even after `SET ROLE ageniza_app`, and its `current_user` is not when it inherits the grants. They
// now skip only a role that RLS and grants do not constrain either, by attribute (`rolsuper`, `rolbypassrls`).
const w = createContentWorld('role-attribute');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

const suffix = randomUUID().slice(0, 8).replaceAll('-', '');
const roles = {
  plain: `test_plain_${suffix}`,
  bypass: `test_bypass_${suffix}`,
  superuser: `test_super_${suffix}`,
  neither: `test_neither_${suffix}`
};
const logins: DatabaseClient[] = [];
const clients: string[] = [];

const loginUrl = (role: string): string => {
  const url = new URL(applicationUrl);
  url.username = role;
  url.password = 'login-secret';
  return url.toString();
};

const openLogin = (role: string): DatabaseClient => {
  const client = createLocalTestDatabaseClient(loginUrl(role));
  logins.push(client);
  return client;
};

beforeAll(async () => {
  await w.setup();
  const knex = w.getOwner().knex;
  // Members of the application role: they can `SET ROLE ageniza_app`, and inherit what it holds.
  await knex.raw(`create role "${roles.plain}" login password 'login-secret' in role ageniza_app`);
  await knex.raw(`create role "${roles.bypass}" login password 'login-secret' bypassrls in role ageniza_app`);
  await knex.raw(`create role "${roles.superuser}" login password 'login-secret' superuser`);
  await knex.raw(`create role "${roles.neither}" nologin`);
});

afterAll(async () => {
  await Promise.all(logins.map((login) => login.close()));
  const knex = w.getOwner().knex;
  try {
    for (const id of clients) {
      for (const table of ['client_personas', 'media_assets', 'media_folders', 'client_memberships']) await knex(table).where({ client_id: id }).delete();
      await knex('clients').where({ id }).delete();
    }
  } finally {
    for (const role of Object.values(roles)) await knex.raw(`drop role if exists "${role}"`);
    await w.teardown();
  }
});

const newClient = async (): Promise<string> => {
  const id = randomUUID();
  clients.push(id);
  await w.getOwner().knex('clients').insert({ id, agency_id: ids.agencyA, name: `Papel ${id}` });
  return id;
};

const personaCount = async (clientId: string): Promise<number> =>
  Number((await w.getOwner().knex('client_personas').where({ client_id: clientId }).count<Array<{ count: string }>>('* as count'))[0]!.count);

describe('app_private.role_bypasses_rls', () => {
  const bypasses = async (role: string): Promise<boolean> => {
    const { rows } = await raw<{ rows: readonly { bypasses: boolean }[] }>(w.getOwner().knex, 'select app_private.role_bypasses_rls(?::name) as bypasses', [role]);
    return rows[0]!.bypasses;
  };

  it('is true for a role with rolsuper or with rolbypassrls, whatever its name', async () => {
    expect(await bypasses('postgres')).toBe(true);
    expect(await bypasses(roles.superuser)).toBe(true);
    expect(await bypasses(roles.bypass)).toBe(true);
  });

  it('is false for the application role, for a login that is a member of it without a bypass, and for a role with no attribute', async () => {
    expect(await bypasses('ageniza_app')).toBe(false);
    expect(await bypasses(roles.plain)).toBe(false);
    expect(await bypasses(roles.neither)).toBe(false);
  });

  it('is false for a role that does not exist, so a typo or a dropped role is constrained', async () => {
    expect(await bypasses(`no_such_role_${suffix}`)).toBe(false);
  });

  it('is closed to PUBLIC and open to the application role, with a fixed search_path', async () => {
    const { rows } = await raw<{ rows: readonly { app: boolean; public_role: boolean; fixed_path: boolean }[] }>(w.getOwner().knex, `
      select
        has_function_privilege('ageniza_app', p.oid, 'execute') as app,
        exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0
        ) as public_role,
        coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path
      from pg_catalog.pg_proc p
      where p.oid = 'app_private.role_bypasses_rls(name)'::regprocedure
    `, []);
    expect(rows[0]).toEqual({ app: true, public_role: false, fixed_path: true });
  });
});

describe('the lock of the archive is taken for a login that is not the application role (acceptance 1)', () => {
  // The archive stays uncommitted, and the persona is written by a login that does `SET ROLE ageniza_app`, as the
  // application role would write it: with the lock it waits for the archive and is refused, without it it is written.
  const writePersonaAsApplicationRole = (login: DatabaseClient, clientId: string): Promise<unknown> =>
    login.knex.transaction(async (transaction: Knex.Transaction) => {
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('client_personas').insert({ client_id: clientId, name: 'Pelo login novo', updated_by: ids.adminA });
    }).then(() => 'written' as const, (error: unknown) => error);

  it('makes a new login without bypass wait for the archive and be refused with A0020, writing nothing', async () => {
    const client = await newClient();
    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [client]);
      outcome = writePersonaAsApplicationRole(openLogin(roles.plain), client);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0020' });
    expect(await personaCount(client)).toBe(0);
  });

  // The foreign key waits for the archive too, so waiting does not tell the trigger apart: what does is the outcome
  // after the commit, as in the test of the owner of client-archive.integration.test.ts.
  it('leaves a login with rolbypassrls alone, as it does the owner: the row enters the archived client', async () => {
    const client = await newClient();
    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [client]);
      outcome = writePersonaAsApplicationRole(openLogin(roles.bypass), client);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toBe('written');
    expect(await personaCount(client)).toBe(1);
  });
});

describe('the guards of the application role run for a login that inherits its grants (acceptance 1)', () => {
  const backwards = async (login: DatabaseClient, assetId: string): Promise<unknown> =>
    login.knex.transaction(async (transaction: Knex.Transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('media_assets').where({ id: assetId }).update({ status: 'pending' });
    }).then(() => 'written' as const, (error: unknown) => error);

  it('refuses to move a confirmed upload back to pending for a member of the application role, and keeps the row', async () => {
    const client = await newClient();
    const asset = await w.seedAsset(client, await w.folderOf(client), { status: 'confirmed' });

    expect(await backwards(openLogin(roles.plain), asset)).toMatchObject({
      code: '42501', message: expect.stringContaining('A media upload can only move from pending to confirmed or rejected.')
    });
    expect((await w.getOwner().knex('media_assets').where({ id: asset }).first('status'))!.status).toBe('confirmed');
  });

  it('lets the owner and a login with rolbypassrls through, because RLS and grants do not constrain them either', async () => {
    const client = await newClient();
    const asset = await w.seedAsset(client, await w.folderOf(client), { status: 'confirmed' });
    const other = await w.seedAsset(client, await w.folderOf(client), { status: 'confirmed' });

    await w.getOwner().knex('media_assets').where({ id: asset }).update({ status: 'pending' });
    expect(await backwards(openLogin(roles.bypass), other)).toBe('written');
    expect((await w.getOwner().knex('media_assets').where({ id: other }).first('status'))!.status).toBe('pending');
  });
});

describe('no function decides who is constrained by a name (acceptance 1: attribute, never the login)', () => {
  // A trigger written later with `current_user <> 'something'` is the same defect again, so the catalog is scanned.
  it('has no function that compares current_user or session_user with a literal', async () => {
    const { rows } = await raw<{ rows: readonly { object: string }[] }>(w.getOwner().knex, `
      select p.pronamespace::regnamespace || '.' || p.proname as object
      from pg_catalog.pg_proc p
      where p.prokind = 'f'
        and p.pronamespace::regnamespace::text in ('public', 'app_private', 'audit', 'auth')
        and pg_catalog.pg_get_functiondef(p.oid) ~* '(current_user|session_user)\\s*(<>|!=|=)\\s*'''
      order by 1
    `, []);
    expect(rows).toEqual([]);
  });

  it('has the five guards ask role_bypasses_rls with the identity each can see', async () => {
    const definitionOf = async (signature: string): Promise<string> => {
      const { rows } = await raw<{ rows: readonly { definition: string }[] }>(w.getOwner().knex, 'select pg_catalog.pg_get_functiondef(?::regprocedure) as definition', [signature]);
      return rows[0]!.definition;
    };
    for (const signature of [
      'app_private.check_agency_membership_update()',
      'app_private.invitation_state_is_forward_only()',
      'app_private.media_asset_upload_state_is_forward_only()',
      'app_private.story_script_scenes_guard_write()'
    ]) {
      expect(await definitionOf(signature), signature).toContain('if app_private.role_bypasses_rls(current_user) then');
    }
    // Inside a security definer function current_user is the owner, so the definer one reads the login.
    expect(await definitionOf('app_private.lock_active_client_of_child()')).toContain('app_private.role_bypasses_rls(session_user)');
  });
});
