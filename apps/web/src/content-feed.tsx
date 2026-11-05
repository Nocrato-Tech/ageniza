import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clapperboard, GalleryVertical } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { Avatar, Button, IconButton, Skeleton } from '@ageniza/ui';
import { CONTENT_FEED_PAGE_SIZE, ContentFeedResponseSchema, type ContentFormat, type ContentListItem, type ContentStatus } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useContentsAddress } from './content-address.js';
import { ContentCover } from './content-cover.js';
import { dayMonthLabel, dayMonthNameLabel } from './content-dates.js';
import { FORMAT_LABELS } from './content-labels.js';
import { useApiClient } from './http.js';

/** What the tile says about the state: shorter than the card's own words, and always with the colour of the dot beside it. */
const TILE_STATUS_LABELS: Readonly<Record<ContentStatus, string>> = {
  in_production: 'Produção',
  awaiting_approval: 'Aguardando',
  adjusting: 'Em ajuste',
  approved: 'Pronto',
  published: 'Publicado',
  cancelled: 'Cancelado'
};

/**
 * The phone beside the calendar loads the feed of the client nine posts at a time (the API's page, three rows of the grid of a
 * profile); the last row may be short, as on a real one. Also the number of shapes the grid draws while the first page loads.
 */
export const FEED_PAGE_SIZE = CONTENT_FEED_PAGE_SIZE;

/** The feed on its own screen has the whole period to show: ten rows of three a page, and no blank corner is drawn. */
export const FULL_FEED_PAGE_SIZE = 30;

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

/**
 * The device the profile is drawn on: a bezel, the camera island and the home bar, around whatever the screen holds. The
 * approval link draws a post on it. `fixed` gives the screen a height of its own, for a feed that scrolls inside it.
 */
export function Phone({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return <div className={fixed ? 'content-phone content-phone--fixed' : 'content-phone'}>
    <div className="content-phone__screen">
      <span className="content-phone__island" aria-hidden="true" />
      {children}
      <span className="content-phone__home" aria-hidden="true" />
    </div>
  </div>;
}

/** The feed on its own screen: the profile and its grid on the page itself, with no device around them. */
function FullFrame({ children }: { children: ReactNode }) {
  return <div className="content-feed-full">{children}</div>;
}

export interface ContentFeedProfile {
  readonly name: string;
  readonly photoUrl: string | null;
}

/** What the profile counts: the posts of the feed, the ones that are ready and the ones that wait for the client. */
interface FeedCounters {
  readonly posts: number;
  readonly approved: number;
  readonly awaitingApproval: number;
}

/** The counters of the profile. On the phone they are the whole feed of the client and come from the API ("posts"); on the full feed, the period on screen ("no período"). */
function FeedProfile({ profile, counters, full }: { profile: ContentFeedProfile; counters: FeedCounters | undefined; full: boolean }) {
  return <div className="content-feed__profile">
    <Avatar name={profile.name} photoUrl={profile.photoUrl} size="lg" />
    {full && <p className="content-feed__name">{profile.name}</p>}
    {counters !== undefined && <dl className="content-feed__counters">
      <div><dt>{full ? 'no período' : counters.posts === 1 ? 'post' : 'posts'}</dt><dd>{counters.posts}</dd></div>
      <div><dt>{counters.approved === 1 ? 'pronto' : 'prontos'}</dt><dd>{counters.approved}</dd></div>
      <div><dt>aguardando</dt><dd>{counters.awaitingApproval}</dd></div>
    </dl>}
  </div>;
}

/** One post of the grid: the cover, the state, the day and a link to the content, which keeps the query and the state of the screen. */
function FeedTile({ content, address, today }: { content: ContentListItem; address: string; today: string }) {
  const location = useLocation();
  return <li className="content-feed__tile" data-status={content.status}>
    <Link
      className="content-feed__link"
      to={{ pathname: `${address}/${content.id}`, search: location.search }}
      state={location.state}
    >
      <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-feed__cover" />
      <span className="content-feed__status"><span className="content-feed__dot" aria-hidden="true" />{TILE_STATUS_LABELS[content.status]}</span>
      {content.format === 'reels' && <Clapperboard className="content-feed__format" aria-hidden="true" />}
      {content.format === 'carousel' && <GalleryVertical className="content-feed__format" aria-hidden="true" />}
      <span className="content-feed__tags">
        <time className="content-feed__date" dateTime={content.publishOn}>{dayMonthNameLabel(content.publishOn)}</time>
        {content.publishOn > today && <span className="content-feed__planned">Planejado</span>}
      </span>
      <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}</span>
    </Link>
  </li>;
}

/** The counters of a list of posts, read from the list itself: the full feed counts the period it shows. */
const countOf = (items: readonly ContentListItem[], status: ContentStatus): number => items.filter((content) => content.status === status).length;

