import { useEffect } from 'react';

import { AuthSessionResponseSchema } from '@ageniza/contracts';
import { useApiClient } from './http.js';

/** Within the 30 to 60 s the owner asked for: a person removed from the agency waits at most this long to be signed out. */
export const SESSION_CHECK_INTERVAL_MS = 45_000;
/** Coming back to the tab right after a check asks nothing: switching tabs often must not become a request each time. */
export const FOCUS_CHECK_MIN_GAP_MS = 10_000;

/**
 * Keeps an open tab honest about its session. Removing a person ends their sessions on the server,
 * but a tab that sends no request would keep showing the old screen, so this asks
 * `GET /auth/session/check` on a timer and when the tab comes back to the foreground. That route reads
 * the session without renewing it: a forgotten tab must not keep the session alive past the 7 days
 * without use (2026-10-08). A 401 is the HTTP client's business: it ends the session and sends the
 * person to the login (`SessionEndRedirect`). Any other failure is not proof of anything and waits for
 * the next check.
 */
export function SessionWatch() {
  const client = useApiClient();

  useEffect(() => {
    let inFlight = false;
    let lastCheckAt = Number.NEGATIVE_INFINITY;
    let timer: number | undefined;

    const check = (): void => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      lastCheckAt = Date.now();
      // Every check restarts the interval, so a check made on focus is not followed by the tick a moment later.
      window.clearInterval(timer);
      timer = window.setInterval(check, SESSION_CHECK_INTERVAL_MS);
      client.request({ path: '/auth/session/check', response: AuthSessionResponseSchema })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    const onVisibilityChange = (): void => {
      if (Date.now() - lastCheckAt < FOCUS_CHECK_MIN_GAP_MS) return;
      check();
    };

    timer = window.setInterval(check, SESSION_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client]);

  return null;
}
