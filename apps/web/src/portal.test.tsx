// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortalClientResponse } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { portalClientQueryKey } from './portal.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { todayInSaoPaulo } from './content-dates.js';
import { createPortalContentsApi } from './portal-contents-fixture.js';
import { createPortalScriptsApi, portalStudyBody } from './portal-fixture.js';
import { createPortalMaterialRequestsApi } from './portal-material-requests-fixture.js';
import { portalMaterialRequestsKey } from './portal-material-requests.js';
import { gateReads } from './portal-retry-fixture.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { readGlobalCss } from './styles/read-css';

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
  required: false,
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
  ...clientRegistrationExtras,
  agencyName: 'Agência Um',
  onboardingSeenAt: '2026-10-01T12:00:00.000Z', agencyReadOnly: false,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0, materialRequestsOpen: 0 },
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
  /** The requests for material of the portal; none by default, as a client the agency asked nothing of. */
  readonly materialRequests?: ReturnType<typeof createPortalMaterialRequestsApi>;
  /** The requests of the other client the same person belongs to; none by default. */
  readonly otherMaterialRequests?: ReturnType<typeof createPortalMaterialRequestsApi>;
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
    if (/^\/clients\/[^/]+\/material-requests$/.test(path) && !path.includes(CLIENT_ID)) {
      const other = path.includes(OTHER_CLIENT_ID) ? scenario.otherMaterialRequests?.handle(url, method) : undefined;
      if (other !== undefined) return other;
      return json({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } });
    }
    const materialBody = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const material = (scenario.materialRequests ?? createPortalMaterialRequestsApi(CLIENT_ID)).handle(url, method, materialBody);
    if (material !== undefined) return material;
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
    expect(within(nav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Início', 'Conteúdos', 'Marca', 'Pedidos da agênciaPedidos']);
    expect(within(nav()).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBe('page');

    clickTab('Conteúdos');
    expect(await screen.findByRole('heading', { level: 1, name: 'Conteúdos' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('conteudos'));
    expect(within(nav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('aria-current')).toBe('page');

    clickTab('Marca');
    expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('marca'));

    clickTab('Início');
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(screen.queryByRole('heading', { name: 'Página não encontrada' })).toBeNull();
  });

  it('sends the old Relatórios address to the Início: the portal has no such area', async () => {
    const { probe } = renderPortal(makeFetch().impl, portalUrl('relatorios'));
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(within(nav()).queryByRole('link', { name: 'Relatórios' })).toBeNull();
  });

  it('shows "Com a agência" above the client in the header, the role at the foot, and the client inside the account menu', async () => {
    const { impl } = makeFetch();
    const { container, probe } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    const header = container.querySelector('.portal-header') as HTMLElement;
    const identity = within(header).getByRole('link', { name: /Com a Agência Um.*Padaria Central/ });
    expect(within(identity).getByText('Com a Agência Um').nextElementSibling?.textContent).toBe('Padaria Central');
    expect(within(header).queryByText('por Agência Um')).toBeNull();
    expect(identity.getAttribute('href')).toBe('/contextos');

    const person = within(header).getByRole('button', { name: /Maria/ });
    expect(within(person).getByText('Aprova os posts')).toBeTruthy();
    fireEvent.click(person);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Contexto ativo')).toBeTruthy();
    expect(within(menu).getByText('Padaria Central')).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });

    fireEvent.click(identity);
    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
  });

  it('opens Ajuda with the tour and the status of the system, each doing its own thing', async () => {
    const { probe } = renderPortal(makeFetch().impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    fireEvent.click(screen.getByRole('button', { name: 'Ajuda' }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Ajuda' })).getByRole('menuitem', { name: 'Rever o tour' }));
    await waitFor(() => expect(document.querySelector('.portal-tour')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Ajuda' }));
    expect(within(await screen.findByRole('menu', { name: 'Ajuda' })).queryByRole('menuitem', { name: 'Rever o tour' })).toBeNull();
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Ajuda' })).getByRole('menuitem', { name: 'Status do serviço' }));
    await waitFor(() => expect(probe.pathname).toBe('/status'));
  });

  it('says the portal is read-only when the trial of the agency ended, and nothing otherwise (issue #714)', async () => {
    renderPortal(makeFetch({ portal: () => json(portalClient({ agencyReadOnly: true })) }).impl);
    const notice = await screen.findByRole('region', { name: 'Portal somente leitura' });
    expect(notice.textContent).toBe('A aprovação está pausada no momento. A equipe de Agência Um já foi avisada. Tudo continua visível.');
    // The client is never told about the agency's billing (decision 2026-11-06).
    expect(notice.textContent).not.toMatch(/plano|renov|assin|cobran|pag/i);
    cleanup();

    renderPortal(makeFetch({ portal: () => json(portalClient()) }).impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(screen.queryByRole('region', { name: 'Portal somente leitura' })).toBeNull();
  });

  it('keeps the focused control clear of the sticky bar: room below it on a phone, under the tabs on a wide screen', () => {
    const css = readGlobalCss().replace(/\r\n/g, '\n');
    const phone = css.slice(css.indexOf('\nhtml:has(.portal-shell) {'));
    expect(phone.slice(0, phone.indexOf('}'))).toMatch(/scroll-padding-bottom:\s*calc\(5\.5rem \+ env\(safe-area-inset-bottom\)\);/);
    const wide = css.slice(css.indexOf('@media (min-width: 48rem) {\n  html:has(.portal-shell) {'));
    expect(wide.slice(0, wide.indexOf('}'))).toMatch(/scroll-padding-top:\s*5rem;/);
  });

  it('sets the tab title of each of the three areas', async () => {
    const { impl } = makeFetch();
    renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(document.title).toBe('Início — Portal do cliente — Ageniza');

    for (const label of ['Conteúdos', 'Marca']) {
      clickTab(label);
      await screen.findByRole('heading', { name: label === 'Marca' ? 'Sua marca' : label });
      expect(document.title).toBe(`${label} — Portal do cliente — Ageniza`);
    }

    clickTab('Início');
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(document.title).toBe('Início — Portal do cliente — Ageniza');
  });

  it('keeps the bar in the navigation piece of a screen-tall column shell, with the content taking the rest', async () => {
    const { impl } = makeFetch();
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    // Structure: the navigation piece (header and bar) and the content; on a phone the piece is `display: contents`, so the bar is a flex item of the shell.
    const shell = container.querySelector('.portal-shell') as HTMLElement;
    expect(shell.classList.contains('app-shell')).toBe(true);
    expect(Array.from(shell.children).filter((child) => !child.classList.contains('shell-topbar')).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'div', 'main']);
    const sidebar = shell.querySelector('.portal-sidebar') as HTMLElement;
    expect(Array.from(sidebar.children).map((child) => child.tagName.toLowerCase())).toEqual(['header', 'nav']);
    expect(sidebar.lastElementChild).toBe(nav());

    // jsdom has no layout, so the rules that put the bar at the bottom of a short page are read from
    // the stylesheet; the real 360x780 capture is in the PR (review of #401, finding 1).
    const css = readGlobalCss();
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
    const { impl } = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 2, brandStudyFilled: 5, contentsAwaitingApproval: 0, materialRequestsOpen: 0 } })) });
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
    expect(screen.queryByRole('button', { name: 'Sair' })).toBeNull();
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

describe('Pedidos da agência in the portal', () => {
  // 01:30Z of the 12th is 22:30 of the 11th in São Paulo: a day computed in UTC is the wrong one.
  const NIGHT = '2026-10-12T01:30:00.000Z';
  const TODAY = '2026-10-11';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NIGHT));
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('Pedidos da agência: the page and the badge of the navigation (decision 2026-11-11)', () => {
    const materialApi = () => createPortalMaterialRequestsApi(CLIENT_ID);
    const REQUESTS = `GET /clients/${CLIENT_ID}/material-requests`;
    const requestsLink = (): HTMLElement => within(nav()).getByRole('link', { name: /^Pedidos da agência/ });
    const badgeOf = (): HTMLElement | null => requestsLink().querySelector('.portal-nav__badge');
    const serverError = (): Response => json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500);
    const itemOf = (title: string): HTMLElement => screen.getByRole('heading', { level: 2, name: title }).closest('li') as HTMLElement;

    it('adds the item to the navigation, with no badge when nothing is open, and opens the page on a click', async () => {
      const { impl } = makeFetch();
      const { probe } = renderPortal(impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });

      expect(within(nav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Início', 'Conteúdos', 'Marca', 'Pedidos da agênciaPedidos']);
      await waitFor(() => expect(requestsLink()).toBeTruthy());
      expect(requestsLink().getAttribute('href')).toBe(portalUrl('pedidos'));
      expect(badgeOf()).toBeNull();
      expect(requestsLink().textContent).not.toMatch(/\d/);

      clickTab('Pedidos da agência');
      expect(await screen.findByRole('heading', { level: 1, name: 'Pedidos da agência' })).toBeTruthy();
      expect(screen.getByText('Material que falta para os próximos posts.')).toBeTruthy();
      expect(probe.pathname).toBe(portalUrl('pedidos'));
      expect(requestsLink().getAttribute('aria-current')).toBe('page');
      expect(within(nav()).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBeNull();
    });

    it('counts the open requests in the badge, as the API counts them (resolved ones are not), and names it for assistive technology', async () => {
      const api = materialApi();
      api.seed({ body: 'Um', dueOn: '2026-10-20' });
      api.seed({ body: 'Dois', dueOn: '2026-10-21' });
      api.seed({ body: 'Três', dueOn: '2026-10-22' });
      api.seed({ body: 'Resolvido', state: 'resolved' });
      renderPortal(makeFetch({ materialRequests: api }).impl);

      await waitFor(() => expect(badgeOf()?.textContent).toBe('3'));
      expect(badgeOf()?.getAttribute('aria-label')).toBe('3 pedidos abertos');
      expect(within(nav()).getByRole('link', { name: 'Pedidos da agência 3 pedidos abertos' })).toBeTruthy();
    });

    it('writes the badge in the singular for one request, and drops it when the agency resolves the last one', async () => {
      const api = materialApi();
      const only = api.seed({ body: 'Só este' });
      const { queryClient } = renderPortal(makeFetch({ materialRequests: api }).impl);

      await waitFor(() => expect(badgeOf()?.getAttribute('aria-label')).toBe('1 pedido aberto'));
      api.resolve(only.threadId);
      await act(async () => { await queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(CLIENT_ID) }); });
      await waitFor(() => expect(badgeOf()).toBeNull());
    });

    it('shows no badge when the count could not be read, and never a zero', async () => {
      const api = materialApi();
      api.seed({ body: 'Um' });
      api.state.failList = serverError;
      renderPortal(makeFetch({ materialRequests: api }).impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      await waitFor(() => expect(api.calls).toContain(REQUESTS));
      expect(badgeOf()).toBeNull();
    });

    it('lists the open requests with title, text, who asked and the deadline day, and flags only the late one in São Paulo days', async () => {
      const api = materialApi();
      api.seed({ title: 'Fotos da equipe', body: 'Envie 3 fotos da equipe no balcão', dueOn: '2026-10-10' });
      api.seed({ title: 'Logotipo', body: 'Mande o logotipo em PNG', dueOn: TODAY });
      api.seed({ title: null, body: 'Pedido antigo sem título', dueOn: '2026-10-25' });
      api.seed({ title: 'Sem prazo', body: 'Quando puder' });
      api.seed({ title: 'Já resolvido', body: 'Resolvido', state: 'resolved' });
      renderPortal(makeFetch({ materialRequests: api }).impl, portalUrl('pedidos'));

      await screen.findByRole('heading', { level: 2, name: 'Fotos da equipe' });
      expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Fotos da equipe', 'Logotipo', 'Pedido de material', 'Sem prazo']);
      expect(screen.getByText('4 pedidos')).toBeTruthy();
      expect(screen.queryByText('Já resolvido')).toBeNull();

      const first = itemOf('Fotos da equipe');
      expect(within(first).getByText('Envie 3 fotos da equipe no balcão')).toBeTruthy();
      expect(within(first).getByText('Pedido de Agência Um')).toBeTruthy();
      expect(within(first).getByText('até 10 de outubro')).toBeTruthy();
      expect(within(first).getByText('Atrasado')).toBeTruthy();
      // The 01:30Z night is still the 11th in São Paulo: a deadline of the 11th is not late, and the one of the 10th is.
      expect(within(itemOf('Logotipo')).getByText('até 11 de outubro')).toBeTruthy();
      expect(within(itemOf('Logotipo')).queryByText('Atrasado')).toBeNull();
      expect(within(itemOf('Pedido de material')).getByText('Pedido antigo sem título')).toBeTruthy();
      expect(within(itemOf('Pedido de material')).getByText('até 25 de outubro')).toBeTruthy();
      expect(within(itemOf('Sem prazo')).queryByText(/^até /)).toBeNull();
      expect(document.querySelectorAll('.portal-requests-page .ui-late-badge')).toHaveLength(1);
    });

    it('answers on the right request when there are two, from the page, naming each button by its title', async () => {
      const api = materialApi();
      const first = api.seed({ title: 'Fotos da equipe', body: 'Envie 3 fotos', dueOn: '2026-10-20' });
      const second = api.seed({ title: 'Logotipo', body: 'Mande o logotipo', dueOn: '2026-10-25' });
      renderPortal(makeFetch({ materialRequests: api }).impl, portalUrl('pedidos'));
      await screen.findByRole('heading', { level: 2, name: 'Logotipo' });

      expect(screen.getAllByRole('button', { name: /^Responder/ }).map((button) => button.textContent)).toEqual(['Responder', 'Responder']);
      fireEvent.click(screen.getByRole('button', { name: 'Responder Logotipo' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(await within(dialog).findByText('Mande o logotipo')).toBeTruthy();
      expect(within(dialog).queryByText('Envie 3 fotos')).toBeNull();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Segue o logotipo' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
      await waitFor(() => expect(api.posted).toEqual([{ threadId: second.threadId, body: 'Segue o logotipo' }]));
      expect(api.rows.find((row) => row.threadId === first.threadId)!.comments).toHaveLength(1);
      // The request stays on the page after the answer: only the agency resolves.
      expect(screen.getByRole('heading', { level: 2, name: 'Logotipo' })).toBeTruthy();
    });

    it('says there is nothing open, as good news, when the read answered with no request', async () => {
      const api = materialApi();
      api.seed({ title: 'Já resolvido', body: 'Resolvido', state: 'resolved' });
      renderPortal(makeFetch({ materialRequests: api }).impl, portalUrl('pedidos'));

      expect(await screen.findByText('Nenhum pedido aberto')).toBeTruthy();
      expect(screen.getByText('A Agência Um não está esperando nenhum material seu.')).toBeTruthy();
      expect(screen.queryByText(/pedidos?$/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Responder/ })).toBeNull();
    });

    it('shows a loading shape on the first read, with no good news and no failure yet', async () => {
      const held = gateReads(makeFetch({ materialRequests: materialApi() }).impl, (url) => url.pathname === `/clients/${CLIENT_ID}/material-requests`);
      let release: () => void = () => undefined;
      held.gate.hold = new Promise<void>((resolve) => { release = resolve; });
      renderPortal(held.impl, portalUrl('pedidos'));
      await screen.findByRole('heading', { level: 1, name: 'Pedidos da agência' });

      expect(document.querySelector('.portal-requests-page__skeleton')?.getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByText('Nenhum pedido aberto')).toBeNull();
      expect(screen.queryByText('Não foi possível carregar os pedidos da agência.')).toBeNull();
      release();
      expect(await screen.findByText('Nenhum pedido aberto')).toBeTruthy();
      expect(document.querySelector('.portal-requests-page__skeleton')).toBeNull();
    });

    it('shows the failure with Tentar de novo that reads again, and never the empty state or the server words', async () => {
      const api = materialApi();
      api.seed({ title: 'Logotipo', body: 'Mande o logotipo' });
      api.state.failList = serverError;
      renderPortal(makeFetch({ materialRequests: api }).impl, portalUrl('pedidos'));

      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(alert.textContent).toContain('Não foi possível carregar os pedidos da agência.');
      expect(screen.queryByText('Nenhum pedido aberto')).toBeNull();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
      api.state.failList = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('heading', { level: 2, name: 'Logotipo' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('reads the client of the address only: the requests of the other client the person belongs to never show', async () => {
      const own = materialApi();
      own.seed({ title: 'Do Padaria', body: 'Pedido deste cliente' });
      const other = createPortalMaterialRequestsApi(OTHER_CLIENT_ID);
      other.seed({ title: 'Do outro', body: 'Pedido de outro cliente' });
      const { impl, calls } = makeFetch({ materialRequests: own, otherMaterialRequests: other });
      renderPortal(impl, portalUrl('pedidos'));

      expect(await screen.findByRole('heading', { level: 2, name: 'Do Padaria' })).toBeTruthy();
      expect(screen.queryByText('Do outro')).toBeNull();
      expect(calls.filter((call) => call.includes('material-requests'))).toEqual([REQUESTS]);
      cleanup();

      const second = makeFetch({ materialRequests: own, otherMaterialRequests: other });
      renderPortal(second.impl, portalUrl('pedidos', OTHER_CLIENT_ID));
      expect(await screen.findByRole('heading', { level: 2, name: 'Do outro' })).toBeTruthy();
      expect(screen.queryByText('Do Padaria')).toBeNull();
      expect(second.calls.filter((call) => call.includes('material-requests'))).toEqual([`GET /clients/${OTHER_CLIENT_ID}/material-requests`]);
    });

    it('has no Relatórios in the navigation', async () => {
      renderPortal(makeFetch().impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      expect(within(nav()).queryByRole('link', { name: /Relatórios/ })).toBeNull();
    });
  });
});
