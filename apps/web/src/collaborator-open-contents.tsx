import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { CollaboratorOpenContentsResponseSchema, type CollaboratorOpenContentsResponse } from '@ageniza/contracts';
import { StatusTag } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { contentsAddress } from './content-address.js';
import { STATUS_LABELS, STATUS_TAGS } from './content-labels.js';
import { useApiClient } from './http.js';

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "3 clientes · 6 conteúdos · 2 aguardando", the line of the profile header. */
export const openContentsSummaryText = (summary: CollaboratorOpenContentsResponse['summary']): string =>
  [plural(summary.clients, 'cliente', 'clientes'), plural(summary.contents, 'conteúdo', 'conteúdos'), `${summary.awaiting} aguardando`].join(' · ');

/**
 * What the person has open, per client (decision 2026-11-11). Only who reads contents may ask: without
 * `conteudo.visualizar` no request leaves, and any failure just leaves the data out, so the page never
 * breaks because of an extra card.
 */
export function useCollaboratorOpenContents(membershipId: string) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const canSeeContents = useCan('conteudo.visualizar');
  return useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', 'open-contents', membershipId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/collaborators/:membershipId/open-contents', { agencyId: agency.agencyId, membershipId }),
      response: CollaboratorOpenContentsResponseSchema,
      signal
    }),
    enabled: canSeeContents,
    retry: false
  });
}

export function CollaboratorOpenContentsCard({ membershipId }: { membershipId: string }) {
  const agency = useAgencyContext();
  const openContents = useCollaboratorOpenContents(membershipId);
  if (openContents.data === undefined) return null;

  return <section className="collaborator-open" aria-labelledby={`open-contents-${membershipId}`}>
    <h2 className="collaborator-open__title" id={`open-contents-${membershipId}`}>Clientes e o que está com ele</h2>
    {openContents.data.data.length === 0
      ? <p className="collaborator-open__empty">Nenhum conteúdo aberto com esta pessoa.</p>
      : <ul className="collaborator-open__clients">
        {openContents.data.data.map((entry) => <li key={entry.client.id} className="collaborator-open__client">
          <p className="collaborator-open__client-name">{entry.client.name}</p>
          <p className="collaborator-open__counts">{plural(entry.contents, 'conteúdo', 'conteúdos')} · {entry.awaiting} aguardando</p>
          <p className="collaborator-open__now-label">Com ele agora:</p>
          <ul className="collaborator-open__now">
            {entry.now.map((content) => <li key={content.contentId}>
              <Link className="collaborator-open__content" to={`${contentsAddress(agency.agencyId, entry.client.id)}/${content.contentId}`}>
                <span className="collaborator-open__content-title">{content.title}</span>
                <StatusTag status={STATUS_TAGS[content.state]}>{STATUS_LABELS[content.state]}</StatusTag>
              </Link>
            </li>)}
          </ul>
        </li>)}
      </ul>}
  </section>;
}
