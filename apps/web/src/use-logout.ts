import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { AuthLogoutAllResponseSchema, AuthLogoutResponseSchema } from '@ageniza/contracts';

import { useOptionalAuthSessionStore } from './auth.js';
import { forgetGoogleInvite } from './google-sign-in.js';
import { HttpClientError, useApiClient } from './http.js';

export type LogoutAction = 'logout' | 'logout-all';

/** The sign-out of the account menu and of the Conta page: one call, one way out to the entry screen. */
export function useLogout() {
  const httpClient = useApiClient();
  const authStore = useOptionalAuthSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<LogoutAction | null>(null);
  const [failedAction, setFailedAction] = useState<LogoutAction | null>(null);

  const finish = (): void => {
    queryClient.clear();
    forgetGoogleInvite();
    authStore?.end();
    navigate('/entrar', { replace: true });
  };

  /** Resolves true when the person is out; a failure leaves `failedAction` set. */
  const logout = async (action: LogoutAction): Promise<boolean> => {
    setFailedAction(null);
    setPendingAction(action);
    try {
      await httpClient.request({
        path: action === 'logout' ? '/auth/logout' : '/auth/logout-all',
        method: 'POST',
        response: action === 'logout' ? AuthLogoutResponseSchema : AuthLogoutAllResponseSchema
      });
      finish();
      return true;
    } catch (error: unknown) {
      // A session revoked elsewhere answers 401; the person asked to leave, so that is the outcome they wanted.
      if (error instanceof HttpClientError && error.status === 401) {
        finish();
        return true;
      }
      setFailedAction(action);
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  return { logout, pendingAction, failedAction, clearFailure: () => { setFailedAction(null); } };
}
