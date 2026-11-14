import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Archive, ArrowRight, CalendarDays, ChevronRight, Circle, Clock, Pencil, Plus } from 'lucide-react';
import { z } from 'zod';

import { ClientDetailResponseSchema, ClientSchema, type ClientDetailResponse } from '@ageniza/contracts';
import { Avatar, AvatarGroup, Button, ButtonLink, EmptyState, Pill, Skeleton, Stage3D, type Stage3DTone } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { ClientLifecycleActions } from './client-lifecycle.js';
import { contentsMetaLine, hasLegacyContentsQuery, useClientMonthContents } from './client-contents.js';
import { ClientMaterialRequests } from './client-material-requests.js';
import { contentsAddress } from './content-address.js';
import { todayInSaoPaulo } from './content-dates.js';
import { useDocumentTitle } from './document-title.js';
import { EditClientDialog } from './edit-client.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';

const NOT_INFORMED = 'Não informado';

export const clientDetailQueryKey = (agencyId: string, clientId: string) =>
  ['agency', agencyId, 'clients', 'detail', clientId] as const;

/**
 * `closingDate` is a date-only string. Reading the day and month from the text keeps the label
 * identical in every timezone; `new Date` would shift it.
 */
export const formatDayMonth = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-');
  if (year === undefined || month === undefined || day === undefined) return value;
  return `${day}/${month}`;
};

/**
 * `archivedAt` is an ISO timestamp the API answers in UTC (`toISOString`): slicing the text would
 * show the UTC day, which flips for the evening hours of `America/Sao_Paulo` (archiving at 22h of
 * the 7th becomes the 8th in UTC). The archiving day is the agency's day, so the label is
 * formatted in that timezone.
 */
const agencyDayFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

/** Day and month of an ISO timestamp in the agency's timezone (America/Sao_Paulo). */
export const formatAgencyDayMonth = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : agencyDayFormatter.format(date);
};

export const formatArchivedDay = formatAgencyDayMonth;

const sinceFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });

/** "março de 2026": the month the registration was created, in the agency's day. */
const clientSinceLabel = (createdAt: string): string => sinceFormatter.format(new Date(createdAt));

/** The contract validates http(s) on write; a response is untrusted input and never becomes a href. */
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

interface ClientTab {
  readonly slug: string;
  readonly label: string;
  /** What the tab holds, from the detail's summary; absent when the person may not read it (never a zero). */
  readonly count?: number | undefined;
}


interface ClientDetailContextValue {
  readonly client: ClientDetailResponse;
}

/** The tab components read the client the detail page already loaded (outlet context). */
export const useClientDetail = (): ClientDetailResponse => {
  const context = useOutletContext<ClientDetailContextValue | null>();
  if (context === null) throw new Error('ClientDetail outlet context is required.');
  return context.client;
};

interface CrumbsProps {
  readonly rosterUrl: string;
  readonly client?: ClientDetailResponse | undefined;
  readonly tab?: ClientTab | undefined;
}

/** "Clientes > name > tab": the roster link keeps the address the person came from, and the name is a link only when a tab is open under it. */
function Crumbs({ rosterUrl, client, tab }: CrumbsProps) {
  const agency = useAgencyContext();
  const location = useLocation();
  return <nav className="client-detail__crumbs" aria-label="Você está em">
    <Link to={rosterUrl}>Clientes</Link>
    {client !== undefined && <>
      <ChevronRight aria-hidden="true" />
      {tab === undefined
        ? <span aria-current="page">{client.name}</span>
        : <Link state={location.state} to={`/agencia/${agency.agencyId}/clientes/${client.id}/geral`}>{client.name}</Link>}
    </>}
    {tab !== undefined && <><ChevronRight aria-hidden="true" /><span aria-current="page">{tab.label}</span></>}
  </nav>;
}

