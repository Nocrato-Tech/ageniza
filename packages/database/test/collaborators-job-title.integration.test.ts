import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import knex from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLocalTestDatabaseClient, type DatabaseClient, resolveIntegrationDatabaseUrls } from '../src/index.js';

// Issue #225. `agency_memberships.job_title` is constrained to what the API response schema accepts:
// null, or 1 to 256 **UTF-16 units** after the same trim the contract's `.trim()` does. A CHECK
// applies to every role, so the suite runs as the migration owner and asserts the thrown error or
// the final state, never a bare resolved value.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_NAME = '20261001000000_job_title_format.mjs';

const NBSP = String.fromCharCode(160);
const ZWNBSP = '\uFEFF';
// ECMAScript trim removes a wider whitespace set than btrim: a tab, NBSP and U+FEFF all go.
const JS_WHITESPACE = `\t ${NBSP}${ZWNBSP}`;

let owner: DatabaseClient | undefined;
let productionRoleId: string;
const agencyId = randomUUID();
const userIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

/** Creates a user and a membership with the given job_title; returns the user id. */
const insertMembership = async (jobTitle: string | null): Promise<string> => {
  const userId = randomUUID();
  userIds.push(userId);
  await getOwner().knex('auth.user').insert({ id: userId, name: 'Cargo Pessoa', email: `cargo.${userId.slice(0, 8)}@db-integration.test`, emailVerified: false });
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: productionRoleId, job_title: jobTitle, status: 'active' });
  return userId;
};

const storedJobTitle = async (userId: string): Promise<string | null> => {
  const row = await getOwner().knex('agency_memberships').where({ user_id: userId }).first('job_title');
  return (row?.job_title as string | null | undefined) ?? null;
};

const normalize = async (value: string | null): Promise<string | null> => {
  const result = await getOwner().knex.raw<{ rows: Array<{ value: string | null }> }>(
    'select app_private.normalize_job_title(?::text) as value',
    [value]
  );
  return result.rows[0]?.value ?? null;
};

const utf16Length = async (value: string): Promise<number> => {
  const result = await getOwner().knex.raw<{ rows: Array<{ length: number }> }>(
    'select app_private.utf16_length(?::text) as length',
    [value]
  );
  return Number(result.rows[0]?.length);
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  await getOwner().knex('agencies').insert({ id: agencyId, name: `Cargo DB ${agencyId.slice(0, 8)}`, owner_user_id: null, status: 'active' });
  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  productionRoleId = role.id as string;
});

afterAll(async () => {
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', userIds).delete();
  await owner?.close();
});

describe('agency_memberships.job_title format (issue #225)', () => {
  it('accepts null, a valid title, and a title of 256 UTF-16 units', async () => {
    await expect(insertMembership(null)).resolves.toEqual(expect.any(String));
    await expect(insertMembership('Editor de Vídeo')).resolves.toEqual(expect.any(String));
    await expect(insertMembership('a'.repeat(256))).resolves.toEqual(expect.any(String));
  });

  it('stores a whitespace-only title as null and rejects over 256 ASCII characters', async () => {
    // A tab or a NBSP is whitespace for the contract's trim: the trigger stores null, which the
    // nullable schema accepts. Over the limit, there is no valid stored form, so the CHECK refuses.
    const tabId = await insertMembership('\t');
    const nbspId = await insertMembership(NBSP);
    await expect(storedJobTitle(tabId)).resolves.toBeNull();
    await expect(storedJobTitle(nbspId)).resolves.toBeNull();
    await expect(insertMembership('a'.repeat(257))).rejects.toThrow(/agency_memberships_job_title_format/);
  });

  it('rejects the forms the contract rejects but Postgres would have counted differently', async () => {
    // 129 astral emoji are 258 UTF-16 units but only 129 code points.
    const emoji129 = '😀'.repeat(129);
    await expect(utf16Length(emoji129)).resolves.toBe(258);
    await expect(insertMembership(emoji129)).rejects.toThrow(/agency_memberships_job_title_format/);

    // A + 300 internal spaces + B: the contract's trim keeps the spaces, so the length is 302.
    const padded = `A${' '.repeat(300)}B`;
    await expect(utf16Length(padded)).resolves.toBe(302);
    await expect(insertMembership(padded)).rejects.toThrow(/agency_memberships_job_title_format/);
  });

  it('normalizes a legacy value without losing the valid title', async () => {
    // Trim removes the tab/NBSP/U+FEFF edges but keeps internal whitespace, exactly like JS trim.
    await expect(normalize(`  Editor \t de ${NBSP} Vídeo  `)).resolves.toBe(`Editor \t de ${NBSP} Vídeo`);
    await expect(normalize('Editor de Vídeo')).resolves.toBe('Editor de Vídeo');
    await expect(normalize('a'.repeat(256))).resolves.toBe('a'.repeat(256));
    await expect(normalize(`${ZWNBSP} x ${ZWNBSP}`)).resolves.toBe('x');
    await expect(normalize(JS_WHITESPACE)).resolves.toBeNull();
    await expect(normalize(null)).resolves.toBeNull();
  });

  it('stores the normalized form on write, including U+FEFF', async () => {
    // U+FEFF is whitespace for the contract's trim: the trigger stores null, which the schema accepts.
    const bomId = await insertMembership(ZWNBSP);
    await expect(storedJobTitle(bomId)).resolves.toBeNull();

    // A value wrapped in U+FEFF is stored trimmed, not raw.
    const wrappedId = await insertMembership(`${ZWNBSP}Editor${ZWNBSP}`);
    await expect(storedJobTitle(wrappedId)).resolves.toBe('Editor');
  });
});

