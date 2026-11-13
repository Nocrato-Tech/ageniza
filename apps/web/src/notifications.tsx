import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { Pagination, Tabs } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { useDocumentTitle } from './document-title.js';
import {
  MarkAllButton,
  NotificationList,
  useNotificationActions,
  useNotificationList,
  useUnreadCount,
  type NotificationFilter
} from './notifications-panel.js';

const UNREAD_FILTER = 'nao-lidas';

const parsePage = (raw: string | null): number => {
  const page = Number(raw);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
};

/**
 * The page of the notifications (specs/notificacoes.md section 7): the whole list, 20 a page, with the "Não lidas" filter and the page
 * in the address, so the view is shareable and survives a reload.
 */
export function NotificationsPage() {
  const { agencyId } = useAgencyContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const filter: NotificationFilter = searchParams.get('filtro') === UNREAD_FILTER ? 'unread' : 'all';
  const page = parsePage(searchParams.get('page'));
  const query = useNotificationList(agencyId, filter, page);
  const count = useUnreadCount(agencyId);
  const actions = useNotificationActions(agencyId);
  const unread = count.status === 'success' ? count.data : undefined;
  const totalPages = query.data?.meta.totalPages ?? 0;
  useDocumentTitle('Notificações — Ageniza');

  const show = (next: { filter?: NotificationFilter; page?: number }, replace = false): void => {
    const params = new URLSearchParams(searchParams);
    const nextFilter = next.filter ?? filter;
    if (nextFilter === 'unread') params.set('filtro', UNREAD_FILTER);
    else params.delete('filtro');
    if ((next.page ?? 1) > 1) params.set('page', String(next.page));
    else params.delete('page');
    setSearchParams(params, { replace, state: location.state });
  };

  // A page past the end (a list that shrank after it was read) goes back to the last one instead of saying there is nothing.
  useEffect(() => {
    if (query.data !== undefined && query.data.data.length === 0 && page > 1 && totalPages > 0) show({ page: totalPages }, true);
  });

  const list = <>
    <NotificationList query={query} agencyId={agencyId} filter={filter} onOpen={(notification) => {
      if (notification.readAt === null) actions.markRead.mutate(notification.id);
    }} />
    {query.data !== undefined && query.data.data.length > 0 && <Pagination
      page={page}
      totalPages={totalPages}
      onPageChange={(next) => { show({ page: next }); }}
      summary={`${query.data.meta.totalItems} ${query.data.meta.totalItems === 1 ? 'notificação' : 'notificações'}`}
    />}
  </>;

  return <section aria-labelledby="notifications-title" className="notifications-page">
    <header className="notifications-page__head">
      <h1 id="notifications-title">Notificações</h1>
      <MarkAllButton actions={actions} unread={unread} />
    </header>
    {actions.markAll.isError && <p className="notif__error" role="alert">Não foi possível marcar como lidas. Tente de novo.</p>}
    <Tabs
      label="Filtro"
      value={filter}
      onChange={(value) => { show({ filter: value as NotificationFilter }); }}
      items={[
        { value: 'all', label: 'Todas', content: list },
        { value: 'unread', label: 'Não lidas', count: unread !== undefined && unread > 0 ? unread : undefined, content: list }
      ]}
    />
  </section>;
}
