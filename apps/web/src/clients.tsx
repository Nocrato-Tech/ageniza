import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { ClientListResponseSchema } from '@ageniza/contracts';
import { Button, ButtonLink, EmptyState, FilterBar, FilterBarItem, FilterBarSelect, Pagination, Pill, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { ClientCard } from './client-card.js';
import { triageSentence } from './clients-triage.js';
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

/**
 * The client roster (specs/clientes.md §7): one badge per client, in the server's order and page —
 * the screen never reorders or groups. Search, status and page live in the URL. The default order is
 * the server's `sort=attention`, so no order parameter leaves the browser. The API filters only by
 * search and status, so those are the only filters the bar offers.
 */
export function ClientsPage() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const canCreate = useCan('cliente.cadastrar');
  const canSeeInvitations = useCan('cliente.convidar_usuario');
  const canSeeContents = useCan('conteudo.visualizar');
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
    // Never across agencies: the rows of the previous agency must not show under the new one, not even for a frame.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === agency.agencyId ? previous : undefined
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

  // Placeholder rows are the previous filter's: an empty one must not become this filter's empty state or "0 de 0" summary, so it keeps the skeleton.
  const loading = clients.isPending || (clients.isPlaceholderData && clients.data.data.length === 0);
  const outOfRange = clients.data !== undefined && !clients.isPlaceholderData && page > Math.max(1, clients.data.meta.totalPages);

  const visible = { contents: canSeeContents, invitations: canSeeInvitations };
  const listUrl = location.pathname + location.search;
  const rows = clients.data?.data ?? [];
  const defaultView = status === 'active' && search === '';
  // No client at all, on the default view: the first visit, whose only way forward is to register one.
  const firstVisit = !loading && !clients.isError && !outOfRange && rows.length === 0 && defaultView;
  // The sentence reads the top of the queue, which is only the first page of the unfiltered active roster.
  const triage = !loading && !clients.isError && defaultView && page === 1 && rows.length > 0 ? triageSentence(rows, visible) : [];

  const otherStatusParams = new URLSearchParams(searchParams);
  otherStatusParams.delete('page');
  if (status === 'active') otherStatusParams.set('status', 'archived'); else otherStatusParams.delete('status');
  const otherStatusQuery = otherStatusParams.toString();
  const otherStatusHref = otherStatusQuery === '' ? location.pathname : `${location.pathname}?${otherStatusQuery}`;

  return (
    <section aria-labelledby="clients-title" className="clients">
      <header className="clients__header">
        <h1 id="clients-title">Clientes</h1>
        {canCreate && !firstVisit && (
          <Button size="lg" leadingIcon={<Plus />} onClick={() => setCreateOpen(true)}>Cadastrar cliente</Button>
        )}
      </header>

      {firstVisit ? (
        <EmptyState
          className="clients__empty"
          mascot={canCreate}
          title="Nenhum cliente ainda"
          description={canCreate ? 'Com o cliente cadastrado você monta o calendário do mês e convida quem aprova os posts. Só o nome é obrigatório: o resto você completa depois.' : undefined}
          action={<>
            {canCreate && <Button size="lg" leadingIcon={<Plus />} onClick={() => setCreateOpen(true)}>Cadastrar cliente</Button>}
            <ButtonLink as={Link} to={otherStatusHref} replace variant="secondary" size="lg">Ver arquivados</ButtonLink>
          </>}
        />
      ) : <>
        <section aria-label="Triagem e filtros" className="clients__panel">
          {triage.length > 0 && (
            <p className="clients__triage">
              {triage.map((part) => <span key={part.lead}><strong>{part.lead}</strong>{part.rest} </span>)}
            </p>
          )}
          <FilterBar label="Filtros da carteira" className="clients__filters">
            <FilterBarItem label="Buscar">
              {(control) => (
                <TextInput
                  {...control}
                  type="search"
                  aria-label="Buscar por nome, razão social ou @"
                  placeholder="Nome, razão social ou @"
                  value={rawSearch}
                  onChange={(event) => setFilter('search', event.target.value)}
                />
              )}
            </FilterBarItem>
            <FilterBarSelect label="Status" value={status} options={STATUS_OPTIONS} onChange={(value) => setFilter('status', value)} />
          </FilterBar>
        </section>

        <div className="clients__section-head">
          <div className="clients__section-title">
            <h2>{status === 'archived' ? 'Clientes arquivados' : 'Seus clientes'}</h2>
            {clients.data !== undefined && <Pill>{clients.data.meta.totalItems}</Pill>}
          </div>
          <ButtonLink as={Link} to={otherStatusHref} replace variant="secondary" trailingIcon={<ChevronRight />}>
            {status === 'active' ? 'Ver arquivados' : 'Ver ativos'}
          </ButtonLink>
        </div>

        {loading ? (
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
          {rows.length === 0 ? (
            status === 'archived' && search === '' ? (
              <EmptyState
                className="clients__empty"
                headingLevel={3}
                title="Nenhum cliente arquivado"
                description="Os clientes que você arquivar aparecem aqui, só para leitura."
              />
            ) : (
              <EmptyState
                className="clients__empty"
                headingLevel={3}
                title={`Nenhum cliente encontrado para "${search}"`}
                action={<Button variant="secondary" onClick={clearSearch}>Limpar busca</Button>}
              />
            )
          ) : (
            <ul className="clients__list">
              {rows.map((client) => (
                <li key={client.id}>
                  <ClientCard client={client} visible={visible} agencyId={agency.agencyId} listUrl={listUrl} />
                </li>
              ))}
            </ul>
          )}
          <Pagination
            page={clients.data.meta.page}
            totalPages={clients.data.meta.totalPages}
            onPageChange={changePage}
            summary={`${rows.length} de ${clients.data.meta.totalItems} clientes`}
          />
        </>}
      </>}
      {createOpen && <CreateClientDialog onClose={() => setCreateOpen(false)} />}
    </section>
  );
}
