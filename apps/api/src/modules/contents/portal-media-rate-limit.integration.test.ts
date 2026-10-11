import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPortalFixtures, type PortalPerson } from './test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Issue #558: the read URL has one bucket per person, and the agency's route and the portal's are the same bucket. The plugin makes a
// store for every route that declares a limit, so two copies of the same numbers would give a person of both sides 600 on each.
// The numbers are written out (600 per 5 minutes, decision 2026-10-11), never read from the policy the code reads.
const w = createContentsWorld('portalmedialimit');
const p = createPortalFixtures(w);

const LIMIT = 600;
const BATCH = 25;

let clientId: string;
let contentId: string;
let assetId: string;

const portalUrl = (): string => `/clients/${clientId}/contents/${contentId}/media/${assetId}/url?variant=thumbnail`;
const agencyUrl = (): string => `/agencies/${w.agencyA}/media/${assetId}/download-url?variant=thumbnail`;

const get = (person: PortalPerson, url: string): Promise<Reply> => w.call('GET', p.people[person].cookie, url);

const spend = async (person: PortalPerson, count: number, url: () => string): Promise<Record<number, number>> => {
  const counts: Record<number, number> = {};
  for (let sent = 0; sent < count; sent += BATCH) {
    const replies = await Promise.all(Array.from({ length: Math.min(BATCH, count - sent) }, () => get(person, url())));
    for (const reply of replies) counts[reply.statusCode] = (counts[reply.statusCode] ?? 0) + 1;
  }
  return counts;
};

beforeAll(async () => {
  await w.setup();
  await p.setup();
  clientId = await w.newClient('portal-limit');
  for (const person of ['portalOne', 'portalMulti', 'dualAdmin', 'dualRead'] as const) {
    await w.getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: p.people[person].id });
  }
  const folderId = await w.folderOf(clientId);
  assetId = await w.seedAsset(clientId, folderId, { category: 'image' });
  contentId = await w.seedContent(clientId, { status: 'awaiting_approval', format: 'image', folderId, coverAssetId: assetId });
}, 120_000);

afterAll(async () => {
  await w.getOwner().knex('audit.events').whereIn('agency_id', [w.agencyA, w.agencyB]).delete();
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('the portal route is limited per person (issue #558)', () => {
  it('answers 600 with the address and the 601st with 429 RATE_LIMITED and Retry-After, and never 500', async () => {
    expect(await spend('portalOne', LIMIT, portalUrl)).toEqual({ 200: LIMIT });

    const limited = await get('portalOne', portalUrl());

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(JSON.stringify(limited.json())).not.toMatch(/url|X-Amz/i);
    const retryAfter = Number((limited as unknown as { headers: Record<string, string> }).headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(300);
  }, 120_000);

  it('leaves another person of the same client, behind the same address, with a budget of their own', async () => {
    expect((await get('portalMulti', portalUrl())).statusCode).toBe(200);
  });

  it('counts nothing for a person the guard refuses: 610 requests of a person with no link to the client are all 404', async () => {
    expect(await spend('portalOther', LIMIT + 10, portalUrl)).toEqual({ 404: LIMIT + 10 });
  }, 120_000);
});

describe('one bucket for the agency\'s route and the portal\'s (issue #558)', () => {
  it('gives 429 in the portal to a person of both sides who spent the bucket in the agency', async () => {
    expect(await spend('dualAdmin', LIMIT, agencyUrl)).toEqual({ 200: LIMIT });

    const portal = await get('dualAdmin', portalUrl());
    const agency = await get('dualAdmin', agencyUrl());

    expect(portal.statusCode).toBe(429);
    expect(portal.json().error.code).toBe('RATE_LIMITED');
    expect(agency.statusCode).toBe(429);
  }, 120_000);

  it('gives 429 in the agency to a person of both sides who spent the bucket in the portal', async () => {
    expect(await spend('dualRead', LIMIT, portalUrl)).toEqual({ 200: LIMIT });

    const agency = await get('dualRead', agencyUrl());
    const portal = await get('dualRead', portalUrl());

    expect(agency.statusCode).toBe(429);
    expect(agency.json().error.code).toBe('RATE_LIMITED');
    expect(portal.statusCode).toBe(429);
  }, 120_000);
});
