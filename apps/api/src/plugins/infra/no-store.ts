import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `Cache-Control: no-store` for a response that names the person or issues the session cookie (#423, #432).
 * Set as the route's `onRequest` hook, so every answer carries it: a 401 or 400 raised later by a
 * `preHandler`, a validation step or the handler itself keeps the header, because a check that answered
 * "signed out" must not be replayed from a cache any more than a 200 that echoes the person.
 */
export const noStore = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  reply.header('cache-control', 'no-store');
};
