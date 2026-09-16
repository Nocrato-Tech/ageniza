import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

export interface CorsOptions { allowedOrigins: readonly string[]; }

/** Applies an exact-origin browser allowlist; requests without Origin remain ordinary server-to-server requests. */
export const registerCors = async (app: FastifyInstance, options: CorsOptions): Promise<void> => {
  const allowedOrigins = new Set(options.allowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin !== undefined && allowedOrigins.has(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
    maxAge: 600,
    strictPreflight: true
  });
};
