import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #753: a test that proves the refusal of a suspended agency by the fixture is only as good as the fixture, and
// `agencySuspended` was inserted without a status, so it rested active and the refusal was never exercised.
const w = createContentWorld('content-world');
const { ids } = w;

const statusOf = async (agencyId: string): Promise<string | undefined> =>
  (await w.getOwner().knex('agencies').where({ id: agencyId }).first('status'))?.status as string | undefined;

beforeAll(async () => {
  await w.setup();
});

afterAll(async () => {
  await w.teardown();
});

describe('the status the content world gives its agencies (issue #753)', () => {
  it('rests the suspended agency as suspended and the other two as active', async () => {
    expect(await statusOf(ids.agencySuspended)).toBe('suspended');
    expect(await statusOf(ids.agencyA)).toBe('active');
    expect(await statusOf(ids.agencyB)).toBe('active');
  });

  it('gives the suspended agency its client, its admin and its portal link, all active, so only the agency is what refuses', async () => {
    const knex = w.getOwner().knex;

    expect(await knex('clients').where({ id: ids.clientSuspended }).first('status', 'agency_id')).toEqual({ status: 'active', agency_id: ids.agencySuspended });
    expect(await knex('agency_memberships').where({ agency_id: ids.agencySuspended, user_id: ids.adminSuspended }).first('status')).toEqual({ status: 'active' });
    expect(await knex('client_memberships').where({ client_id: ids.clientSuspended, user_id: ids.portalSuspended }).first('status')).toEqual({ status: 'active' });
  });

  it('activates the suspended agency for the work given and suspends it again afterwards', async () => {
    const seen = await w.withSuspendedAgencyActive(async () => statusOf(ids.agencySuspended));

    expect(seen).toBe('active');
    expect(await statusOf(ids.agencySuspended)).toBe('suspended');
  });

  it('suspends it again when the work throws, and passes the error on', async () => {
    await expect(w.withSuspendedAgencyActive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    expect(await statusOf(ids.agencySuspended)).toBe('suspended');
  });
});
