import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  raw,
  resolveIntegrationDatabaseUrls,
  type DatabaseClient
} from '../src/index.js';

// Decision 2026-10-27, "a conta de convite só entra depois de confirmar": the agency and client guards and the list of
// contexts ask this function whether the account may be given anything. It fails closed: only a confirmed account passes.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient;
let application: DatabaseClient;
const createdUsers: string[] = [];

const newUser = async (emailVerified: boolean): Promise<string> => {
  const id = randomUUID();
  createdUsers.push(id);
  await owner.knex('auth.user').insert({ id, name: 'Confirmed or not', email: `not-confirmed-${id}@example.test`, emailVerified });
  return id;
};

const notConfirmed = async (userId: string): Promise<boolean> => {
  const { rows } = await raw<{ rows: readonly { unconfirmed: boolean }[] }>(application.knex, 'select app_private.email_not_confirmed(?::uuid) as unconfirmed', [userId]);
  return rows[0]!.unconfirmed;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await owner.knex('auth.user').whereIn('id', createdUsers).delete();
  await application.close();
  await owner.close();
});

describe('app_private.email_not_confirmed', () => {
  it('is no for a confirmed account and yes for one that is not', async () => {
    await expect(notConfirmed(await newUser(true))).resolves.toBe(false);
    await expect(notConfirmed(await newUser(false))).resolves.toBe(true);
  });

  it('follows the account when it is confirmed later', async () => {
    const id = await newUser(false);
    await owner.knex('auth.user').where({ id }).update({ emailVerified: true });
    await expect(notConfirmed(id)).resolves.toBe(false);
  });

  it('is yes for an id that is not an account, so a mistake of the caller fails closed', async () => {
    await expect(notConfirmed(randomUUID())).resolves.toBe(true);
  });

  it('is security definer with a fixed search_path, and only ageniza_app and its owner execute it, never PUBLIC', async () => {
    const { rows } = await raw<{ rows: readonly { definer: boolean; config: readonly string[] | null; grantees: readonly string[] }[] }>(owner.knex, `
      select p.prosecdef as definer, p.proconfig as config,
        array(
          select (case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee)::text end)
          from pg_catalog.aclexplode(p.proacl) acl where acl.privilege_type = 'EXECUTE'
          order by 1
        )::text[] as grantees
      from pg_catalog.pg_proc p
      where p.oid = 'app_private.email_not_confirmed(uuid)'::regprocedure
    `, []);
    expect(rows[0]?.definer).toBe(true);
    expect(rows[0]?.config).toEqual(['search_path=""']);
    expect(rows[0]?.grantees).toEqual(['ageniza_app', 'postgres']);
  });
});
