import { useState, type ReactNode } from 'react';
import { CalendarX, ChevronLeft, ChevronRight, Clapperboard, GalleryVertical } from 'lucide-react';

import { Avatar, IconButton, Skeleton } from '@ageniza/ui';
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

/** The grid is three columns by three rows, nine posts a page, like the profile it previews: a page never has a blank corner. */
export const FEED_PAGE_SIZE = 9;

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

/** A slot with nothing in it: the frame and the "nothing on this day" icon, so the grid is never left with blank space. */
function EmptySlots({ count }: { count: number }) {
  return <>
    {Array.from({ length: count }, (_value, index) => <li key={index} className="content-feed__slot" aria-hidden="true" title="Nada neste dia">
      <CalendarX />
    </li>)}
  </>;
}

/** The device the profile is drawn on: a bezel, the camera island and the home bar, around whatever the screen holds. The approval link draws a post on it. */
export function Phone({ children }: { children: ReactNode }) {
  return <div className="content-phone">
    <div className="content-phone__screen">
      <span className="content-phone__island" aria-hidden="true" />
      {children}
      <span className="content-phone__home" aria-hidden="true" />
    </div>
  </div>;
}

/** The shape of the grid while the first period loads: decorative, never announced. */
export function ContentFeedSkeleton() {
  return <Phone>
    <div className="content-feed">
      <ol className="content-feed__grid" aria-hidden="true">
        {Array.from({ length: FEED_PAGE_SIZE }, (_value, index) => <li key={index} className="content-feed__tile"><Skeleton className="content-feed__skeleton" /></li>)}
      </ol>
    </div>
  </Phone>;
}

export interface ContentFeedProfile {
  readonly name: string;
  readonly photoUrl: string | null;
}

/** The counters of the profile are the period on screen: what the grid shows, what is ready and what waits for the client. */
const countOf = (items: readonly ContentListItem[], status: ContentStatus): number => items.filter((content) => content.status === status).length;

/**
 * The Instagram profile of the client (`specs/conteudo.md` section 7) drawn on a phone, for the period on screen: the
 * posts nine to a page, newest first. A tile is the cover, or the shape of the format when there is none, with the state
 * of the post and a mark on what is still planned; what it says in words is for who does not see the picture. A page
 * that is not full ends in empty slots. `profile` adds the avatar and the counters above the grid. Every text from the
 * server is a React text child. The page belongs to the `scope` it was chosen in (the client and the period on
 * screen): another scope starts on its first page, without remounting the tiles, which would read their covers again.
 */
export function ContentFeed({ contents, today, handle, profile, scope }: {
  contents: readonly ContentListItem[];
  today: string;
  handle: string | null;
  profile?: ContentFeedProfile;
  scope: string;
}) {
  const [chosen, choose] = useState({ scope, page: 1 });
  // Another scope forgets the page at once, so coming back to a period never finds the page it was left on.
  if (chosen.scope !== scope) choose({ scope, page: 1 });
  const setPage = (next: number): void => choose({ scope, page: next });
  const items = feedItems(contents);
  const ready = countOf(items, 'approved');
  const pages = Math.max(1, Math.ceil(items.length / FEED_PAGE_SIZE));
  const page = Math.min(chosen.page, pages);
  const first = (page - 1) * FEED_PAGE_SIZE;
  const shown = items.slice(first, first + FEED_PAGE_SIZE);
  const atStart = page === 1;
  const atEnd = page === pages;

  return <Phone>
    <div className="content-feed">
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
            <EmptySlots count={FEED_PAGE_SIZE} />
          </ol>
          <p className="content-feed__empty">Planeje o primeiro post</p>
        </>
        : <>
          <ol className="content-feed__grid">
            {shown.map((content) => <li key={content.id} className="content-feed__tile" data-status={content.status}>
              <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-feed__cover" />
              <span className="content-feed__status"><span className="content-feed__dot" aria-hidden="true" />{TILE_STATUS_LABELS[content.status]}</span>
              {content.format === 'reels' && <Clapperboard className="content-feed__format" aria-hidden="true" />}
              {content.format === 'carousel' && <GalleryVertical className="content-feed__format" aria-hidden="true" />}
              {content.publishOn > today && <span className="content-feed__planned">Planejado</span>}
              <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}</span>
            </li>)}
            <EmptySlots count={FEED_PAGE_SIZE - shown.length} />
          </ol>
          <nav className="content-feed__pager" aria-label="Páginas do feed">
            {/* `aria-disabled`, not `disabled`: the button that was just pressed keeps the keyboard focus when it reaches an end. */}
            <IconButton label="Página anterior" icon={<ChevronLeft />} aria-disabled={atStart || undefined} onClick={() => { if (!atStart) setPage(page - 1); }} />
            <p className="content-feed__range" aria-live="polite">{shown.length === 1 ? first + 1 : `${first + 1}–${first + shown.length}`} de {items.length}</p>
            <IconButton label="Próxima página" icon={<ChevronRight />} aria-disabled={atEnd || undefined} onClick={() => { if (!atEnd) setPage(page + 1); }} />
          </nav>
        </>}
    </div>
  </Phone>;
}
