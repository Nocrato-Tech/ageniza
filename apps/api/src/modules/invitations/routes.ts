import { randomUUID } from 'node:crypto';

import {
  AgencyClientPathParamsSchema,
  AgencyInvitationPathParamsSchema,
  AgencyPathParamsSchema,
  ClientInvitationRequestSchema,
  CollaboratorInvitationCreatedResponseSchema,
  CollaboratorInvitationRequestSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptRequestSchema,
  InvitationAcceptResponseSchema,
  InvitationCreatedResponseSchema,
  InvitationPreviewResponseSchema,
  PaginationInputSchema,
  PendingInvitationListResponseSchema,
  PublicInvitationTokenPathParamsSchema,
  buildPaginationMetadata,
  resolvePagination,
  type ResolvedPagination
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import {
  createInvitationToken,
  hashInvitationToken,
  type InvitationToken
} from './tokens.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthAuditRecorder } from '../auth/audit.js';
import type { AuthInstance } from '../auth/better-auth.js';
import { applyAuthCookies, toAuthHeaders } from '../auth/bridge.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { EmailService } from '../auth/email-service.js';
import { AUTH_RATE_LIMITS } from '../auth/policy.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { isInsufficientPrivilegeError, tenantHolds } from '../tenancy/guards.js';

/** The small public port used by auth/password routes to validate invitation continuation. */
export interface InvitationTokenLookup {
  (token: string): Promise<InvitationLookup | undefined>;
}

export interface InvitationLookup {
  readonly id: string;
  readonly purpose: 'agency_activation' | 'collaborator_invite' | 'client_invite';
  readonly email: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly clientId: string | null;
  readonly clientName: string | null;
  readonly roleId: string | null;
  readonly valid: boolean;
}

export interface InvitationModuleConfig {
  readonly appPublicUrl: string;
  readonly authTermsVersion: string;
  readonly authPrivacyVersion: string;
}

export interface InvitationModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly emailService: EmailService;
  readonly auditRecorder: AuthAuditRecorder;
  readonly config: InvitationModuleConfig;
  readonly requireAgencyAccess: InvitationPreHandler;
  readonly requirePermission: (key: string) => InvitationPreHandler;
  readonly invitationTokenLookup?: InvitationTokenLookup;
}

export type InvitationPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
type InvitationTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface InvitationRow {
  readonly id: string;
  readonly purpose: InvitationLookup['purpose'];
  readonly email: string;
  readonly agency_id: string;
  readonly agency_name: string;
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly role_id: string | null;
}

interface InvitationLookupRow {
  readonly id: string;
  readonly purpose: InvitationLookup['purpose'];
  readonly email: string;
  readonly agency_id: string;
  readonly agency_name: string;
  readonly client_id: string | null;
  readonly client_name: string | null;
  readonly role_id: string | null;
  readonly valid: boolean;
}

interface AcceptInvitationRow {
  readonly status: 'accepted' | 'already_member';
  readonly agency_id: string;
  readonly client_id: string | null;
}

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

const INVITATION_INVALID = {
  statusCode: 410,
  code: 'INVALID_LINK',
  message: 'Este link não é mais válido.'
} as const;

const invitationNotPending = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'INVITATION_NOT_PENDING',
  message: 'O convite não está pendente.'
});

const membershipExists = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'MEMBERSHIP_EXISTS',
  message: 'Este endereço já possui o vínculo solicitado.'
});

const invalidRole = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'INVALID_ROLE',
  message: 'O papel informado não é válido para esta agência.'
});

// Only the Owner passes `colaborador.atribuir_admin`. The same rule holds for a role change
// (collaborators module): handing out admin through an invitation would otherwise be the way around it.
const GRANT_ADMIN_PERMISSION = 'colaborador.atribuir_admin';

const adminGrantForbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'Só o Owner da agência pode conceder o papel de Admin.'
});

const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

const accountExists = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'ACCOUNT_EXISTS',
  message: 'Já existe uma conta para este endereço.'
});

const accountMismatch = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'INVITATION_ACCOUNT_MISMATCH',
  message: 'A conta autenticada não corresponde ao convite.'
});

