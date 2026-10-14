// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { AppErrorBoundary } from './error-boundary.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

const renderAt = (path: string) => {
  const client = new HttpClient('http://127.0.0.1:3001', async () => new Response(null, { status: 401 }));
  render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated: false, user: null }} />
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const expectSeriousMascotOnce = () => {
  const images = document.querySelectorAll('img');
  expect(images).toHaveLength(1);
  const mascot = images[0]!;
  expect(mascot.getAttribute('alt')).toBe('');
  expect(mascot.getAttribute('src')).toBe('/brand/mascote-serio.webp');
  expect(mascot.getAttribute('srcset')).toBe('/brand/mascote-serio.webp 1x, /brand/mascote-serio@2x.webp 2x');
  expect(mascot.getAttribute('width')).toBe('191');
  expect(mascot.getAttribute('height')).toBe('240');
};

const expectPrimaryButtonLook = (link: HTMLElement) => {
  expect(link.classList.contains('ui-button')).toBe(true);
  expect(link.classList.contains('ui-button--primary')).toBe(true);
  expect(link.classList.contains('ui-button--lg')).toBe(true);
};

describe('status pages (serious mascot)', () => {
  it('shows the not-found with one decorative mascot, the sentence and the way out as a primary button', () => {
    renderAt('/caminho-inexistente');

    expect(screen.getByRole('heading', { name: 'Página não encontrada', level: 1 })).toBeTruthy();
    expect(screen.getByText('Este endereço não corresponde a uma página do Ageniza.')).toBeTruthy();
    const exit = screen.getByRole('link', { name: 'Voltar ao início' });
    expect(exit.getAttribute('href')).toBe('/');
    expectPrimaryButtonLook(exit);
    expectSeriousMascotOnce();
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('shows the ended session with the way back in to the login', () => {
    renderAt('/app');

    expect(screen.getByRole('heading', { name: 'Área indisponível', level: 1 })).toBeTruthy();
    expect(screen.getByText('Esta área exige uma sessão ativa.')).toBeTruthy();
    const exit = screen.getByRole('link', { name: 'Entrar de novo' });
    expect(exit.getAttribute('href')).toBe('/entrar');
    expectPrimaryButtonLook(exit);
    expectSeriousMascotOnce();
    expect(document.title).toBe('Área indisponível — Ageniza');
  });

  it('keeps the public pages light and the agency area dark, on the same status page', () => {
    renderAt('/caminho-inexistente');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    cleanup();

    renderAt(`/agencia/${AGENCY}`);
    expect(screen.getByRole('heading', { name: 'Área indisponível' })).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('unexpected error boundary', () => {
  function Broken(): never { throw new Error('boom'); }

  it('says what happened, offers to reload and shows the mascot once, without leaking the error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);

    expect(screen.getByRole('heading', { name: 'Algo deu errado', level: 1 })).toBeTruthy();
    expect(screen.getByText('Não foi possível mostrar esta página. Carregue de novo para continuar.')).toBeTruthy();
    expectSeriousMascotOnce();
    expect(document.body.textContent).not.toContain('boom');
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('renders its children untouched while nothing throws', () => {
    render(<AppErrorBoundary><p>tudo certo</p></AppErrorBoundary>);

    expect(screen.getByText('tudo certo')).toBeTruthy();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
