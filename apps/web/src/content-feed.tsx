import { Clapperboard, GalleryVertical } from 'lucide-react';

import { Avatar, Skeleton } from '@ageniza/ui';
import type { ContentFormat, ContentListItem, ContentStatus } from '@ageniza/contracts';

import { ContentCover } from './content-cover.js';
import { dayMonthLabel } from './content-dates.js';
import { FORMAT_LABELS } from './content-labels.js';

/** What the tile says about the state: shorter than the card's own words, and always with the colour of the dot beside it. */
const TILE_STATUS_LABELS: Readonly<Record<ContentStatus, string>> = {
  in_production: 'Produção',
  awaiting_approval: 'Aguardando',
  adjusting: 'Em ajuste',
  approved: 'Pronto',
  published: 'Publicado',
  cancelled: 'Cancelado'
};

/** The grid is 3 columns wide; the empty one draws three rows of them so the person sees where the first post goes. */
const EMPTY_TILES = 9;

/** Long videos and VSLs are not posts of the feed: they live in the calendar only (specs/conteudo.md section 7). */
export const FEED_FORMATS: ReadonlySet<ContentFormat> = new Set<ContentFormat>(['image', 'carousel', 'reels']);

/** A content with no time counts as the end of its day, as the calendar's own order does. */
const timeKey = (content: ContentListItem): string => content.publishAtTime ?? '99:99';

/**
 * The posts of the grid, the latest first: feed formats only, no cancelled one, by day and time, and a tie goes to the
 * larger id, so the grid is the calendar's order read backwards.
 */
export const feedItems = (contents: readonly ContentListItem[]): ContentListItem[] => contents
  .filter((content) => FEED_FORMATS.has(content.format) && content.status !== 'cancelled')
  .sort((a, b) => {
    if (a.publishOn !== b.publishOn) return a.publishOn < b.publishOn ? 1 : -1;
    if (timeKey(a) !== timeKey(b)) return timeKey(a) < timeKey(b) ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

/** The shape of the grid while the first period loads: decorative, never announced. */
export function ContentFeedSkeleton() {
  return <ol className="content-feed__grid" aria-hidden="true">
    {Array.from({ length: EMPTY_TILES }, (_value, index) => <li key={index} className="content-feed__tile"><Skeleton className="content-feed__skeleton" /></li>)}
  </ol>;
}

export interface ContentFeedProfile {
  readonly name: string;
  readonly photoUrl: string | null;
}

/** The counters of the profile are the period on screen: what the grid shows, what is ready and what waits for the client. */
const countOf = (items: readonly ContentListItem[], status: ContentStatus): number => items.filter((content) => content.status === status).length;

/**
 * The grid of the Instagram profile of the client (`specs/conteudo.md` section 7), for the period on screen. A tile is the
 * cover, or the shape of the format when there is none, with the state of the post and a mark on what is still planned; what
 * it says in words is for who does not see the picture. `profile` adds the avatar and the counters above the grid. Every text
 * from the server is a React text child.
 */
export function ContentFeed({ contents, today, handle, profile }: {
  contents: readonly ContentListItem[];
  today: string;
  handle: string | null;
  profile?: ContentFeedProfile;
}) {
  const items = feedItems(contents);
  const ready = countOf(items, 'approved');
  return <div className="content-feed">
    {handle !== null && <p className="content-feed__handle">@{handle}</p>}
    {profile !== undefined && <div className="content-feed__profile">
      <Avatar name={profile.name} photoUrl={profile.photoUrl} size="lg" />
      <dl className="content-feed__counters">
        <div><dt>no período</dt><dd>{items.length}</dd></div>
        <div><dt>{ready === 1 ? 'pronto' : 'prontos'}</dt><dd>{ready}</dd></div>
        <div><dt>aguardando</dt><dd>{countOf(items, 'awaiting_approval')}</dd></div>
      </dl>
    </div>}
    {items.length === 0
      ? <>
        <ol className="content-feed__grid content-feed__grid--empty" aria-hidden="true">
          {Array.from({ length: EMPTY_TILES }, (_value, index) => <li key={index} className="content-feed__tile content-feed__tile--empty" />)}
        </ol>
        <p className="content-feed__empty">Planeje o primeiro post</p>
      </>
      : <ol className="content-feed__grid">
        {items.map((content) => <li key={content.id} className="content-feed__tile" data-status={content.status}>
          <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-feed__cover" />
          <span className="content-feed__status"><span className="content-feed__dot" aria-hidden="true" />{TILE_STATUS_LABELS[content.status]}</span>
          {content.format === 'reels' && <Clapperboard className="content-feed__format" aria-hidden="true" />}
          {content.format === 'carousel' && <GalleryVertical className="content-feed__format" aria-hidden="true" />}
          {content.publishOn > today && <span className="content-feed__planned">Planejado</span>}
          <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}</span>
        </li>)}
      </ol>}
  </div>;
}
