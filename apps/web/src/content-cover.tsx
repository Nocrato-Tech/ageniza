import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MediaDownloadUrlResponseSchema, type ContentFormat, type MediaDownloadUrlResponse } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { signedUrlStaleTime } from './signed-url.js';
import { useSeen } from './use-seen.js';

/** What stands for the cover while there is none: the shape of the format, never a cover someone did not choose. */
export const FORMAT_GLYPHS: Readonly<Record<ContentFormat, string>> = { image: '▣', carousel: '▤', reels: '▶', long_video: '▶', vsl: '▶' };

/** The contract validates the URL; a response is untrusted input and only an http(s) address becomes an `src`. */
export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * The cover of a content, in the calendar and in the feed. The signed URL of an image is asked only once the
 * element was on screen and only for a content that has a cover; any refusal of the route (no thumbnail, removed,
 * not allowed) leaves the shape of the format. `className` places it in the card that uses it.
 */
export function ContentCover({ assetId, format, className = 'content-card__cover' }: { assetId: string | null; format: ContentFormat; className?: string }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const cover = useQuery<MediaDownloadUrlResponse>({
    queryKey: ['agency', agency.agencyId, 'media-cover', assetId],
    enabled: assetId !== null && seen,
    staleTime: signedUrlStaleTime,
    queryFn: ({ signal }) => {
      if (assetId === null) throw new Error('A cover is only read for a content that has one.');
      return httpClient.request({
        // The thumbnail is what a cover is: only the request of the original is audited (decision 2026-10-11, #550).
        path: `${apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId })}?variant=thumbnail`,
        response: MediaDownloadUrlResponseSchema,
        signal
      });
    }
  });
  const url = cover.data?.url;
  const usable = url !== undefined && isHttpUrl(url) && broken !== url;
  return <div ref={ref} className={`${className}${usable ? '' : ` ${className}--placeholder`}`}>
    {usable
      ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
      : <span aria-hidden="true">{FORMAT_GLYPHS[format]}</span>}
  </div>;
}
