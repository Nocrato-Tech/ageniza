import { ZodError, type ZodType } from 'zod';

import { HttpError } from '@ageniza/core';

/** Parses untrusted transport values and exposes only safe issue metadata to clients. */
export const parseRequest = <T>(schema: ZodType<T>, value: unknown): T => {
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
