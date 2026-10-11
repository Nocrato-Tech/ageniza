import { useState, type KeyboardEvent, type TouchEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  PortalContentMediaUrlResponseSchema,
  type ContentFormat,
  type PortalContentMediaUrlResponse
} from '@ageniza/contracts';
import { Button, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { useSeen } from './use-seen.js';
import { useApiClient } from './http.js';
import { signedUrlStaleTime } from './signed-url.js';

const MEDIA_URL_PATH = '/clients/:clientId/contents/:contentId/media/:assetId/url';

/** A swipe shorter than this is a tap or a scroll, not a move to the next media. */
const SWIPE_MIN_PX = 40;

export interface PortalMediaItem {
  readonly id: string;
  readonly position: number;
  readonly kind: 'image' | 'video';
}

interface PostIds {
  readonly clientId: string;
  readonly contentId: string;
}

/** The contract validates the URL; a response is untrusted input and only an http(s) address becomes an `src`. */
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** The route signs `original` or `thumbnail` only: a video's thumbnail is its frame, an image's is the image itself. */
function usePortalMediaUrl(ids: PostIds, assetId: string, variant: 'original' | 'thumbnail', enabled: boolean) {
  const httpClient = useApiClient();
  return useQuery<PortalContentMediaUrlResponse>({
    queryKey: ['portal', ids.clientId, 'content', ids.contentId, 'media', assetId, variant],
    enabled,
    staleTime: signedUrlStaleTime,
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(MEDIA_URL_PATH, { ...ids, assetId })}?variant=${variant}`,
      response: PortalContentMediaUrlResponseSchema,
      signal
    })
  });
}

const usableUrl = (data: PortalContentMediaUrlResponse | undefined): string | undefined =>
  data !== undefined && isHttpUrl(data.url) ? data.url : undefined;

const isVideoFormat = (format: ContentFormat): boolean => format !== 'image' && format !== 'carousel';

/** The media of the current slide at full width: the API says whether the item is an image or a video (`kind`). */
function Slide({ ids, format, coverAssetId, item, position, total, title }: {
  ids: PostIds;
  format: ContentFormat;
  coverAssetId: string | null;
  item: PortalMediaItem;
  position: number;
  total: number;
  title: string;
}) {
  const asVideo = item.kind === 'video';
  const [failed, setFailed] = useState(false);
  const original = usePortalMediaUrl(ids, item.id, 'original', true);
  // The cover belongs to the video formats; any other video shows its own frame. Without a ready frame the video has no poster.
  const poster = usePortalMediaUrl(ids, isVideoFormat(format) ? (coverAssetId ?? item.id) : item.id, 'thumbnail', asVideo);
  const url = usableUrl(original.data);
  const posterUrl = usableUrl(poster.data);

  if (original.isPending) return <Skeleton className="portal-media__skeleton" aria-busy="true" />;
  if (url === undefined || failed) {
    return <div className="portal-media__problem" role="alert">
      <p>Não foi possível carregar esta mídia.</p>
      <Button variant="secondary" loading={original.isFetching} onClick={() => { setFailed(false); void original.refetch(); }}>Tentar de novo</Button>
    </div>;
  }
  const label = `${title}: mídia ${position} de ${total}`;
  if (asVideo) {
    return <video
      className="portal-media__item"
      src={url}
      poster={posterUrl}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      onError={() => setFailed(true)}
    />;
  }
  return <img
    className="portal-media__item"
    src={url}
    alt={label}
    onError={() => setFailed(true)}
  />;
}

/** The small picture that jumps to a media; it is asked for only once it was on screen. */
function Thumb({ ids, assetId, number, total, active, onSelect }: {
  ids: PostIds;
  assetId: string;
  number: number;
  total: number;
  active: boolean;
  onSelect: () => void;
}) {
  const [ref, seen] = useSeen<HTMLLIElement>();
  const [broken, setBroken] = useState<string | null>(null);
  const thumbnail = usePortalMediaUrl(ids, assetId, 'thumbnail', seen);
  const url = usableUrl(thumbnail.data);
  return <li ref={ref}>
    <button
      type="button"
      className="portal-media__thumb"
      aria-label={`Ver mídia ${number} de ${total}`}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
    >
      {url !== undefined && broken !== url
        ? <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} />
        : <span aria-hidden="true">{number}</span>}
    </button>
  </li>;
}

/**
 * The media of the post, one at a time and as wide as the screen: Anterior and Próxima, the arrow keys, Home and End, and a
 * swipe all move it, and the strip below jumps straight to one. The cover and the thumbnails are the `thumbnail` variant;
 * the slide itself is the original.
 */
export function PortalMediaCarousel({ ids, format, coverAssetId, media, title }: {
  ids: PostIds;
  format: ContentFormat;
  coverAssetId: string | null;
  media: readonly PortalMediaItem[];
  title: string;
}) {
  const items = [...media].sort((left, right) => left.position - right.position);
  const [index, setIndex] = useState(0);
  const [swipeFrom, setSwipeFrom] = useState<number | null>(null);
  const total = items.length;
  const current = Math.min(index, total - 1);
  const item = items[current];
  if (item === undefined) return <p className="portal-media__empty">Este conteúdo ainda não tem mídia.</p>;

  const move = (target: number): void => { setIndex(Math.max(0, Math.min(total - 1, target))); };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The arrows of a video's own controls seek inside it; they are not for the carousel.
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === 'ArrowRight') move(current + 1);
    else if (event.key === 'ArrowLeft') move(current - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(total - 1);
    else return;
    event.preventDefault();
  };

  const onTouchStart = (event: TouchEvent<HTMLElement>): void => {
    setSwipeFrom(event.touches.length === 1 ? (event.touches[0]?.clientX ?? null) : null);
  };
  const onTouchEnd = (event: TouchEvent<HTMLElement>): void => {
    const end = event.changedTouches[0]?.clientX;
    const from = swipeFrom;
    setSwipeFrom(null);
    if (from === null || end === undefined || Math.abs(end - from) < SWIPE_MIN_PX) return;
    move(end < from ? current + 1 : current - 1);
  };

  return <section
    className="portal-media"
    aria-roledescription="carrossel"
    aria-label="Mídias do post"
    tabIndex={0}
    onKeyDown={onKeyDown}
    onTouchStart={onTouchStart}
    onTouchEnd={onTouchEnd}
  >
    <div className="portal-media__stage">
      <Slide key={item.id} ids={ids} format={format} coverAssetId={coverAssetId} item={item} position={current + 1} total={total} title={title} />
    </div>
    {total > 1 && <>
      <div className="portal-media__controls">
        <Button variant="secondary" disabled={current === 0} onClick={() => { move(current - 1); }}><span aria-hidden="true">‹ </span>Anterior</Button>
        <p className="portal-media__counter" aria-live="polite">{current + 1} de {total}</p>
        <Button variant="secondary" disabled={current === total - 1} onClick={() => { move(current + 1); }}>Próxima<span aria-hidden="true"> ›</span></Button>
      </div>
      <ul className="portal-media__strip" aria-label="Miniaturas das mídias">
        {items.map((entry, position) => <Thumb
          key={entry.id}
          ids={ids}
          assetId={entry.id}
          number={position + 1}
          total={total}
          active={position === current}
          onSelect={() => { move(position); }}
        />)}
      </ul>
    </>}
  </section>;
}
