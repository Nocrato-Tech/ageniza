import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Image as ImageIcon, Music, Shapes, Video } from 'lucide-react';

import { MediaDownloadUrlResponseSchema, type MediaDownloadUrlResponse, type MediaLibraryCategory } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { signedUrlStaleTime } from './signed-url.js';
import { useSeen } from './use-seen.js';

export const MEDIA_GLYPHS: Readonly<Record<MediaLibraryCategory, ReactNode>> = {
  image: <ImageIcon />, video: <Video />, pdf: <FileText />, audio: <Music />, logo: <Shapes />
};

/** A PDF and an audio have no thumbnail to ask for: the shape of the type is all they show. */
const HAS_THUMBNAIL: ReadonlySet<MediaLibraryCategory> = new Set(['image', 'video', 'logo']);

/** The contract validates the URL; a response is untrusted input and only an http(s) address becomes an `src`. */
export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * The thumbnail of a media of a client's library (`variant=thumbnail`, which the API does not audit). The signed URL is asked
 * only once the tile was on screen; a PDF, an audio, a video whose thumbnail is not generated yet, a refusal, or an image the browser
 * cannot draw leave the shape of the type. The file is only ever an `img` source: an SVG logo is never drawn inline.
 */
export function MediaThumbnail({ assetId, category }: { assetId: string; category: MediaLibraryCategory }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const thumbnail = useQuery<MediaDownloadUrlResponse>({
    queryKey: ['agency', agency.agencyId, 'media-thumbnail', assetId],
    enabled: seen && HAS_THUMBNAIL.has(category),
    staleTime: signedUrlStaleTime,
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId })}?variant=thumbnail`,
      response: MediaDownloadUrlResponseSchema,
      signal
    })
  });
  const url = thumbnail.data?.url;
  const usable = url !== undefined && isHttpUrl(url) && broken !== url;
  return <div ref={ref} className={`media-thumbnail media-thumbnail--${category}${usable ? '' : ' media-thumbnail--placeholder'}`}>
    {usable
      ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
      : <span aria-hidden="true">{MEDIA_GLYPHS[category]}</span>}
  </div>;
}