const emailDeliveryFailed = (): HttpError => new HttpError({
  statusCode: 502,
  code: 'EMAIL_DELIVERY_FAILED',
  message: 'Não foi possível entregar o e-mail.'
});

const isDuplicateUserError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Serializes the revoke-then-insert pair against the partial unique index on pending invitations.
 * Read Committed alone is not enough: the revoking UPDATE never sees a row a concurrent
 * transaction inserted after its snapshot, so both sides would reach the insert and one would
 * lose on `invitations_pending_equivalent_unique`. The lock key matches that index exactly and is
 * released at commit.
 */
const lockPendingInvitationSlot = async (
  transaction: Parameters<typeof raw>[0],
  agencyId: string,
  purpose: string,
  email: string,
  clientId: string | null
): Promise<void> => {
  await raw(transaction, 'select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [
    `${agencyId}:${purpose}:${email}:${clientId ?? NIL_UUID}`
  ]);
};

/** Second statement, after the caller's `for update`: `now()` freezes before the wait and would
 * keep an invitation that expired during it looking pending (issue #304). */
const isInvitationPending = async (
  transaction: InvitationTransaction,
  agencyId: string,
  invitationId: string
): Promise<boolean> => {
  const result = await raw<RawRows<{ is_pending: boolean }>>(transaction, `
    select (used_at is null and revoked_at is null and expires_at > pg_catalog.statement_timestamp()) as is_pending
    from public.invitations
    where id = ?::uuid and agency_id = ?::uuid
  `, [invitationId, agencyId]);
  return result.rows[0]?.is_pending === true;
};

// specs/colaboradores.md §6, "Convites pendentes": 24 per page, created_at ascending. The route
// only declares this default and the order; `resolvePagination` owns the ceiling and the offset.
const PENDING_INVITATIONS_DEFAULT_PAGE_SIZE = 24;

interface PendingInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly purpose: InvitationLookup['purpose'];
  readonly role_key: string | null;
  readonly role_name: string | null;
  readonly client_name: string | null;
  readonly created_at: string | Date;
  readonly expires_at: string | Date;
  readonly total: string | number;
}

// Shared by the page query and its empty-page count fallback so the two filters cannot drift.
const PENDING_COLLABORATOR_INVITATION_FILTER = `
        invitation.agency_id = ?::uuid
        and invitation.purpose = 'collaborator_invite'
        and invitation.used_at is null
        and invitation.revoked_at is null
        and invitation.expires_at > now()`;

interface PendingInvitationPage {
  readonly items: readonly PendingInvitationRow[];
  readonly totalItems: number;
}

const invitationFromLookupRow = (row: InvitationLookupRow): InvitationLookup => ({
  id: row.id,
  purpose: row.purpose,
  email: row.email,
  agencyId: row.agency_id,
  agencyName: row.agency_name,
  clientId: row.client_id,
  clientName: row.client_name,
  roleId: row.role_id,
  valid: row.valid === true
});

/**
 * Reads the security-definer token function without an authenticated user context. The function
 * deliberately returns a row for an expired/revoked token, but callers must inspect `valid` and
 * never disclose account existence for an invalid link.
 */
export const createInvitationTokenLookup = (database: DatabaseClient): InvitationTokenLookup => async (token) => {
  const tokenHash = hashInvitationToken(token);
  return database.transaction(async (transaction) => {
    const result = await raw<RawRows<InvitationLookupRow>>(transaction, 'select * from app_private.invitation_by_token_hash(?)', [tokenHash]);
    const row = result.rows[0];
    return row === undefined ? undefined : invitationFromLookupRow(row);
  });
};

const lookupOrInvalid = async (lookup: InvitationTokenLookup, token: string): Promise<InvitationLookup> => {
  const row = await lookup(token);
  if (row === undefined || !row.valid) throw new HttpError(INVITATION_INVALID);
  return row;
};

const invitationExpiresInMinutes = (expiresAt: Date): number => Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60_000));

const auditInTransaction = async (
  transaction: InvitationTransaction,
  event: { readonly action: string; readonly actorUserId: string; readonly agencyId: string; readonly targetId: string }
): Promise<void> => {
  await raw(transaction, `
    insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
    values (?, ?, ?, 'invitation', ?)
  `, [event.action, event.actorUserId, event.agencyId, event.targetId]);
};

