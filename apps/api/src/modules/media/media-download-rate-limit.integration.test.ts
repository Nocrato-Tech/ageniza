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

// Issue #558: the read URL is limited per user, because the thumbnail of an image signs the original and is not audited.
// The numbers are written out here on purpose (600 per 5 minutes, decision 2026-10-11): a test that looped over the policy
// constant would follow a wrong constant. Every permission is held alone by a custom role, since the Owner passes every guard.
// The store of the limit lives in the app, so this file has its own and no other test file spends these users' budgets.
const origin = { origin: TEST_APP_PUBLIC_URL };

const LIMIT = 600;
const WINDOW_SECONDS = 300;
const BATCH = 25;

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};
const assetIds: string[] = [];
let imageA: string;
let videoPendingA: string;
let imageB: string;

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

interface Reply {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const read = async (agency: string, assetId: string, as?: string, variant = 'thumbnail'): Promise<Reply> =>
  (await app.app.inject({
    method: 'GET',
    url: `/agencies/${agency}/media/${assetId}/download-url?variant=${variant}`,
    headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) }
  })) as unknown as Reply;

/** `count` requests of one user, `BATCH` at a time, answered in the order they were asked. */
const readMany = async (count: number, agency: string, assetId: string, as?: string): Promise<Reply[]> => {
  const replies: Reply[] = [];
  for (let sent = 0; sent < count; sent += BATCH) {
    replies.push(...await Promise.all(Array.from({ length: Math.min(BATCH, count - sent) }, () => read(agency, assetId, as))));
  }
  return replies;
};

const tally = (replies: readonly Reply[]): Record<number, number> => {
  const counts: Record<number, number> = {};
  for (const reply of replies) counts[reply.statusCode] = (counts[reply.statusCode] ?? 0) + 1;
  return counts;
};

