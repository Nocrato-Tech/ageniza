import type { ContentFormat, PortalApprovalBatch, PortalApprovalContent } from '@ageniza/contracts';

/**
 * A stand-in for the routes of the approval link (`/portal-approval/*`) that answers the way the API does: a macrotask later (a
 * `setTimeout`, never a microtask, so a race between two reads cannot hide behind a synchronous fake), `404 APPROVAL_LINK_INVALID`
 * for every dead link and for a missing cookie, `400` for any query the route does not take, `409` for a stale revision or a
 * content that no longer waits. `canDecide` is the fake's own judgement of the status, never a field a test hands the page.
 */

export const APPROVAL_TOKEN = 'Zq3_kT9-aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX';
export const CLIENT_NAME = 'Padaria Central';
export const AGENCY_NAME = 'Agência Exemplo';
export const PERSON_EMAIL = 'maria@padariacentral.example.test';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const failure = (status: number, code: string, headers: Record<string, string> = {}): Response => json({ error: { code, message: 'MENSAGEM DO SERVIDOR' } }, status, headers);

export const asset = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const contentId = (n: number): string => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

export type ServerStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published';

export interface SeedContent {
  readonly id: string;
  readonly title?: string;
  readonly status?: ServerStatus;
  readonly format?: ContentFormat;
  readonly publishOn?: string;
  readonly publishAtTime?: string | null;
  readonly caption?: string | null;
  readonly revision?: number;
  readonly media?: readonly { id: string; kind: 'image' | 'video' }[];
  readonly coverAssetId?: string | null;
  /** The server refusing to let a content be decided although it waits (a rule the page must obey from `canDecide`, not from the status). */
  readonly locked?: boolean;
}

export interface StoredContent {
  readonly id: string;
  title: string;
  status: ServerStatus;
  format: ContentFormat;
  publishOn: string;
  publishAtTime: string | null;
  caption: string | null;
  revision: number;
  media: { id: string; kind: 'image' | 'video' }[];
  coverAssetId: string | null;
  publishedOn: string | null;
  locked: boolean;
}

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
  /** What the address bar said when the request left: the fragment must be gone by then. */
  readonly hashAtSend: string;
}

export interface ApprovalControls {
  /** Milliseconds of every answer (a real timer). */
  latency: number;
  /** A promise held open delays the matching routes until it resolves. */
  hold: { exchange?: Promise<void>; batch?: Promise<void>; decision?: Promise<void>; media?: Promise<void> };
  /** Replaces the answer of a route while it returns something: a Response is sent as it is, `'network'` fails like a dropped connection, `undefined` lets the route answer. */
  fail: { exchange?: () => Response | 'network' | undefined; batch?: () => Response | 'network' | undefined; decision?: () => Response | 'network' | undefined; media?: () => Response | 'network' | undefined };
  /** How long a signed address of a media lasts. */
  mediaTtlMs: number;
}

export const stored = (seed: SeedContent): StoredContent => ({
  id: seed.id,
  title: seed.title ?? `Conteúdo ${seed.id.slice(-2)}`,
  status: seed.status ?? 'awaiting_approval',
  format: seed.format ?? 'image',
  publishOn: seed.publishOn ?? '2026-10-12',
  publishAtTime: seed.publishAtTime === undefined ? '18:30' : seed.publishAtTime,
  caption: seed.caption === undefined ? 'Legenda do post.' : seed.caption,
  revision: seed.revision ?? 1,
  media: [...(seed.media ?? [{ id: asset(1), kind: 'image' as const }])],
  coverAssetId: seed.coverAssetId ?? null,
  locked: seed.locked ?? false,
  publishedOn: seed.status === 'published' ? '2026-10-13' : null
});

const asContent = (row: StoredContent): PortalApprovalContent => {
  if (row.status === 'in_production') {
    return { id: row.id, title: row.title, format: row.format, publishOn: row.publishOn, status: 'in_production', canDecide: false };
  }
  return {
    id: row.id,
    title: row.title,
    platform: 'instagram',
    format: row.format,
    publishOn: row.publishOn,
    publishAtTime: row.publishAtTime,
    status: row.status,
    coverAssetId: row.coverAssetId,
    publishedOn: row.publishedOn,
    caption: row.caption,
    revision: row.revision,
    media: row.media.map((entry, index) => ({ id: entry.id, position: index + 1, kind: entry.kind })),
    canDecide: row.status === 'awaiting_approval' && !row.locked
  };
};

