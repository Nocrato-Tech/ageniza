import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useParams } from 'react-router-dom';

import { isMaterialRequestOverdue, MaterialRequestListResponseSchema, type MaterialRequest } from '@ageniza/contracts';
import { Button, EmptyState, LateBadge, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { dayOfMonthLabel, todayInSaoPaulo } from './content-dates.js';
import { MATERIAL_REQUEST_LABEL } from './conversation.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { portalMaterialRequestsKey, RequestThread } from './portal-material-requests.js';
import { PortalUploadActions } from './portal-material-upload.js';
import { usePortalClient } from './portal.js';

/** The open requests for material of the client, as the portal reads them: the Início, this page and the badge of the navigation share one read. */
export const usePortalMaterialRequests = (clientId: string) => {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: portalMaterialRequestsKey(clientId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/clients/:clientId/material-requests', { clientId }),
      response: MaterialRequestListResponseSchema,
      signal
    })
  });
};

function RequestCard({ clientId, request, agencyName, today, onOpen }: { clientId: string; request: MaterialRequest; agencyName: string; today: string; onOpen: () => void }) {
  const titleId = `portal-request-${request.threadId}`;
  return <li className="portal-requests-page__item">
    <span className="portal-requests-page__icon" aria-hidden="true"><Inbox /></span>
    <div className="portal-requests-page__text">
      <h2 id={titleId} className="portal-requests-page__title">{request.title ?? MATERIAL_REQUEST_LABEL}</h2>
      <p className="portal-requests-page__body">{request.body}</p>
      <p className="portal-requests-page__meta">
        <span>Pedido de {agencyName}</span>
        {request.dueOn !== null && <span>até {dayOfMonthLabel(request.dueOn)}</span>}
        {isMaterialRequestOverdue(request, today) && <LateBadge>Atrasado</LateBadge>}
      </p>
    </div>
    <div className="portal-requests-page__actions">
      <PortalUploadActions clientId={clientId} request={request} variant="ghost" />
      <Button variant="secondary" id={`${titleId}-button`} aria-labelledby={`${titleId}-button ${titleId}`} onClick={onOpen}>Responder</Button>
    </div>
  </li>;
}

/**
 * "Pedidos da agência" (decision 2026-11-11): every request for material still open for this client, nearest deadline first as the API
 * gives them. The client answers here and never closes one; the client is the one of the address, which the portal shell proved.
 */
export function PortalRequestsPage() {
  const client = usePortalClient();
  const { clienteId = '' } = useParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = usePortalMaterialRequests(clienteId);
  useDocumentTitle('Pedidos da agência — Portal do cliente — Ageniza');
  const today = todayInSaoPaulo();

  // A retry keeps the failure and its button mounted (and the focus on it): only the first read is a skeleton.
  const firstRead = requests.isPending && requests.errorUpdateCount === 0;
  const data = requests.data?.data ?? [];
  const total = requests.data?.meta.totalItems ?? 0;
  const current = openId === null ? undefined : data.find((request) => request.threadId === openId);

  return <section className="portal-requests-page" aria-labelledby="portal-requests-page-title">
    <header className="portal-requests-page__head">
      <div>
        <h1 id="portal-requests-page-title" className="portal-headline">Pedidos da agência</h1>
        <p className="portal-requests-page__lead">Material que falta para os próximos posts.</p>
      </div>
      {total > 0 && <span className="portal-requests-page__count"><Inbox aria-hidden="true" />{total} {total === 1 ? 'pedido' : 'pedidos'}</span>}
    </header>
    {firstRead && <div className="portal-requests-page__skeleton" aria-busy="true"><Skeleton /><Skeleton /></div>}
    {!firstRead && requests.data === undefined && <EmptyState kind="failure" className="portal-empty" headingLevel={2} title="Não foi possível carregar os pedidos da agência."
      retrying={requests.isFetching}
      onRetry={() => { void requests.refetch(); }}
    />}
    {requests.data !== undefined && data.length === 0 && <EmptyState kind="good-news" className="portal-empty" headingLevel={2} title="Nenhum pedido aberto"
      description={`A ${client.agencyName} não está esperando nenhum material seu.`}
    />}
    {data.length > 0 && <ul className="portal-requests-page__list">
      {data.map((request) => <RequestCard key={request.threadId} clientId={clienteId} request={request} agencyName={client.agencyName} today={today} onOpen={() => setOpenId(request.threadId)} />)}
    </ul>}
    {total > data.length && <p className="portal-requests-page__more">Mostrando {data.length} de {total}</p>}
    {current !== undefined && <RequestThread clientId={clienteId} request={current} onClose={() => setOpenId(null)} />}
  </section>;
}
