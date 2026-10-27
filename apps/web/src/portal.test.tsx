// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortalClientResponse } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { portalClientQueryKey } from './portal.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { todayInSaoPaulo } from './content-dates.js';
import { contentsError, createPortalContentsApi } from './portal-contents-fixture.js';
import { createPortalScriptsApi, portalStudyBody, scriptError } from './portal-fixture.js';
import { useCommittedLocation } from './location-probe-fixture.js';

afterEach(cleanup);

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  // jsdom has no top layer; these stubs only model opening and closing.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CLIENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sessionBody = { user: { id: USER_ID, name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const agencyMe = {
  agencyId: AGENCY_A,
  agencyName: 'Agência Um',
  isOwner: false,
  membershipId: null,
  role: { key: 'admin', name: 'Admin' },
  plan: { kind: 'isenta', trialEndsAt: null, readOnly: false },
  permissions: ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar']
};
const contextsBody = {
  canCreateAgency: false,
  contexts: [{ type: 'client', clientId: CLIENT_ID, clientName: 'Padaria Central', agencyId: AGENCY_A, agencyName: 'Agência Um', onboardingPending: false }]
};
const legalAccepted = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};

const portalClient = (overrides: Partial<PortalClientResponse> = {}): Record<string, unknown> => ({
  id: CLIENT_ID,
  name: 'Padaria Central',
  status: 'active',
  photoUrl: null,
  legalName: null,
  taxId: null,
  segment: null,
  website: null,
  instagramHandle: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  archivedAt: null,
  agencyName: 'Agência Um',
  onboardingSeenAt: '2026-10-01T12:00:00.000Z', agencyReadOnly: false,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0 },
  ...overrides
});

const detailOf = (registration: Record<string, unknown>): Record<string, unknown> => ({
  ...registrationOf(registration),
  summary: { brandStudyFilled: 5, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 1 }
});

function registrationOf(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'summary' && key !== 'agencyName' && key !== 'onboardingSeenAt' && key !== 'agencyReadOnly' && key !== 'home'));
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (): Response => json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } }, 404);

interface Scenario {
  /** No session: like the real API, every endpoint answers 401 (the portal is never reachable). */
  readonly anonymous?: boolean;
  readonly portal?: () => Response | Promise<Response>;
  readonly client?: () => Response | Promise<Response>;
  readonly patch?: (body: unknown) => Response | Promise<Response>;
  readonly putPhoto?: () => Response | Promise<Response>;
  readonly legal?: () => Response | Promise<Response>;
  /** The story scripts of the portal; none by default, as a client with nothing sent for any day. */
  readonly scripts?: ReturnType<typeof createPortalScriptsApi>;
  /** The contents of the portal; none by default, as a client with nothing planned for any month. */
  readonly contents?: ReturnType<typeof createPortalContentsApi>;
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (scenario.anonymous === true) return json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, 401);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    if (path.endsWith('/me/contexts')) return json(contextsBody);
    if (path.endsWith('/me/legal-acceptances')) return scenario.legal?.() ?? json(legalAccepted);
    if (path.startsWith(`/clients/${CLIENT_ID}/story-scripts`)) {
      const answered = (scenario.scripts ?? createPortalScriptsApi(CLIENT_ID, () => new Date())).handle(url, method);
      if (answered !== undefined) return answered;
    }
    if (path.startsWith(`/clients/${CLIENT_ID}/contents`)) {
      const answered = (scenario.contents ?? createPortalContentsApi(CLIENT_ID)).handle(url, method);
      if (answered !== undefined) return answered;
    }
    if (path === `/clients/${CLIENT_ID}`) return scenario.portal?.() ?? json(portalClient());
    if (path === `/clients/${CLIENT_ID}/brand-study`) return json(portalStudyBody());
    if (path === `/clients/${OTHER_CLIENT_ID}`) return json(portalClient({ id: OTHER_CLIENT_ID, name: 'Outro Cliente' }));
    if (path.endsWith('/agencies/' + AGENCY_A + '/me')) return json(agencyMe);
    const photo = new RegExp(`/agencies/${AGENCY_A}/clients/([^/]+)/photo$`).exec(path);
    if (photo !== null) {
      if (method === 'PUT') return scenario.putPhoto?.() ?? json({ photoUrl: 'https://storage.test/nova.png' });
      return new Response(null, { status: 204 });
    }
    const detail = new RegExp(`/agencies/${AGENCY_A}/clients/([^/]+)$`).exec(path);
    if (detail !== null) {
      if (method === 'PATCH') {
        if (scenario.patch === undefined) throw new Error(`unexpected PATCH ${url}`);
        return scenario.patch(JSON.parse(String(init?.body)));
      }
      return scenario.client?.() ?? json(detailOf(registrationOf(portalClient())));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface ProbeTarget {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function Probe({ probe }: { probe: ProbeTarget }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.navigate = navigate;
  });
  return null;
}

const portalUrl = (slug = 'inicio', clientId = CLIENT_ID) => `/portal/${clientId}/${slug}`;
const agencyClientUrl = `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}/geral`;

const renderPortal = (impl: typeof fetch, entry = portalUrl()) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', search: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <Probe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe, queryClient };
};

/** What the client's portal never says: the words of the system and of the agency's side. */
const INTERNAL_TERMS = /thread|status|arquivad|onboarding|persona/i;

const nav = () => screen.getByRole('navigation', { name: 'Navegação do portal' });
const clickTab = (label: string): void => { fireEvent.click(within(nav()).getByRole('link', { name: label })); };

