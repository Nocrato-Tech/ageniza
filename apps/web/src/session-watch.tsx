import { useEffect } from 'react';

import { AuthSessionResponseSchema } from '@ageniza/contracts';
import { useApiClient } from './http.js';

/** Within the 30 to 60 s the owner asked for: a person removed from the agency waits at most this long to be signed out. */
export const SESSION_CHECK_INTERVAL_MS = 45_000;

/**
 * Keeps an open tab honest about its session. Removing a person ends their sessions on the server,
 * but a tab that sends no request would keep showing the old screen, so this asks `GET /auth/session`
 * on a timer and when the tab comes back to the foreground. A 401 is the HTTP client's business: it
 * ends the session and sends the person to the login (`SessionEndRedirect`). Any other failure is
 * not proof of anything and waits for the next check.
 */
export function SessionWatch() {
  const client = useApiClient();

  useEffect(() => {
    let inFlight = false;
    const check = (): void => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      client.request({ path: '/auth/session', response: AuthSessionResponseSchema })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(check, SESSION_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [client]);

  return null;
}
