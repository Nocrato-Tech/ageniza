import { describe, expect, it, vi } from 'vitest';

import { createAuthSessionStore } from './auth.js';
import { HttpClient } from './http.js';

const clientAnswering = (fetchImplementation: typeof fetch): HttpClient =>
  new HttpClient('http://127.0.0.1:3001', fetchImplementation);

const activeSession = () => new Response(JSON.stringify({
  user: { id: '11111111-1111-4111-8111-111111111111', name: 'Person', email: 'person@example.com' },
  session: { expiresAt: '2026-10-01T00:00:00.000Z' }
}), { status: 200, headers: { 'content-type': 'application/json' } });

const unauthenticated = () => new Response(JSON.stringify({
  error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' }
}), { status: 401, headers: { 'content-type': 'application/json' } });

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe('auth session store', () => {
  it('starts loading and becomes authenticated once the session answers', async () => {
    const store = createAuthSessionStore(clientAnswering(async () => activeSession()));

    expect(store.getSnapshot()).toEqual({ status: 'loading', isAuthenticated: false });
    store.subscribe(() => undefined);
    await settle();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: true });
  });

  it('treats 401 as a visitor, not as a failure', async () => {
    const store = createAuthSessionStore(clientAnswering(async () => unauthenticated()));

    store.subscribe(() => undefined);
    await settle();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });

  it('leaves the page unauthenticated when the session cannot be reached', async () => {
    const store = createAuthSessionStore(clientAnswering(async () => { throw new TypeError('network down'); }));

    store.subscribe(() => undefined);
    await settle();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });

  it('does not publish a resolution from a previous generation under Strict Mode replay', async () => {
    let answer: () => Response = activeSession;
    const store = createAuthSessionStore(clientAnswering(async () => answer()));

    const firstCleanup = store.subscribe(() => undefined);
    firstCleanup();
    answer = unauthenticated;
    store.subscribe(() => undefined);
    await settle();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });

  it('re-reads the session on refresh, so logging out is observed', async () => {
    let answer: () => Response = activeSession;
    const store = createAuthSessionStore(clientAnswering(async () => answer()));
    const listener = vi.fn();

    store.subscribe(listener);
    await settle();
    expect(store.getSnapshot().isAuthenticated).toBe(true);

    answer = unauthenticated;
    await store.refresh();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
    expect(listener).toHaveBeenCalled();
  });

  it('probes the session without treating the visitor 401 as a session that ended', async () => {
    const onSessionEnded = vi.fn();
    const store = createAuthSessionStore(new HttpClient('http://127.0.0.1:3001', async () => unauthenticated(), { onSessionEnded }));

    store.subscribe(() => undefined);
    await settle();
    await store.refresh();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('drops the session at once when told it ended, ignoring a probe still in flight', async () => {
    let answerProbe: (response: Response) => void = () => undefined;
    const store = createAuthSessionStore(clientAnswering(() => new Promise<Response>((resolve) => { answerProbe = resolve; })));

    store.subscribe(() => undefined);
    store.end();
    answerProbe(activeSession());
    await settle();

    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });
});
