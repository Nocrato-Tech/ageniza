import { createVerifiedUserClaims, raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { Context } from '@ageniza/contracts';

type ContextTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

interface AgencyContextRow {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly is_owner: boolean;
  readonly role_key: string;
  readonly role_name: string;
}

interface ClientContextRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly agency_id: string;
  readonly agency_name: string;
  readonly onboarding_pending: boolean;
}

interface LastContextRow {
  readonly context_type: 'agency' | 'client';
  readonly agency_id: string | null;
  readonly client_id: string | null;
}

export interface ListValidContextsResult {
  /** Every context the caller currently has valid access to, ordered per issue #33 section 6.1. */
  readonly contexts: readonly Context[];
  /** The person's last-used context, present only when it is still valid; never mutates state. */
  readonly lastUsedContext: Context | null;
}

/** Stable per-context key used for equality/sort tie-breaking; never exposed on the wire. */
const contextKey = (context: Context): string => context.type === 'agency'
  ? `agency:${context.agencyId}`
  : `client:${context.clientId}`;

const displayName = (context: Context): string => context.type === 'agency' ? context.agencyName : context.clientName;

/**
 * Orders contexts per spec 6.1: the last-used context (if still valid) first, then the rest
 * alphabetically by display name (accent/case-insensitive, pt-BR collation), then agency before
 * client, then by id.
 */
const sortContexts = (contexts: readonly Context[], lastUsedKey: string | undefined): readonly Context[] =>
  [...contexts].sort((a, b) => {
    if (lastUsedKey !== undefined) {
      const aIsLast = contextKey(a) === lastUsedKey;
      const bIsLast = contextKey(b) === lastUsedKey;
      if (aIsLast !== bIsLast) return aIsLast ? -1 : 1;
    }
    const nameComparison = displayName(a).localeCompare(displayName(b), 'pt-BR', { sensitivity: 'base' });
    if (nameComparison !== 0) return nameComparison;
    if (a.type !== b.type) return a.type === 'agency' ? -1 : 1;
    const aId = a.type === 'agency' ? a.agencyId : a.clientId;
    const bId = b.type === 'agency' ? b.agencyId : b.clientId;
    return aId.localeCompare(bId);
  });

const fetchAgencyContexts = async (transaction: ContextTransaction): Promise<Context[]> => {
  const result = await raw<RawRows<AgencyContextRow>>(transaction, `
    select
      agency.id as agency_id,
      agency.name as agency_name,
      (agency.owner_user_id = app_private.current_user_id()) as is_owner,
      coalesce(role.key, 'admin') as role_key,
      coalesce(role.name, 'Admin') as role_name
    from public.agencies as agency
    left join public.agency_memberships as membership
      on membership.agency_id = agency.id
     and membership.user_id = app_private.current_user_id()
     and membership.status = 'active'
    left join public.roles as role
      on role.id = membership.role_id
     and (role.agency_id is null or role.agency_id = agency.id)
    where agency.status = 'active'
      and (membership.id is not null or agency.owner_user_id = app_private.current_user_id())
  `, []);
  return result.rows.map((row) => ({
    type: 'agency' as const,
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    roleKey: row.role_key,
    roleName: row.role_name,
    isOwner: row.is_owner === true
  }));
};

const fetchClientContexts = async (transaction: ContextTransaction): Promise<Context[]> => {
  const result = await raw<RawRows<ClientContextRow>>(transaction, `
    select
      client.id as client_id,
      client.name as client_name,
      agency.id as agency_id,
      agency.name as agency_name,
      (membership.onboarding_seen_at is null) as onboarding_pending
    from public.client_memberships as membership
    join public.clients as client on client.id = membership.client_id
    join public.agencies as agency on agency.id = client.agency_id
    where membership.user_id = app_private.current_user_id()
      and membership.status = 'active'
      and client.status = 'active'
      and agency.status = 'active'
  `, []);
  return result.rows.map((row) => ({
    type: 'client' as const,
    clientId: row.client_id,
    clientName: row.client_name,
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    onboardingPending: row.onboarding_pending === true
  }));
};

const fetchLastUsedKey = async (transaction: ContextTransaction): Promise<string | undefined> => {
  const result = await raw<RawRows<LastContextRow>>(transaction, `
    select context_type, agency_id, client_id
    from public.user_context_preferences
    where user_id = app_private.current_user_id()
  `, []);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return row.context_type === 'agency' ? `agency:${row.agency_id}` : `client:${row.client_id}`;
};

/**
 * Lists every context (agency or client) the authenticated user currently has valid access to,
 * ordered per issue #33 section 6.1. Must run inside `withAuthenticatedUserTransaction`; the
 * queries rely on transaction-local `app_private.current_user_id()`, matching the RLS boundary
 * exactly.
 */
export const listValidContexts = async (transaction: ContextTransaction): Promise<ListValidContextsResult> => {
  const [agencyContexts, clientContexts, lastUsedKey] = await Promise.all([
    fetchAgencyContexts(transaction),
    fetchClientContexts(transaction),
    fetchLastUsedKey(transaction)
  ]);
  const contexts = sortContexts([...agencyContexts, ...clientContexts], lastUsedKey);
  const lastUsedContext = lastUsedKey === undefined ? null : contexts.find((context) => contextKey(context) === lastUsedKey) ?? null;
  return { contexts, lastUsedContext };
};

/**
 * Counts every valid context for a user, reusing the same query `listValidContexts` walks.
 * Injected into the auth module (issue #68) so `POST /auth/login` can deny a correct credential
 * that resolves to zero contexts without duplicating this query there.
 */
export const countValidContexts = async (database: DatabaseClient, userId: string): Promise<number> => {
  const claims = createVerifiedUserClaims({ userId });
  const { contexts } = await withAuthenticatedUserTransaction(database, claims, (transaction) => listValidContexts(transaction));
  return contexts.length;
};

/** Finds the context matching a raw `preferred=agency:<uuid>` / `client:<uuid>` query value. */
export const findPreferredContext = (contexts: readonly Context[], preferred: string): Context | undefined => {
  return contexts.find((context) => contextKey(context) === preferred);
};

/** Revalidates an agency context using the same security-definer check RLS relies on. */
export const isValidAgencyContext = async (transaction: ContextTransaction, agencyId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ valid: boolean }>>(transaction, 'select app_private.is_agency_member(?::uuid) as valid', [agencyId]);
  return result.rows[0]?.valid === true;
};

/** Revalidates a client context using the same security-definer check RLS relies on. */
export const isValidClientContext = async (transaction: ContextTransaction, clientId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ valid: boolean }>>(transaction, 'select app_private.is_client_member(?::uuid) as valid', [clientId]);
  return result.rows[0]?.valid === true;
};
