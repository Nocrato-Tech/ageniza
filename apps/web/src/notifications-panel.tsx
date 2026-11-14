import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlarmClock, Bell, CheckCheck, CircleCheck, Inbox, MessageSquareWarning, UserPlus, type LucideIcon } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import {
  AuthNoContentResponseSchema,
  NotificationListResponseSchema,
  NotificationUnreadCountResponseSchema,
  type Notification,
  type NotificationKind,
  type NotificationListResponse
} from '@ageniza/contracts';
import { Button, ButtonLink, Dialog, EmptyState, IconButton, Popover, Skeleton, Tabs } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { daysBetween, shortDayLabel, todayInSaoPaulo } from './content-dates.js';
import { useApiClient } from './http.js';
import { notificationPath } from './notification-target.js';
import { usePhone } from './use-phone.js';

const COUNT_REFRESH_MS = 60_000;
const BASE = '/agencies/:agencyId/notifications';

export const notificationsKey = (agencyId: string) => ['agency', agencyId, 'notifications'] as const;

export type NotificationFilter = 'all' | 'unread';

const KINDS: Record<NotificationKind, { icon: LucideIcon; tone: 'ready' | 'adjust' | 'request' | 'late' | 'team' }> = {
  content_approved: { icon: CircleCheck, tone: 'ready' },
  content_changes_requested: { icon: MessageSquareWarning, tone: 'adjust' },
  material_request_answered: { icon: Inbox, tone: 'request' },
  approval_deadline_passed: { icon: AlarmClock, tone: 'late' },
  invitation_accepted: { icon: UserPlus, tone: 'team' }
};

const dayOf = (ms: number): string => todayInSaoPaulo(new Date(ms));

/** "há 12 min", "há 3 h", "ontem", "há 3 dias", then the day: the agency's days, not the browser's. */
export const relativeTime = (at: string, now: number): string => {
  const then = Date.parse(at);
  const elapsed = now - then;
  if (elapsed < 60_000) return 'agora';
  if (elapsed < 3_600_000) return `há ${Math.floor(elapsed / 60_000)} min`;
  const days = daysBetween(dayOf(then), dayOf(now));
  if (days <= 0) return `há ${Math.floor(elapsed / 3_600_000)} h`;
  if (days === 1) return 'ontem';
  return days < 7 ? `há ${days} dias` : shortDayLabel(dayOf(then));
};

const groupLabel = (at: string, now: number): string => {
  const days = daysBetween(dayOf(Date.parse(at)), dayOf(now));
  if (days <= 0) return 'Hoje';
  return days === 1 ? 'Ontem' : shortDayLabel(dayOf(Date.parse(at)));
};

/** The dot of the bell. Every refresh is a plain read: this is not a connection, and a failed read is not "nothing new". */
export function useUnreadCount(agencyId: string): UseQueryResult<number> {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: [...notificationsKey(agencyId), 'unread-count'],
    queryFn: async ({ signal }) => (await httpClient.request({ path: apiPath(`${BASE}/unread-count`, { agencyId }), response: NotificationUnreadCountResponseSchema, signal })).data.count,
    staleTime: 0,
    refetchInterval: COUNT_REFRESH_MS,
    refetchOnWindowFocus: true
  });
}

