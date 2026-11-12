import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Clapperboard, GalleryVertical } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { Avatar, Button, IconButton, LateBadge, StatusTag } from '@ageniza/ui';
import type { ContentFormat, ContentListItem, StoryScriptListItem } from '@ageniza/contracts';

import { useContentsAddress } from './content-address.js';
import { ContentCover } from './content-cover.js';
import { dayMonthLabel, shortDayLabel } from './content-dates.js';
import { DISPLAY_TAGS, displayState, FORMAT_LABELS, type DisplayState } from './content-labels.js';
import { StoryScriptCircles } from './story-scripts.js';

/** What the tile says about the state: shorter than the card's own words, and always in the tag of the state's colour. */
const TILE_STATE_LABELS: Readonly<Record<DisplayState, string>> = {
  in_production: 'Produção',
  awaiting_approval: 'Aguardando',
  adjusting: 'Em ajuste',
  approved: 'Pronto',
  scheduled: 'Agendado',
  late: 'Atrasado',
  published: 'Publicado',
  cancelled: 'Cancelado'
};

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
 * approval link draws a post on it.
 */
export function Phone({ children }: { children: ReactNode }) {
  return <div className="content-phone">
    <div className="content-phone__screen">
      <span className="content-phone__island" aria-hidden="true" />
      {children}
      <span className="content-phone__home" aria-hidden="true" />
    </div>
  </div>;
}

export interface ContentFeedProfile {
  readonly name: string;
  readonly photoUrl: string | null;
}

type Clock = { readonly day: string; readonly time: string };

/** One post of the grid: the cover, the day, the format, the state and a link to the content, which keeps the query and the state of the screen. */
function FeedTile({ content, address, now }: { content: ContentListItem; address: string; now: Clock }) {
  const location = useLocation();
  const state = displayState(content, now);
  const planned = content.publishOn > now.day;
  return <li className="content-feed__tile" data-status={content.status} data-state={state} data-planned={planned || undefined}>
    <Link
      className="content-feed__link"
      to={{ pathname: `${address}/${content.id}`, search: location.search }}
      state={location.state}
    >
      <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-feed__cover" />
      <time className="content-feed__date" dateTime={content.publishOn}>{shortDayLabel(content.publishOn)}</time>
      {content.format === 'reels' && <Clapperboard className="content-feed__format" aria-hidden="true" />}
      {content.format === 'carousel' && <GalleryVertical className="content-feed__format" aria-hidden="true" />}
      <span className="content-feed__state">
        {state === 'late'
          ? <LateBadge>{TILE_STATE_LABELS.late}</LateBadge>
          : <StatusTag status={DISPLAY_TAGS[state]}>{TILE_STATE_LABELS[state]}</StatusTag>}
      </span>
      <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}{planned ? ' · planejado' : ''}</span>
    </Link>
  </li>;
}

/** What each state of the tile means, as the board words them; the dashed outline is the planned one. */
const LEGEND = [
  { status: 'production', label: 'Produção', meaning: 'sua vez' },
  { status: 'waiting', label: 'Aguardando', meaning: 'esperando o cliente aprovar' },
  { status: 'ready', label: 'Pronto', meaning: 'aprovado, pronto para publicar' },
  { status: 'published', label: 'Publicado', meaning: 'já no ar' }
] as const;

/** The panel beside the phone: how the grid reads, and what the stories circles at the top of the profile are. */
function FeedGuide() {
  return <aside className="content-feed-guide" aria-label="Como ler o feed">
    <section className="content-feed-guide__card">
      <h2 className="content-feed-guide__title">Como ler o feed</h2>
      <p>A grade mostra imagem, carrossel e reels, do mais recente para o mais antigo, em três colunas, como o Instagram vai mostrar. Vídeo longo, VSL e cancelados ficam de fora. Toque num quadrado para abrir o conteúdo.</p>
      <ul className="content-feed-guide__legend">
        {LEGEND.map((entry) => <li key={entry.status}>
          <StatusTag status={entry.status}>{entry.label}</StatusTag>
          <span>{entry.meaning}</span>
        </li>)}
        <li>
          <span className="content-feed-guide__dashed" aria-hidden="true" />
          <span>contorno tracejado: planejado, data futura</span>
        </li>
      </ul>
      <p className="content-feed-guide__note">Seguidores, bio, destaques, curtidas e comentários não existem: é um simulador da grade, não o Instagram.</p>
    </section>
    <section className="content-feed-guide__card">
      <h2 className="content-feed-guide__title">Stories no feed</h2>
      <p>Os roteiros de stories ganham a faixa de círculos no topo do perfil, no lugar dos destaques: o círculo traz o dia e muda de borda conforme o estado (rascunho tracejado, enviado em violeta, gravado em teal). Tocar abre o roteiro. A grade de posts não muda.</p>
    </section>
  </aside>;
}

