import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  AuthLogoutAllResponseSchema,
  AuthLogoutResponseSchema,
  MeContextsResponseSchema,
  PutLastContextResponseSchema,
  type AuthUser,
  type Context
} from '@ageniza/contracts';
import { Button, ConfirmDialog, Menu, MenuItem, MenuSeparator, Skeleton } from '@ageniza/ui';

import { useAuthSession, useOptionalAuthSessionStore, type AuthSessionStore } from './auth.js';
import { contextDestination, targetFromDestination, type ContextTarget } from './context-destination.js';
import { contextDescription, contextKey, contextTitle } from './context-labels.js';
import { EmailChangeDialog } from './email-change.js';
import { HttpClientError, useApiClient } from './http.js';

type LogoutAction = 'logout' | 'logout-all';
type AccountMenuPanel = 'root' | 'switch';

const fallbackAuthSnapshot = { status: 'ready' as const, isAuthenticated: false, user: null };
const fallbackAuthStore: AuthSessionStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => fallbackAuthSnapshot,
  refresh: async () => undefined,
  end: () => undefined,
  dispose: () => undefined
};

const logoutErrorMessage = 'N\u00e3o foi poss\u00edvel sair. Tente de novo.';
const logoutAllErrorMessage = 'N\u00e3o foi poss\u00edvel encerrar todas as sess\u00f5es. Tente de novo.';
const contextsErrorMessage = 'N\u00e3o foi poss\u00edvel carregar seus contextos. Tente de novo.';
const switchErrorMessage = 'N\u00e3o foi poss\u00edvel trocar de contexto. Tente de novo.';
const logoutAllLabel = 'Sair de todas as sess\u00f5es';
const switchLabel = 'Trocar de contexto';
const emailChangeLabel = 'Pedir troca de e-mail';

/** Whether a context is the one the route is currently showing, derived from the address, not a name. */
const isCurrentContext = (context: Context, target: ContextTarget | null): boolean => {
  if (target === null) return false;
  if (context.type === 'agency') return target.type === 'agency' && context.agencyId === target.agencyId;
  return target.type === 'client' && context.clientId === target.clientId;
};

export interface AccountMenuProps {
  activeContext?: string;
  /** Offered only where a tour exists to review (the client portal); it reopens the tour and calls nothing. */
  onReviewTour?: () => void;
  user?: AuthUser | null;
}

