import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  ClientDetailResponseSchema,
  ClientListResponseSchema,
  ClientSchema,
  ContentDetailSchema,
  ContentPeriodResponseSchema,
  type ClientListItem,
  type ContentListItem,
  type UpdateContentRequest
} from '@ageniza/contracts';
import { Avatar, Button, ClientStrip, IconButton, Segmented, Skeleton } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey } from './client-detail.js';
import { contentsAddress } from './content-address.js';
import { ContentCalendar } from './content-calendar.js';
import type { ContentsOutletContext } from './content-modal.js';
import { ContentFeed, ContentFeedSkeleton } from './content-feed.js';
import { daysOf, parseAnchor, periodOf, periodTitle, shiftAnchor, todayInSaoPaulo, type CalendarView } from './content-dates.js';
import { deadlineAlert, STATUS_LABELS } from './content-labels.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';
import { useStoryScriptLayer } from './story-scripts.js';

/** The listing's own ceiling (`PaginationInputSchema`): the stories show one page of the roster, in the roster's order. */
const STORIES_PAGE_SIZE = 100;

/** An answer that hides the resource: a 403 or 404 from the guard becomes the ordinary not-found. */
const isNotVisible = (error: unknown): boolean =>
  error instanceof HttpClientError && (error.status === 403 || error.status === 404);

/** Active clients in the order of the roster (the server's `sort=attention`, so no order leaves the browser). */
const useStoryClients = () => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: ['agency', agency.agencyId, 'clients', 'stories'],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/clients', { agencyId: agency.agencyId })}?page=1&pageSize=${STORIES_PAGE_SIZE}`,
      response: ClientListResponseSchema,
      signal
    })
  });
};

type StoryClients = ReturnType<typeof useStoryClients>;

/**
 * What puts a ring on a story (`specs/conteudo.md` section 7): a content the client asked to change, one past its
 * day, or one due in two days. "Em produção" and "aguardando aprovação" alone are the normal flow and draw nothing.
 * A caller without `conteudo.visualizar` has no indicators at all, and so no ring.
 */
const ATTENTION_REASONS = [
  ['adjusting', 'em ajuste'],
  ['overdue', 'em atraso'],
  ['dueSoon', 'com prazo em dois dias']
] as const;

const attentionOf = (client: ClientListItem): string[] =>
  ATTENTION_REASONS.filter(([key]) => (client.contentIndicators?.[key] ?? 0) > 0).map(([, label]) => label);

/** The same reasons with their counts, for the picker of the index: "2 em atraso", the late one first. */
const signalsOf = (client: ClientListItem): { key: string; text: string }[] =>
  ([['overdue', 'em atraso'], ['dueSoon', 'com prazo em dois dias'], ['adjusting', 'em ajuste']] as const)
    .flatMap(([key, label]) => {
      const count = client.contentIndicators?.[key] ?? 0;
      return count > 0 ? [{ key, text: `${count} ${label}` }] : [];
    });

/** Whether the screen is as narrow as a phone: the seven-column grid gives way to a list of days. */
const NARROW_QUERY = '(max-width: 63.99rem)';
const useNarrow = (): boolean => {
  const read = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const listener = (): void => setNarrow(query.matches);
    listener();
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return narrow;
};

/**
 * Clients as stories (`specs/conteudo.md` section 7): photo or initials and the name, in the
 * roster's order, active ones only (the listing's default). Every link carries the navigation
 * state forward, so the roster address a person came from is never lost here.
 */
function ContentStories({ stories, selectedId }: { stories: StoryClients; selectedId?: string }) {
  const agency = useAgencyContext();
  const location = useLocation();

  if (stories.isPending) {
    return <ul className="content-stories" aria-hidden="true">
      {Array.from({ length: 6 }, (_value, index) => <li key={index}><Skeleton className="content-stories__skeleton" /></li>)}
    </ul>;
  }
  if (stories.isError) {
    return <div className="content-stories__error" role="alert">
      <p>Não foi possível carregar os clientes. Tente de novo.</p>
      <Button onClick={() => { void stories.refetch(); }}>Tentar de novo</Button>
    </div>;
  }
  if (stories.data.data.length === 0) return <p className="content-stories__empty">Nenhum cliente ativo ainda.</p>;
  const total = stories.data.meta.totalItems;
  return <>
    <ClientStrip
      label="Clientes"
      selectedId={selectedId}
      items={stories.data.data.map((client) => ({
        id: client.id,
        name: client.name,
        photoUrl: client.photoUrl,
        attention: attentionOf(client),
        href: `/agencia/${agency.agencyId}/conteudos/${client.id}`
      }))}
      renderLink={(item, link) => <Link {...link} to={item.href} state={location.state} />}
    />
    {total > stories.data.data.length && <p className="content-stories__note">Mostrando {stories.data.data.length} de {total} clientes.</p>}
  </>;
}