/** The counters of a list of posts, read from the list itself: the feed counts the period it shows, by the state it shows. */
const countOf = (items: readonly ContentListItem[], now: Clock, state: DisplayState): number => items.filter((content) => displayState(content, now) === state).length;

/**
 * The Instagram profile of the client (`specs/conteudo.md` section 7) on its own screen, for the period on screen, drawn on the
 * phone of the board with the guide beside it: the posts thirty to a page, newest first. A tile is the cover, or the shape of the
 * format when there is none, with the day, the state of the post and a dashed outline on what is still planned; what it says in
 * words is for who does not see the picture. The circles of the story scripts sit above the grid, and a press opens the script.
 * Every text from the server is a React text child. The page belongs to the `scope` it was chosen in (the client and the period
 * on screen): another scope starts on its first page, without remounting the tiles, which would read their covers again.
 */
export function ContentFeed({ onCreate, clientId, contents, now, handle, profile, scope, scripts, onOpenScript }: {
  /** The way to plan the first post, for who may create one: absent for who may not. */
  onCreate?: (() => void) | undefined;
  clientId: string;
  contents: readonly ContentListItem[];
  now: Clock;
  handle: string | null;
  profile?: ContentFeedProfile;
  scope: string;
  scripts: readonly StoryScriptListItem[];
  onOpenScript: (scriptId: string) => void;
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
  const approved = countOf(items, now, 'approved');

  return <div className="content-feed-layout">
    <section className="content-feed-layout__phone" aria-label="Simulador do perfil do Instagram">
      <Phone>
        <div className="content-feed">
          {handle !== null && <p className="content-feed__handle">@{handle}</p>}
          {profile !== undefined && <>
            <div className="content-feed__profile">
              <Avatar name={profile.name} photoUrl={profile.photoUrl} size="lg" />
              <dl className="content-feed__counters">
                <div><dt>no período</dt><dd>{items.length}</dd></div>
                <div><dt>{approved === 1 ? 'pronto' : 'prontos'}</dt><dd>{approved}</dd></div>
                <div><dt>aguardando</dt><dd>{countOf(items, now, 'awaiting_approval')}</dd></div>
              </dl>
            </div>
            <p className="content-feed__name">{profile.name}</p>
          </>}
          <StoryScriptCircles scripts={scripts} onOpen={onOpenScript} />
          {items.length === 0
            ? <div className="content-feed__empty">
              <p>Nenhum post planejado neste período.</p>
              {onCreate !== undefined && <Button variant="secondary" onClick={onCreate}>Planejar um post</Button>}
            </div>
            : <>
              <ol className="content-feed__grid">
                {shown.map((content) => <FeedTile key={content.id} content={content} address={address} now={now} />)}
              </ol>
              {pages > 1 && <nav className="content-feed__pager" aria-label="Páginas do feed">
                {/* `aria-disabled`, not `disabled`: the button that was just pressed keeps the keyboard focus when it reaches an end. */}
                <IconButton label="Página anterior" icon={<ChevronLeft />} aria-disabled={atStart || undefined} onClick={() => { if (!atStart) setPage(page - 1); }} />
                <p className="content-feed__range" aria-live="polite">{shown.length === 1 ? first + 1 : `${first + 1}–${first + shown.length}`} de {items.length}</p>
                <IconButton label="Próxima página" icon={<ChevronRight />} aria-disabled={atEnd || undefined} onClick={() => { if (!atEnd) setPage(page + 1); }} />
              </nav>}
            </>}
        </div>
      </Phone>
    </section>
    <FeedGuide />
  </div>;
}
