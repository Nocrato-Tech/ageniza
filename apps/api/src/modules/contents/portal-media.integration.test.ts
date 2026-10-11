import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createPortalFixtures, DUAL_PEOPLE, type PortalPerson } from './test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Issue #584: the signed address of a media of a content, for the person of the portal. Every scenario that proves isolation uses
// a person the policy WOULD let read the file (a collaborator with a link, a person with a link to two clients), so a missing
// check shows up as a signed address instead of being hidden by row-level security. What is signed is read from the key in the
// address, and what must not be signed is checked by the audit it must not leave.
const w = createContentsWorld('portalmedia');
const p = createPortalFixtures(w);

const AUDIT = 'media.download_url_issued';
const LINKED: readonly PortalPerson[] = ['portalOne', ...DUAL_PEOPLE];

const mediaUrl = (clientId: string, contentId: string, assetId: string, query = ''): string =>
  `/clients/${clientId}/contents/${contentId}/media/${assetId}/url${query}`;

const get = (person: PortalPerson, url: string): Promise<Reply> => w.call('GET', p.people[person].cookie, url);
const errorOf = (reply: Reply): { code?: string; message?: string; details?: unknown } => reply.json().error ?? {};

const signedKey = (url: string): string => decodeURIComponent(new URL(url).pathname).replace(/^\/[^/]+\//, '');

const issued = async (assetId: string): Promise<number> =>
  Number((await w.getOwner().knex('audit.events').where({ action: AUDIT, target_id: assetId }).count<Array<{ count: string }>>('id as count'))[0]?.count ?? 0);

const freshClient = async (label: string, members: readonly PortalPerson[] = ['portalOne']): Promise<string> => {
  const clientId = await w.newClient(label);
  for (const member of members) await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people[member].id });
  return clientId;
};

interface Post {
  readonly clientId: string;
  readonly contentId: string;
  readonly image: string;
  readonly video: string;
  readonly cover: string;
}

/** A content with a cover and two items of media (an image and a video, its thumbnail ready), on a client the given people read. */
const seedPost = async (
  label: string,
  status: 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled' = 'awaiting_approval',
  members: readonly PortalPerson[] = LINKED
): Promise<Post> => {
  const clientId = await freshClient(label, members);
  const folderId = await w.folderOf(clientId);
  const cover = await w.seedAsset(clientId, folderId, { category: 'image' });
  const image = await w.seedAsset(clientId, folderId, { category: 'image' });
  const video = await w.seedAsset(clientId, folderId, { category: 'video', video: 'ready' });
  const contentId = await w.seedContent(clientId, { status, format: 'carousel', folderId, coverAssetId: cover });
  await w.attach(contentId, [image, video]);
  return { clientId, contentId, image, video, cover };
};

const expectNotFound = (reply: Reply, message: string): void => {
  expect(reply.statusCode).toBe(404);
  expect(errorOf(reply).code).toBe('NOT_FOUND');
  expect(errorOf(reply).message).toBe(message);
};

beforeAll(async () => {
  await w.setup();
  await p.setup();
}, 120_000);