export function useNotificationList(agencyId: string, filter: NotificationFilter, page: number, enabled = true): UseQueryResult<NotificationListResponse> {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: [...notificationsKey(agencyId), 'list', { filter, page }],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(BASE, { agencyId })}?page=${page}${filter === 'unread' ? '&unread=true' : ''}`,
      response: NotificationListResponseSchema,
      signal
    }),
    staleTime: 0,
    enabled
  });
}

/** Reading one or all, then both the list and the dot are read again. */
export function useNotificationActions(agencyId: string) {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: notificationsKey(agencyId) });
  const markRead = useMutation({
    mutationFn: (notificationId: string) => httpClient.request({
      path: apiPath(`${BASE}/:notificationId/read`, { agencyId, notificationId }), method: 'POST', response: AuthNoContentResponseSchema
    }),
    onSettled: refresh
  });
  const markAll = useMutation({
    mutationFn: () => httpClient.request({ path: apiPath(`${BASE}/read-all`, { agencyId }), method: 'POST', response: AuthNoContentResponseSchema }),
    onSettled: refresh
  });
  return { markRead, markAll };
}

export type NotificationActions = ReturnType<typeof useNotificationActions>;

export function MarkAllButton({ actions, unread }: { actions: NotificationActions; unread: number | undefined }) {
  return <Button
    variant="ghost"
    size="sm"
    leadingIcon={<CheckCheck />}
    loading={actions.markAll.isPending}
    disabled={unread === 0}
    onClick={() => { actions.markAll.mutate(); }}
  >Marcar todas como lidas</Button>;
}

function SkeletonRows() {
  return <div className="notif-skeleton" aria-busy="true">
    {[0, 1, 2].map((row) => <div key={row} className="notif-skeleton__row">
      <Skeleton className="notif-skeleton__icon" />
      <span className="notif-skeleton__text"><Skeleton /><Skeleton /></span>
      <Skeleton className="notif-skeleton__time" />
    </div>)}
  </div>;
}

function NotificationRow({ notification, agencyId, now, onOpen }: { notification: Notification; agencyId: string; now: number; onOpen: (notification: Notification) => void }) {
  const location = useLocation();
  const { icon: Icon, tone } = KINDS[notification.kind];
  const unread = notification.readAt === null;
  return <li>
    <Link
      className="notif-row"
      data-unread={unread || undefined}
      to={notificationPath(agencyId, notification.destination)}
      state={location.state}
      onClick={() => { onOpen(notification); }}
    >
      <span className={`notif-row__icon notif-row__icon--${tone}`} aria-hidden="true"><Icon /></span>
      <span className="notif-row__text">
        {unread && <span className="notif-row__sr">Não lida: </span>}
        {notification.summary}
      </span>
      <span className="notif-row__end">
        <time dateTime={notification.createdAt}>{relativeTime(notification.createdAt, now)}</time>
        {unread && <span className="notif-row__dot" aria-hidden="true" />}
      </span>
    </Link>
  </li>;
}

/** The three states of a list of notifications (specs/notificacoes.md section 7), and the rows grouped by day. */
export function NotificationList({ query, agencyId, filter, onOpen }: { query: UseQueryResult<NotificationListResponse>; agencyId: string; filter: NotificationFilter; onOpen: (notification: Notification) => void }) {
  // A retry of a query that never answered goes back to `pending`: the failure stays on screen and its button keeps the focus.
  if (query.isPending && query.errorUpdateCount === 0) return <SkeletonRows />;
  if (query.isError || query.isPending) {
    return <EmptyState kind="failure" headingLevel={3} title="Não foi possível carregar as notificações" retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />;
  }
  if (query.data.data.length === 0) {
    return <EmptyState
      kind="good-news"
      headingLevel={3}
      title="Nada novo por aqui"
      description={filter === 'unread' ? 'Nenhuma notificação por ler.' : 'Quando um cliente aprovar, pedir ajuste ou responder, você vê aqui.'}
    />;
  }
  const now = Date.now();
  const groups: { label: string; rows: Notification[] }[] = [];
  for (const notification of query.data.data) {
    const label = groupLabel(notification.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(notification);
    else groups.push({ label, rows: [notification] });
  }
  return <div className="notif-groups">
    {groups.map((group) => <section key={group.label} aria-label={group.label}>
      <h3 className="notif-groups__title">{group.label}</h3>
      <ul className="notif-groups__list">
        {group.rows.map((notification) => <NotificationRow key={notification.id} notification={notification} agencyId={agencyId} now={now} onOpen={onOpen} />)}
      </ul>
    </section>)}
  </div>;
}

function NotificationsPanel({ agencyId, actions, unread, sheet, onNavigate }: { agencyId: string; actions: NotificationActions; unread: number | undefined; sheet: boolean; onNavigate: () => void }) {
  const location = useLocation();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const query = useNotificationList(agencyId, filter, 1);
  const list = <NotificationList query={query} agencyId={agencyId} filter={filter} onOpen={(notification) => {
    if (notification.readAt === null) actions.markRead.mutate(notification.id);
    onNavigate();
  }} />;
  return <div className={sheet ? 'notif notif--sheet' : 'notif'}>
    <div className="notif__head">
      {!sheet && <h2 className="notif__title">Notificações</h2>}
      <MarkAllButton actions={actions} unread={unread} />
    </div>
    {actions.markAll.isError && <p className="notif__error" role="alert">Não foi possível marcar como lidas. Tente de novo.</p>}
    <Tabs
      label="Filtro"
      value={filter}
      onChange={(value) => { setFilter(value as NotificationFilter); }}
      items={[
        { value: 'all', label: 'Todas', content: list },
        { value: 'unread', label: 'Não lidas', count: unread !== undefined && unread > 0 ? unread : undefined, content: list }
      ]}
    />
    <div className="notif__foot">
      <ButtonLink as={Link} to={`/agencia/${agencyId}/notificacoes`} state={location.state} variant="ghost" size="sm" onClick={onNavigate}>Ver todas</ButtonLink>
    </div>
  </div>;
}

/**
 * The bell of the top bar (wide and phone): the dot while there is something unread, and the panel. On a wide screen the panel hangs
 * from the bell; on a phone it takes the screen. A read that failed leaves the bell without a dot.
 */
export function NotificationsBell({ agencyId }: { agencyId: string }) {
  const phone = usePhone();
  const queryClient = useQueryClient();
  const count = useUnreadCount(agencyId);
  const actions = useNotificationActions(agencyId);
  const [sheet, setSheet] = useState(false);
  const [closed, setClosed] = useState(0);
  const unread = count.status === 'success' ? count.data : undefined;

  // The panel may be open when the count changes: its list is read again, so the two never disagree.
  const previous = useRef(unread);
  useEffect(() => {
    if (previous.current !== unread) void queryClient.invalidateQueries({ queryKey: [...notificationsKey(agencyId), 'list'] });
    previous.current = unread;
  }, [agencyId, queryClient, unread]);

  const dot = unread === undefined || unread === 0 ? undefined : `${unread} ${unread === 1 ? 'não lida' : 'não lidas'}`;
  const trigger = (extra: object): ReactNode => <IconButton label="Notificações" dot={dot} icon={<Bell />} {...extra} />;
  const panel = (sheetMode: boolean) => <NotificationsPanel agencyId={agencyId} actions={actions} unread={unread} sheet={sheetMode} onNavigate={() => { setSheet(false); setClosed((value) => value + 1); }} />;

  if (phone) {
    return <span className="notif-bell">
      {trigger({ 'aria-haspopup': 'dialog', onClick: () => { setSheet(true); } })}
      {sheet && <Dialog title="Notificações" closeLabel="Fechar as notificações" size="lg" onClose={() => { setSheet(false); }}>{panel(true)}</Dialog>}
    </span>;
  }
  // The popover has no way to be closed from outside: a new key closes it once a row has taken the person elsewhere.
  return <Popover key={closed} className="notif-bell" label="Notificações" placement="bottom-end" strategy="fixed" trigger={trigger}>
    {panel(false)}
  </Popover>;
}
