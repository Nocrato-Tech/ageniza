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
  city: null,
  website: null,
  instagramHandle: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  createdAt: '2026-03-10T12:00:00.000Z',
  archivedAt: null,
  agencyName: 'Agência Exemplo',
  onboardingSeenAt: null,
  agencyReadOnly: false,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 0, contentsAwaitingApproval: 0, materialRequestsOpen: 0 }
};

const without = (value: object, key: string): object => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const section = { key: 'branding', body: null, colors: null, archetype: null, updatedAt: null };
const persona = {
  id, name: 'Dona Maria', description: null, pains: null, desires: null, objections: null,
  age: null, occupation: null, location: null, traits: [], whereTheyAre: null, toneThatWorks: null,
  updatedAt: '2026-10-07T12:00:00.000Z'
};

describe('PortalClientResponseSchema (issue #129)', () => {
  it('serves an active client and refuses one that is archived or carries an extra field', () => {
    expect(PortalClientResponseSchema.safeParse(portalClient).success).toBe(true);
    for (const response of [
      { ...portalClient, status: 'archived' },
      { ...portalClient, archivedAt: '2026-10-07T12:00:00.000Z' },
      { ...portalClient, updatedBy: id },
      { ...portalClient, home: { ...portalClient.home, threadsAnsweredByAgency: -1 } },
      { ...portalClient, home: { ...portalClient.home, contentsAwaitingApproval: -1 } },
      { ...portalClient, home: { threadsAnsweredByAgency: 0, brandStudyFilled: 0 } },
      { ...portalClient, home: { ...portalClient.home, brandStudyFilled: 8 } },
      { ...portalClient, home: { ...portalClient.home, materialRequestsOpen: -1 } },
      { ...portalClient, home: { ...portalClient.home, materialRequestsOpen: 1.5 } },
      { ...portalClient, home: without(portalClient.home, 'materialRequestsOpen') }
    ]) {
      expect(PortalClientResponseSchema.safeParse(response).success, JSON.stringify(response).slice(0, 80)).toBe(false);
    }
  });

  it('carries the city and "cliente desde", and the count of open requests for material of the own client', () => {
    expect(PortalClientResponseSchema.parse({ ...portalClient, city: 'Campinas', home: { ...portalClient.home, materialRequestsOpen: 3 } })).toMatchObject({
      city: 'Campinas', createdAt: '2026-03-10T12:00:00.000Z', home: { materialRequestsOpen: 3 }
    });
    for (const response of [without(portalClient, 'city'), without(portalClient, 'createdAt'), { ...portalClient, createdAt: 'março' }]) {
      expect(PortalClientResponseSchema.safeParse(response).success, JSON.stringify(response).slice(0, 80)).toBe(false);
    }
  });

  it('takes no query parameter', () => {
    expect(PortalClientQuerySchema.safeParse({}).success).toBe(true);
    expect(PortalClientQuerySchema.safeParse({ x: '1' }).success).toBe(false);
  });
});

describe('PortalBrandStudyResponseSchema (issue #129)', () => {
  it('serves sections and personas without who edited them', () => {
    expect(PortalBrandStudyResponseSchema.safeParse({ filled: 1, sections: [section], personas: [persona] }).success).toBe(true);
  });

  it('refuses any trace of who edited internally and the count of the conversation of the agency', () => {
    for (const study of [
      { filled: 1, sections: [section], personas: [{ ...persona, messageCount: 3 }] },
      { filled: 1, sections: [section], personas: [{ ...persona, status: 'active' }] },
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
    expect(AgencyClientMemberPathParamsSchema.safeParse({ agencyId: id, clientId: id, accessId: 'not-a-uuid' }).success).toBe(true);
    expect(AgencyClientMemberPathParamsSchema.safeParse({ agencyId: id, clientId: 'not-a-uuid', accessId: id }).success).toBe(false);
  });
});