describe('upgrade of a real legacy job_title (issue #225)', () => {
  it('does not abort the deploy on a legacy 257-character row: it drops it explicitly', async () => {
    const databaseName = `ageniza_upgrade_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
    await admin.raw(`create database "${databaseName}"`);
    try {
      const target = new URL(ownerUrl);
      target.pathname = `/${databaseName}`;
      const upgrade = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 1 } });
      try {
        await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });

        // Put the column back in its pre-upgrade state and write real legacy data.
        await upgrade.raw('drop trigger if exists agency_memberships_job_title_normalize on public.agency_memberships');
        await upgrade.raw('alter table public.agency_memberships drop constraint if exists agency_memberships_job_title_format');

        const role = await upgrade('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
        const upgradeAgencyId = randomUUID();
        const longId = randomUUID();
        const blankId = randomUUID();
        const validId = randomUUID();
        await upgrade('agencies').insert({ id: upgradeAgencyId, name: `Upgrade ${upgradeAgencyId.slice(0, 8)}`, owner_user_id: null, status: 'active' });
        await upgrade('auth.user').insert([
          { id: longId, name: 'Legacy 257', email: `legacy.${longId.slice(0, 8)}@db-integration.test`, emailVerified: false },
          { id: blankId, name: 'Legacy blank', email: `blank.${blankId.slice(0, 8)}@db-integration.test`, emailVerified: false },
          { id: validId, name: 'Legacy valid', email: `valid.${validId.slice(0, 8)}@db-integration.test`, emailVerified: false }
        ]);
        await upgrade('agency_memberships').insert([
          { agency_id: upgradeAgencyId, user_id: longId, role_id: role.id, job_title: 'a'.repeat(257), status: 'active' },
          { agency_id: upgradeAgencyId, user_id: blankId, role_id: role.id, job_title: JS_WHITESPACE, status: 'active' },
          { agency_id: upgradeAgencyId, user_id: validId, role_id: role.id, job_title: '  Editor \t ', status: 'active' }
        ]);

        // Re-apply the migration over the legacy data (the record is removed so knex runs it again).
        await upgrade('knex_migrations').where({ name: MIGRATION_NAME }).delete();
        // The upgrade must leave a record of what the backfill dropped, not just change the rows.
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        let backfillLog = '';
        try {
          await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });
        } finally {
          backfillLog = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
          logSpy.mockRestore();
        }
        expect(backfillLog).toContain('"whitespace_nulled":1');
        expect(backfillLog).toContain('"over_limit_nulled":1');

        const rows = await upgrade('agency_memberships').where({ agency_id: upgradeAgencyId }).select('user_id', 'job_title');
        const byUser = new Map(rows.map((row) => [row.user_id as string, row.job_title as string | null]));
        expect(byUser.get(longId)).toBeNull();
        expect(byUser.get(blankId)).toBeNull();
        expect(byUser.get(validId)).toBe('Editor');

        // The constraint is back and refuses the 257-character form on a new write.
        await expect(
          upgrade('agency_memberships').insert({ agency_id: upgradeAgencyId, user_id: randomUUID(), role_id: role.id, job_title: 'a'.repeat(257), status: 'active' })
        ).rejects.toThrow(/agency_memberships_job_title_format/);
      } finally {
        await upgrade.destroy();
      }
    } finally {
      await admin.raw(`drop database if exists "${databaseName}" with (force)`);
      await admin.destroy();
    }
  }, 180_000);
});

describe('function grants of the job_title migration (issue #97)', () => {
  const privilege = async (role: string, signature: string): Promise<boolean> => {
    const result = await getOwner().knex.raw<{ rows: Array<{ allowed: boolean }> }>(
      'select has_function_privilege(?, ?, \'execute\') as allowed',
      [role, signature]
    );
    return result.rows[0]?.allowed === true;
  };

  // The two helpers the API relies on are the only ones the application role may execute; the
  // backfill rewrites every membership and the trigger function is not an entry point, so neither
  // is granted to ageniza_app or left to PUBLIC.
  it('lets ageniza_app execute only normalize_job_title and utf16_length', async () => {
    await expect(privilege('ageniza_app', 'app_private.normalize_job_title(text)')).resolves.toBe(true);
    await expect(privilege('ageniza_app', 'app_private.utf16_length(text)')).resolves.toBe(true);
    for (const signature of ['app_private.backfill_job_title()', 'app_private.set_job_title()']) {
      await expect(privilege('ageniza_app', signature)).resolves.toBe(false);
      await expect(privilege('public', signature)).resolves.toBe(false);
    }
  });

  it('refuses to run the backfill as ageniza_app', async () => {
    const application = createLocalTestDatabaseClient(applicationUrl);
    try {
      await expect(application.knex.raw('select * from app_private.backfill_job_title()')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await application.close();
    }
  });
});
