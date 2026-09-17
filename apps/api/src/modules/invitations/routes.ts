import { randomUUID } from 'node:crypto';

import {
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptResponseSchema,
  InvitationPreviewResponseSchema,
  AuthEmailSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import {
  createInvitationToken,
  hashInvitationToken,
  type InvitationToken
} from './tokens.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuthAuditRecorder } from '../auth/audit.js';
import type { AuthInstance } from '../auth/better-auth.js';
import { applyAuthCookies, toAuthHeaders } from '../auth/bridge.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { EmailService } from '../auth/email-service.js';
import { AUTH_RATE_LIMITS } from '../auth/policy.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';

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
  readonly expires_at: string | Date;
  readonly used_at: string | Date | null;
  readonly revoked_at: string | Date | null;
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

const agencyParamsSchema = z.object({ agencyId: z.string().uuid() }).strict();
const agencyInvitationParamsSchema = z.object({
  agencyId: z.string().uuid(),
  invitationId: z.string().uuid()
}).strict();
const clientInvitationParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid()
}).strict();
const publicInvitationParamsSchema = z.object({ token: z.string().min(1).max(2_048) }).strict();
const collaboratorBodySchema = z.object({
  email: AuthEmailSchema,
  roleId: z.string().uuid()
}).strict();
const clientBodySchema = z.object({ email: AuthEmailSchema }).strict();

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