const tokenForInsert = (appPublicUrl: string): InvitationToken => createInvitationToken({ appPublicUrl });

const agencyInvitationDetails = async (transaction: InvitationTransaction, agencyId: string): Promise<{ agencyName: string } | undefined> => {
  const result = await raw<RawRows<{ agency_name: string }>>(transaction, `
    select name as agency_name from public.agencies where id = ?::uuid and status = 'active'
  `, [agencyId]);
  const row = result.rows[0];
  return row === undefined ? undefined : { agencyName: row.agency_name };
};

const createCollaboratorInvitation = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  email: string,
  roleId: string,
  agencyId: string
): Promise<{ invitationId: string; expiresAt: Date; token: InvitationToken; agencyName: string; supersededInvitationId: string | null }> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  const tenant = request.tenant;
  if (tenant === undefined) throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });
  const token = tokenForInsert(dependencies.config.appPublicUrl);
  try {
  return await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const roleResult = await raw<RawRows<{ id: string; is_admin: boolean }>>(transaction, `
        select id, app_private.is_admin_role(id, ?::uuid) as is_admin
        from public.roles where id = ?::uuid and (agency_id is null or agency_id = ?::uuid)
      `, [agencyId, roleId, agencyId]);
      const role = roleResult.rows[0];
      if (role === undefined) throw invalidRole();
      if (role.is_admin === true && !tenantHolds(tenant, GRANT_ADMIN_PERMISSION)) throw adminGrantForbidden();

      const agency = await agencyInvitationDetails(transaction, agencyId);
      if (agency === undefined) throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

      const memberResult = await raw<RawRows<{ id: string }>>(transaction, `
        select membership.id
        from public.agency_memberships membership
        join auth."user" invited_user on invited_user.id = membership.user_id
        where membership.agency_id = ?::uuid and membership.status = 'active' and invited_user.email = ?
        limit 1
      `, [agencyId, email]);
      if (memberResult.rows[0] !== undefined) throw membershipExists();

      await lockPendingInvitationSlot(transaction, agencyId, 'collaborator_invite', email, null);
      const revoked = await raw<RawRows<{ id: string }>>(transaction, `
        update public.invitations
           set revoked_at = now()
         where agency_id = ?::uuid and purpose = 'collaborator_invite' and email = ?
           and used_at is null and revoked_at is null
        returning id
      `, [agencyId, email]);
      for (const old of revoked.rows) {
        await auditInTransaction(transaction, { action: 'invitation.revoked', actorUserId: auth.userId, agencyId, targetId: old.id });
      }
      // At most one equivalent pending invitation exists (the partial unique index guarantees it),
      // and the revoking UPDATE is scoped to this agency, so the id can only be this agency's.
      const supersededInvitationId = revoked.rows[0]?.id ?? null;

      const result = await raw<RawRows<{ id: string; expires_at: Date }>>(transaction, `
        insert into public.invitations
          (agency_id, purpose, email, role_id, token_hash, expires_at, invited_by_user_id)
        values (?, 'collaborator_invite', ?, ?, ?, ?, ?)
        returning id, expires_at
      `, [agencyId, email, roleId, token.tokenHash, token.expiresAt, auth.userId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('Invitation insert did not return a row.');
      await auditInTransaction(transaction, { action: 'invitation.sent', actorUserId: auth.userId, agencyId, targetId: row.id });
      return { invitationId: row.id, expiresAt: new Date(row.expires_at), token, agencyName: agency.agencyName, supersededInvitationId };
    });
  } catch (error) {
    if (isInsufficientPrivilegeError(error)) throw forbidden();
    if (error instanceof HttpError || !isDuplicateUserError(error)) throw error;
    throw new Error('Invitation could not be created.', { cause: error });
  }
};

