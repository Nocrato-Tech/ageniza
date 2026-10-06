import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@ageniza/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Copies the request id and the correlation id onto the reply, preserving a valid inbound
 * correlation id. Shared by the `onRequest` hook and by the router's framework errors, whose
 * synthetic reply never reaches a hook.
 */
export const applyCorrelationHeaders = (request: FastifyRequest, reply: FastifyReply): void => {
  reply.header(REQUEST_ID_HEADER, request.id);
  reply.header(CORRELATION_ID_HEADER, resolveRequestId(request.headers[CORRELATION_ID_HEADER] ?? request.id));
};
