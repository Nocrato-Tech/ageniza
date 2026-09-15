import type { FastifyInstance } from 'fastify';

import { ApiErrorResponseSchema } from '@ageniza/contracts';
import { captureUnexpectedError, CORRELATION_ID_HEADER, HttpError } from '@ageniza/core';

const payloadTooLargeCode = 'FST_ERR_CTP_BODY_TOO_LARGE';

const isRateLimitError = (error: unknown): error is { statusCode: number; code: string } =>
  typeof error === 'object' && error !== null &&
  'statusCode' in error && error.statusCode === 429 &&
  'code' in error && error.code === 'RATE_LIMITED';

const publicError = (error: unknown): { statusCode: number; code: string; message: string; details?: Record<string, unknown> } => {
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
  if (error instanceof Error && 'code' in error && error.code === payloadTooLargeCode) {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large' };
  }
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
      captureUnexpectedError(error, { ...logContext, correlationId: String(reply.getHeader(CORRELATION_ID_HEADER) ?? request.id), route: request.routeOptions.url ?? request.url.split('?')[0] });
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