const seedAsset = async (agencyId: string, clientId: string, category: 'image' | 'video'): Promise<string> => {
  const id = randomUUID();
  const extension = category === 'image' ? 'png' : 'mp4';
  const contentType = category === 'image' ? 'image/png' : 'video/mp4';
  assetIds.push(id);
  const folder = await owner.knex('media_folders').where({ client_id: clientId, name: category === 'image' ? 'Imagens' : 'Vídeos', is_default: true }).first('id');
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyId,
    client_id: clientId,
    folder_id: folder.id,
    category,
    declared_content_type: contentType,
    extension,
    object_key: `${agencyId}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
    declared_size_bytes: 1_000,
    created_by_user_id: users.owner!.id,
    status: 'confirmed',
    confirmed_size_bytes: 1_000,
    confirmed_content_type: contentType,
    confirmed_at: new Date(),
    ...(category === 'video' ? { video_processing_status: 'pending' } : {})
  });
  return id;
};

const issuedCount = async (assetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action: 'media.download_url_issued', target_id: assetId }).count<{ count: string }[]>('id as count'))[0]?.count);

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  for (const key of ['owner', 'ownerB', 'heavy', 'colleague', 'normal', 'sales', 'fresh']) {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `download-limit-${key.toLowerCase()}`, name: key });
    userIds.push(user.id);
    users[key] = user;
  }

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Download limit A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Download limit B ${agencyB}`, owner_user_id: users.ownerB!.id }
  ]);
  await owner.knex('clients').insert([
    { id: clientA, agency_id: agencyA, name: `Cliente A ${clientA}` },
    { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` }
  ]);

  const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  const systemRole = async (key: string): Promise<string> => (await owner.knex('roles').whereNull('agency_id').where({ key }).first('id')).id as string;
  await owner.knex('agency_memberships').insert([
    // Reads Conteúdo in two agencies: its budget is one, whatever the agency of the request.
    { agency_id: agencyA, user_id: users.heavy!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyB, user_id: users.heavy!.id, role_id: await customRole(agencyB, 'conteudo.visualizar') },
    // The same agency, the same address (the inject IP is one for everybody), another person.
    { agency_id: agencyA, user_id: users.colleague!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.normal!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.fresh!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.sales!.id, role_id: await systemRole('sales') }
  ]);

  imageA = await seedAsset(agencyA, clientA, 'image');
  videoPendingA = await seedAsset(agencyA, clientA, 'video');
  imageB = await seedAsset(agencyB, clientB, 'image');

  for (const key of ['heavy', 'colleague', 'normal', 'sales', 'fresh']) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode).toBe(200);
    cookies[key] = cookieOf(response);
  }
}, 60_000);

afterAll(async () => {
  const agencies = [agencyA, agencyB];
  const clients = [clientA, clientB];
  await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
  await owner.knex('media_assets').whereIn('agency_id', agencies).delete();
  await owner.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
  await owner.knex('media_folders').whereIn('client_id', clients).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
  await owner.knex('clients').whereIn('id', clients).delete();
  await owner.knex('role_permissions').whereIn('role_id', roleIds).delete();
  await owner.knex('roles').whereIn('id', roleIds).delete();
  await owner.knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', agencies).delete();
  await owner.knex('auth.user').whereIn('id', userIds).delete();
  await app.close();
  await owner.close();
});

describe('after one user asked for 600 read URLs (issue #558)', () => {
  const startedAt = { ms: 0 };
  let granted: Reply[] = [];
  let limited: Reply;
  let limitedAt = 0;

  beforeAll(async () => {
    startedAt.ms = Date.now();
    granted = await readMany(LIMIT, agencyA, imageA, 'heavy');
    limited = await read(agencyA, imageA, 'heavy');
    limitedAt = Date.now();
  }, 120_000);

  it('answered each of the 600 with its URL and the 601st with 429 RATE_LIMITED', () => {
    expect(tally(granted)).toEqual({ 200: LIMIT });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(JSON.stringify(limited.json())).not.toMatch(/url|X-Amz/i);
  });

  it('says in Retry-After how long until the window of 5 minutes ends', () => {
    const retryAfter = Number(limited.headers['retry-after']);
    const elapsedSeconds = (limitedAt - startedAt.ms) / 1_000;

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
    expect(retryAfter).toBeGreaterThanOrEqual(WINDOW_SECONDS - Math.ceil(elapsedSeconds) - 1);
  });

  it('keeps answering 429, never 500 or 403, to every further request', async () => {
    const replies = await readMany(5, agencyA, imageA, 'heavy');

    expect(tally(replies)).toEqual({ 429: 5 });
    for (const reply of replies) expect(reply.json().error.code).toBe('RATE_LIMITED');
  });

  it('limits the original too, and a refused request audits and signs nothing', async () => {
    const before = await issuedCount(imageA);

    const response = await read(agencyA, imageA, 'heavy', 'original');

    expect(response.statusCode).toBe(429);
    expect(JSON.stringify(response.json())).not.toMatch(/url|X-Amz/i);
    expect(await issuedCount(imageA)).toBe(before);
  });

  it('spends the same budget in the other agency of that user', async () => {
    const response = await read(agencyB, imageB, 'heavy');

    expect(response.statusCode).toBe(429);
  });

  it('leaves a colleague of the same agency, behind the same address, with a budget of their own', async () => {
    const response = await read(agencyA, imageA, 'colleague');

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/^https?:\/\//);
  });

  it('leaves a person who never asked with the whole window', async () => {
    const replies = await readMany(10, agencyA, imageA, 'fresh');

    expect(tally(replies)).toEqual({ 200: 10 });
    expect(Math.min(...replies.map((reply) => Number(reply.headers['x-ratelimit-remaining'])))).toBe(LIMIT - 10);
  });
});

describe('the normal use of the screens (issue #558)', () => {
  it('never reaches the limit: two months of covers, three folder pages and two full carousels in one window', async () => {
    // Per-asset cache: a cover is asked once per window. 100 covers is a month of up to three posts a day.
    const covers = await readMany(200, agencyA, imageA, 'normal');
    // Three pages of 48 tiles, a quarter of them a video whose thumbnail is not ready (409, which also counts).
    const tiles: Reply[] = [];
    for (let page = 0; page < 3; page += 1) {
      tiles.push(...await Promise.all(Array.from({ length: 48 }, (_, index) => read(agencyA, index % 4 === 3 ? videoPendingA : imageA, 'normal'))));
    }
    const carousels = await readMany(40, agencyA, imageA, 'normal');

    expect(tally(covers)).toEqual({ 200: 200 });
    expect(tally(tiles)).toEqual({ 200: 108, 409: 36 });
    expect(tally(carousels)).toEqual({ 200: 40 });
    // The 384th request left 216 of the 600: the count is what the screens spent, not a smaller one.
    expect(Math.min(...carousels.map((reply) => Number(reply.headers['x-ratelimit-remaining'])))).toBe(LIMIT - 200 - 144 - 40);
  }, 120_000);
});

describe('a request that a guard refuses counts for nobody (issue #558)', () => {
  it('does not limit a role without permission: 403 on every one of 610', async () => {
    const replies = await readMany(LIMIT + 10, agencyA, imageA, 'sales');

    expect(tally(replies)).toEqual({ 403: LIMIT + 10 });
  }, 120_000);

  it('does not limit a request without a session: 401 on every one of 610', async () => {
    const replies = await readMany(LIMIT + 10, agencyA, imageA);

    expect(tally(replies)).toEqual({ 401: LIMIT + 10 });
  }, 120_000);
});
