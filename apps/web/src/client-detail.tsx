import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useMatch, useOutletContext, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, ArrowRight, CalendarDays, Circle, Clock, Pencil } from 'lucide-react';
import { z } from 'zod';

import { ClientDetailResponseSchema, ClientSchema, type ClientDetailResponse } from '@ageniza/contracts';
import { Avatar, Button, ButtonLink, EmptyState, Pill, Realce, Skeleton, Stage3D } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { ClientLifecycleActions } from './client-lifecycle.js';
import { Conversation } from './conversation.js';
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

/** The contract validates http(s) on write; a response is untrusted input and never becomes a href. */
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

interface ClientTab {
  readonly slug: string;
  readonly label: string;
}

/** `specs/clientes.md` §7: six tabs, with Acessos only for whoever manages portal access. */
const CLIENT_TABS: readonly ClientTab[] = [
  { slug: 'geral', label: 'Geral' },
  { slug: 'midias', label: 'Mídias' },
  { slug: 'tarefas', label: 'Tarefas' },
  { slug: 'estudo-de-marca', label: 'Estudo de marca' },
  { slug: 'relatorios', label: 'Relatórios' }
];
const ACCESS_TAB: ClientTab = { slug: 'acessos', label: 'Acessos' };

interface ClientDetailContextValue {
  readonly client: ClientDetailResponse;
}

/** The tab components read the client the detail page already loaded (outlet context). */
export const useClientDetail = (): ClientDetailResponse => {
  const context = useOutletContext<ClientDetailContextValue | null>();
  if (context === null) throw new Error('ClientDetail outlet context is required.');
  return context.client;
};

function ClientHeader({ client, onEdit }: { client: ClientDetailResponse; onEdit: () => void }) {
  const canOperate = useCan('cliente.operar');
  const canSeeContents = useCan('conteudo.visualizar');
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const location = useLocation();
  const active = client.status === 'active';

  return <header className="client-detail__header">
    <Avatar className="client-detail__avatar" name={client.name} photoUrl={client.photoUrl} size="lg" />
    <div className="client-detail__identity">
      <div className="client-detail__title">
        <h1 id="client-detail-title">{client.name}</h1>
        <Pill className={active ? 'client-detail__status client-detail__status--active' : 'client-detail__status'} icon={active ? <Circle /> : <Archive />}>{active ? 'Ativo' : 'Arquivado'}</Pill>
      </div>
      {client.instagramHandle !== null && <p className="client-detail__handle">@{client.instagramHandle}</p>}
      {active && client.closingDate !== null && <p className="client-detail__meta"><Pill className="client-detail__closing" icon={<Clock />}>encerra em {formatDayMonth(client.closingDate)}</Pill></p>}
    </div>
    <div className="client-detail__actions">
      {/* The calendar and the feed live only on the screen of Conteúdos (decision 2026-11-04); the roster address travels along, so coming back keeps it. */}
      {canSeeContents && <ButtonLink as={Link} variant="secondary" leadingIcon={<CalendarDays />} state={location.state} to={`/agencia/${agency.agencyId}/conteudos/${client.id}`}>Abrir no Calendário Editorial</ButtonLink>}
      {canOperate && active && <Button variant="secondary" leadingIcon={<Pencil />} blockedReason={blocked} onClick={onEdit}>Editar</Button>}
      <ClientLifecycleActions client={client} />
    </div>
  </header>;
}

/**
 * The client page (`specs/clientes.md` §7): header, the tabs and the tab content. The tab lives
 * in the URL so the link is shareable and the back button works. Geral and the three skeleton tabs
 * belong to #136; the content tabs belong to #138/#140, and the closing actions to #139.
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
  // A 403 or 404 hides the resource the same way: other agency, nonexistent, or no permission.
  const notFound = !validId || (detail.error instanceof HttpClientError && [403, 404].includes(detail.error.status ?? 0));
  // Defense in depth: an answer that belongs to another client is never rendered.
  const client = !notFound && detail.data?.id.toLowerCase() === normalizedId ? detail.data : undefined;
  useDocumentTitle(client === undefined ? 'Cliente — Ageniza' : `${client.name} — Ageniza`);

  if (notFound || (accessTab !== null && !canSeeAccess) || (mediaTab !== null && !canSeeContents)) return <NotFoundPage as="section" />;

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
  const back = <ButtonLink as={Link} variant="ghost" size="sm" leadingIcon={<ArrowLeft />} className="client-detail__back" aria-label="Voltar para Clientes" to={listUrlFromState ?? `/agencia/${agenciaId}/clientes`}>Clientes</ButtonLink>;

  // A background refetch that fails (e.g. after the save invalidation) must not replace the page
  // nor unmount an open modal: the error screen is only for when there is nothing to show.
  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failedWithoutData = (detail.isError || (detail.isPending && detail.errorUpdateCount > 0)) && detail.data === undefined;
  if (failedWithoutData || (detail.data !== undefined && client === undefined)) {
    return <section className="client-detail">
      {back}
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
      {back}
      <header className="client-detail__header" aria-hidden="true">
        <Skeleton className="client-detail__avatar-skeleton" />
        <div className="client-detail__identity"><Skeleton /><Skeleton /></div>
      </header>
      <div className="client-detail__tabs-skeleton" aria-hidden="true"><Skeleton /></div>
      <div className="client-detail__panel"><Skeleton /><Skeleton /><Skeleton /></div>
    </section>;
  }

  // Vendas and Financeiro do not see Conteúdo, nor what Clientes shows of it: the media (specs/conteudo.md section 2).
  const visible = canSeeContents ? CLIENT_TABS : CLIENT_TABS.filter((tab) => tab.slug !== 'midias');
  const tabs = canSeeAccess ? [...visible, ACCESS_TAB] : visible;
  return <section className="client-detail" aria-labelledby="client-detail-title">
    {back}
    {client.status === 'archived' && (
      <p className="client-detail__archived">
        {client.archivedAt === null ? 'Cliente arquivado' : `Cliente arquivado em ${formatArchivedDay(client.archivedAt)}`}
      </p>
    )}
    <ClientHeader client={client} onEdit={() => setEditOpen(true)} />
    <nav className="client-detail__tabs" aria-label="Seções do cliente">
      <ul className="ui-tabs__list">
        {tabs.map((tab) => <li key={tab.slug}>
          {/* In-app navigations carry the roster address forward (state), so "← Clientes" still
              knows it after any tab or block click (review of #379 r2). */}
          <NavLink className="ui-tabs__tab" state={location.state} to={`/agencia/${agenciaId}/clientes/${client.id}/${tab.slug}`}>{tab.label}</NavLink>
        </li>)}
      </ul>
    </nav>
    <div className="client-detail__panel"><Outlet context={{ client } satisfies ClientDetailContextValue} /></div>
    {editOpen && <EditClientDialog client={client} onClose={() => setEditOpen(false)} />}
  </section>;
}

