import { Skeleton } from '@ageniza/ui';
import type { ContentFormat, ContentListItem } from '@ageniza/contracts';

import { ContentCover } from './content-cover.js';
import { dayMonthLabel } from './content-dates.js';
import { FORMAT_LABELS } from './content-labels.js';

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

/**
 * The grid of the Instagram profile of the client (`specs/conteudo.md` section 7), for the period on screen. A tile is the
 * cover, or the shape of the format when there is none, with a mark on what is still planned; what it says in words is
 * for who does not see the picture. Every text from the server is a React text child.
 */
export function ContentFeed({ contents, today, handle }: { contents: readonly ContentListItem[]; today: string; handle: string | null }) {
  const items = feedItems(contents);
  return <div className="content-feed">
    {handle !== null && <p className="content-feed__handle">@{handle}</p>}
    {items.length === 0
      ? <>
        <ol className="content-feed__grid content-feed__grid--empty" aria-hidden="true">
          {Array.from({ length: EMPTY_TILES }, (_value, index) => <li key={index} className="content-feed__tile content-feed__tile--empty" />)}
        </ol>
        <p className="content-feed__empty">Planeje o primeiro post</p>
      </>
      : <ol className="content-feed__grid">
        {items.map((content) => <li key={content.id} className="content-feed__tile" data-status={content.status}>
          <ContentCover assetId={content.coverAssetId} format={content.format} className="content-feed__cover" />
          {content.publishOn > today && <span className="content-feed__planned">Planejado</span>}
          <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}</span>
        </li>)}
      </ol>}
  </div>;
}