export function AccountMenu({ activeContext, onReviewTour, user: userOverride }: AccountMenuProps) {
  const httpClient = useApiClient();
  const authStore = useOptionalAuthSessionStore();
  const session = useAuthSession(userOverride === undefined ? (authStore ?? fallbackAuthStore) : fallbackAuthStore);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<AccountMenuPanel>('root');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [emailChangeOpen, setEmailChangeOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<LogoutAction | null>(null);
  const [failedAction, setFailedAction] = useState<LogoutAction | null>(null);

  const user = userOverride === undefined ? session.user : userOverride;

  // The list is only needed once the menu opens, and only to decide whether switching is offered.
  const contexts = useQuery({
    queryKey: ['contexts', 'list'],
    queryFn: () => httpClient.request({ path: '/me/contexts', response: MeContextsResponseSchema }),
    enabled: menuOpen && user !== null
  });

  const switchContext = useMutation({
    mutationFn: (context: Context) => httpClient.request({
      path: '/me/last-context',
      method: 'PUT',
      body: context.type === 'agency'
        ? { type: 'agency' as const, agencyId: context.agencyId }
        : { type: 'client' as const, clientId: context.clientId },
      response: PutLastContextResponseSchema
    }),
    onSuccess: (_data, context) => {
      // A different context must never show the previous one's data, and switching does not touch the
      // session; only the data cache is dropped.
      queryClient.clear();
      navigate(contextDestination(context), { replace: true });
    }
  });

  const currentTarget = targetFromDestination(location.pathname);

  if (user === null || (userOverride === undefined && session.status === 'loading')) {
    return <Skeleton className='account-menu__skeleton' />;
  }

  const startLogout = async (action: LogoutAction): Promise<void> => {
    setFailedAction(null);
    setPendingAction(action);
    try {
      await httpClient.request({
        path: action === 'logout' ? '/auth/logout' : '/auth/logout-all',
        method: 'POST',
        response: action === 'logout' ? AuthLogoutResponseSchema : AuthLogoutAllResponseSchema
      });
      queryClient.clear();
      authStore?.end();
      navigate('/entrar', { replace: true });
    } catch (error: unknown) {
      // A session revoked elsewhere answers 401; the person asked to leave, so that is the outcome
      // they wanted. Finish the sign-out without state, over the destination the session-ended
      // redirect saved, so the next account is not sent back to the previous one's address.
      if (error instanceof HttpClientError && error.status === 401) {
        queryClient.clear();
        authStore?.end();
        navigate('/entrar', { replace: true });
        return;
      }
      setFailedAction(action);
      if (action === 'logout-all') setConfirmOpen(false);
    } finally {
      setPendingAction(null);
    }
  };

  const failedMessage = failedAction === 'logout-all' ? logoutAllErrorMessage : logoutErrorMessage;
  const canSwitch = contexts.data !== undefined && contexts.data.contexts.length > 1;

  return (
    <div className='account-menu'>
      <Menu
        label='Menu da conta'
        activePanel={panel}
        onOpenChange={(open) => { setMenuOpen(open); if (!open) setPanel('root'); }}
        trigger={<><span>{user.name}</span><span aria-hidden='true'>{'\u2304'}</span></>}
      >
        {panel === 'root' ? <>
          <div className='account-menu__identity' role='group' aria-label='Conta'>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          {activeContext !== undefined && (
            <div className='account-menu__context' role='group' aria-label='Contexto ativo'>
              <span className='account-menu__context-label'>Contexto ativo</span>
              <strong>{activeContext}</strong>
            </div>
          )}
          {contexts.isPending && <div className='account-menu__loading'><Skeleton /></div>}
          {contexts.isError && (
            <div className='account-menu__menu-error' role='group'>
              <span role='alert'>{contextsErrorMessage}</span>
              <Button size='sm' variant='ghost' onClick={() => { void contexts.refetch(); }}>Tentar de novo</Button>
            </div>
          )}
          {canSwitch && (
            <MenuItem onClick={(event) => { event.preventDefault(); setPanel('switch'); }}>
              {switchLabel} <span aria-hidden='true'>{'\u203A'}</span>
            </MenuItem>
          )}
          {onReviewTour !== undefined && <MenuItem onClick={onReviewTour}>Rever o tour</MenuItem>}
          <MenuItem onClick={() => { setEmailChangeOpen(true); }}>{emailChangeLabel}</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => { void startLogout('logout'); }}>Sair</MenuItem>
          <MenuSeparator />
          <MenuItem variant='destructive' onClick={() => { setFailedAction(null); setConfirmOpen(true); }}>
            {logoutAllLabel}
          </MenuItem>
        </> : <>
          <MenuItem onClick={(event) => { event.preventDefault(); setPanel('root'); }}>
            <span aria-hidden='true'>{'\u2039'}</span> {switchLabel}
          </MenuItem>
          <MenuSeparator />
          {contexts.data?.contexts.map((context) => {
            const isCurrent = isCurrentContext(context, currentTarget);
            return <MenuItem
              key={contextKey(context)}
              aria-current={isCurrent ? 'true' : undefined}
              disabled={switchContext.isPending}
              onClick={(event) => { event.preventDefault(); switchContext.mutate(context); }}
            >
              <span className='account-menu__context-option'>
                <span className='account-menu__context-check' aria-hidden='true'>{isCurrent ? '\u2713' : ''}</span>
                <span className='account-menu__context-name'>{contextTitle(context)}</span>
                <span className='account-menu__context-description'>{contextDescription(context)}</span>
              </span>
            </MenuItem>;
          })}
          {switchContext.isError && (
            <div className='account-menu__menu-error' role='group'>
              <span role='alert'>{switchErrorMessage}</span>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => { if (switchContext.variables !== undefined) switchContext.mutate(switchContext.variables); }}
              >
                Tentar de novo
              </Button>
            </div>
          )}
        </>}
      </Menu>
      {failedAction !== null && (
        <div className='account-menu__error' role='alert'>
          <span>{failedMessage}</span>
          <Button size='sm' variant='ghost' onClick={() => { void startLogout(failedAction); }}>Tentar de novo</Button>
        </div>
      )}
      {emailChangeOpen && <EmailChangeDialog onClose={() => { setEmailChangeOpen(false); }} />}
      <ConfirmDialog
        open={confirmOpen}
        title={`${logoutAllLabel}?`}
        description={'Isso encerra o acesso em todos os dispositivos. Ser\u00e1 preciso entrar de novo.'}
        confirmLabel={logoutAllLabel}
        cancelLabel='Cancelar'
        busy={pendingAction === 'logout-all'}
        onConfirm={() => { void startLogout('logout-all'); }}
        onCancel={() => { if (pendingAction === null) setConfirmOpen(false); }}
      />
    </div>
  );
}
