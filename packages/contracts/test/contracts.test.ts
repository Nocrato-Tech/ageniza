import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ApiErrorResponseSchema,
  ApiResponseMetadataSchema,
  CollaboratorInvitationCreatedResponseSchema,
  HealthResponseSchema,
  InvitationAcceptNewAccountRequestSchema,
  InvitationAcceptNewAccountResponseSchema,
  InvitationAcceptRequestSchema,
  InvitationAcceptResponseSchema,
  InvitationCreatedResponseSchema,
  InvitationPreviewResponseSchema,
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

describe('invitation contracts', () => {
  const context = { agencyId: 'agency-1', clientId: null };

  it('models a valid invitation preview without exposing token fields', () => {
    expect(InvitationPreviewResponseSchema.parse({
      purpose: 'client_invite',
      email: ' Person@Example.TEST ',
      agency: { name: 'Ageniza' },
      client: { name: 'Cliente A' },
      accountExists: false
    })).toEqual({
      purpose: 'client_invite',
      email: 'person@example.test',
      agency: { name: 'Ageniza' },
      client: { name: 'Cliente A' },
      accountExists: false
    });
    expect(() => InvitationPreviewResponseSchema.parse({
      purpose: 'agency_activation',
      email: 'person@example.test',
      agency: { name: 'Ageniza' },
      client: null,
      accountExists: false,
      token: 'must-not-be-public'
    })).toThrow();
  });

  it('requires explicit terms acceptance and validates invitation acceptance responses', () => {
    expect(InvitationAcceptNewAccountRequestSchema.parse({ name: 'Person', password: '1234567890', acceptTerms: true })).toEqual({
      name: 'Person', password: '1234567890', acceptTerms: true
    });
    expect(() => InvitationAcceptNewAccountRequestSchema.parse({ name: 'Person', password: '1234567890', acceptTerms: false })).toThrow();
    expect(() => InvitationAcceptNewAccountRequestSchema.parse({ name: 'Person', email: 'other@example.test', password: '1234567890', acceptTerms: true })).toThrow();
    expect(InvitationAcceptNewAccountResponseSchema.parse({ status: 'accepted', context })).toEqual({ status: 'accepted', context });
    expect(InvitationAcceptRequestSchema.parse(undefined)).toBeUndefined();
    expect(InvitationAcceptResponseSchema.parse({ status: 'already_member', context })).toEqual({ status: 'already_member', context });
    expect(() => InvitationAcceptResponseSchema.parse({ status: 'accepted', context: { agencyId: 'agency-1', clientId: undefined } })).toThrow();
  });

  it('models the collaborator creation response with the invitation it superseded', () => {
    const invitationId = '11111111-1111-4111-8111-111111111111';
    const supersededInvitationId = '22222222-2222-4222-8222-222222222222';
    expect(CollaboratorInvitationCreatedResponseSchema.parse({
      invitationId,
      expiresAt: '2026-10-02T12:00:00.000Z',
      supersededInvitationId
    })).toEqual({ invitationId, expiresAt: '2026-10-02T12:00:00.000Z', supersededInvitationId });
    expect(CollaboratorInvitationCreatedResponseSchema.parse({
      invitationId,
      expiresAt: '2026-10-02T12:00:00.000Z',
      supersededInvitationId: null
    }).supersededInvitationId).toBeNull();
    // The shared creation/resend contract keeps no such field; the collaborator one requires it.
    expect(() => InvitationCreatedResponseSchema.parse({ invitationId, expiresAt: '2026-10-02T12:00:00.000Z', supersededInvitationId })).toThrow();
    expect(() => CollaboratorInvitationCreatedResponseSchema.parse({ invitationId, expiresAt: '2026-10-02T12:00:00.000Z' })).toThrow();
  });
});
