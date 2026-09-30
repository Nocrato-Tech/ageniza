// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

// `/app` now lands on the context resolver, which reads the session store; the 401 here is the
// ordinary answer for a visitor and keeps the boundary test deterministic.
const httpClient = new HttpClient('http://127.0.0.1:3001', async () => new Response(null, { status: 401 }));
const renderRoute = (path: string, isAuthenticated: boolean) => render(
  <AuthSessionProvider store={createAuthSessionStore(httpClient)}>
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={httpClient}><MemoryRouter initialEntries={[path]}>
        <ApplicationRoutes session={{ status: 'ready', isAuthenticated }} />
      </MemoryRouter></ApiClientProvider>
    </QueryClientProvider>
  </AuthSessionProvider>
);

describe('route boundaries', () => {
  it('keeps protected workspace content out of an anonymous route', () => {
    renderRoute('/app', false);
    expect(screen.getByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('sends /app to the resolve instead of rendering a workspace of its own', () => {
    renderRoute('/app', true);
    // `/app` is only a redirect now (issue #181): it lands on the context resolver, never on the
    // old placeholder.
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('sends unknown paths to an accessible not-found boundary', () => {
    renderRoute('/missing', false);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
