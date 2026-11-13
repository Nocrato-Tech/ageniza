// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { isCalendarPath } from './agency-nav.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { readGlobalCss } from './styles/read-css';

let meOverrides: Record<string, unknown> = {};
let health: () => Response = () => json({ status: 'ok' });
afterEach(() => { cleanup(); meOverrides = {}; health = () => json({ status: 'ok' }); });

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const sessionBody = { user: { id: AGENCY, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (): Response => json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Custom' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions, ...meOverrides
});

const makeFetch = (permissions: readonly string[], gate?: Promise<void>, logoutGate?: Promise<void>) => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith('/auth/session')) return json(sessionBody);
    if (url.endsWith('/health')) return health();
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
  await screen.findByRole('link', { name: /Agência Um/ });
  return sidebarElement();
};
const linkNames = (scope: HTMLElement): (string | null)[] => within(scope).getAllByRole('link').map((link) => link.textContent);
const go = async (probe: { navigate: (to: string) => void }, to: string): Promise<void> => { await act(async () => { probe.navigate(to); }); };

describe('agency side navigation (#628)', () => {
  it('groups the items under Trabalho and Agência, in the order of the design', async () => {
    renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    const nav = within(aside).getByRole('navigation', { name: 'Navegação da agência' });
    expect(linkNames(within(nav).getByRole('region', { name: 'Trabalho' }))).toEqual(['Início', 'Calendário Editorial', 'Clientes']);
    expect(linkNames(within(nav).getByRole('region', { name: 'Agência' }))).toEqual(['Equipe']);
    expect(within(nav).queryByRole('link', { name: 'Ajustes' })).toBeNull();
  });

  it.each([
    ['no permission', [], ['Início'], false],
    ['only the team', ['colaborador.visualizar'], ['Início'], true],
    ['only the roster', ['cliente.visualizar'], ['Início', 'Clientes'], false],
    ['contents without the roster', ['conteudo.visualizar'], ['Início'], false],
    ['contents with the roster', ['conteudo.visualizar', 'cliente.visualizar'], ['Início', 'Calendário Editorial', 'Clientes'], false]
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
    expect(href('Calendário Editorial')).toBe(`/agencia/${AGENCY}/conteudos`);
    expect(href('Clientes')).toBe(`/agencia/${AGENCY}/clientes`);
    expect(href('Equipe')).toBe(`/agencia/${AGENCY}/colaboradores`);
    expect(within(aside).getByRole('link', { name: 'Clientes' }).getAttribute('aria-current')).toBe('page');
    expect(within(aside).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBeNull();
  });

  it('puts the context card at the top, with the agency name, and it leads to the context switch', async () => {
    const { probe } = renderAt(`/agencia/${AGENCY}`);
    const aside = await sidebar();
    expect(within(aside).getByText('Agência logada')).toBeTruthy();
    expect(within(aside).queryByText('Contexto ativo')).toBeNull();
    const card = within(aside).getByRole('link', { name: /Agência logada.*Agência Um/ });
    expect(card.getAttribute('href')).toBe('/contextos');
    expect(card.querySelector('svg')).not.toBeNull();
    fireEvent.click(card);
    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
  });

  it('goes to the screen of every item when it is clicked', async () => {
    const { probe } = renderAt(`/agencia/${AGENCY}`, ['colaborador.visualizar', 'cliente.visualizar', 'conteudo.visualizar', 'assinatura.gerenciar']);
    const aside = await sidebar();
    expect(linkNames(within(aside).getByRole('region', { name: 'Agência' }))).toEqual(['Equipe', 'Assinatura']);
    for (const [name, to] of [['Calendário Editorial', 'conteudos'], ['Clientes', 'clientes'], ['Equipe', 'colaboradores'], ['Assinatura', 'assinatura'], ['Início', '']] as const) {
      fireEvent.click(within(aside).getByRole('link', { name }));
      await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}${to === '' ? '' : `/${to}`}`));
    }
  });

  it('shows the role under the name at the foot: the Owner as "Dona" with the crown, anyone else with the name of the role', async () => {
    meOverrides = { isOwner: true, role: { key: 'admin', name: 'Admin' } };
    renderAt(`/agencia/${AGENCY}`);
    const owner = within(await sidebar()).getByRole('button', { name: /Pessoa/ });
    expect(within(owner).getByText('Dona')).toBeTruthy();
    expect(owner.querySelector('.account-menu__role--owner svg')).not.toBeNull();
    expect(within(owner).queryByText('Admin')).toBeNull();
    cleanup();

    meOverrides = {};
    renderAt(`/agencia/${AGENCY}`);
    const member = within(await sidebar()).getByRole('button', { name: /Pessoa/ });
    expect(within(member).getByText('Custom')).toBeTruthy();
    expect(within(member).queryByText('Dona')).toBeNull();
    expect(member.querySelector('.account-menu__role--owner')).toBeNull();
  });

  it('opens Ajuda with the status of the system, and leaves the tour out where there is none to review', async () => {
    const { probe } = renderAt(`/agencia/${AGENCY}`);
    await sidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ajuda' }));
    const menu = await screen.findByRole('menu', { name: 'Ajuda' });
    expect(within(menu).queryByRole('menuitem', { name: 'Rever o tour' })).toBeNull();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Status do serviço Normal' }));
    await waitFor(() => expect(probe.pathname).toBe('/status'));
  });

  it('names the status entry without a label when the status did not answer: never Normal without having read it', async () => {
    health = () => json({ error: { code: 'INTERNAL_ERROR', message: 'down' } }, 503);
    const { calls } = renderAt(`/agencia/${AGENCY}`);
    await sidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ajuda' }));
    const menu = await screen.findByRole('menu', { name: 'Ajuda' });
    const entry = within(menu).getByRole('menuitem', { name: 'Status do serviço' });
    await waitFor(() => expect(calls).toContain('GET /health'));
    expect(within(entry).queryByText('Normal')).toBeNull();
    expect(entry.textContent).toBe('Status do serviço');
  });

  it('keeps the place of the search empty and puts the bell before Ajuda: no control for what has no destination yet', async () => {
    renderAt(`/agencia/${AGENCY}`);
    await sidebar();
    const bar = document.querySelector<HTMLElement>('.shell-topbar');
    expect(bar).not.toBeNull();
    expect(within(bar!).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Notificações', 'Ajuda']);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('calls the context "Agência logada" in the account menu too, with the name of the agency', async () => {
    renderAt(`/agencia/${AGENCY}`);
    const aside = await sidebar();
    fireEvent.click(within(aside).getByRole('button', { name: /Pessoa/ }));
    const menu = await screen.findByRole('menu');
    const context = within(menu).getByRole('group', { name: 'Agência logada' });
    expect(within(context).getByText('Agência Um')).toBeTruthy();
    expect(within(menu).queryByText('Contexto ativo')).toBeNull();
  });

  it('opens at full width with the logo on every screen but the calendar', async () => {
    renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    expect(aside.getAttribute('data-collapsed')).toBe('false');
    expect(within(aside).getByRole('img', { name: 'Ageniza' }).getAttribute('src')).toBe('/brand/logo-para-fundo-claro.svg');
    const toggle = within(aside).getByRole('button', { name: 'Recolher navegação' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens collapsed, with the symbol, on the calendar of a client', async () => {
    renderAt(`/agencia/${AGENCY}/conteudos/${CLIENT}`);
    const aside = await sidebar();
    expect(aside.getAttribute('data-collapsed')).toBe('true');
    expect(within(aside).getByRole('img', { name: 'Ageniza' }).getAttribute('src')).toBe('/brand/simbolo-colorido.svg');
    expect(within(aside).getAllByRole('img', { name: 'Ageniza' })).toHaveLength(1);
    expect(within(aside).getByRole('button', { name: 'Abrir navegação' }).getAttribute('aria-expanded')).toBe('false');
    expect(linkNames(aside)).toContain('Calendário Editorial');
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

  it('puts the person at the foot with no Sair beside it: the way out is the account menu item', async () => {
    const { calls, probe } = renderAt(`/agencia/${AGENCY}/clientes`);
    const aside = await sidebar();
    fireEvent.click(await within(aside).findByRole('button', { name: /Pessoa/ }));
    expect(within(aside).queryByRole('button', { name: 'Sair' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sair' }));
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls.filter((call) => call === 'POST /auth/logout')).toHaveLength(1);
  });

  it('shows the sidebar skeleton, with the logo and the account menu, while the context loads', async () => {
    let release: () => void = () => undefined;
    renderAt(`/agencia/${AGENCY}`, undefined, new Promise<void>((resolve) => { release = resolve; }));
    const aside = await waitFor(sidebarElement);
    expect(within(aside).getByRole('img', { name: 'Ageniza' })).toBeTruthy();
    expect(await within(aside).findByRole('button', { name: /Pessoa/ })).toBeTruthy();
    expect(within(aside).queryByRole('link', { name: 'Início' })).toBeNull();
    release();
    await waitFor(() => expect(within(sidebarElement()).getByRole('link', { name: 'Início' })).toBeTruthy());
  });
});

describe('CSS contract of the rail and the bottom bar', () => {
  const css = readGlobalCss();
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
    body: match[2]!
  }));
  const rail = (selector: string): string[] =>
    rules.filter((rule) => rule.selectors.includes(`.agency-sidebar[data-collapsed='true'] ${selector}`)).map((rule) => rule.body);
  const bar = (selector: string): string[] => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);

  // Controls that take focus must leave the tab order when hidden: a clipped block is still tabbable (WCAG 2.4.7).
  it.each(['.agency-sidebar__context'])('removes %s from the rail with display: none, never clip-path', (selector) => {
    const found = rail(selector);
    expect(found.length).toBeGreaterThan(0);
    for (const body of found) {
      expect(body).toMatch(/display:\s*none/);
      expect(body).not.toMatch(/clip-path/);
    }
  });

  it.each(['.agency-nav__group-title', '.account-menu__name', '.account-menu__role', '.account-menu__chevron'])('keeps the text of %s readable in the rail with the visually-hidden pattern', (selector) => {
    const found = rail(selector);
    expect(found.length).toBeGreaterThan(0);
    for (const body of found) {
      expect(body).toMatch(/clip-path:\s*inset\(50%\)/);
      expect(body).not.toMatch(/display:\s*none/);
    }
  });

  it('draws the phone bars as their own blocks: the top bar sticks, the bottom bar is fixed and shares its width by item', () => {
    expect(bar('.agency-mbar').join(' ')).toMatch(/position:\s*sticky/);
    expect(bar('.agency-bottomnav').join(' ')).toMatch(/position:\s*fixed/);
    expect(bar('.agency-bottomnav').join(' ')).toContain('repeat(var(--n, 4), minmax(0, 1fr))');
  });

  it('lifts the skip link above the sidebar, or the focused link lands behind it', () => {
    const zIndex = (selector: string): number => {
      const body = rules.find((rule) => rule.selectors.includes(selector))?.body ?? '';
      return Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    };
    expect(zIndex('.skip-link')).toBeGreaterThan(zIndex('.agency-sidebar'));
  });

});

describe('the phone shell (390px)', () => {
  const stubPhone = (): void => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('min-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  const everything = ['colaborador.visualizar', 'cliente.visualizar', 'conteudo.visualizar', 'assinatura.gerenciar'];

  it('has a top bar with the mark, the context switch and the person, and no side column', async () => {
    stubPhone();
    const { probe } = renderAt(`/agencia/${AGENCY}`, everything);
    const bar = (await screen.findByRole('link', { name: 'Agência Um' })).closest('.agency-mbar') as HTMLElement;
    expect(document.querySelector('.agency-sidebar')).toBeNull();
    expect(document.querySelector('.shell-topbar')).toBeNull();
    expect(within(bar).getByRole('link', { name: 'Agência Um' }).getAttribute('href')).toBe('/contextos');
    expect(within(bar).getByRole('button', { name: 'Notificações' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Ajuda' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Conta de Pessoa' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('link', { name: 'Agência Um' }));
    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
  });

  it('has the four daily destinations at the bottom, and Assinatura only in the account menu', async () => {
    stubPhone();
    const { probe } = renderAt(`/agencia/${AGENCY}/clientes`, everything);
    const bottom = await screen.findByRole('navigation', { name: 'Navegação da agência' });
    const links = within(bottom).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label') ?? link.textContent)).toEqual(['Início', 'Calendário Editorial', 'Clientes', 'Equipe']);
    expect(links.map((link) => link.textContent)).toEqual(['Início', 'Calendário', 'Clientes', 'Equipe']);
    expect(within(bottom).queryByRole('link', { name: 'Assinatura' })).toBeNull();
    expect(within(bottom).getByRole('link', { name: 'Clientes' }).getAttribute('aria-current')).toBe('page');
    for (const [name, to] of [['Calendário Editorial', 'conteudos'], ['Equipe', 'colaboradores'], ['Início', '']] as const) {
      fireEvent.click(within(bottom).getByRole('link', { name }));
      await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}${to === '' ? '' : `/${to}`}`));
    }

    fireEvent.click(screen.getByRole('button', { name: 'Conta de Pessoa' }));
    const menu = await screen.findByRole('menu', { name: 'Menu da conta' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Assinatura' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/assinatura`));
  });

  it('keeps every control of the account menu within reach: the context, the e-mail change and the ways out', async () => {
    stubPhone();
    renderAt(`/agencia/${AGENCY}`, everything);
    fireEvent.click(await screen.findByRole('button', { name: 'Conta de Pessoa' }));
    const menu = await screen.findByRole('menu', { name: 'Menu da conta' });
    expect(within(menu).getByRole('group', { name: 'Agência logada' })).toBeTruthy();
    for (const name of ['Pedir troca de e-mail', 'Sair', 'Sair de todas as sessões']) expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
  });

  it('opens Ajuda from the top bar with the status of the system', async () => {
    stubPhone();
    const { probe } = renderAt(`/agencia/${AGENCY}`, everything);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajuda' }));
    fireEvent.click(await within(await screen.findByRole('menu', { name: 'Ajuda' })).findByRole('menuitem', { name: 'Status do serviço Normal' }));
    await waitFor(() => expect(probe.pathname).toBe('/status'));
  });
});
