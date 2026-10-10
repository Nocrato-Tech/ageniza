// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect, sessionDestination } from './session-end.js';

// #411. Removing a person ends their sessions on the server; a tab that sends no request would keep
// showing the old screen. The tabs below send none: the only thing that can find out is the check.
const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

const sessionBody = { user: { id: USER_ID, name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-11-01T00:00:00.000Z' } };
const legalAccepted = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};
const portalClient = {
  id: CLIENT_ID, name: 'Padaria Central', status: 'active', photoUrl: null, legalName: null, taxId: null, segment: null, website: null,
  instagramHandle: null, contactName: null, contactPhone: null, contactEmail: null, closingDate: null, archivedAt: null,
  agencyName: 'Agência Um', onboardingSeenAt: null, home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5 }
};

interface World {
  /** What the server says about the session; flipped by the test, never by the page. */
  sessionAlive: boolean;
  /** Makes `GET /auth/session/check` fail without a verdict (network error or 5xx) instead of answering. */
  sessionCheck: 'answer' | 'unreachable' | 'unavailable';
  /** Holds the answer of `GET /auth/session/check` until `release` is called. */
  hold: boolean;
  release: () => void;
  /** `GET /auth/session`, which the app makes once when it opens. */
  initialLoads: number;
  /** `GET /auth/session/check`, the periodic one: the only route that must not renew the session. */
  sessionChecks: number;
  /** Anything else the page asked for from the `/auth/session` family, which must never be the renewing route. */
  renewingChecks: number;
}

const makeWorld = (): { world: World; impl: typeof fetch } => {
  let open: () => void = () => undefined;
  const world: World = {
    sessionAlive: true, sessionCheck: 'answer', hold: false, release: () => open(), initialLoads: 0, sessionChecks: 0, renewingChecks: 0
  };
  const impl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/session') {
      world.initialLoads += 1;
      if (world.initialLoads > 1) world.renewingChecks += 1;
    }
    if (path === '/auth/session/check') {
      world.sessionChecks += 1;
      if (world.hold) await new Promise<void>((resolve) => { open = resolve; });
      if (world.sessionAlive && world.sessionCheck === 'unreachable') throw new TypeError('network down');
      if (world.sessionAlive && world.sessionCheck === 'unavailable') return json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' } }, 500);
    }
    if (!world.sessionAlive) return unauthenticated();
    if (path === '/auth/session' || path === '/auth/session/check') return json(sessionBody);
    if (path === '/me/legal-acceptances') return json(legalAccepted);
    if (path === '/me/contexts') {
      return json({ contexts: [{ type: 'client', clientId: CLIENT_ID, clientName: 'Padaria Central', agencyId: AGENCY_ID, agencyName: 'Agência Um', onboardingPending: false }] });
    }
    if (path === `/agencies/${AGENCY_ID}/me`) {
      return json({ agencyId: AGENCY_ID, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions: ['cliente.visualizar'] });
    }
    if (path === `/clients/${CLIENT_ID}`) return json(portalClient);
    return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  };
  return { world, impl };
};

let currentLocation = '';
let currentState: unknown = null;
function Probe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  currentState = location.state;
  return null;
}

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <>
    <ApplicationRoutes session={session} />
    {session.isAuthenticated ? null : <p>Sessão encerrada</p>}
  </>;
}

const renderAt = (entry: string, impl: typeof fetch) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <Probe />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { store };
};

const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const focus = async (): Promise<void> => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); };

const AREAS = [
  { label: 'agency area', entry: `/agencia/${AGENCY_ID}`, ready: () => screen.findByRole('link', { name: 'Agência Um' }) },
  { label: 'portal', entry: `/portal/${CLIENT_ID}/inicio`, ready: () => screen.findByRole('heading', { name: 'Olá, Maria' }) },
  // The generic protected layout (the context chooser and the protected not-found).
  { label: 'protected layout', entry: '/rota-que-nao-existe', ready: () => screen.findByRole('heading', { name: /não encontrada|not found/i }) }
] as const;

const SESSION_DEAD_AREAS = [AREAS[0], AREAS[1]] as const;

beforeEach(() => {
  // The timers and the clock are faked: the HTTP client and the router keep their real setTimeout.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  setVisibility('visible');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  currentLocation = '';
  currentState = null;
});