afterAll(async () => {
  await w.getOwner().knex('audit.events').whereIn('agency_id', [w.agencyA, w.agencyB]).delete();
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('who may ask for the signed address of a media in the portal', () => {
  it('refuses a request without a session before anything is read or audited', async () => {
    const post = await seedPost('no-session');
    const reply = await w.getApp().app.inject({ method: 'GET', url: mediaUrl(post.clientId, post.contentId, post.image), headers: { origin: TEST_APP_PUBLIC_URL } });
    expect(reply.statusCode).toBe(401);
    expect(await issued(post.image)).toBe(0);
  });

  const strangers: ReadonlyArray<[string, () => string]> = [
    ['a person of another client of the same agency', () => p.people.portalOther.cookie],
    ['a person of a client of another agency', () => p.people.portalB.cookie],
    ['a person whose link was removed', () => p.people.removed.cookie],
    ['an Admin of the agency without a link', () => w.people.admin.cookie],
    ['the Owner of the agency without a link', () => w.people.owner.cookie],
    ['an Admin of another agency without a link', () => w.people.adminB.cookie]
  ];

  it.each(strangers)('answers 404 to %s, signs nothing and audits nothing', async (_label, cookieOf) => {
    const post = await seedPost('stranger');
    for (const variant of ['original', 'thumbnail']) {
      const reply = await w.call('GET', cookieOf(), mediaUrl(post.clientId, post.contentId, post.image, `?variant=${variant}`));
      expectNotFound(reply, 'Client not found.');
    }
    expect(await issued(post.image)).toBe(0);
  });

  it('answers 404 for an archived client, signs nothing and audits nothing', async () => {
    const clientId = await w.newClient('archived', { status: 'archived' });
    await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people.portalOne.id });
    const folderId = await w.folderOf(clientId);
    const image = await w.seedAsset(clientId, folderId, { category: 'image' });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', folderId, coverAssetId: image });

    const reply = await get('portalOne', mediaUrl(clientId, contentId, image));

    expect(reply.statusCode).toBe(404);
    expect(await issued(image)).toBe(0);
  });
});

describe('what is signed', () => {
  it.each(LINKED)('signs the original of the cover and of every item of the media for %s, and audits who asked', async (person) => {
    const post = await seedPost(`original-${person}`);
    for (const [assetId, extension] of [[post.cover, 'png'], [post.image, 'png'], [post.video, 'mp4']] as const) {
      const reply = await get(person, mediaUrl(post.clientId, post.contentId, assetId));

      expect(reply.statusCode, assetId).toBe(200);
      expect(signedKey(reply.json().url)).toBe(`${w.agencyA}/${assetId}/original.${extension}`);
      expect(Object.keys(reply.json()).sort()).toEqual(['expiresAt', 'url']);
      const rows = await w.getOwner().knex('audit.events').where({ action: AUDIT, target_id: assetId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_user_id: p.people[person].id, agency_id: w.agencyA, target_type: 'media_asset' });
    }
  });

  it('signs a short-lived GET and answers nothing of the person or of the agency beyond the address and its expiry', async () => {
    const post = await seedPost('expiry', 'awaiting_approval', ['portalOne']);
    const before = Date.now();

    const reply = await get('portalOne', mediaUrl(post.clientId, post.contentId, post.image));

    const address = new URL(reply.json().url);
    expect(address.searchParams.get('X-Amz-Expires')).toBe('300');
    const expiresAt = new Date(reply.json().expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 299_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 301_000);
    const serialized = JSON.stringify(reply.json());
    for (const id of p.allUserIds()) expect(serialized).not.toContain(id);
  });

  it.each(['awaiting_approval', 'adjusting', 'approved', 'published'] as const)('signs the media of a content that is %s', async (status) => {
    const post = await seedPost(`state-${status}`, status, ['portalOne']);
    const reply = await get('portalOne', mediaUrl(post.clientId, post.contentId, post.image));
    expect(reply.statusCode).toBe(200);
    expect(signedKey(reply.json().url)).toBe(`${w.agencyA}/${post.image}/original.png`);
  });

  it('asks for the original by default, so the default is audited like the explicit original', async () => {
    const post = await seedPost('default-variant', 'awaiting_approval', ['portalOne']);
    await get('portalOne', mediaUrl(post.clientId, post.contentId, post.image));
    expect(await issued(post.image)).toBe(1);
  });
});

