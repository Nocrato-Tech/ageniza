import { APIError } from 'better-auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '@ageniza/core';

/** Only these four headers ever reach Better Auth; nothing else the client sent is forwarded. */
const FORWARDED_REQUEST_HEADERS = ['cookie', 'origin', 'user-agent'] as const;
const CLIENT_IP_HEADER = 'x-ageniza-client-ip';

/**
 * Builds the only `Headers` object Better Auth ever sees for a request.
 *
 * `x-ageniza-client-ip` is always set from Fastify's own resolved `request.ip` (which honors
 * `trustProxy`/`API_TRUSTED_PROXY_CIDRS`); any `x-ageniza-client-ip` the client itself sent is
 * discarded, never forwarded.
 */
export const toAuthHeaders = (request: FastifyRequest): Headers => {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  headers.set(CLIENT_IP_HEADER, request.ip);
  return headers;
};

/** Copies every `set-cookie` from a Better Auth `returnHeaders: true` result onto the Fastify reply. */
export const applyAuthCookies = (reply: FastifyReply, headers: Headers): void => {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
};

export interface AuthErrorFallback {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Converts a Better Auth `APIError` into the public error contract.
 *
 * The Better Auth error's own `message`/`code`/`body` are deliberately discarded and never
 * reach the response: callers pass the exact public shape allowed for the route (the tables in
 * issue #31 section 6 enumerate them), so no Better Auth-authored text can leak to a client.
 * Anything that is not an `APIError` is rethrown so the global error handler treats it as an
 * unexpected failure instead of silently downgrading it to a public auth error.
 */
export const toPublicAuthError = (error: unknown, fallback: AuthErrorFallback): HttpError => {
  if (error instanceof APIError) return new HttpError(fallback);
  throw error;
};
