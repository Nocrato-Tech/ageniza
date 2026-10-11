import type { MediaDownloadUrlResponse } from '@ageniza/contracts';

/** The URL is short-lived: it is kept until shortly before it expires, so the margin never hands out an expired one. */
export const URL_MARGIN_MS = 30_000;

/**
 * How long a signed URL stays fresh in the query cache: until `URL_MARGIN_MS` before its `expiresAt`. Without data the
 * query is stale at once, so the first read asks for it. Shared by every screen that draws a signed image.
 */
export const signedUrlStaleTime = (query: { state: { data: MediaDownloadUrlResponse | undefined } }): number => (
  query.state.data === undefined ? 0 : Math.max(0, Date.parse(query.state.data.expiresAt) - Date.now() - URL_MARGIN_MS)
);
