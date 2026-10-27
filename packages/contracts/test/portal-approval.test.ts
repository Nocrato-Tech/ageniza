import { describe, expect, it } from 'vitest';

import {
  PORTAL_APPROVAL_PAGE_PATH,
  PORTAL_APPROVAL_TOKEN_PATTERN,
  PortalApprovalApproveRequestSchema,
  PortalApprovalBatchSchema,
  PortalApprovalContentSchema,
  PortalApprovalExchangeRequestSchema,
  PortalApprovalNoQuerySchema,
  PortalApprovalRequestChangesRequestSchema
} from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const open = {
  id: ID,
  title: 'Post',
  platform: 'instagram',
  format: 'reels',
  publishOn: '2026-10-20',
  publishAtTime: '18:30',
  status: 'awaiting_approval',
  coverAssetId: null,
  publishedOn: null,
  caption: 'Legenda',
  revision: 1,
  media: [{ id: ID, position: 1, kind: 'image' }],
  canDecide: true
};

describe('the contract of the approval link (issue #712)', () => {
  it('names the page of the link, and the token has the shape of 32 bytes in base64url', () => {
    expect(PORTAL_APPROVAL_PAGE_PATH).toBe('/aprovar');
    expect(PORTAL_APPROVAL_TOKEN_PATTERN.test('x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV6')).toBe(true);
    for (const token of ['', 'curto', 'x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV6A', 'x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV=', 'x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV+', ` x9Qm2L0vWk3pTz8RjYb4Nc7HsAe1UdFgO5iXqKrMtV6`]) {
      expect(PORTAL_APPROVAL_TOKEN_PATTERN.test(token), token).toBe(false);
    }
  });

  it('takes the token alone in the body, and nothing else', () => {
    expect(PortalApprovalExchangeRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    for (const body of [{}, { token: '' }, { token: 'a'.repeat(257) }, { token: 1 }, { token: 'abc', extra: 1 }, { token: 'abc', email: 'a@b.test' }]) {
      expect(PortalApprovalExchangeRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('takes no query at all', () => {
    expect(PortalApprovalNoQuerySchema.safeParse({}).success).toBe(true);
    expect(PortalApprovalNoQuerySchema.safeParse({ token: 'x' }).success).toBe(false);
  });

  it('takes the revision alone to approve, and the revision and the comment to ask for changes: who decides is never a field', () => {
    expect(PortalApprovalApproveRequestSchema.safeParse({ revision: 1 }).success).toBe(true);
    for (const body of [{}, { revision: 0 }, { revision: 1, approvedBy: ID }, { revision: 1, accessId: ID }]) {
      expect(PortalApprovalApproveRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(PortalApprovalRequestChangesRequestSchema.safeParse({ revision: 1, comment: 'Troque a foto.' }).success).toBe(true);
    for (const body of [{ revision: 1 }, { revision: 1, comment: '  ' }, { revision: 1, comment: 'a'.repeat(5001) }, { revision: 1, comment: 'ok', authorId: ID }]) {
      expect(PortalApprovalRequestChangesRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('reads a content open to the client with its buttons flag, and one in production as title, day and format, never with a caption', () => {
    expect(PortalApprovalContentSchema.safeParse(open).success).toBe(true);
    expect(PortalApprovalContentSchema.safeParse({ ...open, status: 'approved', canDecide: false }).success).toBe(true);
    const production = { id: ID, title: 'Post', format: 'reels', publishOn: '2026-10-20', status: 'in_production', canDecide: false };
    expect(PortalApprovalContentSchema.safeParse(production).success).toBe(true);
    expect(PortalApprovalContentSchema.safeParse({ ...production, caption: 'Rascunho' }).success).toBe(false);
    expect(PortalApprovalContentSchema.safeParse({ ...production, canDecide: true }).success).toBe(false);
    expect(PortalApprovalContentSchema.safeParse({ ...open, canDecide: undefined }).success).toBe(false);
    expect(PortalApprovalContentSchema.safeParse({ ...open, agencyId: ID }).success).toBe(false);
  });

  it('reads the batch with the names, the address of the access and the validities, and nothing of the brand', () => {
    const batch = {
      clientName: 'Padaria', agencyName: 'Agência', personEmail: 'maria@padaria.test',
      sessionExpiresAt: '2026-10-27T14:00:00.000Z', linkExpiresAt: '2026-11-03T12:00:00.000Z', contents: [open]
    };
    expect(PortalApprovalBatchSchema.safeParse(batch).success).toBe(true);
    for (const extra of [{ clientPhotoUrl: 'https://x.test/a.png' }, { brandColors: [] }, { hasAccount: true }, { accessId: ID }]) {
      expect(PortalApprovalBatchSchema.safeParse({ ...batch, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});