/** The stories of the client screen: its own component, so the tab of the client's detail never reads the roster for them. */
function ClientStories({ selectedId }: { selectedId: string }) {
  return <ContentStories stories={useStoryClients()} selectedId={selectedId} />;
}

/** The name of the screen: the same words, in the same place, before and after a client is chosen. */
const SCREEN_TITLE = 'Calendário Editorial';

/**
 * The picker of the index: one link per client, with what asks for action in words ("2 em atraso"), the late ones in the
 * red of the state. A caller without `conteudo.visualizar` has no indicators, so no line is drawn for her.
 */
function ClientPicker({ stories }: { stories: StoryClients }) {
  const agency = useAgencyContext();
  const location = useLocation();

  if (stories.isPending) {
    return <ul className="content-clients" aria-hidden="true">
      {Array.from({ length: 6 }, (_value, index) => <li key={index}><Skeleton className="content-clients__skeleton" /></li>)}
    </ul>;
  }
  if (stories.isError) {
    return <div className="content-stories__error" role="alert">
      <p>Não foi possível carregar os clientes. Tente de novo.</p>
      <Button onClick={() => { void stories.refetch(); }}>Tentar de novo</Button>
    </div>;
  }
  if (stories.data.data.length === 0) return <p className="content-stories__empty">Nenhum cliente ativo ainda.</p>;
  const total = stories.data.meta.totalItems;
  return <>
    <nav aria-label="Clientes">
      <ul className="content-clients">
        {stories.data.data.map((client) => {
          const signals = signalsOf(client);
          return <li key={client.id}>
            <Link className="content-clients__item" to={`/agencia/${agency.agencyId}/conteudos/${client.id}`} state={location.state}>
              <Avatar name={client.name} photoUrl={client.photoUrl} size="md" />
              <span className="content-clients__name">{client.name}</span>
              {client.contentIndicators !== undefined && (signals.length === 0
                ? <span className="content-clients__signals content-clients__signals--calm">Em dia</span>
                : <span className="content-clients__signals">
                  {signals.map((signal) => <span key={signal.key} className="content-clients__signal" data-signal={signal.key}>{signal.text}</span>)}
                </span>)}
            </Link>
          </li>;
        })}
      </ul>
    </nav>
    {total > stories.data.data.length && <p className="content-stories__note">Mostrando {stories.data.data.length} de {total} clientes.</p>}
  </>;
}

/** `/agencia/:agenciaId/conteudos`: the client picker, before a client is chosen. */
export function ContentsPage() {
  const stories = useStoryClients();
  useDocumentTitle(`${SCREEN_TITLE} — Ageniza`);

  if (stories.isError && isNotVisible(stories.error)) return <NotFoundPage as="section" />;
  return <section aria-labelledby="contents-title" className="contents" data-screen="">
    <header className="contents__head">
      <h1 id="contents-title" className="contents__title">{SCREEN_TITLE}</h1>
    </header>
    <ClientPicker stories={stories} />
  </section>;
}

/** The screen's own words for each refusal of a move: what the server wrote is never shown. */
const moveErrorMessage = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    if (error.status === 409 && error.code === 'CONTENT_NOT_EDITABLE') return 'Este conteúdo já foi publicado ou cancelado e não pode mudar de data.';
    if (error.status === 409 && error.code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: o calendário é só leitura.';
    if (error.status === 403) return 'Você não tem permissão para mover conteúdos.';
    if (error.status === 404) return 'Este conteúdo não existe mais.';
  }
  return 'Não foi possível mover o conteúdo. Tente de novo.';
};

