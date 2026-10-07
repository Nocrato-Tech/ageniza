import { describe, expect, it } from 'vitest';

import {
  AgencyClientMemberPathParamsSchema,
  ClientInvitationListQuerySchema,
  ClientMemberListQuerySchema,
  ClientPendingInvitationSchema,
  PortalBrandStudyResponseSchema,
  PortalClientQuerySchema,
  PortalClientResponseSchema
} from '../src/index.js';

const id = '77777777-7777-4777-8777-777777777777';

const portalClient = {
  id,
  name: 'Padaria Central',
  status: 'active',
  photoUrl: null,
  legalName: null,
  taxId: null,
  segment: null,
  website: null,
  instagramHandle: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  archivedAt: null,
  agencyName: 'Agência Exemplo',
  onboardingSeenAt: null,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 0 }
};

const section = { key: 'branding', body: null, colors: null, archetype: null, updatedAt: null };
const persona = { id, name: 'Dona Maria', description: null, pains: null, desires: null, objections: null, status: 'active', updatedAt: '2026-10-07T12:00:00.000Z' };

describe('PortalClientResponseSchema (issue #129)', () => {
  it('serves an active client and refuses one that is archived or carries an extra field', () => {
    expect(PortalClientResponseSchema.safeParse(portalClient).success).toBe(true);
    for (const response of [
      { ...portalClient, status: 'archived' },
      { ...portalClient, archivedAt: '2026-10-07T12:00:00.000Z' },
      { ...portalClient, updatedBy: id },
      { ...portalClient, home: { threadsAnsweredByAgency: -1, brandStudyFilled: 0 } },
      { ...portalClient, home: { threadsAnsweredByAgency: 0, brandStudyFilled: 8 } }
    ]) {
      expect(PortalClientResponseSchema.safeParse(response).success, JSON.stringify(response).slice(0, 80)).toBe(false);
    }
  });

  it('takes no query parameter', () => {
    expect(PortalClientQuerySchema.safeParse({}).success).toBe(true);
    expect(PortalClientQuerySchema.safeParse({ x: '1' }).success).toBe(false);
  });
});

describe('PortalBrandStudyResponseSchema (issue #129)', () => {
  it('serves sections and active personas without who edited them', () => {
    expect(PortalBrandStudyResponseSchema.safeParse({ filled: 1, sections: [section], personas: [persona] }).success).toBe(true);
  });

  it('refuses an archived persona and any trace of who edited internally', () => {
    for (const study of [
      { filled: 1, sections: [section], personas: [{ ...persona, status: 'archived' }] },
      { filled: 1, sections: [{ ...section, updatedBy: { id, name: 'Alguém' } }], personas: [] },
      { filled: 1, sections: [{ ...section, updatedBy: null }], personas: [] },
      { filled: 1, sections: [section], personas: [{ ...persona, updatedBy: null }] },
      { filled: 8, sections: [section], personas: [] }
    ]) {
      expect(PortalBrandStudyResponseSchema.safeParse(study).success, JSON.stringify(study).slice(0, 80)).toBe(false);
    }
  });
});

describe('the portal access lists (issue #132)', () => {
  it('accept the two statuses and the page controls, and nothing else', () => {
    expect(ClientMemberListQuerySchema.parse({ status: 'removed', page: '2' })).toEqual({ status: 'removed', page: 2 });
    expect(ClientMemberListQuerySchema.parse({})).toEqual({});
    for (const query of [{ status: 'pending' }, { search: 'a' }, { page: '1e20' }, { page: '0' }]) {
      expect(ClientMemberListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
      expect(ClientInvitationListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('list a pending invitation by id, address and expiry, never by token', () => {
    const item = { invitationId: id, email: 'joao@exemplo.test', expiresAt: '2026-10-14T12:00:00.000Z' };
    expect(ClientPendingInvitationSchema.safeParse(item).success).toBe(true);
    expect(ClientPendingInvitationSchema.safeParse({ ...item, token: 'abc' }).success).toBe(false);
    expect(ClientPendingInvitationSchema.safeParse({ ...item, tokenHash: 'abc' }).success).toBe(false);
  });

  it('read a link id as a plain string, so a malformed one reaches the uniform 404', () => {
    expect(AgencyClientMemberPathParamsSchema.safeParse({ agencyId: id, clientId: id, membershipId: 'not-a-uuid' }).success).toBe(true);
    expect(AgencyClientMemberPathParamsSchema.safeParse({ agencyId: id, clientId: 'not-a-uuid', membershipId: id }).success).toBe(false);
  });
});
