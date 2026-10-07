import {
  EmailChangeConfirmRequestSchema,
  EmailChangeConfirmResponseSchema,
  EmailChangeRequestResponseSchema,
  EmailChangeRequestSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import type { EmailService } from '../auth/email-service.js';
import { createRequireSession } from '../auth/session-guard.js';
import { hashInvitationToken } from '../invitations/tokens.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import { EMAIL_CHANGE_CONFIRM_RATE_LIMIT, EMAIL_CHANGE_REQUEST_RATE_LIMIT } from './policy.js';
import {
  confirmEmailChange,
  databaseErrorCode,
  EMAIL_CHANGE_ERRORS,
  isRetryableConflict,
  loadCredentialHash,
  requestEmailChange
} from './service.js';

export interface EmailChangeModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly emailService: EmailService;
}

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return auth;
};

/** 403, not 401: a 401 means "the session ended" to the web client and would log the person out. */
const invalidPassword = (): HttpError =>
  new HttpError({ statusCode: 403, code: 'INVALID_PASSWORD', message: 'A senha atual não confere.' });
const sameAddress = (): HttpError =>
  new HttpError({ statusCode: 400, code: 'SAME_EMAIL', message: 'Informe um e-mail diferente do atual.' });
/** A lost race, never a 500 and never any detail of what raced: repeating the call is the answer. */
const tryAgain = (): HttpError =>
  new HttpError({ statusCode: 409, code: 'TRY_AGAIN', message: 'Houve um conflito momentâneo. Tente de novo.' });
const invalidLink = (): HttpError =>
  new HttpError({ statusCode: 400, code: 'INVALID_LINK', message: 'Este link não é mais válido.' });

/**
 * Registers the account e-mail change routes (issue #80): `POST /me/email-change` asks for it and
 * `POST /email-change/confirm` spends the link the operation's approval sent to the new address.
 *
 * Approving is not an API route: the operation uses `cli:email-change`, the way an agency is
 * created, so there is no administration surface to attack. The request names only the new address
 * and the current password; the account is always the session's.
 *
 * The answer to a request is the same whether or not another account already uses the address (202
 * with an empty body, and the notice to the current address goes out either way), so the route is
 * never an oracle for which e-mails have an account. The collision is checked again when the
 * operation approves and when the link is spent, and the link then answers like any dead link.
 */
export const registerEmailChangeModule = (app: FastifyInstance, dependencies: EmailChangeModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const requestDocs = {
    permission: null,
    responseStatus: 202,
    schemas: { body: EmailChangeRequestSchema, response: EmailChangeRequestResponseSchema }
  } satisfies DocumentedRouteConfig;
  const confirmDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { body: EmailChangeConfirmRequestSchema, response: EmailChangeConfirmResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.post('/me/email-change', {
    preHandler: requireSession,
    config: {
      ...requestDocs,
      // After `requireSession`, so `request.auth` is populated when the key is read.
      rateLimit: {
        max: EMAIL_CHANGE_REQUEST_RATE_LIMIT.max,
        timeWindow: EMAIL_CHANGE_REQUEST_RATE_LIMIT.windowMs,
        hook: 'preHandler' as const,
        keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip
      }
    }
  }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = routeBody(requestDocs, request);

    const hash = await dependencies.database.transaction((transaction) => loadCredentialHash(transaction, auth.userId));
    const verified = hash !== undefined
      && await (await dependencies.auth.$context).password.verify({ hash, password: body.currentPassword });
    if (!verified) throw invalidPassword();

    let recorded: Awaited<ReturnType<typeof requestEmailChange>>;
    try {
      recorded = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        requestEmailChange(transaction, body.newEmail)
      );
    } catch (error) {
      if (databaseErrorCode(error) === EMAIL_CHANGE_ERRORS.sameAddress) throw sameAddress();
      if (isRetryableConflict(error)) throw tryAgain();
      throw error;
    }

    dependencies.emailService.sendEmailChangeRequested({ to: recorded.previousEmail });
    return reply.status(202).send(routeResponse(requestDocs, request, {}));
  });

  app.post('/email-change/confirm', {
    config: {
      ...confirmDocs,
      rateLimit: { max: EMAIL_CHANGE_CONFIRM_RATE_LIMIT.max, timeWindow: EMAIL_CHANGE_CONFIRM_RATE_LIMIT.windowMs }
    }
  }, async (request, reply) => {
    const body = routeBody(confirmDocs, request);

    let confirmed: Awaited<ReturnType<typeof confirmEmailChange>>;
    try {
      confirmed = await dependencies.database.transaction((transaction) =>
        confirmEmailChange(transaction, hashInvitationToken(body.token))
      );
    } catch (error) {
      // One public answer for every reason the link cannot swap the address.
      if (databaseErrorCode(error) === EMAIL_CHANGE_ERRORS.invalidLink) throw invalidLink();
      if (isRetryableConflict(error)) throw tryAgain();
      throw error;
    }

    dependencies.emailService.sendEmailChanged({ to: confirmed.previousEmail });
    return reply.send(routeResponse(confirmDocs, request, {}));
  });
};
