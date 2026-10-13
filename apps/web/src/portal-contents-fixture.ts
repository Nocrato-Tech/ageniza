import type { ContentFormat } from '@ageniza/contracts';

import { daysBetween } from './content-dates.js';

/**
 * The contents routes of the portal (#257, #584) as the API answers them, for the screens of the portal. What the API refuses it
 * refuses here too (the period without both ends, past 93 days, `variant=preview`, a page size over 100, a content of another
 * client or one in production for a media), and what only the agency knows (caption, time, cover, owner) is stored on the row but
 * leaves only in the shape the API gives: a content in production is five keys, and nothing the test seeds can widen it.
 */
export type PortalContentStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published';

export interface PortalContentRow {
  id: string;
  title: string;
  format: ContentFormat;
  publishOn: string;
  publishAtTime: string | null;
  status: PortalContentStatus;
  coverAssetId: string | null;
  thumbnailAssetId: string | null;
  caption: string | null;
  publishedOn: string | null;
  cancelled: boolean;
}

export type PortalContentSeed = Partial<PortalContentRow> & { publishOn: string };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const contentsError = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => json({ error: { code, message } }, status);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_CEILING_DAYS = 93;
const AWAITING_DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_CEILING = 100;

const byPlan = (a: PortalContentRow, b: PortalContentRow): number =>
  a.publishOn.localeCompare(b.publishOn) || (a.publishAtTime ?? '￿').localeCompare(b.publishAtTime ?? '￿') || a.id.localeCompare(b.id);

export const createPortalContentsApi = (clientId: string) => {
  const rows: PortalContentRow[] = [];
  const calls: string[] = [];
  let sequence = 0;
  const state: {
    /** The period answers this instead, until cleared. */
    failPeriod: (() => Response) | null;
    failAwaiting: (() => Response) | null;
    /** The media of this asset answers this instead, until cleared. */
    failMedia: Map<string, () => Response>;
    holdPeriod: Promise<void> | null;
    /** What no answer of the API would carry: a content in production with its caption, time and cover. */
    leakInProduction: boolean;
    /** What the media route signs: an address that is not http(s). */
    mediaUrl: ((assetId: string, variant: string) => string) | null;
  } = { failPeriod: null, failAwaiting: null, failMedia: new Map(), holdPeriod: null, leakInProduction: false, mediaUrl: null };

  const seed = (row: PortalContentSeed): PortalContentRow => {
    sequence += 1;
    const made: PortalContentRow = {
      id: `c0c0c0c0-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      title: `Conteúdo ${sequence}`,
      format: 'reels',
      publishAtTime: null,
      status: 'approved',
      coverAssetId: null,
      thumbnailAssetId: null,
      caption: null,
      publishedOn: null,
      cancelled: false,
      ...row
    };
    // As the API answers: the cover that was chosen is the file that serves as the cover, unless the test says another.
    made.thumbnailAssetId = 'thumbnailAssetId' in row ? (row.thumbnailAssetId ?? null) : (row.coverAssetId ?? null);
    rows.push(made);
    return made;
  };

  const shape = (row: PortalContentRow): Record<string, unknown> => {
    if (row.status === 'in_production') {
      const base = { id: row.id, title: row.title, format: row.format, publishOn: row.publishOn, status: row.status };
      return state.leakInProduction ? { ...base, caption: row.caption, publishAtTime: row.publishAtTime, coverAssetId: row.coverAssetId } : base;
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
      thumbnailAssetId: row.thumbnailAssetId,
      publishedOn: row.publishedOn
    };
  };

  const visible = (): PortalContentRow[] => rows.filter((row) => !row.cancelled);

  /** `undefined` means the path is not a contents route of this client. */
  const handle = (url: URL, method: string): Response | undefined | Promise<Response> => {
    const media = new RegExp(`^/clients/${clientId}/contents/([^/]+)/media/([^/]+)/url$`).exec(url.pathname);
    const awaiting = url.pathname === `/clients/${clientId}/contents/awaiting-approval`;
    const list = url.pathname === `/clients/${clientId}/contents`;
    if (!list && !awaiting && media === null) return undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (method !== 'GET') return contentsError(404, 'NOT_FOUND');

    if (list) {
      const run = async (): Promise<Response> => {
        if (state.holdPeriod !== null) await state.holdPeriod;
        if (state.failPeriod !== null) return state.failPeriod();
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from === null || to === null || !DAY.test(from) || !DAY.test(to) || from > to) return contentsError(400, 'VALIDATION_ERROR');
        if (daysBetween(from, to) + 1 > PERIOD_CEILING_DAYS) return contentsError(400, 'VALIDATION_ERROR');
        const found = visible().filter((row) => row.publishOn >= from && row.publishOn <= to).sort(byPlan);
        return json({ data: found.map(shape), meta: { from, to, count: found.length } });
      };
      return run();
    }

    if (awaiting) {
      if (state.failAwaiting !== null) return state.failAwaiting();
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? String(AWAITING_DEFAULT_PAGE_SIZE));
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_CEILING) {
        return contentsError(400, 'VALIDATION_ERROR');
      }
      const found = visible().filter((row) => row.status === 'awaiting_approval').sort(byPlan);
      return json({
        data: found.slice((page - 1) * pageSize, page * pageSize).map(shape),
        meta: { page, pageSize, totalItems: found.length, totalPages: Math.ceil(found.length / pageSize) }
      });
    }

    const [, contentId, assetId] = media!;
    const variant = url.searchParams.get('variant') ?? 'original';
    if (variant !== 'original' && variant !== 'thumbnail') return contentsError(400, 'VALIDATION_ERROR');
    const row = visible().find((candidate) => candidate.id === contentId);
    if (row === undefined || row.status === 'in_production') return contentsError(404, 'NOT_FOUND', 'Content not found.');
    if (row.thumbnailAssetId !== assetId) return contentsError(404, 'NOT_FOUND', 'Media asset not found.');
    const failure = state.failMedia.get(assetId!);
    if (failure !== undefined) return failure();
    return json({ url: state.mediaUrl?.(assetId!, variant) ?? `https://storage.test/${assetId}.png?variant=${variant}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  };

  return { handle, seed, rows, calls, state };
};
