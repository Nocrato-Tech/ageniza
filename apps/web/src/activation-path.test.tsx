// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { useCommittedLocation } from './location-probe-fixture.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const VIEW = ['cliente.visualizar', 'conteudo.visualizar'];
const ALL = [...VIEW, 'cliente.cadastrar', 'cliente.convidar_usuario', 'conteudo.operar'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Scenario {
  readonly permissions: readonly string[];
  readonly clients?: number;
  readonly facts?: { hasContent: boolean; sentForApproval: boolean; approvedByClient: boolean; published: boolean };
  readonly readOnly?: boolean;
}

const none = { hasContent: false, sentForApproval: false, approvedByClient: false, published: false };

const calls: string[] = [];

const makeFetch = (scenario: Scenario): typeof fetch => async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/auth/session')) return json(sessionBody);
  if (url.endsWith(`/agencies/${AGENCY}/me`)) {
    return json({
      agencyId: AGENCY, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' },
      plan: { kind: 'isenta', trialEndsAt: null, readOnly: scenario.readOnly ?? false }, permissions: scenario.permissions
    });
  }
  if (url.includes(`/agencies/${AGENCY}/clients?`)) {
    const total = scenario.clients ?? 0;
    return json({
      data: total === 0 ? [] : [{ id: CLIENT, name: 'Cliente', photoUrl: null, instagramHandle: null, status: 'active', closingDate: null, threadsAwaitingAgency: 0 }],
      meta: { page: 1, pageSize: 1, totalItems: total, totalPages: total }
    });
  }
  if (url.endsWith(`/agencies/${AGENCY}/contents/activation`)) return json({ data: scenario.facts ?? none });
  return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

function Probe({ target }: { target: { pathname: string } }) {
  useCommittedLocation((location) => { target.pathname = location.pathname; });
  return null;
}

const renderHome = (scenario: Scenario) => {
  const client = new HttpClient('http://127.0.0.1:3001', makeFetch(scenario), { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY}`]}>
            <Probe target={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return probe;
};

const steps = {
  client: 'Cadastre o primeiro cliente',
  content: 'Crie o primeiro conteúdo no calendário',
  sent: 'Envie o conteúdo para aprovação',
  approved: 'Seu cliente aprova pelo link, sem criar conta'
};

/** "3 de 4 passos": the big number and the words are two elements, so the line is read as one. */
const findCount = (text: string) => waitFor(() => { expect(document.querySelector('.activation__count')?.textContent).toBe(text); });

/** The state of each step in the words the trail says before its title ("Feito", "Passo atual", "Próximo passo"). */
const stateWords = (scope: HTMLElement): (string | undefined)[] =>
  within(scope).getAllByRole('listitem').map((item) => item.querySelector('.ui-trail__status')?.textContent?.replace(/:\s*$/, ''));

const journeyOf = (): HTMLElement => screen.getByRole('heading', { name: 'Até a primeira aprovação' }).closest('section') as HTMLElement;

beforeEach(() => { window.localStorage.clear(); calls.length = 0; });
afterEach(cleanup);

describe('the journey "Até a primeira aprovação" on the agency Início', () => {
  it('shows the four steps pending and the first one leads to the clients', async () => {
    const probe = renderHome({ permissions: ALL });
    expect(await screen.findByRole('heading', { name: 'Até a primeira aprovação' })).toBeTruthy();
    await findCount('0 de 4 passos');
    for (const title of Object.values(steps)) expect(screen.getByText(title)).toBeTruthy();
    expect(stateWords(journeyOf())).toEqual(['Passo atual', 'Próximo passo', 'Próximo passo', 'Próximo passo']);
    expect(screen.getByText('Só o nome é obrigatório. O resto você completa depois.')).toBeTruthy();
    expect(screen.getByText('O cliente vê o post no portal e aprova ou pede ajuste.')).toBeTruthy();
    // Without a client there is nowhere to create a content or invite: only the first step has a button.
    expect(screen.queryByRole('link', { name: 'Criar conteúdo' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Convidar o cliente' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Cadastrar cliente' }));
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/clientes`); });
  });

  it('presents the steps as a journey: who does each one, the progress, and the last step belongs to the client', async () => {
    renderHome({ permissions: ALL, clients: 1, facts: { ...none, hasContent: true } });
    await findCount('2 de 4 passos');
    const journey = within(journeyOf());
    const items = journey.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(stateWords(journeyOf())).toEqual(['Feito', 'Feito', 'Passo atual', 'Próximo passo']);
    expect(items.map((item) => within(item).getByText(/^(Você|Seu cliente)$/).textContent)).toEqual(['Você', 'Você', 'Você', 'Seu cliente']);
    const progress = screen.getByRole('progressbar', { name: 'Passos concluídos até a primeira aprovação' });
    expect(progress.getAttribute('value')).toBe('2');
    expect(progress.getAttribute('max')).toBe('4');
    // The first step still pending is the current one; the done ones and the rest are not.
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(within(items[3] as HTMLElement).getByText(steps.approved)).toBeTruthy();
    expect(within(items[3] as HTMLElement).getByText('Seu cliente')).toBeTruthy();
    expect(screen.queryByText('Primeiros passos')).toBeNull();
  });

  it('marks done steps from the data and sends each button to the screen that resolves it', async () => {
    const probe = renderHome({ permissions: ALL, clients: 1, facts: { ...none, hasContent: true } });
    await findCount('2 de 4 passos');
    expect(stateWords(journeyOf())).toEqual(['Feito', 'Feito', 'Passo atual', 'Próximo passo']);
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Enviar para aprovação' }));
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}`); });
  });

  it('sends the create-content button to the calendar of the client', async () => {
    const probe = renderHome({ permissions: ALL, clients: 1 });
    fireEvent.click(await screen.findByRole('link', { name: 'Criar conteúdo' }));
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}`); });
  });

  it('sends the invite button to the portal accesses of the client', async () => {
    const probe = renderHome({ permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: false, published: false } });
    await findCount('3 de 4 passos');
    fireEvent.click(screen.getByRole('link', { name: 'Convidar o cliente' }));
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/acessos`); });
  });

  it('shows the steps without any button to a role that can only see', async () => {
    renderHome({ permissions: VIEW, clients: 1 });
    expect(await screen.findByRole('heading', { name: 'Até a primeira aprovação' })).toBeTruthy();
    for (const title of Object.values(steps)) expect(screen.getByText(title)).toBeTruthy();
    for (const label of ['Cadastrar cliente', 'Criar conteúdo', 'Enviar para aprovação', 'Convidar o cliente']) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });

  it('keeps each button to the permission of its own step', async () => {
    renderHome({ permissions: [...VIEW, 'cliente.cadastrar'], clients: 1 });
    await screen.findByRole('heading', { name: 'Até a primeira aprovação' });
    // The first step is done, so its button is gone; the others need permissions this role lacks.
    expect(screen.queryByRole('link', { name: 'Criar conteúdo' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Convidar o cliente' })).toBeNull();
    cleanup();
    renderHome({ permissions: [...VIEW, 'conteudo.operar'], clients: 1 });
    expect(await screen.findByRole('link', { name: 'Criar conteúdo' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Convidar o cliente' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();
  });

  it('offers no write button while the plan is read-only', async () => {
    renderHome({ permissions: ALL, readOnly: true });
    expect(await screen.findByRole('heading', { name: 'Até a primeira aprovação' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();
  });

  it('disappears when the four steps are done and the Início is what it was', async () => {
    renderHome({ permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: true, published: false } });
    expect(await screen.findByText('Carteira, estudo de marca e conversas.')).toBeTruthy();
    // The facts were read and settled before the absence is asserted, so it is not the loading state.
    await waitFor(() => { expect(calls.some((url) => url.endsWith('/contents/activation'))).toBe(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
    expect(screen.queryByText(/de 4 passos/)).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Início' })).toBeTruthy();
  });

  it('congratulates the agency on the Início when its first approval arrives after a visit that was waiting for it', async () => {
    window.localStorage.setItem(`ageniza:milestones:${AGENCY}`, JSON.stringify(['client', 'content', 'sent']));
    renderHome({ permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: true, published: false } });
    expect(await screen.findByText('Parabéns pela primeira aprovação!')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
  });

  it('counts the first step done when the default list is empty (only archived clients) but there is content', async () => {
    renderHome({ permissions: ALL, clients: 0, facts: { ...none, hasContent: true } });
    await findCount('2 de 4 passos');
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();
  });

  it('keeps the path concluded after the approval steps back (an edit clears it) and does not bring it back', async () => {
    const scenario: { -readonly [K in keyof Scenario]: Scenario[K] } = { permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: true, published: false } };
    window.localStorage.setItem(`ageniza:milestones:${AGENCY}`, JSON.stringify(['client', 'content', 'sent']));
    renderHome(scenario);
    expect(await screen.findByText('Parabéns pela primeira aprovação!')).toBeTruthy();
    scenario.facts = { hasContent: true, sentForApproval: true, approvedByClient: false, published: false };
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Clientes' }));
    await screen.findByRole('heading', { name: 'Clientes' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Início' }));
    await screen.findByText('Carteira, estudo de marca e conversas.');
    await waitFor(() => { expect(calls.filter((url) => url.endsWith('/contents/activation')).length).toBeGreaterThan(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
  });

  it('shows the new step and celebrates it when the person comes back to the Início soon after', async () => {
    const scenario: { -readonly [K in keyof Scenario]: Scenario[K] } = { permissions: ALL, clients: 0 };
    renderHome(scenario);
    await findCount('0 de 4 passos');
    scenario.clients = 1;
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Clientes' }));
    await screen.findByRole('heading', { name: 'Clientes' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Início' }));
    await findCount('1 de 4 passos');
    expect(await screen.findByText('Primeiro cliente cadastrado!')).toBeTruthy();
  });

  it('does not show the path when this browser recorded the approval, whatever the data says now', async () => {
    window.localStorage.setItem(`ageniza:milestones:${AGENCY}`, JSON.stringify(['client', 'content', 'sent', 'approved']));
    renderHome({ permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: false, published: false } });
    expect(await screen.findByText('Carteira, estudo de marca e conversas.')).toBeTruthy();
    await waitFor(() => { expect(calls.some((url) => url.endsWith('/contents/activation'))).toBe(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
  });

  it('does not show the path to a role that cannot read clients and contents', async () => {
    renderHome({ permissions: ['colaborador.visualizar'] });
    expect(await screen.findByText('Colaboradores, papéis e convites.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
  });

  it('puts the current step on the trail with its way forward, and the rocket and the bar beside it', async () => {
    renderHome({ permissions: ALL, clients: 1, facts: { ...none, hasContent: true } });
    await findCount('2 de 4 passos');
    const journey = within(journeyOf());
    const trail = journey.getByRole('list', { name: 'Passos até a primeira aprovação' });
    const [current] = within(trail).getAllByRole('listitem').filter((item) => item.getAttribute('aria-current') === 'step');
    expect(within(current as HTMLElement).getByText(steps.sent)).toBeTruthy();
    expect(within(current as HTMLElement).getByRole('link', { name: 'Enviar para aprovação' })).toBeTruthy();
    expect(journeyOf().querySelector('img[src="/3d/rocket.png"]')).not.toBeNull();
  });
});

describe('"Marcos da agência" on the Início', () => {
  const milestones = (): HTMLElement => screen.getByRole('heading', { name: 'Marcos da agência' }).closest('section') as HTMLElement;

  it('is not there for a new agency: the journey already shows the whole way', async () => {
    renderHome({ permissions: ALL });
    await findCount('0 de 4 passos');
    expect(screen.queryByRole('heading', { name: 'Marcos da agência' })).toBeNull();
  });

  it('lists the five first achievements in order while the journey goes on, the reached ones as achieved', async () => {
    renderHome({ permissions: ALL, clients: 1, facts: { ...none, hasContent: true } });
    await screen.findByRole('heading', { name: 'Marcos da agência' });
    const titles = within(milestones()).getAllByRole('listitem').map((item) => item.querySelector('.ui-trail__title')?.lastChild?.textContent);
    expect(titles).toEqual(['Primeiro cliente cadastrado', 'Primeiro conteúdo criado', 'Primeiro envio para aprovação', 'Primeira aprovação', 'Primeiro conteúdo postado']);
    expect(stateWords(milestones())).toEqual(['Conquistado', 'Conquistado', 'A conquistar', 'A conquistar', 'A conquistar']);
    expect(milestones().querySelector('img[src="/3d/medal.png"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Até a primeira aprovação' })).toBeTruthy();
  });

  it('stays on the Início after the first approval, when the journey is gone', async () => {
    window.localStorage.setItem(`ageniza:milestones:${AGENCY}`, JSON.stringify(['client', 'content', 'sent']));
    renderHome({ permissions: ALL, clients: 1, facts: { hasContent: true, sentForApproval: true, approvedByClient: true, published: false } });
    await screen.findByRole('heading', { name: 'Marcos da agência' });
    expect(stateWords(milestones())).toEqual(['Conquistado', 'Conquistado', 'Conquistado', 'Conquistado', 'A conquistar']);
    expect(screen.queryByRole('heading', { name: 'Até a primeira aprovação' })).toBeNull();
  });

  it('is not on the Início of a role that cannot read the contents', async () => {
    renderHome({ permissions: ['colaborador.visualizar'] });
    expect(await screen.findByText('Colaboradores, papéis e convites.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Marcos da agência' })).toBeNull();
  });
});
