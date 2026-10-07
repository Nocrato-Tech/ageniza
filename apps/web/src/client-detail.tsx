import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useMatch, useOutletContext, useParams } from 'react-router-dom';

import { ClientDetailResponseSchema, ClientSchema, type ClientDetailResponse } from '@ageniza/contracts';
import { Avatar, Button, Skeleton } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { EditClientDialog } from './edit-client.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';

const NOT_INFORMED = 'Não informado';
/** The closing actions are issue #139; until they land, the header shows where they will be,
 *  never a control that silently does nothing (docs/design-system.md section 23). */
const ARCHIVE_PENDING = 'As ações de encerramento chegam na próxima entrega.';
const REACTIVATE_PENDING = 'A reativação chega na próxima entrega.';

export const clientDetailQueryKey = (agencyId: string, clientId: string) =>
  ['agency', agencyId, 'clients', 'detail', clientId] as const;

/**
 * `closingDate` is a date-only string and `archivedAt` an ISO timestamp. Reading the day and month
 * from the text keeps the label identical in every timezone; `new Date` would shift it.
 */
export const formatDayMonth = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-');
  if (year === undefined || month === undefined || day === undefined) return value;
  return `${day}/${month}`;
};

/** The contract validates http(s) on write; a response is untrusted input and never becomes a href. */
const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

interface ClientTab {
  readonly slug: string;
  readonly label: string;
}

/** `specs/clientes.md` §7: six tabs, with Acessos only for whoever manages portal access. */
const CLIENT_TABS: readonly ClientTab[] = [
  { slug: 'geral', label: 'Geral' },
  { slug: 'conteudos', label: 'Conteúdos' },
  { slug: 'tarefas', label: 'Tarefas' },
  { slug: 'estudo-de-marca', label: 'Estudo de marca' },
  { slug: 'relatorios', label: 'Relatórios' }
];
const ACCESS_TAB: ClientTab = { slug: 'acessos', label: 'Acessos' };

interface ClientDetailContextValue {
  readonly client: ClientDetailResponse;
}

const useClientDetail = (): ClientDetailResponse => {
  const context = useOutletContext<ClientDetailContextValue | null>();
  if (context === null) throw new Error('ClientDetail outlet context is required.');
  return context.client;
};

function ClientHeader({ client, onEdit }: { client: ClientDetailResponse; onEdit: () => void }) {
  const canOperate = useCan('cliente.operar');
  const canArchive = useCan('cliente.arquivar');
  const active = client.status === 'active';

  return <header className="client-detail__header">
    <Avatar name={client.name} photoUrl={client.photoUrl} size="lg" />
    <div className="client-detail__identity">
      <h1 id="client-detail-title">{client.name}</h1>
      {client.instagramHandle !== null && <p className="client-detail__handle">@{client.instagramHandle}</p>}
      <ul className="client-detail__meta">
        <li className="client-detail__status">{active ? 'Ativo' : 'Arquivado'}</li>
        {active && client.closingDate !== null && <li className="client-detail__closing">encerra em {formatDayMonth(client.closingDate)}</li>}
      </ul>
    </div>
    <div className="client-detail__actions">
      {canOperate && active && <Button onClick={onEdit}>Editar</Button>}
      {canArchive && active && <Button variant="ghost" disabled title={ARCHIVE_PENDING} aria-label="Ações de encerramento"><span aria-hidden="true">⋯</span></Button>}
      {canArchive && !active && <Button disabled title={REACTIVATE_PENDING}>Reativar</Button>}
    </div>
  </header>;
}

/**
 * The client page (`specs/clientes.md` §7): header, the six tabs and the tab content. The tab lives
 * in the URL so the link is shareable and the back button works. Geral and the three skeleton tabs
 * belong to this task; the content tabs of #138 and #140 are skeleton text until their own tasks
 * land, and the closing actions of #139 are announced, never faked.
 */
