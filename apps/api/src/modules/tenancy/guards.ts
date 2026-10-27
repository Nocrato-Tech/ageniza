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
  readonly terms_blocked: boolean;
  readonly email_unconfirmed: boolean;
}

interface ClientAccessRow {
  readonly client_id: string;
  readonly agency_id: string;
  readonly client_membership_id: string;
  readonly terms_blocked: boolean;
  readonly email_unconfirmed: boolean;
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

/**
 * The account has Google and has not accepted the Terms and the Privacy Policy, or Google took the account over and revoked the
 * acceptance (decision 2026-10-26, items 2 and 4; issue #707). Without the acceptance there is no context, so no agency or
 * portal route answers: the person keeps only what is needed to accept (`/me/legal-acceptances`, the session, sign-out and the
 * profile), none of which goes through these guards.
 */
const termsNotAccepted = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'TERMS_NOT_ACCEPTED',
  message: 'Aceite os Termos de Uso e a Política de Privacidade para continuar.'
});

/** An account that has not confirmed its e-mail opens no agency and no portal, even with the session of an invitation (decision 2026-10-27). */
const emailNotConfirmed = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'EMAIL_NOT_CONFIRMED',
  message: 'Confirme o seu e-mail para entrar.'
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
          -- The keys come from the one function that resolves them (#189), never from a join of
          -- this file: the guard cannot allow what RLS would deny because a copy drifted. The Owner
          -- gets the whole catalog here, and tenantHolds still passes the Owner by ownership.
          coalesce(
            (select array_agg(held.key order by held.key) from app_private.agency_permission_keys(agency.id) as held(key)),
            array[]::text[]
          ) as permissions,
          app_private.legal_acceptance_blocks_access(app_private.current_user_id()) as terms_blocked,
          app_private.email_not_confirmed(app_private.current_user_id()) as email_unconfirmed
        from public.agencies as agency
        left join public.agency_memberships as membership
          on membership.agency_id = agency.id
         and membership.user_id = app_private.current_user_id()
         and membership.status = 'active'
        -- Only the role's label is read here, with the same scope as the keys: a membership pointing
        -- at another agency's role has no role key.
        left join public.roles as role
          on role.id = membership.role_id
         and (role.agency_id is null or role.agency_id = agency.id)
        where agency.id = ?::uuid
          and agency.status = 'active'
          and (membership.id is not null or agency.owner_user_id = app_private.current_user_id())
      `, [agencyId]);
      return result.rows[0];
    });

    // A missing row intentionally covers nonexistent, suspended, and inaccessible agencies.
    if (row === undefined) throw notFound();
    if (row.email_unconfirmed !== false) throw emailNotConfirmed();
    if (row.terms_blocked === true) throw termsNotAccepted();
    request.tenant = {
      agencyId,
      isOwner: row.is_owner === true,
      roleKey: row.role_key ?? null,
      permissions: new Set(row.permissions ?? [])
    };
  };

/** Alias matching the guard name used by route modules. */
export const requireAgencyAccess = createRequireAgencyAccess;

/**
 * Whether the caller holds a permission: the Owner passes every check by ownership, exactly like
 * `app_private.has_agency_permission`. For a rule that depends on the request body, where a single
 * fixed `requirePermission` key cannot say enough.
 */
export const tenantHolds = (tenant: Pick<TenantContext, 'isOwner' | 'permissions'>, key: string): boolean =>
  tenant.isOwner || tenant.permissions.has(key);

/**
 * 42501 is what both an RLS policy and a trigger of this schema raise. A route checks before it
 * writes, so reaching it means the two layers disagreed; the caller still gets the 403 the route
 * would have given, never a 500.
 */
export const isInsufficientPrivilegeError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '42501';

/** Builds a preHandler for one permission after `requireAgencyAccess` populated the context. */
export const requirePermission = (key: string) =>
  async (request: FastifyRequest): Promise<void> => {
    const tenant = request.tenant;
    if (tenant === undefined || !tenantHolds(tenant, key)) throw forbidden();
  };

/**
 * Builds a preHandler for **any** of the named permissions after `requireAgencyAccess` populated
 * the context (issue #287): reading the assignable roles serves both the invite flow
 * (`colaborador.convidar`) and the role change/reactivation flows (`colaborador.alterar_papel`),
 * and either one is enough. The Owner keeps passing by ownership, exactly like `requirePermission`.
 */
export const requireAnyPermission = (keys: readonly string[]) =>
  async (request: FastifyRequest): Promise<void> => {
    const tenant = request.tenant;
    if (tenant === undefined || (!tenant.isOwner && !keys.some((key) => tenant.permissions.has(key)))) throw forbidden();
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
          membership.id as client_membership_id,
          app_private.legal_acceptance_blocks_access(app_private.current_user_id()) as terms_blocked,
          app_private.email_not_confirmed(app_private.current_user_id()) as email_unconfirmed
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
    if (row.email_unconfirmed !== false) throw emailNotConfirmed();
    if (row.terms_blocked === true) throw termsNotAccepted();
    request.clientContext = {
      clientId: row.client_id,
      agencyId: row.agency_id,
      clientMembershipId: row.client_membership_id
    };
  };

/** Alias matching the guard name used by route modules. */
export const requireClientAccess = createRequireClientAccess;