function ClientHeader({ client, tab, meta, onEdit }: { client: ClientDetailResponse; tab: ClientTab | undefined; meta: ReactNode; onEdit: () => void }) {
  const canOperate = useCan('cliente.operar');
  const canSeeContents = useCan('conteudo.visualizar');
  const canWriteContents = useCan('conteudo.operar');
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const location = useLocation();
  const navigate = useNavigate();
  const active = client.status === 'active';
  const onContents = tab?.slug === 'conteudos';
  const workers = client.summary.workers ?? [];
  const moreWorkers = client.summary.workersMore ?? 0;
  const calendarAddress = contentsAddress(agency.agencyId, client.id);
  // The calendar and the feed keep one address; the roster address travels along, so coming back keeps it.
  const calendar = canSeeContents && <ButtonLink as={Link} variant={active && !onContents ? 'primary' : 'secondary'} leadingIcon={<CalendarDays />} state={location.state} to={calendarAddress}>Abrir no Calendário Editorial</ButtonLink>;

  return <header className="client-detail__header">
    <Avatar className="client-detail__avatar" name={client.name} photoUrl={client.photoUrl} size="lg" />
    <div className="client-detail__identity">
      <div className="client-detail__title">
        <h1 id="client-detail-title">{client.name}</h1>
        <Pill className={active ? 'client-detail__status client-detail__status--active' : 'client-detail__status'} icon={active ? <Circle /> : <Archive />}>{active ? 'Ativo' : 'Arquivado'}</Pill>
        {active && client.closingDate !== null && <Pill className="client-detail__closing" icon={<Clock />}>encerra em {formatDayMonth(client.closingDate)}</Pill>}
      </div>
      {meta !== null && <p className="client-detail__meta">{meta}</p>}
      {workers.length > 0 && <span className="client-detail__workers">
        <AvatarGroup label="Quem trabalha neste cliente" people={workers.map((person) => ({ name: person.name, photoUrl: person.photoUrl }))} max={workers.length} />
        {moreWorkers > 0 && <span className="client-detail__workers-more">+{moreWorkers}</span>}
      </span>}
    </div>
    <div className="client-detail__actions">
      {onContents
        ? <>
          {calendar}
          {canWriteContents && active && <Button leadingIcon={<Plus />} blockedReason={blocked} onClick={() => navigate({ pathname: `${calendarAddress}/novo`, search: `?dia=${todayInSaoPaulo()}` }, { state: location.state })}>Nova publicação</Button>}
        </>
        : <>
          {canOperate && active && <Button variant="ghost" leadingIcon={<Pencil />} blockedReason={blocked} onClick={onEdit}>Editar</Button>}
          <ClientLifecycleActions client={client} />
          {calendar}
        </>}
    </div>
  </header>;
}

/**
 * The client page (`specs/clientes.md` §7): header, the tabs and the tab content. The tab lives
 * in the URL so the link is shareable and the back button works. Five tabs (decision 2026-11-11):
 * Visão geral, Conteúdos, Mídias, Marca and Acessos, the counts coming from the detail's summary.
 */
