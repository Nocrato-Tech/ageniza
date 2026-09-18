import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Database-only proof of the issue #21 acceptance criterion: "um usuário da Agência A NUNCA obtém
// URL de arquivo da Agência B" starts at this layer. The HTTP-level isolation test in
// apps/api/src/modules/media exercises the same guarantee through the actual routes.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const userA = randomUUID();
const userB = randomUUID();
const agencyA = randomUUID();
const agencyB = randomUUID();
const assetA = randomUUID();
const assetB = randomUUID();

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

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert([
      { id: userA, name: 'Media Agency A User', email: `media-tenant-a-${userA}@example.test`, emailVerified: true },
      { id: userB, name: 'Media Agency B User', email: `media-tenant-b-${userB}@example.test`, emailVerified: true }
    ]);
    // Ownership alone grants `midia.enviar` (app_private.has_agency_permission checks owner_user_id
    // directly), so this suite does not need to seed a membership/role as well.
    await transaction('agencies').insert([
      { id: agencyA, name: 'Media Agency A', owner_user_id: userA },
      { id: agencyB, name: 'Media Agency B', owner_user_id: userB }
    ]);
    await transaction('media_assets').insert([
      {
        id: assetA,
        agency_id: agencyA,
        category: 'image',
        declared_content_type: 'image/png',
        extension: 'png',
        object_key: `${agencyA}/${assetA}/original.png`,
        upload_object_key: `${agencyA}/${assetA}/upload.png`,
        declared_size_bytes: 1_024,
        created_by_user_id: userA
      },
      {
        id: assetB,
        agency_id: agencyB,
        category: 'image',
        declared_content_type: 'image/png',
        extension: 'png',
        object_key: `${agencyB}/${assetB}/original.png`,
        upload_object_key: `${agencyB}/${assetB}/upload.png`,
        declared_size_bytes: 2_048,
        created_by_user_id: userB
      }
    ]);
  });
});

afterAll(async () => {
  await getOwner().knex('media_assets').whereIn('agency_id', [agencyA, agencyB]).delete();
  await getOwner().knex('agency_storage_quotas').whereIn('agency_id', [agencyA, agencyB]).delete();
  await getOwner().knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
  await getOwner().knex('auth.user').whereIn('id', [userA, userB]).delete();
  await owner?.close();
  await application?.close();
});

describe('media storage RLS isolation (issue #21)', () => {
  it('never returns another agency\'s media asset', async () => {
    await expect(asUser(userA, (transaction) => transaction('media_assets').select('id'))).resolves.toEqual([{ id: assetA }]);
    await expect(asUser(userB, (transaction) => transaction('media_assets').select('id'))).resolves.toEqual([{ id: assetB }]);
    await expect(asUser(userA, (transaction) => transaction('media_assets').where({ id: assetB }).select('id'))).resolves.toEqual([]);
    await expect(asUser(userB, (transaction) => transaction('media_assets').where({ id: assetA }).select('id'))).resolves.toEqual([]);
  });

  it('refuses to insert a row into another agency\'s namespace', async () => {
    const foreignAssetId = randomUUID();
    await expect(asUser(userA, (transaction) => transaction('media_assets').insert({
      id: foreignAssetId,
      agency_id: agencyB,
      category: 'image',
      declared_content_type: 'image/png',
      extension: 'png',
      object_key: `${agencyB}/${foreignAssetId}/original.png`,
      upload_object_key: `${agencyB}/${foreignAssetId}/upload.png`,
      declared_size_bytes: 1_024,
      created_by_user_id: userA
    }))).rejects.toThrow(/row-level security/);
  });

  it('rejects an object key that does not match (agency_id, id, extension)', async () => {
    const mismatchedId = randomUUID();
    await expect(getOwner().knex('media_assets').insert({
      id: mismatchedId,
      agency_id: agencyA,
      category: 'image',
      declared_content_type: 'image/png',
      extension: 'png',
      object_key: `${agencyB}/${mismatchedId}/original.png`,
      upload_object_key: `${agencyB}/${mismatchedId}/upload.png`,
      declared_size_bytes: 1_024,
      created_by_user_id: userA
    })).rejects.toThrow(/media_assets_object_key_shape/);
  });

  it('keeps agency_storage_quotas scoped the same way and read-only for the app role', async () => {
    await getOwner().knex('agency_storage_quotas').insert([
      { agency_id: agencyA, quota_bytes: 1_000, quota_object_count: 10 },
      { agency_id: agencyB, quota_bytes: 2_000, quota_object_count: 20 }
    ]);
    await expect(asUser(userA, (transaction) => transaction('agency_storage_quotas').select('agency_id'))).resolves.toEqual([{ agency_id: agencyA }]);
    await expect(asUser(userB, (transaction) => transaction('agency_storage_quotas').select('agency_id'))).resolves.toEqual([{ agency_id: agencyB }]);
    // ageniza_app has no insert/update/delete grant on this table at all (see the migration);
    // Postgres reports that as either an RLS violation or a plain permission-denied error
    // depending on evaluation order, so this accepts either without weakening the assertion.
    await expect(asUser(userA, (transaction) => transaction('agency_storage_quotas').insert({ agency_id: agencyA, quota_bytes: 5 }))).rejects.toThrow(/permission denied|row-level security/);
  });
});