/**
 * The Instagram profile of the client (`specs/conteudo.md` section 7) on its own screen, for the period on screen: the
 * posts thirty to a page, newest first, with no device around them. A tile is the cover, or the shape of the format when
 * there is none, with the state of the post and a mark on what is still planned; what it says in words is for who does
 * not see the picture. `profile` adds the avatar and the counters above the grid. Every text from the server is a React
 * text child. The page belongs to the `scope` it was chosen in (the client and the period on screen): another scope starts
 * on its first page, without remounting the tiles, which would read their covers again. The phone beside the calendar is
 * `ContentPhoneFeed`, which is not by period.
 */
export function ContentFeed({ onCreate, clientId, contents, today, handle, profile, scope }: {
  /** The way to plan the first post, for who may create one: absent for who may not. */
  onCreate?: (() => void) | undefined;
  clientId: string;
  contents: readonly ContentListItem[];
  today: string;
  handle: string | null;
  profile?: ContentFeedProfile;
  scope: string;
}) {
  const address = useContentsAddress(clientId);
  const [chosen, choose] = useState({ scope, page: 1 });
  // Another scope forgets the page at once, so coming back to a period never finds the page it was left on.
  if (chosen.scope !== scope) choose({ scope, page: 1 });
  const setPage = (next: number): void => choose({ scope, page: next });
  const items = feedItems(contents);
  const pages = Math.max(1, Math.ceil(items.length / FULL_FEED_PAGE_SIZE));
  const page = Math.min(chosen.page, pages);
  const first = (page - 1) * FULL_FEED_PAGE_SIZE;
  const shown = items.slice(first, first + FULL_FEED_PAGE_SIZE);
  const atStart = page === 1;
  const atEnd = page === pages;

  return <FullFrame>
    <div className="content-feed">
      {handle !== null && <p className="content-feed__handle">@{handle}</p>}
      {profile !== undefined && <FeedProfile
        full
        profile={profile}
        counters={{ posts: items.length, approved: countOf(items, 'approved'), awaitingApproval: countOf(items, 'awaiting_approval') }}
      />}
      {items.length === 0
        ? <div className="content-feed__empty">
          <p>Nenhum post planejado neste período.</p>
          {onCreate !== undefined && <Button variant="secondary" onClick={onCreate}>Planejar um post</Button>}
        </div>
        : <>
          <ol className="content-feed__grid">
            {shown.map((content) => <FeedTile key={content.id} content={content} address={address} today={today} />)}
          </ol>
          {pages > 1 && <nav className="content-feed__pager" aria-label="Páginas do feed">
            {/* `aria-disabled`, not `disabled`: the button that was just pressed keeps the keyboard focus when it reaches an end. */}
            <IconButton label="Página anterior" icon={<ChevronLeft />} aria-disabled={atStart || undefined} onClick={() => { if (!atStart) setPage(page - 1); }} />
            <p className="content-feed__range" aria-live="polite">{shown.length === 1 ? first + 1 : `${first + 1}–${first + shown.length}`} de {items.length}</p>
            <IconButton label="Próxima página" icon={<ChevronRight />} aria-disabled={atEnd || undefined} onClick={() => { if (!atEnd) setPage(page + 1); }} />
          </nav>}
        </>}
    </div>
  </FullFrame>;
}

/** The key of the phone's feed: under the client's contents, so everything that invalidates the calendar invalidates it too. */
export const contentFeedQueryKey = (agencyId: string, clientId: string): readonly unknown[] => ['agency', agencyId, 'contents', clientId, 'feed'];

/** Without animation for who asked the system for none; the scroll then jumps. */
const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tolerance, in pixels, of a scroll position that the browser rounds. */
const EDGE_TOLERANCE = 1;

/** A screen of the phone is three rows of the grid (nine posts). */
const SCREEN_ROWS = 3;

/** How far one arrow moves: three real rows, measured from the tiles (a tile and the gap under it), at any width. With no row to measure it falls back to the height of the screen. */
const screenStep = (scroller: HTMLElement): number => {
  const tiles = scroller.querySelectorAll<HTMLElement>('.content-feed__tile');
  const first = tiles[0];
  const below = tiles[3];
  if (first === undefined || below === undefined) return scroller.clientHeight;
  const row = below.getBoundingClientRect().top - first.getBoundingClientRect().top;
  return row > 0 ? row * SCREEN_ROWS : scroller.clientHeight;
};

/**
 * The phone beside the calendar (`specs/conteudo.md` section 7): the Instagram profile of the client, whole, not the period
 * on screen. It opens on the newest post and the grid scrolls inside the screen of the device (wheel, touch, keyboard); the
 * next nine posts load as the end comes near, the API reading them by cursor. The two arrows move one screen (nine posts,
 * three rows) with a smooth scroll, or a jump for who prefers reduced motion, and are locked (`aria-disabled`, so the
 * focus stays) only at the real start or the real end of the feed. The counters of the profile are the whole feed's, read
 * from the API. A tile opens the content and keeps the query and the state of the screen; the phone stays mounted under
 * the modal, so the scroll is where it was left. A page that fails to load shows an error with a retry, and leaves the
 * arrows free, so a press tries again.
 */