export function ClientDetailPage() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const location = useLocation();
  const { agenciaId = '', clienteId = '' } = useParams();
  const [editOpen, setEditOpen] = useState(false);
  const canSeeAccess = useCan('cliente.convidar_usuario');
  const canSeeContents = useCan('conteudo.visualizar');
  // A tab someone cannot see is not a screen: the whole address is the ordinary not-found, and
  // the header never reveals the client behind a hidden tab (specs/clientes.md §7).
  const accessTab = useMatch('/agencia/:agenciaId/clientes/:clienteId/acessos');
  const mediaTab = useMatch('/agencia/:agenciaId/clientes/:clienteId/midias/*');
  const contentsTab = useMatch('/agencia/:agenciaId/clientes/:clienteId/conteudos/*');
  const currentSlug = useMatch('/agencia/:agenciaId/clientes/:clienteId/:tab/*')?.params.tab;
  const normalizedId = clienteId.toLowerCase();
  const validId = ClientSchema.shape.id.safeParse(normalizedId).success;
  const detail = useQuery({
    queryKey: clientDetailQueryKey(agency.agencyId, normalizedId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId', { agencyId: agency.agencyId, clientId: normalizedId }),
      response: ClientDetailResponseSchema,
      signal
    }),
    enabled: validId
  });
  const monthContents = useClientMonthContents(normalizedId, validId && contentsTab !== null && canSeeContents && !hasLegacyContentsQuery(location.search));
  // A 403 or 404 hides the resource the same way: other agency, nonexistent, or no permission.
  const notFound = !validId || (detail.error instanceof HttpClientError && [403, 404].includes(detail.error.status ?? 0));
  // Defense in depth: an answer that belongs to another client is never rendered.
  const client = !notFound && detail.data?.id.toLowerCase() === normalizedId ? detail.data : undefined;
  useDocumentTitle(client === undefined ? 'Cliente — Ageniza' : `${client.name} — Ageniza`);

  if (notFound || (accessTab !== null && !canSeeAccess) || ((mediaTab !== null || contentsTab !== null) && !canSeeContents)) return <NotFoundPage as="section" />;

  // The roster passes its own address (filters and page included) when it opens the detail
  // (review of #379, specs/clientes.md §7 "volta à carteira preservando busca, filtro e página").
  // The state is only an address this agency's roster can have produced; anything else falls back
  // to the plain list.
  const listUrlFromState = (() => {
    const state = z.object({ clientListUrl: z.string() }).safeParse(location.state);
    if (!state.success) return undefined;
    const prefix = `/agencia/${agenciaId}/clientes`;
    const url = state.data.clientListUrl;
    return url === prefix || url.startsWith(`${prefix}?`) ? url : undefined;
  })();
  const rosterUrl = listUrlFromState ?? `/agencia/${agenciaId}/clientes`;

  // A background refetch that fails (e.g. after the save invalidation) must not replace the page
  // nor unmount an open modal: the error screen is only for when there is nothing to show.
  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failedWithoutData = (detail.isError || (detail.isPending && detail.errorUpdateCount > 0)) && detail.data === undefined;
  if (failedWithoutData || (detail.data !== undefined && client === undefined)) {
    return <section className="client-detail">
      <Crumbs rosterUrl={rosterUrl} />
      <EmptyState
        kind="failure"
        headingLevel={2}
        title="Não foi possível carregar o cliente. Tente de novo."
        retrying={detail.isFetching}
        onRetry={() => { void detail.refetch(); }}
      />
    </section>;
  }

  if (client === undefined) {
    return <section className="client-detail" aria-busy="true">
      <Crumbs rosterUrl={rosterUrl} />
      <header className="client-detail__header" aria-hidden="true">
        <Skeleton className="client-detail__avatar-skeleton" />
        <div className="client-detail__identity"><Skeleton /><Skeleton /></div>
      </header>
      <div className="client-detail__tabs-skeleton" aria-hidden="true"><Skeleton /></div>
      <div className="client-detail__panel"><Skeleton /><Skeleton /><Skeleton /></div>
    </section>;
  }

  // Vendas and Financeiro do not see Conteúdo, nor what Clientes shows of it: the contents and the media (specs/conteudo.md section 2).
  const summary = client.summary;
  const tabs: readonly ClientTab[] = [
    { slug: 'geral', label: 'Visão geral' },
    ...(canSeeContents ? [{ slug: 'conteudos', label: 'Conteúdos', count: summary.contentsThisMonth }, { slug: 'midias', label: 'Mídias', count: summary.mediaFiles }] : []),
    { slug: 'estudo-de-marca', label: 'Marca' },
    ...(canSeeAccess ? [{ slug: 'acessos', label: 'Acessos', count: summary.activePortalMembers }] : [])
  ];
  const openTab = tabs.find((tab) => tab.slug === currentSlug);
  const trailTab = openTab !== undefined && openTab.slug !== 'geral' ? openTab : undefined;
  const handle = client.instagramHandle === null ? null : `@${client.instagramHandle}`;
  const joined = (parts: readonly (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null && part !== '');
    return kept.length === 0 ? null : kept.join(' · ');
  };
  const meta = openTab?.slug === 'conteudos'
    ? contentsMetaLine(summary.contentsThisMonth, monthContents.data)
    : openTab?.slug === 'acessos'
      ? `${client.name} · quem aprova os posts, sem criar conta`
      : openTab === undefined || openTab.slug === 'geral'
        ? joined([handle, client.city])
        : joined([client.segment, client.city, `cliente desde ${clientSinceLabel(client.createdAt)}`]);
  return <section className="client-detail" aria-labelledby="client-detail-title">
    <Crumbs rosterUrl={rosterUrl} client={client} tab={trailTab} />
    {client.status === 'archived' && (
      <p className="client-detail__archived">
        {client.archivedAt === null ? 'Cliente arquivado' : `Cliente arquivado em ${formatArchivedDay(client.archivedAt)}`}
      </p>
    )}
    <ClientHeader client={client} tab={openTab} meta={meta} onEdit={() => setEditOpen(true)} />
    <nav className="client-detail__tabs" aria-label="Seções do cliente">
      <ul className="ui-tabs__list">
        {tabs.map((tab) => <li key={tab.slug}>
          {/* In-app navigations carry the roster address forward (state), so "Clientes" still
              knows it after any tab or block click (review of #379 r2). */}
          <NavLink className="ui-tabs__tab" state={location.state} to={`/agencia/${agenciaId}/clientes/${client.id}/${tab.slug}`}>
            {tab.label}
            {tab.count !== undefined && <Pill className="ui-tabs__count">{tab.count}</Pill>}
          </NavLink>
        </li>)}
      </ul>
    </nav>
    <div className="client-detail__panel"><Outlet context={{ client } satisfies ClientDetailContextValue} /></div>
    {editOpen && <EditClientDialog client={client} onClose={() => setEditOpen(false)} />}
  </section>;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The Visão geral (`specs/clientes.md` §7): a summary, and every block leads to its tab. */
