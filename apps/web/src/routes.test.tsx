// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { portalClientBody } from './portal-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { useCommittedLocation } from './location-probe-fixture.js';

afterEach(cleanup);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyMe = { agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: [] };

// `/app` now lands on the context resolver, which reads the session store; the 401 here is the
// ordinary answer for a visitor and keeps the boundary test deterministic.
const unauthenticatedFetch: typeof fetch = async () => new Response(null, { status: 401 });
/** A valid session for the store; every other endpoint keeps answering like a visitor. */
const authenticatedFetch: typeof fetch = async (input) =>
  String(input).endsWith('/auth/session') ? json(sessionBody) : new Response(null, { status: 401 });
/** What `/entrar` with a valid session touches on its way to the active context. */
const signedInFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return json(sessionBody);
  if (url.endsWith('/me/contexts/resolve')) return json({ decision: 'enter', context: agencyA });
  if (url.endsWith('/me/last-context') && init?.method === 'PUT') return new Response(null, { status: 204 });
  if (url.endsWith(`/agencies/${AGENCY_A}/me`)) return json(agencyMe);
  return new Response(null, { status: 401 });
};

function LocationProbe({ probe }: { probe: { pathname: string } }) {
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
  });
  return null;
}

const renderRoute = (path: string, isAuthenticated: boolean, impl: typeof fetch = unauthenticatedFetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <LocationProbe probe={probe} />
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated, user: isAuthenticated ? sessionBody.user : null }} />
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe };
};

/** Opens the account menu and asserts the person identity inside it, not only its trigger. */
const expectAccountMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Pessoa/ }));
  const menu = screen.getByRole('menu', { name: 'Menu da conta' });
  expect(within(menu).getByText('Pessoa')).toBeTruthy();
  expect(within(menu).getByText('pessoa@example.test')).toBeTruthy();
};

describe('route boundaries', () => {
  it('keeps protected workspace content out of an anonymous route', () => {
    renderRoute('/app', false);
    expect(screen.getByRole('heading', { name: 'Área indisponível' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pessoa/ })).toBeNull();
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
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
  });

  it('shows the system pages in Portuguese, with the exact text and a way back', () => {
    renderRoute('/missing', false);
    expect(screen.getByRole('heading', { name: 'Página não encontrada', level: 1 })).toBeTruthy();
    expect(screen.getByText('Este endereço não corresponde a uma página do Ageniza.')).toBeTruthy();
    expect(document.title).toBe('Página não encontrada — Ageniza');
    expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe('/entrar');
    cleanup();

    renderRoute('/app', false);
    expect(screen.getByRole('heading', { name: 'Área indisponível', level: 1 })).toBeTruthy();
    expect(screen.getByText('Esta área exige uma sessão ativa.')).toBeTruthy();
  });

  it('shows the public home in Portuguese, behind the skip link of the public layout', () => {
    renderRoute('/', false);
    expect(screen.getByRole('heading', { name: 'Ageniza', level: 1 })).toBeTruthy();
    expect(screen.getByText('Operações de agência, em um só lugar.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Status do serviço' }).getAttribute('href')).toBe('/status');
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe('#main-content');
    expect(screen.getByRole('main').id).toBe('main-content');
  });

  it('shows the service status in Portuguese when the API answers', async () => {
    const healthy: typeof fetch = async (input) => (String(input).endsWith('/health') ? json({ status: 'ok' }) : new Response(null, { status: 401 }));
    renderRoute('/status', false, healthy);
    expect(await screen.findByText('A API está ok.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Status do serviço', level: 1 })).toBeTruthy();
  });

  it('says in Portuguese that the service status is unavailable when the API cannot answer', async () => {
    const down: typeof fetch = async () => json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' } }, 500);
    renderRoute('/status', false, down);
    expect(await screen.findByText('O status está temporariamente indisponível.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Status do serviço', level: 1 })).toBeTruthy();
  });

  it('shows the loading page in Portuguese while the session is read', () => {
    const client = new HttpClient('http://127.0.0.1:3001', unauthenticatedFetch);
    render(
      <AuthSessionProvider store={createAuthSessionStore(client)}>
        <QueryClientProvider client={createQueryClient()}>
          <ApiClientProvider client={client}><MemoryRouter initialEntries={['/app']}>
            <ApplicationRoutes session={{ status: 'loading', isAuthenticated: false, user: null }} />
          </MemoryRouter></ApiClientProvider>
        </QueryClientProvider>
      </AuthSessionProvider>
    );
    expect(screen.getByText('Carregando…')).toBeTruthy();
  });

  it('sends a visitor without a session from the global not-found to the login, not to the public page', async () => {
    const { probe } = renderRoute('/rota-inexistente', false);
    fireEvent.click(screen.getByRole('link', { name: 'Voltar ao início' }));
    expect(probe.pathname).toBe('/entrar');
    expect(await screen.findByRole('heading', { name: 'Entrar', level: 1 })).toBeTruthy();
  });

  it('sends a signed-in person from the global not-found to the context chooser', () => {
    const { probe } = renderRoute('/rota-inexistente', true);
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Voltar ao início' }));
    expect(probe.pathname).toBe('/contextos');
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
  });

  it('keeps the account menu with the person identity on the context resolver', async () => {
    renderRoute('/contextos', true);
    expectAccountMenu();
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
  });

  it('keeps the account menu with the person identity on the client portal', async () => {
    const clientId = '11111111-1111-4111-8111-111111111111';
    renderRoute(`/portal/${clientId}/inicio`, true, async (input) => (
      String(input).endsWith(`/clients/${clientId}`) ? json(portalClientBody(clientId, 'Cliente Um')) : authenticatedFetch(input)
    ));
    expect(await screen.findByRole('heading', { name: 'Olá, Pessoa' })).toBeTruthy();
    expectAccountMenu();
  });

  it('keeps the account menu on the global not-found when there is a session', () => {
    renderRoute('/rota-inexistente', true);
    expectAccountMenu();
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
  });
});

