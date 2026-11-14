import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Globe, Laptop, Monitor, ShieldOff, Smartphone } from 'lucide-react';

import {
  AuthNoContentResponseSchema,
  AuthRevokeOtherSessionsResponseSchema,
  AuthSessionListResponseSchema,
  type AuthActiveSession
} from '@ageniza/contracts';
import { Button, ConfirmDialog, EmptyState, Skeleton } from '@ageniza/ui';

import { HttpClientError, useApiClient } from './http.js';
import { useLogout } from './use-logout.js';

export const activeSessionsQueryKey = ['auth', 'sessions'] as const;

const ZONE = 'America/Sao_Paulo';
const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: ZONE });

/** Whole days between the São Paulo days of two instants: 01:30Z is still the evening before. */
const daysBetween = (from: string, to: Date): number => {
  const toDay = (value: Date): number => Date.parse(`${dayKey.format(value)}T00:00:00Z`);
  return Math.round((toDay(to) - toDay(new Date(from))) / 86_400_000);
};

/** The day of the last use, never the hour: the session only renews once a day of use. */
export const lastUseLabel = (lastUsedAt: string, now: Date = new Date()): string => {
  const days = daysBetween(lastUsedAt, now);
  if (days <= 0) return 'último uso hoje';
  if (days === 1) return 'último uso ontem';
  return `último uso há ${days} dias`;
};

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const sessionName = (session: Pick<AuthActiveSession, 'browser' | 'os'>): string => {
  if (session.browser !== null && session.os !== null) return `${session.browser} no ${session.os}`;
  if (session.browser !== null) return session.browser;
  if (session.os !== null) return `Navegador no ${session.os}`;
  return 'Aparelho desconhecido';
};

export const sessionMeta = (session: AuthActiveSession, now: Date = new Date()): string => {
  const use = session.current ? 'usando agora' : lastUseLabel(session.lastUsedAt, now);
  const text = session.city === null ? use : `${session.city} · ${use}`;
  return session.city === null ? capitalize(text) : text;
};

const deviceKind = (os: AuthActiveSession['os']): 'phone' | 'laptop' | 'computer' | 'unknown' => {
  if (os === null) return 'unknown';
  if (os === 'iOS' || os === 'Android') return 'phone';
  return os === 'macOS' || os === 'ChromeOS' ? 'laptop' : 'computer';
};

const DEVICE_ICONS = { phone: Smartphone, laptop: Laptop, computer: Monitor, unknown: Globe } as const;

const DeviceIcon = ({ os }: { os: AuthActiveSession['os'] }) => {
  const kind = deviceKind(os);
  const Icon = DEVICE_ICONS[kind];
  return <Icon aria-hidden="true" data-device={kind} />;
};

/** The sessions of the account; the account menu reads the same query to know whether "Sair de todas" is offered. */
export const useActiveSessions = (enabled = true) => {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: activeSessionsQueryKey,
    queryFn: () => httpClient.request({ path: '/auth/sessions', response: AuthSessionListResponseSchema }),
    enabled,
    staleTime: 0
  });
};

const revokeOneError = 'Não foi possível sair desse aparelho. Tente de novo.';
const signOutError = 'Não foi possível sair. Tente de novo.';
const revokeOthersError = 'Não foi possível encerrar as outras sessões. Tente de novo.';

const othersNotice = (revoked: number): string => {
  if (revoked === 0) return 'Não havia outras sessões abertas.';
  return revoked === 1 ? '1 outra sessão foi encerrada.' : `${revoked} outras sessões foram encerradas.`;
};

