import { raw } from '@ageniza/database';

import type { ContentTransaction } from './service.js';

/** Who reads the people of a client's portal: the permission of the Acessos tab, the one the decisions of 2026-11-11 ask for. */
const PORTAL_PEOPLE_PERMISSION = 'cliente.convidar_usuario';

export interface PortalPeople {
  /** The names of the first people, in the order they were given the access. */
  readonly names: string[];
  /** All the active people who have entered, not only the names read. */
  readonly total: number;
}

/**
 * Whether this person reads the portal people of the agency's clients. The table of accesses is also readable by `cliente.remover_usuario`
 * (to remove what they see), so the policy would give the names to a person the decision does not: the permission is asked here.
 */
export const canReadPortalPeople = async (transaction: ContentTransaction, agencyId: string): Promise<boolean> => {
  const result = await raw<{ readonly rows: ReadonlyArray<{ allowed: boolean }> }>(
    transaction,
    'select app_private.has_agency_permission(?::uuid, ?::text) as allowed',
    [agencyId, PORTAL_PEOPLE_PERMISSION]
  );
  return result.rows[0]?.allowed === true;
};

/**
 * The active people of the portal of each client who have entered it, by name only (no e-mail, id or role leaves this query), the first
 * `limit` of each in the order they were given the access. A person whose access has no account, or who never entered, is nobody yet:
 * the link alone does not make a name, as in the Acessos tab. The caller has asked `canReadPortalPeople` first.
 */
export const loadPortalPeople = async (
  transaction: ContentTransaction,
  input: { readonly clientIds: readonly string[]; readonly limit: number }
): Promise<ReadonlyMap<string, PortalPeople>> => {
  const result = await raw<{ readonly rows: ReadonlyArray<{ client_id: string; name: string; total: string | number }> }>(transaction, `
    select ranked.client_id, ranked.name, ranked.total
    from (
      select access.client_id, member.name,
        row_number() over (partition by access.client_id order by access.created_at, access.id) as position,
        count(*) over (partition by access.client_id) as total
      from public.client_portal_accesses access
      join auth."user" member on member.id = access.user_id
      where access.client_id = any(?::uuid[]) and access.status = 'active' and access.first_entered_at is not null
    ) ranked
    where ranked.position <= ?
    order by ranked.client_id, ranked.position
  `, [`{${input.clientIds.join(',')}}`, input.limit]);

  const people = new Map<string, { names: string[]; total: number }>(input.clientIds.map((clientId) => [clientId, { names: [], total: 0 }]));
  for (const row of result.rows) {
    const entry = people.get(row.client_id);
    if (entry === undefined) continue;
    entry.names.push(row.name);
    entry.total = Number(row.total);
  }
  return people;
};
