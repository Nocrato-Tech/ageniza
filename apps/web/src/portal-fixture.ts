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

const SECTION_KEYS = ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'] as const;

export interface PortalSectionContent {
  readonly body?: string;
  readonly colors?: readonly { name: string; hex: string }[];
  readonly archetype?: string;
}

/** A `GET /clients/:clientId/brand-study` answer: the seven sections in order, only the given ones filled. */
export const portalStudyBody = (
  filled: Partial<Record<(typeof SECTION_KEYS)[number], PortalSectionContent>> = {},
  personas: readonly Record<string, unknown>[] = []
): Record<string, unknown> => ({
  filled: Object.keys(filled).length,
  sections: SECTION_KEYS.map((key) => ({
    key,
    body: filled[key]?.body ?? null,
    colors: filled[key]?.colors ?? null,
    archetype: filled[key]?.archetype ?? null,
    updatedAt: filled[key] === undefined ? null : '2026-10-13T01:30:00.000Z'
  })),
  personas
});

export const portalPersona = (id: string, name: string, fields: Record<string, string | null> = {}): Record<string, unknown> => ({
  id,
  name,
  description: null,
  pains: null,
  desires: null,
  objections: null,
  status: 'active',
  updatedAt: '2026-10-13T01:30:00.000Z',
  ...fields
});