export function ClientGeneralTab() {
  const client = useClientDetail();
  const agency = useAgencyContext();
  const location = useLocation();
  const canSeeAccess = useCan('cliente.convidar_usuario');
  const canOperate = useCan('cliente.operar');
  const blocked = useWriteBlocked();
  const [editOpen, setEditOpen] = useState(false);
  const base = `/agencia/${agency.agencyId}/clientes/${client.id}`;
  const summary = client.summary;
  const active = client.status === 'active';

  return <div className="client-general">
    <section className="client-general__summary" aria-label="Resumo do cliente">
      <SummaryBlock tone="indigo" icon="bulb" title="Estudo de marca" to={`${base}/estudo-de-marca`} state={location.state} cta="Ver o estudo"
        figure={<>{summary.brandStudyFilled} <small>de 7</small></>} hint="seções preenchidas">
        <progress className="client-general__progress" max={7} value={summary.brandStudyFilled} aria-label="Seções preenchidas do estudo de marca" />
      </SummaryBlock>
      <SummaryBlock tone="violet" icon="mail" title="Conversas" to={`${base}/estudo-de-marca`} state={location.state} cta="Ver conversas"
        figure={summary.threadsAwaitingAgency} hint="aguardando a agência" />
      <SummaryBlock tone="teal" icon="thumb-up" title="Portal" titleId="client-portal-title" to={canSeeAccess ? `${base}/acessos` : undefined} state={location.state} cta="Ver acessos"
        figure={summary.activePortalMembers} hint={summary.activePortalMembers === 1 ? 'pessoa com acesso' : 'pessoas com acesso'} />
      {summary.mediaFiles !== undefined && summary.mediaFolders !== undefined && <SummaryBlock tone="sky" icon="folder" title="Mídias" to={`${base}/midias`} state={location.state} cta="Abrir mídias"
        figure={summary.mediaFiles} hint={`${summary.mediaFiles === 1 ? 'arquivo' : 'arquivos'} em ${plural(summary.mediaFolders, 'pasta', 'pastas')}`} />}
    </section>
    <ClientMaterialRequests client={client} />
    <section className="client-general__registration" aria-labelledby="client-registration-title">
      <div className="client-general__registration-head">
        <h2 id="client-registration-title">Cadastro</h2>
        {canOperate && active && <Button variant="ghost" size="sm" leadingIcon={<Pencil />} aria-label="Editar cadastro" blockedReason={blocked} onClick={() => setEditOpen(true)}>Editar</Button>}
      </div>
      <dl className="client-general__fields">
        <dt>Razão social</dt><dd>{client.legalName ?? NOT_INFORMED}</dd>
        <dt>CNPJ ou CPF</dt><dd>{client.taxId ?? NOT_INFORMED}</dd>
        <dt>Segmento</dt><dd>{client.segment ?? NOT_INFORMED}</dd>
        <dt>Site</dt><dd>{client.website === null
          ? NOT_INFORMED
          : isHttpUrl(client.website)
            ? <a href={client.website} target="_blank" rel="noopener noreferrer">{client.website}</a>
            : client.website}</dd>
        <dt>Contato</dt><dd>{client.contactName ?? NOT_INFORMED}</dd>
        <dt>Telefone</dt><dd>{client.contactPhone ?? NOT_INFORMED}</dd>
        <dt>E-mail de contato</dt><dd>{client.contactEmail ?? NOT_INFORMED}</dd>
      </dl>
      <p className="client-general__note">Este é o contato da empresa. Quem entra no portal é definido na aba Acessos. Campo vazio mostra “Não informado”.</p>
    </section>
    {editOpen && <EditClientDialog client={client} onClose={() => setEditOpen(false)} />}
  </div>;
}

interface SummaryBlockProps {
  tone: Stage3DTone;
  /** The 3D render, by file name in `/3d/`. */
  icon: string;
  title: string;
  titleId?: string;
  /** Where the block leads; without it the block is readable text, with no promise of a link. */
  to: string | undefined;
  state: unknown;
  cta: string;
  figure: ReactNode;
  hint: string;
  children?: ReactNode;
}

/** A summary block of the Visão geral: the family colour, the 3D mark on its stage, the figure with its hint and where it leads. */
function SummaryBlock({ tone, icon, title, titleId, to, state, cta, figure, hint, children }: SummaryBlockProps) {
  const className = `client-general__block client-general__block--${tone}`;
  const head = <>
    <Stage3D src={`/3d/${icon}.png`} tone={tone} size="lg" breakout />
    <h2 id={to === undefined ? titleId : undefined}>{title}</h2>
    <div className="client-general__figures">
      <p className="client-general__figure">{figure}</p>
      <p className="client-general__hint">{hint}</p>
      {children}
    </div>
  </>;
  if (to === undefined) return <section className={className} aria-labelledby={titleId} data-stage-host>{head}</section>;
  return <Link className={className} state={state} to={to} data-stage-host>
    {head}
    <span className="client-general__cta">{cta}<ArrowRight aria-hidden="true" /></span>
  </Link>;
}
