import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { AuthLogoutAllResponseSchema, AuthLogoutResponseSchema, type AuthUser } from '@ageniza/contracts';
import { Button, ConfirmDialog, Menu, MenuItem, MenuSeparator, Skeleton } from '@ageniza/ui';

import { useAuthSession, useOptionalAuthSessionStore, type AuthSessionStore } from './auth.js';
import { HttpClientError, useApiClient } from './http.js';

type LogoutAction = 'logout' | 'logout-all';

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
const logoutAllLabel = 'Sair de todas as sess\u00f5es';

export interface AccountMenuProps {
  activeContext?: string;
  user?: AuthUser | null;
}

export function AccountMenu({ activeContext, user: userOverride }: AccountMenuProps) {
  const httpClient = useApiClient();
  const authStore = useOptionalAuthSessionStore();
  const session = useAuthSession(userOverride === undefined ? (authStore ?? fallbackAuthStore) : fallbackAuthStore);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<LogoutAction | null>(null);
  const [failedAction, setFailedAction] = useState<LogoutAction | null>(null);

  const user = userOverride === undefined ? session.user : userOverride;

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

  return (
    <div className='account-menu'>
      <Menu label='Menu da conta' trigger={<><span>{user.name}</span><span aria-hidden='true'>{'\u2304'}</span></>}>
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
        <MenuSeparator />
        <MenuItem onClick={() => { void startLogout('logout'); }}>Sair</MenuItem>
        <MenuSeparator />
        <MenuItem variant='destructive' onClick={() => { setFailedAction(null); setConfirmOpen(true); }}>
          {logoutAllLabel}
        </MenuItem>
      </Menu>
      {failedAction !== null && (
        <div className='account-menu__error' role='alert'>
          <span>{failedMessage}</span>
          <Button size='sm' variant='ghost' onClick={() => { void startLogout(failedAction); }}>Tentar de novo</Button>
        </div>
      )}
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
