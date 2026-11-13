// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortalClientResponse, PortalContentProgressResponse } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
import { ApiClientProvider, HttpClient, HttpClientError } from './http.js';
import { recordRefusal } from './portal-story-scripts.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { contentsError, createPortalContentsApi } from './portal-contents-fixture.js';
import { createPortalScriptsApi, portalStudyBody, scriptError } from './portal-fixture.js';
import { createPortalMaterialRequestsApi } from './portal-material-requests-fixture.js';
import { portalMaterialRequestsKey } from './portal-material-requests.js';
import { gateReads, retryWhileHeld, serverFailure } from './portal-retry-fixture.js';
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

const progressOf = (data: Partial<PortalContentProgressResponse['data']> = {}): PortalContentProgressResponse => ({
  data: { month: '2026-10', approved: 0, total: 0, next: null, ...data }
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

interface Scenario {
  /** No session: like the real API, every endpoint answers 401 (the portal is never reachable). */
  readonly anonymous?: boolean;
  /** The name of the account that is signed in; "Maria" by default. */
  readonly userName?: string;
  /** The progress of the month for the good news; a month with nothing in it by default. */
  readonly progress?: () => Response | Promise<Response>;
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
    if (path.endsWith('/auth/session')) return json(scenario.userName === undefined ? sessionBody : { ...sessionBody, user: { ...sessionBody.user, name: scenario.userName } });
    if (path === `/clients/${CLIENT_ID}/contents/progress`) return scenario.progress?.() ?? json(progressOf());
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

describe('the Início of the portal (#271, decision 2026-11-11)', () => {
  // 01:30Z of the 12th is 22:30 of the 11th in São Paulo: a day computed in UTC is the wrong one.
  const NIGHT = '2026-10-12T01:30:00.000Z';
  const TODAY = '2026-10-11';
  const TOMORROW = '2026-10-12';
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NIGHT));
  });
  afterEach(() => { vi.useRealTimers(); });

  const withHome = (home: Partial<PortalClientResponse['home']>) => json(portalClient({ home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0, materialRequestsOpen: 0, ...home } }));
  const scriptsApi = () => createPortalScriptsApi(CLIENT_ID, () => new Date());
  const block = (): HTMLElement => screen.getByRole('region', { name: 'Roteiro de hoje' });
  const todayCalls = (api: ReturnType<typeof scriptsApi>): string[] => api.calls.filter((call) => call.startsWith('GET'));

  const waiting = (count: number, extra: Partial<PortalClientResponse['home']> = {}) => withHome({ contentsAwaitingApproval: count, ...extra });
  const postOf = (row: { id: string }): string => portalUrl(`conteudos/${row.id}`);

  /** The API gives the deadline at noon of São Paulo; a test that needs another instant rewrites the awaiting answer. */
  const withDueAt = (api: ReturnType<typeof createPortalContentsApi>, dueAt: string): void => {
    const handle = api.handle;
    api.handle = (url, method) => {
      const answer = handle(url, method);
      if (!url.pathname.endsWith('/awaiting-approval') || answer === undefined) return answer;
      return Promise.resolve(answer).then(async (response) => {
        const body = await response.json() as { data: Array<{ approval: { dueAt: string } | null }> };
        for (const row of body.data) if (row.approval !== null) row.approval.dueAt = dueAt;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      });
    };
  };

  describe('the head: the date, the greeting and what the agency waits for', () => {
    it('says the day of São Paulo (01:30Z of the 12th is still Sunday the 11th), "Olá" with the first name and what the agency waits for', async () => {
      renderPortal(makeFetch({ userName: 'Rosana Teixeira', portal: () => waiting(2, { materialRequestsOpen: 1 }) }).impl);
      expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Rosana' })).toBeTruthy();
      expect(screen.getByText('Domingo, 11 de outubro')).toBeTruthy();
      expect(screen.getByText('A Agência Um espera 3 respostas suas. Cada uma leva menos de um minuto.')).toBeTruthy();
    });

    it('greets by the name of the account that is in, whatever the name', async () => {
      renderPortal(makeFetch({ userName: 'Maria' }).impl);
      expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Maria' })).toBeTruthy();
      cleanup();
      renderPortal(makeFetch({ userName: 'Débora Souza Lima' }).impl);
      expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Débora' })).toBeTruthy();
    });

    it('words one thing in the singular, and says nothing of waiting when nothing waits', async () => {
      renderPortal(makeFetch({ portal: () => waiting(1) }).impl);
      expect(await screen.findByText('A Agência Um espera 1 resposta sua. Leva menos de um minuto.')).toBeTruthy();
      cleanup();
      renderPortal(makeFetch().impl);
      await screen.findByRole('heading', { level: 1, name: 'Olá, Maria' });
      expect(screen.queryByText(/espera/)).toBeNull();
    });

    it('has no "Nesta semana" and does not read the week, whatever is planned in it', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.seed({ publishOn: '2026-10-13', title: 'Sonho recheado', status: 'approved' });
      const { impl } = makeFetch({ contents });
      renderPortal(impl);
      await screen.findByRole('heading', { level: 1, name: 'Olá, Maria' });
      await screen.findByRole('heading', { name: 'Nada para aprovar' });
      expect(screen.queryByText('Nesta semana')).toBeNull();
      expect(screen.queryByText('Sonho recheado')).toBeNull();
      expect(contents.calls.filter((call) => call.includes('?from='))).toEqual([]);
    });
  });

  describe('the contents waiting for approval', () => {
    it.each([
      [3, '3 posts esperando sua aprovação', 'Revisar os 3 posts'],
      [12, '12 posts esperando sua aprovação', 'Revisar os 12 posts'],
      [1, '1 post esperando sua aprovação', 'Revisar o post']
    ])('says %i with the number of the API, in the singular or the plural, and the review starts at the post that expires first', async (count, headline, action) => {
      const contents = createPortalContentsApi(CLIENT_ID);
      const first = contents.seed({ publishOn: TOMORROW, title: 'Vence primeiro', status: 'awaiting_approval' });
      contents.seed({ publishOn: '2026-10-20', title: 'Vence depois', status: 'awaiting_approval' });
      const { impl } = makeFetch({ portal: () => waiting(count), contents });
      const { probe } = renderPortal(impl);
      expect(await screen.findByRole('heading', { level: 2, name: headline })).toBeTruthy();
      expect(screen.getByText('Toque em um post para ver como vai ficar no Instagram. Aprovando, a agência é avisada e cuida da publicação.')).toBeTruthy();
      await screen.findByRole('link', { name: /Vence primeiro/ });
      const link = screen.getByRole('link', { name: action });
      expect(link.getAttribute('href')).toBe(postOf(first));
      fireEvent.click(link);
      await waitFor(() => expect(probe.pathname).toBe(postOf(first)));
    });

    it('says "Começamos pelo que vence primeiro." beside the review of several posts, and not beside the one post', async () => {
      renderPortal(makeFetch({ portal: () => waiting(3) }).impl);
      expect(await screen.findByText('Começamos pelo que vence primeiro.')).toBeTruthy();
      cleanup();
      renderPortal(makeFetch({ portal: () => waiting(1) }).impl);
      await screen.findByRole('link', { name: 'Revisar o post' });
      expect(screen.queryByText('Começamos pelo que vence primeiro.')).toBeNull();
    });

    it('has one filled indigo in the block: the cards are links and nothing else is primary', async () => {
      renderPortal(makeFetch({ portal: () => waiting(2) }).impl);
      await screen.findByRole('link', { name: 'Revisar os 2 posts' });
      expect(document.querySelectorAll('.ui-button--primary')).toHaveLength(1);
    });

    it('shows the three nearest covers the API sent, each one a link to its own post, with its title, "Aguardando você" and until when', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      const first = contents.seed({ publishOn: TOMORROW, title: 'Bolo de fubá', format: 'reels', status: 'awaiting_approval', approval: { dueOn: '2026-10-15', note: 'Confira a legenda.' } });
      const second = contents.seed({ publishOn: '2026-10-14', title: 'Fornada de sábado', format: 'image', status: 'awaiting_approval', approval: { dueOn: '2026-10-16', note: null } });
      contents.seed({ publishOn: '2026-10-15', title: 'Terceiro post', format: 'image', status: 'awaiting_approval', approval: null });
      contents.seed({ publishOn: '2026-10-16', title: 'Quarto que espera', format: 'image', status: 'awaiting_approval' });
      const { impl } = makeFetch({ portal: () => waiting(4), contents });
      const { probe } = renderPortal(impl);

      const covers = await screen.findAllByRole('link', { name: /Bolo de fubá|Fornada de sábado|Terceiro post/ });
      expect(covers).toHaveLength(3);
      expect(screen.queryByText('Quarto que espera')).toBeNull();
      expect(covers[0]!.getAttribute('href')).toBe(postOf(first));
      expect(within(covers[0]!).getByText('Bolo de fubá')).toBeTruthy();
      expect(within(covers[0]!).getByText('Aguardando você')).toBeTruthy();
      expect(within(covers[0]!).getByText('Responda até quinta, 15 out, 12h')).toBeTruthy();
      expect(within(covers[1]!).getByText('Responda até sexta, 16 out, 12h')).toBeTruthy();
      expect(within(covers[2]!).queryByText(/Responda até/)).toBeNull();
      expect(screen.queryByText('Confira a legenda.')).toBeNull();
      expect(contents.calls.filter((call) => call.includes('awaiting-approval'))).toEqual([`GET /clients/${CLIENT_ID}/contents/awaiting-approval?pageSize=3`]);

      // The click acts on the card clicked, not on the first one.
      fireEvent.click(covers[1]!);
      await waitFor(() => expect(probe.pathname).toBe(postOf(second)));
    });

    it('counts the deadline in the day and the hour of São Paulo: 01:30Z of the 16th is 22h30 of the 15th', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.seed({ publishOn: '2026-10-20', title: 'Bolo de fubá', status: 'awaiting_approval', approval: { dueOn: '2026-10-16', note: null } });
      withDueAt(contents, '2026-10-16T01:30:00.000Z');
      renderPortal(makeFetch({ portal: () => waiting(1), contents }).impl);
      expect(await screen.findByText('Responda até quinta, 15 out, 22h30')).toBeTruthy();
    });

    it('says "Atrasado" when the publication day passed, with its own line, and not "Aguardando você"; a deadline that passed says "Venceu"', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.seed({ publishOn: '2026-10-09', title: 'Já devia ter saído', status: 'awaiting_approval', approval: { dueOn: '2026-10-15', note: null } });
      contents.seed({ publishOn: TODAY, title: 'Sai hoje', status: 'awaiting_approval', approval: { dueOn: '2026-10-10', note: null } });
      renderPortal(makeFetch({ portal: () => waiting(2), contents }).impl);

      const late = await screen.findByRole('link', { name: /Já devia ter saído/ });
      expect(within(late).getByText('Atrasado').className).toContain('ui-late-badge');
      expect(within(late).getByText('A data de publicação já passou')).toBeTruthy();
      expect(within(late).queryByText('Aguardando você')).toBeNull();
      expect(within(late).queryByText(/Responda até/)).toBeNull();
      const today = screen.getByRole('link', { name: /Sai hoje/ });
      expect(within(today).getByText('Aguardando você')).toBeTruthy();
      expect(within(today).queryByText('Atrasado')).toBeNull();
      expect(within(today).getByText('Venceu sábado, 10 out, 12h')).toBeTruthy();
    });

    it('holds the place of the covers with a skeleton nobody reads while they load', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const handle = contents.handle;
      contents.handle = (url, method) => (url.pathname.endsWith('/awaiting-approval') ? held.then(() => handle(url, method) as Response) : handle(url, method));
      const { container } = renderPortal(makeFetch({ portal: () => waiting(2), contents }).impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(container.querySelector('.portal-covers')?.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelectorAll('.portal-covers__skeleton')).toHaveLength(3);
      release();
      await waitFor(() => expect(container.querySelector('.portal-covers[aria-hidden]')).toBeNull());
    });

    it('keeps the headline and the action when the covers cannot be read, shows the mascot of the failure and offers to try again', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.state.failAwaiting = () => contentsError(500, 'INTERNAL_ERROR');
      const { impl } = makeFetch({ portal: () => waiting(2), contents });
      renderPortal(impl);

      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(within(alert).getByText('Não foi possível carregar os posts.')).toBeTruthy();
      expect(alert.querySelector('img.ui-mascot')).toBeTruthy();
      expect(screen.getByRole('heading', { name: '2 posts esperando sua aprovação' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Revisar os 2 posts' }).getAttribute('href')).toBe(portalUrl('conteudos'));
      contents.state.failAwaiting = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => expect(screen.queryByText('Não foi possível carregar os posts.')).toBeNull());
    });

    it('is not shown with nothing waiting, and then the next action is the answer of the agency, which leads to Marca', async () => {
      const none = makeFetch({ portal: () => waiting(0, { threadsAnsweredByAgency: 4 }) });
      const { probe } = renderPortal(none.impl);
      const link = await screen.findByRole('link', { name: /A agência respondeu 4 sugestões suas/ });
      expect(link.getAttribute('href')).toBe(portalUrl('marca'));
      expect(screen.queryByText(/esperando sua aprovação/)).toBeNull();
      expect(screen.queryByRole('link', { name: /Revisar/ })).toBeNull();
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
      expect(probe.pathname).toBe(portalUrl('marca'));
      cleanup();

      renderPortal(makeFetch({ portal: () => waiting(0, { threadsAnsweredByAgency: 1 }) }).impl);
      expect(await screen.findByText('A agência respondeu 1 sugestão sua')).toBeTruthy();
      cleanup();

      renderPortal(makeFetch({ portal: () => waiting(2, { threadsAnsweredByAgency: 4 }) }).impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(screen.queryByText(/A agência respondeu/)).toBeNull();
      expect(screen.queryByText('Conheça o estudo da sua marca')).toBeNull();
    });
  });

  describe('the next action when nothing waits', () => {
    it('leads to the brand study, or says how many suggestions the agency answered, and goes to Marca', async () => {
      const first = renderPortal(makeFetch().impl);
      const study = await screen.findByRole('link', { name: /Conheça o estudo da sua marca/ });
      expect(within(study).getByText('ver')).toBeTruthy();
      expect(screen.queryByText(/A agência respondeu/)).toBeNull();
      fireEvent.click(study);
      expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
      expect(first.probe.pathname).toBe(portalUrl('marca'));
      cleanup();

      renderPortal(makeFetch({ portal: () => waiting(0, { threadsAnsweredByAgency: 2 }) }).impl);
      expect((await screen.findByRole('link', { name: /A agência respondeu 2 sugestões suas/ })).getAttribute('href')).toBe(portalUrl('marca'));
      expect(screen.queryByText('Conheça o estudo da sua marca')).toBeNull();
    });
  });

  describe('"Boa notícia": the month when nothing waits', () => {
    const NEXT = { id: 'dddddddd-4444-4444-8444-444444444444', title: 'Pão de fermentação natural', publishOn: TODAY, publishAtTime: '18:00:00' };
    const good = (data: Partial<PortalContentProgressResponse['data']>) => ({ progress: () => json(progressOf({ approved: 7, total: 10, next: NEXT, ...data })) });

    it('says the percentage of the month, the count, the next post to go on air today at its hour, and leads to what is approved in Conteúdos', async () => {
      const { impl, calls } = makeFetch(good({}));
      const { probe } = renderPortal(impl);
      const block = await screen.findByRole('region', { name: 'Seu feed de outubro já está 70% aprovado' });
      expect(within(block).getByText('Boa notícia')).toBeTruthy();
      expect(within(block).getByRole('heading', { level: 2, name: 'Seu feed de outubro já está 70% aprovado' })).toBeTruthy();
      const bar = within(block).getByRole('progressbar', { name: 'Posts aprovados em outubro' });
      expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['7', '10']);
      expect(block.querySelector('.portal-win__text')!.textContent).toBe('7 de 10 posts aprovados. O primeiro vai ao ar hoje às 18h: Pão de fermentação natural.');
      expect(block.querySelectorAll('img.ui-mascot')).toHaveLength(1);
      expect(calls.filter((call) => call.endsWith('/contents/progress'))).toHaveLength(1);

      const link = within(block).getByRole('link', { name: 'Ver o que vai ao ar esta semana' });
      expect(link.getAttribute('href')).toBe(`${portalUrl('conteudos')}?situacao=approved`);
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { level: 1, name: 'Conteúdos' })).toBeTruthy();
      expect(probe.pathname).toBe(portalUrl('conteudos'));
      expect(probe.search).toBe('?situacao=approved');
    });

    it.each([
      ['tomorrow, with the hour', '2026-10-12', '12:00', 'amanhã às 12h'],
      ['a later day, with minutes', '2026-10-16', '12:30:00', 'sexta, 16 out às 12h30'],
      ['a day with no hour', '2026-10-16', null, 'sexta, 16 out']
    ])('words %s in the day of São Paulo', async (_name, publishOn, publishAtTime, when) => {
      renderPortal(makeFetch(good({ next: { ...NEXT, publishOn, publishAtTime } })).impl);
      const block = await screen.findByRole('region', { name: /Seu feed de outubro/ });
      expect(block.querySelector('.portal-win__text')!.textContent).toBe(`7 de 10 posts aprovados. O primeiro vai ao ar ${when}: Pão de fermentação natural.`);
    });

    it('rounds the percentage, and tells only the count when no post is on its way', async () => {
      renderPortal(makeFetch(good({ approved: 1, total: 3, next: null })).impl);
      const block = await screen.findByRole('region', { name: 'Seu feed de outubro já está 33% aprovado' });
      expect(block.querySelector('.portal-win__text')!.textContent).toBe('1 de 3 posts aprovados.');
    });

    it('is not there while something waits, and the month is not even read', async () => {
      const { impl, calls } = makeFetch({ ...good({}), portal: () => waiting(2) });
      renderPortal(impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(screen.queryByText('Boa notícia')).toBeNull();
      expect(calls.filter((call) => call.endsWith('/contents/progress'))).toEqual([]);
    });

    it('holds its place with a skeleton nobody reads while the month loads, and never says "Nada para aprovar" meanwhile', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { container } = renderPortal(makeFetch({ progress: () => held.then(() => json(progressOf({ approved: 7, total: 10, next: NEXT }))) }).impl);
      await screen.findByRole('heading', { level: 1, name: 'Olá, Maria' });
      await waitFor(() => expect(container.querySelector('.portal-win--loading')?.getAttribute('aria-hidden')).toBe('true'));
      expect(screen.queryByText('Nada para aprovar')).toBeNull();
      release();
      expect(await screen.findByRole('region', { name: /Seu feed de outubro/ })).toBeTruthy();
      expect(container.querySelector('.portal-win--loading')).toBeNull();
    });

    it('shows the failure with the mascot and "Tentar de novo", never the good news nor "Nada para aprovar", and reads again', async () => {
      let failing = true;
      const { impl } = makeFetch({ progress: () => (failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500) : json(progressOf({ approved: 7, total: 10, next: NEXT }))) });
      renderPortal(impl);
      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
      expect(alert.querySelector('img.ui-mascot')).toBeTruthy();
      expect(within(alert).getByRole('heading', { level: 2, name: 'Não foi possível carregar o andamento do mês.' })).toBeTruthy();
      expect(screen.queryByText('Nada para aprovar')).toBeNull();
      expect(screen.queryByText('Boa notícia')).toBeNull();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('region', { name: /Seu feed de outubro/ })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('the script of today stays under the board (decision 2026-11-11, item 3)', () => {
    it('is drawn after "A agência pediu" and brings no primary action of its own', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Abrir com o forno', guidance: null }] });
      const requests = createPortalMaterialRequestsApi(CLIENT_ID);
      requests.seed({ title: 'Fotos', body: 'Envie fotos' });
      const { container } = renderPortal(makeFetch({ scripts: api, materialRequests: requests }).impl);
      const script = await screen.findByRole('region', { name: 'Roteiro de hoje' });
      const asked = await screen.findByRole('region', { name: 'A agência pediu' });
      expect(asked.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.querySelectorAll('.ui-button--primary')).toHaveLength(0);
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

    it('while the agency is read-only, "Já gravei" is blocked with the neutral reason and nothing on screen speaks of the plan (decision 2026-11-06)', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY });
      renderPortal(makeFetch({ scripts: api, portal: () => json(portalClient({ agencyReadOnly: true, home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0, materialRequestsOpen: 0 } })) }).impl);
      const button = await screen.findByRole('button', { name: 'Já gravei' });

      expect(button.getAttribute('aria-disabled')).toBe('true');
      const reason = (button.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
      expect(reason).toBe('A aprovação está pausada no momento. A agência já foi avisada.');
      expect(document.body.textContent).not.toMatch(/plano|renov/i);
    });

    it('a refusal of Já gravei because the agency turned read-only says the neutral reason, never the server text', () => {
      const error = new HttpClientError('O plano desta agência precisa ser renovado para usar esta opção.', { code: 'AGENCY_READ_ONLY', status: 409 });
      expect(recordRefusal(error)).toBe('A aprovação está pausada no momento. A agência já foi avisada.');
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

  describe('A agência pediu: the open requests for material', () => {
    const materialApi = () => createPortalMaterialRequestsApi(CLIENT_ID);
    const REQUESTS = `GET /clients/${CLIENT_ID}/material-requests`;
    const requestsBlock = (): HTMLElement => screen.getByRole('region', { name: 'A agência pediu' });
    const bodiesOf = (): (string | null)[] => Array.from(requestsBlock().querySelectorAll('.portal-request__title')).map((node) => node.textContent);
    const serverError = (): Response => json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500);

    it('is not there at all with no open request, and is no "nothing pending" either', async () => {
      const api = materialApi();
      api.seed({ body: 'Já resolvido', state: 'resolved' });
      renderPortal(makeFetch({ materialRequests: api }).impl);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      await waitFor(() => expect(api.calls).toContain(REQUESTS));

      expect(screen.queryByRole('region', { name: 'A agência pediu' })).toBeNull();
      expect(screen.queryByText('A agência pediu')).toBeNull();
      expect(screen.queryByText('Já resolvido')).toBeNull();
      expect(screen.queryByText(/nenhum pedido/i)).toBeNull();
    });

    it('lists what the API returned, in its order, each with the title, the description and by when, and counts them', async () => {
      const api = materialApi();
      api.seed({ body: 'Sem prazo nenhum' });
      api.seed({ title: 'Fotos do novo cardápio', body: 'Pelo menos 5 fotos dos panetones', dueOn: '2026-10-20' });
      api.seed({ title: 'Logotipo em PNG', body: 'Mande o logotipo em PNG', dueOn: '2026-10-15' });
      api.seed({ body: 'Pedido já resolvido', dueOn: '2026-10-12', state: 'resolved' });
      renderPortal(makeFetch({ materialRequests: api }).impl);

      await screen.findByRole('region', { name: 'A agência pediu' });
      expect(within(requestsBlock()).getByRole('heading', { level: 2, name: 'A agência pediu' })).toBeTruthy();
      expect(within(requestsBlock()).getByText('Material que falta para os próximos posts.')).toBeTruthy();
      expect(within(requestsBlock()).getByText('3 pedidos')).toBeTruthy();
      expect(bodiesOf()).toEqual(['Logotipo em PNG', 'Fotos do novo cardápio', 'Sem prazo nenhum']);
      const metas = Array.from(requestsBlock().querySelectorAll('.portal-request__meta')).map((node) => node.textContent);
      expect(metas).toEqual(['Mande o logotipo em PNG', 'Pelo menos 5 fotos dos panetones']);
      const dues = Array.from(requestsBlock().querySelectorAll('.portal-request__due')).map((node) => node.textContent);
      expect(dues).toEqual(['até 15 de outubro', 'até 20 de outubro']);
      expect(within(requestsBlock()).queryByText('Pedido já resolvido')).toBeNull();
      expect(within(requestsBlock()).queryByText(/Pedido de Agência Um/)).toBeNull();
      expect(api.calls.filter((call) => call.includes('material-requests'))).toEqual([REQUESTS]);
    });

    it('counts one request in the singular', async () => {
      const api = materialApi();
      api.seed({ title: 'Logotipo', body: 'Mande o logotipo em PNG' });
      renderPortal(makeFetch({ materialRequests: api }).impl);
      await screen.findByRole('region', { name: 'A agência pediu' });
      expect(within(requestsBlock()).getByText('1 pedido')).toBeTruthy();
    });

    it('says "venceu" only when the deadline day has passed in São Paulo, not in UTC (01:30Z is still the 11th)', async () => {
      const api = materialApi();
      api.seed({ body: 'Venceu ontem', dueOn: '2026-10-10' });
      api.seed({ body: 'Vence hoje', dueOn: TODAY });
      api.seed({ body: 'Vence amanhã', dueOn: TOMORROW });
      renderPortal(makeFetch({ materialRequests: api }).impl);

      await screen.findByRole('region', { name: 'A agência pediu' });
      const itemOf = (text: string): HTMLElement => within(requestsBlock()).getByText(text).closest('li') as HTMLElement;
      expect(itemOf('Venceu ontem').textContent).toContain('até 10 de outubro');
      expect(within(itemOf('Venceu ontem')).getByText('venceu')).toBeTruthy();
      expect(itemOf('Vence hoje').textContent).toContain('até 11 de outubro');
      expect(within(itemOf('Vence hoje')).queryByText('venceu')).toBeNull();
      expect(within(itemOf('Vence amanhã')).queryByText('venceu')).toBeNull();
      expect(requestsBlock().querySelectorAll('.ui-late-badge')).toHaveLength(1);

      // The thread says the same of the same request, on the same day.
      fireEvent.click(screen.getByRole('button', { name: 'Ver o pedido Venceu ontem' }));
      const late = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(within(late).getByText('venceu')).toBeTruthy();
      fireEvent.click(within(late).getByRole('button', { name: 'Fechar conversa' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Ver o pedido Vence hoje' }));
      const today = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(within(today).getByText('Entregar até 11/10')).toBeTruthy();
      expect(within(today).queryByText('venceu')).toBeNull();
    });

    it('names each "Responder" by its request and answers on the right thread (two requests)', async () => {
      const api = materialApi();
      const first = api.seed({ body: 'Envie 3 fotos da equipe', dueOn: '2026-10-20' });
      const second = api.seed({ body: 'Mande o logotipo em PNG', dueOn: '2026-10-25' });
      renderPortal(makeFetch({ materialRequests: api }).impl);
      await screen.findByRole('region', { name: 'A agência pediu' });

      expect(screen.getAllByRole('button', { name: /^Ver o pedido/ }).map((button) => button.textContent)).toEqual(['Ver o pedido', 'Ver o pedido']);
      fireEvent.click(screen.getByRole('button', { name: 'Ver o pedido Mande o logotipo em PNG' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(await within(dialog).findByText('Mande o logotipo em PNG')).toBeTruthy();
      expect(within(dialog).getByText('Lucas')).toBeTruthy();
      expect(within(dialog).getByText('Entregar até 25/10')).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
      expect(within(dialog).queryByText('Envie 3 fotos da equipe')).toBeNull();

      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Segue o logotipo' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
      await waitFor(() => expect(api.posted).toEqual([{ threadId: second.threadId, body: 'Segue o logotipo' }]));
      expect(await within(dialog).findByText('Segue o logotipo')).toBeTruthy();
      expect(api.rows.find((row) => row.threadId === first.threadId)!.comments).toHaveLength(1);
      expect(api.calls).toContain(`POST /clients/${CLIENT_ID}/threads/${second.threadId}/comments`);
      // The request stays in the list: only the agency resolves.
      expect(bodiesOf()).toEqual(['Envie 3 fotos da equipe', 'Mande o logotipo em PNG']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      const again = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(await within(again).findByText('Envie 3 fotos da equipe')).toBeTruthy();
      expect(within(again).queryByText('Segue o logotipo')).toBeNull();
      fireEvent.change(within(again).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Mando amanhã' } });
      fireEvent.click(within(again).getByRole('button', { name: 'Responder' }));
      await waitFor(() => expect(api.posted).toEqual([
        { threadId: second.threadId, body: 'Segue o logotipo' },
        { threadId: first.threadId, body: 'Mando amanhã' }
      ]));
    });

    it('refuses an empty answer without sending, and says it when the send fails, without the words of the server', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      renderPortal(makeFetch({ materialRequests: api }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
      expect(await within(dialog).findByText('Escreva a mensagem.')).toBeTruthy();
      expect(api.posted).toEqual([]);

      api.state.failPost = serverError;
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Mando amanhã' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
      expect(await within(dialog).findByText('Não foi possível enviar. Tente de novo.')).toBeTruthy();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    });

    it('drops a request from the list, after the next read, once the agency resolved it, and keeps the others', async () => {
      const api = materialApi();
      const done = api.seed({ body: 'Envie 3 fotos da equipe', dueOn: '2026-10-20' });
      const kept = api.seed({ body: 'Mande o logotipo em PNG', dueOn: '2026-10-25' });
      const { queryClient } = renderPortal(makeFetch({ materialRequests: api }).impl);
      await screen.findByRole('region', { name: 'A agência pediu' });
      expect(bodiesOf()).toEqual(['Envie 3 fotos da equipe', 'Mande o logotipo em PNG']);

      api.resolve(done.threadId);
      expect(bodiesOf()).toEqual(['Envie 3 fotos da equipe', 'Mande o logotipo em PNG']);
      await act(async () => { await queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(CLIENT_ID) }); });
      await waitFor(() => expect(bodiesOf()).toEqual(['Mande o logotipo em PNG']));

      api.resolve(kept.threadId);
      await act(async () => { await queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(CLIENT_ID) }); });
      await waitFor(() => expect(screen.queryByRole('region', { name: 'A agência pediu' })).toBeNull());
    });

    it('closes the thread that left the list instead of leaving an answer box on a resolved request', async () => {
      const api = materialApi();
      const request = api.seed({ body: 'Envie 3 fotos da equipe' });
      const { queryClient } = renderPortal(makeFetch({ materialRequests: api }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      await screen.findByRole('dialog', { name: 'Pedido de material' });

      api.resolve(request.threadId);
      await act(async () => { await queryClient.invalidateQueries({ queryKey: portalMaterialRequestsKey(CLIENT_ID) }); });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());
      expect(screen.queryByRole('region', { name: 'A agência pediu' })).toBeNull();
    });

    it('has no way to open a request: no "Pedir material" and no new conversation on the Início, in the thread or in Marca', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      renderPortal(makeFetch({ materialRequests: api }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      await within(dialog).findByText('Envie 3 fotos da equipe');

      const creating = /pedir material|novo pedido|nova conversa|iniciar conversa/i;
      expect(screen.queryAllByRole('button', { name: creating })).toEqual([]);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());
      expect(screen.queryAllByRole('button', { name: creating })).toEqual([]);
      expect(screen.queryAllByRole('link', { name: creating })).toEqual([]);

      clickTab('Marca');
      await screen.findByRole('heading', { name: 'Sua marca' });
      expect(screen.queryAllByRole('button', { name: creating })).toEqual([]);
      expect(screen.queryByText(/pedir material/i)).toBeNull();
      expect(api.calls.some((call) => call.startsWith('POST'))).toBe(false);
    });

    it('keeps the answer on screen but blocked, with the neutral reason, while the agency is read-only', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      renderPortal(makeFetch({ materialRequests: api, portal: () => json(portalClient({ agencyReadOnly: true })) }).impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });

      expect(within(dialog).queryByRole('textbox')).toBeNull();
      const blocked = within(dialog).getByRole('button', { name: 'Responder' });
      expect(blocked.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(blocked);
      expect(api.posted).toEqual([]);
    });

    it('shows the failure only in the block, with Tentar de novo that reads again, and never an empty or good-news state', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      api.state.failList = serverError;
      renderPortal(makeFetch({ materialRequests: api }).impl);

      const block = await screen.findByRole('region', { name: 'A agência pediu' }, { timeout: 5000 });
      const alert = within(block).getByRole('alert');
      expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
      expect(alert.querySelector('img.ui-mascot')).toBeTruthy();
      expect(within(alert).getByRole('heading', { level: 3, name: 'Não foi possível carregar os pedidos da agência.' })).toBeTruthy();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
      expect(within(block).queryByText('Envie 3 fotos da equipe')).toBeNull();
      expect(block.querySelector('.ui-empty-state--good-news')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
      const before = api.calls.filter((call) => call === REQUESTS).length;

      api.state.failList = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await within(requestsBlock()).findByText('Envie 3 fotos da equipe')).toBeTruthy();
      expect(api.calls.filter((call) => call === REQUESTS).length).toBe(before + 1);
      expect(screen.queryByText('Não foi possível carregar os pedidos da agência.')).toBeNull();
    });

    it('shows only the requests of the client of the address, for a person who belongs to two clients', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      const other = createPortalMaterialRequestsApi(OTHER_CLIENT_ID);
      other.seed({ body: 'Mande o cardápio do outro cliente' });
      const { probe } = renderPortal(makeFetch({ materialRequests: api, otherMaterialRequests: other }).impl);
      await screen.findByText('Envie 3 fotos da equipe');

      act(() => { probe.navigate(portalUrl('inicio', OTHER_CLIENT_ID)); });
      // B's Início has settled once its own request is on screen; only then is the absence of A's request a fact about the rule.
      expect(await screen.findByText('Mande o cardápio do outro cliente')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
      expect(bodiesOf()).toEqual(['Mande o cardápio do outro cliente']);
      expect(screen.queryByText('Envie 3 fotos da equipe')).toBeNull();
      expect(api.calls.filter((call) => call === REQUESTS)).toHaveLength(1);
      expect(other.calls.filter((call) => call === `GET /clients/${OTHER_CLIENT_ID}/material-requests`)).toHaveLength(1);
    });

    it('is the first block under what waits for approval, which the redesign puts in the lead of the Início', async () => {
      const api = materialApi();
      api.seed({ body: 'Envie 3 fotos da equipe' });
      const { container } = renderPortal(makeFetch({ materialRequests: api, portal: () => withHome({ contentsAwaitingApproval: 2 }) }).impl);
      const waiting = await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      const requests = await screen.findByRole('region', { name: 'A agência pediu' });
      const main = container.querySelector('.portal-home__split') as HTMLElement;
      expect(main.firstElementChild).toBe(requests);
      expect(waiting.compareDocumentPosition(requests) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('the three empty states of the Início', () => {
    it('says "Nada para aprovar" as good news when the count answered zero and the month has nothing in it', async () => {
      renderPortal(makeFetch().impl);
      const good = (await screen.findByRole('heading', { level: 2, name: 'Nada para aprovar' })).closest('.ui-empty-state') as HTMLElement;
      expect(good.classList.contains('ui-empty-state--good-news')).toBe(true);
      expect(good.querySelector('.ui-empty-state__icon')).toBeTruthy();
      expect(within(good).getByText('Quando a agência enviar um post para aprovação, ele aparece aqui.')).toBeTruthy();
      expect(good.hasAttribute('role')).toBe(false);
      expect(screen.queryByText('Boa notícia')).toBeNull();
    });

    it('never says it while something waits, even when the covers of what waits could not be read', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.state.failAwaiting = () => contentsError(500, 'INTERNAL_ERROR');
      renderPortal(makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 2 }), contents }).impl);
      await screen.findByRole('heading', { name: '2 posts esperando sua aprovação' });
      expect(await screen.findByRole('alert', undefined, { timeout: 5000 })).toBeTruthy();
      expect(screen.queryByText('Nada para aprovar')).toBeNull();
      expect(document.querySelector('.ui-empty-state--good-news')).toBeNull();
    });

    it('shows the failure of the script of today in its block, with a retry, and no good news on top of it', async () => {
      const base = makeFetch().impl;
      let broken = true;
      const impl: typeof fetch = async (input, init) => (broken && String(input).includes('/story-scripts') ? scriptError(500, 'INTERNAL_ERROR') : base(input, init));
      renderPortal(impl);
      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
      expect(within(alert).getByText('Não foi possível carregar o roteiro de hoje.')).toBeTruthy();
      expect(within(alert.closest('section') as HTMLElement).queryByText('Nada para aprovar')).toBeNull();
      broken = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => expect(screen.queryByText('Não foi possível carregar o roteiro de hoje.')).toBeNull());
    });
  });

  describe('Tentar de novo keeps its button while the read repeats', () => {
    it('keeps it in "A agência pediu" and then shows the requests, with no failure left', async () => {
      const api = createPortalMaterialRequestsApi(CLIENT_ID);
      api.seed({ body: 'Envie 3 fotos da equipe' });
      const { impl, gate } = gateReads(makeFetch({ materialRequests: api }).impl, (url) => url.pathname === `/clients/${CLIENT_ID}/material-requests`);
      gate.fail = serverFailure;
      renderPortal(impl);
      const block = await screen.findByRole('region', { name: 'A agência pediu' }, { timeout: 5000 });
      await retryWhileHeld(within(block).getByRole('alert'), gate);
      expect(await within(screen.getByRole('region', { name: 'A agência pediu' })).findByText('Envie 3 fotos da equipe')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps it in the covers of what waits and then shows them', async () => {
      const contents = createPortalContentsApi(CLIENT_ID);
      contents.seed({ publishOn: TODAY, title: 'Bolo de fubá', format: 'reels', status: 'awaiting_approval' });
      const { impl, gate } = gateReads(makeFetch({ portal: () => withHome({ contentsAwaitingApproval: 1 }), contents }).impl, (url) => url.pathname.endsWith('/contents/awaiting-approval'));
      gate.fail = serverFailure;
      renderPortal(impl);
      await retryWhileHeld(await screen.findByRole('alert', undefined, { timeout: 5000 }), gate);
      expect(await screen.findByRole('link', { name: /Bolo de fubá/ })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps it in the script of today and then shows the script', async () => {
      const scripts = scriptsApi();
      scripts.seed({ scriptOn: TODAY, scenes: [{ position: 1, text: 'Abra mostrando a vitrine', guidance: null }] });
      const { impl, gate } = gateReads(makeFetch({ scripts }).impl, (url) => url.pathname === `/clients/${CLIENT_ID}/story-scripts`);
      gate.fail = serverFailure;
      renderPortal(impl);
      await retryWhileHeld(await screen.findByRole('alert', undefined, { timeout: 5000 }), gate);
      expect(await screen.findByText('Abra mostrando a vitrine')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps it, and the focus inside the dialog, in the comments of a request, and then shows the thread', async () => {
      const api = createPortalMaterialRequestsApi(CLIENT_ID);
      api.seed({ body: 'Envie 3 fotos da equipe' });
      const { impl, gate } = gateReads(makeFetch({ materialRequests: api }).impl, (url) => url.pathname.endsWith('/comments'));
      gate.fail = serverFailure;
      renderPortal(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Ver o pedido Envie 3 fotos da equipe' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      const failure = await within(dialog).findByRole('alert', undefined, { timeout: 5000 });
      await retryWhileHeld(failure, gate);
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(await within(dialog).findByText('Lucas')).toBeTruthy();
      expect(within(dialog).queryByRole('alert')).toBeNull();
    });
  });

  describe('on a phone', () => {
    const css = (): string => readGlobalCss().replace(/\r\n/g, '\n');
    const rule = (selector: string): string => {
      const text = css();
      const start = text.indexOf(`\n${selector} {`);
      if (start === -1) throw new Error(`${selector} was not found in globals.css.`);
      return text.slice(start, text.indexOf('}', start));
    };

    it('keeps the bar in the navigation piece of the shell with the whole Início drawn, and the content taking the rest', async () => {
      const api = scriptsApi();
      api.seed({ scriptOn: TODAY });
      const { container } = renderPortal(makeFetch({ scripts: api, portal: () => withHome({ contentsAwaitingApproval: 3 }) }).impl);
      await screen.findByRole('region', { name: 'Roteiro de hoje' });
      const shell = container.querySelector('.portal-shell') as HTMLElement;
      expect(Array.from(shell.children).filter((child) => !child.classList.contains('shell-topbar')).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'div', 'main']);
      expect((shell.querySelector('.portal-sidebar') as HTMLElement).lastElementChild).toBe(nav());
      // jsdom has no layout: the rules that keep a short page's bar at the bottom, and a page of 390 px from scrolling sideways, are read from the stylesheet.
      expect(rule('.portal-shell')).toMatch(/min-height:\s*100dvh;/);
      expect(rule('.portal-shell > .portal-content')).toMatch(/flex:\s*1;/);
      expect(rule('.portal-nav')).toMatch(/position:\s*sticky;/);
      expect(rule('.portal-nav')).toMatch(/bottom:\s*0;/);
      // The bar is the last piece on a phone only because of these: the sidebar's own box does not take part in the layout, and the bar is ordered after the content.
      expect(rule('.portal-sidebar')).toMatch(/display:\s*contents;/);
      expect(rule('.portal-nav')).toMatch(/order:\s*2;/);
      expect(rule('.portal-shell > .portal-content')).toMatch(/order:\s*1;/);
      expect(rule('.portal-header')).toMatch(/order:\s*0;/);
    });

    it('lets the requests of the agency shrink and their text wrap, and styles them with tokens only', () => {
      expect(rule('.portal-requests')).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-request__title')).toMatch(/overflow-wrap:\s*anywhere;/);
      expect(rule('.portal-request__meta')).toMatch(/overflow-wrap:\s*anywhere;/);
      for (const selector of ['.portal-requests', '.portal-requests__list', '.portal-request', '.portal-request__title', '.portal-request__meta', '.portal-requests__more']) {
        expect(rule(selector)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(^|[^-])(width|min-width):\s*[\d.]+(px|rem)|font(-size)?:\s*[\d.]+(px|rem)/);
      }
    });

    it('lets the board shrink on 390 px: every box takes min-width 0, the covers and the news share the width, nothing is fixed in pixels', () => {
      for (const selector of ['.portal-home__head', '.portal-home__split', '.portal-hero', '.portal-win', '.portal-hero__text', '.portal-hero__cta']) expect(rule(selector)).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-hero .portal-covers')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
      expect(rule('.portal-home__split')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
      expect(rule('.portal-win__row')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
      expect(rule('.portal-win .portal-win__mascot')).toMatch(/max-width:\s*100%;/);
      expect(rule('.portal-win__title')).toMatch(/overflow-wrap:\s*anywhere;/);
      expect(rule('.portal-win__link')).toMatch(/min-height:\s*2\.75rem;/);
      expect(rule('.portal-postcard__due')).toMatch(/min-width:\s*0;/);
      for (const selector of ['.portal-home__split', '.portal-hero', '.portal-win', '.portal-win__text', '.portal-postcard__due']) {
        expect(rule(selector)).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|(^|[^-])(width|min-width):\s*[\d.]+(px|rem)/);
      }
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
