import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';

import type { AuthSessionStore } from './auth.js';

export const LOGIN_PATH = '/entrar';
export const DESTINATION_PARAM = 'destino';

export interface SessionEndSignal {
  notify(): void;
  subscribe(listener: () => void): () => void;
}

/** Bridges the HTTP client, which lives outside React, to the router that has to react to it. */
export const createSessionEndSignal = (): SessionEndSignal => {
  const listeners = new Set<() => void>();
  return {
    notify: () => listeners.forEach((listener) => listener()),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
};

/** The login address that brings the person back to where they were once authenticated again. */
export const loginPathPreserving = (location: Pick<Location, 'pathname' | 'search' | 'hash'>): string => {
  if (location.pathname === LOGIN_PATH) return `${location.pathname}${location.search}${location.hash}`;
  const destination = `${location.pathname}${location.search}${location.hash}`;
  return `${LOGIN_PATH}?${new URLSearchParams({ [DESTINATION_PARAM]: destination }).toString()}`;
};

const ORIGIN_PROBE = 'https://ageniza.invalid';

/**
 * Reads the preserved destination from the login address. The parameter arrives from the URL bar, so
 * anything that could leave the application -- another origin, a protocol-relative or backslash path
 * -- is discarded instead of followed.
 */
export const sessionDestination = (search: string): string | null => {
  const raw = new URLSearchParams(search).get(DESTINATION_PARAM);
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  let resolved: URL;
  try { resolved = new URL(raw, ORIGIN_PROBE); } catch { return null; }
  if (resolved.origin !== ORIGIN_PROBE || resolved.pathname === LOGIN_PATH) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};

/**
 * Ends the session globally when any request proves it is gone: the session is dropped, every cached
 * response of the previous session is discarded so nothing stale stays on screen, and the person is
 * sent to the login with the current address preserved.
 */
export function SessionEndRedirect({ signal, authStore }: { signal: SessionEndSignal; authStore: AuthSessionStore }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const locationRef = useRef(location);

  useEffect(() => { locationRef.current = location; }, [location]);

  useEffect(() => signal.subscribe(() => {
    authStore.end();
    queryClient.clear();
    navigate(loginPathPreserving(locationRef.current), { replace: true });
  }), [signal, authStore, queryClient, navigate]);

  return null;
}
