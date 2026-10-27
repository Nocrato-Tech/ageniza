import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { AuthInvitationTokenSchema, AuthProvidersResponseSchema } from '@ageniza/contracts';
import { ButtonLink } from '@ageniza/ui';

import { useAuthSessionStore } from './auth.js';
import { AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { ownPathOrNull } from './own-path.js';

const PROVIDERS_KEY = ['auth-providers'] as const;
const REAUTH_RETURN_KEY = 'ageniza.google-reauth-return';
const INVITE_RETURN_KEY = 'ageniza.google-invite-return';

/** Where the person goes after a reauthentication when the screen that asked was not kept. */
const REAUTH_FALLBACK = '/contextos';

/** The same sentence a wrong password gets: the screen never says why the Google sign-in was refused (decision 2026-10-26). */
export const GOOGLE_REFUSED_MESSAGE = 'E-mail ou senha incorretos.';

/**
 * Whether the server has Google on (`GET /auth/providers`, a flag with no secret). Anything but a clear `true` is off: while it
 * loads, when the read fails and when the answer is not the contract, the button is not there, so a person is never sent to a
 * route that would answer 404.
 */
export const useGoogleEnabled = (): boolean => {
  const httpClient = useApiClient();
  const providers = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => httpClient.request({ path: '/auth/providers', response: AuthProvidersResponseSchema }),
    staleTime: 5 * 60_000,
    retry: false
  });
  return providers.data?.google === true;
};

/** The multicolour "G" of Google's own button, as an image that carries no text. */
function GoogleMark() {
  return <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>;
}

/**
 * A real link to the API route that sends the browser to Google: a navigation, so it opens like any link and works without a
 * script. It is not there while Google is off.
 */
export function GoogleLink({ intent, inviteToken, children = 'Entrar com o Google', className = 'auth-submit', onNavigate }: {
  intent?: 'reauth';
  /** The invitation the sign-in is for: kept in this browser tab across the trip (never in the address sent to the server). */
  inviteToken?: string;
  children?: string;
  className?: string;
  /** Runs before the browser leaves, to keep what the page must find again when it comes back. */
  onNavigate?: () => void;
}) {
  const httpClient = useApiClient();
  const enabled = useGoogleEnabled();
  if (!enabled) return null;
  const path = intent === undefined ? '/auth/google/start' : `/auth/google/start?intent=${intent}`;
  const onClick = (): void => {
    // Set or cleared on every start, so what an abandoned invitation left cannot ride on a later, unrelated sign-in.
    rememberGoogleInvite(inviteToken);
    onNavigate?.();
  };
  return <ButtonLink variant="secondary" className={className} href={httpClient.browserUrl(path)} leadingIcon={<GoogleMark />}
    onClick={onClick}>{children}</ButtonLink>;
}

/** "ou" and the Google button under the form of `/entrar` and `/criar-conta`, and on the invitation; nothing at all while Google is off. */
export function GoogleSignInBlock({ inviteToken }: { inviteToken?: string }) {
  const enabled = useGoogleEnabled();
  if (!enabled) return null;
  return <div className="auth-alternative">
    <p className="auth-divider"><span>ou</span></p>
    <GoogleLink {...(inviteToken === undefined ? {} : { inviteToken })} />
  </div>;
}

/** Keeps the invitation across the trip to Google, or forgets any kept one when there is none. */
const rememberGoogleInvite = (token: string | undefined): void => {
  try {
    if (token === undefined) window.sessionStorage.removeItem(INVITE_RETURN_KEY);
    else window.sessionStorage.setItem(INVITE_RETURN_KEY, token);
  } catch { /* storage refused: the person comes back to the sign-in screen and opens the invitation again */ }
};

/** Reads and forgets the invitation: it is used once, and only a token the API could have issued is followed. */
const takeGoogleInvite = (): string | null => {
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(INVITE_RETURN_KEY);
    window.sessionStorage.removeItem(INVITE_RETURN_KEY);
  } catch { /* nothing kept */ }
  return stored !== null && AuthInvitationTokenSchema.safeParse(stored).success ? stored : null;
};

/** Remembers the address a reauthentication must come back to, when the browser can keep it. */
export const rememberReauthReturn = (path: string): void => {
  try { window.sessionStorage.setItem(REAUTH_RETURN_KEY, path); } catch { /* storage refused: the fallback is used */ }
};

/** Reads and forgets the address; only an address of this app is followed. */
const takeReauthReturn = (): string => {
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(REAUTH_RETURN_KEY);
    window.sessionStorage.removeItem(REAUTH_RETURN_KEY);
  } catch { /* nothing kept */ }
  return ownPathOrNull(stored) ?? REAUTH_FALLBACK;
};

/**
 * `/entrar/google`, where the API sends the browser after Google answered and a session was made (decision 2026-10-26). Nothing is
 * decided here: it reads the session, and the sign-in screen resolves the destination as it does after a password, so the Google
 * entry cannot reach a place the password one cannot. A reauthentication goes back to the screen that asked for it. When there
 * is no session after all, it is the same refusal as any other (`/entrar?erro=google`).
 */
export function GoogleLandingPage() {
  const authStore = useAuthSessionStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reauth = searchParams.get('intent') === 'reauth';
  useDocumentTitle('Entrando com o Google — Ageniza');

  useEffect(() => {
    let current = true;
    void (async () => {
      try { await authStore.refresh(); } catch { /* an unreadable session is no session */ }
      if (!current) return;
      // Forgotten whatever the answer is: a kept invitation is used by this return and by no other. (After the guard above, so a
      // run that was replaced, as Strict Mode does in development, leaves it for the one that goes on.)
      const invitation = reauth ? null : takeGoogleInvite();
      if (!authStore.getSnapshot().isAuthenticated) { navigate('/entrar?erro=google', { replace: true }); return; }
      // An invitation goes back to its own screen, which accepts it only when the session is the invited address (the same
      // path as a password sign-in that carried the invitation).
      if (invitation !== null) { navigate(`/convite/${encodeURIComponent(invitation)}`, { replace: true, state: { inviteLogin: true } }); return; }
      if (!reauth) { navigate('/entrar', { replace: true }); return; }
      navigate(takeReauthReturn(), { replace: true, state: { reopenEmailChange: true } });
    })();
    return () => { current = false; };
  }, [authStore, navigate, reauth]);

  return <AuthPanel titleId="google-landing-title" title="Entrando com o Google" lead="Só um instante.">
    <p className="auth-note" role="status">Confirmando o seu acesso…</p>
  </AuthPanel>;
}
