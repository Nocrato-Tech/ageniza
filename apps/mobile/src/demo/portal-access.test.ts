import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock('./config', () => ({ get demoWorkspaceEnabled() { return gate.enabled; }, demoAgencyName: 'Agência Horizonte · Demonstração' }));
import { prepareDemoPortalAccess } from './portal-access';

const agency: Extract<Context, { type: 'agency' }> = { type: 'agency', agencyId: 'agency-one', agencyName: 'Agência Horizonte · Demonstração', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
const portal: Extract<Context, { type: 'client' }> = { type: 'client', clientId: 'client-one', clientName: 'Clínica Vida · Exemplo', agencyId: agency.agencyId, agencyName: agency.agencyName, onboardingPending: true };
type World = {
  verified?: boolean;
  email?: string;
  contexts?: Context[];
  refreshed?: Context[];
  clientPages?: { id: string; name: string }[][];
  activePages?: { email: string }[][];
  removedPages?: { email: string }[][];
  postError?: Error;
};
function world(options: World = {}) {
  let granted = false;
  let contextReads = 0;
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/auth/session') return { emailVerified: 'verified' in options ? options.verified : true, user: { id: 'user-one', email: options.email ?? 'tester@example.test' } };
    if (path === '/me/contexts') {
      contextReads += 1;
      return { contexts: granted || contextReads > 1 ? options.refreshed ?? [agency, portal] : options.contexts ?? [agency] };
    }
    const url = new URL(path, 'https://api.example.test');
    const page = Number(url.searchParams.get('page')) - 1;
    if (url.pathname === `/agencies/${agency.agencyId}/clients`) {
      const pages = options.clientPages ?? [[{ id: portal.clientId, name: portal.clientName }]];
      return { data: pages[page] ?? [], meta: { totalPages: pages.length } };
    }
    if (url.pathname !== `/agencies/${agency.agencyId}/clients/${portal.clientId}/members`) throw new Error(`Unexpected endpoint: ${path}`);
    if (init?.method === 'POST') { granted = true; if (options.postError) throw options.postError; return {}; }
    const pages = (url.searchParams.get('status') === 'removed' ? options.removedPages : options.activePages) ?? [[]];
    return { data: pages[page] ?? [], meta: { totalPages: pages.length } };
  });
  return { request, api: { request } as unknown as ApiClient, writes: () => request.mock.calls.filter(([, init]) => init?.method === 'POST') };
}
afterEach(() => { gate.enabled = true; });

it('grants only the verified session email to the server-listed example client and returns its resolved context', async () => {
  const w = world();
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.writes()).toEqual([[`/agencies/${agency.agencyId}/clients/${portal.clientId}/members`, { method: 'POST', body: { email: 'tester@example.test' } }]]);
});

it('does not call the API when the demo configuration is disabled', async () => {
  gate.enabled = false;
  const w = world();
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('agência de demonstração');
  expect(w.request).not.toHaveBeenCalled();
});

it.each([{ ...agency, isOwner: false }, { ...agency, agencyName: 'Real agency' }])('refuses an ineligible local agency before requests: %j', async (selected) => {
  const w = world();
  await expect(prepareDemoPortalAccess(w.api, selected)).rejects.toThrow('agência de demonstração');
  expect(w.request).not.toHaveBeenCalled();
});

it.each([false, undefined])('requires explicitly verified email, received %s', async (verified) => {
  const w = world({ verified });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('Confirme seu e-mail');
  expect(w.request.mock.calls.map(([path]) => path)).toEqual(['/auth/session']);
});

it.each([
  [],
  [{ ...agency, agencyId: 'other-agency' }],
  [{ ...agency, isOwner: false }],
  [{ ...agency, agencyName: 'Real agency' }],
  [portal],
])('rejects fabricated local ownership when server contexts are %j', async (...values) => {
  const contexts = values as Context[];
  const w = world({ contexts });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('não está disponível');
  expect(w.request.mock.calls.map(([path]) => path)).toEqual(['/auth/session', '/me/contexts']);
});

it('does not substitute another client when the exact example is missing', async () => {
  const w = world({ clientPages: [[{ id: 'real-client', name: 'Clínica Vida' }], [{ id: 'other-example', name: 'Outro · Exemplo' }]] });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('Prepare os dados de exemplo');
  expect(w.writes()).toEqual([]);
  expect(w.request.mock.calls.some(([path]) => path.includes('/members'))).toBe(false);
});

it('finds the server-listed example on later client pages', async () => {
  const w = world({ clientPages: [[{ id: 'real-client', name: 'Real client' }], [{ id: portal.clientId, name: portal.clientName }]] });
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.request).toHaveBeenCalledWith(`/agencies/${agency.agencyId}/clients?page=2&pageSize=100`);
  expect(w.writes()).toHaveLength(1);
});

it('reuses a matching server context without creating or resending access', async () => {
  const w = world({ contexts: [agency, portal] });
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.request.mock.calls.some(([path]) => path.includes('/members'))).toBe(false);
});

it('reuses an active access from later pages and refreshes the actual contexts', async () => {
  const w = world({ activePages: [[{ email: 'someone@example.test' }], [{ email: ' TESTER@EXAMPLE.TEST ' }]] });
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.writes()).toEqual([]);
  expect(w.request.mock.calls.filter(([path]) => path === '/me/contexts')).toHaveLength(2);
});

it('refuses a removed access on a later page instead of reactivating it through POST', async () => {
  const w = world({ removedPages: [[{ email: 'someone@example.test' }], [{ email: 'TESTER@EXAMPLE.TEST' }]] });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('Seu acesso foi removido');
  expect(w.writes()).toEqual([]);
});

it('does not claim an access is ready while its active membership has no portal context', async () => {
  const w = world({ activePages: [[{ email: 'tester@example.test' }]], refreshed: [agency] });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('portal ainda não apareceu');
  expect(w.writes()).toEqual([]);
});

it.each([
  { ...portal, agencyId: 'other-agency' },
  { ...portal, clientId: 'other-client' },
])('never enters a context for a different tenant/client: %j', async (other) => {
  const w = world({ contexts: [agency, other], refreshed: [agency, other] });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('portal ainda não apareceu');
  expect(w.writes()).toHaveLength(1);
});

it('uses the current session address instead of a fixed tester account', async () => {
  const w = world({ email: 'another-tester@example.test' });
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.writes()[0]?.[1]?.body).toEqual({ email: 'another-tester@example.test' });
});

it('does not grant access for a malformed session email', async () => {
  const w = world({ email: 'not-an-address' });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow();
  expect(w.writes()).toEqual([]);
});

it('surfaces a failed grant and reuses a persisted access on retry', async () => {
  const w = world({ postError: new Error('E-mail indisponível') });
  await expect(prepareDemoPortalAccess(w.api, agency)).rejects.toThrow('E-mail indisponível');
  expect(await prepareDemoPortalAccess(w.api, agency)).toEqual(portal);
  expect(w.writes()).toHaveLength(1);
});

it('stops before granting when the screen is abandoned during access lookup', async () => {
  const controller = new AbortController();
  const w = world();
  const original = w.request.getMockImplementation()!;
  w.request.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[0].includes('status=removed')) controller.abort();
    return result;
  });
  await expect(prepareDemoPortalAccess(w.api, agency, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(w.writes()).toEqual([]);
});
