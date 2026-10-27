// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { isCalendarPath } from './agency-nav.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const sessionBody = { user: { id: AGENCY, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (): Response => json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Custom' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions
});

const makeFetch = (permissions: readonly string[], gate?: Promise<void>, logoutGate?: Promise<void>) => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith('/auth/session')) return json(sessionBody);
    if (url.endsWith(`/agencies/${AGENCY}/me`)) {
      await gate;
      return json(agencyMe(permissions));
    }
    if (url.endsWith('/auth/logout') && method === 'POST') {
      await logoutGate;
      return new Response(null, { status: 204 });
    }
    return notFound();
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  return <ApplicationRoutes session={useAuthSession(store)} />;
}

const renderAt = (entry: string, permissions: readonly string[] = ['colaborador.visualizar', 'cliente.visualizar', 'conteudo.visualizar'], gate?: Promise<void>, logoutGate?: Promise<void>) => {
  const { impl, calls } = makeFetch(permissions, gate, logoutGate);
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const store = createAuthSessionStore(client);
  const probe = { pathname: '', navigate: (to: string): void => { void to; } };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <Navigator probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { calls, probe };
};

function Navigator({ probe }: { probe: { pathname: string; navigate: (to: string) => void } }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.navigate = navigate;
  });
  return null;
}

const sidebarElement = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.agency-sidebar');
  if (element === null) throw new Error('The sidebar is not on screen.');
  return element;
};
const sidebar = async (): Promise<HTMLElement> => {
  await screen.findByRole('link', { name: 'Agência Um' });
  return sidebarElement();
};
const linkNames = (scope: HTMLElement): (string | null)[] => within(scope).getAllByRole('link').map((link) => link.textContent);
const go = async (probe: { navigate: (to: string) => void }, to: string): Promise<void> => { await act(async () => { probe.navigate(to); }); };