describe('the thumbnail', () => {
  it('is the original for an image and leaves no audit, because it is what the screens render', async () => {
    const post = await seedPost('thumbnail-image', 'awaiting_approval', ['portalOne']);
    for (const assetId of [post.cover, post.image]) {
      const reply = await get('portalOne', mediaUrl(post.clientId, post.contentId, assetId, '?variant=thumbnail'));
      expect(reply.statusCode).toBe(200);
      expect(signedKey(reply.json().url)).toBe(`${w.agencyA}/${assetId}/original.png`);
      expect(await issued(assetId)).toBe(0);
    }
  });

  it('is the generated thumbnail for a processed video and leaves no audit', async () => {
    const post = await seedPost('thumbnail-video', 'awaiting_approval', ['portalOne']);
    const reply = await get('portalOne', mediaUrl(post.clientId, post.contentId, post.video, '?variant=thumbnail'));
    expect(reply.statusCode).toBe(200);
    expect(signedKey(reply.json().url)).toBe(`${w.agencyA}/${post.video}/thumbnail.jpg`);
    expect(await issued(post.video)).toBe(0);
  });

  it('answers its own code while the video is not processed, and another when processing failed, without the worker\'s reason', async () => {
    const clientId = await freshClient('thumbnail-state');
    const folderId = await w.folderOf(clientId);
    const pending = await w.seedAsset(clientId, folderId, { category: 'video', video: 'pending' });
    const failed = await w.seedAsset(clientId, folderId, { category: 'video', video: 'failed' });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'carousel', folderId });
    await w.attach(contentId, [pending, failed]);

    const notReady = await get('portalOne', mediaUrl(clientId, contentId, pending, '?variant=thumbnail'));
    const processingFailed = await get('portalOne', mediaUrl(clientId, contentId, failed, '?variant=thumbnail'));

    expect(notReady.statusCode).toBe(409);
    expect(errorOf(notReady).code).toBe('VARIANT_NOT_READY');
    expect(processingFailed.statusCode).toBe(409);
    expect(errorOf(processingFailed).code).toBe('VARIANT_PROCESSING_FAILED');
    expect(JSON.stringify(processingFailed.json())).not.toContain('processing_failed');
    expect(await issued(pending) + await issued(failed)).toBe(0);
  });

  it('still signs the original of a video whose thumbnail is not ready', async () => {
    const clientId = await freshClient('original-unprocessed');
    const folderId = await w.folderOf(clientId);
    const pending = await w.seedAsset(clientId, folderId, { category: 'video', video: 'pending' });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'reels', folderId });
    await w.attach(contentId, [pending]);

    const reply = await get('portalOne', mediaUrl(clientId, contentId, pending));

    expect(reply.statusCode).toBe(200);
    expect(signedKey(reply.json().url)).toBe(`${w.agencyA}/${pending}/original.mp4`);
  });
});