export function ContentPhoneFeed({ onCreate, clientId, today, handle, profile }: {
  /** The way to plan the first post, for who may create one: absent for who may not. */
  onCreate?: (() => void) | undefined;
  clientId: string;
  today: string;
  handle: string | null;
  profile?: ContentFeedProfile;
}) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const address = useContentsAddress(clientId);
  const feed = useInfiniteQuery({
    queryKey: contentFeedQueryKey(agency.agencyId, clientId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/clients/:clientId/contents/feed', { agencyId: agency.agencyId, clientId })}${pageParam === undefined ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`,
      response: ContentFeedResponseSchema,
      signal
    }),
    getNextPageParam: (last) => last.data.nextCursor ?? undefined
  });
  const scroller = useRef<HTMLDivElement>(null);
  const waitingForPage = useRef(false);
  const [edges, setEdges] = useState({ top: true, bottom: true });

  const items = feed.data?.pages.flatMap((page) => page.data.contents) ?? [];
  // Only the first page carries them (the API leaves the other pages with `null`): the profile keeps what that one said.
  const counters = feed.data?.pages[0]?.data.counters ?? undefined;
  const more = feed.hasNextPage;
  const nextFailed = feed.isFetchNextPageError;

  const scrollOneScreen = (direction: 1 | -1): void => {
    const element = scroller.current;
    if (element === null) return;
    const top = Math.max(0, element.scrollTop + direction * screenStep(element));
    if (typeof element.scrollTo === 'function') element.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    else element.scrollTop = top;
  };

  // Where the scroll is, and whether the next nine are about to be needed: read after every render and on every scroll.
  const check = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    const top = element.scrollTop <= EDGE_TOLERANCE;
    const bottom = remaining <= EDGE_TOLERANCE;
    setEdges((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    // A screen from the end loads the next page. A failed page waits for the retry instead of looping on every scroll.
    if (element.clientHeight > 0 && remaining <= element.clientHeight && more && !feed.isFetchingNextPage && !nextFailed) void feed.fetchNextPage({ cancelRefetch: false });
  };
  useEffect(check);

  // An arrow pressed at the end of what is loaded waits for the next page and then moves one screen.
  useEffect(() => {
    if (!waitingForPage.current || feed.isFetchingNextPage) return;
    waitingForPage.current = false;
    if (!nextFailed) scrollOneScreen(1);
  }, [feed.isFetchingNextPage, nextFailed]);

  const atStart = edges.top;
  const atEnd = edges.bottom && !more;
  const down = (): void => {
    const element = scroller.current;
    if (atEnd || element === null) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= EDGE_TOLERANCE && more) {
      waitingForPage.current = true;
      if (!feed.isFetchingNextPage) void feed.fetchNextPage({ cancelRefetch: false });
      return;
    }
    scrollOneScreen(1);
  };

  return <Phone fixed>
    <div className="content-feed content-feed--scroll">
      <div className="content-feed__scroller" ref={scroller} onScroll={check} tabIndex={0} role="region" aria-label="Posts do feed">
        <div className="content-feed__scrolled">
          {handle !== null && <p className="content-feed__handle">@{handle}</p>}
          {profile !== undefined && <FeedProfile full={false} profile={profile} counters={counters} />}
          {feed.isPending && <ol className="content-feed__grid" aria-hidden="true">
            {Array.from({ length: FEED_PAGE_SIZE }, (_value, index) => <li key={index} className="content-feed__tile"><Skeleton className="content-feed__skeleton" /></li>)}
          </ol>}
          {feed.isError && feed.data === undefined && <div className="content-feed__error" role="alert">
            <p>Não foi possível carregar o feed.</p>
            <Button variant="secondary" onClick={() => { void feed.refetch(); }}>Tentar de novo</Button>
          </div>}
          {feed.data !== undefined && items.length === 0 && <div className="content-feed__empty">
            <p>Nenhum post planejado ainda.</p>
            {onCreate !== undefined && <Button variant="secondary" onClick={onCreate}>Planejar um post</Button>}
          </div>}
          {items.length > 0 && <ol className="content-feed__grid">
            {items.map((content) => <FeedTile key={content.id} content={content} address={address} today={today} />)}
          </ol>}
          {nextFailed && <div className="content-feed__error" role="alert">
            <p>Não foi possível carregar mais posts.</p>
            <Button variant="secondary" onClick={() => { void feed.fetchNextPage({ cancelRefetch: false }); }}>Tentar de novo</Button>
          </div>}
          {feed.isFetchingNextPage && <p className="content-feed__loading" role="status">Carregando mais posts…</p>}
        </div>
      </div>
      <nav className="content-feed__pager" aria-label="Rolagem do feed">
        {/* `aria-disabled`, not `disabled`: the button that was just pressed keeps the keyboard focus when it reaches an end. */}
        <IconButton label="Rolar para cima" icon={<ChevronUp />} aria-disabled={atStart || undefined} onClick={() => { if (!atStart) scrollOneScreen(-1); }} />
        <IconButton label="Rolar para baixo" icon={<ChevronDown />} aria-disabled={atEnd || undefined} onClick={down} />
      </nav>
    </div>
  </Phone>;
}
