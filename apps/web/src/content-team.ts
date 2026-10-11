import { useQuery } from '@tanstack/react-query';

import { CollaboratorListResponseSchema } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { readAllPages } from './content-media.js';
import { useApiClient } from './http.js';

const TEAM_PATH = '/agencies/:agencyId/collaborators';
const PAGE_SIZE = 100;

export interface TeamMember {
  readonly membershipId: string;
  /** The name, with the job title when there is one, so two people of one name can be told apart. */
  readonly label: string;
}

/**
 * The active collaborators of the agency, to choose who is in charge of a content or of a subtask. The API decides who may be
 * chosen (an active collaborator who reads Conteúdo); the list only offers the names, never an id. Read only when `enabled`.
 */
export const useTeam = (enabled: boolean) => {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  return useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', 'team'],
    enabled,
    staleTime: 0,
    queryFn: async ({ signal }): Promise<TeamMember[]> => {
      const people = await readAllPages((page) => httpClient.request({
        path: `${apiPath(TEAM_PATH, { agencyId: agency.agencyId })}?page=${page}&pageSize=${PAGE_SIZE}`,
        response: CollaboratorListResponseSchema,
        signal
      }));
      return people.map((person) => ({
        membershipId: person.membershipId,
        label: person.jobTitle === null ? person.name : `${person.name} (${person.jobTitle})`
      }));
    }
  });
};
