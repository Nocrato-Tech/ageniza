import type { FastifyRequest } from 'fastify';

import { HttpError } from '@ageniza/core';
import { raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';

export interface TenantContext {
  readonly agencyId: string;
  /** Ownership is an agency property and is intentionally independent of role membership. */
  readonly isOwner: boolean;
  /** Null is possible only for a legacy/partially provisioned owner without a membership. */
  readonly roleKey: string | null;
  readonly permissions: ReadonlySet<string>;
}

export interface ClientContext {
  readonly clientId: string;
  readonly agencyId: string;
  readonly clientMembershipId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the agency guard for downstream domain handlers. */
    tenant?: TenantContext;
    /** Set by `requireClientAccess` for downstream client-portal handlers. */
    clientContext?: ClientContext;
  }
}

export interface TenancyGuardDependencies {
  readonly database: DatabaseClient;
}

interface AgencyAccessRow {
  readonly agency_id: string;
  readonly is_owner: boolean;
  readonly role_key: string | null;
  readonly permissions: readonly string[] | null;
}

interface ClientAccessRow {
  readonly client_id: string;
  readonly agency_id: string;
  readonly client_membership_id: string;
}

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const notFound = (): HttpError => new HttpError({
  statusCode: 404,
  code: 'NOT_FOUND',
  message: 'Agency not found.'
});

const clientNotFound = (): HttpError => new HttpError({
  statusCode: 404,
  code: 'NOT_FOUND',
  message: 'Client not found.'
});

const unauthenticated = (): HttpError => new HttpError({
  statusCode: 401,
  code: 'UNAUTHENTICATED',
  message: 'Authentication is required.'
});

const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

const invalidAgencyId = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'agencyId', code: 'invalid_string', message: 'Agency ID must be a UUID.' }] }
});

const routeAgencyId = (params: unknown): string | undefined => {
  if (typeof params !== 'object' || params === null || !('agencyId' in params)) return undefined;
  const value = (params as Record<string, unknown>).agencyId;
  return typeof value === 'string' ? value : undefined;
};

const routeClientId = (params: unknown): string | undefined => {
  if (typeof params !== 'object' || params === null || !('clientId' in params)) return undefined;
  const value = (params as Record<string, unknown>).clientId;
  return typeof value === 'string' ? value : undefined;
};

/**
 * Builds the reusable tenant preHandler. The active membership/owner check deliberately runs
 * under `withAuthenticatedUserTransaction`, so the same connection-local user context is present
 * for this check and for every domain query that follows it.
 */
export const createRequireAgencyAccess = (dependencies: TenancyGuardDependencies) =>
  async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();

    const agencyId = routeAgencyId(request.params);
    if (agencyId === undefined || !uuidPattern.test(agencyId)) throw invalidAgencyId();

    const row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const result = await raw<RawRows<AgencyAccessRow>>(transaction, `
        select
          agency.id as agency_id,
          (agency.owner_user_id = app_private.current_user_id()) as is_owner,
          role.key as role_key,
          coalesce(
            array_agg(distinct role_permission.permission_key) filter (where role_permission.permission_key is not null),
            array[]::text[]
          ) as permissions
        from public.agencies as agency
        left join public.agency_memberships as membership
          on membership.agency_id = agency.id
         and membership.user_id = app_private.current_user_id()
         and membership.status = 'active'
        -- The role scope mirrors app_private.has_agency_permission: a membership pointing at
        -- another agency's role grants nothing, so the guard never allows what RLS would deny.
        left join public.roles as role
          on role.id = membership.role_id
         and (role.agency_id is null or role.agency_id = agency.id)
        left join public.role_permissions as role_permission on role_permission.role_id = role.id
        where agency.id = ?::uuid
          and agency.status = 'active'
          and (membership.id is not null or agency.owner_user_id = app_private.current_user_id())
        group by agency.id, agency.owner_user_id, role.key
      `, [agencyId]);
      return result.rows[0];
    });

    // A missing row intentionally covers nonexistent, suspended, and inaccessible agencies.
    if (row === undefined) throw notFound();
    request.tenant = {
      agencyId,
      isOwner: row.is_owner === true,
      roleKey: row.role_key ?? null,
      permissions: new Set(row.permissions ?? [])
    };
  };

/** Alias matching the guard name used by route modules. */
export const requireAgencyAccess = createRequireAgencyAccess;

/** Builds a preHandler for one permission after `requireAgencyAccess` populated the context. */
export const requirePermission = (key: string) =>
  async (request: FastifyRequest): Promise<void> => {
    const tenant = request.tenant;
    if (tenant === undefined || (!tenant.isOwner && !tenant.permissions.has(key))) throw forbidden();
  };

/**
 * Builds the client-portal preHandler (AUTH-20C). Requires `requireSession` to have already
 * populated `request.auth`. A client context is valid only when the caller has an *active client
 * membership* for `:clientId`, the client is `active`, and its agency is `active` -- an agency
 * collaborator without an explicit client membership does not gain portal access through this
 * guard, because the agency workspace and the client portal are different contexts (issue #33).
 */
export const createRequireClientAccess = (dependencies: TenancyGuardDependencies) =>
  async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();

    const clientId = routeClientId(request.params);
    if (clientId === undefined || !uuidPattern.test(clientId)) throw clientNotFound();

    const row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const result = await raw<RawRows<ClientAccessRow>>(transaction, `
        select
          client.id as client_id,
          client.agency_id as agency_id,
          membership.id as client_membership_id
        from public.client_memberships as membership
        join public.clients as client on client.id = membership.client_id
        join public.agencies as agency on agency.id = client.agency_id
        where client.id = ?::uuid
          and membership.user_id = app_private.current_user_id()
          and membership.status = 'active'
          and client.status = 'active'
          and agency.status = 'active'
      `, [clientId]);
      return result.rows[0];
    });

    // A missing row intentionally covers a nonexistent client, an archived client, a suspended
    // agency, and a caller without an active client membership -- never revealing which.
    if (row === undefined) throw clientNotFound();
    request.clientContext = {
      clientId: row.client_id,
      agencyId: row.agency_id,
      clientMembershipId: row.client_membership_id
    };
  };

/** Alias matching the guard name used by route modules. */
export const requireClientAccess = createRequireClientAccess;
