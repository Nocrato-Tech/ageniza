import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ApiErrorResponseSchema,
  ApiResponseMetadataSchema,
  HealthResponseSchema,
  PaginationInputSchema,
  PaginationMetadataSchema,
  createPaginatedResponseSchema
} from '../src/index.js';

describe('public API error contracts', () => {
  it('accepts a safe error envelope with optional response metadata', () => {
    expect(ApiErrorResponseSchema.parse({
      error: { code: 'VALIDATION_ERROR', message: 'One or more fields are invalid', details: { fields: ['email'] } },
      meta: { requestId: 'request-123' }
    })).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'One or more fields are invalid', details: { fields: ['email'] } },
      meta: { requestId: 'request-123' }
    });
  });

  it('rejects malformed envelopes and undeclared public fields', () => {
    expect(() => ApiErrorResponseSchema.parse({ error: { code: '', message: 'Invalid' } })).toThrow();
    expect(() => ApiErrorResponseSchema.parse({ error: { code: 'INVALID', message: 'Invalid', stack: 'private' } })).toThrow();
    expect(() => ApiResponseMetadataSchema.parse({ requestId: 'request-1', agencyId: 'private' })).toThrow();
    expect(() => ApiResponseMetadataSchema.parse({ requestId: 'unsafe request id' })).toThrow();
  });
});

describe('pagination contracts', () => {
  it('coerces valid query controls without imposing endpoint defaults', () => {
    expect(PaginationInputSchema.parse({ page: '2', pageSize: '25' })).toEqual({ page: 2, pageSize: 25 });
    expect(PaginationInputSchema.parse({})).toEqual({});
  });

  it('rejects invalid controls and invalid metadata', () => {
    expect(() => PaginationInputSchema.parse({ page: 0 })).toThrow();
    expect(() => PaginationInputSchema.parse({ pageSize: 1.5 })).toThrow();
    expect(() => PaginationMetadataSchema.parse({ page: 1, pageSize: 10, totalItems: -1, totalPages: 0 })).toThrow();
  });

  it('creates a public collection response from an explicitly supplied item schema', () => {
    const ProjectListResponseSchema = createPaginatedResponseSchema(z.object({ id: z.string(), name: z.string() }).strict());
    expect(ProjectListResponseSchema.parse({
      data: [{ id: 'project-1', name: 'Ageniza' }],
      meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 }
    })).toEqual({
      data: [{ id: 'project-1', name: 'Ageniza' }],
      meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 }
    });
  });
});

describe('health response contract', () => {
  it('accepts only the current public health response', () => {
    expect(HealthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(() => HealthResponseSchema.parse({ status: 'degraded' })).toThrow();
    expect(() => HealthResponseSchema.parse({ status: 'ok', checks: [] })).toThrow();
  });
});