/** The General tab (`specs/clientes.md` §7): a summary, and every block leads to its tab. */
export function ClientGeneralTab() {
  const client = useClientDetail();
  const agency = useAgencyContext();
  const location = useLocation();
  const canSeeAccess = useCan('cliente.convidar_usuario');
  const canSeeClient = useCan('cliente.visualizar');
  const canOperate = useCan('cliente.operar');
  const blocked = useWriteBlocked();
  const base = `/agencia/${agency.agencyId}/clientes/${client.id}`;
  const summary = client.summary;
  const portalCount = summary.activePortalMembers === 1
    ? '1 pessoa com acesso'
    : `${summary.activePortalMembers} pessoas com acesso`;
  // The tab it belongs to is not a screen for this person: the block stays readable, without the
  // promise of a link (specs/clientes.md §7). A `text/link` never sits over the hover background.
  const study = <>
    <progress className="client-general__progress" max={7} value={summary.brandStudyFilled} aria-label="Seções preenchidas do estudo de marca" />
    <p>{summary.brandStudyFilled} de 7</p>
  </>;
  const threads = <>
    <p>{summary.threadsAwaitingAgency > 0
      ? <Realce>{summary.threadsAwaitingAgency} aguardando a agência</Realce>
      : `${summary.threadsAwaitingAgency} aguardando a agência`}</p>
    <p className="client-general__sub">{summary.threadsAnsweredByAgency} com resposta da agência</p>
  </>;

  return <div className="client-general">
    <section className="client-general__summary" aria-label="Resumo do cliente">
      <SummaryBlock tone="indigo" icon="bulb" title="Estudo de marca" to={`${base}/estudo-de-marca`} state={location.state} cta="Ver o estudo">{study}</SummaryBlock>
      <SummaryBlock tone="violet" icon="mail" title="Conversas" to={`${base}/estudo-de-marca`} state={location.state} cta="Ver conversas">{threads}</SummaryBlock>
      <SummaryBlock tone="teal" icon="thumb-up" title="Portal" titleId="client-portal-title" to={canSeeAccess ? `${base}/acessos` : undefined} state={location.state} cta="Ver acessos">
        <p>{portalCount}</p>
      </SummaryBlock>
    </section>
    {canSeeClient && <section className="client-general__requests" aria-label="Pedidos de material ao cliente">
      <Conversation
        scope={{ side: 'agency', agencyId: agency.agencyId, clientId: client.id }}
        subject={{ materialRequest: true }}
        subjectLabel="Pedido de material"
        canWrite={canOperate}
        readOnly={client.status !== 'active'}
        planBlockedReason={blocked}
        headingLevel={3}
        onWritten={() => undefined}
      />
    </section>}
    <section className="client-general__registration" aria-labelledby="client-registration-title">
      <h2 id="client-registration-title">Cadastro</h2>
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
    </section>
  </div>;
}

type SummaryTone = 'indigo' | 'violet' | 'teal';

interface SummaryBlockProps {
  tone: SummaryTone;
  /** The 3D render, by file name in `/3d/`. */
  icon: string;
  title: string;
  titleId?: string;
  /** Where the block leads; without it the block is readable text, with no promise of a link. */
  to: string | undefined;
  state: unknown;
  cta: string;
  children: ReactNode;
}

/** A summary block of the General tab: the family colour, the 3D mark on its stage, the figures and where it leads. */
function SummaryBlock({ tone, icon, title, titleId, to, state, cta, children }: SummaryBlockProps) {
  const className = `client-general__block client-general__block--${tone}`;
  const head = <>
    <Stage3D src={`/3d/${icon}.png`} tone={tone} size="lg" breakout />
    <h2 id={to === undefined ? titleId : undefined}>{title}</h2>
    <div className="client-general__figures">{children}</div>
  </>;
  if (to === undefined) return <section className={className} aria-labelledby={titleId} data-stage-host>{head}</section>;
  return <Link className={className} state={state} to={to} data-stage-host>
    {head}
    <span className="client-general__cta">{cta}<ArrowRight aria-hidden="true" /></span>
  </Link>;
}

/**
 * A tab whose content belongs to a task that has not landed: the area's name and one sentence
 * about what it will show. `specs/clientes.md` §7 allows no fictional data and no control that
 * does not work, so there is nothing clickable here beyond the tab itself.
 */
export function ClientSkeletonTab({ title, description }: { title: string; description: string }) {
  return <EmptyState className="client-skeleton-tab" title={title} description={description} />;
}