describe('agency side navigation (#628)', () => {
  it('groups the items under Trabalho and Agência, in the order of the design', async () => {
    renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    const nav = within(aside).getByRole('navigation', { name: 'Navegação da agência' });
    expect(linkNames(within(nav).getByRole('region', { name: 'Trabalho' }))).toEqual(['Início', 'Conteúdos', 'Clientes']);
    expect(linkNames(within(nav).getByRole('region', { name: 'Agência' }))).toEqual(['Equipe']);
    expect(within(nav).queryByRole('link', { name: 'Ajustes' })).toBeNull();
  });

  it.each([
    ['no permission', [], ['Início'], false],
    ['only the team', ['colaborador.visualizar'], ['Início'], true],
    ['only the roster', ['cliente.visualizar'], ['Início', 'Clientes'], false],
    ['contents without the roster', ['conteudo.visualizar'], ['Início'], false],
    ['contents with the roster', ['conteudo.visualizar', 'cliente.visualizar'], ['Início', 'Conteúdos', 'Clientes'], false]
  ])('offers the items a role with %s sees, and the Agência group only with the team', async (_name, permissions, work, hasAgencyGroup) => {
    renderAt(`/agencia/${AGENCY}`, permissions);
    const aside = await sidebar();
    expect(linkNames(within(aside).getByRole('region', { name: 'Trabalho' }))).toEqual(work);
    if (hasAgencyGroup) expect(linkNames(within(aside).getByRole('region', { name: 'Agência' }))).toEqual(['Equipe']);
    else expect(within(aside).queryByRole('region', { name: 'Agência' })).toBeNull();
  });

  it('points each item at its route and marks the current one', async () => {
    renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    const href = (name: string): string | null => within(aside).getByRole('link', { name }).getAttribute('href');
    expect(href('Início')).toBe(`/agencia/${AGENCY}`);
    expect(href('Conteúdos')).toBe(`/agencia/${AGENCY}/conteudos`);
    expect(href('Clientes')).toBe(`/agencia/${AGENCY}/clientes`);
    expect(href('Equipe')).toBe(`/agencia/${AGENCY}/colaboradores`);
    expect(within(aside).getByRole('link', { name: 'Clientes' }).getAttribute('aria-current')).toBe('page');
    expect(within(aside).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps the context link at the top, with the agency name', async () => {
    renderAt(`/agencia/${AGENCY}`);
    const aside = await sidebar();
    expect(within(aside).getByText('Contexto ativo')).toBeTruthy();
    expect(within(aside).getByRole('link', { name: 'Agência Um' }).getAttribute('href')).toBe(`/agencia/${AGENCY}`);
  });

  it('opens at full width with the logo on every screen but the calendar', async () => {
    renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    expect(aside.getAttribute('data-collapsed')).toBe('false');
    expect(within(aside).getByRole('img', { name: 'Ageniza' }).getAttribute('src')).toBe('/brand/logo-para-fundo-escuro.svg');
    const toggle = within(aside).getByRole('button', { name: 'Recolher navegação' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens collapsed, with the symbol, on the calendar of a client', async () => {
    renderAt(`/agencia/${AGENCY}/conteudos/${CLIENT}`);
    const aside = await sidebar();
    expect(aside.getAttribute('data-collapsed')).toBe('true');
    expect(within(aside).getByRole('img', { name: 'Ageniza' }).getAttribute('src')).toBe('/brand/simbolo-branco.svg');
    expect(within(aside).getAllByRole('img', { name: 'Ageniza' })).toHaveLength(1);
    expect(within(aside).getByRole('button', { name: 'Abrir navegação' }).getAttribute('aria-expanded')).toBe('false');
    expect(linkNames(aside)).toContain('Conteúdos');
  });

  it.each([
    [`/agencia/${AGENCY}/conteudos/${CLIENT}`, true],
    [`/agencia/${AGENCY}/conteudos/${CLIENT}/novo`, true],
    [`/agencia/${AGENCY}/conteudos/${CLIENT}/33333333-3333-4333-8333-333333333333`, true],
    [`/agencia/${AGENCY}/conteudos`, false],
    [`/agencia/${AGENCY}/clientes/${CLIENT}/conteudos`, false],
    [`/agencia/${AGENCY}`, false]
  ])('tells the calendar of a client (and the modals over it) from every other address: %s', (path, expected) => {
    expect(isCalendarPath(path)).toBe(expected);
  });

  it('opens at full width on the client picker, which is not the calendar', async () => {
    renderAt(`/agencia/${AGENCY}/conteudos`);
    expect((await sidebar()).getAttribute('data-collapsed')).toBe('false');
  });

  it('follows the route until the person chooses, then keeps their choice across screens', async () => {
    const { probe } = renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();

    await go(probe, `/agencia/${AGENCY}/conteudos/${CLIENT}`);
    await waitFor(() => expect(aside.getAttribute('data-collapsed')).toBe('true'));
    await go(probe, `/agencia/${AGENCY}/clientes`);
    await waitFor(() => expect(aside.getAttribute('data-collapsed')).toBe('false'));

    fireEvent.click(within(aside).getByRole('button', { name: 'Recolher navegação' }));
    expect(aside.getAttribute('data-collapsed')).toBe('true');
    await go(probe, `/agencia/${AGENCY}`);
    expect(aside.getAttribute('data-collapsed')).toBe('true');

    await go(probe, `/agencia/${AGENCY}/conteudos/${CLIENT}`);
    fireEvent.click(within(aside).getByRole('button', { name: 'Abrir navegação' }));
    expect(aside.getAttribute('data-collapsed')).toBe('false');
    await go(probe, `/agencia/${AGENCY}/conteudos/${CLIENT}/novo`);
    expect(aside.getAttribute('data-collapsed')).toBe('false');
  });

  it('puts the person and the way out at the foot, and Sair signs out', async () => {
    const { calls, probe } = renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    expect(await within(aside).findByRole('button', { name: 'Pessoa' })).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls.filter((call) => call === 'POST /auth/logout')).toHaveLength(1);
  });

  it('shows the sidebar skeleton, with the logo and the account menu, while the context loads', async () => {
    let release: () => void = () => undefined;
    renderAt(`/agencia/${AGENCY}`, undefined, new Promise<void>((resolve) => { release = resolve; }));
    const aside = await waitFor(sidebarElement);
    expect(within(aside).getByRole('img', { name: 'Ageniza' })).toBeTruthy();
    expect(await within(aside).findByRole('button', { name: 'Pessoa' })).toBeTruthy();
    expect(within(aside).queryByRole('link', { name: 'Início' })).toBeNull();
    release();
    await waitFor(() => expect(within(sidebarElement()).getByRole('link', { name: 'Início' })).toBeTruthy());
  });
});

describe('Sair at the foot while the sign-out is in flight', () => {
  it('keeps focus on the button and marks it busy instead of disabling it', async () => {
    let release: () => void = () => undefined;
    const { probe } = renderAt(`/agencia/${AGENCY}/clientes`, undefined, undefined, new Promise<void>((resolve) => { release = resolve; }));
    const aside = await sidebar();
    const leave = within(aside).getByRole('button', { name: 'Sair' });
    leave.focus();
    fireEvent.click(leave);

    await waitFor(() => expect(leave.getAttribute('aria-disabled')).toBe('true'));
    expect(leave.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(leave);

    release();
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
  });
});

describe('CSS contract of the rail and the bottom bar', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
    body: match[2]!
  }));
  const rail = (selector: string): string[] =>
    rules.filter((rule) => rule.selectors.includes(`.agency-sidebar[data-collapsed='true'] ${selector}`)).map((rule) => rule.body);
  const bar = (selector: string): string[] => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);

  // Controls that take focus must leave the tab order when hidden: a clipped block is still tabbable (WCAG 2.4.7).
  it.each(['.agency-sidebar__context', '.account-menu__leave'])('removes %s from the rail with display: none, never clip-path', (selector) => {
    const found = rail(selector);
    expect(found.length).toBeGreaterThan(0);
    for (const body of found) {
      expect(body).toMatch(/display:\s*none/);
      expect(body).not.toMatch(/clip-path/);
    }
  });

  it.each(['.agency-sidebar__top', '.agency-sidebar__context', '.account-menu__leave'])('removes %s from the bar with display: none, never clip-path', (selector) => {
    const last = bar(selector).at(-1);
    expect(last).toMatch(/display:\s*none/);
    for (const body of bar(selector)) expect(body).not.toMatch(/clip-path/);
  });

  it.each(['.agency-nav__group-title', '.account-menu__name', '.account-menu__chevron'])('keeps the text of %s readable in the bar with the visually-hidden pattern', (selector) => {
    expect(bar(selector).at(-1)).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(bar(selector).at(-1)).not.toMatch(/display:\s*none/);
  });

  it('lifts the skip link above the sidebar, or the focused link lands behind it', () => {
    const zIndex = (selector: string): number => {
      const body = rules.find((rule) => rule.selectors.includes(selector))?.body ?? '';
      return Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    };
    expect(zIndex('.skip-link')).toBeGreaterThan(zIndex('.agency-sidebar'));
  });

  it('shares the bar by item: each group takes as much width as it has items', () => {
    for (const items of [1, 2, 3]) {
      expect(bar(`.agency-nav__group[data-items='${items}']`).join(' ')).toContain(`flex: ${items};`);
    }
  });
});
