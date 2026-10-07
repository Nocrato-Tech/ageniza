import type { ClientMember, ClientMemberStatus } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';
import type { ClientTransaction } from './service.js';

/**
 * Access to a client's portal, seen from the agency (specs/clientes.md sections 4 and 6; issue #132).
 *
 * `auth."user"` has no RLS, so every statement starts from `client_memberships` filtered by the
 * client of the route and by that client's agency, and reaches the person only through the link's
 * `user_id`. The RLS of `client_memberships` lets any member of the agency read the links of its
 * clients, and `invitations_select` lets whoever holds `cliente.convidar_usuario` read the
 * invitations of every kind of the agency; neither says which client or which kind a route means, so
 * the client, the agency and the purpose are conditions of each statement here.
 */

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface ClientMemberRow {
  readonly membership_id: string;
  readonly name: string;
  readonly email: string;
  readonly status: ClientMemberStatus;
  readonly created_at: Date;
}

const MEMBER_COLUMNS = `
  membership.id as membership_id,
  member.name as name,
  member.email as email,
  membership.status as status,
  membership.created_at as created_at
`;

const MEMBER_FROM = `
  from public.client_memberships membership
  join public.clients client on client.id = membership.client_id
  join auth."user" member on member.id = membership.user_id
`;

export const clientMemberFromRow = (row: ClientMemberRow): ClientMember => ({
  membershipId: row.membership_id,
  name: row.name,
  email: row.email,
  status: row.status,
  since: new Date(row.created_at).toISOString()
});

export interface ClientMemberPage {
  readonly items: readonly ClientMemberRow[];
  readonly totalItems: number;
}

/**
 * One page of the people of a client in one status, by name ascending (accent and case folded, then
 * compared byte by byte like the collaborators, so the order does not depend on the database
 * collation) with the link id as the tie-break. `count(*) over ()` rides the page's own snapshot.
 */
export const listClientMembers = async (
  transaction: ClientTransaction,
  scope: { readonly agencyId: string; readonly clientId: string },
  filters: { readonly status: ClientMemberStatus },
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<ClientMemberPage> => {
  const where = 'membership.client_id = ?::uuid and client.agency_id = ?::uuid and membership.status = ?';
  const bindings = [scope.clientId, scope.agencyId, filters.status];
  const result = await raw<RawRows<ClientMemberRow & { readonly total: string | number }>>(transaction, `
    select ${MEMBER_COLUMNS}, count(*) over () as total
    ${MEMBER_FROM}
    where ${where}
    order by ${foldTextSql('member.name')} collate "C" asc, membership.id asc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) return { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) };
  // An empty first page is the whole truth; a second count could only answer from another snapshot.
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `select count(*) as total ${MEMBER_FROM} where ${where}`, bindings);
  return { items: [], totalItems: Number(count.rows[0]?.total ?? 0) };
};

/** A link of this client, of this agency, in any status; a link of another client is not a row here. */
export const loadClientMember = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly membershipId: string }
): Promise<ClientMemberRow | undefined> => {
  const result = await raw<RawRows<ClientMemberRow>>(transaction, `
    select ${MEMBER_COLUMNS}
    ${MEMBER_FROM}
    where membership.id = ?::uuid and membership.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.membershipId, input.clientId, input.agencyId]);
  return result.rows[0];
};

/** The code `app_private.set_client_membership_status` raises for every refusal it can give. */
const MEMBERSHIP_FUNCTION_REFUSED = 'A0020';

export const isMembershipFunctionRefusal = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MEMBERSHIP_FUNCTION_REFUSED;

/**
 * Removes or reactivates a link through the one function that may write `status` (`ageniza_app` has
 * no `UPDATE` on the column). The function checks `cliente.remover_usuario` on the client's own
 * agency, locks, audits, and writes nothing when the link is already in the status.
 */
export const setClientMemberStatus = async (
  transaction: ClientTransaction,
  membershipId: string,
  status: ClientMemberStatus
): Promise<void> => {
  await raw(transaction, 'select app_private.set_client_membership_status(?::uuid, ?)', [membershipId, status]);
};

export interface PendingClientInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly expires_at: Date;
}

export interface PendingClientInvitationPage {
  readonly items: readonly PendingClientInvitationRow[];
  readonly totalItems: number;
}

const PENDING_CLIENT_INVITATIONS = `
  from public.invitations invitation
  where invitation.agency_id = ?::uuid
    and invitation.client_id = ?::uuid
    and invitation.purpose = 'client_invite'
    and invitation.used_at is null
    and invitation.revoked_at is null
    and invitation.expires_at > now()
`;

/**
 * The pending portal invitations of one client, the one that expires first on top. Only
 * `client_invite` of this client: an invitation of a collaborator, of another client or of the
 * agency's own activation is the agency's to read by policy and none of this route's.
 */
export const listPendingClientInvitations = async (
  transaction: ClientTransaction,
  scope: { readonly agencyId: string; readonly clientId: string },
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<PendingClientInvitationPage> => {
  const bindings = [scope.agencyId, scope.clientId];
  const result = await raw<RawRows<PendingClientInvitationRow & { readonly total: string | number }>>(transaction, `
    select invitation.id, invitation.email, invitation.expires_at, count(*) over () as total
    ${PENDING_CLIENT_INVITATIONS}
    order by invitation.expires_at asc, invitation.id asc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) return { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) };
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `select count(*) as total ${PENDING_CLIENT_INVITATIONS}`, bindings);
  return { items: [], totalItems: Number(count.rows[0]?.total ?? 0) };
};
