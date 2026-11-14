import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { CollaboratorListResponseSchema } from '@ageniza/contracts';
import { Avatar, ButtonLink, SearchField, Skeleton } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { CollaboratorProfile, CollaboratorProfileStatus, useCollaboratorDetail } from './collaborator-detail.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';

/** Same page size as the team grid, so the side list shares its cache. */
const PAGE_SIZE = 24;

const ListStateSchema = z.object({ collaboratorListUrl: z.string() });

interface SideListProps {
  readonly membershipId: string;
  readonly listUrl: string;
}

/** The compact list beside the profile: search by name or e-mail, the open person marked. */
function SideList({ membershipId, listUrl }: SideListProps) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const search = q.trim();
  const people = useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', { page: 1, q: search, role: '', jobTitle: '', status: 'active' }],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agenciaId/collaborators', { agenciaId: agency.agencyId })}?page=1&pageSize=${PAGE_SIZE}${search === '' ? '' : `&q=${encodeURIComponent(search)}`}`,
      response: CollaboratorListResponseSchema,
      signal
    }),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === agency.agencyId ? previous : undefined
  });

  const setSearch = (value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete('q'); else next.set('q', value);
    setSearchParams(next, { replace: true, state: { collaboratorListUrl: listUrl } });
  };

  const query = q === '' ? '' : `?q=${encodeURIComponent(q)}`;
  return <aside className="collaborator-page__list" aria-label="Equipe">
    <SearchField label="Buscar pessoa" placeholder="Buscar pessoa" value={q} onChange={setSearch} />
    {people.isPending
      ? <div className="collaborator-page__list-rows" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
      : people.isError
        ? <p className="collaborator-page__list-note" role="alert">Não foi possível carregar a equipe. <button type="button" className="collaborator-page__retry" onClick={() => { void people.refetch(); }}>Tentar de novo</button></p>
        : people.data.data.length === 0
          ? <p className="collaborator-page__list-note">Nenhuma pessoa encontrada.</p>
          : <>
            <ul className="collaborator-page__list-rows">
              {people.data.data.map((person) => <li key={person.membershipId}>
                <Link
                  className="collaborator-page__person"
                  to={{ pathname: `/agencia/${agency.agencyId}/colaboradores/${person.membershipId}`, search: query }}
                  state={{ collaboratorListUrl: listUrl }}
                  aria-current={person.membershipId === membershipId ? 'page' : undefined}
                >
                  <Avatar name={person.name} photoUrl={person.photoUrl} size="sm" />
                  <span className="collaborator-page__person-text">
                    <span className="collaborator-page__person-name">{person.name}</span>
                    {person.jobTitle !== null && person.jobTitle !== '' && <span className="collaborator-page__person-job">{person.jobTitle}</span>}
                  </span>
                </Link>
              </li>)}
            </ul>
            {people.data.meta.totalItems > people.data.data.length && <p className="collaborator-page__list-note">{people.data.data.length} de {people.data.meta.totalItems} pessoas. Busque para ver as demais.</p>}
          </>}
  </aside>;
}

/**
 * The profile of a collaborator (specs/colaboradores.md §7, decision 2026-11-11): a page, with the team
 * list beside it. On a narrow screen the list is the team screen itself and "Voltar à equipe" goes
 * back to it, keeping the filters the person came from.
 */
export function CollaboratorPage() {
  const { membershipId = '' } = useParams();
  const agency = useAgencyContext();
  const location = useLocation();
  const navigate = useNavigate();
  const { detail, notFound, collaborator } = useCollaboratorDetail(membershipId);
  const normalizedId = membershipId.toLowerCase();

  const teamPath = `/agencia/${agency.agencyId}/colaboradores`;
  const state = ListStateSchema.safeParse(location.state);
  // Only an address inside the team screen is followed back: the state is the history's, never trusted blindly.
  const listUrl = state.success && (state.data.collaboratorListUrl === teamPath || state.data.collaboratorListUrl.startsWith(`${teamPath}?`))
    ? state.data.collaboratorListUrl
    : teamPath;

  useDocumentTitle(collaborator === undefined ? 'Colaborador — Ageniza' : `${collaborator.name} — Ageniza`);

  const back = <ButtonLink as={Link} to={listUrl} variant="secondary" leadingIcon={<ArrowLeft />}>Voltar à lista</ButtonLink>;

  return <section className="collaborator-page" aria-label="Colaborador">
    <nav className="collaborator-page__crumbs" aria-label="Você está em">
      <Link to={listUrl}>Equipe</Link>
      {collaborator !== undefined && <><ChevronRight aria-hidden="true" /><span aria-current="page">{collaborator.name}</span></>}
    </nav>
    <Link className="collaborator-page__back" to={listUrl}><ArrowLeft aria-hidden="true" />Voltar à equipe</Link>
    <div className="collaborator-page__layout">
      <SideList membershipId={normalizedId} listUrl={listUrl} />
      <div className="collaborator-page__main">
        <CollaboratorProfileStatus detail={detail} notFound={notFound} collaborator={collaborator} backTo={back} />
        {collaborator !== undefined && <CollaboratorProfile
          key={agency.agencyId + normalizedId}
          collaborator={collaborator}
          isSelf={collaborator.isSelf}
          onRemoved={() => { void navigate(listUrl, { replace: true }); }}
        />}
      </div>
    </div>
  </section>;
}