const createClientInvitation = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  email: string,
  agencyId: string,
  clientId: string
): Promise<{ invitationId: string; expiresAt: Date; token: InvitationToken; agencyName: string; clientName: string }> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  const token = tokenForInsert(dependencies.config.appPublicUrl);
  return withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    const clientResult = await raw<RawRows<{ client_name: string; agency_name: string }>>(transaction, `
      select client.name as client_name, agency.name as agency_name
      from public.clients client
      join public.agencies agency on agency.id = client.agency_id
      where client.id = ?::uuid and client.agency_id = ?::uuid
        and client.status = 'active' and agency.status = 'active'
    `, [clientId, agencyId]);
    const client = clientResult.rows[0];
    if (client === undefined) throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });

    const memberResult = await raw<RawRows<{ id: string }>>(transaction, `
      select membership.id
      from public.client_memberships membership
      join auth."user" invited_user on invited_user.id = membership.user_id
      where membership.client_id = ?::uuid and membership.status = 'active' and invited_user.email = ?
      limit 1
    `, [clientId, email]);
    if (memberResult.rows[0] !== undefined) throw membershipExists();

    await lockPendingInvitationSlot(transaction, agencyId, 'client_invite', email, clientId);
    const revoked = await raw<RawRows<{ id: string }>>(transaction, `
      update public.invitations
         set revoked_at = now()
       where agency_id = ?::uuid and purpose = 'client_invite' and email = ? and client_id = ?::uuid
         and used_at is null and revoked_at is null
      returning id
    `, [agencyId, email, clientId]);
    for (const old of revoked.rows) {
      await auditInTransaction(transaction, { action: 'invitation.revoked', actorUserId: auth.userId, agencyId, targetId: old.id });
    }

    const result = await raw<RawRows<{ id: string; expires_at: Date }>>(transaction, `
      insert into public.invitations
        (agency_id, purpose, email, client_id, token_hash, expires_at, invited_by_user_id)
      values (?, 'client_invite', ?, ?, ?, ?, ?)
      returning id, expires_at
    `, [agencyId, email, clientId, token.tokenHash, token.expiresAt, auth.userId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Invitation insert did not return a row.');
    await auditInTransaction(transaction, { action: 'invitation.sent', actorUserId: auth.userId, agencyId, targetId: row.id });
    return {
      invitationId: row.id,
      expiresAt: new Date(row.expires_at),
      token,
      agencyName: client.agency_name,
      clientName: client.client_name
    };
  });
};

const resendInvitation = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  agencyId: string,
  invitationId: string
): Promise<{ invitationId: string; expiresAt: Date; token: InvitationToken; agencyName: string; clientName: string | null; purpose: InvitationLookup['purpose']; email: string }> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  const tenant = request.tenant;
  if (tenant === undefined) throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });
  const token = tokenForInsert(dependencies.config.appPublicUrl);
  return withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    // The row is locked first; pendingness is a second statement, after the lock wait (issue #304).
    const currentResult = await raw<RawRows<InvitationRow>>(transaction, `
      select invitation.id, invitation.purpose, invitation.email, invitation.agency_id, agency.name as agency_name,
             invitation.client_id, client.name as client_name, invitation.role_id
      from public.invitations invitation
      join public.agencies agency on agency.id = invitation.agency_id
      left join public.clients client on client.id = invitation.client_id
      where invitation.id = ?::uuid and invitation.agency_id = ?::uuid
      for update of invitation
    `, [invitationId, agencyId]);
    const current = currentResult.rows[0];
    if (current === undefined || current.purpose === 'agency_activation') throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
    // A resend inserts a new invitation, so it hands the role out again: `invitations_insert` refuses
    // an admin one to anyone without the grant, and without this check that refusal is a 500.
    if (current.role_id !== null && !tenantHolds(tenant, GRANT_ADMIN_PERMISSION)) {
      const adminResult = await raw<RawRows<{ is_admin: boolean }>>(transaction, `
        select app_private.is_admin_role(?::uuid, ?::uuid) as is_admin
      `, [current.role_id, agencyId]);
      if (adminResult.rows[0]?.is_admin === true) throw adminGrantForbidden();
    }
    // Slot lock before the pendingness read: an invitation that expires while waiting for it must
    // not be resent (issue #304 review).
    await lockPendingInvitationSlot(transaction, agencyId, current.purpose, current.email, current.client_id);
    if (!(await isInvitationPending(transaction, agencyId, invitationId))) throw invitationNotPending();
    const revoked = await raw<RawRows<{ id: string }>>(transaction, `
      update public.invitations set revoked_at = now() where id = ?::uuid returning id
    `, [invitationId]);
    // A silently filtered UPDATE would otherwise report success while the invitation stays live.
    if (revoked.rows[0] === undefined) throw invitationNotPending();
    await auditInTransaction(transaction, { action: 'invitation.revoked', actorUserId: auth.userId, agencyId, targetId: invitationId });
    const inserted = await raw<RawRows<{ id: string; expires_at: Date }>>(transaction, `
      insert into public.invitations
        (agency_id, purpose, email, role_id, client_id, token_hash, expires_at, invited_by_user_id)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      returning id, expires_at
      `, [agencyId, current.purpose, current.email, current.role_id, current.client_id, token.tokenHash, token.expiresAt, auth.userId]);
    const next = inserted.rows[0];
    if (next === undefined) throw new Error('Invitation insert did not return a row.');
    await auditInTransaction(transaction, { action: 'invitation.resent', actorUserId: auth.userId, agencyId, targetId: next.id });
    return {
      invitationId: next.id,
      expiresAt: new Date(next.expires_at),
      token,
      agencyName: current.agency_name,
      clientName: current.client_name,
      purpose: current.purpose,
      email: current.email
    };
  }).catch((error: unknown) => {
    if (isInsufficientPrivilegeError(error)) throw forbidden();
    throw error;
  });
};

