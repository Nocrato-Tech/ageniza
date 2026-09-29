import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';

import type { AuthSessionStore } from './auth.js';

export const LOGIN_PATH = '/entrar';
export const MAX_DESTINATION_LENGTH = 2_048;
/** Long enough to sign in again, short enough that a forgotten tab does not hold an old address. */
export const DESTINATION_TTL_MS = 30 * 60_000;

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

export interface SessionDestinationState {
  sessionDestination: { path: string; savedAt: number };
}

type AddressLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;

/** Matches the login route the way the router does: case, a trailing slash and percent-encoding do not matter. */
export const isLoginPath = (pathname: string): boolean => {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* an undecodable path is not the login route */ }
  return decoded.toLowerCase().replace(/\/+$/, '') === LOGIN_PATH;
};

/**
 * Where to send the person when the session ends. The destination travels in navigation state, never
 * in the login URL: an address such as `/convite/<token>` or `/senha/redefinir?token=…` is a live
 * credential, and copying it into a query string would repeat it in history, reloads and referers.
 */
export const loginNavigation = (location: AddressLocation, now: number = Date.now()): { to: string; state?: SessionDestinationState } => {
  const path = `${location.pathname}${location.search}${location.hash}`;
  if (path.length > MAX_DESTINATION_LENGTH) return { to: LOGIN_PATH };
  return { to: LOGIN_PATH, state: { sessionDestination: { path, savedAt: now } } };
};

const ORIGIN_PROBE = 'https://ageniza.invalid';

/**
 * Reads the destination the login screen returns to after authenticating. Anything expired, oversized,
 * outside the application, or pointing back at the login is discarded instead of followed.
 */
export const sessionDestination = (state: unknown, now: number = Date.now()): string | null => {
  if (typeof state !== 'object' || state === null || !('sessionDestination' in state)) return null;
  const saved = (state as { sessionDestination: unknown }).sessionDestination;
  if (typeof saved !== 'object' || saved === null) return null;
  const { path, savedAt } = saved as { path?: unknown; savedAt?: unknown };
  if (typeof path !== 'string' || typeof savedAt !== 'number') return null;
  if (now < savedAt || now - savedAt > DESTINATION_TTL_MS || path.length > MAX_DESTINATION_LENGTH) return null;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  let resolved: URL;
  try { resolved = new URL(path, ORIGIN_PROBE); } catch { return null; }
  if (resolved.origin !== ORIGIN_PROBE || isLoginPath(resolved.pathname)) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};

/**
 * Ends the session globally when any request proves it is gone: the session is dropped, every cached
 * response of the previous session is discarded so nothing stale stays on screen, and the person is
 * sent to the login with the current address kept for the way back.
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
    if (isLoginPath(locationRef.current.pathname)) return;
    const { to, state } = loginNavigation(locationRef.current);
    navigate(to, { replace: true, state });
  }), [signal, authStore, queryClient, navigate]);

  return null;
}
