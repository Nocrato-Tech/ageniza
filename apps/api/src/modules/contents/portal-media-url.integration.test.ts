import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import type { MediaStorageClient } from '../media/storage-client.js';
import { createPortalFixtures, type PortalPerson } from './test-support/portal-fixtures.js';
import { createContentsWorld } from './test-support/world.js';

// Issue #593, on the portal's read URL (#584): a HEAD is not a way to ask for a URL, and the original is audited only once it is
// signed. The person is one the policy lets read the file, so a refused signature is the only reason the URL is not handed over.
const signing = { calls: 0, refuse: false };
const countingStorage = (storage: MediaStorageClient): MediaStorageClient => ({
  ...storage,
  presignGetObject: async (input) => {
    signing.calls += 1;
    if (signing.refuse) throw new Error('The signer refused the request.');
    return storage.presignGetObject(input);
  }
});

const w = createContentsWorld('portalurl');
const p = createPortalFixtures(w);
const PERSON: PortalPerson = 'portalOne';

let clientId: string;
let contentId: string;
let assetId: string;

const url = (variant: string): string => `/clients/${clientId}/contents/${contentId}/media/${assetId}/url?variant=${variant}`;
const request = (method: 'GET' | 'HEAD', variant: string): Promise<{ statusCode: number; body: string }> => w.getApp().app.inject({
  method,
  url: url(variant),
  headers: { origin: TEST_APP_PUBLIC_URL, cookie: p.people[PERSON].cookie }
});

const issuedCount = async (): Promise<number> =>
  Number((await w.getOwner().knex('audit.events').where({ action: 'media.download_url_issued', target_id: assetId }).count<Array<{ count: string }>>('id as count'))[0]?.count ?? 0);

beforeAll(async () => {
  await w.setup({ wrapMediaStorage: countingStorage });
  await p.setup();
  clientId = await w.newClient('portal-url');
  await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people[PERSON].id });
  const folderId = await w.folderOf(clientId);
  assetId = await w.seedAsset(clientId, folderId, { category: 'image' });
  contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'carousel', folderId });
  await w.attach(contentId, [assetId]);
}, 120_000);

afterAll(async () => {
  await w.getOwner().knex('audit.events').whereIn('agency_id', [w.agencyA, w.agencyB]).delete();
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('a HEAD on the portal read URL (issue #593)', () => {
  it('is not answered by the handler: no signature and no audit, whatever the variant', async () => {
    const before = signing.calls;
    for (const variant of ['original', 'thumbnail']) {
      const reply = await request('HEAD', variant);
      expect([404, 405]).toContain(reply.statusCode);
      expect(reply.body).not.toMatch(/https?:\/\//);
    }
    expect(signing.calls).toBe(before);
    expect(await issuedCount()).toBe(0);
  });

  it('is the same for a GET of the original, which does sign and audit (the control of the test above)', async () => {
    const before = signing.calls;
    const reply = await request('GET', 'original');
    expect(reply.statusCode).toBe(200);
    expect(signing.calls).toBe(before + 1);
    expect(await issuedCount()).toBe(1);
  });
});

describe('a refused signature on the portal read URL (issue #593)', () => {
  it('leaves no download event when the signer refuses, and records one only for the URL that was handed over', async () => {
    const issuedBefore = await issuedCount();
    signing.refuse = true;
    try {
      const refused = await request('GET', 'original');
      expect(refused.statusCode).toBeGreaterThanOrEqual(500);
      expect(await issuedCount()).toBe(issuedBefore);
    } finally {
      signing.refuse = false;
    }

    const granted = await request('GET', 'original');
    expect(granted.statusCode).toBe(200);
    expect(await issuedCount()).toBe(issuedBefore + 1);
  });
});
