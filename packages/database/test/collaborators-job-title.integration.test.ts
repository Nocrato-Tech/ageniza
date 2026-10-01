import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, type DatabaseClient } from '../src/index.js';

// Issue #225. `agency_memberships.job_title` is constrained to what the API response schema accepts:
// null, or 1 to 256 characters after whitespace normalization. A CHECK applies to every role, so the
// suite runs as the migration owner and asserts the thrown error, never a bare resolved value.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

const NBSP = String.fromCharCode(160);

let owner: DatabaseClient | undefined;
let productionRoleId: string;
const agencyId = randomUUID();
const userIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

/** Creates a user and a membership with the given job_title; resolves after both inserts. */
const insertMembership = async (jobTitle: string | null): Promise<void> => {
  const userId = randomUUID();
  userIds.push(userId);
  await getOwner().knex('auth.user').insert({ id: userId, name: 'Cargo Pessoa', email: `cargo.${userId.slice(0, 8)}@db-integration.test`, emailVerified: false });
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: productionRoleId, job_title: jobTitle, status: 'active' });
};

const normalize = async (value: string | null): Promise<string | null> => {
  const result = await getOwner().knex.raw<{ rows: Array<{ value: string | null }> }>(
    'select app_private.normalize_job_title(?::text) as value',
    [value]
  );
  return result.rows[0]?.value ?? null;
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
  it('accepts null, a valid title, and the 256-character boundary', async () => {
    await expect(insertMembership(null)).resolves.toBeUndefined();
    await expect(insertMembership('Editor de Vídeo')).resolves.toBeUndefined();
    await expect(insertMembership('a'.repeat(256))).resolves.toBeUndefined();
  });

  it('rejects a title that is only a tab', async () => {
    await expect(insertMembership('\t')).rejects.toThrow(/agency_memberships_job_title_format/);
  });

  it('rejects a title that is only a NBSP', async () => {
    await expect(insertMembership(NBSP)).rejects.toThrow(/agency_memberships_job_title_format/);
  });

  it('rejects a 257-character title', async () => {
    await expect(insertMembership('a'.repeat(257))).rejects.toThrow(/agency_memberships_job_title_format/);
  });

  it('normalizes a legacy value without losing the valid title', async () => {
    await expect(normalize(`  Editor \t de ${NBSP} Vídeo  `)).resolves.toBe('Editor de Vídeo');
    // A value already in the canonical form is untouched.
    await expect(normalize('Editor de Vídeo')).resolves.toBe('Editor de Vídeo');
    // A 256-character valid title is not truncated.
    await expect(normalize('a'.repeat(256))).resolves.toBe('a'.repeat(256));
    // Whitespace-only and null both become null, which is what the migration writes for them.
    await expect(normalize(`\t ${NBSP}\n`)).resolves.toBeNull();
    await expect(normalize(null)).resolves.toBeNull();
  });

  it('stores the canonical form after the normalization UPDATE the migration runs', async () => {
    await insertMembership(`  Editor \t de ${NBSP} Vídeo  `);
    await getOwner().knex('agency_memberships')
      .where({ agency_id: agencyId, job_title: `  Editor \t de ${NBSP} Vídeo  ` })
      .update({ job_title: getOwner().knex.raw('app_private.normalize_job_title(job_title)') });

    const stored = await getOwner().knex('agency_memberships')
      .where({ agency_id: agencyId, job_title: 'Editor de Vídeo' })
      .first('job_title');
    expect(stored?.job_title).toBe('Editor de Vídeo');
  });
});
