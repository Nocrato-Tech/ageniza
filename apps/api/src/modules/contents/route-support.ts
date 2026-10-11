import type { HttpError } from '@ageniza/core';
import type { FastifyRequest } from 'fastify';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route. */
export const idFromRoute = (request: FastifyRequest, name: 'clientId' | 'contentId' | 'taskId', notFound: () => HttpError): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound();
  return value;
};
