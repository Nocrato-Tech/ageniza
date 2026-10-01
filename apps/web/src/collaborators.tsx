import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { CollaboratorListResponseSchema } from '@ageniza/contracts';
import { BadgeCard, Button, Pagination, Select, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { NotFoundPage } from './status-pages.js';

/** `specs/colaboradores.md` §6: 24 per page, a multiple of both 3 and 4 so the grid never breaks. */
const PAGE_SIZE = 24;

/** The five system presets (specs/colaboradores.md §2). The screen only offers these. */
const SYSTEM_ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'account_manager', label: 'Gestor de conta' },
  { value: 'production', label: 'Produção' },
  { value: 'sales', label: 'Vendas' },
  { value: 'finance', label: 'Financeiro' }
] as const;

/**
 * `GET /agencies/:agencyId/collaborators/job-titles` (issue #218) answers `{ data: string[] }`. The
 * contract lands in `@ageniza/contracts` with that route; until then the screen declares the exact
 * shape here so the filter can be written against it.
 */
const JobTitlesResponseSchema = z.object({ data: z.array(z.string()) }).strict();

const parsePage = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

interface Filters {
  readonly page: number;
  readonly q: string;
  readonly role: string;
  readonly jobTitle: string;
}

/** The listing path, with every value percent-encoded (never `+`, which is not a space in a path). */
const listPath = (agenciaId: string, filters: Filters): string => {
  const params: Array<[string, string]> = [['page', String(filters.page)], ['pageSize', String(PAGE_SIZE)]];
  if (filters.q !== '') params.push(['q', filters.q]);
  if (filters.role !== '') params.push(['role', filters.role]);
  if (filters.jobTitle !== '') params.push(['jobTitle', filters.jobTitle]);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${apiPath('/agencies/:agenciaId/collaborators', { agenciaId })}?${query}`;
};

/** An answer that hides the resource: a 403 or 404 from the guard becomes the ordinary not-found. */
const isNotVisible = (error: unknown): boolean =>
  error instanceof HttpClientError && (error.status === 403 || error.status === 404);

/**
 * The team grid (specs/colaboradores.md §7): a badge per person, in the server's order and page.
 * Search, role and job-title filters live in the URL, so the state is shareable and survives a
 * reload. The screen never reorders, groups or draws an empty state.
 */
export function CollaboratorsPage() {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const canInvite = useCan('colaborador.convidar');
  const [searchParams, setSearchParams] = useSearchParams();
  useDocumentTitle('Colaboradores — Ageniza');

  const q = searchParams.get('q') ?? '';
  const role = searchParams.get('role') ?? '';
  const jobTitle = searchParams.get('jobTitle') ?? '';
  const page = parsePage(searchParams.get('page'));
  // Whitespace-only is not a search: the API trims `q` and refuses an empty filter as a 400.
  const search = q.trim();

  const collaborators = useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', { page, q: search, role, jobTitle }],
    queryFn: () => httpClient.request({ path: listPath(agency.agencyId, { page, q: search, role, jobTitle }), response: CollaboratorListResponseSchema })
  });

  const jobTitles = useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', 'job-titles'],
    queryFn: () => httpClient.request({
      path: apiPath('/agencies/:agenciaId/collaborators/job-titles', { agenciaId: agency.agencyId }),
      response: JobTitlesResponseSchema
    })
  });

  const setFilter = (key: 'q' | 'role' | 'jobTitle', value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key); else next.set(key, value);
    // A filter change always returns to the first page.
    next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const changePage = (nextPage: number): void => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete('page'); else next.set('page', String(nextPage));
    setSearchParams(next, { replace: true });
  };

  if (collaborators.isError && isNotVisible(collaborators.error)) return <NotFoundPage as="section" />;

  const hasFilters = search !== '' || role !== '' || jobTitle !== '';
  const jobTitleOptions = (jobTitles.data?.data ?? []).map((value) => ({ value, label: value }));

  return (
    <section aria-labelledby="collaborators-title" className="collaborators">
      <header className="collaborators__header">
        <h1 id="collaborators-title">Colaboradores</h1>
        {canInvite && (
          <Button disabled title="O convite chega na próxima entrega.">
            <span aria-hidden="true">+</span> Convidar
          </Button>
        )}
      </header>

      <div className="collaborators__filters">
        <TextInput
          type="search"
          aria-label="Buscar por nome ou e-mail"
          placeholder="Buscar por nome ou e-mail"
          value={q}
          onChange={(event) => setFilter('q', event.target.value)}
        />
        <Select label="Papel" value={role} placeholder="Todos os papéis" options={SYSTEM_ROLES} onChange={(value) => setFilter('role', value)} />
        <Select
          label="Cargo"
          value={jobTitle}
          placeholder="Todos os cargos"
          options={jobTitleOptions}
          disabled={jobTitles.isPending || jobTitles.isError}
          title={jobTitles.isError ? 'Não foi possível carregar os cargos.' : undefined}
          onChange={(value) => setFilter('jobTitle', value)}
        />
      </div>

      {collaborators.isPending ? (
        <ul className="collaborators__grid" aria-hidden="true">
          {Array.from({ length: PAGE_SIZE }, (_value, index) => <li key={index}><Skeleton className="ui-badge-card__skeleton" /></li>)}
        </ul>
      ) : collaborators.isError ? (
        <div className="collaborators__error" role="alert">
          <p>Não foi possível carregar a equipe. Tente de novo.</p>
          <Button onClick={() => { void collaborators.refetch(); }}>Tentar de novo</Button>
        </div>
      ) : <>
        {collaborators.data.data.length === 0 && hasFilters ? (
          <div className="collaborators__empty">
            <p>{search !== '' ? `Nenhuma pessoa encontrada para "${search}"` : 'Nenhuma pessoa encontrada com esses filtros.'}</p>
            <Button variant="ghost" onClick={() => { setSearchParams({}, { replace: true }); }}>
              {search !== '' ? 'Limpar busca' : 'Limpar filtros'}
            </Button>
          </div>
        ) : (
          <ul className="collaborators__grid">
            {collaborators.data.data.map((collaborator) => (
              <li key={collaborator.membershipId}>
                <BadgeCard
                  name={collaborator.name}
                  photoUrl={collaborator.photoUrl}
                  jobTitle={collaborator.jobTitle}
                  role={collaborator.role.name}
                />
              </li>
            ))}
          </ul>
        )}
        <Pagination
          page={collaborators.data.meta.page}
          totalPages={collaborators.data.meta.totalPages}
          onPageChange={changePage}
          summary={`${collaborators.data.data.length} de ${collaborators.data.meta.totalItems} pessoas`}
        />
      </>}
    </section>
  );
}
