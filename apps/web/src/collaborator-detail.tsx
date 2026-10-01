import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';

import { CollaboratorSchema, type Collaborator } from '@ageniza/contracts';
import { Avatar, Button, LiveStatus, Modal, Skeleton } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { HttpClientError, useApiClient } from './http.js';

function CollaboratorDetails({ collaborator }: { collaborator: Collaborator }) {
  const tabId = useId();
  const panelId = useId();
  const unavailableReason = 'Disponível quando o módulo de Tarefas existir.';

  return <>
    <div className="collaborator-detail__identity">
      <Avatar name={collaborator.name} photoUrl={collaborator.photoUrl} size="lg" />
      <div>
        <p>{[collaborator.jobTitle, collaborator.role.name].filter(Boolean).join(' · ')}</p>
        <p>{collaborator.email}</p>
        <p>Na agência desde <time dateTime={collaborator.joinedAt}>{new Intl.DateTimeFormat('pt-BR').format(new Date(collaborator.joinedAt))}</time></p>
      </div>
    </div>
    <div className="collaborator-detail__tabs" role="tablist" aria-label="Informações do colaborador">
      <Button id={tabId} role="tab" aria-selected="true" aria-controls={panelId} variant="secondary">Detalhes</Button>
      {['Performance', 'Entregas'].map((label) => <div key={label} className="collaborator-detail__tab">
        <Button role="tab" aria-selected="false" disabled variant="ghost">{label}</Button>
        <p className="form-hint">{unavailableReason}</p>
      </div>)}
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={tabId} tabIndex={0}>
      <dl className="collaborator-detail__fields">
        <dt>Cargo</dt><dd>{collaborator.jobTitle ?? 'Não informado'}</dd>
        <dt>Papel</dt><dd>{collaborator.role.name}</dd>
        <dt>E-mail</dt><dd>{collaborator.email}<p className="form-hint">A troca de e-mail é feita pela operação.</p></dd>
      </dl>
    </div>
  </>;
}

export function CollaboratorDetailDialog({ membershipId, onClose }: { membershipId: string; onClose: () => void }) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const normalizedId = membershipId.toLowerCase();
  const validId = CollaboratorSchema.shape.membershipId.safeParse(normalizedId).success;
  const detail = useQuery({
    queryKey: ['agency', agency.agencyId, 'collaborators', 'detail', normalizedId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/collaborators/:membershipId', { agencyId: agency.agencyId, membershipId: normalizedId }),
      response: CollaboratorSchema,
      signal
    }),
    enabled: validId,
    refetchOnMount: 'always'
  });
  const notFound = !validId || (detail.error instanceof HttpClientError && [403, 404].includes(detail.error.status ?? 0));
  const collaborator = !notFound && detail.data?.membershipId.toLowerCase() === normalizedId ? detail.data : undefined;

  return <Modal title={collaborator?.name ?? 'Detalhe do colaborador'} closeLabel="Fechar detalhe do colaborador" onClose={onClose}>
    {notFound ? <div className="collaborator-detail__status">
      <p>Colaborador não encontrado.</p>
      <Button variant="secondary" onClick={onClose}>Voltar à lista</Button>
    </div> : <>
      {detail.isError || (detail.data !== undefined && collaborator === undefined) ? <div role="alert" className="collaborator-detail__status">
        <p>Não foi possível carregar o colaborador. Tente de novo.</p>
        <Button onClick={() => { void detail.refetch(); }} loading={detail.isFetching}>Tentar de novo</Button>
      </div> : null}
      {collaborator !== undefined ? <CollaboratorDetails collaborator={collaborator} /> : detail.isPending ? <div className="collaborator-detail__status">
        <LiveStatus>Carregando colaborador…</LiveStatus>
        <Skeleton /><Skeleton />
      </div> : null}
    </>}
  </Modal>;
}
