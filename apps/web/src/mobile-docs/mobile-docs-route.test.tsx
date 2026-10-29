// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const user = { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' };
const fetchImpl: typeof fetch = async () => new Response(null, { status: 401 });

// `routes.tsx` reads the environment when it loads, so every case imports a graph of its own.
const loadGraph = () => Promise.all([import('../auth.js'), import('../http.js'), import('../query.js'), import('../routes.js')]);

async function renderAt(path: string, env: { dev: boolean; devDocs?: string }, isAuthenticated = false) {
  vi.resetModules();
  vi.stubEnv('DEV', env.dev);
  vi.stubEnv('VITE_DEV_DOCS', env.devDocs as string);
  const [{ AuthSessionProvider, createAuthSessionStore }, { ApiClientProvider, HttpClient }, { createQueryClient }, { ApplicationRoutes }] = await loadGraph();
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated, user: isAuthenticated ? user : null }} />
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const GUIDE_TITLE = 'Ageniza no celular — ponto de partida';

describe('the /mobile route', { timeout: 60_000 }, () => {
  it('opens in development without a session, outside the agency and the portal', async () => {
    await renderAt('/mobile', { dev: true });
    expect(await screen.findByRole('heading', { level: 1, name: GUIDE_TITLE }, { timeout: 30_000 })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).toBeNull();
  });

  it('opens in a deeper path of the guide and in the API tab', async () => {
    await renderAt('/mobile/fluxos/portal', { dev: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Portal do cliente' }, { timeout: 30_000 })).toBeTruthy();
    cleanup();
    await renderAt('/mobile/api', { dev: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Referência da API' }, { timeout: 30_000 })).toBeTruthy();
  });

  it('opens in a build that is not development when VITE_DEV_DOCS is "true" (the dev server image)', async () => {
    await renderAt('/mobile', { dev: false, devDocs: 'true' });
    expect(await screen.findByRole('heading', { level: 1, name: GUIDE_TITLE }, { timeout: 30_000 })).toBeTruthy();
  });

  it.each([[undefined], [''], ['false'], ['TRUE']])('is the not-found page in a build that is not development when VITE_DEV_DOCS is %j', async (devDocs) => {
    await renderAt('/mobile', { dev: false, ...(devDocs === undefined ? {} : { devDocs }) });
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: GUIDE_TITLE })).toBeNull();
    cleanup();
    await renderAt('/mobile/api', { dev: false, ...(devDocs === undefined ? {} : { devDocs }) });
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
  });
});
