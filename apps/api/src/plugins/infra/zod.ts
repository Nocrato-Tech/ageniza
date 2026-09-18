import { ZodError, type ZodType, type ZodTypeDef } from 'zod';

import { HttpError } from '@ageniza/core';

/**
 * Parses untrusted transport values and exposes only safe issue metadata to clients.
 *
 * `TIn` is separate from `TOut` so a schema that normalizes rather than merely validates still
 * infers its parsed type. Query schemas need this: a value that must be treated as absent instead
 * of rejected (issue #33's `preferred`) transforms `unknown` into `string | undefined`.
 */
export const parseRequest = <TOut, TIn = TOut>(schema: ZodType<TOut, ZodTypeDef, TIn>, value: unknown): TOut => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })) }
      });
    }
    throw error;
  }
};

/** Validates route responses before Fastify serializes them. */
export const parseResponse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);
