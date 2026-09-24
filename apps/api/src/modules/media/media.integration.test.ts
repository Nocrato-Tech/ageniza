import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  captureLogs,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  TEST_STORAGE_CONFIG,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #21 acceptance tests. Runs against the real local LocalStack started by
// `pnpm storage:start` -- see apps/api/src/modules/media/README.md.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const openApps: TestApp[] = [];

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (app: TestApp, user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (app: TestApp, emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUserIds.push(user.id);
  return user;
};

const createAgency = async (name: string, ownerUserId: string): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId });
  return id;
};

/** Uploads a body to a presigned URL exactly the way the browser would, and returns the ETag the
 * (Mini)S3 backend assigned -- multipart completion needs this per part. */
const putToPresignedUrl = async (url: string, body: Uint8Array, contentType?: string): Promise<string> => {
  const response = await fetch(url, {
    method: 'PUT',
    body,
    ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } })
  });
  expect(response.ok).toBe(true);
  const eTag = response.headers.get('etag');
  if (eTag === null) throw new Error('Upload response did not include an ETag header.');
  return eTag;
};

const smallPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe('media upload HTTP module (issue #21)', () => {
  beforeAll(async () => {
    owner = ownerClient();
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    // Issue #24: the multipart video test leaves a real queued job behind for the worker; delete
    // it by the asset ids that belonged to this test's own agencies.
    const assetIds = await owner.knex('media_assets').whereIn('agency_id', agencyIds).pluck('id');
    if (assetIds.length > 0) {
      await owner.knex.raw(
        "delete from pgboss.job where name = 'media.process-video' and data->>'assetId' = any(?::text[])",
        [assetIds]
      );
    }
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('media_assets').whereIn('agency_id', agencyIds).delete();
    await owner.knex('agency_storage_quotas').whereIn('agency_id', agencyIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await owner.knex('auth.user').whereIn('id', [...new Set(createdUserIds)]).delete();
    await Promise.all(openApps.splice(0).map((app) => app.close()));
    await owner.close();
  });

  it('never lets agency A obtain a signed URL for agency B\'s asset, in either direction (critério de aceite)', async () => {
    const app = await buildTestApp();
    openApps.push(app);
    const ownerA = await makeUser(app, 'media-isolation-a');
    const ownerB = await makeUser(app, 'media-isolation-b');
    const agencyA = await createAgency('Media Isolation Agency A', ownerA.id);
    const agencyB = await createAgency('Media Isolation Agency B', ownerB.id);
    const cookieA = await loginCookie(app, ownerA);
    const cookieB = await loginCookie(app, ownerB);

    // B cannot even ask for an upload URL scoped to A's agency: requireAgencyAccess rejects a
    // non-member before the media module's own logic runs.
    const crossAgencyCreate = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyA}/media/uploads`,
      headers: { ...origin, cookie: cookieB },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    expect(crossAgencyCreate.statusCode).toBe(404);

    // A creates a real asset under its own agency.
    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyA}/media/uploads`,
      headers: { ...origin, cookie: cookieA },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    expect(created.statusCode).toBe(201);
    const assetId = created.json().assetId as string;

    // B, scoped to its own agency in the URL, never resolves A's asset id -- not a 403 that would
    // confirm the asset exists, but the same 404 as a nonexistent one.
    const partsProbe = await app.app.inject({
      method: 'POST', url: `/agencies/${agencyB}/media/uploads/${assetId}/parts`, headers: { ...origin, cookie: cookieB }, payload: { partNumbers: [1] }
    });
    expect(partsProbe.statusCode).toBe(404);
    const completeProbe = await app.app.inject({
      method: 'POST', url: `/agencies/${agencyB}/media/uploads/${assetId}/complete`, headers: { ...origin, cookie: cookieB }, payload: {}
    });
    expect(completeProbe.statusCode).toBe(404);
    const downloadProbe = await app.app.inject({
      method: 'GET', url: `/agencies/${agencyB}/media/${assetId}/download-url`, headers: { ...origin, cookie: cookieB }
    });
    expect(downloadProbe.statusCode).toBe(404);

    // B, scoped to A's agency (the correct owner), is still rejected by requireAgencyAccess before
    // ever reaching the asset lookup.
    const crossAgencyDownload = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyA}/media/${assetId}/download-url`,
      headers: { ...origin, cookie: cookieB }
    });
    expect(crossAgencyDownload.statusCode).toBe(404);
  });

  it('completes a full single-part upload: presign, browser PUT, HeadObject-confirmed size and type', async () => {
    const app = await buildTestApp();
    openApps.push(app);
    const admin = await makeUser(app, 'media-single');
    const agencyId = await createAgency('Media Single Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.upload.type).toBe('single');
    expect(body.objectKey).toBe(`${agencyId}/${body.assetId}/original.png`);
    await expect(owner.knex('media_assets').where({ id: body.assetId }).first('upload_object_key'))
      .resolves.toEqual({ upload_object_key: `staging/${agencyId}/${body.assetId}/upload.png` });

    await putToPresignedUrl(body.upload.url, smallPng, 'image/png');

    const completed = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: {}
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ assetId: body.assetId, status: 'confirmed', sizeBytes: smallPng.length, contentType: 'image/png' });

    // The original presigned URL may remain cryptographically valid until expiry, but it points
    // only at a staging key. Reusing it after confirmation cannot mutate the canonical object.
    await putToPresignedUrl(body.upload.url, new Uint8Array([99, 98, 97]), 'image/png');

    const downloadUrl = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyId}/media/${body.assetId}/download-url`,
      headers: { ...origin, cookie }
    });
    expect(downloadUrl.statusCode).toBe(200);
    const getResponse = await fetch(downloadUrl.json().url as string);
    expect(getResponse.ok).toBe(true);
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(smallPng);
  });

  it('completes a multipart upload across two parts and resumes a dropped part URL', async () => {
    let failFirstDispatch = true;
    const app = await buildTestApp({
      config: { storage: { ...TEST_STORAGE_CONFIG, multipartThresholdBytes: 10, multipartPartBytes: 5 * 1024 * 1024 } },
      wrapMediaJobs: (jobs) => ({
        start: () => jobs.start(),
        stop: () => jobs.stop(),
        async enqueueVideoProcessing(transaction, payload) {
          if (failFirstDispatch) {
            failFirstDispatch = false;
            throw new Error('simulated queue outage');
          }
          await jobs.enqueueVideoProcessing(transaction, payload);
        }
      })
    });
    openApps.push(app);
    const admin = await makeUser(app, 'media-multipart');
    const agencyId = await createAgency('Media Multipart Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const partOne = new Uint8Array(5 * 1024 * 1024).fill(7);
    const partTwo = new Uint8Array(1024).fill(9);
    const totalSize = partOne.length + partTwo.length;

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'clip.mp4', contentType: 'video/mp4', declaredSizeBytes: totalSize }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.upload.type).toBe('multipart');
    expect(body.upload.partCount).toBe(2);

    const partsResponse = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/parts`,
      headers: { ...origin, cookie },
      payload: { partNumbers: [1, 2] }
    });
    expect(partsResponse.statusCode).toBe(200);
    const { parts } = partsResponse.json() as { parts: readonly { partNumber: number; url: string }[] };

    // Simulates a dropped connection on part 2: the client re-requests just that part's URL.
    const resumeResponse = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/parts`,
      headers: { ...origin, cookie },
      payload: { partNumbers: [2] }
    });
    expect(resumeResponse.statusCode).toBe(200);
    const resumedPartTwoUrl = (resumeResponse.json() as { parts: readonly { partNumber: number; url: string }[] }).parts[0]!.url;

    const eTagOne = await putToPresignedUrl(parts.find((part) => part.partNumber === 1)!.url, partOne);
    const eTagTwo = await putToPresignedUrl(resumedPartTwoUrl, partTwo);

    const firstCompletion = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: { parts: [{ partNumber: 1, eTag: eTagOne }, { partNumber: 2, eTag: eTagTwo }] }
    });
    expect(firstCompletion.statusCode).toBe(500);
    // The job insert and media confirmation share a transaction. A dispatch failure leaves the
    // row pending, while the retry tolerates that R2 already finalized the multipart upload.
    await expect(owner.knex('media_assets').where({ id: body.assetId }).first('status', 'video_processing_status')).resolves.toMatchObject({
      status: 'pending',
      video_processing_status: 'not_applicable'
    });

    const completed = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: { parts: [{ partNumber: 1, eTag: eTagOne }, { partNumber: 2, eTag: eTagTwo }] }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'confirmed', sizeBytes: totalSize, contentType: 'video/mp4' });

    // Issue #24: confirming a video queues the worker's thumbnail/preview job by moving
    // `video_processing_status` from 'not_applicable' to 'pending' in the same transaction --
    // before the worker has done anything, neither variant is servable yet.
    const statusRow = await owner.knex('media_assets').where({ id: body.assetId }).first('video_processing_status');
    expect(statusRow.video_processing_status).toBe('pending');
    const thumbnailProbe = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyId}/media/${body.assetId}/download-url?variant=thumbnail`,
      headers: { ...origin, cookie }
    });
    expect(thumbnailProbe.statusCode).toBe(409);
    expect(thumbnailProbe.json().error.code).toBe('VARIANT_NOT_READY');

    // The worker's job was actually queued, not just the row's status flipped.
    const jobRows = await owner.knex.raw(
      "select data from pgboss.job where name = 'media.process-video' and data->>'assetId' = ?",
      [body.assetId]
    );
    expect(jobRows.rows).toHaveLength(1);
    expect(jobRows.rows[0].data).toMatchObject({ assetId: body.assetId, agencyId });

    await owner.knex('media_assets').where({ id: body.assetId }).update({
      video_processing_status: 'failed',
      video_processing_error: 'duration_exceeds_limit'
    });
    const failedVariant = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyId}/media/${body.assetId}/download-url?variant=preview`,
      headers: { ...origin, cookie }
    });
    expect(failedVariant.statusCode).toBe(409);
    expect(failedVariant.json()).toMatchObject({
      error: { code: 'VARIANT_PROCESSING_FAILED', details: { reason: 'duration_exceeds_limit' } }
    });
  });

  it('rejects and deletes the object when the confirmed content type does not match the declared category', async () => {
    const app = await buildTestApp();
    openApps.push(app);
    const admin = await makeUser(app, 'media-type-mismatch');
    const agencyId = await createAgency('Media Type Mismatch Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    const body = created.json();
    // The browser is free to send any bytes/content-type to the presigned URL; nothing here
    // trusts the client, which is exactly why the server-side HeadObject re-check exists.
    await putToPresignedUrl(body.upload.url, new TextEncoder().encode('not actually a png'), 'text/plain');

    const completed = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: {}
    });
    expect(completed.statusCode).toBe(422);
    expect(completed.json()).toMatchObject({ error: { details: { reason: 'content_type_mismatch' } } });

    expect(await app.media!.storage.headObject({ key: body.objectKey })).toBeUndefined();
    await expect(owner.knex('media_assets').where({ id: body.assetId }).first('status')).resolves.toMatchObject({ status: 'rejected' });
  });

  it('rejects and deletes the object when it exceeds the category size limit', async () => {
    const app = await buildTestApp({ config: { storage: { ...TEST_STORAGE_CONFIG, maxImageBytes: 5 } } });
    openApps.push(app);
    const admin = await makeUser(app, 'media-too-large');
    const agencyId = await createAgency('Media Too Large Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      // Declared size is within the (tiny) limit; the real body sent to the presigned URL is not.
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: 5 }
    });
    const body = created.json();
    await putToPresignedUrl(body.upload.url, smallPng, 'image/png');

    const completed = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: {}
    });
    expect(completed.statusCode).toBe(422);
    expect(completed.json()).toMatchObject({ error: { details: { reason: 'too_large' } } });
    expect(await app.media!.storage.headObject({ key: body.objectKey })).toBeUndefined();
  });

  it('serializes concurrent confirmations so only one asset can consume the final quota slot', async () => {
    const app = await buildTestApp({ config: { storage: { ...TEST_STORAGE_CONFIG, quotaDefaultObjectCount: 2 } } });
    openApps.push(app);
    const admin = await makeUser(app, 'media-quota-race');
    const agencyId = await createAgency('Media Quota Race Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const createUpload = async () => {
      const response = await app.app.inject({
        method: 'POST', url: `/agencies/${agencyId}/media/uploads`, headers: { ...origin, cookie },
        payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      await putToPresignedUrl(body.upload.url, smallPng, 'image/png');
      return body;
    };
    const first = await createUpload();
    const second = await createUpload();
    await owner.knex('agency_storage_quotas').insert({
      agency_id: agencyId,
      quota_bytes: smallPng.length * 2,
      quota_object_count: 1
    });
    await owner.knex('media_assets').whereIn('id', [first.assetId, second.assetId]).update({
      updated_at: new Date(Date.now() - (TEST_STORAGE_CONFIG.uploadUrlExpirySeconds + 60) * 1_000)
    });

    const complete = (assetId: string) => app.app.inject({
      method: 'POST', url: `/agencies/${agencyId}/media/uploads/${assetId}/complete`, headers: { ...origin, cookie }, payload: {}
    });
    const responses = await Promise.all([complete(first.assetId as string), complete(second.assetId as string)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
    await expect(owner.knex('media_assets').where({ agency_id: agencyId, status: 'confirmed' }).count<{ count: string }[]>('* as count'))
      .resolves.toEqual([{ count: '1' }]);
  });

  it('rejects at creation once the declared size would exceed the tenant quota, and re-checks the real size at confirmation', async () => {
    const app = await buildTestApp({ config: { storage: { ...TEST_STORAGE_CONFIG, quotaDefaultBytes: smallPng.length, quotaDefaultObjectCount: 5 } } });
    openApps.push(app);
    const admin = await makeUser(app, 'media-quota');
    const agencyId = await createAgency('Media Quota Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    // Declaring more than the whole quota is rejected before any URL is issued.
    const overQuota = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length + 1 }
    });
    expect(overQuota.statusCode).toBe(409);
    expect(overQuota.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });

    // A second asset is created while it still fits, but an operator then lowers the tenant's
    // quota override before confirmation -- proving the confirm step re-checks quota for real
    // rather than trusting the decision made at creation time.
    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    const reservedQuota = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'second.png', contentType: 'image/png', declaredSizeBytes: 1 }
    });
    expect(reservedQuota.statusCode).toBe(409);
    await putToPresignedUrl(body.upload.url, smallPng, 'image/png');
    await owner.knex('agency_storage_quotas').insert({ agency_id: agencyId, quota_bytes: 1, quota_object_count: 5 });

    const completed = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads/${body.assetId}/complete`,
      headers: { ...origin, cookie },
      payload: {}
    });
    expect(completed.statusCode).toBe(422);
    expect(completed.json()).toMatchObject({ error: { details: { reason: 'quota_exceeded' } } });
    expect(await app.media!.storage.headObject({ key: body.objectKey })).toBeUndefined();
  });

  it('never logs a presigned URL, its query-string signature, or storage credentials', async () => {
    const { logger, text } = captureLogs();
    const app = await buildTestApp({ logger });
    openApps.push(app);
    const admin = await makeUser(app, 'media-log-safety');
    const agencyId = await createAgency('Media Log Safety Agency', admin.id);
    const cookie = await loginCookie(app, admin);

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/media/uploads`,
      headers: { ...origin, cookie },
      payload: { fileName: 'photo.png', contentType: 'image/png', declaredSizeBytes: smallPng.length }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();

    const downloadUrl = await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/media/${body.assetId}/download-url`, headers: { ...origin, cookie } });
    // The asset is not confirmed yet, so this 404 is expected; the point is only that neither
    // response ever put a signature or the storage secret key into the log stream.
    expect(downloadUrl.statusCode).toBe(404);

    const logText = text();
    expect(logText).not.toContain(TEST_STORAGE_CONFIG.secretAccessKey);
    expect(logText).not.toContain('X-Amz-Signature');
    expect(logText).not.toContain(body.upload.url as string);
  });
});