const cancelInvitation = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  agencyId: string,
  invitationId: string
): Promise<void> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    // Same two-step pendingness rule as the resend: lock the row, then read the clock after the
    // wait (issue #304).
    const currentResult = await raw<RawRows<Pick<InvitationRow, 'id' | 'purpose'>>>(transaction, `
      select id, purpose
      from public.invitations
      where id = ?::uuid and agency_id = ?::uuid
      for update
    `, [invitationId, agencyId]);
    const current = currentResult.rows[0];
    if (current === undefined || current.purpose === 'agency_activation') throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
    if (!(await isInvitationPending(transaction, agencyId, invitationId))) throw invitationNotPending();
    const revoked = await raw<RawRows<{ id: string }>>(transaction, `
      update public.invitations set revoked_at = now() where id = ?::uuid returning id
    `, [invitationId]);
    // A silently filtered UPDATE would otherwise report 204 while the invitation stays live.
    if (revoked.rows[0] === undefined) throw invitationNotPending();
    await auditInTransaction(transaction, { action: 'invitation.revoked', actorUserId: auth.userId, agencyId, targetId: invitationId });
  });
};

const acceptInvitation = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  token: string,
  recordAcceptance: boolean
): Promise<{ status: 'accepted' | 'already_member'; context: { agencyId: string; clientId: string | null } }> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  const result = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    const rows = await raw<RawRows<AcceptInvitationRow>>(transaction, `
      select * from app_private.accept_invitation(?, ?, ?, ?, ?)
    `, [
      hashInvitationToken(token),
      auth.userId,
      dependencies.config.authTermsVersion,
      dependencies.config.authPrivacyVersion,
      recordAcceptance
    ]);
    return rows.rows[0];
  }).catch((error: unknown) => {
    // The security-definer function uses private PostgreSQL error codes for invalid links. Its
    // message is intentionally discarded so every invalid state has one public response.
    if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code?: unknown }).code).startsWith('A')) {
      throw new HttpError(INVITATION_INVALID);
    }
    throw error;
  });
  if (result === undefined) throw new HttpError(INVITATION_INVALID);
  return { status: result.status, context: { agencyId: result.agency_id, clientId: result.client_id } };
};

/**
 * Lists pending collaborator invitations for one agency, paginated per the shared list contract
 * (`packages/contracts/src/pagination.ts`). Scoped to `purpose = 'collaborator_invite'` even
 * though `invitations_select` also grants `cliente.convidar_usuario` holders read access to this
 * table: the RLS policy is shared across invitation types, so the type filter has to live here,
 * in the query, and not in the guard (docs/business/structural-changes.md, "Permissões de convite
 * compartilhadas entre tipos"). Never selects `token_hash`.
 */