describe('client portal shell (#141)', () => {
  it('redirects the bare portal address to Início and keeps every route under /portal/:clienteId, in Portuguese', async () => {
    const { impl } = makeFetch();
    const { probe } = renderPortal(impl, `/portal/${CLIENT_ID}`);
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(within(nav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Início', 'Conteúdos', 'Marca', 'Relatórios']);
    expect(within(nav()).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBe('page');

    clickTab('Conteúdos');
    expect(await screen.findByRole('heading', { level: 1, name: 'Conteúdos' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('conteudos'));
    expect(within(nav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('aria-current')).toBe('page');

    clickTab('Relatórios');
    expect(await screen.findByRole('heading', { name: 'Relatórios' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('relatorios'));

    clickTab('Marca');
    expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('marca'));

    clickTab('Início');
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(screen.queryByRole('heading', { name: 'Página não encontrada' })).toBeNull();
  });

  it('shows the client and its agency in the header, and the client inside the account menu', async () => {
    const { impl } = makeFetch();
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    const header = container.querySelector('.portal-header') as HTMLElement;
    expect(within(header).getByText('Padaria Central')).toBeTruthy();
    expect(within(header).getByText('por Agência Um')).toBeTruthy();

    fireEvent.click(within(header).getByRole('button', { name: /Maria/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Contexto ativo')).toBeTruthy();
    expect(within(menu).getByText('Padaria Central')).toBeTruthy();
  });

  it('says the portal is read-only when the trial of the agency ended, and nothing otherwise (issue #714)', async () => {
    renderPortal(makeFetch({ portal: () => json(portalClient({ agencyReadOnly: true })) }).impl);
    const notice = await screen.findByRole('region', { name: 'Portal somente leitura' });
    expect(notice.textContent).toContain('não é possível aprovar, pedir ajustes nem comentar');
    expect(notice.textContent).toContain('Fale com Agência Um.');
    cleanup();

    renderPortal(makeFetch({ portal: () => json(portalClient()) }).impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(screen.queryByRole('region', { name: 'Portal somente leitura' })).toBeNull();
  });

  it('offers one next action, which changes with the agency answers and leads to the brand study', async () => {
    const none = makeFetch({ portal: () => json(portalClient()) });
    const first = renderPortal(none.impl);
    expect(await screen.findByText('Conheça o estudo da sua marca')).toBeTruthy();
    expect(screen.queryByText(/A agência respondeu/)).toBeNull();
    expect(within(screen.getByRole('link', { name: /Conheça o estudo da sua marca/ })).getByText('ver')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Conheça o estudo da sua marca/ }));
    expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
    expect(first.probe.pathname).toBe(portalUrl('marca'));
    cleanup();

    const many = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 2, brandStudyFilled: 5, contentsAwaitingApproval: 0 } })) });
    renderPortal(many.impl);
    const action = await screen.findByRole('link', { name: /A agência respondeu 2 sugestões suas/ });
    expect(action.getAttribute('href')).toBe(portalUrl('marca'));
    cleanup();

    const one = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 1, brandStudyFilled: 5, contentsAwaitingApproval: 0 } })) });
    renderPortal(one.impl);
    expect(await screen.findByText('A agência respondeu 1 sugestão sua')).toBeTruthy();
    expect(screen.queryByText('A agência respondeu 2 sugestões suas')).toBeNull();
  });

  it.each([
    ['Relatórios', 'Aqui você vai ver os resultados do trabalho que sua agência faz para você.']
  ])('draws %s as a skeleton with its reason and no clickable control', async (label, sentence) => {
    const { impl } = makeFetch();
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    clickTab(label);

    const heading = await screen.findByRole('heading', { name: label });
    expect(within(heading.closest('section') as HTMLElement).getByText(sentence)).toBeTruthy();
    const panel = heading.closest('section') as HTMLElement;
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.portal-skeleton')).toBeTruthy();
  });

  it('draws Relatórios with the owl and what is missing, not as a bare paragraph', async () => {
    const { container } = renderPortal(makeFetch().impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    clickTab('Relatórios');
    expect(await screen.findByRole('heading', { level: 2, name: 'Ainda não há resultados para mostrar' })).toBeTruthy();
    expect(container.querySelectorAll('.portal-skeleton img.ui-mascot')).toHaveLength(1);
  });

  it('keeps the focused control clear of the sticky bar: room below it on a phone, under the tabs on a wide screen', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8').replace(/\r\n/g, '\n');
    const phone = css.slice(css.indexOf('\nhtml:has(.portal-shell) {'));
    expect(phone.slice(0, phone.indexOf('}'))).toMatch(/scroll-padding-bottom:\s*calc\(5\.5rem \+ env\(safe-area-inset-bottom\)\);/);
    const wide = css.slice(css.indexOf('@media (min-width: 48rem) {\n  html:has(.portal-shell) {'));
    expect(wide.slice(0, wide.indexOf('}'))).toMatch(/scroll-padding-top:\s*5rem;/);
  });

  it('sets the tab title of each of the four areas', async () => {
    const { impl } = makeFetch();
    renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(document.title).toBe('Início — Portal do cliente — Ageniza');

    for (const label of ['Conteúdos', 'Marca', 'Relatórios']) {
      clickTab(label);
      await screen.findByRole('heading', { name: label === 'Marca' ? 'Sua marca' : label });
      expect(document.title).toBe(`${label} — Portal do cliente — Ageniza`);
    }

    clickTab('Início');
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(document.title).toBe('Início — Portal do cliente — Ageniza');
  });

  it('keeps the bottom bar as the last piece of a screen-tall column shell, with the content taking the rest', async () => {
    const { impl } = makeFetch();
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    // Structure: header, content, bar — the bar follows the content directly inside the shell.
    const shell = container.querySelector('.portal-shell') as HTMLElement;
    expect(shell.classList.contains('app-shell')).toBe(true);
    expect(Array.from(shell.children).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'header', 'main', 'nav']);
    expect(shell.lastElementChild).toBe(nav());

    // jsdom has no layout, so the rules that put the bar at the bottom of a short page are read from
    // the stylesheet; the real 360x780 capture is in the PR (review of #401, finding 1).
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      if (start === -1) throw new Error(`${selector} was not found in globals.css.`);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.portal-shell')).toMatch(/display:\s*flex;/);
    expect(rule('.portal-shell')).toMatch(/flex-direction:\s*column;/);
    expect(rule('.portal-shell')).toMatch(/min-height:\s*100dvh;/);
    expect(rule('.portal-shell > .portal-content')).toMatch(/flex:\s*1;/);
    expect(rule('.portal-shell > .portal-content')).toMatch(/width:\s*100%;/);
  });

  it('never shows an internal term in the client portal', async () => {
    const { impl } = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 2, brandStudyFilled: 5, contentsAwaitingApproval: 0 } })) });
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    clickTab('Conteúdos');
    await screen.findByRole('heading', { name: 'Conteúdos' });

    expect(container.textContent).not.toMatch(INTERNAL_TERMS);
  });

  it('never shows an internal term in the contents of the portal, with the month, with the month empty and with the filter empty', async () => {
    const contents = createPortalContentsApi(CLIENT_ID);
    contents.seed({ title: 'Um post do mês', publishOn: `${todayInSaoPaulo().slice(0, 8)}01`, status: 'approved' });
    const { container } = renderPortal(makeFetch({ contents }).impl, portalUrl('conteudos'));
    await screen.findByText('Um post do mês');
    expect(container.textContent).not.toMatch(INTERNAL_TERMS);

    fireEvent.change(screen.getByLabelText('Filtro'), { target: { value: 'adjusting' } });
    expect(await screen.findByText('Nenhum conteúdo nesta situação neste mês')).toBeTruthy();
    expect(container.textContent).not.toMatch(INTERNAL_TERMS);

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    expect(await screen.findByText('Nenhum conteúdo planejado para este mês')).toBeTruthy();
    expect(container.textContent).not.toMatch(INTERNAL_TERMS);
  });

  it('turns the next navigation into the ordinary not-found when the link is gone', async () => {
    let active = true;
    const { impl, calls } = makeFetch({ portal: () => (active ? json(portalClient()) : notFound()) });
    const { probe } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length).toBe(1);

    active = false;
    clickTab('Conteúdos');

    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('conteudos'));
    // The same not-found as any unknown address: never a message confirming the portal existed.
    expect(screen.queryByText(/acesso/i)).toBeNull();
  });

  it('brings the client back to the portal start from the not-found, never to the agency or the public home', async () => {
    const { impl } = makeFetch();
    const { probe } = renderPortal(impl, portalUrl('caminho-inexistente'));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.getByText('Este endereço não corresponde a uma página do Ageniza.')).toBeTruthy();
    expect(document.title).toBe('Página não encontrada — Ageniza');

    fireEvent.click(screen.getByRole('link', { name: 'Voltar ao início' }));

    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
  });

  it.each([
    ['the client is not found', () => makeFetch({ portal: () => notFound() }).impl, portalUrl()],
    ['the id is malformed', () => makeFetch().impl, '/portal/nao-e-uuid/inicio'],
    ['the answer belongs to another client', () => makeFetch({ portal: () => json(portalClient({ id: OTHER_CLIENT_ID })) }).impl, portalUrl()]
  ] as const)('points the not-found of an unverified portal address at the context chooser when %s', async (_name, impl, entry) => {
    renderPortal(impl(), entry);
    await screen.findByRole('heading', { name: 'Página não encontrada' });

    expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe('/contextos');
  });

  it('answers the ordinary not-found for a 404, for a malformed id and for another client answer', async () => {
    const gone = makeFetch({ portal: () => notFound() });
    renderPortal(gone.impl);
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    cleanup();

    const malformed = makeFetch();
    renderPortal(malformed.impl, '/portal/nao-e-uuid/inicio');
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(malformed.calls.some((call) => call.startsWith('GET /clients/'))).toBe(false);
    cleanup();

    // Defense in depth: an answer for another client is not shown as if it were this portal's.
    const wrong = makeFetch({ portal: () => json(portalClient({ id: OTHER_CLIENT_ID, name: 'Outro Cliente' })) });
    renderPortal(wrong.impl);
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.queryByText('Outro Cliente')).toBeNull();
  });

  it('does not render the portal without a session: no request for the client, the unavailable page instead', async () => {
    const { impl, calls } = makeFetch({ anonymous: true });
    renderPortal(impl);

    expect(await screen.findByRole('heading', { name: 'Área indisponível' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Olá/ })).toBeNull();
    expect(calls.some((call) => call.startsWith('GET /clients/'))).toBe(false);
  });

  it('answers the not-found inside the portal shell for an unknown portal address', async () => {
    const { impl } = makeFetch();
    const { probe, container } = renderPortal(impl, portalUrl('qualquer-coisa'));

    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('qualquer-coisa'));
    // Still the portal shell (client header and bar), not the generic protected header: the `*` of the portal answers.
    expect(within(container.querySelector('.portal-header') as HTMLElement).getByText('Padaria Central')).toBeTruthy();
    expect(within(nav()).getAllByRole('link').map((link) => link.getAttribute('aria-current'))).toEqual([null, null, null, null]);
    expect(container.querySelector('.protected-header')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Olá/ })).toBeNull();

    // The bar still works from there.
    clickTab('Início');
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
  });

  it.each([
    ['the client is not found', () => notFound(), 'Página não encontrada'],
    ['the portal cannot be opened', () => json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500), 'Não foi possível abrir o portal']
  ])('keeps the account menu as the way out when %s, without an active client', async (_name, portal, heading) => {
    const { impl } = makeFetch({ portal });
    const { container } = renderPortal(impl);
    // The query client retries a 5xx once after its backoff, so the failure screen takes a moment.
    expect(await screen.findByRole('heading', { name: heading }, { timeout: 4000 })).toBeTruthy();

    const header = container.querySelector('.portal-header') as HTMLElement;
    fireEvent.click(within(header).getByRole('button', { name: /Maria/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('maria@example.test')).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Sair' })).toBeTruthy();
    // No client is proven for this address, so none is named as the active context.
    expect(within(menu).queryByText('Contexto ativo')).toBeNull();
    expect(within(menu).queryByText('Padaria Central')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull();
  });

  it('offers a retry when the portal cannot be opened', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      portal: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : json(portalClient());
      }
    });
    const { container } = renderPortal(impl);
    // The query client retries a 5xx once after its backoff, so the failure screen takes a moment.
    expect(await screen.findByText('Não foi possível abrir o portal', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Tente de novo em instantes.')).toBeTruthy();
    expect(container.textContent).not.toContain('private diagnostic');

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(attempts).toBe(3);
  });

  it('shows the Início skeleton while the client loads', async () => {
    let resolvePortal: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolvePortal = resolve; });
    const { impl } = makeFetch({ portal: () => pending });
    const { container } = renderPortal(impl);

    await waitFor(() => expect(container.querySelectorAll('.portal-content .ui-skeleton').length).toBe(2));
    expect(container.querySelectorAll('.portal-header .ui-skeleton').length).toBe(3);
    expect(screen.queryByRole('heading', { name: /Olá/ })).toBeNull();
    await act(async () => { resolvePortal?.(json(portalClient())); });
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
  });
});

