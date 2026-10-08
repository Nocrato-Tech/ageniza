import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { ClientListResponseSchema, type ClientListItem } from '@ageniza/contracts';
import { Avatar, Button, Pagination, Select, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { CreateClientDialog } from './create-client.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';

/** `specs/clientes.md` §6: 20 per page. */
const PAGE_SIZE = 20;

/** `active` is the server default, so only the archived filter travels; the two are never mixed. */
const STATUS_OPTIONS = [
  { value: 'active', label: 'Ativos' },
  { value: 'archived', label: 'Arquivados' }
] as const;

const parsePage = (value: string | null): number => {
  const parsed = Number(value);
  // `1e20` is an integer to `Number.isInteger` but not exactly representable; the API would 400 it.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
};

interface Filters {
  readonly page: number;
  readonly search: string;
  readonly status: 'active' | 'archived';
}

/** The listing path, with every value percent-encoded (never `+`, which is not a space in a path). */
const listPath = (agenciaId: string, filters: Filters): string => {
  const params: Array<[string, string]> = [['page', String(filters.page)], ['pageSize', String(PAGE_SIZE)]];
  if (filters.search !== '') params.push(['search', filters.search]);
  if (filters.status === 'archived') params.push(['status', 'archived']);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${apiPath('/agencies/:agenciaId/clients', { agenciaId })}?${query}`;
};

/** An answer that hides the resource: a 403 or 404 from the guard becomes the ordinary not-found. */
const isNotVisible = (error: unknown): boolean =>
  error instanceof HttpClientError && (error.status === 403 || error.status === 404);

/** "2026-10-30" → "30/10". Built from the string: a UTC parse would flip the day in Brazil. */
const closingLabel = (closingDate: string): string => `${closingDate.slice(8, 10)}/${closingDate.slice(5, 7)}`;

const suggestionLabel = (count: number): string =>
  count === 1 ? '1 sugestão aguardando' : `${count} sugestões aguardando`;

/**
 * The triage card (`specs/clientes.md` §7): photo or initials, name and @, the badges and the
 * reserved indicator strip. The strip never shows a number in the MVP — it only says the area
 * exists. An archived card is dimmed and carries no badge; its only destination is the read-only
 * detail.
 */
function ClientCard({ client, canSeeInvitations }: { client: ClientListItem; canSeeInvitations: boolean }) {
  const archived = client.status === 'archived';
  return <article className={`clients__card${archived ? ' clients__card--archived' : ''}`}>
    <Avatar name={client.name} photoUrl={client.photoUrl} size="lg" />
    <div className="clients__card-body">
      <p className="clients__card-name" id={`client-${client.id}-name`}>{client.name}</p>
      {client.instagramHandle !== null && <p className="clients__card-handle">@{client.instagramHandle}</p>}
      {!archived && <ul className="clients__badges">
        {client.threadsAwaitingAgency > 0 && (
          <li className="clients__badge clients__badge--attention">{suggestionLabel(client.threadsAwaitingAgency)}</li>
        )}
        {client.closingDate !== null && <li className="clients__badge">encerra em {closingLabel(client.closingDate)}</li>}
        {/* The API omits the field for who cannot invite; the extra check keeps the promise if the
            response ever leaks it (the same convenience, not barrier, as specs/clientes.md §7). */}
        {canSeeInvitations && client.pendingInvitations !== undefined && client.pendingInvitations > 0 && (
          <li className="clients__badge">convite pendente</li>
        )}
      </ul>}
    </div>
    {!archived && <p className="clients__indicators">pendentes · em revisão · atrasos</p>}
  </article>;
}

/**
 * The client roster (specs/clientes.md §7): one full-width card per client, in the server's order
 * and page — the screen never reorders or groups. Search, status and page live in the URL. The
 * default order is the server's `sort=attention`, so no order parameter leaves the browser.
 */
export function ClientsPage() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const canCreate = useCan('cliente.cadastrar');
  const canSeeInvitations = useCan('cliente.convidar_usuario');
  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  useDocumentTitle('Clientes — Ageniza');

  const rawSearch = searchParams.get('search') ?? '';
  const status: 'active' | 'archived' = searchParams.get('status') === 'archived' ? 'archived' : 'active';
  const page = parsePage(searchParams.get('page'));
  // Whitespace-only is not a search: the API trims `search` and refuses an empty filter as a 400.
  const search = rawSearch.trim();

  const clients = useQuery({
    queryKey: ['agency', agency.agencyId, 'clients', { page, search, status }],
    queryFn: ({ signal }) => httpClient.request({
      path: listPath(agency.agencyId, { page, search, status }),
      response: ClientListResponseSchema,
      signal
    }),
    // Keep the rows on screen while the next search/page loads: the skeleton is for the first load only.
    placeholderData: keepPreviousData
  });

  const setFilter = (key: 'search' | 'status', value: string): void => {
    const next = new URLSearchParams(searchParams);
    // `active` is the listing default, so it is the absence of the parameter, never `status=active`.
    if (value === '' || (key === 'status' && value === 'active')) next.delete(key); else next.set(key, value);
    // A filter change always returns to the first page.
    next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const clearSearch = (): void => {
    const next = new URLSearchParams(searchParams);
    next.delete('search');
    next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const changePage = (nextPage: number): void => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete('page'); else next.set('page', String(nextPage));
    setSearchParams(next, { replace: true });
  };

  // A filter can shrink the total while the URL still points at a page that no longer exists. The
  // server's `totalPages` is authoritative, so move to the last valid page instead of reading
  // "nenhum cliente" as if the roster were gone.
  useEffect(() => {
    // Placeholder rows belong to the previous filter: their `totalPages` says nothing about this page.
    if (clients.data === undefined || clients.isPlaceholderData) return;
    const lastPage = Math.max(1, clients.data.meta.totalPages);
    if (page <= lastPage) return;
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (lastPage <= 1) next.delete('page'); else next.set('page', String(lastPage));
      return next;
    }, { replace: true });
  }, [clients.data, clients.isPlaceholderData, page, setSearchParams]);

  if (clients.isError && isNotVisible(clients.error)) return <NotFoundPage as="section" />;

  const outOfRange = clients.data !== undefined && !clients.isPlaceholderData && page > Math.max(1, clients.data.meta.totalPages);

  return (
    <section aria-labelledby="clients-title" className="clients">
      <header className="clients__header">
        <h1 id="clients-title">Clientes</h1>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <span aria-hidden="true">+</span> Cadastrar cliente
          </Button>
        )}
      </header>

      <div className="clients__filters">
        <TextInput
          type="search"
          aria-label="Buscar por nome, razão social ou @"
          placeholder="Buscar por nome, razão social ou @"
          value={rawSearch}
          onChange={(event) => setFilter('search', event.target.value)}
        />
        <Select label="Status" value={status} options={STATUS_OPTIONS} onChange={(value) => setFilter('status', value)} />
      </div>

      {clients.isPending ? (
        <ul className="clients__list" aria-hidden="true">
          {Array.from({ length: PAGE_SIZE }, (_value, index) => <li key={index}><Skeleton className="clients__card-skeleton" /></li>)}
        </ul>
      ) : clients.isError ? (
        <div className="clients__error" role="alert">
          <p>Não foi possível carregar os clientes. Tente de novo.</p>
          <Button onClick={() => { void clients.refetch(); }}>Tentar de novo</Button>
        </div>
      ) : outOfRange ? null : <>
        {clients.isPlaceholderData && <p className="list-refreshing" role="status">Atualizando…</p>}
        {clients.data.data.length === 0 ? (
          status === 'archived' && search === '' ? (
            <div className="clients__empty">
              <p>Nenhum cliente arquivado</p>
            </div>
          ) : search !== '' ? (
            <div className="clients__empty">
              <p>Nenhum cliente encontrado para "{search}"</p>
              <Button variant="ghost" onClick={clearSearch}>Limpar busca</Button>
            </div>
          ) : (
            <div className="clients__empty">
              <p>Nenhum cliente ainda</p>
              {canCreate && <Button onClick={() => setCreateOpen(true)}>Cadastrar cliente</Button>}
            </div>
          )
        ) : (
          <ul className="clients__list">
            {clients.data.data.map((client) => (
              <li key={client.id}>
                <Link
                  className="clients__card-link"
                  to={`/agencia/${agency.agencyId}/clientes/${client.id}/geral`}
                  // The detail's "← Clientes" restores this exact address (filters and page
                  // included) through the navigation state (specs/clientes.md §7, review of #379).
                  state={{ clientListUrl: location.pathname + location.search }}
                  aria-labelledby={`client-${client.id}-name`}
                >
                  <ClientCard client={client} canSeeInvitations={canSeeInvitations} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Pagination
          page={clients.data.meta.page}
          totalPages={clients.data.meta.totalPages}
          onPageChange={changePage}
          summary={`${clients.data.data.length} de ${clients.data.meta.totalItems} clientes`}
        />
      </>}
      {createOpen && <CreateClientDialog onClose={() => setCreateOpen(false)} />}
    </section>
  );
}
