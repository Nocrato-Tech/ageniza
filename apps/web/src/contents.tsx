import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, ChevronsUpDown, Grid3x3, Plus } from 'lucide-react';
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
import { Avatar, Button, ButtonLink, Chip, EmptyState, IconButton, LateBadge, Menu, MenuItem, MenuSeparator, Segmented, Skeleton, StatusTag } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey } from './client-detail.js';
import { contentsAddress } from './content-address.js';
import { ContentCalendar } from './content-calendar.js';
import type { ContentsOutletContext } from './content-modal.js';
import { ContentFeed } from './content-feed.js';
import { daysOf, parseAnchor, periodOf, periodTitle, saoPauloClock, shiftAnchor, type CalendarView } from './content-dates.js';
import { DISPLAY_LABELS, DISPLAY_TAGS, displayState, type DisplayState } from './content-labels.js';
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

/** The same reasons with their counts, for the picker of the index: "2 em atraso", the late one first. */
const signalsOf = (client: ClientListItem): { key: string; text: string }[] =>
  ([['overdue', 'em atraso'], ['dueSoon', 'com prazo em dois dias'], ['adjusting', 'em ajuste']] as const)
    .flatMap(([key, label]) => {
      const count = client.contentIndicators?.[key] ?? 0;
      return count > 0 ? [{ key, text: `${count} ${label}` }] : [];
    });

/** Whether the screen is as narrow as a phone: the seven-column grid gives way to a list of days. */
const NARROW_QUERY = '(max-width: 63.99rem)';
/** Whether a media query holds now and while the screen changes; `unknown` is the answer where the browser cannot tell (tests). */
const useMediaMatch = (media: string, unknown: boolean): boolean => {
  const read = (): boolean => typeof window.matchMedia === 'function' ? window.matchMedia(media).matches : unknown;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(media);
    const listener = (): void => setMatches(query.matches);
    listener();
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [media]);
  return matches;
};
const useNarrow = (): boolean => useMediaMatch(NARROW_QUERY, false);

/** The name of the screen: the same words, in the same place, before and after a client is chosen. */
const SCREEN_TITLE = 'Calendário Editorial';

/**
 * The picker of the index: one link per client, with what asks for action in words ("2 em atraso"), the late ones in the
 * red of the state. A caller without `conteudo.visualizar` has no indicators, so no line is drawn for her.
 */