// Issue #342: the rule 11 exceptions. Each screen below opens for a valid session, because the
// invitation is accepted while signed in and the reset/confirmation links arrive by e-mail and may
// belong to another account; Terms and Privacy are public. None of them may bounce to the context.
describe('screens that open with a valid session (rule 11 exceptions, issue #342)', () => {
  it('opens the invitation so a signed-in person can accept it, without redirecting', async () => {
    const { probe } = renderRoute('/convite/um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Convite' })).toBeTruthy();
    expect(probe.pathname).toBe('/convite/um-token');
    expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull();
  });

  it('opens the password reset from the e-mail link with its form, without redirecting', async () => {
    // With a token the screen renders the form; a redirect added after the token check would bounce here.
    const { probe } = renderRoute('/senha/redefinir?token=um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Definir nova senha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy();
    expect(probe.pathname).toBe('/senha/redefinir');
  });

  it('opens the e-mail confirmation from the e-mail link with its button, without redirecting', async () => {
    const { probe } = renderRoute('/email/confirmar?token=um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Confirmar novo e-mail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar troca de e-mail' })).toBeTruthy();
    expect(probe.pathname).toBe('/email/confirmar');
  });

  it('opens the Terms of Use page, without redirecting', async () => {
    const { probe } = renderRoute('/termos', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Termos de Uso' })).toBeTruthy();
    expect(probe.pathname).toBe('/termos');
  });

  it('opens the Privacy Policy page, without redirecting', async () => {
    const { probe } = renderRoute('/privacidade', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Política de Privacidade' })).toBeTruthy();
    expect(probe.pathname).toBe('/privacidade');
  });

  it('still sends the common screens /sem-acesso and /senha/esquecida to the active context', async () => {
    const noAccess = renderRoute('/sem-acesso', true);
    await waitFor(() => expect(noAccess.probe.pathname).toBe('/contextos'));
    cleanup();
    const forgot = renderRoute('/senha/esquecida', true);
    await waitFor(() => expect(forgot.probe.pathname).toBe('/contextos'));
  });

  it('still sends /entrar to the active context, through the resolve', async () => {
    const { probe } = renderRoute('/entrar', true, signedInFetch);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(screen.queryByRole('heading', { name: 'Entrar' })).toBeNull();
  });
});

describe('public pages in the Pauta look (#639)', () => {
  it('leads the home with one primary way in, and keeps the status as the quiet one', () => {
    renderRoute('/', false);
    const enter = screen.getByRole('link', { name: 'Entrar' });
    expect(enter.getAttribute('href')).toBe('/entrar');
    expect(enter.classList.contains('ui-button--primary')).toBe(true);
    expect(screen.getByRole('link', { name: 'Status do serviço' }).classList.contains('ui-button--secondary')).toBe(true);
  });

  it('wears the logo, not the word, in the header of the public pages', () => {
    renderRoute('/', false);
    const link = screen.getByRole('link', { name: 'Ageniza' });
    expect(link.getAttribute('href')).toBe('/');
    expect(link.querySelector('img')?.getAttribute('src')).toBe('/brand/logo-para-fundo-claro.svg');
    expect(link.closest('header')?.classList.contains('public-header')).toBe(true);
  });

  it('marks the healthy status with an icon beside the sentence, never the sentence alone', async () => {
    const healthy: typeof fetch = async (input) => (String(input).endsWith('/health') ? json({ status: 'ok' }) : new Response(null, { status: 401 }));
    renderRoute('/status', false, healthy);
    const sentence = await screen.findByText('A API está ok.');
    expect(sentence.parentElement?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('offers "Tentar de novo" on the unavailable status, and shows the answer once it comes', async () => {
    let up = false;
    const flaky: typeof fetch = async (input) => String(input).endsWith('/health') && up
      ? json({ status: 'ok' })
      : json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' } }, 500);
    renderRoute('/status', false, flaky);

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 5000 });
    expect(screen.getByRole('alert').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    up = true;
    fireEvent.click(retry);
    expect(await screen.findByText('A API está ok.')).toBeTruthy();
  });
});

describe('the retry of the service status keeps the keyboard where it was (#639)', () => {
  it('keeps the button mounted, focused and busy while the new request runs, and ignores a second click', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let healthCalls = 0;
    const flaky: typeof fetch = async (input) => {
      if (!String(input).endsWith('/health')) return new Response(null, { status: 401 });
      healthCalls += 1;
      if (healthCalls <= 2) return json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' } }, 500);
      await slow;
      return json({ status: 'ok' });
    };
    renderRoute('/status', false, flaky);

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 5000 });
    const callsBefore = healthCalls;
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => expect(healthCalls).toBe(callsBefore + 1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const same = screen.getByRole('button', { name: 'Tentar de novo' });
    expect(same).toBe(retry);
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Carregando…')).toBeNull();
    fireEvent.click(retry);
    expect(healthCalls).toBe(callsBefore + 1);

    release();
    expect(await screen.findByText('A API está ok.')).toBeTruthy();
  });
});

describe('the public home does not say the brand twice (#639)', () => {
  it('keeps the title for assistive technology and shows the sentence as the visible heading line', () => {
    renderRoute('/', false);
    expect(screen.getByRole('heading', { name: 'Ageniza', level: 1 }).classList.contains('visually-hidden')).toBe(true);
    expect(screen.getByText('Operações de agência, em um só lugar.').classList.contains('public-home__lead')).toBe(true);
  });
});
