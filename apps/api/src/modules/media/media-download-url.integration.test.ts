import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import type { MediaStorageClient } from './storage-client.js';

// Issue #593: the agency's read URL. A HEAD is not a way to ask for a URL (Fastify would run this handler for it), and a URL is
// audited only once it is signed, so a refused signature leaves no event for a URL nobody received. The storage is wrapped to count
// the signatures and to refuse them on demand. The audit is counted in the database, the way the rest of the suite reads it.
const origin = { origin: TEST_APP_PUBLIC_URL };

const agencyId = randomUUID();
const clientId = randomUUID();
const assetId = randomUUID();

let owner: DatabaseClient;
let app: TestApp;
let cookie: string;
let user: TestUserFixture;
const signing = { calls: 0, refuse: false };

const download = (method: 'GET' | 'HEAD', variant: string): Promise<{ statusCode: number; body: string }> => app.app.inject({
  method,
  url: `/agencies/${agencyId}/media/${assetId}/download-url?variant=${variant}`,
  headers: { ...origin, cookie }
}) as unknown as Promise<{ statusCode: number; body: string }>;

const issuedCount = async (): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action: 'media.download_url_issued', target_id: assetId }).count<{ count: string }[]>('id as count'))[0]?.count);

/** Counts each signature and, while `refuse` is set, makes the bucket refuse it the way a failing signer does. */
const countingStorage = (storage: MediaStorageClient): MediaStorageClient => ({
  ...storage,
  presignGetObject: async (input) => {
    signing.calls += 1;
    if (signing.refuse) throw new Error('The signer refused the request.');
    return storage.presignGetObject(input);
  }
});

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp({ wrapMediaStorage: countingStorage });

  user = await insertTestUser(app.pool, app.auth, { emailLabel: 'download-url-owner', name: 'Dona' });
  await owner.knex('agencies').insert({ id: agencyId, name: `Download URL ${agencyId}`, owner_user_id: user.id });
  await owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Cliente ${clientId}` });
  const folder = await owner.knex('media_folders').where({ client_id: clientId, name: 'Imagens', is_default: true }).first('id');
  await owner.knex('media_assets').insert({
    id: assetId,
    agency_id: agencyId,
    client_id: clientId,
    folder_id: folder.id,
    category: 'image',
    declared_content_type: 'image/png',
    extension: 'png',
    object_key: `${agencyId}/${assetId}/original.png`,
    upload_object_key: `staging/${agencyId}/${assetId}/upload.png`,
    declared_size_bytes: 1_000,
    created_by_user_id: user.id,
    status: 'confirmed',
    confirmed_size_bytes: 1_000,
    confirmed_content_type: 'image/png',
    confirmed_at: new Date()
  });

  const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(login.statusCode).toBe(200);
  cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
}, 60_000);

afterAll(async () => {
  await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
  await owner.knex('media_assets').where({ agency_id: agencyId }).delete();
  await owner.knex('agency_storage_quotas').where({ agency_id: agencyId }).delete();
  await owner.knex('media_folders').where({ client_id: clientId }).delete();
  await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await owner.knex('clients').where({ id: clientId }).delete();
  await owner.knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await owner.knex('agencies').where({ id: agencyId }).delete();
  await owner.knex('auth.user').where({ id: user.id }).delete();
  await app.close();
  await owner.close();
});

describe('a HEAD on the agency read URL (issue #593)', () => {
  it('is not answered by the handler: no signature and no audit, whatever the variant', async () => {
    const before = signing.calls;
    for (const variant of ['original', 'thumbnail', 'preview']) {
      const reply = await download('HEAD', variant);
      expect([404, 405]).toContain(reply.statusCode);
      expect(reply.body).not.toMatch(/https?:\/\//);
    }
    expect(signing.calls).toBe(before);
    expect(await issuedCount()).toBe(0);
  });

  it('is the same for a GET of the original, which does sign and audit (the control of the test above)', async () => {
    const before = signing.calls;
    const reply = await download('GET', 'original');
    expect(reply.statusCode).toBe(200);
    expect(signing.calls).toBe(before + 1);
    expect(await issuedCount()).toBe(1);
  });
});

describe('a refused signature on the agency read URL (issue #593)', () => {
  it('leaves no download event when the signer refuses, and records one only for the URL that was handed over', async () => {
    const issuedBefore = await issuedCount();
    signing.refuse = true;
    try {
      const refused = await download('GET', 'original');
      expect(refused.statusCode).toBeGreaterThanOrEqual(500);
      expect(await issuedCount()).toBe(issuedBefore);
    } finally {
      signing.refuse = false;
    }

    const granted = await download('GET', 'original');
    expect(granted.statusCode).toBe(200);
    expect(await issuedCount()).toBe(issuedBefore + 1);
  });
});