describe('portal reflects the agency edits (#141 extra acceptance)', () => {
  const clientGroup = (dialog: HTMLElement): HTMLElement =>
    within(dialog).getByRole('heading', { name: 'Cliente' }).closest('.edit-client__group') as HTMLElement;
  const openEditDialog = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    return await screen.findByRole('dialog', { name: 'Editar cliente' });
  };

  it('shows a registration edit on the portal without a reload', async () => {
    let registration = portalClient();
    let detail = detailOf(registration);
    const { impl, calls } = makeFetch({
      portal: () => json(registration),
      client: () => json(detail),
      patch: (body) => {
        registration = { ...registration, ...(body as Record<string, unknown>) };
        detail = detailOf(registration);
        return json(registrationOf(registration));
      }
    });
    const { probe, container, queryClient } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(within(container.querySelector('.portal-header') as HTMLElement).getByText('Padaria Central')).toBeTruthy();
    const portalGets = calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length;

    probe.navigate(agencyClientUrl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    fireEvent.change(within(clientGroup(dialog)).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toContain(`PATCH /agencies/${AGENCY_A}/clients/${CLIENT_ID}`);
    // The edit itself marks the portal's query stale; the portal's refetch on navigation must not be what makes this pass.
    expect(queryClient.getQueryState(portalClientQueryKey(CLIENT_ID))?.isInvalidated).toBe(true);

    probe.navigate(portalUrl('inicio'));
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    const header = (): HTMLElement => container.querySelector('.portal-header') as HTMLElement;
    await waitFor(() => expect(within(header()).getByText('Padaria Renovada')).toBeTruthy());
    expect(within(header()).queryByText('Padaria Central')).toBeNull();
    // The portal read again instead of serving the cached registration.
    expect(calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length).toBeGreaterThan(portalGets);
  });

  it('shows a new photo on the portal without a reload', async () => {
    let registration = portalClient();
    let detail = detailOf(registration);
    const { impl } = makeFetch({
      portal: () => json(registration),
      client: () => json(detail),
      putPhoto: () => {
        registration = { ...registration, photoUrl: 'https://storage.test/nova.png' };
        detail = { ...detail, photoUrl: 'https://storage.test/nova.png' };
        return json({ photoUrl: 'https://storage.test/nova.png' });
      }
    });
    const { probe, container, queryClient } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(container.querySelector('.portal-header img.ui-avatar__photo')).toBeNull();

    probe.navigate(agencyClientUrl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] } });
    await waitFor(() => expect(dialog.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
    expect(queryClient.getQueryState(portalClientQueryKey(CLIENT_ID))?.isInvalidated).toBe(true);

    probe.navigate(portalUrl('inicio'));
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    await waitFor(() => expect(container.querySelector('.portal-header img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
  });
});

describe('the Início: approvals and the script of today (#271)', () => {
  // 01:30Z of the 12th is 22:30 of the 11th in São Paulo: a day computed in UTC is the wrong one.
  const NIGHT = '2026-10-12T01:30:00.000Z';
  const TODAY = '2026-10-11';
  const TOMORROW = '2026-10-12';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NIGHT));
  });
  afterEach(() => { vi.useRealTimers(); });

  const withHome = (home: Partial<PortalClientResponse['home']>) => json(portalClient({ home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0, ...home } }));
  const scriptsApi = () => createPortalScriptsApi(CLIENT_ID, () => new Date());
  const block = (): HTMLElement => screen.getByRole('region', { name: 'Roteiro de hoje' });
  const todayCalls = (api: ReturnType<typeof scriptsApi>): string[] => api.calls.filter((call) => call.startsWith('GET'));

  describe('the contents waiting for approval', () => {
    it.each([
      [3, '3 posts esperando sua aprovação', 'Revisar os 3 posts'],
      [12, '12 posts esperando sua aprovação', 'Revisar os 12 posts'],
      [1, '1 post esperando sua aprovação', 'Revisar o post']
    ])('says %i with the number of the API, in the singular or the plural, and leads to the contents of the portal', async (count, headline, action) => {
      const { impl } = makeFetch({ portal: () => withHome({ contentsAwaitingApproval: count }) });
      const { probe } = renderPortal(impl);
      expect(await screen.findByRole('heading', { level: 2, name: headline })).toBeTruthy();
      const link = screen.getByRole('link', { name: action });
      expect(link.getAttribute('href')).toBe(portalUrl('conteudos'));
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { level: 1, name: 'Conteúdos' })).toBeTruthy();
      expect(probe.pathname).toBe(portalUrl('conteudos'));
    });

    it('is the next action over the answer of the agency and the brand study, and gives way to them when nothing waits', async () => {
      const waiting = makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 2, threadsAnsweredByAgency: 4 }) });
      renderPortal(waiting.impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(screen.queryByText(/A agência respondeu/)).toBeNull();
      expect(screen.queryByText('Conheça o estudo da sua marca')).toBeNull();
      cleanup();

      const none = makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 0, threadsAnsweredByAgency: 4 }) });
      renderPortal(none.impl);
      expect(await screen.findByRole('link', { name: /A agência respondeu 4 sugestões suas/ })).toBeTruthy();
      expect(screen.queryByText(/esperando sua aprovação/)).toBeNull();
      expect(screen.queryByRole('link', { name: /Revisar/ })).toBeNull();
      cleanup();

      renderPortal(makeFetch().impl);
      expect(await screen.findByRole('link', { name: /Conheça o estudo da sua marca/ })).toBeTruthy();
      expect(screen.queryByText(/esperando sua aprovação/)).toBeNull();
      expect(screen.queryByText(/em breve/)).toBeNull();
    });

    it('shows the two nearest covers the API sent, each one a link to its post, with the format and the day', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      const first = contents.seed({ publishOn: TODAY, title: 'Bolo de fubá', format: 'reels', status: 'awaiting_approval' });
      contents.seed({ publishOn: TOMORROW, title: 'Fornada de sábado', format: 'image', status: 'awaiting_approval' });
      contents.seed({ publishOn: TOMORROW, title: 'Terceiro que espera', format: 'image', status: 'awaiting_approval' });
      const { impl } = makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 3 }), contents });
      renderPortal(impl);

      const covers = await screen.findAllByRole('link', { name: /Bolo de fubá|Fornada de sábado/ });
      expect(covers).toHaveLength(2);
      expect(covers[0]!.getAttribute('href')).toBe(portalUrl(`conteudos/${first.id}`));
      expect(screen.queryByText('Terceiro que espera')).toBeNull();
      expect(within(covers[0]!).getByText('Reels')).toBeTruthy();
      expect(within(covers[0]!).getByText('dom, 11/10')).toBeTruthy();
      expect(contents.calls.filter((call) => call.includes('awaiting-approval'))).toEqual([`GET /clients/${CLIENT_ID}/contents/awaiting-approval?pageSize=2`]);
    });

    it('holds the place of the covers with a skeleton nobody reads while they load', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const handle = contents.handle;
      contents.handle = (url, method) => (url.pathname.endsWith('/awaiting-approval') ? held.then(() => handle(url, method) as Response) : handle(url, method));
      const { container } = renderPortal(makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 2 }), contents }).impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(container.querySelector('.portal-covers')?.getAttribute('aria-hidden')).toBe('true');
      release();
      await waitFor(() => expect(container.querySelector('.portal-covers[aria-hidden]')).toBeNull());
    });

    it('keeps the headline and the action when the covers cannot be read, and offers to try again', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.state.failAwaiting = () => contentsError(500, 'INTERNAL_ERROR');
      const { impl } = makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 2 }), contents });
      renderPortal(impl);

      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(within(alert).getByText('Não foi possível carregar os posts.')).toBeTruthy();
      expect(screen.getByRole('heading', { name: '2 posts esperando sua aprovação' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Revisar os 2 posts' })).toBeTruthy();
      contents.state.failAwaiting = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => expect(screen.queryByText('Não foi possível carregar os posts.')).toBeNull());
    });
  });

  describe('the week', () => {
    const WEEK = `GET /clients/${CLIENT_ID}/contents?from=2026-10-05&to=2026-10-11`;
    const weekCalls = (api: ReturnType<typeof createPortalContentsApi>): string[] => api.calls.filter((call) => call.includes('?from='));

    it('asks for Monday to Sunday of the day in São Paulo, and lists what is planned with its state in words and the day', async () => {
      const api = createPortalContentsApi(CLIENT_ID);
      const approved = api.seed({ publishOn: '2026-10-07', title: 'Sonho recheado', status: 'approved' });
      api.seed({ publishOn: '2026-10-09', title: 'Cardápio de outono', status: 'adjusting' });
      api.seed({ publishOn: '2026-10-10', title: 'Na fila', status: 'in_production' });
      api.seed({ publishOn: '2026-10-08', title: 'Esperando você', status: 'awaiting_approval' });
      api.seed({ publishOn: '2026-10-12', title: 'Semana que vem', status: 'approved' });
      renderPortal(makeFetch({ contents: api }).impl);

      const section = (await screen.findByRole('heading', { name: 'Nesta semana' })).closest('section') as HTMLElement;
      const rows = await within(section).findAllByRole('link');
      expect(rows.map((row) => [
        row.querySelector('.portal-row__title')!.textContent,
        row.querySelector('.ui-status-tag')!.textContent,
        row.querySelector('.ui-status-tag')!.className,
        row.querySelector('.portal-meta')!.lastElementChild!.textContent
      ])).toEqual([
        ['Sonho recheado', 'Aprovado', 'ui-status-tag ui-status-tag--ready', 'qua, 07/10'],
        ['Cardápio de outono', 'Em ajuste', 'ui-status-tag ui-status-tag--adjust', 'sex, 09/10'],
        ['Na fila', 'Em produção', 'ui-status-tag ui-status-tag--production', 'sáb, 10/10']
      ]);
      expect(rows[0]!.getAttribute('href')).toBe(portalUrl(`conteudos/${approved.id}`));
      expect(within(section).queryByText('Esperando você')).toBeNull();
      expect(within(section).queryByText('Semana que vem')).toBeNull();
      expect(weekCalls(api)).toEqual([WEEK]);
    });

    it('shows five rows and leads to the rest in Conteúdos', async () => {
      const api = createPortalContentsApi(CLIENT_ID);
      for (let day = 5; day <= 10; day += 1) api.seed({ publishOn: `2026-10-${String(day).padStart(2, '0')}`, title: `Post ${day}`, status: 'approved' });
      renderPortal(makeFetch({ contents: api }).impl);

      const section = (await screen.findByRole('heading', { name: 'Nesta semana' })).closest('section') as HTMLElement;
      await within(section).findByText('Post 5');
      expect(within(section).queryByText('Post 10')).toBeNull();
      expect(within(section).getByRole('link', { name: 'Ver todos os conteúdos' }).getAttribute('href')).toBe(portalUrl('conteudos'));
    });

    it('says what is missing, with the owl and the way to the month, when nothing is planned', async () => {
      const { container } = renderPortal(makeFetch().impl);
      const section = (await screen.findByRole('heading', { name: 'Nesta semana' })).closest('section') as HTMLElement;
      expect(await within(section).findByRole('heading', { level: 3, name: 'Nenhum post planejado para esta semana' })).toBeTruthy();
      expect(within(section).getByRole('link', { name: 'Ver o mês' }).getAttribute('href')).toBe(portalUrl('conteudos'));
      expect(container.querySelectorAll('img.ui-mascot')).toHaveLength(1);
    });

    it('draws a skeleton on the first load and offers to try again when the week cannot be read', async () => {
      const api = createPortalContentsApi(CLIENT_ID);
      let release: () => void = () => undefined;
      api.state.holdPeriod = new Promise<void>((resolve) => { release = resolve; });
      api.state.failPeriod = () => contentsError(500, 'INTERNAL_ERROR');
      const { container } = renderPortal(makeFetch({ contents: api }).impl);
      await screen.findByRole('heading', { name: 'Nesta semana' });
      expect(container.querySelector('.portal-rows__skeleton')?.getAttribute('aria-hidden')).toBe('true');
      release();

      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(within(alert).getByText('Não foi possível carregar a semana.')).toBeTruthy();
      api.state.failPeriod = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('heading', { name: 'Nenhum post planejado para esta semana' })).toBeTruthy();
    });
  });

  describe('the script of today', () => {
    it('asks for the day of São Paulo, both ends the same, and draws no block when nothing was sent for it', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TOMORROW });
      api.seed({ scriptOn: TODAY, status: 'draft', scenes: [{ position: 1, text: 'Rascunho que nunca chega', guidance: null }] });
      const { impl } = makeFetch({ scripts: api });
      renderPortal(impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      await waitFor(() => expect(todayCalls(api)).toEqual([`GET /clients/${CLIENT_ID}/story-scripts?from=${TODAY}&to=${TODAY}`]));
      await waitFor(() => expect(document.querySelector('.portal-today')).toBeNull());
      expect(screen.queryByRole('region', { name: 'Roteiro de hoje' })).toBeNull();
      expect(screen.queryByText('Rascunho que nunca chega')).toBeNull();
      expect(screen.queryByRole('button', { name: /Já gravei/ })).toBeNull();
    });

    it.each([
      ['a minute before midnight in São Paulo', '2026-10-12T02:59:30.000Z', TODAY, 'Cena de domingo', TOMORROW],
      ['at midnight in São Paulo', '2026-10-12T03:00:00.000Z', TOMORROW, 'Cena de segunda', TODAY]
    ])('shows the script of the day it is %s, and never the one of the other side', async (_name, instant, day, text, otherDay) => {
      vi.setSystemTime(new Date(instant));
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Cena de domingo', guidance: null }] });
      api.seed({ scriptOn: TOMORROW, scenes: [{ position: 1, text: 'Cena de segunda', guidance: null }] });
      const { impl } = makeFetch({ scripts: api });
      renderPortal(impl);
      expect(await screen.findByText(text)).toBeTruthy();
      expect(todayCalls(api)).toEqual([`GET /clients/${CLIENT_ID}/story-scripts?from=${day}&to=${day}`]);
      expect(screen.queryByText(otherDay === TODAY ? 'Cena de domingo' : 'Cena de segunda')).toBeNull();
    });

    it('shows the scenes in order, with their guidance, as text and never as markup, and a button to mark it recorded', async () => {
      const api = scriptsApi();
      const hostile = '<img src=x onerror="window.__hacked = 1">‮atrás';
      api.seed({ scriptOn: TODAY, scenes: [
        { position: 1, text: hostile, guidance: '<b>Luz natural</b>' },
        { position: 2, text: 'Segunda cena\ncom quebra de linha', guidance: null },
        { position: 3, text: 'x'.repeat(300), guidance: 'y'.repeat(300) }
      ] });
      const { impl } = makeFetch({ scripts: api });
      const { container } = renderPortal(impl);
      await within(await screen.findByRole('region', { name: 'Roteiro de hoje' })).findByRole('button', { name: 'Já gravei' });

      const scenes = Array.from(block().querySelectorAll('.portal-script__scene'));
      expect(scenes).toHaveLength(3);
      expect(scenes[0]!.querySelector('.portal-script__text')!.textContent).toBe(hostile);
      expect(scenes[0]!.querySelector('.portal-script__guidance')!.textContent).toBe('Orientação: <b>Luz natural</b>');
      expect(scenes[1]!.querySelector('.portal-script__text')!.textContent).toBe('Segunda cena\ncom quebra de linha');
      expect(scenes[1]!.querySelector('.portal-script__guidance')).toBeNull();
      expect(block().querySelector('img, b')).toBeNull();
      expect((window as unknown as { __hacked?: number }).__hacked).toBeUndefined();
      expect(within(block()).getByRole('heading', { name: 'Roteiro de hoje', level: 2 })).toBeTruthy();
      expect(container.textContent).not.toMatch(/thread|status|arquivad|onboarding|persona|rascunho|draft/i);
    });

    it('offers "Já gravei" as a secondary action, so the only filled indigo of the screen is the review', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY });
      renderPortal(makeFetch({ scripts: api, portal: () => withHome({ contentsAwaitingApproval: 2 }) }).impl);
      const button = await screen.findByRole('button', { name: 'Já gravei' });
      expect(button.className).toContain('ui-button--secondary');
      expect(button.className).not.toContain('ui-button--primary');
      expect(document.querySelectorAll('.ui-button--primary')).toHaveLength(1);
    });

    it('marks it recorded with one click on that script, shows who and the day in São Paulo, and no button after', async () => {
      const api = scriptsApi();
      const script = api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Abrir com o forno', guidance: null }] });
      const { impl } = makeFetch({ scripts: api });
      renderPortal(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Já gravei' }));

      await within(block()).findByText('Gravado por Maria em 11/10');
      expect(within(block()).queryByRole('button', { name: /Já gravei/ })).toBeNull();
      expect(api.calls.filter((call) => call.startsWith('POST'))).toEqual([`POST /clients/${CLIENT_ID}/story-scripts/${script.id}/recorded`]);
      expect(api.rows[0]!.status).toBe('recorded');
      expect(screen.getByText('Abrir com o forno')).toBeTruthy();
    });

    it('shows a recorded script without the button, with the person and the day, and with no name when the API has none', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, status: 'recorded', recordedBy: { name: 'Ana' }, recordedAt: NIGHT, scenes: [{ position: 1, text: 'Já gravada', guidance: null }] });
      const { impl } = makeFetch({ scripts: api });
      renderPortal(impl);
      expect(await within(await screen.findByRole('region', { name: 'Roteiro de hoje' })).findByText('Gravado por Ana em 11/10')).toBeTruthy();
      expect(within(block()).queryByRole('button')).toBeNull();
      cleanup();

      const nameless = scriptsApi();
      nameless.seed({ scriptOn: TODAY, status: 'recorded', recordedBy: { name: null }, recordedAt: NIGHT });
      renderPortal(makeFetch({ scripts: nameless }).impl);
      expect(await screen.findByText('Gravado em 11/10')).toBeTruthy();
    });

    it('marks the script that was clicked among two, and leaves the other one to be marked', async () => {
      const api = scriptsApi();
      const first = api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Primeiro roteiro', guidance: null }] });
      const second = api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Segundo roteiro', guidance: null }] });
      const { impl } = makeFetch({ scripts: api });
      renderPortal(impl);
      expect(await within(await screen.findByRole('region', { name: 'Roteiro de hoje' })).findByRole('heading', { name: 'Roteiro 2' })).toBeTruthy();
      expect(within(block()).getByRole('heading', { name: 'Roteiro 1' })).toBeTruthy();

      fireEvent.click(within(block()).getByRole('button', { name: 'Já gravei o roteiro 2' }));
      await within(block()).findByText('Gravado por Maria em 11/10');
      expect(api.calls.filter((call) => call.startsWith('POST'))).toEqual([`POST /clients/${CLIENT_ID}/story-scripts/${second.id}/recorded`]);
      expect(api.rows.map((row) => row.status)).toEqual(['sent', 'recorded']);
      expect(within(block()).getByRole('button', { name: 'Já gravei o roteiro 1' })).toBeTruthy();
      expect(first.status).toBe('sent');
    });

    it('sends once when the button is clicked twice, and holds both buttons while it is on its way', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY });
      api.seed({ scriptOn: TODAY });
      let release!: () => void;
      api.holdWrites(new Promise<void>((resolve) => { release = resolve; }));
      renderPortal(makeFetch({ scripts: api }).impl);
      const first = await within(await screen.findByRole('region', { name: 'Roteiro de hoje' })).findByRole('button', { name: 'Já gravei o roteiro 1' });
      fireEvent.click(first);
      fireEvent.click(first);
      fireEvent.click(within(block()).getByRole('button', { name: 'Já gravei o roteiro 2' }));
      await waitFor(() => expect(api.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1));
      expect((within(block()).getByRole('button', { name: 'Já gravei o roteiro 2' }) as HTMLButtonElement).disabled).toBe(true);
      release();
      await waitFor(() => expect(api.rows[0]!.status).toBe('recorded'));
      expect(api.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    });

    it.each([
      [500, 'INTERNAL_ERROR', 'Não foi possível marcar como gravado. Tente de novo.'],
      [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.'],
      [403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'],
      [404, 'NOT_FOUND', 'Este roteiro não existe mais.']
    ])('keeps the script as it was when the API answers %i %s, says it in its own words, and marks it on the next try', async (status, code, text) => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Cena que fica', guidance: null }] });
      api.failNext(() => scriptError(status, code));
      renderPortal(makeFetch({ scripts: api }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Já gravei' }));

      expect(await within(block()).findByText(text)).toBeTruthy();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
      expect(within(block()).getByText('Cena que fica')).toBeTruthy();
      expect((within(block()).getByRole('button', { name: 'Já gravei' }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();

      fireEvent.click(within(block()).getByRole('button', { name: 'Já gravei' }));
      await within(block()).findByText('Gravado por Maria em 11/10');
      expect(within(block()).queryByText(text)).toBeNull();
    });

    it('treats the 409 of a script that changed meanwhile: says so and shows what is there now', async () => {
      const api = scriptsApi();
      const script = api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Gravada por outra pessoa', guidance: null }] });
      // Another person of the client marked it recorded between the screen reading it and the click.
      api.failNext(() => scriptError(409, 'STORY_SCRIPT_STATE'), () => { script.status = 'recorded'; script.recordedBy = { name: 'Ana' }; script.recordedAt = NIGHT; });
      renderPortal(makeFetch({ scripts: api }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Já gravei' }));

      expect(await within(block()).findByText('Este roteiro mudou e a tela foi atualizada com o que há agora.')).toBeTruthy();
      await within(block()).findByText('Gravado por Ana em 11/10');
      expect(within(block()).queryByRole('button', { name: /Já gravei/ })).toBeNull();
    });

    it('shows a skeleton while it loads, and its own error with "Tentar de novo" without taking the Início away', async () => {
      let release!: () => void;
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Cena do dia', guidance: null }] });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow = { ...api, handle: (url: URL, method: string) => (method === 'GET' ? gate.then(() => api.handle(url, method) as Response) : api.handle(url, method)) } as typeof api;
      const { container } = renderPortal(makeFetch({ scripts: slow }).impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      expect(container.querySelector('.portal-today')?.getAttribute('aria-hidden')).toBe('true');
      expect(screen.queryByRole('region', { name: 'Roteiro de hoje' })).toBeNull();
      release();
      expect(await screen.findByText('Cena do dia')).toBeTruthy();
      expect(container.querySelector('.portal-today[aria-hidden="true"]')).toBeNull();
    });

    it('says it could not load, keeps the rest of the Início, and offers to try again', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Cena do dia', guidance: null }] });
      let failing = true;
      const flaky = { ...api, handle: (url: URL, method: string) => (failing && method === 'GET' ? scriptError(403, 'FORBIDDEN') : api.handle(url, method)) } as typeof api;
      renderPortal(makeFetch({ scripts: flaky }).impl);
      expect(await screen.findByText('Não foi possível carregar o roteiro de hoje.')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
      expect(screen.getByRole('link', { name: /Conheça o estudo da sua marca/ })).toBeTruthy();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByText('Cena do dia')).toBeTruthy();
      expect(screen.queryByText('Não foi possível carregar o roteiro de hoje.')).toBeNull();
    });

    it('never draws a draft, even if the answer carried one: the whole block says it could not load', async () => {
      const api = scriptsApi();
      api.state.leakDrafts = true;
      api.seed({ scriptOn: TODAY, status: 'draft', scenes: [{ position: 1, text: 'Rascunho vazado', guidance: null }] });
      renderPortal(makeFetch({ scripts: api }).impl);
      expect(await screen.findByText('Não foi possível carregar o roteiro de hoje.', undefined, { timeout: 5000 })).toBeTruthy();
      expect(screen.queryByText('Rascunho vazado')).toBeNull();
    });
  });

  describe('on a phone', () => {
    const css = (): string => readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8').replace(/\r\n/g, '\n');
    const rule = (selector: string): string => {
      const text = css();
      const start = text.indexOf(`\n${selector} {`);
      if (start === -1) throw new Error(`${selector} was not found in globals.css.`);
      return text.slice(start, text.indexOf('}', start));
    };

    it('keeps the bottom bar the last piece of the shell with the whole Início drawn, and the content taking the rest', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY });
      const { container } = renderPortal(makeFetch({ scripts: api, portal: () => withHome({ contentsAwaitingApproval: 3 }) }).impl);
      await screen.findByRole('region', { name: 'Roteiro de hoje' });
      const shell = container.querySelector('.portal-shell') as HTMLElement;
      expect(Array.from(shell.children).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'header', 'main', 'nav']);
      expect(shell.lastElementChild).toBe(nav());
      // jsdom has no layout: the rules that keep a short page's bar at the bottom, and a page of 390 px from scrolling sideways, are read from the stylesheet.
      expect(rule('.portal-shell')).toMatch(/min-height:\s*100dvh;/);
      expect(rule('.portal-shell > .portal-content')).toMatch(/flex:\s*1;/);
      expect(rule('.portal-nav')).toMatch(/position:\s*sticky;/);
      expect(rule('.portal-nav')).toMatch(/bottom:\s*0;/);
    });

    it('lets every box of the script shrink and every text wrap, with no fixed width that could push a 390 px screen sideways', async () => {
      expect(rule('.portal-home')).toMatch(/min-width:\s*0;/);
      for (const selector of ['.portal-today', '.portal-script']) expect(rule(selector)).toMatch(/min-width:\s*0;/);
      const text = rule('.portal-script__text,\n.portal-script__guidance,\n.portal-script__recorded');
      expect(text).toMatch(/overflow-wrap:\s*anywhere;/);
      expect(text).toMatch(/white-space:\s*pre-line;/);
      expect(rule('.portal-script > .ui-button')).toMatch(/width:\s*100%;/);
      expect(rule('.portal-today__skeleton')).toMatch(/width:\s*100%;/);
      for (const selector of ['.portal-today', '.portal-script', '.portal-script__scenes']) expect(rule(selector)).not.toMatch(/(^|[^-])(width|min-width):\s*[\d.]+(px|rem)/);
    });
  });
});

describe('portal.tsx source (#689)', () => {
  it('writes the accent-stripping range as escapes, never as invisible combining characters', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/portal.tsx'), 'utf8');
    const escape = String.fromCharCode(92);
    expect(source).toContain(`[${escape}u0300-${escape}u036f]`);
    expect(source).not.toMatch(/[\u0300-\u036f]/);
  });
});
