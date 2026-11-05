import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// The counters of the feed of a client (posts, approved, awaiting approval) were a `count(*)` under the policy of `contents`,
// which calls `has_agency_permission` for every row: 2.5 to 3.8 s over 40 000 contents, against 21 ms without the policy. One
// person with `conteudo.visualizar`, inside the rate limit, could keep the pool of the API busy for the other agencies.
// `app_private.content_feed_counters` checks the permission once and counts. Every attack runs as `ageniza_app`; the number a
// person gets must be the one the policy gives, and a person the policy shows nothing gets no row at all.
const w = createContentWorld('conteudo-feed-counters');
const { ids } = w;

const FORMATS = '{image,carousel,reels}';
const NOBODY = '00000000-0000-4000-8000-000000000000';

interface Counters { readonly posts: number; readonly approved: number; readonly awaiting: number }

const viaFunction = (user: string, clientId: string): Promise<Counters | undefined> =>
  w.asUser(user, async (transaction) => {
    const result = await transaction.raw('select posts, approved, awaiting from app_private.content_feed_counters(?::uuid, ?::text[])', [clientId, FORMATS]);
    const row = (result.rows as Array<Record<string, string | number>>)[0];
    return row === undefined ? undefined : { posts: Number(row.posts), approved: Number(row.approved), awaiting: Number(row.awaiting) };
  });

/** What the feed counted before: the same filter, under the policy of `contents`. */
const underPolicy = (user: string, clientId: string): Promise<Counters> =>
  w.asUser(user, async (transaction) => {
    const result = await transaction.raw(`
      select count(*) as posts,
        count(*) filter (where content.status = 'approved') as approved,
        count(*) filter (where content.status = 'awaiting_approval') as awaiting
      from public.contents content
      where content.client_id = ?::uuid and content.format::text = any(?::text[]) and content.status <> 'cancelled'
    `, [clientId, FORMATS]);
    const row = (result.rows as Array<Record<string, string | number>>)[0]!;
    return { posts: Number(row.posts), approved: Number(row.approved), awaiting: Number(row.awaiting) };
  });

let reader: string;
let operateOnly: string;
let noContent: string;

beforeAll(async () => {
  await w.setup();
  reader = await w.personWith('conteudo.visualizar');
  operateOnly = await w.personWith('conteudo.operar');
  noContent = await w.personWith('cliente.visualizar');

  // clientA1: 7 in the feed (2 approved, 1 awaiting), plus a cancelled one and two formats the feed never lists.
  for (const status of ['in_production', 'in_production', 'adjusting', 'published'] as const) await w.seedContent(ids.clientA1, { status });
  await w.seedContent(ids.clientA1, { status: 'approved', format: 'image' });
  await w.seedContent(ids.clientA1, { status: 'approved', format: 'carousel' });
  await w.seedContent(ids.clientA1, { status: 'awaiting_approval', format: 'reels' });
  await w.seedContent(ids.clientA1, { status: 'cancelled' });
  await w.seedContent(ids.clientA1, { status: 'approved', format: 'long_video' });
  await w.seedContent(ids.clientA1, { status: 'awaiting_approval', format: 'vsl' });
  // clientA2: another client of the same agency, so a count never mixes clients.
  await w.seedContent(ids.clientA2, { status: 'awaiting_approval' });
  await w.seedContent(ids.clientA2);
  // clientB: another agency.
  await w.seedContent(ids.clientB, { status: 'approved', owner: ids.adminB, approvedBy: ids.portalB });
  await w.seedContent(ids.clientB, { owner: ids.adminB });
  await w.seedContent(ids.clientB, { owner: ids.adminB });
}, 90_000);

afterAll(async () => {
  await w.teardown();
});

describe('the counters of the feed', () => {
  it('count the feed of the client: cancelled and the formats the feed never lists stay out', async () => {
    expect(await viaFunction(ids.adminA, ids.clientA1)).toEqual({ posts: 7, approved: 2, awaiting: 1 });
    expect(await viaFunction(ids.adminA, ids.clientA2)).toEqual({ posts: 2, approved: 0, awaiting: 1 });
    expect(await viaFunction(ids.adminB, ids.clientB)).toEqual({ posts: 3, approved: 1, awaiting: 0 });
  });

  it('are the numbers of the policy for every person and every client, in both directions', async () => {
    const people = {
      ownerA: ids.ownerA, adminA: ids.adminA, managerA: ids.managerA, productionA: ids.productionA, salesA: ids.salesA, financeA: ids.financeA,
      adminB: ids.adminB, adminSuspended: ids.adminSuspended, dualBare: ids.dualBare, dualFull: ids.dualFull, dualRemoved: ids.dualRemoved,
      crossDual: ids.crossDual, portalA1: ids.portalA1, portalB: ids.portalB, reader, operateOnly, noContent
    };
    const clients = [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended, NOBODY];
    let positives = 0;
    let zeros = 0;
    for (const [name, user] of Object.entries(people)) {
      for (const client of clients) {
        const policy = await underPolicy(user, client);
        const given = await viaFunction(user, client);
        if (policy.posts === 0) {
          // The policy shows this person nothing: the function gives no row or zeros, never a number.
          zeros += 1;
          expect(given === undefined || given.posts === 0, `${name} on ${client}`).toBe(true);
        } else {
          positives += 1;
          expect(given, `${name} on ${client}`).toEqual(policy);
        }
      }
    }
    expect(positives).toBeGreaterThan(8);
    expect(zeros).toBeGreaterThan(30);
  });

  it('gives a person who may not see contents no row at all, not even zeros', async () => {
    for (const user of [operateOnly, noContent, ids.salesA, ids.financeA]) {
      expect(await viaFunction(user, ids.clientA1), user).toBeUndefined();
    }
  });

  it('gives a member of another agency no row, whichever client is asked', async () => {
    expect(await viaFunction(ids.adminB, ids.clientA1)).toBeUndefined();
    expect(await viaFunction(ids.adminA, ids.clientB)).toBeUndefined();
    expect(await viaFunction(ids.crossDual, ids.clientA1)).toBeUndefined();
  });

  it('gives a person of a suspended agency, a stranger and a client that does not exist no row', async () => {
    expect(await viaFunction(ids.adminSuspended, ids.clientSuspended)).toBeUndefined();
    expect(await viaFunction(ids.adminA, NOBODY)).toBeUndefined();
    expect(await viaFunction('00000000-0000-4000-8000-0000000000aa', ids.clientA1)).toBeUndefined();
  });

  it('can be executed by the application and by nobody else, and does not read the schema of the caller', async () => {
    const privileges = await w.getOwner().knex.raw<{ rows: Array<{ app: boolean; pub: boolean; definer: boolean; path: string[] | null }> }>(`
      select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
             has_function_privilege('public', p.oid, 'execute') as pub,
             p.prosecdef as definer,
             p.proconfig as path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'content_feed_counters'
    `);
    expect(privileges.rows).toHaveLength(1);
    expect(privileges.rows[0]).toMatchObject({ app: true, pub: false, definer: true });
    expect(privileges.rows[0]!.path).toEqual(['search_path=""']);
  });
});
