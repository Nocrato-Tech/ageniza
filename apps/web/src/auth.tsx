import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';

import type { BrowserConfig } from '@ageniza/config/browser';

export interface AuthSessionSnapshot {
  status: 'loading' | 'ready';
  isAuthenticated: boolean;
}

export interface AuthSessionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AuthSessionSnapshot;
  getAccessToken(): Promise<string | null>;
  dispose(): void;
}

/** Creates a browser-only Supabase client using only the public project URL and anon key. */
export const createSupabaseBrowserClient = (config: Pick<BrowserConfig, 'supabaseUrl' | 'supabaseAnonKey'>): SupabaseClient =>
  createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

const snapshotFor = (session: Session | null): AuthSessionSnapshot => ({ status: 'ready', isAuthenticated: session !== null });

/** Bridges Supabase's session lifecycle into React without exposing tokens to page components. */
export const createAuthSessionStore = (client: SupabaseClient): AuthSessionStore => {
  let snapshot: AuthSessionSnapshot = { status: 'loading', isAuthenticated: false };
  let initialized = false;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: AuthSessionSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    const activeGeneration = ++generation;
    let authEventSeen = false;
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      authEventSeen = true;
      if (generation === activeGeneration) publish(snapshotFor(session));
    });
    unsubscribe = () => subscription.data.subscription.unsubscribe();
    void client.auth.getSession().then(({ data }) => {
      if (generation === activeGeneration && !authEventSeen) publish(snapshotFor(data.session));
    }).catch(() => {
      if (generation === activeGeneration && !authEventSeen) publish({ status: 'ready', isAuthenticated: false });
    });
  };
  const teardown = (): void => {
    generation += 1;
    initialized = false;
    unsubscribe?.();
    unsubscribe = undefined;
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
    getAccessToken: async () => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session?.access_token ?? null;
    },
    dispose() { teardown(); listeners.clear(); }
  };
};

export const useAuthSession = (store: AuthSessionStore): AuthSessionSnapshot =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
