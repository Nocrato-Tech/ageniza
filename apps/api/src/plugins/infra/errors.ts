import type { FastifyInstance } from 'fastify';

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
 * Body-parser failures the client can provoke, answered with a fixed, safe response. Each Fastify
 * error is matched by its exact `code`; a generic `statusCode < 500` shortcut is deliberately not
 * used, so any parser error not listed here still fails as unexpected (logged and captured) rather
 * than being silently downgraded. The parser's own `message` is never forwarded: it can echo a
 * fragment of the body.
 */
const contentTypeErrorResponses: Readonly<Record<string, Omit<PublicErrorResponse, 'details'>>> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { statusCode: 400, code: 'INVALID_BODY', message: 'O corpo da requisição é inválido.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'O tipo de conteúdo da requisição não é suportado.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large' }
};

const isRateLimitError = (error: unknown): error is { statusCode: number; code: string } =>
  typeof error === 'object' && error !== null &&
  'statusCode' in error && error.statusCode === 429 &&
  'code' in error && error.code === 'RATE_LIMITED';

/**
 * A client that declares a body and closes the socket before sending it: Fastify's body parser
 * hands over the exact error the request stream emitted, Node's `Error('aborted')` with
 * `code === 'ECONNRESET'`. Match that error, not the request state: `raw.readableAborted` is also
 * true when a client leaves during a bodyless request, so using it alone (issue #195) would hide a
 * genuine upstream `ECONNRESET` (pg, S3, SMTP) behind a 400 and keep it out of Sentry.
 */
const isAbortedBody = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ECONNRESET' && error.message === 'aborted';

const contentTypeErrorResponse = (error: unknown): PublicErrorResponse | undefined => {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined;
  return contentTypeErrorResponses[error.code];
};

const publicError = (error: unknown): PublicErrorResponse => {
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
  if (isAbortedBody(error)) {
    return { statusCode: 400, code: 'REQUEST_ABORTED', message: 'A requisição foi interrompida pelo cliente.' };
  }
  const parserError = contentTypeErrorResponse(error);
  if (parserError !== undefined) return { ...parserError };
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
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
    const response = publicError(error);
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
    return reply.status(response.statusCode).send(body);
  });
};
