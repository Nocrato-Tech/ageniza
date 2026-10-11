import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #81. `app_private.accept_legal_document` is the only path through which the application
// role records an acceptance of one document; the table itself still refuses a direct INSERT
// (tenancy.integration.test.ts pins that). Everything below runs as ageniza_app.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const actorA = randomUUID();
const actorB = randomUUID();
const actorC = randomUUID();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(
  userId: string,
  work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]
): Promise<TResult> => withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const accept = (userId: string, document: string | null, version: string | null): Promise<boolean> =>
  asUser(userId, async (transaction) => {
    const result = await raw<{ rows: readonly { recorded: boolean }[] }>(transaction, 'select app_private.accept_legal_document(?, ?) as recorded', [document, version]);
    return result.rows[0]?.recorded ?? false;
  });

const rowsOf = (userId: string): Promise<{ document: string; version: string }[]> =>
  getOwner().knex('legal_acceptances').where({ user_id: userId }).orderBy([{ column: 'document' }, { column: 'version' }]).select('document', 'version');

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  await getOwner().knex('auth.user').insert([
    { id: actorA, name: 'Legal A', email: `legal-a-${actorA}@example.test`, emailVerified: true },
    { id: actorB, name: 'Legal B', email: `legal-b-${actorB}@example.test`, emailVerified: true },
    { id: actorC, name: 'Legal C', email: `legal-c-${actorC}@example.test`, emailVerified: true }
  ]);
});

afterAll(async () => {
  await getOwner().knex('legal_acceptances').whereIn('user_id', [actorA, actorB, actorC]).delete();
  await getOwner().knex('auth.user').whereIn('id', [actorA, actorB, actorC]).delete();
  await application?.close();
  await owner?.close();
});