export const createApprovalApi = (seeds: readonly SeedContent[], initial: Partial<ApprovalControls> = {}) => {
  const rows: StoredContent[] = seeds.map(stored);
  const calls: RecordedCall[] = [];
  const controls: ApprovalControls = { latency: 3, hold: {}, fail: {}, mediaTtlMs: 5 * 60_000, ...initial };
  const world = { cookie: false, linkAlive: true, sessionLive: true, mediaCalls: 0, clientName: CLIENT_NAME };

  const batch = (): PortalApprovalBatch => ({
    clientName: world.clientName,
    agencyName: AGENCY_NAME,
    personEmail: PERSON_EMAIL,
    sessionExpiresAt: '2026-10-27T14:00:00.000Z',
    linkExpiresAt: '2026-11-04T01:30:00.000Z',
    contents: rows.map(asContent)
  });

  const decide = (row: StoredContent | undefined, body: unknown, action: 'approve' | 'request'): Response => {
    if (row === undefined) return failure(404, 'NOT_FOUND');
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const allowed = action === 'approve' ? ['revision'] : ['revision', 'comment'];
    if (Object.keys(record).some((key) => !allowed.includes(key)) || !Number.isInteger(record.revision)) return failure(400, 'VALIDATION_ERROR');
    if (action === 'request') {
      if (typeof record.comment !== 'string' || record.comment.trim() === '') return failure(400, 'VALIDATION_ERROR');
      if (record.comment.includes('\u0000')) return failure(400, 'CONTENT_COMMENT_INVALID');
    }
    if (row.status !== 'awaiting_approval' || row.locked) return failure(409, 'CONTENT_NOT_AWAITING_APPROVAL');
    if (record.revision !== row.revision) return failure(409, 'CONTENT_REVISION_CHANGED');
    row.status = action === 'approve' ? 'approved' : 'adjusting';
    return json(asContent(row));
  };

  const answer = async (url: URL, method: string, body: unknown): Promise<Response> => {
    const path = url.pathname;
    const takesQuery = /\/media\/[^/]+\/url$/.test(path);
    if (url.search !== '' && !(takesQuery && [...url.searchParams.keys()].every((key) => key === 'variant'))) return failure(400, 'VALIDATION_ERROR');

    if (path === '/portal-approval/session' && method === 'POST') {
      await controls.hold.exchange;
      const override = controls.fail.exchange?.();
      if (override === 'network') throw new TypeError('Failed to fetch');
      if (override !== undefined) return override;
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
      if (Object.keys(record).join() !== 'token' || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.token)) return failure(400, 'VALIDATION_ERROR');
      if (record.token !== APPROVAL_TOKEN || !world.linkAlive) return failure(404, 'APPROVAL_LINK_INVALID');
      world.cookie = true;
      return json({ sessionExpiresAt: '2026-10-27T14:00:00.000Z', linkExpiresAt: '2026-11-04T01:30:00.000Z' });
    }

    if (!world.cookie || !world.linkAlive || !world.sessionLive) return failure(404, 'APPROVAL_LINK_INVALID');

    if (path === '/portal-approval/batch' && method === 'GET') {
      await controls.hold.batch;
      const override = controls.fail.batch?.();
      if (override === 'network') throw new TypeError('Failed to fetch');
      if (override !== undefined) return override;
      return json(batch());
    }

    const media = /^\/portal-approval\/contents\/([^/]+)\/media\/([^/]+)\/url$/.exec(path);
    if (media !== null && method === 'GET') {
      await controls.hold.media;
      const override = controls.fail.media?.();
      if (override === 'network') throw new TypeError('Failed to fetch');
      if (override !== undefined) return override;
      const row = rows.find((entry) => entry.id === media[1]);
      const variant = url.searchParams.get('variant') ?? 'original';
      if (row === undefined || row.status === 'in_production' || !['original', 'thumbnail'].includes(variant)) return failure(404, 'NOT_FOUND');
      if (!row.media.some((entry) => entry.id === media[2]) && row.coverAssetId !== media[2]) return failure(404, 'NOT_FOUND');
      world.mediaCalls += 1;
      return json({ url: `https://storage.example.test/${media[2]}/${variant}?n=${world.mediaCalls}`, expiresAt: new Date(Date.now() + controls.mediaTtlMs).toISOString() });
    }

    const decision = /^\/portal-approval\/contents\/([^/]+)\/(approve|request-changes)$/.exec(path);
    if (decision !== null && method === 'POST') {
      await controls.hold.decision;
      const override = controls.fail.decision?.();
      if (override === 'network') throw new TypeError('Failed to fetch');
      if (override !== undefined) return override;
      return decide(rows.find((entry) => entry.id === decision[1]), body, decision[2] === 'approve' ? 'approve' : 'request');
    }
    return failure(404, 'NOT_FOUND');
  };

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body, credentials: init?.credentials, hashAtSend: window.location.hash });
    await new Promise<void>((resolve) => { setTimeout(resolve, controls.latency); });
    return answer(url, method, body);
  };

  return {
    impl,
    calls,
    controls,
    world,
    rows,
    row: (id: string): StoredContent => {
      const found = rows.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`no content ${id} in the fixture`);
      return found;
    },
    callsTo: (method: string, pathPattern: RegExp): RecordedCall[] => calls.filter((call) => call.method === method && pathPattern.test(call.path))
  };
};

export type ApprovalApi = ReturnType<typeof createApprovalApi>;
