import type { ClientMember, ClientMemberStatus } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';
import type { ClientTransaction } from './service.js';

/**
 * Access to a client's portal, seen from the agency (specs/clientes.md sections 4 and 6; issues #132 and #711).
 *
 * A person is an access given to an e-mail address (`client_portal_accesses`), with an account or without one. The table has
 * no INSERT or UPDATE for the application: every change goes through a `security definer` function of the access, so this
 * file only reads the table and calls those functions. `auth."user"` has no RLS, so every statement starts from the access
 * filtered by the client of the route and by that client's agency, and reaches the account only through the access's own
 * `user_id`, with a LEFT join: an access nobody has entered is a row, not a gap.
 *
 * Nothing here says whether an address has an account. The name is the account's, and only once that account has entered the
 * portal of THIS client (`first_entered_at`): the link happens at any load of the contexts, even of someone who only works in
 * another agency, and the list must not turn that into a name.
 */

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface ClientMemberRow {
  readonly access_id: string;
  readonly name: string | null;
  readonly email: string;
  readonly status: ClientMemberStatus;
  readonly entered: boolean;
  readonly created_at: Date;
}

const MEMBER_COLUMNS = `
  access.id as access_id,
  case when access.first_entered_at is not null then member.name end as name,
  access.email as email,
  access.status as status,
  (access.first_entered_at is not null and access.user_id is not null) as entered,
  access.created_at as created_at
`;

const MEMBER_FROM = `
  from public.client_portal_accesses access
  join public.clients client on client.id = access.client_id
  left join auth."user" member on member.id = access.user_id
`;

export const clientMemberFromRow = (row: ClientMemberRow): ClientMember => ({
  accessId: row.access_id,
  name: row.name,
  email: row.email,
  status: row.status,
  entered: row.entered,
  since: new Date(row.created_at).toISOString()
});

export interface ClientMemberPage {
  readonly items: readonly ClientMemberRow[];
  readonly totalItems: number;
}

/**
 * One page of the people of a client in one status, by name ascending (the account's name once it is linked, the address before;
 * accent and case folded, then compared byte by byte like the collaborators, so the order does not depend on the database
 * collation) with the access id as the tie-break. `count(*) over ()` rides the page's own snapshot.
 */
export const listClientMembers = async (
  transaction: ClientTransaction,
  scope: { readonly agencyId: string; readonly clientId: string },
  filters: { readonly status: ClientMemberStatus },
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<ClientMemberPage> => {
  const where = 'access.client_id = ?::uuid and client.agency_id = ?::uuid and access.status = ?';
  const bindings = [scope.clientId, scope.agencyId, filters.status];
  const result = await raw<RawRows<ClientMemberRow & { readonly total: string | number }>>(transaction, `
    select ${MEMBER_COLUMNS}, count(*) over () as total
    ${MEMBER_FROM}
    where ${where}
    order by ${foldTextSql('coalesce(member.name, access.email)')} collate "C" asc, access.id asc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) return { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) };
  // An empty first page is the whole truth; a second count could only answer from another snapshot.
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `select count(*) as total ${MEMBER_FROM} where ${where}`, bindings);
  return { items: [], totalItems: Number(count.rows[0]?.total ?? 0) };
};

/** An access of this client, of this agency, in any status; an access of another client is not a row here. */
export const loadClientMember = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly accessId: string }
): Promise<ClientMemberRow | undefined> => {
  const result = await raw<RawRows<ClientMemberRow>>(transaction, `
    select ${MEMBER_COLUMNS}
    ${MEMBER_FROM}
    where access.id = ?::uuid and access.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.accessId, input.clientId, input.agencyId]);
  return result.rows[0];
};

/** The code the functions of the access raise for every refusal they can give (client or access absent, archived, or no permission). */
const ACCESS_FUNCTION_REFUSED = 'A0020';

export const isAccessFunctionRefusal = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ACCESS_FUNCTION_REFUSED;

export interface AddedClientAccess {
  readonly accessId: string;
  /** `created`: a new row. `reactivated`: the removed row of the address, or the row of an account that no longer has it. `already_active`: nothing written. */
  readonly outcome: 'created' | 'reactivated' | 'already_active';
  /** The account that lost the access because the address changed hands; its sessions end like any removal. */
  readonly unlinkedUserId: string | null;
}

/**
 * "Adicionar pessoa": the one function that may insert an access. It checks `cliente.convidar_usuario` on the client's own
 * agency, locks the client, and gives the access on the spot, or reactivates the row of the same address.
 */
export const addClientMember = async (
  transaction: ClientTransaction,
  clientId: string,
  email: string
): Promise<AddedClientAccess> => {
  const result = await raw<RawRows<{ access_id: string; outcome: AddedClientAccess['outcome']; unlinked_user_id: string | null }>>(
    transaction,
    'select * from app_private.add_client_portal_access(?::uuid, ?)',
    [clientId, email]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The access just added could not be read back.');
  return { accessId: row.access_id, outcome: row.outcome, unlinkedUserId: row.unlinked_user_id };
};

export interface ChangedClientAccess {
  /** The account linked to the access, whose sessions end when the access is removed; `null` for an access nobody has entered. */
  readonly accountUserId: string | null;
  /** Whether this call changed the state; removing a removed access, or reactivating an active one, writes nothing. */
  readonly changed: boolean;
}

/**
 * Removes or reactivates an access through the one function that may write its state (`ageniza_app` has no `UPDATE` on the
 * table). The function checks `cliente.remover_usuario` on the client's own agency, locks, audits, takes the membership along,
 * and on a removal advances the generation that the approval links carry.
 */
export const setClientMemberStatus = async (
  transaction: ClientTransaction,
  accessId: string,
  status: ClientMemberStatus
): Promise<ChangedClientAccess> => {
  const statement = status === 'removed'
    ? 'select * from app_private.remove_client_portal_access(?::uuid)'
    : 'select * from app_private.reactivate_client_portal_access(?::uuid)';
  const result = await raw<RawRows<{ account_user_id: string | null; changed: boolean }>>(transaction, statement, [accessId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The access whose state just changed could not be read back.');
  return { accountUserId: row.account_user_id, changed: row.changed };
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
 * The pending portal invitations of one client, the one that expires first on top. A portal invitation is no longer created
 * (decision 2026-10-26), so this is what is left of the old ones, until the last of them expires. Only `client_invite` of this
 * client: an invitation of a collaborator, of another client or of the agency's own activation is the agency's to read by
 * policy and none of this route's.
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