describe('app_private.accept_legal_document (issue #81)', () => {
  it('records one document at the given version, for the bound actor only', async () => {
    await expect(accept(actorA, 'privacy', '2026-05-01')).resolves.toBe(true);

    await expect(rowsOf(actorA)).resolves.toEqual([{ document: 'privacy', version: '2026-05-01' }]);
    await expect(rowsOf(actorB)).resolves.toEqual([]);
  });

  it('is a no-op for the same version, and for any older one, and moves forward for a newer one', async () => {
    await expect(accept(actorA, 'terms', '2026-03-01')).resolves.toBe(true);
    await expect(accept(actorA, 'terms', '2026-03-01')).resolves.toBe(false);
    await expect(accept(actorA, 'terms', '2026-02-28')).resolves.toBe(false);
    await expect(accept(actorA, 'terms', '2025-12-31')).resolves.toBe(false);
    await expect(rowsOf(actorA)).resolves.toEqual([
      { document: 'privacy', version: '2026-05-01' },
      { document: 'terms', version: '2026-03-01' }
    ]);

    await expect(accept(actorA, 'terms', '2026-03-02')).resolves.toBe(true);
    await expect(rowsOf(actorA)).resolves.toEqual([
      { document: 'privacy', version: '2026-05-01' },
      { document: 'terms', version: '2026-03-01' },
      { document: 'terms', version: '2026-03-02' }
    ]);
  });

  it('keeps the two documents apart: accepting one never touches the other', async () => {
    await expect(accept(actorB, 'terms', '2026-03-01')).resolves.toBe(true);

    await expect(rowsOf(actorB)).resolves.toEqual([{ document: 'terms', version: '2026-03-01' }]);
    await expect(accept(actorB, 'privacy', '2026-01-01')).resolves.toBe(true);
    await expect(rowsOf(actorB)).resolves.toEqual([
      { document: 'privacy', version: '2026-01-01' },
      { document: 'terms', version: '2026-03-01' }
    ]);
  });

  it('refuses a transaction with no actor bound, and ignores a forged app.user_id', async () => {
    await expect(getApplication().transaction(async (transaction) => {
      await raw(transaction, "select set_config('app.user_id', ?, true)", [actorA]);
      await raw(transaction, "select app_private.accept_legal_document('terms', '2030-01-01')", []);
    })).rejects.toMatchObject({ code: 'A0030' });
    await expect(getApplication().transaction((transaction) =>
      raw(transaction, "select app_private.accept_legal_document('terms', '2030-01-01')", [])
    )).rejects.toMatchObject({ code: 'A0030' });

    await expect(rowsOf(actorA)).resolves.not.toContainEqual({ document: 'terms', version: '2030-01-01' });
  });

  it('refuses a document the table does not know and a version that is not YYYY-MM-DD, recording nothing', async () => {
    const before = await rowsOf(actorA);

    for (const [document, version] of [
      ['cookies', '2026-06-01'],
      ['TERMS', '2026-06-01'],
      ['terms ', '2026-06-01'],
      [null, '2026-06-01'],
      ['terms', null],
      ['terms', ''],
      ['terms', 'latest'],
      ['terms', '2026-6-1'],
      ['terms', '2026-06-01 '],
      ['terms', '2026-06-01\n'],
      ['terms', '2026-06-01T00:00:00Z'],
      ['terms', '20260601']
    ] as const) {
      await expect(accept(actorA, document, version), `${String(document)} ${String(version)}`).rejects.toMatchObject({ code: 'A0031' });
    }

    await expect(rowsOf(actorA)).resolves.toEqual(before);
  });

  it('refuses a version that is not a real date or lies in the future, recording nothing', async () => {
    const before = await rowsOf(actorA);
    const sao = await raw<{ rows: { today: string; tomorrow: string }[] }>(getOwner().knex, `
      select ((now() at time zone 'America/Sao_Paulo')::date)::text as today,
             ((now() at time zone 'America/Sao_Paulo')::date + 1)::text as tomorrow
    `, []);
    const { tomorrow } = sao.rows[0]!;

    for (const version of ['2026-02-30', '2025-02-29', '2026-99-99', '2026-13-01', '2026-00-10', '2026-04-31', '0000-01-01', '9999-12-31', tomorrow]) {
      await expect(accept(actorA, 'terms', version), version).rejects.toMatchObject({ code: 'A0031' });
      await expect(accept(actorA, 'privacy', version), version).rejects.toMatchObject({ code: 'A0031' });
    }

    await expect(rowsOf(actorA)).resolves.toEqual(before);
  });

  it('accepts today in the product time zone and a leap day, the two edges of the rule', async () => {
    const actor = actorC;
    const sao = await raw<{ rows: { today: string }[] }>(getOwner().knex, `select ((now() at time zone 'America/Sao_Paulo')::date)::text as today`, []);
    const { today } = sao.rows[0]!;

    await expect(accept(actor, 'privacy', '2024-02-29')).resolves.toBe(true);
    await expect(accept(actor, 'terms', today)).resolves.toBe(true);

    await expect(rowsOf(actor)).resolves.toEqual([{ document: 'privacy', version: '2024-02-29' }, { document: 'terms', version: today }]);
  });

  it('is executable by ageniza_app and not by PUBLIC', async () => {
    const privileges = await raw<{ rows: readonly { app: boolean; public_role: boolean }[] }>(getOwner().knex, `
      select
        has_function_privilege('ageniza_app', 'app_private.accept_legal_document(text, text)', 'execute') as app,
        exists (
          select 1
          from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
          where p.oid = 'app_private.accept_legal_document(text, text)'::regprocedure and acl.grantee = 0
        ) as public_role
    `, []);
    expect(privileges.rows[0]).toEqual({ app: true, public_role: false });
  });

  // Issue #343. The privilege layer refuses before the RLS is consulted, so the message names the
  // table privilege, not a policy: "row-level security" would mean the grant is back.
  it('refuses a direct insert, update and delete at the privilege layer, leaving the rows intact', async () => {
    await accept(actorB, 'terms', '2026-03-01');
    const before = await rowsOf(actorB);
    const denied = { code: '42501', message: expect.stringContaining('permission denied for table legal_acceptances') };

    await expect(asUser(actorB, (transaction) => transaction('legal_acceptances').insert({ user_id: actorB, document: 'terms', version: '2031-01-01' })))
      .rejects.toMatchObject(denied);
    await expect(asUser(actorB, (transaction) => transaction('legal_acceptances').where({ user_id: actorB }).update({ version: '2031-01-01' })))
      .rejects.toMatchObject(denied);
    await expect(asUser(actorB, (transaction) => transaction('legal_acceptances').where({ user_id: actorB }).update({ accepted_at: new Date(0) })))
      .rejects.toMatchObject(denied);
    await expect(asUser(actorB, (transaction) => transaction('legal_acceptances').where({ user_id: actorB }).delete()))
      .rejects.toMatchObject(denied);

    await expect(rowsOf(actorB)).resolves.toEqual(before);
  });

  it('leaves ageniza_app the SELECT behind the policy and no other privilege on the table or any column', async () => {
    const { rows } = await raw<{ rows: readonly Record<string, boolean>[] }>(getOwner().knex, `
      select
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'select') as can_select,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'insert') as can_insert,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'update') as can_update,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'delete') as can_delete,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'truncate') as can_truncate,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'references') as can_references,
        has_table_privilege('ageniza_app', 'public.legal_acceptances', 'trigger') as can_trigger,
        has_any_column_privilege('ageniza_app', 'public.legal_acceptances', 'insert') as any_column_insert,
        has_any_column_privilege('ageniza_app', 'public.legal_acceptances', 'update') as any_column_update
    `, []);

    expect(rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_references: false,
      can_trigger: false,
      any_column_insert: false,
      any_column_update: false
    });
  });
});
