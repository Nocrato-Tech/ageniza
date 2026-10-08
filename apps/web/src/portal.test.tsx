// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PortalClientResponse } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { portalClientQueryKey } from './portal.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

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
  role: { key: 'admin', name: 'Admin' },
  permissions: ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar']
};
const contextsBody = {
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
  onboardingSeenAt: null,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5 },
  ...overrides
});

const detailOf = (registration: Record<string, unknown>): Record<string, unknown> => ({
  ...registrationOf(registration),
  summary: { brandStudyFilled: 5, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 1 }
});

function registrationOf(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'summary' && key !== 'agencyName' && key !== 'onboardingSeenAt' && key !== 'home'));
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
    if (path === `/clients/${CLIENT_ID}`) return scenario.portal?.() ?? json(portalClient());
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
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  probe.navigate = useNavigate();
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

const nav = () => screen.getByRole('navigation', { name: 'Navegação do portal' });
const clickTab = (label: string): void => { fireEvent.click(within(nav()).getByRole('link', { name: label })); };

describe('client portal shell (#141)', () => {
  it('redirects the bare portal address to Início and keeps every route under /portal/:clienteId, in Portuguese', async () => {
    const { impl } = makeFetch();
    const { probe } = renderPortal(impl, `/portal/${CLIENT_ID}`);
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(within(nav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Início', 'Calendário', 'Marca', 'Relatórios']);
    expect(within(nav()).getByRole('link', { name: 'Início' }).getAttribute('aria-current')).toBe('page');

    clickTab('Calendário');
    expect(await screen.findByRole('heading', { name: 'Calendário' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('calendario'));
    expect(within(nav()).getByRole('link', { name: 'Calendário' }).getAttribute('aria-current')).toBe('page');

    clickTab('Relatórios');
    expect(await screen.findByRole('heading', { name: 'Relatórios' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('relatorios'));

    clickTab('Marca');
    expect(await screen.findByRole('heading', { name: 'Marca' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('marca'));

    clickTab('Início');
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('inicio'));
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
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

  it('offers one next action, which changes with the agency answers and leads to the brand study', async () => {
    const none = makeFetch({ portal: () => json(portalClient()) });
    const first = renderPortal(none.impl);
    expect(await screen.findByText('Conheça o estudo da sua marca')).toBeTruthy();
    expect(screen.queryByText(/A agência respondeu/)).toBeNull();
    expect(within(screen.getByRole('link', { name: /Conheça o estudo da sua marca/ })).getByText('ver')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Conheça o estudo da sua marca/ }));
    expect(await screen.findByRole('heading', { name: 'Marca' })).toBeTruthy();
    expect(first.probe.pathname).toBe(portalUrl('marca'));
    cleanup();

    const many = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 2, brandStudyFilled: 5 } })) });
    renderPortal(many.impl);
    const action = await screen.findByRole('link', { name: /A agência respondeu 2 sugestões suas/ });
    expect(action.getAttribute('href')).toBe(portalUrl('marca'));
    cleanup();

    const one = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 1, brandStudyFilled: 5 } })) });
    renderPortal(one.impl);
    expect(await screen.findByText('A agência respondeu 1 sugestão sua')).toBeTruthy();
    expect(screen.queryByText('A agência respondeu 2 sugestões suas')).toBeNull();
  });

  it('reserves the content-to-approve space, as text and nothing to click', async () => {
    const { impl } = makeFetch();
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    const reserved = container.querySelector('.portal-home__reserved') as HTMLElement;
    expect(reserved.textContent).toBe('conteúdos para aprovar (em breve)');
    expect(reserved.querySelector('a')).toBeNull();
    expect(reserved.querySelector('button')).toBeNull();
  });

  it.each([
    ['Calendário', 'Aqui você vai ver os posts planejados para sua marca e aprovar cada um.'],
    ['Marca', 'Aqui você vai ver o estudo da sua marca e conversar com a agência sobre ele.'],
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

  it('sets the tab title of each of the four areas', async () => {
    const { impl } = makeFetch();
    renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(document.title).toBe('Início — Portal do cliente — Ageniza');

    for (const label of ['Calendário', 'Marca', 'Relatórios']) {
      clickTab(label);
      await screen.findByRole('heading', { name: label });
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
    const { impl } = makeFetch({ portal: () => json(portalClient({ home: { threadsAnsweredByAgency: 2, brandStudyFilled: 5 } })) });
    const { container } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    clickTab('Calendário');
    await screen.findByRole('heading', { name: 'Calendário' });

    expect(container.textContent).not.toMatch(/thread|status|arquivad|onboarding|persona/i);
  });

  it('turns the next navigation into the ordinary not-found when the link is gone', async () => {
    let active = true;
    const { impl, calls } = makeFetch({ portal: () => (active ? json(portalClient()) : notFound()) });
    const { probe } = renderPortal(impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    expect(calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length).toBe(1);

    active = false;
    clickTab('Calendário');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(probe.pathname).toBe(portalUrl('calendario'));
    // The same not-found as any unknown address: never a message confirming the portal existed.
    expect(screen.queryByText(/acesso/i)).toBeNull();
  });

  it('answers the ordinary not-found for a 404, for a malformed id and for another client answer', async () => {
    const gone = makeFetch({ portal: () => notFound() });
    renderPortal(gone.impl);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    cleanup();

    const malformed = makeFetch();
    renderPortal(malformed.impl, '/portal/nao-e-uuid/inicio');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(malformed.calls.some((call) => call.startsWith('GET /clients/'))).toBe(false);
    cleanup();

    // Defense in depth: an answer for another client is not shown as if it were this portal's.
    const wrong = makeFetch({ portal: () => json(portalClient({ id: OTHER_CLIENT_ID, name: 'Outro Cliente' })) });
    renderPortal(wrong.impl);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByText('Outro Cliente')).toBeNull();
  });

  it('does not render the portal without a session: no request for the client, the unavailable page instead', async () => {
    const { impl, calls } = makeFetch({ anonymous: true });
    renderPortal(impl);

    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Olá/ })).toBeNull();
    expect(calls.some((call) => call.startsWith('GET /clients/'))).toBe(false);
  });

  it('answers the not-found inside the portal shell for an unknown portal address', async () => {
    const { impl } = makeFetch();
    const { probe, container } = renderPortal(impl, portalUrl('qualquer-coisa'));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
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
    ['the client is not found', () => notFound(), 'Page not found'],
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
