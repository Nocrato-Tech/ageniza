// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

const httpClient = new HttpClient('http://127.0.0.1:3001');
const renderRoute = (path: string, isAuthenticated: boolean) => render(
  <QueryClientProvider client={createQueryClient()}>
    <ApiClientProvider client={httpClient}><MemoryRouter initialEntries={[path]}>
      <ApplicationRoutes session={{ status: 'ready', isAuthenticated }} />
    </MemoryRouter></ApiClientProvider>
  </QueryClientProvider>
);

describe('route boundaries', () => {
  it('keeps protected workspace content out of an anonymous route', () => {
    renderRoute('/app', false);
    expect(screen.getByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('renders the workspace only after a session boundary has passed', () => {
    renderRoute('/app', true);
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy();
  });

  it('sends unknown paths to an accessible not-found boundary', () => {
    renderRoute('/missing', false);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
