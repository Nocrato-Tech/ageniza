/** A `GET /clients/:clientId` answer (the portal's own read); the tour is already seen unless the test asks for it. */
export const portalClientBody = (clientId: string, name: string, onboardingSeenAt: string | null = '2026-10-01T12:00:00.000Z'): Record<string, unknown> => ({
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
  onboardingSeenAt,
  agencyReadOnly: false,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 0, contentsAwaitingApproval: 0 }
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

// --- The story scripts of the portal (#258, #271) ---------------------------------------------------------------------

export interface PortalScriptRow {
  id: string;
  scriptOn: string;
  status: 'draft' | 'sent' | 'recorded';
  scenes: Array<{ position: number; text: string; guidance: string | null }>;
  recordedBy: { name: string | null } | null;
  recordedAt: string | null;
}

const scriptJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const scriptError = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => scriptJson({ error: { code, message } }, status);

/**
 * The two routes of the portal for story scripts, answering as the API does: a period lists only what was sent or recorded (a draft
 * never leaves, unless `leakDrafts` is set to see what the screen does with an answer the API would never give), both ends of the day
 * included; marking recorded is for a sent script of this client (a draft, another client's or an unknown id is the same 404), repeating it
 * on a recorded one changes nothing, and the person who recorded is named by their link, never by an id.
 */
export const createPortalScriptsApi = (clientId: string, now: () => Date, personName = 'Maria') => {
  const rows: PortalScriptRow[] = [];
  const calls: string[] = [];
  let sequence = 0;
  let failure: { make: () => Response; effect?: () => void } | undefined;
  let hold: Promise<void> | undefined;
  const state = { leakDrafts: false };

  const seed = (row: Partial<PortalScriptRow> & { scriptOn: string }): PortalScriptRow => {
    sequence += 1;
    const made: PortalScriptRow = {
      id: `d0d0d0d0-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      status: 'sent',
      scenes: [{ position: 1, text: `Cena ${sequence}`, guidance: null }],
      recordedBy: null,
      recordedAt: null,
      ...row
    };
    rows.push(made);
    return made;
  };

  const portalShape = (row: PortalScriptRow) => ({ id: row.id, scriptOn: row.scriptOn, status: row.status, scenes: row.scenes, recordedBy: row.recordedBy, recordedAt: row.recordedAt });

  /** `undefined` means the path is not a story script route of this client. */
  const handle = (url: URL, method: string): Response | undefined | Promise<Response> => {
    const list = url.pathname === `/clients/${clientId}/story-scripts`;
    const recorded = new RegExp(`^/clients/${clientId}/story-scripts/([^/]+)/recorded$`).exec(url.pathname);
    if (!list && recorded === null) return undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (list && method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const day = /^\d{4}-\d{2}-\d{2}$/;
      if (from === null || to === null || !day.test(from) || !day.test(to) || from > to) return scriptError(400, 'VALIDATION_ERROR');
      const found = rows.filter((row) => (state.leakDrafts || row.status !== 'draft') && row.scriptOn >= from && row.scriptOn <= to)
        .sort((a, b) => a.scriptOn.localeCompare(b.scriptOn) || a.id.localeCompare(b.id));
      return scriptJson({ data: found.map(portalShape), meta: { from, to, count: found.length } });
    }
    if (recorded !== null && method === 'POST') {
      const run = async (): Promise<Response> => {
        if (hold !== undefined) await hold;
        if (failure !== undefined) {
          const { make, effect } = failure;
          failure = undefined;
          effect?.();
          return make();
        }
        const row = rows.find((candidate) => candidate.id === recorded[1]);
        if (row === undefined || row.status === 'draft') return scriptError(404, 'NOT_FOUND', 'Story script not found.');
        if (row.status === 'sent') {
          row.status = 'recorded';
          row.recordedBy = { name: personName };
          row.recordedAt = now().toISOString();
        }
        return scriptJson(portalShape(row));
      };
      return run();
    }
    return scriptError(404, 'NOT_FOUND');
  };

  return {
    handle,
    seed,
    rows,
    calls,
    state,
    /** The next marking is answered with this, once; `effect` is what happened on the server meanwhile. */
    failNext: (make: () => Response, effect?: () => void): void => { failure = effect === undefined ? { make } : { make, effect }; },
    holdWrites: (promise: Promise<void>): void => { hold = promise; }
  };
};