describe('what is never signed', () => {
  it.each(LINKED)('answers 404 for the media of a content in production, even to %s, whose role reads it', async (person) => {
    const post = await seedPost(`production-${person}`, 'in_production');
    for (const assetId of [post.cover, post.image, post.video]) {
      for (const variant of ['original', 'thumbnail']) {
        expectNotFound(await get(person, mediaUrl(post.clientId, post.contentId, assetId, `?variant=${variant}`)), 'Content not found.');
      }
      expect(await issued(assetId)).toBe(0);
    }
  });

  it.each(LINKED)('answers 404 for the media of a cancelled content, even to %s, whose role reads it', async (person) => {
    const post = await seedPost(`cancelled-${person}`, 'cancelled');
    for (const assetId of [post.cover, post.image, post.video]) {
      expectNotFound(await get(person, mediaUrl(post.clientId, post.contentId, assetId)), 'Content not found.');
      expect(await issued(assetId)).toBe(0);
    }
  });

  it('answers 404 for a content of another client the person also reads, through the address of the first', async () => {
    const first = await seedPost('multi-first', 'awaiting_approval', ['portalMulti']);
    const second = await seedPost('multi-second', 'awaiting_approval', ['portalMulti']);

    for (const assetId of [second.cover, second.image, second.video]) {
      expectNotFound(await get('portalMulti', mediaUrl(first.clientId, second.contentId, assetId)), 'Content not found.');
      expect(await issued(assetId)).toBe(0);
    }
    expect((await get('portalMulti', mediaUrl(second.clientId, second.contentId, second.image))).statusCode).toBe(200);
  });

  it('answers 404 for a file of another content of the same client, of another client and of another agency', async () => {
    const mine = await seedPost('isolation-mine', 'awaiting_approval', LINKED);
    const sibling = await seedPost('isolation-sibling', 'awaiting_approval', ['portalOne']);
    const foreign = await seedPost('isolation-foreign', 'awaiting_approval', ['portalB']);
    const otherAgency = await w.newClient('isolation-agency-b', { agencyId: w.agencyB });
    const otherFolder = await w.folderOf(otherAgency);
    const otherAgencyAsset = await w.seedAsset(otherAgency, otherFolder, { category: 'image' });

    for (const person of LINKED) {
      for (const assetId of [sibling.image, foreign.image, otherAgencyAsset]) {
        expectNotFound(await get(person, mediaUrl(mine.clientId, mine.contentId, assetId)), 'Media asset not found.');
      }
    }
    for (const assetId of [sibling.image, foreign.image, otherAgencyAsset]) expect(await issued(assetId)).toBe(0);
  });

  it('answers 404 for a file of the client that no content uses, one that was removed, one that never finished uploading and an unknown id', async () => {
    const clientId = await freshClient('files');
    const folderId = await w.folderOf(clientId);
    const unused = await w.seedAsset(clientId, folderId, { category: 'image' });
    const removed = await w.seedAsset(clientId, folderId, { category: 'image', removed: true });
    const pending = await w.seedAsset(clientId, folderId, { category: 'image', status: 'pending' });
    const contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'carousel', folderId });
    await w.attach(contentId, [removed, pending]);

    for (const assetId of [unused, removed, pending, randomUUID()]) {
      for (const variant of ['original', 'thumbnail']) {
        expectNotFound(await get('portalOne', mediaUrl(clientId, contentId, assetId, `?variant=${variant}`)), 'Media asset not found.');
      }
      expect(await issued(assetId)).toBe(0);
    }
  });

  it('answers 404 for an unknown content and for ids that are not UUIDs, never a 400', async () => {
    const post = await seedPost('malformed', 'awaiting_approval', ['portalOne']);

    expectNotFound(await get('portalOne', mediaUrl(post.clientId, randomUUID(), post.image)), 'Content not found.');
    expectNotFound(await get('portalOne', mediaUrl(post.clientId, 'not-a-uuid', post.image)), 'Content not found.');
    expectNotFound(await get('portalOne', mediaUrl(post.clientId, post.contentId, 'not-a-uuid')), 'Media asset not found.');
    expect(await issued(post.image)).toBe(0);
  });

  it('refuses a variant the portal is not offered and an unknown query, and signs nothing', async () => {
    const post = await seedPost('variants', 'awaiting_approval', ['portalOne']);

    for (const query of ['?variant=preview', '?variant=other', '?variant=', '?variant=original&variant=thumbnail', '?variant=original&download=1']) {
      const reply = await get('portalOne', mediaUrl(post.clientId, post.contentId, post.video, query));
      expect(reply.statusCode, query).toBe(400);
      expect(errorOf(reply).code, query).toBe('VALIDATION_ERROR');
    }
    expect(await issued(post.video)).toBe(0);
  });

  it('never selects from the table of the contents or of the media: the portal reads by the functions that answer for the link', async () => {
    const post = await seedPost('statements', 'awaiting_approval', ['portalOne']);
    w.statements.length = 0;

    await get('portalOne', mediaUrl(post.clientId, post.contentId, post.image));
    await get('portalOne', mediaUrl(post.clientId, post.contentId, post.video, '?variant=thumbnail'));

    expect(w.statements.length).toBeGreaterThan(0);
    expect(w.statements.some((statement) => /public\.(contents|media_assets|content_media)\b/.test(statement))).toBe(false);
  });
});
