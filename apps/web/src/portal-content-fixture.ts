import {
  CommentBodySchema,
  PortalApproveContentRequestSchema,
  PortalContentMediaUrlQuerySchema,
  PortalRequestContentChangesRequestSchema,
  type ContentFormat
} from '@ageniza/contracts';

import type { createConversationApi } from './conversation-fixture.js';

/**
 * A stateful stand-in for the content routes of the portal (#257, #584), answering as the API does: a content of another client, a
 * cancelled one and one that does not exist are the same 404; the post of a content in production is the strict shape without caption
 * or media; approving checks the revision the person read against the one stored (409), a state that is not "aguardando aprovação"
 * (409, except approving what is already approved, which is a 200), and a request for changes writes the comment into the conversation
 * of the content. The revision it compares with is its own, never handed in by the screen.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const portalContentError = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => json({ error: { code, message } }, status);

export type PortalContentState = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';

export interface PortalContentRow {
  readonly id: string;
  readonly clientId: string;
  title: string;
  format: ContentFormat;
  publishOn: string;
  publishAtTime: string | null;
  state: PortalContentState;
  caption: string | null;
  revision: number;
  coverAssetId: string | null;
  media: Array<{ id: string; position: number; kind: 'image' | 'video' }>;
  publishedOn: string | null;
}

export type PortalContentSeed = Partial<PortalContentRow> & Pick<PortalContentRow, 'id' | 'clientId'>;

type ConversationApi = ReturnType<typeof createConversationApi>;

export const createPortalContentsApi = (
  viewerClientId: string,
  conversation: ConversationApi,
  mediaUrl: (assetId: string, variant: string) => string = (assetId, variant) => `https://storage.test/${assetId}/${variant}`
) => {
  const rows = new Map<string, PortalContentRow>();
  const calls: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];
  const mediaRequests: Array<{ assetId: string; variant: string }> = [];
  let failure: ((path: string) => Response | undefined) | undefined;

  const seed = (input: PortalContentSeed): PortalContentRow => {
    const row: PortalContentRow = {
      title: 'Lançamento da primavera',
      format: 'image',
      publishOn: '2026-10-12',
      publishAtTime: null,
      state: 'awaiting_approval',
      caption: 'Legenda do post',
      revision: 1,
      coverAssetId: null,
      media: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', position: 1, kind: ['image', 'carousel'].includes(input.format ?? 'image') ? 'image' : 'video' }],
      publishedOn: null,
      ...input
    };
    rows.set(row.id, row);
    return row;
  };

  const detailOf = (row: PortalContentRow): Record<string, unknown> => row.state === 'in_production'
    ? { id: row.id, title: row.title, format: row.format, publishOn: row.publishOn, status: 'in_production' }
    : {
      id: row.id,
      title: row.title,
      platform: 'instagram',
      format: row.format,
      publishOn: row.publishOn,
      publishAtTime: row.publishAtTime,
      status: row.state,
      coverAssetId: row.coverAssetId,
      publishedOn: row.publishedOn,
      caption: row.caption,
      revision: row.revision,
      media: row.media
    };

  // What the portal can read: its own client's, and never a cancelled one.
  const visible = (id: string): PortalContentRow | undefined => {
    const row = rows.get(id);
    return row !== undefined && row.clientId === viewerClientId && row.state !== 'cancelled' ? row : undefined;
  };

  const notFound = (): Response => portalContentError(404, 'NOT_FOUND', 'Content not found.');

  const route = new RegExp(`^/clients/${viewerClientId}/contents/([^/]+)(?:/(approve|request-changes)|/media/([^/]+)/url)?$`);

  /** `undefined` means the path is not a content route of the portal. */
  const handle = (url: URL, method: string, rawBody: unknown): Response | undefined => {
    const match = route.exec(url.pathname);
    if (match === null) return undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (method === 'POST') bodies.push({ path: url.pathname, body: rawBody });
    const failed = method === 'POST' ? failure?.(url.pathname) : undefined;
    if (failed !== undefined) { failure = undefined; return failed; }
    const [, id = '', action, assetId] = match;
    const row = visible(id);

    if (assetId !== undefined) {
      if (row === undefined || row.state === 'in_production') return notFound();
      const query = PortalContentMediaUrlQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return portalContentError(400, 'VALIDATION_ERROR');
      const belongs = row.media.some((item) => item.id === assetId) || row.coverAssetId === assetId;
      if (!belongs) return portalContentError(404, 'NOT_FOUND', 'Media asset not found.');
      mediaRequests.push({ assetId, variant: query.data.variant });
      return json({ url: mediaUrl(assetId, query.data.variant), expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (action === undefined && method === 'GET') return row === undefined ? notFound() : json(detailOf(row));
    if (action === undefined || method !== 'POST') return portalContentError(404, 'NOT_FOUND');

    if (action === 'approve') {
      const body = PortalApproveContentRequestSchema.safeParse(rawBody);
      if (!body.success) return portalContentError(400, 'VALIDATION_ERROR');
      if (row === undefined) return notFound();
      if (row.state === 'approved') return json(detailOf(row));
      if (row.state !== 'awaiting_approval') return portalContentError(409, 'CONTENT_NOT_AWAITING_APPROVAL');
      if (body.data.revision !== row.revision) return portalContentError(409, 'CONTENT_REVISION_CHANGED');
      row.state = 'approved';
      return json(detailOf(row));
    }
    const body = PortalRequestContentChangesRequestSchema.safeParse(rawBody);
    if (!body.success) return portalContentError(400, 'VALIDATION_ERROR');
    if (row === undefined) return notFound();
    if (row.state !== 'awaiting_approval') return portalContentError(409, 'CONTENT_NOT_AWAITING_APPROVAL');
    if (body.data.revision !== row.revision) return portalContentError(409, 'CONTENT_REVISION_CHANGED');
    row.state = 'adjusting';
    conversation.seed({ contentId: row.id }, [{ side: 'client', body: CommentBodySchema.parse(body.data.comment), at: '2026-10-13T01:30:00.000Z' }]);
    return json(detailOf(row));
  };

  return {
    handle,
    seed,
    rows,
    calls,
    bodies,
    mediaRequests,
    /** The agency edited the caption: the revision moves on, and anyone holding the old one is refused. */
    editCaption: (id: string, caption: string): void => { const row = rows.get(id)!; row.caption = caption; row.revision += 1; },
    setState: (id: string, state: PortalContentState): void => { rows.get(id)!.state = state; },
    failNextWrite: (make: (path: string) => Response | undefined): void => { failure = make; }
  };
};