const listPendingCollaboratorInvitations = async (
  dependencies: InvitationModuleDependencies,
  request: FastifyRequest,
  agencyId: string,
  pagination: ResolvedPagination
): Promise<PendingInvitationPage> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    // `count(*) over ()` rides the page query's own snapshot, so the counter and the list cannot
    // describe two different states of the table (issue #165). The separate count only runs for an
    // empty page past the first, where `totalItems` is allowed to exceed the empty `data` anyway.
    const itemsResult = await raw<RawRows<PendingInvitationRow>>(transaction, `
      select
        invitation.id,
        invitation.email,
        invitation.purpose,
        role.key as role_key,
        role.name as role_name,
        client.name as client_name,
        invitation.created_at,
        invitation.expires_at,
        count(*) over () as total
      from public.invitations invitation
      left join public.roles role on role.id = invitation.role_id
      left join public.clients client on client.id = invitation.client_id
      where ${PENDING_COLLABORATOR_INVITATION_FILTER}
      order by invitation.created_at asc, invitation.id asc
      limit ? offset ?
    `, [agencyId, pagination.pageSize, pagination.offset]);
    if (itemsResult.rows.length > 0) {
      return { items: itemsResult.rows, totalItems: Number(itemsResult.rows[0]?.total ?? 0) };
    }
    // An empty first page is the whole truth: no row exists before it, so a second count could
    // only answer from another snapshot and show `data: []` with `totalItems: 1` (issue #304).
    if (pagination.offset === 0) {
      return { items: itemsResult.rows, totalItems: 0 };
    }

    const countResult = await raw<RawRows<{ total: string | number }>>(transaction, `
      select count(*) as total
      from public.invitations invitation
      where ${PENDING_COLLABORATOR_INVITATION_FILTER}
    `, [agencyId]);
    return { items: itemsResult.rows, totalItems: Number(countResult.rows[0]?.total ?? 0) };
  });
};

/**
 * `PendingInvitationSchema` pins `purpose` to the literal and requires `role`; a row that violated
 * the query's own `purpose = 'collaborator_invite'` filter -- an activation invite with no role, or
 * a client invite -- fails to parse here instead of being served. That is deliberate: this endpoint
 * only ever sees rows the `invitations_purpose_fields_check` constraint guarantees have both.
 */
const pendingInvitationFromRow = (row: PendingInvitationRow) => ({
  id: row.id,
  email: row.email,
  purpose: row.purpose,
  role: row.role_key === null || row.role_name === null ? null : { key: row.role_key, name: row.role_name },
  client: null,
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString()
});

