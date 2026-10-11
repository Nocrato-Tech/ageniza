import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MediaDownloadUrlResponseSchema, type MediaCategory, type MediaDownloadUrlResponse } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { signedUrlStaleTime } from './signed-url.js';
import { useSeen } from './use-seen.js';

const GLYPHS: Readonly<Record<MediaCategory, string>> = { image: '▣', video: '▶' };

/** The contract validates the URL; a response is untrusted input and only an http(s) address becomes an `src`. */
export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * The thumbnail of a media of a client's folder (`variant=thumbnail`, which the API does not audit). The signed URL is asked
 * only once the tile was on screen; a video whose thumbnail is not generated yet, a refusal, or an image the browser cannot
 * draw leave the shape of the category.
 */
export function MediaThumbnail({ assetId, category }: { assetId: string; category: MediaCategory }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const thumbnail = useQuery<MediaDownloadUrlResponse>({
    queryKey: ['agency', agency.agencyId, 'media-thumbnail', assetId],
    enabled: seen,
    staleTime: signedUrlStaleTime,
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId })}?variant=thumbnail`,
      response: MediaDownloadUrlResponseSchema,
      signal
    })
  });
  const url = thumbnail.data?.url;
  const usable = url !== undefined && isHttpUrl(url) && broken !== url;
  return <div ref={ref} className={`media-thumbnail${usable ? '' : ' media-thumbnail--placeholder'}`}>
    {usable
      ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
      : <span aria-hidden="true">{GLYPHS[category]}</span>}
  </div>;
}
