import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import type { DatabaseClient } from '../../src/index.js';

import type { ApprovalFixtures } from './approval-fixtures.js';
import type { ContentWorld } from './content-world.js';

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export interface LinkWorld { readonly clientId: string; readonly accessId: string; readonly linkId: string; readonly sessionHash: string }

/**
 * An access of a fresh client, the link of its e-mail (one content, awaiting approval) and the session of its cookie: what the functions of the
 * approval link are called with. `worker` is the client of the application role, which runs the link with no account bound.
 */
export const createLinkWorld = async (w: ContentWorld, a: ApprovalFixtures, worker: DatabaseClient): Promise<LinkWorld> => {
  const owner = w.getOwner().knex;
  const asApp = <T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => worker.knex.transaction(work);
  const clientId = await a.freshClient([]);
  const access = (await owner('client_portal_accesses').insert({ client_id: clientId, email: `${randomUUID()}@w11s1-link.test` }).returning('id'))[0] as { id: string };
  const first = await w.seedContent(clientId, { status: 'awaiting_approval' });
  const claimToken = randomUUID();
  const item = (await owner.raw<{ rows: Array<{ id: string }> }>(`
    insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
    values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1)
    returning id
  `, [clientId, access.id, first, claimToken])).rows[0]!;
  const tokenHash = sha(randomBytes(32).toString('base64url'));
  const sessionHash = sha(randomBytes(32).toString('base64url'));
  await asApp((t) => t.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [[item.id], claimToken, tokenHash]));
  await asApp((t) => t.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, sessionHash]));
  const link = (await owner('client_portal_approval_links').where({ token_hash: tokenHash }).first('id'))!;
  return { clientId, accessId: access.id, linkId: link.id as string, sessionHash };
};
