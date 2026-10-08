/** A `GET /clients/:clientId` answer (the portal's own read) for tests that only need the shell to open. */
export const portalClientBody = (clientId: string, name: string): Record<string, unknown> => ({
  id: clientId,
  name,
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
  agencyName: 'Agência Um',
  onboardingSeenAt: null,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 0 }
});
