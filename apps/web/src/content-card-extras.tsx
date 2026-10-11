import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ContentDetailSchema, MediaDownloadUrlResponseSchema, type ContentFormat, type MediaDownloadUrlResponse } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { useApiClient } from './http.js';

/** Whether the element was ever on screen. Without `IntersectionObserver` (an old browser) it counts as seen. */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** What stands for the cover while there is none: the shape of the format, never a cover someone did not choose. */
const FORMAT_GLYPHS: Readonly<Record<ContentFormat, string>> = { image: '▣', carousel: '▤', reels: '▶', long_video: '▶', vsl: '▶' };

/** The contract validates the URL; a response is untrusted input and only an http(s) address becomes an `src`. */
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** The URL is short-lived: it stays cached until shortly before it expires, per asset, for as long as the screen is open. */
const URL_MARGIN_MS = 30_000;

/**
 * The cover of a card. The signed URL of an image is asked only once the card was on screen and only for a
 * content that has a cover; any refusal of the route (no thumbnail, removed, not allowed) leaves the placeholder.
 */
export function ContentCover({ assetId, format }: { assetId: string | null; format: ContentFormat }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const cover = useQuery<MediaDownloadUrlResponse>({
    queryKey: ['agency', agency.agencyId, 'media-cover', assetId],
    enabled: assetId !== null && seen,
    staleTime: (query) => (query.state.data === undefined ? 0 : Math.max(0, Date.parse(query.state.data.expiresAt) - Date.now() - URL_MARGIN_MS)),
    queryFn: ({ signal }) => {
      if (assetId === null) throw new Error('A cover is only read for a content that has one.');
      return httpClient.request({
        path: apiPath('/agencies/:agencyId/media/:assetId/download-url', { agencyId: agency.agencyId, assetId }),
        response: MediaDownloadUrlResponseSchema,
        signal
      });
    }
  });
  const url = cover.data?.url;
  const usable = url !== undefined && isHttpUrl(url) && broken !== url;
  return <div ref={ref} className={`content-card__cover${usable ? '' : ' content-card__cover--placeholder'}`}>
    {usable
      ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
      : <span aria-hidden="true">{FORMAT_GLYPHS[format]}</span>}
  </div>;
}

const CAPTION_EXCERPT_LENGTH = 140;

const captionExcerpt = (caption: string | null): string => {
  if (caption === null) return 'Sem legenda';
  const letters = Array.from(caption.replace(/\s+/g, ' ').trim());
  return letters.length <= CAPTION_EXCERPT_LENGTH ? letters.join('') : `${letters.slice(0, CAPTION_EXCERPT_LENGTH).join('')}…`;
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * What the calendar card cannot hold (`specs/conteudo.md` section 7): the start of the caption, the subtasks
 * and the conversation. It reads the content only while someone is pointing at it, once per content.
 */
export function ContentHoverDetail({ id, clientId, contentId }: { id: string; clientId: string; contentId: string }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const detail = useQuery({
    queryKey: ['agency', agency.agencyId, 'contents', clientId, 'detail', contentId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/contents/:contentId', { agencyId: agency.agencyId, clientId, contentId }),
      response: ContentDetailSchema,
      signal
    })
  });

  if (detail.isPending) return <div role="tooltip" id={id} className="content-card__detail"><p>Carregando detalhes…</p></div>;
  if (detail.isError) return <div role="tooltip" id={id} className="content-card__detail"><p>Não foi possível carregar os detalhes.</p></div>;

  const { caption, tasks, conversation } = detail.data;
  const delivered = tasks.filter((task) => task.status === 'delivered').length;
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const approved = tasks.length - delivered - pending;
  const subtasks = tasks.length === 0
    ? 'Sem subtarefas'
    : [
      `${approved} de ${tasks.length} aprovadas`,
      delivered > 0 ? `${delivered} ${plural(delivered, 'entregue', 'entregues')}` : null,
      pending > 0 ? `${pending} ${plural(pending, 'pendente', 'pendentes')}` : null
    ].filter((part) => part !== null).join(' · ');
  const comments = conversation.commentCount === 0
    ? 'Sem comentários'
    : `${conversation.commentCount} ${plural(conversation.commentCount, 'comentário', 'comentários')}${conversation.lastCommentAt === null ? '' : ` · último em ${formatAgencyDayMonth(conversation.lastCommentAt)}`}`;

  return <div role="tooltip" id={id} className="content-card__detail">
    <dl>
      <dt>Legenda</dt><dd>{captionExcerpt(caption)}</dd>
      <dt>Subtarefas</dt><dd>{subtasks}</dd>
      <dt>Conversa</dt><dd>{comments}</dd>
    </dl>
  </div>;
}
