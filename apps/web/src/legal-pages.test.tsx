// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClientProvider, HttpClient } from './http.js';
import { privacyPolicy } from './legal/privacy.js';
import { termsOfUse } from './legal/terms.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const renderAt = (path: string, fetchImpl: typeof fetch = async () => new Response(null, { status: 204 })) => {
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

  it('sets the browser tab title to the document', () => {
    renderAt('/termos');
    expect(document.title).toBe('Termos de Uso — Ageniza');
  });

  it('keeps a list attached to the paragraph that introduces it, not at the end', () => {
    renderAt('/termos');
    const section = screen.getByRole('heading', { name: '2. O que o Ageniza é' }).closest('section');
    if (section === null) throw new Error('section not found');

    // "Ele tem dois lados separados:" introduces the list, but two more paragraphs follow it, so a
    // renderer that emits every paragraph before the list would produce P,P,P,UL here.
    const blocks = Array.from(section.querySelectorAll('p, ul'));
    expect(blocks.map((element) => element.tagName)).toEqual(['P', 'UL', 'P', 'P']);
    expect(blocks[0]!.textContent).toContain('dois lados separados:');
    expect(blocks[1]!.tagName).toBe('UL');
  });

  it('returns to the home page when there is no in-app history to go back to', () => {
    renderAt('/termos');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Ageniza' })).toBeTruthy();
  });

  it('shows the draft notice while the document is a draft', () => {
    renderAt('/termos');
    expect(screen.getByRole('note').textContent).toBe(termsOfUse.draftNotice);
  });
});