/** The three views of the screen: the month and the week are the calendar with the phone beside it, the feed is the profile on its own. */
type ScreenView = CalendarView | 'feed';

const VIEW_PARAMS: Readonly<Record<ScreenView, string | null>> = { month: null, week: 'semana', feed: 'feed' };

const parseView = (raw: string | null): ScreenView => (raw === 'semana' ? 'week' : raw === 'feed' ? 'feed' : 'month');

/** What the strip above the grid counts: the states of the flow, and the one derived from the day, which overlaps them. */
const SUMMARY_STATUSES = ['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published'] as const;

/** The counters of the period on screen, from the contents the screen already read; a month counts its own days, not its neighbours'. */
function ContentSummary({ contents, today, scope }: { contents: readonly ContentListItem[]; today: string; scope: string }) {
  const late = contents.filter((content) => deadlineAlert(content, today) === 'overdue').length;
  return <ul className="contents__summary" aria-label={`Conteúdos ${scope} por situação`}>
    {SUMMARY_STATUSES.map((status) => {
      const count = contents.filter((content) => content.status === status).length;
      return <li key={status} className="contents__count" data-status={status} data-empty={count === 0 || undefined}>
        <span className="contents__count-number">{count}</span>
        <span className="contents__count-label">{STATUS_LABELS[status]}</span>
      </li>;
    })}
    <li className="contents__count" data-status="late" data-empty={late === 0 || undefined}>
      <span className="contents__count-number">{late}</span>
      <span className="contents__count-label">Atrasados</span>
    </li>
  </ul>;
}

/** The address the folders had here (`?vista=pastas`) before they became the Mídias tab of the client's detail. */
const isLegacyFolders = (searchParams: URLSearchParams): boolean => searchParams.get('vista') === 'pastas';

/**
 * `/agencia/:agenciaId/conteudos/:clienteId`: the calendar of one client. The client is in the
 * path; the view (`visao`) and the day the period is built around (`data`) are in the query, so a
 * reload lands on the same period. The feed is the phone beside the calendar, not a view of its own, and the folders
 * are the Mídias tab of the client's detail: the old `?vista=pastas` address goes there, with the folder it had open.

 * The client's detail has no copy of it: its header links here, and the old `/clientes/:clienteId/conteudos` addresses redirect here.
 */