/** "Sessões ativas" and the danger card "Encerrar as outras sessões" (specs/auth.md section 14). */
export function AccountSessions() {
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const sessions = useActiveSessions();
  const [leaving, setLeaving] = useState<AuthActiveSession | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const signOut = useLogout();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const revokeOne = useMutation({
    mutationFn: (session: AuthActiveSession) => httpClient.request({
      path: `/auth/sessions/${encodeURIComponent(session.id)}`,
      method: 'DELETE',
      response: AuthNoContentResponseSchema
    }),
    onSuccess: (_data, session) => {
      setLeaving(null);
      setNotice(`Você saiu de ${sessionName(session)}.`);
      void queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey });
    },
    onError: (error) => {
      setLeaving(null);
      // A session that is already gone is the outcome that was asked for.
      if (error instanceof HttpClientError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey });
        return;
      }
      setFailure(revokeOneError);
    }
  });

  const revokeOthers = useMutation({
    mutationFn: () => httpClient.request({
      path: '/auth/sessions/revoke-others',
      method: 'POST',
      response: AuthRevokeOtherSessionsResponseSchema
    }),
    onSuccess: ({ revoked }) => {
      setConfirmOthers(false);
      setNotice(othersNotice(revoked));
      void queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey });
    },
    onError: () => {
      setConfirmOthers(false);
      setFailure(revokeOthersError);
    }
  });

  if (sessions.isPending) {
    return <section aria-labelledby="account-sessions-title" aria-busy="true">
      <div className="account-sessions__head"><h2 id="account-sessions-title">Sessões ativas</h2></div>
      <div className="account-sessions__list"><Skeleton className="account-sessions__skeleton" /><Skeleton className="account-sessions__skeleton" /></div>
    </section>;
  }

  if (sessions.isError) {
    return <section aria-labelledby="account-sessions-title">
      <div className="account-sessions__head"><h2 id="account-sessions-title">Sessões ativas</h2></div>
      <EmptyState
        kind="failure"
        mascot
        headingLevel={3}
        title="Não foi possível carregar as suas sessões. Tente de novo."
        retrying={sessions.isFetching}
        onRetry={() => { void sessions.refetch(); }}
      />
    </section>;
  }

  const list = sessions.data.sessions;
  const count = list.length;

  return <>
    <section aria-labelledby="account-sessions-title">
      <div className="account-sessions__head">
        <h2 id="account-sessions-title">Sessões ativas</h2>
        <p>{count === 1 ? '1 aparelho com a conta aberta.' : `${count} aparelhos com a conta aberta.`}</p>
      </div>
      {notice !== null && <p className="account-sessions__notice" role="status">{notice}</p>}
      {failure !== null && <p className="account-sessions__error" role="alert">{failure}</p>}
      {signOut.failedAction !== null && <p className="account-sessions__error" role="alert">{signOutError}</p>}
      <ul className="account-sessions__list">
        {list.map((session) => {
          const name = sessionName(session);
          return <li key={session.id} className={session.current ? 'account-session account-session--current' : 'account-session'}>
            <span className="account-session__thumb"><DeviceIcon os={session.os} /></span>
            <div className="account-session__text">
              <p className="account-session__name">
                {name}
                {session.current && <span className="account-session__tag"><Check aria-hidden="true" />Este aparelho</span>}
              </p>
              <p className="account-session__meta">{sessionMeta(session)}</p>
            </div>
            <Button
              className="account-session__action"
              variant="secondary"
              size="sm"
              aria-label={`Sair deste aparelho: ${name}`}
              disabled={session.current && signOut.pendingAction !== null}
              onClick={() => {
                setFailure(null);
                setNotice(null);
                if (session.current) void signOut.logout('logout');
                else setLeaving(session);
              }}
            >Sair deste aparelho</Button>
          </li>;
        })}
      </ul>
      <p className="account-sessions__hint">A cidade é aproximada e só aparece quando se sabe; quando não, a linha mostra só o último uso.</p>
    </section>

    {count >= 2 && <section className="account-danger" aria-labelledby="account-others-title">
      <div className="account-danger__text">
        <h2 id="account-others-title">Encerrar as outras sessões</h2>
        <p>Mantém só este aparelho. As outras sessões precisam entrar de novo.</p>
      </div>
      <Button variant="danger-quiet" leadingIcon={<ShieldOff />} onClick={() => { setFailure(null); setNotice(null); setConfirmOthers(true); }}>
        Sair de todas as outras
      </Button>
    </section>}

    <ConfirmDialog
      open={leaving !== null}
      title={leaving === null ? '' : `Sair de ${sessionName(leaving)}?`}
      description="Esse aparelho precisará entrar de novo."
      confirmLabel="Sair deste aparelho"
      cancelLabel="Cancelar"
      busy={revokeOne.isPending}
      onConfirm={() => { if (leaving !== null) revokeOne.mutate(leaving); }}
      onCancel={() => { if (!revokeOne.isPending) setLeaving(null); }}
    />
    <ConfirmDialog
      open={confirmOthers}
      title="Sair de todas as outras sessões?"
      description="Este aparelho continua aberto. As outras sessões precisam entrar de novo."
      confirmLabel="Sair de todas as outras"
      cancelLabel="Cancelar"
      busy={revokeOthers.isPending}
      onConfirm={() => { revokeOthers.mutate(); }}
      onCancel={() => { if (!revokeOthers.isPending) setConfirmOthers(false); }}
    />
  </>;
}
