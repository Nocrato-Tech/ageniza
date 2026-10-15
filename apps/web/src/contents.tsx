import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

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
import { Avatar, Button, ClientStrip, Skeleton } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { clientDetailQueryKey } from './client-detail.js';
import { contentsAddress, ContentsHomeContext } from './content-address.js';
import { ContentCalendar } from './content-calendar.js';
import type { ContentsOutletContext } from './content-modal.js';
import { ContentFeed, ContentFeedSkeleton } from './content-feed.js';
import { ContentFolders } from './content-folders.js';
import { daysOf, parseAnchor, periodOf, periodTitle, shiftAnchor, todayInSaoPaulo, type CalendarView } from './content-dates.js';
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

/** `/agencia/:agenciaId/conteudos`: the client picker, before a client is chosen. */
export function ContentsPage() {
  const stories = useStoryClients();
  useDocumentTitle('Conteúdos — Ageniza');

  if (stories.isError && isNotVisible(stories.error)) return <NotFoundPage as="section" />;
  return <section aria-labelledby="contents-title" className="contents">
    <h1 id="contents-title">Conteúdos</h1>
    <ContentStories stories={stories} />
    {stories.data !== undefined && stories.data.data.length > 0 && <p>Escolha um cliente para ver o calendário editorial.</p>}
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

const parseView = (raw: string | null): CalendarView => (raw === 'semana' ? 'week' : 'month');

type Vista = 'calendar' | 'feed' | 'folders';

/** The client's views: the calendar (the default, so absent from the URL), the grid of the feed or the folders. */
const parseVista = (raw: string | null): Vista => (raw === 'feed' ? 'feed' : raw === 'pastas' ? 'folders' : 'calendar');

/**
 * `/agencia/:agenciaId/conteudos/:clienteId`: the calendar of one client. The client is in the
 * path; the view (`visao`) and the day the period is built around (`data`) are in the query, so a
 * reload lands on the same period. The Feed and Pastas views are chosen by `vista`, and the folder open in the
 * Pastas view is in the query too (`content-folders.tsx`).
 *
 * `pinned` is the same view inside the tab of the client's detail (`/clientes/:clienteId/conteudos`): the client is the
 * one of the page around it, so there are no stories and no client header, and every address it builds stays in the tab.
 */
export function ContentsClientPage({ pinned = false }: { pinned?: boolean }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const { clienteId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const normalizedId = clienteId.toLowerCase();
  const validId = ClientSchema.shape.id.safeParse(normalizedId).success;
  const today = todayInSaoPaulo();
  const view = parseView(searchParams.get('visao'));
  const vista = parseVista(searchParams.get('vista'));
  const anchor = parseAnchor(searchParams.get('data'), today);
  const period = periodOf(view, anchor);

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
    enabled: validId && vista !== 'folders',
    // The previous period stays while the next loads, but never another client's or agency's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === agency.agencyId && previousQuery.queryKey[3] === normalizedId ? previous : undefined
  });

  const queryClient = useQueryClient();
  const canOperate = useCan('conteudo.operar');
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
  const address = contentsAddress(pinned ? 'tab' : 'screen', agency.agencyId, normalizedId);
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
    canOperate: canWriteScripts,
    scripts: contents.data?.data.storyScripts ?? [],
    today,
    onCreateContent: startContent
  });

  const name = client.data?.name;
  // In the tab the page around it already names the client in the title.
  useDocumentTitle(pinned
    ? (name === undefined ? 'Cliente — Ageniza' : `${name} — Ageniza`)
    : (name === undefined ? 'Conteúdos — Ageniza' : `Conteúdos de ${name} — Ageniza`));

  const setPeriod = (nextView: CalendarView, nextAnchor: string | null): void => {
    setMoveError(null);
    const next = new URLSearchParams(searchParams);
    if (nextView === 'week') next.set('visao', 'semana'); else next.delete('visao');
    if (nextAnchor === null) next.delete('data'); else next.set('data', nextAnchor);
    setSearchParams(next, { replace: true });
  };

  const setVista = (next: Vista): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'feed') params.set('vista', 'feed'); else if (next === 'folders') params.set('vista', 'pastas'); else params.delete('vista');
    for (const name of ['pasta', 'subpasta', 'pagina']) params.delete(name);
    setSearchParams(params, { replace: true });
  };

  if (!validId || (client.isError && isNotVisible(client.error)) || (vista !== 'folders' && contents.isError && isNotVisible(contents.error))) {
    return <NotFoundPage as="section" />;
  }
  // The answer must be about the client in the address, or it is not shown at all.
  const clientData = client.data?.id.toLowerCase() === normalizedId ? client.data : undefined;
  const failed = (client.isError && clientData === undefined) || (vista !== 'folders' && contents.isError && contents.data === undefined);
  const loaded = contents.data;
  const unitLabel = view === 'week' ? 'semana' : 'mês';
  const archived = clientData?.status === 'archived';
  const canMove = canOperate && clientData !== undefined && !archived;

  const Title = pinned ? 'h2' : 'h1';
  // The other home of the same view, on the same client and period, and with the roster's address carried along.
  const otherHome = <Link
    className="contents__switch"
    to={{ pathname: contentsAddress(pinned ? 'screen' : 'tab', agency.agencyId, normalizedId), search: location.search }}
    state={location.state}
  >{pinned ? 'Abrir na tela de Conteúdos' : 'Abrir no cadastro do cliente'}</Link>;

  return <ContentsHomeContext.Provider value={pinned ? 'tab' : 'screen'}><section aria-labelledby="contents-title" className="contents">
    <Title id="contents-title" className="visually-hidden">Conteúdos</Title>
    {!pinned && <ClientStories selectedId={normalizedId} />}
    {failed ? <div className="contents__error" role="alert">
      <p>Não foi possível carregar os conteúdos. Tente de novo.</p>
      <Button onClick={() => { void client.refetch(); void contents.refetch(); }}>Tentar de novo</Button>
    </div> : <div className="contents__workspace">
      <div className="contents__main">
        {pinned
          ? <p className="contents__switch-row">{otherHome}</p>
          : <header className="contents__client">
            {clientData === undefined
              ? <Skeleton className="contents__client-skeleton" aria-hidden="true" />
              : <>
                <Avatar name={clientData.name} photoUrl={clientData.photoUrl} size="md" />
                <div>
                  <h2 className="contents__client-name">{clientData.name}</h2>
                </div>
                {otherHome}
              </>}
          </header>}
        <div className="contents__header">
          {!pinned && <div className="contents__heading">
            <h2 className="contents__title">Calendário Editorial</h2>
            <p className="contents__subtitle">Planeje, agende e acompanhe todas as publicações.</p>
          </div>}
          <div className="contents__actions">
            <div className="contents__views" role="tablist" aria-label="Visão do cliente">
              <Button role="tab" aria-selected={vista === 'calendar'} variant={vista === 'calendar' ? 'secondary' : 'ghost'} onClick={() => setVista('calendar')}>Calendário</Button>
              <Button role="tab" aria-selected={vista === 'feed'} variant={vista === 'feed' ? 'secondary' : 'ghost'} onClick={() => setVista('feed')}>Feed</Button>
              <Button role="tab" aria-selected={vista === 'folders'} variant={vista === 'folders' ? 'secondary' : 'ghost'} onClick={() => setVista('folders')}>Pastas</Button>
            </div>
            {canWriteScripts && <Button size="lg" leadingIcon={<Plus />} onClick={() => startContent(today)}>Nova publicação</Button>}
          </div>
        </div>
        {vista !== 'folders' && archived && <p className="contents__note">Cliente arquivado: o calendário é só leitura.</p>}
        {vista !== 'folders' && moveError !== null && <p className="contents__move-error" role="alert">{moveError}</p>}
        {vista !== 'folders' && move.isPending && <p className="list-refreshing" role="status">Movendo conteúdo…</p>}
        {vista === 'folders'
          ? <ContentFolders clientId={normalizedId} canWrite={clientData?.status === 'active'} />
          : <div className="contents__panel">
            <div className="contents__panel-head">
              <div className="contents__period" role="group" aria-label="Período">
                <h2 className="contents__period-title" aria-live="polite">{periodTitle(view, anchor)}</h2>
                <Button variant="secondary" aria-label={`${unitLabel === 'mês' ? 'Mês' : 'Semana'} anterior`} onClick={() => setPeriod(view, shiftAnchor(view, anchor, -1))}>
                  <span aria-hidden="true">‹</span>
                </Button>
                <Button variant="ghost" onClick={() => setPeriod(view, null)}>Hoje</Button>
                <Button variant="secondary" aria-label={`Próxim${view === 'week' ? 'a semana' : 'o mês'}`} onClick={() => setPeriod(view, shiftAnchor(view, anchor, 1))}>
                  <span aria-hidden="true">›</span>
                </Button>
              </div>
              <div className="contents__toggle" role="group" aria-label="Escala do calendário">
                <Button variant={view === 'month' ? 'secondary' : 'ghost'} aria-pressed={view === 'month'} onClick={() => setPeriod('month', searchParams.get('data'))}>Mês</Button>
                <Button variant={view === 'week' ? 'secondary' : 'ghost'} aria-pressed={view === 'week'} onClick={() => setPeriod('week', searchParams.get('data'))}>Semana</Button>
              </div>
            </div>
            {loaded === undefined
              ? (vista === 'feed' ? <ContentFeedSkeleton /> : <div className="contents__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>)
              : <>
                {contents.isPlaceholderData && <p className="list-refreshing" role="status">Atualizando…</p>}
                {vista === 'feed'
                  ? <section aria-label="Prévia do feed"><ContentFeed contents={loaded.data.contents} today={today} handle={clientData?.instagramHandle ?? null} /></section>
                  : <>
                    {loaded.data.contents.length === 0 && !contents.isPlaceholderData && <p className="contents__empty">Nenhum conteúdo planejado neste período.</p>}
                    <ContentCalendar
                      clientId={normalizedId}
                      view={view}
                      anchor={anchor}
                      today={today}
                      days={daysOf(period)}
                      contents={loaded.data.contents}
                      canMove={canMove}
                      movingId={move.isPending ? move.variables.content.id : null}
                      onMove={(content, day) => move.mutate({ content, day })}
                      dayExtras={scriptLayer.dayExtras}
                    />
                  </>}
              </>}
          </div>}
        {vista === 'calendar' && loaded !== undefined && scriptLayer.list}
      </div>
      {vista === 'calendar' && <aside className="contents__feed" aria-label="Prévia do feed">
        {loaded === undefined
          ? <ContentFeedSkeleton />
          : <ContentFeed
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
      canEdit: canMove,
      ready: clientData !== undefined || client.isError,
      archived,
      handle: clientData?.instagramHandle ?? null
    } satisfies ContentsOutletContext} />
  </section></ContentsHomeContext.Provider>;
}