export function ContentsClientPage() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const { clienteId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const normalizedId = clienteId.toLowerCase();
  const validId = ClientSchema.shape.id.safeParse(normalizedId).success;
  const today = todayInSaoPaulo();
  const view = parseView(searchParams.get('visao'));
  // The feed reads a month, like the month does; only the week is narrower.
  const calendarView: CalendarView = view === 'week' ? 'week' : 'month';
  const narrow = useNarrow();
  const legacyFolders = isLegacyFolders(searchParams);
  const anchor = parseAnchor(searchParams.get('data'), today);
  const period = periodOf(calendarView, anchor);

  const client = useQuery({
    queryKey: clientDetailQueryKey(agency.agencyId, normalizedId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId', { agencyId: agency.agencyId, clientId: normalizedId }),
      response: ClientDetailResponseSchema,
      signal
    }),
    enabled: validId
  });

  const contents = useQuery({
    queryKey: ['agency', agency.agencyId, 'contents', normalizedId, period.from, period.to],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/clients/:clientId/contents', { agencyId: agency.agencyId, clientId: normalizedId })}?from=${period.from}&to=${period.to}`,
      response: ContentPeriodResponseSchema,
      signal
    }),
    enabled: validId && !legacyFolders,
    // The previous period stays while the next loads, but never another client's or agency's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === agency.agencyId && previousQuery.queryKey[3] === normalizedId ? previous : undefined
  });

  const queryClient = useQueryClient();
  const canOperate = useCan('conteudo.operar');
  const blocked = useWriteBlocked();
  const [moveError, setMoveError] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ content, day }: { content: ContentListItem; day: string }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/contents/:contentId', { agencyId: agency.agencyId, clientId: normalizedId, contentId: content.id }),
      method: 'PATCH',
      body: { publishOn: day } satisfies UpdateContentRequest,
      response: ContentDetailSchema
    }),
    onMutate: () => setMoveError(null),
    onError: (error) => setMoveError(moveErrorMessage(error)),
    // Settled only after the period is read again: the card never waits on its old day with the move already done.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', normalizedId] })
  });
  const address = contentsAddress(agency.agencyId, normalizedId);
  const canWriteScripts = canOperate && client.data?.id.toLowerCase() === normalizedId && client.data.status !== 'archived';
  const navigate = useNavigate();
  const location = useLocation();
  // The day of the "+" travels in the address, so a reload of the creation modal keeps it.
  const startContent = (day: string): void => {
    const next = new URLSearchParams(searchParams);
    next.set('dia', day);
    navigate({ pathname: `${address}/novo`, search: `?${next.toString()}` }, { state: location.state });
  };
  const scriptLayer = useStoryScriptLayer({
    clientId: normalizedId,
    canOperate: canWriteScripts && blocked === undefined,
    scripts: contents.data?.data.storyScripts ?? [],
    today,
    onCreateContent: startContent
  });

  const name = client.data?.name;
  useDocumentTitle(name === undefined ? `${SCREEN_TITLE} — Ageniza` : `${SCREEN_TITLE} de ${name} — Ageniza`);

  // Moving through periods rewrites the address; choosing another view adds a step to it, so "voltar" returns to the view before.
  const setPeriod = (nextView: ScreenView, nextAnchor: string | null, replace = true): void => {
    setMoveError(null);
    const next = new URLSearchParams(searchParams);
    const param = VIEW_PARAMS[nextView];
    if (param === null) next.delete('visao'); else next.set('visao', param);
    if (nextAnchor === null) next.delete('data'); else next.set('data', nextAnchor);
    setSearchParams(next, { replace });
  };

  if (legacyFolders && validId) {
    const folder = new URLSearchParams();
    for (const name of ['pasta', 'subpasta', 'pagina']) {
      const value = searchParams.get(name);
      if (value !== null) folder.set(name, value);
    }
    const search = folder.toString();
    return <Navigate to={{ pathname: `/agencia/${agency.agencyId}/clientes/${normalizedId}/midias`, search: search === '' ? '' : `?${search}` }} state={location.state} replace />;
  }
  if (!validId || (client.isError && isNotVisible(client.error)) || (contents.isError && isNotVisible(contents.error))) {
    return <NotFoundPage as="section" />;
  }
  // The answer must be about the client in the address, or it is not shown at all.
  const clientData = client.data?.id.toLowerCase() === normalizedId ? client.data : undefined;
  const failed = (client.isError && clientData === undefined) || (contents.isError && contents.data === undefined);
  const loaded = contents.data;
  const unitLabel = calendarView === 'week' ? 'semana' : 'mês';
  const archived = clientData?.status === 'archived';
  const canEdit = canOperate && clientData !== undefined && !archived;
  const canMove = canEdit && blocked === undefined;

  // The client's profile, with the roster's address carried along so "← Clientes" there still returns to the search it left.
  const toProfile = <Link
    className="contents__switch"
    to={`/agencia/${agency.agencyId}/clientes/${normalizedId}/geral`}
    state={location.state}
  >Abrir no cadastro do cliente</Link>;
  // What the summary counts: the days of the month on screen (not the neighbours' the grid spills into), or the week.
  const counted = loaded === undefined ? [] : loaded.data.contents.filter((content) => calendarView === 'week' || content.publishOn.slice(0, 7) === anchor.slice(0, 7));

  return <section aria-labelledby="contents-title" className="contents" data-view={view} data-screen="">
    <header className="contents__head">
      {/* The title is the screen's, the same with or without a client. */}
      <h1 id="contents-title" className="contents__title">{SCREEN_TITLE}</h1>
      <div className="contents__actions">
        {canWriteScripts && <Button size="lg" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => startContent(today)}>Nova publicação</Button>}
      </div>
    </header>
    <ClientStories selectedId={normalizedId} />
    {failed ? <div className="contents__error" role="alert">
      <p>Não foi possível carregar os conteúdos. Tente de novo.</p>
      <Button onClick={() => { void client.refetch(); void contents.refetch(); }}>Tentar de novo</Button>
    </div> : <div className="contents__workspace">
      <div className="contents__main">
        <header className="contents__client">
          {clientData === undefined
            ? <Skeleton className="contents__client-skeleton" aria-hidden="true" />
            : <>
              <Avatar name={clientData.name} photoUrl={clientData.photoUrl} size="sm" />
              <h2 className="contents__client-name">{clientData.name}</h2>
              {toProfile}
            </>}
        </header>
        {archived && <p className="contents__note">Cliente arquivado: o calendário é só leitura.</p>}
        {moveError !== null && <p className="contents__move-error" role="alert">{moveError}</p>}
        {move.isPending && <p className="list-refreshing" role="status">Movendo conteúdo…</p>}
        {loaded !== undefined && <ContentSummary contents={counted} today={today} scope={calendarView === 'week' ? 'da semana' : 'do mês'} />}
        <div className="contents__panel">
          <div className="contents__panel-head">
            <div className="contents__period" role="group" aria-label="Período">
              <h2 className="contents__period-title" aria-live="polite">{periodTitle(calendarView, anchor)}</h2>
              <IconButton variant="secondary" icon={<ChevronLeft />} label={`${unitLabel === 'mês' ? 'Mês' : 'Semana'} anterior`} onClick={() => setPeriod(view, shiftAnchor(calendarView, anchor, -1))} />
              <Button variant="ghost" onClick={() => setPeriod(view, null)}>Hoje</Button>
              <IconButton variant="secondary" icon={<ChevronRight />} label={`Próxim${calendarView === 'week' ? 'a semana' : 'o mês'}`} onClick={() => setPeriod(view, shiftAnchor(calendarView, anchor, 1))} />
            </div>
            <Segmented<ScreenView>
              label="Visualização"
              value={view}
              onChange={(next) => setPeriod(next, searchParams.get('data'), false)}
              options={[{ value: 'month', label: 'Mês' }, { value: 'week', label: 'Semana' }, { value: 'feed', label: 'Feed' }]}
            />
          </div>
          {loaded === undefined
            ? <div className="contents__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
            : <>
              {contents.isPlaceholderData && <p className="list-refreshing" role="status">Atualizando…</p>}
              {loaded.data.contents.length === 0 && !contents.isPlaceholderData && <p className="contents__empty">Nenhum conteúdo planejado neste período.</p>}
              {view === 'feed'
                ? <ContentFeed
                  variant="full"
                  onCreate={canWriteScripts && blocked === undefined ? () => startContent(today) : undefined}
                  clientId={normalizedId}
                  scope={`${normalizedId}|${period.from}|${period.to}`}
                  contents={loaded.data.contents}
                  today={today}
                  handle={clientData?.instagramHandle ?? null}
                  profile={clientData === undefined ? undefined : { name: clientData.name, photoUrl: clientData.photoUrl }}
                />
                : <ContentCalendar
                  clientId={normalizedId}
                  view={calendarView}
                  layout={narrow ? 'agenda' : 'grid'}
                  anchor={anchor}
                  today={today}
                  days={daysOf(period)}
                  contents={loaded.data.contents}
                  canMove={canMove}
                  movingId={move.isPending ? move.variables.content.id : null}
                  onMove={(content, day) => move.mutate({ content, day })}
                  dayExtras={scriptLayer.dayExtras}
                  onOpenDay={(day) => setPeriod('week', day, false)}
                />}
            </>}
        </div>
        {loaded !== undefined && scriptLayer.list}
      </div>
      {view !== 'feed' && <aside className="contents__feed" aria-label="Prévia do feed">
        {loaded === undefined
          ? <ContentFeedSkeleton />
          : <ContentFeed
            onCreate={canWriteScripts && blocked === undefined ? () => startContent(today) : undefined}
            clientId={normalizedId}
            scope={`${normalizedId}|${period.from}|${period.to}`}
            contents={loaded.data.contents}
            today={today}
            handle={clientData?.instagramHandle ?? null}
            profile={clientData === undefined ? undefined : { name: clientData.name, photoUrl: clientData.photoUrl }}
          />}
      </aside>}
    </div>}
    {scriptLayer.modal}
    <Outlet context={{
      clientId: normalizedId,
      canEdit,
      ready: clientData !== undefined || client.isError,
      archived,
      handle: clientData?.instagramHandle ?? null
    } satisfies ContentsOutletContext} />
  </section>;
}
