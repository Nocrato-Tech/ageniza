import { useEffect, useId, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';

import {
  CommentListResponseSchema,
  CommentSchema,
  MaterialRequestListResponseSchema,
  type MaterialRequest
} from '@ageniza/contracts';
import { Button, EmptyState, Modal, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { todayInSaoPaulo } from './content-dates.js';
import { CommentItem, Composer, MATERIAL_REQUEST_LABEL, MaterialDue, routesOf, writeError } from './conversation.js';
import { useApiClient } from './http.js';
import { PORTAL_PAUSED_REASON } from './plan-notice.js';
import { isClientRosterKey } from './portal-brand.js';
import { usePortalClient } from './portal.js';

const LIST_PATH = '/clients/:clientId/material-requests';

export const portalMaterialRequestsKey = (clientId: string) => ['portal', clientId, 'material-requests'] as const;
const commentsKey = (clientId: string, threadId: string) => [...portalMaterialRequestsKey(clientId), 'comments', threadId] as const;

/** The thread of one request: what the agency asked and what was answered, and the box to answer. The portal never resolves. */
function RequestThread({ clientId, request, onClose }: { clientId: string; request: MaterialRequest; onClose: () => void }) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const client = usePortalClient();
  const routes = routesOf({ side: 'client', clientId });
  const [sendError, setSendError] = useState<string | undefined>();
  const [sent, setSent] = useState(0);

  const comments = useInfiniteQuery({
    queryKey: commentsKey(clientId, request.threadId),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => httpClient.request({
      path: `${routes.comments(request.threadId)}?page=${pageParam}`,
      response: CommentListResponseSchema,
      signal
    }),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined)
  });
  // A request is a short exchange: reading it from the first message to the last keeps the answer just sent in view.
  useEffect(() => {
    if (comments.hasNextPage && !comments.isFetchingNextPage) void comments.fetchNextPage();
  }, [comments.hasNextPage, comments.isFetchingNextPage, comments.fetchNextPage]);

  const answer = useMutation({
    mutationFn: (body: string) => httpClient.request({
      path: routes.comments(request.threadId),
      method: 'POST',
      body: { body },
      response: CommentSchema
    }),
    onSuccess: () => {
      setSendError(undefined);
      setSent((count) => count + 1);
      void queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(clientId) });
      // The same person may also be in the agency of this client, with its conversations and roster cached in this browser.
      void queryClient.invalidateQueries({ queryKey: ['conversation'] });
      void queryClient.invalidateQueries({ queryKey: ['agency'], predicate: isClientRosterKey });
    },
    onError: (error: unknown) => { setSendError(writeError(error, 'client')); }
  });

  // A retry keeps the failure and its button mounted (and the focus on it): only the first read is a skeleton.
  const firstRead = comments.isPending && comments.errorUpdateCount === 0;
  const items = comments.data?.pages.flatMap((page) => page.data) ?? [];
  return <Modal title={MATERIAL_REQUEST_LABEL} closeLabel="Fechar conversa" onClose={onClose}>
    <div className="conversation__thread-view">
      <MaterialDue thread={request} today={todayInSaoPaulo()} />
      {firstRead && <div className="conversation__comments-skeleton" aria-busy="true"><Skeleton /><Skeleton /></div>}
      {!firstRead && comments.data === undefined && <EmptyState kind="failure" className="portal-empty" headingLevel={3} title="Não foi possível carregar a conversa."
        retrying={comments.isFetching}
        onRetry={() => { void comments.refetch(); }}
      />}
      {items.length > 0 && <ol className="conversation__comments">
        {items.map((comment) => <CommentItem key={comment.id} comment={comment} />)}
      </ol>}
      {client.agencyReadOnly
        ? <div className="conversation__actions"><Button blockedReason={PORTAL_PAUSED_REASON}>Responder</Button></div>
        : <Composer
          key={`${request.threadId}-${sent}`}
          label="Escrever resposta"
          submitLabel="Responder"
          pending={answer.isPending}
          error={sendError}
          onEdit={() => setSendError(undefined)}
          onSubmit={(body) => { setSendError(undefined); answer.mutate(body); }}
        />}
    </div>
  </Modal>;
}

function Request({ request, agencyName, onOpen }: { request: MaterialRequest; agencyName: string; onOpen: () => void }) {
  const id = useId();
  const today = todayInSaoPaulo();
  return <li className="portal-request">
    <span className="portal-request__icon" aria-hidden="true"><Inbox /></span>
    <div className="portal-request__text">
      <p id={`${id}-body`} className="portal-request__body">{request.body}</p>
      <p className="portal-request__meta">
        <span>Pedido de {agencyName}</span>
        <MaterialDue thread={request} today={today} />
      </p>
    </div>
    <Button variant="secondary" id={`${id}-button`} aria-labelledby={`${id}-button ${id}-body`} onClick={onOpen}>Responder</Button>
  </li>;
}

/**
 * "A agência pediu" of the Início: the open requests for material of this client, in the order the API gave (nearest deadline first).
 * The client answers and never opens one; with none open the block is not there, because it is optional and says nothing about
 * what is pending. A failed read shows only in the block.
 */
export function PortalMaterialRequests({ clientId }: { clientId: string }) {
  const httpClient = useApiClient();
  const client = usePortalClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: portalMaterialRequestsKey(clientId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(LIST_PATH, { clientId }),
      response: MaterialRequestListResponseSchema,
      signal
    })
  });

  // A retry keeps the failure and its button mounted (and the focus on it): only the first read is nothing.
  if (requests.isPending && requests.errorUpdateCount === 0) return null;
  if (requests.data === undefined) {
    return <section className="portal-section portal-requests" aria-labelledby="portal-requests-title">
      <h2 id="portal-requests-title" className="portal-section__title">A agência pediu</h2>
      <EmptyState kind="failure" className="portal-empty" headingLevel={3} title="Não foi possível carregar os pedidos da agência."
        retrying={requests.isFetching}
        onRetry={() => { void requests.refetch(); }}
      />
    </section>;
  }
  const { data, meta } = requests.data;
  if (data.length === 0) return null;
  const current = openId === null ? undefined : data.find((request) => request.threadId === openId);
  return <section className="portal-section portal-requests" aria-labelledby="portal-requests-title">
    <div className="portal-requests__head">
      <h2 id="portal-requests-title" className="portal-section__title">A agência pediu</h2>
      <span className="portal-requests__count"><Inbox aria-hidden="true" />{meta.totalItems} {meta.totalItems === 1 ? 'pedido' : 'pedidos'}</span>
    </div>
    <ul className="portal-requests__list">
      {data.map((request) => <Request key={request.threadId} request={request} agencyName={client.agencyName} onOpen={() => setOpenId(request.threadId)} />)}
    </ul>
    {meta.totalItems > data.length && <p className="portal-requests__more">Mostrando {data.length} de {meta.totalItems}</p>}
    {current !== undefined && <RequestThread clientId={clientId} request={current} onClose={() => setOpenId(null)} />}
  </section>;
}