const routeParams = <T>(schema: z.ZodType<T>, request: FastifyRequest): T => parseRequest(schema, request.params);

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
): Promise<{ invitationId: string; expiresAt: Date; token: InvitationToken; agencyName: string }> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  const token = tokenForInsert(dependencies.config.appPublicUrl);
  try {
  return await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const roleResult = await raw<RawRows<{ id: string }>>(transaction, `
        select id from public.roles where id = ?::uuid and (agency_id is null or agency_id = ?::uuid)
      `, [roleId, agencyId]);
      if (roleResult.rows[0] === undefined) throw invalidRole();

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

      const result = await raw<RawRows<{ id: string; expires_at: Date }>>(transaction, `
        insert into public.invitations
          (agency_id, purpose, email, role_id, token_hash, expires_at, invited_by_user_id)
        values (?, 'collaborator_invite', ?, ?, ?, ?, ?)
        returning id, expires_at
      `, [agencyId, email, roleId, token.tokenHash, token.expiresAt, auth.userId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('Invitation insert did not return a row.');
      await auditInTransaction(transaction, { action: 'invitation.sent', actorUserId: auth.userId, agencyId, targetId: row.id });
      return { invitationId: row.id, expiresAt: new Date(row.expires_at), token, agencyName: agency.agencyName };
    });
  } catch (error) {
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
  const token = tokenForInsert(dependencies.config.appPublicUrl);
  return withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
    const currentResult = await raw<RawRows<InvitationRow>>(transaction, `
      select invitation.id, invitation.purpose, invitation.email, invitation.agency_id, agency.name as agency_name,
             invitation.client_id, client.name as client_name, invitation.role_id,
             invitation.expires_at, invitation.used_at, invitation.revoked_at
      from public.invitations invitation
      join public.agencies agency on agency.id = invitation.agency_id
      left join public.clients client on client.id = invitation.client_id
      where invitation.id = ?::uuid and invitation.agency_id = ?::uuid
      for update of invitation
    `, [invitationId, agencyId]);
    const current = currentResult.rows[0];
    if (current === undefined || current.purpose === 'agency_activation') throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
    if (current.used_at !== null || current.revoked_at !== null || new Date(current.expires_at).getTime() <= Date.now()) throw invitationNotPending();

    await raw(transaction, `update public.invitations set revoked_at = now() where id = ?::uuid`, [invitationId]);
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
    const currentResult = await raw<RawRows<Pick<InvitationRow, 'id' | 'purpose' | 'used_at' | 'revoked_at' | 'expires_at'>>>(transaction, `
      select id, purpose, used_at, revoked_at, expires_at
      from public.invitations
      where id = ?::uuid and agency_id = ?::uuid
      for update
    `, [invitationId, agencyId]);
    const current = currentResult.rows[0];
    if (current === undefined || current.purpose === 'agency_activation') throw new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
    if (current.used_at !== null || current.revoked_at !== null || new Date(current.expires_at).getTime() <= Date.now()) throw invitationNotPending();
    await raw(transaction, 'update public.invitations set revoked_at = now() where id = ?::uuid', [invitationId]);
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

/** Registers authenticated administration and public invitation routes. */
export const registerInvitationModule = (app: FastifyInstance, dependencies: InvitationModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const lookup = dependencies.invitationTokenLookup ?? createInvitationTokenLookup(dependencies.database);
  const authenticated = (permission: string): { preHandler: InvitationPreHandler[]; config: object } => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(permission)],
    config: { rateLimit: { max: AUTH_RATE_LIMITS.invitation.authenticatedIp.max, timeWindow: AUTH_RATE_LIMITS.invitation.authenticatedIp.windowMs, addHeaders: false } }
  });
  const publicConfig = { config: { rateLimit: { max: AUTH_RATE_LIMITS.invitation.publicIp.max, timeWindow: AUTH_RATE_LIMITS.invitation.publicIp.windowMs, addHeaders: false } } };

  app.post('/agencies/:agencyId/invitations/collaborators', authenticated('colaborador.convidar'), async (request, reply) => {
    const params = routeParams(agencyParamsSchema, request);
    const body = parseRequest(collaboratorBodySchema, request.body);
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
    return reply.status(201).send({ invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() });
  });

  app.post('/agencies/:agencyId/clients/:clientId/invitations', authenticated('cliente.convidar_usuario'), async (request, reply) => {
    const params = routeParams(clientInvitationParamsSchema, request);
    const body = parseRequest(clientBodySchema, request.body);
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
    return reply.status(201).send({ invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() });
  });

  app.post('/agencies/:agencyId/invitations/:invitationId/resend', authenticated('convite.reenviar'), async (request, reply) => {
    const params = routeParams(agencyInvitationParamsSchema, request);
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
    return reply.send({ invitationId: result.invitationId, expiresAt: result.expiresAt.toISOString() });
  });

  app.delete('/agencies/:agencyId/invitations/:invitationId', authenticated('convite.cancelar'), async (request, reply) => {
    const params = routeParams(agencyInvitationParamsSchema, request);
    await cancelInvitation(dependencies, request, params.agencyId, params.invitationId);
    return reply.status(204).send();
  });

  app.get('/invitations/:token', publicConfig, async (request) => {
    const { token } = routeParams(publicInvitationParamsSchema, request);
    const row = await lookupOrInvalid(lookup, token);
    const accountResult = await dependencies.database.transaction(async (transaction) =>
      raw<RawRows<{ exists: boolean }>>(transaction, 'select exists(select 1 from auth."user" where email = ?) as exists', [row.email])
    );
    return parseResponse(InvitationPreviewResponseSchema, {
      purpose: row.purpose,
      email: row.email,
      agency: { name: row.agencyName },
      client: row.clientName === null ? null : { name: row.clientName },
      accountExists: accountResult.rows[0]?.exists === true
    });
  });

  app.post('/invitations/:token/accept-new-account', publicConfig, async (request, reply) => {
    const { token } = routeParams(publicInvitationParamsSchema, request);
    const body = parseRequest(InvitationAcceptNewAccountRequestSchema, request.body);
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
    return reply.status(201).send(parseResponse(InvitationAcceptNewAccountResponseSchema, {
      status: 'accepted',
      context: { agencyId: invitation.agencyId, clientId: invitation.clientId }
    }));
  });

  app.post('/invitations/:token/accept', { ...publicConfig, preHandler: requireSession }, async (request, reply) => {
    const { token } = routeParams(publicInvitationParamsSchema, request);
    if (request.auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
    const invitation = await lookupOrInvalid(lookup, token);
    if (invitation.email !== request.auth.user.email) throw accountMismatch();
    const result = await acceptInvitation(dependencies, request, token, false);
    return reply.send(parseResponse(InvitationAcceptResponseSchema, result));
  });
};
