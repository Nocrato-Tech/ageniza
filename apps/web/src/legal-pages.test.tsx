// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClientProvider, HttpClient } from './http.js';
import { privacyPolicy } from './legal/privacy.js';
import { termsOfUse } from './legal/terms.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const renderAt = (path: string, fetchImpl: typeof fetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated: false }} />
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  );
};

describe('legal pages', () => {
  it.each([
    ['/termos', termsOfUse, 'Política de Privacidade'],
    ['/privacidade', privacyPolicy, 'Termos de Uso']
  ] as const)('%s opens without a session, with its version, content and sibling link', (path, document, sibling) => {
    let calls = 0;
    renderAt(path, async () => { calls += 1; return new Response(null, { status: 204 }); });

    expect(screen.getByRole('heading', { level: 1, name: document.title })).toBeTruthy();
    expect(screen.getByText(`Versão ${document.version}`)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: `1. ${document.sections[0]!.heading}` })).toBeTruthy();
    expect(screen.getByRole('link', { name: sibling })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
    // The content ships in the bundle: no request is made to render it.
    expect(calls).toBe(0);
  });

  it('shows the draft notice while the document is a draft', () => {
    renderAt('/termos', async () => new Response(null, { status: 204 }));
    expect(screen.getByRole('note').textContent).toBe(termsOfUse.draftNotice);
  });
});
