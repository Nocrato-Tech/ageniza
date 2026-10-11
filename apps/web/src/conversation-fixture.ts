import {
  CreateCommentRequestSchema,
  CreateThreadRequestSchema,
  threadSubjectOfQuery,
  ThreadListQuerySchema,
  type ConversationSide,
  type Thread,
  type ThreadComment,
  type ThreadSubject
} from '@ageniza/contracts';

/**
 * A stateful stand-in for the conversation routes of both sides (#128, #130). It answers like the
 * API: one subject per listing (400 otherwise), a comment reopens a resolved thread, the side is
 * stamped from the route, a body that breaks the contract is a 400, and the portal has no resolve.
 * Nothing the screen should compute is ever handed to it.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const apiError = (status: number, code: string, message = code): Response => json({ error: { code, message } }, status);

interface StoredThread {
  readonly id: string;
  readonly subject: ThreadSubject;
  readonly openedBy: { name: string | null; side: ConversationSide };
  readonly comments: ThreadComment[];
  resolvedAt: string | null;
  resolvedBy: { name: string | null } | null;
}

export interface FakePeople {
  readonly agency: { name: string; photoUrl: string | null };
  readonly client: { name: string; photoUrl: string | null };
}

export interface ConversationApiOptions {
  /** Which route set is answered: `/agencies/:agencyId/clients/:clientId/...` or `/clients/:clientId/...`. */
  readonly side: ConversationSide;
  readonly clientId: string;
  readonly people?: FakePeople;
  readonly pageSize?: number;
}

export interface SeedComment {
  readonly side: ConversationSide;
  readonly body: string;
  readonly at: string;
}

const DEFAULT_PEOPLE: FakePeople = {
  agency: { name: 'Ana', photoUrl: 'https://photos.example.test/ana.png' },
  client: { name: 'Maria', photoUrl: null }
};

const sameSubject = (left: ThreadSubject, right: ThreadSubject): boolean =>
  ('sectionKey' in left && 'sectionKey' in right && left.sectionKey === right.sectionKey)
  || ('personaId' in left && 'personaId' in right && left.personaId === right.personaId);

export const createConversationApi = (options: ConversationApiOptions) => {
  const people = options.people ?? DEFAULT_PEOPLE;
  const threads: StoredThread[] = [];
  let sequence = 0;
  let clock = Date.parse('2026-10-13T01:30:00.000Z');
  const tick = (): string => { clock += 60_000; return new Date(clock).toISOString(); };
  const nextId = (): string => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const calls: string[] = [];
  const bodies: unknown[] = [];

  const lastOf = (thread: StoredThread): ThreadComment => thread.comments[thread.comments.length - 1]!;
  const stateOf = (thread: StoredThread): 'open' | 'resolved' =>
    thread.resolvedAt !== null && thread.resolvedAt > lastOf(thread).createdAt ? 'resolved' : 'open';

  const publicThread = (thread: StoredThread): Thread => ({
    id: thread.id,
    subject: thread.subject,
    state: stateOf(thread),
    openedBy: thread.openedBy,
    lastComment: { side: lastOf(thread).side, at: lastOf(thread).createdAt, excerpt: lastOf(thread).body.slice(0, 120) },
    commentCount: thread.comments.length,
    resolvedBy: stateOf(thread) === 'resolved' ? thread.resolvedBy : null,
    resolvedAt: stateOf(thread) === 'resolved' ? thread.resolvedAt : null
  });

  const commentOf = (side: ConversationSide, body: string, createdAt: string): ThreadComment => ({
    id: nextId(), body, side, author: people[side], createdAt
  });

  const seed = (subject: ThreadSubject, comments: readonly SeedComment[], resolved?: { at: string; by: string | null }): string => {
    const first = comments[0]!;
    const thread: StoredThread = {
      id: nextId(),
      subject,
      openedBy: { name: people[first.side].name, side: first.side },
      comments: comments.map((comment) => commentOf(comment.side, comment.body, comment.at)),
      resolvedAt: resolved?.at ?? null,
      resolvedBy: resolved === undefined ? null : { name: resolved.by }
    };
    threads.unshift(thread);
    return thread.id;
  };

  const page = <T,>(items: T[], url: URL, defaultSize: number) => {
    const pageSize = Number(url.searchParams.get('pageSize') ?? defaultSize);
    const number = Number(url.searchParams.get('page') ?? 1);
    return {
      data: items.slice((number - 1) * pageSize, number * pageSize),
      meta: { page: number, pageSize, totalItems: items.length, totalPages: Math.ceil(items.length / pageSize) }
    };
  };

  /** A write the next request should fail with, once. */
  let failure: (() => Response) | undefined;
  const failNextWrite = (make: () => Response): void => { failure = make; };

  const base = options.side === 'agency'
    ? '/agencies/[^/]+/clients/' + options.clientId
    : '/clients/' + options.clientId;
  const threadsRoute = new RegExp(`^${base}/threads$`);
  const commentsRoute = new RegExp(`^${base}/threads/([^/]+)/comments$`);
  const resolveRoute = new RegExp(`^${base}/threads/([^/]+)/resolve$`);

  /** `undefined` means the path is not a conversation route. */
  const handle = (url: URL, method: string, rawBody: unknown): Response | undefined => {
    const path = url.pathname;
    const isThreads = threadsRoute.test(path);
    const comments = commentsRoute.exec(path);
    const resolve = resolveRoute.exec(path);
    if (!isThreads && comments === null && resolve === null) return undefined;
    calls.push(`${method} ${path}${url.search}`);
    const writing = method === 'POST';
    if (writing) bodies.push(rawBody);
    if (writing && failure !== undefined) { const make = failure; failure = undefined; return make(); }

    if (isThreads && method === 'GET') {
      const query = ThreadListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      const subject = query.success ? threadSubjectOfQuery(query.data) : undefined;
      if (subject === undefined) return apiError(400, 'VALIDATION_ERROR');
      // Like the API: the latest activity first; the sort is stable, so a tie keeps the newest thread first.
      const matching = threads
        .filter((thread) => sameSubject(thread.subject, subject))
        .filter((thread) => query.data?.state === undefined || stateOf(thread) === query.data.state)
        .sort((left, right) => lastOf(right).createdAt.localeCompare(lastOf(left).createdAt))
        .map(publicThread);
      return json(page(matching, url, options.pageSize ?? 20));
    }
    if (isThreads && writing) {
      const parsed = CreateThreadRequestSchema.safeParse(rawBody);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR');
      const id = seed(parsed.data.subject, [{ side: options.side, body: parsed.data.body, at: tick() }]);
      const thread = threads.find((item) => item.id === id)!;
      return json({ thread: publicThread(thread), comment: lastOf(thread) }, 201);
    }
    const thread = threads.find((item) => item.id === (comments?.[1] ?? resolve?.[1]));
    if (thread === undefined) return apiError(404, 'NOT_FOUND', 'Thread not found.');
    if (comments !== null && method === 'GET') return json(page(thread.comments, url, 50));
    if (comments !== null && writing) {
      const parsed = CreateCommentRequestSchema.safeParse(rawBody);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR');
      const comment = commentOf(options.side, parsed.data.body, tick());
      thread.comments.push(comment);
      return json(comment, 201);
    }
    if (resolve !== null && writing && options.side === 'agency') {
      thread.resolvedAt = tick();
      thread.resolvedBy = { name: people.agency.name };
      return json(publicThread(thread));
    }
    return apiError(404, 'NOT_FOUND');
  };

  return { handle, seed, failNextWrite, calls, bodies, threads };
};