/** Registers authenticated administration and public invitation routes. */
export const registerInvitationModule = (app: FastifyInstance, dependencies: InvitationModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const lookup = dependencies.invitationTokenLookup ?? createInvitationTokenLookup(dependencies.database);
  const invitationRateLimit = {
    rateLimit: { max: AUTH_RATE_LIMITS.invitation.authenticatedIp.max, timeWindow: AUTH_RATE_LIMITS.invitation.authenticatedIp.windowMs, addHeaders: false }
  };
  const publicRateLimit = {
    rateLimit: { max: AUTH_RATE_LIMITS.invitation.publicIp.max, timeWindow: AUTH_RATE_LIMITS.invitation.publicIp.windowMs, addHeaders: false }
  };
  const docsConfig = (docs: DocumentedRouteConfig): Record<string, unknown> => ({
    permission: docs.permission,
    responseStatus: docs.responseStatus,
    schemas: docs.schemas
  });
  const authenticated = (docs: DocumentedRouteConfig & { permission: string }): { preHandler: InvitationPreHandler[]; config: object } => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { ...invitationRateLimit, permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });
  const publicConfig = (docs: DocumentedRouteConfig) => ({ config: { ...publicRateLimit, ...docsConfig(docs) } });

  // Declared once per route: the same object is the route's documentation metadata and the source
  // of the schemas the handler validates with, so a handler cannot drift from what is documented.
  const listDocs = {
    permission: 'colaborador.convidar',
    responseStatus: 200,
    schemas: { params: AgencyPathParamsSchema, query: PaginationInputSchema, response: PendingInvitationListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const collaboratorDocs = {
    permission: 'colaborador.convidar',
    responseStatus: 201,
    schemas: { params: AgencyPathParamsSchema, body: CollaboratorInvitationRequestSchema, response: CollaboratorInvitationCreatedResponseSchema }
  } satisfies DocumentedRouteConfig;
  const clientInviteDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: ClientInvitationRequestSchema, response: InvitationCreatedResponseSchema }
  } satisfies DocumentedRouteConfig;
  const resendDocs = {
    permission: 'convite.reenviar',
    responseStatus: 200,
    schemas: { params: AgencyInvitationPathParamsSchema, response: InvitationCreatedResponseSchema }
  } satisfies DocumentedRouteConfig;
  const cancelDocs = {
    permission: 'convite.cancelar',
    responseStatus: 204,
    schemas: { params: AgencyInvitationPathParamsSchema }
  } satisfies DocumentedRouteConfig;
  const previewDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PublicInvitationTokenPathParamsSchema, response: InvitationPreviewResponseSchema }
  } satisfies DocumentedRouteConfig;
  const acceptNewAccountDocs = {
    permission: null,
    responseStatus: 201,
    schemas: { params: PublicInvitationTokenPathParamsSchema, body: InvitationAcceptNewAccountRequestSchema, response: InvitationAcceptNewAccountResponseSchema }
  } satisfies DocumentedRouteConfig;
  const acceptDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PublicInvitationTokenPathParamsSchema, body: InvitationAcceptRequestSchema, response: InvitationAcceptResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/invitations', authenticated(listDocs), async (request) => {
    const params = routeParams(listDocs, request);
    const query = routeQuery(listDocs, request);
    const pagination = resolvePagination(query, PENDING_INVITATIONS_DEFAULT_PAGE_SIZE);
    const { items, totalItems } = await listPendingCollaboratorInvitations(dependencies, request, params.agencyId, pagination);
    return routeResponse(listDocs, request, {
      data: items.map(pendingInvitationFromRow),
      meta: buildPaginationMetadata(pagination, totalItems)
    });
  });

  app.post('/agencies/:agencyId/invitations/collaborators', authenticated(collaboratorDocs), async (request, reply) => {
    const params = routeParams(collaboratorDocs, request);
    const body = routeBody(collaboratorDocs, request);
    const result = await createCollaboratorInvitation(dependencies, request, body.email, body.roleId, params.agencyId);
    try {
      await dependencies.emailService.sendCollaboratorInvitation({
        to: body.email,
        actionUrl: result.token.actionUrl,
        expiresInMinutes: invitationExpiresInMinutes(result.expiresAt),
        agencyName: result.agencyName
      });
    } catch {
      throw emailDeliveryFailed();
    }
    return reply.status(201).send(routeResponse(collaboratorDocs, request, {
      invitationId: result.invitationId,
      expiresAt: result.expiresAt.toISOString(),
      supersededInvitationId: result.supersededInvitationId
    }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/invitations', authenticated(clientInviteDocs), async (request, reply) => {
    const params = routeParams(clientInviteDocs, request);
    const body = routeBody(clientInviteDocs, request);
    const result = await createClientInvitation(dependencies, request, body.email, params.agencyId, params.clientId);
    try {
      await dependencies.emailService.sendClientInvitation({
        to: body.email,
        actionUrl: result.token.actionUrl,
        expiresInMinutes: invitationExpiresInMinutes(result.expiresAt),
        agencyName: result.agencyName,
        clientName: result.clientName
      });
    } catch {
      throw emailDeliveryFailed();
    }
    return reply.status(201).send(routeResponse(clientInviteDocs, request, { invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() }));
  });

  app.post('/agencies/:agencyId/invitations/:invitationId/resend', authenticated(resendDocs), async (request, reply) => {
    const params = routeParams(resendDocs, request);
    const result = await resendInvitation(dependencies, request, params.agencyId, params.invitationId);
    try {
      if (result.purpose === 'client_invite' && result.clientName !== null) {
        await dependencies.emailService.sendClientInvitation({
          to: result.email,
          actionUrl: result.token.actionUrl,
          expiresInMinutes: invitationExpiresInMinutes(result.expiresAt),
          agencyName: result.agencyName,
          clientName: result.clientName
        });
      } else {
        await dependencies.emailService.sendCollaboratorInvitation({
          to: result.email,
          actionUrl: result.token.actionUrl,
          expiresInMinutes: invitationExpiresInMinutes(result.expiresAt),
          agencyName: result.agencyName
        });
      }
    } catch {
      throw emailDeliveryFailed();
    }
    return reply.send(routeResponse(resendDocs, request, { invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() }));
  });

  app.delete('/agencies/:agencyId/invitations/:invitationId', authenticated(cancelDocs), async (request, reply) => {
    const params = routeParams(cancelDocs, request);
    await cancelInvitation(dependencies, request, params.agencyId, params.invitationId);
    return reply.status(204).send();
  });

  app.get('/invitations/:token', publicConfig(previewDocs), async (request) => {
    const { token } = routeParams(previewDocs, request);
    const row = await lookupOrInvalid(lookup, token);
    const accountResult = await dependencies.database.transaction(async (transaction) =>
      raw<RawRows<{ exists: boolean }>>(transaction, 'select exists(select 1 from auth."user" where email = ?) as exists', [row.email])
    );
    return routeResponse(previewDocs, request, {
      purpose: row.purpose,
      email: row.email,
      agency: { name: row.agencyName },
      client: row.clientName === null ? null : { name: row.clientName },
      accountExists: accountResult.rows[0]?.exists === true
    });
  });

  app.post('/invitations/:token/accept-new-account', publicConfig(acceptNewAccountDocs), async (request, reply) => {
    const { token } = routeParams(acceptNewAccountDocs, request);
    const body = routeBody(acceptNewAccountDocs, request);
    const invitation = await lookupOrInvalid(lookup, token);
    const existing = await dependencies.database.transaction(async (transaction) =>
      raw<RawRows<{ id: string }>>(transaction, 'select id from auth."user" where email = ? limit 1', [invitation.email])
    );
    if (existing.rows[0] !== undefined) throw accountExists();

    const passwordHash = await (await dependencies.auth.$context).password.hash(body.password);
    const userId = randomUUID();
    try {
      await dependencies.database.transaction(async (transaction) => {
        await raw(transaction, `
          insert into auth."user" (id, name, email, "emailVerified") values (?, ?, ?, true)
        `, [userId, body.name, invitation.email]);
        await raw(transaction, `
          insert into auth."account" (id, "accountId", "providerId", "userId", password, "updatedAt")
          values (?, ?, 'credential', ?, ?, now())
        `, [randomUUID(), userId, userId, passwordHash]);
        const result = await raw<RawRows<AcceptInvitationRow>>(transaction, `
          select * from app_private.accept_invitation(?, ?, ?, ?, true)
        `, [hashInvitationToken(token), userId, dependencies.config.authTermsVersion, dependencies.config.authPrivacyVersion]);
        if (result.rows[0] === undefined) throw new HttpError(INVITATION_INVALID);
      });
    } catch (error) {
      if (isDuplicateUserError(error)) throw accountExists();
      if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code?: unknown }).code).startsWith('A')) throw new HttpError(INVITATION_INVALID);
      throw error;
    }

    try {
      const { headers } = await dependencies.auth.api.signInEmail({
        body: { email: invitation.email, password: body.password },
        headers: toAuthHeaders(request),
        returnHeaders: true
      });
      applyAuthCookies(reply, headers);
    } catch {
      // Account creation and invitation acceptance have already committed, but the API contract
      // promises a session cookie for this flow. Return only a generic server error if Better Auth
      // cannot establish that session; the credential account remains recoverable through login.
      throw new HttpError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
    return reply.status(201).send(routeResponse(acceptNewAccountDocs, request, {
      status: 'accepted',
      context: { agencyId: invitation.agencyId, clientId: invitation.clientId }
    }));
  });

  app.post('/invitations/:token/accept', {
    ...publicConfig(acceptDocs),
    preHandler: requireSession
  }, async (request, reply) => {
    const { token } = routeParams(acceptDocs, request);
    routeBody(acceptDocs, request);
    if (request.auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
    const invitation = await lookupOrInvalid(lookup, token);
    if (invitation.email !== request.auth.user.email) throw accountMismatch();
    const result = await acceptInvitation(dependencies, request, token, false);
    return reply.send(routeResponse(acceptDocs, request, result));
  });
};
