import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Hourglass, Plus, TriangleAlert } from 'lucide-react';

import { ThreadListResponseSchema, type ClientDetailResponse, type Thread } from '@ageniza/contracts';
import { Button, Pill, Skeleton, StatusTag } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { todayInSaoPaulo } from './content-dates.js';
import {
  awaitsViewer,
  deadlineLabel,
  isOverdue,
  MATERIAL_REQUEST_LABEL,
  MaterialRequestDialog,
  OpenThread,
  routesOf,
  scopeKeyOf,
  type ConversationProps,
  type ConversationScope
} from './conversation.js';
import { useApiClient } from './http.js';

const PAGE_SIZE = 100;
const dayFormatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', timeZone: 'America/Sao_Paulo' });

/** "9 nov": the agency's day of an instant. */
const dayOf = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dayFormatter.format(date).replace('.', '');
};

const useMaterialThreads = (scope: ConversationScope) => {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: [...scopeKeyOf(scope), 'threads', 'material-request'],
    queryFn: async ({ signal }) => {
      const read = async (state: Thread['state']) => await httpClient.request({
        path: `${routesOf(scope).threads}?materialRequest=true&state=${state}&pageSize=${PAGE_SIZE}`,
        response: ThreadListResponseSchema,
        signal
      });
      const [open, resolved] = await Promise.all([read('open'), read('resolved')]);
      return { open, resolved };
    }
  });
};

/** Who the request is waiting on and what was last said, in the words of the board's rows. */
const whoLine = (thread: Thread): string => {
  if (thread.state === 'resolved') {
    return `Resolvida ${thread.resolvedBy?.name ? `por ${thread.resolvedBy.name}` : 'pela agência'}${thread.resolvedAt === null ? '' : ` em ${dayOf(thread.resolvedAt)}`}`;
  }
  if (thread.lastComment.side === 'client') return `Cliente · ${dayOf(thread.lastComment.at)}`;
  return thread.openedBy.name === null ? 'Aberta pela agência' : `Aberta por ${thread.openedBy.name} (agência)`;
};

function RequestRow({ thread, today, onOpen }: { thread: Thread; today: string; onOpen: () => void }) {
  const overdue = isOverdue(thread, today);
  const awaiting = awaitsViewer(thread, 'agency');
  const title = thread.title ?? MATERIAL_REQUEST_LABEL;
  return <li>
    <button type="button" className="client-requests__row" onClick={onOpen}>
      <span className="client-requests__main">
        <span className="client-requests__title">{title}</span>
        <span className="client-requests__sub">“{thread.lastComment.excerpt}” · {whoLine(thread)}</span>
        {thread.state === 'open' && thread.dueOn !== null && (overdue
          ? <span className="client-requests__due client-requests__due--late"><TriangleAlert aria-hidden="true" />{deadlineLabel(thread.dueOn)} · atrasado</span>
          : <span className="client-requests__due">{deadlineLabel(thread.dueOn)}</span>)}
      </span>
      {thread.state === 'resolved'
        ? <StatusTag status="ready">resolvida</StatusTag>
        : awaiting ? <StatusTag status="production">aguardando você</StatusTag> : <StatusTag status="waiting">aberta</StatusTag>}
    </button>
  </li>;
}

/**
 * "Pedidos de material" of the Visão geral: the requests the agency made to the client, open ones first (the API orders each state by
 * activity), each with its title, the last words, the deadline and who it waits on. A row opens the thread, as the conversation does.
 */
export function ClientMaterialRequests({ client }: { client: ClientDetailResponse }) {
  const agency = useAgencyContext();
  const canSeeClient = useCan('cliente.visualizar');
  const canOperate = useCan('cliente.operar');
  const blocked = useWriteBlocked();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('pedido');
  const [openId, setOpenId] = useState<string | null>(requested);
  // A notification opens this page with `?pedido=`; the request opens once the list holds it, and an unknown one opens nothing.
  useEffect(() => { if (requested !== null) setOpenId(requested); }, [requested]);
  const closeRequest = (): void => {
    setOpenId(null);
    if (requested !== null) setSearchParams((params) => { const next = new URLSearchParams(params); next.delete('pedido'); return next; }, { replace: true });
  };
  const [creating, setCreating] = useState(false);
  const scope: ConversationScope = { side: 'agency', agencyId: agency.agencyId, clientId: client.id };
  const threads = useMaterialThreads(scope);
  if (!canSeeClient) return null;

  const today = todayInSaoPaulo();
  const props: ConversationProps = {
    scope,
    subject: { materialRequest: true },
    subjectLabel: MATERIAL_REQUEST_LABEL,
    canWrite: canOperate,
    readOnly: client.status !== 'active',
    planBlockedReason: blocked,
    headingLevel: 3,
    onWritten: () => undefined
  };
  const list = threads.data === undefined ? [] : [...threads.data.open.data, ...threads.data.resolved.data];
  const total = threads.data === undefined ? 0 : threads.data.open.meta.totalItems + threads.data.resolved.meta.totalItems;
  const openCount = threads.data?.open.meta.totalItems ?? 0;
  const truncated = threads.data !== undefined && (threads.data.open.meta.totalItems > PAGE_SIZE || threads.data.resolved.meta.totalItems > PAGE_SIZE);
  const current = openId === null ? undefined : list.find((thread) => thread.id === openId);

  return <section className="client-general__requests client-requests" aria-labelledby="client-requests-title">
    <header className="client-requests__head">
      <div className="client-requests__heading">
        <h2 id="client-requests-title">Pedidos de material</h2>
        {threads.data !== undefined && <Pill>{total}</Pill>}
        {openCount > 0 && <span className="client-requests__waiting"><Hourglass aria-hidden="true" />{openCount} aguardando</span>}
      </div>
      {canOperate && client.status === 'active' && threads.data !== undefined && <Button variant="secondary" leadingIcon={<Plus />} blockedReason={blocked} onClick={() => setCreating(true)}>Pedir material</Button>}
    </header>
    {threads.isPending && <div className="client-requests__skeleton" aria-busy="true"><Skeleton /><Skeleton /></div>}
    {threads.isError && threads.data === undefined && <div role="alert" className="client-requests__failure">
      <p>Não foi possível carregar os pedidos de material.</p>
      <Button size="sm" variant="secondary" loading={threads.isFetching} onClick={() => { void threads.refetch(); }}>Tentar de novo</Button>
    </div>}
    {threads.data !== undefined && list.length === 0 && <p className="client-requests__empty">Nenhum pedido de material</p>}
    {list.length > 0 && <ul className="client-requests__list">
      {list.map((thread) => <RequestRow key={thread.id} thread={thread} today={today} onOpen={() => setOpenId(thread.id)} />)}
    </ul>}
    {truncated && <p className="client-requests__note">Mostrando os {PAGE_SIZE} pedidos mais recentes de cada situação.</p>}
    <p className="client-requests__note">Abertos primeiro, depois resolvidos. Depois de enviada, a mensagem não pode ser editada nem apagada.</p>
    {current !== undefined && <OpenThread props={props} thread={current} onClose={closeRequest} />}
    {creating && <MaterialRequestDialog props={props} onClose={() => setCreating(false)} />}
  </section>;
}
