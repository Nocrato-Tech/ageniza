import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import { AuthSessionResponseSchema, type AuthUser } from '@ageniza/contracts';
import { HttpClientError, type HttpClient } from './http.js';

export interface AuthSessionSnapshot {
  status: 'loading' | 'ready';
  isAuthenticated: boolean;
  user: AuthUser | null;
}

export interface AuthSessionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AuthSessionSnapshot;
  refresh(): Promise<void>;
  /** Drops the session at once, without asking the API, after a request proved it has ended. */
  end(): void;
  dispose(): void;
}

/**
 * Session state for the browser. The API issues an httpOnly cookie (Better Auth, ADR 0011), so the
 * page never holds a token: `GET /auth/session` answering is itself the proof of an active session,
 * and 401 is the ordinary answer for a visitor, not a failure.
 */
export interface AuthSessionStoreOptions {
  /**
   * Runs before a newly confirmed session is published, so nothing cached under a previous session
   * can render for the next person who signs in on the same browser.
   */
  onSessionStarted?: () => void;
}

export const createAuthSessionStore = (client: HttpClient, options: AuthSessionStoreOptions = {}): AuthSessionStore => {
  let snapshot: AuthSessionSnapshot = { status: 'loading', isAuthenticated: false, user: null };
  let initialized = false;
  // Guards against React Strict Mode replaying subscribe/unsubscribe: a resolution belonging to a
  // previous generation must never publish over the current one.
  let generation = 0;
  const listeners = new Set<() => void>();

  const publish = (next: AuthSessionSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const load = async (activeGeneration: number): Promise<void> => {
    try {
      const response = await client.request({ path: '/auth/session', response: AuthSessionResponseSchema });
      if (generation !== activeGeneration) return;
      if (!snapshot.isAuthenticated) options.onSessionStarted?.();
      client.confirmSession();
      publish({ status: 'ready', isAuthenticated: true, user: response.user });
    } catch (error: unknown) {
      // Only an authenticated answer proves a session; every other outcome -- 401, network, an
      // unparseable body -- leaves the page unauthenticated rather than guessing.
      if (generation === activeGeneration) publish({ status: 'ready', isAuthenticated: false, user: null });
      if (!(error instanceof HttpClientError)) throw error;
    }
  };

  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    void load(++generation);
  };

  const teardown = (): void => {
    generation += 1;
    initialized = false;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      initialize();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) teardown();
      };
    },
    getSnapshot: () => snapshot,
    /** Re-reads the session after login, logout, or any action that can end it server-side. */
    refresh: async () => { await load(++generation); },
    end() {
      generation += 1;
      publish({ status: 'ready', isAuthenticated: false, user: null });
    },
    dispose() { teardown(); listeners.clear(); }
  };
};

export const useAuthSession = (store: AuthSessionStore): AuthSessionSnapshot =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

const AuthSessionStoreContext = createContext<AuthSessionStore | null>(null);

/** Publishes the session store so a screen can end the session after a server-side sign-out. */
export function AuthSessionProvider({ store, children }: { store: AuthSessionStore; children: ReactNode }) {
  return <AuthSessionStoreContext.Provider value={store}>{children}</AuthSessionStoreContext.Provider>;
}

export const useAuthSessionStore = (): AuthSessionStore => {
  const store = useContext(AuthSessionStoreContext);
  if (store === null) throw new Error('AuthSessionProvider is required.');
  return store;
};

export const useOptionalAuthSessionStore = (): AuthSessionStore | null => useContext(AuthSessionStoreContext);
