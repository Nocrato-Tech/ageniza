/**
 * The routes of the portal for requests for material, as the API answers them: the listing has the open requests of this client only,
 * the nearest deadline first and the ones without a deadline last, twenty a page; the comments of a request are read and written
 * through the portal's conversation routes. The portal has no route that opens a request, and neither does this.
 */
export interface MaterialRequestRow {
  threadId: string;
  title: string | null;
  body: string;
  dueOn: string | null;
  createdAt: string;
  state: 'open' | 'resolved';
  comments: Array<{ id: string; body: string; side: 'agency' | 'client'; author: { name: string; photoUrl: null } | null; createdAt: string }>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const materialError = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => json({ error: { code, message } }, status);

const LIST_PAGE_SIZE = 20;
const COMMENT_PAGE_SIZE = 50;

export const createPortalMaterialRequestsApi = (clientId: string, agencyPerson = 'Lucas') => {
  const rows: MaterialRequestRow[] = [];
  const calls: string[] = [];
  /** What the portal posted, by thread: the proof that an answer went to the request it was written on. */
  const posted: Array<{ threadId: string; body: string }> = [];
  let sequence = 0;
  const state: { failList: (() => Response) | null; failComments: (() => Response) | null; failPost: (() => Response) | null } = { failList: null, failComments: null, failPost: null };

  const seed = (row: { title?: string | null; body: string; dueOn?: string | null; createdAt?: string; state?: 'open' | 'resolved' }): MaterialRequestRow => {
    sequence += 1;
    const createdAt = row.createdAt ?? '2026-10-07T12:00:00.000Z';
    const made: MaterialRequestRow = {
      threadId: `e1e1e1e1-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      title: row.title ?? null,
      body: row.body,
      dueOn: row.dueOn ?? null,
      createdAt,
      state: row.state ?? 'open',
      comments: [{ id: `c1c1c1c1-0000-4000-8000-${String(sequence).padStart(12, '0')}`, body: row.body, side: 'agency', author: { name: agencyPerson, photoUrl: null }, createdAt }]
    };
    rows.push(made);
    return made;
  };

  const byDeadline = (a: MaterialRequestRow, b: MaterialRequestRow): number => {
    if (a.dueOn !== b.dueOn) return a.dueOn === null ? 1 : b.dueOn === null ? -1 : a.dueOn < b.dueOn ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt) || a.threadId.localeCompare(b.threadId);
  };

  const page = <T>(items: T[], url: URL, pageSize: number) => {
    const number = Number(url.searchParams.get('page') ?? '1');
    return {
      data: items.slice((number - 1) * pageSize, number * pageSize),
      meta: { page: number, pageSize, totalItems: items.length, totalPages: Math.max(1, Math.ceil(items.length / pageSize)) }
    };
  };

  /** `undefined` means the path is not a route of requests for material of this client. */
  const handle = (url: URL, method: string, body?: unknown): Response | undefined => {
    const list = url.pathname === `/clients/${clientId}/material-requests`;
    const comments = new RegExp(`^/clients/${clientId}/threads/([^/]+)/comments$`).exec(url.pathname);
    if (!list && comments === null) return undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (list && method === 'GET') {
      if (state.failList !== null) return state.failList();
      const open = rows.filter((row) => row.state === 'open').sort(byDeadline);
      return json(page(open.map((row) => ({ threadId: row.threadId, title: row.title, body: row.body, dueOn: row.dueOn, createdAt: row.createdAt, state: row.state })), url, LIST_PAGE_SIZE));
    }
    if (comments !== null) {
      const row = rows.find((candidate) => candidate.threadId === comments[1]);
      if (row === undefined) return materialError(404, 'NOT_FOUND');
      if (method === 'GET') {
        if (state.failComments !== null) return state.failComments();
        return json(page(row.comments, url, COMMENT_PAGE_SIZE));
      }
      if (method === 'POST') {
        if (state.failPost !== null) return state.failPost();
        const text = String((body as { body?: unknown } | undefined)?.body ?? '');
        posted.push({ threadId: row.threadId, body: text });
        const comment = { id: `c2c2c2c2-0000-4000-8000-${String(row.comments.length + 1).padStart(12, '0')}`, body: text, side: 'client' as const, author: { name: 'Maria', photoUrl: null }, createdAt: '2026-10-08T12:00:00.000Z' };
        row.comments.push(comment);
        return json(comment, 201);
      }
    }
    return materialError(404, 'NOT_FOUND');
  };

  return {
    handle,
    seed,
    rows,
    calls,
    posted,
    state,
    /** The agency resolves it: it leaves the listing, and stays readable. */
    resolve: (threadId: string): void => {
      const row = rows.find((candidate) => candidate.threadId === threadId);
      if (row !== undefined) row.state = 'resolved';
    }
  };
};