function ClientPicker({ stories }: { stories: StoryClients }) {
  const agency = useAgencyContext();
  const location = useLocation();
  const canRegister = useCan('cliente.cadastrar');
  const blocked = useWriteBlocked();

  const failed = stories.isError || (stories.isPending && stories.errorUpdateCount > 0);
  if (stories.isPending && !failed) {
    return <ul className="content-clients" aria-hidden="true">
      {Array.from({ length: 6 }, (_value, index) => <li key={index}><Skeleton className="content-clients__skeleton" /></li>)}
    </ul>;
  }
  if (stories.isError || stories.isPending) {
    return <EmptyState kind="failure" title="Não foi possível carregar os clientes. Tente de novo." retrying={stories.isFetching} onRetry={() => { void stories.refetch(); }} />;
  }
  if (stories.data.data.length === 0) {
    return <EmptyState
      title="Nenhum cliente ativo ainda."
      description={canRegister ? 'Cadastre o primeiro para começar o calendário dele.' : undefined}
      action={!canRegister ? undefined : blocked === undefined
        ? <ButtonLink as={Link} to={`/agencia/${agency.agencyId}/clientes`} state={location.state} variant="secondary">Cadastrar cliente</ButtonLink>
        : <Button variant="secondary" blockedReason={blocked}>Cadastrar cliente</Button>}
    />;
  }
  const total = stories.data.meta.totalItems;
  return <>
    <nav aria-label="Clientes">
      <ul className="content-clients">
        {stories.data.data.map((client) => {
          const signals = signalsOf(client);
          return <li key={client.id}>
            <Link className="content-clients__item" to={{ pathname: `/agencia/${agency.agencyId}/conteudos/${client.id}`, search: location.search }} state={location.state}>
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

/** The three views of the screen: the month and the week are the calendar, the feed is the profile of the client with the stories. */
type ScreenView = CalendarView | 'feed';

const VIEW_PARAMS: Readonly<Record<ScreenView, string | null>> = { month: null, week: 'semana', feed: 'feed' };

const parseView = (raw: string | null): ScreenView => (raw === 'semana' ? 'week' : raw === 'feed' ? 'feed' : 'month');

/** The filter chips, in the order of the flow; `param` is what `estado` carries in the address. Every state a day or an hour derives has its chip. */
const FILTERS = [
  { param: 'producao', state: 'in_production' },
  { param: 'aguardando', state: 'awaiting_approval' },
  { param: 'ajuste', state: 'adjusting' },
  { param: 'aprovado', state: 'approved' },
  { param: 'agendado', state: 'scheduled' },
  { param: 'atrasado', state: 'late' },
  { param: 'publicado', state: 'published' }
] as const satisfies readonly { param: string; state: DisplayState }[];

type FilterState = (typeof FILTERS)[number]['state'];

const parseFilter = (raw: string | null): FilterState | null => FILTERS.find((filter) => filter.param === raw)?.state ?? null;

type Clock = ReturnType<typeof saoPauloClock>;

/** "Em ajuste" is only worth a chip while something is in it: the board's row has the other six. */
function ContentFilters({ contents, now, selected, onSelect }: {
  contents: readonly ContentListItem[];
  now: Clock;
  selected: FilterState | null;
  onSelect: (state: FilterState | null) => void;
}) {
  const states = contents.map((content) => displayState(content, now));
  const countOf = (state: DisplayState): number => states.filter((candidate) => candidate === state).length;
  return <div className="contents__filters" role="group" aria-label="Filtrar por estado">
    <Chip selected={selected === null} count={contents.length} onClick={() => onSelect(null)}>Todos</Chip>
    {FILTERS.filter((filter) => filter.state !== 'adjusting' || countOf('adjusting') > 0 || selected === 'adjusting').map(({ state }) => <Chip
      key={state}
      selected={selected === state}
      count={countOf(state)}
      onClick={() => onSelect(selected === state ? null : state)}
    >
      {state === 'late'
        ? <LateBadge>{DISPLAY_LABELS.late}</LateBadge>
        : <StatusTag status={DISPLAY_TAGS[state]}>{DISPLAY_LABELS[state]}</StatusTag>}
    </Chip>)}
  </div>;
}

/** The formats and what tints them, under the grid: the card is tinted by its format and the state is its tag. */
function CalendarLegend() {
  return <ul className="contents__legend" aria-label="Legenda dos formatos">
    <li><i data-format="carousel" aria-hidden="true" />Carrossel</li>
    <li><i data-format="reels" aria-hidden="true" />Reels</li>
    <li><i data-format="static" aria-hidden="true" />Estático</li>
    <li>O formato tinge o card; o estado fica na etiqueta.</li>
  </ul>;
}

/** The chip of the header's trail: it changes the client without leaving the view, and holds the way to the client's registration. */
function ClientSwitch({ clientId, name, photoUrl, profileHref }: { clientId: string; name: string; photoUrl: string | null; profileHref: string }) {
  const stories = useStoryClients();
  const agency = useAgencyContext();
  const navigate = useNavigate();
  const location = useLocation();
  const roster = stories.data?.data ?? [];
  return <Menu
    label="Clientes"
    triggerLabel={`Trocar de cliente, ${name}`}
    trigger={<>
      <Avatar name={name} photoUrl={photoUrl} size="sm" />
      <span className="contents__crumb-name">{name}</span>
      <ChevronsUpDown aria-hidden="true" />
    </>}
  >
    {roster.map((client) => {
      const signals = signalsOf(client);
      return <MenuItem
        key={client.id}
        aria-current={client.id === clientId ? 'true' : undefined}
        onClick={() => navigate({ pathname: `/agencia/${agency.agencyId}/conteudos/${client.id}`, search: location.search }, { state: location.state })}
      >
        {client.name}
        {signals.length > 0 && <span className="contents__crumb-signals">{signals.map((signal) => signal.text).join(' · ')}</span>}
      </MenuItem>;
    })}
    {stories.isPending && <MenuItem disabled>Carregando clientes…</MenuItem>}
    {stories.isError && <MenuItem onClick={(event) => { event.preventDefault(); void stories.refetch(); }}>Não foi possível carregar os clientes. Tente de novo.</MenuItem>}
    <MenuSeparator />
    <MenuItem onClick={() => navigate(profileHref, { state: location.state })}>Abrir no cadastro do cliente</MenuItem>
  </Menu>;
}

/** The address the folders had here (`?vista=pastas`) before they became the Mídias tab of the client's detail. */
const isLegacyFolders = (searchParams: URLSearchParams): boolean => searchParams.get('vista') === 'pastas';

/**
 * `/agencia/:agenciaId/conteudos/:clienteId`: the calendar of one client. The client is in the
 * path; the view (`visao`) and the day the period is built around (`data`) are in the query, so a
 * reload lands on the same period, and so does the filter (`estado`). The feed is a view of its own (Mês, Semana and Feed), and the folders
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
  const now = saoPauloClock();
  const today = now.day;
  const view = parseView(searchParams.get('visao'));
  // The feed on its own screen reads a month, like the month does; only the week is narrower.
  const calendarView: CalendarView = view === 'week' ? 'week' : 'month';
  const narrow = useNarrow();
  const filter = parseFilter(searchParams.get('estado'));
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
    scope: calendarView === 'week' ? 'da semana' : 'do mês',
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
  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failed = ((client.isError || (client.isPending && client.errorUpdateCount > 0)) && clientData === undefined)
    || ((contents.isError || (contents.isPending && contents.errorUpdateCount > 0)) && contents.data === undefined);
  const loaded = contents.data;
  const archived = clientData?.status === 'archived';
  const canEdit = canOperate && clientData !== undefined && !archived;
  const canMove = canEdit && blocked === undefined;

  // What the chips count: the days of the month on screen (not the neighbours' the grid spills into), or the week.
  const counted = loaded === undefined ? [] : loaded.data.contents.filter((content) => calendarView === 'week' || content.publishOn.slice(0, 7) === anchor.slice(0, 7));
  const shown = filter === null || loaded === undefined ? loaded?.data.contents ?? [] : loaded.data.contents.filter((content) => displayState(content, now) === filter);
  const setFilter = (state: FilterState | null): void => {
    const next = new URLSearchParams(searchParams);
    const param = FILTERS.find((candidate) => candidate.state === state)?.param;
    if (param === undefined) next.delete('estado'); else next.set('estado', param);
    setSearchParams(next, { replace: true });
  };
  const handle = clientData?.instagramHandle ?? null;
  const unit = calendarView === 'week' ? 'Semana' : 'Mês';
  const onFeed = view === 'feed';

  return <section aria-labelledby="contents-title" className="contents" data-view={view} data-screen="">
    <header className="contents__head">
      <div className="contents__lead">
        <nav className="contents__crumbs" aria-label="Você está em">
          <Link to={`/agencia/${agency.agencyId}/conteudos`} state={location.state}>{SCREEN_TITLE}</Link>
          <ChevronRight aria-hidden="true" />
          {clientData === undefined
            ? <Skeleton className="contents__client-skeleton" aria-hidden="true" />
            : <ClientSwitch clientId={normalizedId} name={clientData.name} photoUrl={clientData.photoUrl} profileHref={`/agencia/${agency.agencyId}/clientes/${normalizedId}/geral`} />}
        </nav>
        <div className="contents__period" role="group" aria-label="Período">
          <IconButton variant="secondary" icon={<ChevronLeft />} label={`${unit} anterior`} onClick={() => setPeriod(view, shiftAnchor(calendarView, anchor, -1))} />
          <h1 id="contents-title" className="contents__title" aria-live="polite">{periodTitle(calendarView, anchor)}</h1>
          <IconButton variant="secondary" icon={<ChevronRight />} label={calendarView === 'week' ? 'Próxima semana' : 'Próximo mês'} onClick={() => setPeriod(view, shiftAnchor(calendarView, anchor, 1))} />
          <Button variant="ghost" size="sm" onClick={() => setPeriod(view, null)}>Hoje</Button>
        </div>
      </div>
      <div className="contents__actions">
        <Segmented<ScreenView>
          label="Visão"
          value={view}
          onChange={(next) => setPeriod(next, searchParams.get('data'), false)}
          options={[
            { value: 'month', label: 'Mês', icon: <CalendarDays /> },
            { value: 'week', label: 'Semana', icon: <CalendarRange /> },
            { value: 'feed', label: 'Feed', icon: <Grid3x3 /> }
          ]}
        />
        {canWriteScripts && <Button size="lg" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => startContent(today)}>{onFeed ? 'Nova publicação' : 'Novo conteúdo'}</Button>}
      </div>
    </header>
    {failed ? <EmptyState kind="failure" title="Não foi possível carregar os conteúdos. Tente de novo." retrying={client.isFetching || contents.isFetching} onRetry={() => { void client.refetch(); void contents.refetch(); }} /> : <div className="contents__main">
      {archived && <p className="contents__note">Cliente arquivado: o calendário é só leitura.</p>}
      {moveError !== null && <p className="contents__move-error" role="alert">{moveError}</p>}
      {move.isPending && <p className="list-refreshing" role="status">Movendo conteúdo…</p>}
      {loaded === undefined
        ? <div className="contents__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
        : <>
          {contents.isPlaceholderData && <p className="list-refreshing" role="status">Atualizando…</p>}
          {!onFeed && <ContentFilters contents={counted} now={now} selected={filter} onSelect={setFilter} />}
          {!onFeed && scriptLayer.list}
          {loaded.data.contents.length === 0 && !contents.isPlaceholderData && <p className="contents__empty">Nenhum conteúdo planejado neste período.</p>}
          {loaded.data.contents.length > 0 && shown.length === 0 && <p className="contents__empty">Nenhum conteúdo com este estado neste período.</p>}
          {onFeed
            ? <ContentFeed
              onCreate={canWriteScripts && blocked === undefined ? () => startContent(today) : undefined}
              clientId={normalizedId}
              scope={`${normalizedId}|${period.from}|${period.to}`}
              contents={loaded.data.contents}
              now={now}
              handle={handle}
              profile={clientData === undefined ? undefined : { name: clientData.name, photoUrl: clientData.photoUrl }}
              scripts={loaded.data.storyScripts}
              onOpenScript={scriptLayer.open}
            />
            : <>
              <ContentCalendar
                clientId={normalizedId}
                view={calendarView}
                layout={narrow ? 'agenda' : 'grid'}
                anchor={anchor}
                today={today}
                now={now}
                days={daysOf(period)}
                contents={shown}
                canMove={canMove}
                movingId={move.isPending ? move.variables.content.id : null}
                onMove={(content, day) => move.mutate({ content, day })}
                dayExtras={scriptLayer.dayExtras}
                onOpenDay={(day) => setPeriod('week', day, false)}
              />
              <CalendarLegend />
            </>}
        </>}
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