describe.each(AREAS)('the session check in the $label', ({ entry, ready }) => {
  it('asks the API about the session on a timer and sends the person to the login when it is gone, keeping the address', async () => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();
    expect(world.initialLoads).toBe(1);
    expect(world.sessionChecks).toBe(0);

    // The owner asked for 30 to 60 s: nothing is asked before 30 s, exactly one check falls inside the
    // first minute, and a live session is not disturbed by it.
    await tick(29_999);
    expect(world.sessionChecks).toBe(0);
    await tick(30_001);
    expect(world.sessionChecks).toBe(1);
    expect(currentLocation).toBe(entry);

    // Removed from the agency or the client: the server ends the session; the tab sends nothing itself.
    world.sessionAlive = false;
    await tick(60_000);

    expect(currentLocation).toBe('/entrar');
    expect(sessionDestination(currentState)).toBe(entry);
    expect(screen.getByText('Sessão encerrada')).toBeTruthy();

    // Once signed out nothing keeps asking: not on the timer, and not when the tab comes back to the foreground.
    const checksAfterEnd = world.sessionChecks;
    await tick(3 * 60_000);
    await focus();
    await tick(15_000);
    await focus();
    expect(world.sessionChecks).toBe(checksAfterEnd);
  });

  it('never asks through the route that renews the session: a forgotten tab must not keep it alive', async () => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();

    await tick(60_000);
    await focus();
    await tick(60_000);

    expect(world.sessionChecks).toBeGreaterThanOrEqual(2);
    expect(world.renewingChecks).toBe(0);
  });

  it('checks as soon as the tab comes back to the foreground, and not while it is hidden', async () => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();

    setVisibility('hidden');
    world.sessionAlive = false;
    await focus();
    await tick(2 * 60_000);
    expect(world.sessionChecks).toBe(0);
    expect(currentLocation).toBe(entry);

    setVisibility('visible');
    await focus();
    await tick(0);

    expect(world.sessionChecks).toBe(1);
    expect(currentLocation).toBe('/entrar');
    expect(sessionDestination(currentState)).toBe(entry);
  });

  it('keeps one check at a time: a focus, a second focus and the timer while the answer is pending ask nothing more', async () => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();

    world.hold = true;
    await tick(60_000);
    expect(world.sessionChecks).toBe(1);

    // The answer has not come back: the tab returns twice, a long time passes (timers fire), nothing is asked.
    await focus();
    await focus();
    await tick(3 * 60_000);
    await focus();
    expect(world.sessionChecks).toBe(1);

    world.hold = false;
    await act(async () => { world.release(); });
    await tick(0);

    // With the answer in, the next check is possible again.
    await tick(60_000);
    expect(world.sessionChecks).toBe(2);
  });

  it('does not ask again when the tab returns right after a check, and restarts the interval after each check', async () => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();

    // A check at 40 s, by the focus (the first one is never held back).
    await tick(40_000);
    await focus();
    expect(world.sessionChecks).toBe(1);

    // Back and forth a moment later: held back. The old timer would have fired at 45 s: it does not.
    await focus();
    await tick(5_000);
    await focus();
    expect(world.sessionChecks).toBe(1);

    // The interval counts from the last check (40 s): the next tick is at 85 s.
    await tick(39_999);
    expect(world.sessionChecks).toBe(1);
    await tick(1);
    expect(world.sessionChecks).toBe(2);

    // Past the gap, a focus asks again.
    await tick(11_000);
    await focus();
    expect(world.sessionChecks).toBe(3);
  });

  it.each(['unreachable', 'unavailable'] as const)('does not end the session when the check cannot reach the API (%s): only a 401 does', async (failure) => {
    const { world, impl } = makeWorld();
    renderAt(entry, impl);
    await ready();

    world.sessionCheck = failure;
    await tick(60_000);
    expect(world.sessionChecks).toBe(1);
    expect(currentLocation).toBe(entry);
    expect(screen.queryByText('Sessão encerrada')).toBeNull();

    // The next check is still made, and the answer is believed once it comes.
    world.sessionCheck = 'answer';
    world.sessionAlive = false;
    await tick(60_000);
    expect(currentLocation).toBe('/entrar');
  });
});

describe.each(SESSION_DEAD_AREAS)('the $label without a session', ({ entry }) => {
  it('shows the unavailable page and asks nothing about the session, on the timer or on focus', async () => {
    const { world, impl } = makeWorld();
    world.sessionAlive = false;
    renderAt(entry, impl);
    await screen.findByRole('heading', { name: 'Workspace unavailable' });
    expect(world.initialLoads).toBe(1);

    await tick(3 * 60_000);
    await focus();
    await tick(15_000);
    await focus();

    expect(world.sessionChecks).toBe(0);
    expect(currentLocation).toBe(entry);
  });
});

describe('where the check does not run', () => {
  it('does not poll a public page: a visitor has no session to lose', async () => {
    const { world, impl } = makeWorld();
    world.sessionAlive = false;
    renderAt('/termos', impl);
    await screen.findByRole('heading', { level: 1 });

    await tick(3 * 60_000);
    await focus();

    expect(world.sessionChecks).toBe(0);
    expect(currentLocation).toBe('/termos');
  });
});
