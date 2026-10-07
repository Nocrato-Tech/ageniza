import { describe, expect, it } from 'vitest';

import { CollaboratorListQuerySchema, ReactivateCollaboratorRequestSchema } from '../src/index.js';

const roleId = '66666666-6666-4666-8666-666666666666';

describe('ReactivateCollaboratorRequestSchema (issue #98)', () => {
  it('requires the role and accepts nothing else', () => {
    expect(ReactivateCollaboratorRequestSchema.parse({ roleId })).toEqual({ roleId });
    for (const body of [{}, { roleId: null }, { roleId: 'not-a-uuid' }, { roleId: 7 }, { role_id: roleId }, { roleId, extra: true }, null, 'x', []]) {
      expect(ReactivateCollaboratorRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('the status filter of the collaborator listing (issue #98)', () => {
  it('accepts active and removed, and nothing else', () => {
    expect(CollaboratorListQuerySchema.parse({ status: 'removed' }).status).toBe('removed');
    expect(CollaboratorListQuerySchema.parse({ status: 'active' }).status).toBe('active');
    expect(CollaboratorListQuerySchema.parse({}).status).toBeUndefined();
    for (const status of ['', 'all', 'REMOVED', 'archived']) {
      expect(CollaboratorListQuerySchema.safeParse({ status }).success, status).toBe(false);
    }
  });
});
