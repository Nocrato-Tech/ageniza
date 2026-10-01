import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiErrorResponseSchema } from '@ageniza/contracts';
import { loggableRoute } from './route.js';
import { captureUnexpectedError, CORRELATION_ID_HEADER, HttpError } from '@ageniza/core';

interface PublicErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Fastify errors the client can provoke, answered with a fixed, safe response. Each error is
 * matched by its exact `code`; a generic `statusCode < 500` shortcut is deliberately not used, so
 * any error not listed here still fails as unexpected (logged and captured) rather than being
 * silently downgraded. The framework's own `message` is never forwarded: for a body parser it can
 * echo a fragment of the body, and for the router it echoes the request path.
 */
const clientErrorResponses: Readonly<Record<string, Omit<PublicErrorResponse, 'details'>>> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'O tipo de conteúdo da requisição não é suportado.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large' },
  // A path segment longer than Fastify's `maxParamLength` (100) throws before any route runs; the
  // raw reply carries the requested path, so the mapped message is fixed and echoes nothing.
  FST_ERR_MAX_PARAM_LENGTH: { statusCode: 414, code: 'URI_TOO_LONG', message: 'O caminho da requisição é longo demais.' },
  // The other router framework error the client can provoke (a malformed URL component). It is
  // mapped for the same reason: once `frameworkErrors` routes the router's errors through the error
  // handler, an unmapped code would be an unexpected 500 instead of the framework's own 400.
  FST_ERR_BAD_URL: { statusCode: 400, code: 'INVALID_URL', message: 'O caminho da requisição não é válido.' }
};

const isRateLimitError = (error: unknown): error is { statusCode: number; code: string } =>
  typeof error === 'object' && error !== null &&
  'statusCode' in error && error.statusCode === 429 &&
  'code' in error && error.code === 'RATE_LIMITED';

/**
 * A client that declares a body and closes the socket before sending it. Both signs are required:
 *
 * - the shape of the error the request stream emitted, Node's `Error('aborted')` with
 *   `code === 'ECONNRESET'`. The error alone is not enough: a truncated **upstream** response (pg,
 *   S3/R2, SMTP) is the very same error, with the client still connected (issue #211).
 * - `raw.readableAborted === true`, the request itself was aborted. The state alone is not enough
 *   either: it stays true whenever a client leaves during a bodyless request, which would hide a
 *   genuine upstream `ECONNRESET` behind a 400 and keep it out of Sentry (issue #195).
 */
const isAbortedBody = (error: unknown, request: FastifyRequest): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ECONNRESET' && error.message === 'aborted' &&
  request.raw.readableAborted === true;

const clientErrorResponse = (error: unknown): PublicErrorResponse | undefined => {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined;
  return clientErrorResponses[error.code];
};

const publicError = (error: unknown, request: FastifyRequest): PublicErrorResponse => {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }
  if (isRateLimitError(error)) {
    return { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' };
  }
  if (isAbortedBody(error, request)) {
    return { statusCode: 400, code: 'REQUEST_ABORTED', message: 'A requisição foi interrompida pelo cliente.' };
  }
  const clientError = clientErrorResponse(error);
  if (clientError !== undefined) return { ...clientError };
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
};

/**
 * Answers one error with the public envelope, mapping the exact code and logging at the right level.
 * Shared by `setErrorHandler` and the router's framework errors: those are raised before a route
 * exists, so Fastify's own `onMaxParamLength`/`onBadUrl` would otherwise reply a raw body that skips
 * this handler and echoes the path. The framework error's synthetic reply has no route error handler
 * to fall back on, so `frameworkErrors` calls this directly instead of `reply.send(error)`.
 */
export const sendErrorEnvelope = (error: unknown, request: FastifyRequest, reply: FastifyReply): void => {
  const response = publicError(error, request);
  const logContext = { requestId: request.id, statusCode: response.statusCode, code: response.code };
  if (response.code === 'INTERNAL_ERROR') {
    // Do not attach raw errors to logs: exception messages and payload-derived errors can contain secrets.
    request.log.error({ ...logContext, error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'INTERNAL_ERROR' } }, 'Request failed unexpectedly');
    captureUnexpectedError(error, { ...logContext, correlationId: String(reply.getHeader(CORRELATION_ID_HEADER) ?? request.id), route: loggableRoute(request) });
  } else {
    request.log.info(logContext, 'Request failed');
  }
  const body = ApiErrorResponseSchema.parse({
    error: {
      code: response.code,
      message: response.message,
      ...(response.details === undefined ? {} : { details: response.details })
    },
    meta: { requestId: request.id }
  });
  reply.status(response.statusCode).send(body);
};

/** Installs the public error contract and prevents accidental error detail leakage. */
export const registerErrorHandling = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request, reply) => {
    const body = ApiErrorResponseSchema.parse({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
      meta: { requestId: request.id }
    });
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    sendErrorEnvelope(error, request, reply);
  });
};