export function ClientDetailPage() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const { agenciaId = '', clienteId = '' } = useParams();
  const [editOpen, setEditOpen] = useState(false);
  const canSeeAccess = useCan('cliente.convidar_usuario');
  // A tab someone cannot see is not a screen: the whole address is the ordinary not-found, and
  // the header never reveals the client behind a hidden tab (specs/clientes.md §7).
  const accessTab = useMatch('/agencia/:agenciaId/clientes/:clienteId/acessos');
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

  if (notFound || (accessTab !== null && !canSeeAccess)) return <NotFoundPage as="section" />;

  const back = <Link className="client-detail__back" to={`/agencia/${agenciaId}/clientes`}>← Clientes</Link>;

  if (detail.isError || (detail.data !== undefined && client === undefined)) {
    return <section className="client-detail">
      {back}
      <div className="client-detail__error" role="alert">
        <p>Não foi possível carregar o cliente. Tente de novo.</p>
        <Button onClick={() => { void detail.refetch(); }} loading={detail.isFetching}>Tentar de novo</Button>
      </div>
    </section>;
  }

  if (client === undefined) {
    return <section className="client-detail" aria-busy="true">
      {back}
      <header className="client-detail__header" aria-hidden="true">
        <Skeleton className="client-detail__avatar-skeleton" />
        <div className="client-detail__identity"><Skeleton /><Skeleton /></div>
      </header>
      <div className="client-detail__panel"><Skeleton /><Skeleton /><Skeleton /></div>
    </section>;
  }

  const tabs = canSeeAccess ? [...CLIENT_TABS, ACCESS_TAB] : CLIENT_TABS;
  return <section className="client-detail" aria-labelledby="client-detail-title">
    {back}
    {client.status === 'archived' && (
      <p className="client-detail__archived">
        {client.archivedAt === null ? 'Cliente arquivado' : `Cliente arquivado em ${formatDayMonth(client.archivedAt)}`}
      </p>
    )}
    <ClientHeader client={client} onEdit={() => setEditOpen(true)} />
    <nav className="client-detail__tabs" aria-label="Seções do cliente">
      <ul>
        {tabs.map((tab) => <li key={tab.slug}>
          <NavLink to={`/agencia/${agenciaId}/clientes/${client.id}/${tab.slug}`}>{tab.label}</NavLink>
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
  const canSeeAccess = useCan('cliente.convidar_usuario');
  const base = `/agencia/${agency.agencyId}/clientes/${client.id}`;
  const summary = client.summary;
  const portalCount = summary.activePortalMembers === 1
    ? '1 pessoa com acesso'
    : `${summary.activePortalMembers} pessoas com acesso`;
  // The tab it belongs to is not a screen for this person: the block stays readable, without the
  // promise of a link (specs/clientes.md §7). A `text/link` never sits over the hover background.
  const portalBlock = <section className="client-general__block" aria-labelledby="client-portal-title">
    <h2 id="client-portal-title">Portal</h2>
    <p>{portalCount}</p>
  </section>;

  return <div className="client-general">
    <section className="client-general__block" aria-labelledby="client-registration-title">
      <h2 id="client-registration-title">Cadastro</h2>
      <dl className="client-general__fields">
        <dt>Razão social</dt><dd>{client.legalName ?? NOT_INFORMED}</dd>
        <dt>CNPJ</dt><dd>{client.taxId ?? NOT_INFORMED}</dd>
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
    <Link className="client-general__block" to={`${base}/estudo-de-marca`}>
      <h2>Estudo de marca</h2>
      <progress className="client-general__progress" max={7} value={summary.brandStudyFilled} aria-label="Seções preenchidas do estudo de marca" />
      <p>{summary.brandStudyFilled} de 7</p>
    </Link>
    <Link className="client-general__block" to={`${base}/estudo-de-marca`}>
      <h2>Conversas</h2>
      <p>{summary.threadsAwaitingAgency} aguardando a agência</p>
      <p>{summary.threadsAnsweredByAgency} com resposta da agência</p>
    </Link>
    {canSeeAccess
      ? <Link className="client-general__block" to={`${base}/acessos`}>
        <h2>Portal</h2>
        <p>{portalCount}</p>
      </Link>
      : portalBlock}
    <section className="client-general__reserved" aria-labelledby="client-health-title">
      <h2 id="client-health-title">Saúde do cliente</h2>
      <p>Pendentes, atrasos e próximos posts aparecem quando os módulos de Conteúdo e Tarefas existirem.</p>
    </section>
  </div>;
}

/**
 * A tab whose content belongs to a task that has not landed: the area's name and one sentence
 * about what it will show. `specs/clientes.md` §7 allows no fictional data and no control that
 * does not work, so there is nothing clickable here beyond the tab itself.
 */
export function ClientSkeletonTab({ title, description }: { title: string; description: string }) {
  return <section className="client-skeleton-tab">
    <h2>{title}</h2>
    <p>{description}</p>
  </section>;
}