import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { PortalContentMediaUrlResponseSchema, type ContentFormat, type PortalContentMediaUrlResponse } from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import { FormatShape, isHttpUrl } from './content-cover.js';
import { useApiClient } from './http.js';
import { signedUrlStaleTime } from './signed-url.js';
import { useSeen } from './use-seen.js';

const MEDIA_URL_PATH = '/clients/:clientId/contents/:contentId/media/:assetId/url';

/**
 * The cover of a content in the portal. The signed URL is the portal's own route for the media of a content the person can read
 * (issue #584), asked as a thumbnail and only once the element was on screen. A content with no cover, and any refusal of the
 * route, leave the shape of the format.
 */
export function PortalContentCover({ clientId, contentId, assetId, format, className }: {
  clientId: string;
  contentId: string;
  assetId: string | null;
  format: ContentFormat;
  className: string;
}) {
  const httpClient = useApiClient();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const cover = useQuery<PortalContentMediaUrlResponse>({
    queryKey: ['portal', clientId, 'contents', 'cover', contentId, assetId],
    enabled: assetId !== null && seen,
    staleTime: signedUrlStaleTime,
    queryFn: ({ signal }) => {
      if (assetId === null) throw new Error('A cover is only read for a content that has one.');
      return httpClient.request({
        path: `${apiPath(MEDIA_URL_PATH, { clientId, contentId, assetId })}?variant=thumbnail`,
        response: PortalContentMediaUrlResponseSchema,
        signal
      });
    }
  });
  const url = cover.data?.url;
  const usable = url !== undefined && isHttpUrl(url) && broken !== url;
  return <div ref={ref} className={`${className}${usable ? '' : ` ${className}--placeholder`}`}>
    {usable
      ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
      : <FormatShape format={format} />}
  </div>;
}
