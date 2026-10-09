// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { apiError, createConversationApi } from './conversation-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { portalClientBody, portalPersona, portalStudyBody } from './portal-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

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

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const MARIA_ID = 'dddddddd-1111-4111-8111-111111111111';
const JOAO_ID = 'dddddddd-2222-4222-8222-222222222222';
const LIA_ID = 'eeeeeeee-3333-4333-8333-333333333333';
// 01:30 UTC of the 13th is 22:30 of the 12th in São Paulo: every date must read 12/10.
const LATE = '2026-10-13T01:30:00.000Z';
const EARLIER = '2026-10-12T15:00:00.000Z';
const RESOLVED_AT = '2026-10-13T01:30:30.000Z';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionBody = { user: { id: USER_ID, name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const legalAccepted = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};

const FULL_STUDY = portalStudyBody({
  branding: { body: 'Padaria de bairro desde 1990' },
  tone_of_voice: { body: 'Fala como vizinha: simples e calorosa' },
  colors: { colors: [{ name: 'Vinho', hex: '#7A1F2B' }, { name: 'Creme', hex: '#F5EBDD' }] },
  positioning: { body: 'A padaria de confiança do bairro' },
  archetype: { archetype: 'caregiver' },
  observations: { body: 'Evitar gírias' }
}, [
  portalPersona(MARIA_ID, 'Dona Maria', { description: 'Mora perto da padaria', pains: 'Falta de tempo' }),
  portalPersona(JOAO_ID, 'Seu João', { desires: 'Pão quente cedo' })
]);

const FULL_STUDY_FILLED = {
  branding: { body: 'Padaria de bairro desde 1990' },
  tone_of_voice: { body: 'Fala como vizinha: simples e calorosa' },
  colors: { colors: [{ name: 'Vinho', hex: '#7A1F2B' }] },
  positioning: { body: 'A padaria de confiança do bairro' },
  archetype: { archetype: 'caregiver' },
  observations: { body: 'Evitar gírias' }
};

const SECOND_STUDY = portalStudyBody(
  { branding: { body: 'Confeitaria artesanal' }, tone_of_voice: { body: 'Doce e direta' } },
  [portalPersona(LIA_ID, 'Dona Lia', { description: 'Faz bolo de festa' })]
);

interface Scenario {
  /** What each client's study answers; a client without an entry is not reachable. */
  readonly studies?: Readonly<Record<string, Record<string, unknown>>>;
  /** Holds the first read of the study until released, to look at the loading state. */
  readonly holdStudy?: Promise<void>;
  /** Answers the next read of the study instead of the study. */
  readonly failStudy?: () => Response;
  /** The person is also a collaborator of the agency of this client (the "pessoa dupla"). */
  readonly alsoCollaborator?: boolean;
}

const makeWorld = (scenario: Scenario = {}) => {
  const studies: Record<string, Record<string, unknown>> = { ...(scenario.studies ?? { [CLIENT_ID]: FULL_STUDY, [SECOND_ID]: SECOND_STUDY }) };
  const names: Record<string, string> = { [CLIENT_ID]: 'Padaria Central', [SECOND_ID]: 'Confeitaria Dois' };
  const apis = {
    [CLIENT_ID]: createConversationApi({ side: 'client', clientId: CLIENT_ID }),
    [SECOND_ID]: createConversationApi({ side: 'client', clientId: SECOND_ID })
  };
  const calls: string[] = [];
  let failStudy = scenario.failStudy;
  let held = scenario.holdStudy;

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    // The server answers a tick later, so a test can seed it right after mounting.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    if (path.endsWith('/auth/session')) return json(sessionBody);
    if (path.endsWith('/me/legal-acceptances')) return json(legalAccepted);
    if (path.endsWith('/me/contexts')) {
      return json({
        contexts: [
          ...Object.entries(names).map(([clientId, clientName]) => ({ type: 'client', clientId, clientName, agencyId: AGENCY_ID, agencyName: 'Agência Um', onboardingPending: false })),
          ...(scenario.alsoCollaborator === true ? [{ type: 'agency', agencyId: AGENCY_ID, agencyName: 'Agência Um', role: { key: 'admin', name: 'Admin' }, isOwner: false }] : [])
        ]
      });
    }
    if (path === `/agencies/${AGENCY_ID}/me`) {
      return json({ agencyId: AGENCY_ID, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions: ['cliente.visualizar', 'cliente.operar', 'cliente.arquivar'] });
    }
    for (const clientId of Object.keys(names)) {
      if (path === `/clients/${clientId}`) return json(portalClientBody(clientId, names[clientId]!));
      if (path === `/clients/${clientId}/brand-study`) {
        if (held !== undefined) { const release = held; held = undefined; await release; }
        if (failStudy !== undefined) { const make = failStudy; failStudy = undefined; return make(); }
        return json(studies[clientId]);
      }
      const answered = apis[clientId as keyof typeof apis].handle(url, method, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      if (answered !== undefined) return answered;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const setStudy = (clientId: string, body: Record<string, unknown>): void => { studies[clientId] = body; };
  return { impl, calls, apis, setStudy };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface ProbeTarget { pathname: string; navigate: NavigateFunction }

function Probe({ probe }: { probe: ProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.navigate = useNavigate();
  return null;
}

const marcaUrl = (clientId = CLIENT_ID) => `/portal/${clientId}/marca`;

const renderPortal = (impl: typeof fetch, entry = marcaUrl()) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', navigate: () => undefined };
  const queryClient = createQueryClient();
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <Probe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, container: rendered.container, queryClient };
};

const SECTION_LABELS = ['Sobre sua marca', 'Como sua marca fala', 'Cores', 'Posicionamento', 'Personalidade da marca', 'Quem é seu público', 'Observações'];
const NOT_PREPARED = 'Sua agência está preparando esta parte';

const page = async (): Promise<HTMLElement> => {
  await screen.findByRole('heading', { name: 'Sua marca' });
  return screen.getByRole('main');
};
const sectionOf = (label: string): HTMLElement => screen.getByRole('region', { name: label });
const conversationsOf = (label: string): HTMLElement => screen.getByRole('region', { name: `Conversas sobre ${label}` });
const rowsOf = (region: HTMLElement): HTMLElement[] => Array.from(region.querySelectorAll<HTMLElement>('.conversation__threads > li'));
const suggest = (label: string): void => { fireEvent.click(screen.getByRole('button', { name: `Sugerir sobre ${label}` })); };
const nav = () => screen.getByRole('navigation', { name: 'Navegação do portal' });

describe('portal Marca (#143)', () => {
  it('reads the whole study in the client language, in order, with the archetype by its Portuguese name', async () => {
    const { impl, calls } = makeWorld();
    renderPortal(impl);
    const main = await page();

    expect(within(main).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(SECTION_LABELS);
    expect(within(sectionOf('Sobre sua marca')).getByText('Padaria de bairro desde 1990')).toBeTruthy();
    expect(within(sectionOf('Como sua marca fala')).getByText('Fala como vizinha: simples e calorosa')).toBeTruthy();
    const colors = within(sectionOf('Cores'));
    for (const text of ['Vinho', '#7A1F2B', 'Creme', '#F5EBDD']) expect(colors.getByText(text)).toBeTruthy();
    expect(within(sectionOf('Posicionamento')).getByText('A padaria de confiança do bairro')).toBeTruthy();
    expect(within(sectionOf('Personalidade da marca')).getByText('Cuidador')).toBeTruthy();
    expect(within(sectionOf('Observações')).getByText('Evitar gírias')).toBeTruthy();

    const audience = within(sectionOf('Quem é seu público'));
    expect(audience.getByRole('heading', { level: 3, name: 'Dona Maria' })).toBeTruthy();
    expect(audience.getByRole('heading', { level: 3, name: 'Seu João' })).toBeTruthy();
    // Each card shows only the fields the persona has, by label and by value, and none of the empty ones.
    const fieldsOf = (name: string): [string, string][] => {
      const card = audience.getByRole('heading', { level: 3, name }).closest('li')!;
      return Array.from(card.querySelectorAll('.portal-persona__field')).map((field) => [field.querySelector('dt')!.textContent!, field.querySelector('dd')!.textContent!]);
    };
    expect(fieldsOf('Dona Maria')).toEqual([['Descrição', 'Mora perto da padaria'], ['Dores', 'Falta de tempo']]);
    expect(fieldsOf('Seu João')).toEqual([['Desejos', 'Pão quente cedo']]);
    expect(screen.queryByText(NOT_PREPARED)).toBeNull();
    expect(calls).toContain(`GET /clients/${CLIENT_ID}/brand-study`);
    expect(document.title).toBe('Marca — Portal do cliente — Ageniza');
  });

  it('has no control to edit the study: the only buttons of the page are the suggestions, one per part', async () => {
    const { impl } = makeWorld();
    renderPortal(impl);
    const main = await page();

    expect(within(main).queryAllByRole('textbox')).toEqual([]);
    expect(within(main).queryAllByRole('link')).toEqual([]);
    expect(within(main).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Sugerir sobre Sobre sua marca',
      'Sugerir sobre Como sua marca fala',
      'Sugerir sobre Cores',
      'Sugerir sobre Posicionamento',
      'Sugerir sobre Personalidade da marca',
      'Sugerir sobre Dona Maria',
      'Sugerir sobre Seu João',
      'Sugerir sobre Quem é seu público',
      'Sugerir sobre Observações'
    ]);
    for (const button of within(main).getAllByRole('button')) expect(button.textContent).toBe('Sugerir');
  });

  it('says the agency is preparing a part that is not filled, with no Sugerir, no conversation and no request about it', async () => {
    const study = portalStudyBody({ branding: { body: 'Padaria de bairro' }, positioning: { body: 'A de confiança' }, tone_of_voice: { body: '   ' }, colors: { colors: [] } });
    const { impl, calls } = makeWorld({ studies: { [CLIENT_ID]: study, [SECOND_ID]: SECOND_STUDY } });
    renderPortal(impl);
    const main = await page();

    for (const label of ['Como sua marca fala', 'Cores', 'Personalidade da marca', 'Quem é seu público', 'Observações']) {
      const section = within(sectionOf(label));
      expect(section.getByText(NOT_PREPARED)).toBeTruthy();
      expect(section.queryByRole('button')).toBeNull();
      expect(section.queryByRole('region')).toBeNull();
    }
    expect(within(main).getAllByText(NOT_PREPARED)).toHaveLength(5);
    expect(within(main).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Sugerir sobre Sobre sua marca', 'Sugerir sobre Posicionamento']);
    await screen.findAllByText('Nenhuma conversa sobre esta parte');
    const threadReads = calls.filter((call) => call.includes('/threads')).sort();
    expect(threadReads).toEqual([
      `GET /clients/${CLIENT_ID}/threads?sectionKey=branding&pageSize=100`,
      `GET /clients/${CLIENT_ID}/threads?sectionKey=positioning&pageSize=100`
    ]);
  });

  it('draws a study with nothing filled as seven preparing parts, without an error screen or a field', async () => {
    const { impl } = makeWorld({ studies: { [CLIENT_ID]: portalStudyBody(), [SECOND_ID]: SECOND_STUDY } });
    renderPortal(impl);
    const main = await page();

    expect(within(main).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(SECTION_LABELS);
    expect(within(main).getAllByText(NOT_PREPARED)).toHaveLength(7);
    expect(within(main).queryAllByRole('button')).toEqual([]);
    expect(within(main).queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('suggests on the part it was asked on: dialog, note, send, close on success, the suggestion in the list and the Início told', async () => {
    const { impl, calls, apis } = makeWorld();
    renderPortal(impl);
    await page();
    const homeReadsBefore = calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length;

    suggest('Como sua marca fala');
    const dialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Como sua marca fala"' });
    const field = within(dialog).getByRole('textbox', { name: 'Escreva sua sugestão' });
    expect(field.getAttribute('placeholder')).toBe('Escreva aqui');
    expect(within(dialog).getByText('A agência vai ver e responder por aqui.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Enviar' })).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Fale menos formal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const region = conversationsOf('Como sua marca fala');
    expect(await within(region).findByText('Fale menos formal')).toBeTruthy();
    expect(within(region).getByText('Conversas (1)')).toBeTruthy();
    // The side is never sent: the server stamps it from the route and the credential.
    expect(apis[CLIENT_ID].bodies).toEqual([{ subject: { sectionKey: 'tone_of_voice' }, body: 'Fale menos formal' }]);
    expect(calls).toContain(`POST /clients/${CLIENT_ID}/threads`);
    await waitFor(() => expect(calls.filter((call) => call === `GET /clients/${CLIENT_ID}`).length).toBeGreaterThan(homeReadsBefore));
  });

  it('acts on the right item: a part and each of two personas carry their own subject and show it only under themselves', async () => {
    const { impl, apis } = makeWorld();
    renderPortal(impl);
    await page();

    const send = async (label: string, text: string): Promise<void> => {
      suggest(label);
      const dialog = await screen.findByRole('dialog', { name: `Sugerir sobre "${label}"` });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: text } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };

    await send('Cores', 'Mais um tom de verde');
    await send('Seu João', 'Ele é mais velho que isso');
    expect(apis[CLIENT_ID].bodies).toEqual([
      { subject: { sectionKey: 'colors' }, body: 'Mais um tom de verde' },
      { subject: { personaId: JOAO_ID }, body: 'Ele é mais velho que isso' }
    ]);
    expect(await within(conversationsOf('Cores')).findByText('Mais um tom de verde')).toBeTruthy();
    expect(await within(conversationsOf('Seu João')).findByText('Ele é mais velho que isso')).toBeTruthy();
    expect(within(conversationsOf('Dona Maria')).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy();
    expect(within(conversationsOf('Como sua marca fala')).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy();
    expect(within(conversationsOf('Quem é seu público')).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy();
  });

  it('keeps the dialog and the typed text when the send fails, and sends the very same text on the retry', async () => {
    const { impl, apis } = makeWorld();
    renderPortal(impl);
    await page();

    suggest('Posicionamento');
    const dialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Posicionamento"' });
    const field = within(dialog).getByRole('textbox', { name: 'Escreva sua sugestão' });
    fireEvent.change(field, { target: { value: 'Falem de entrega em casa' } });
    apis[CLIENT_ID].failNextWrite(() => apiError(500, 'INTERNAL_ERROR'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe('Não foi possível enviar. Tente de novo.');
    expect((field as HTMLTextAreaElement).value).toBe('Falem de entrega em casa');
    expect(screen.getByRole('dialog', { name: 'Sugerir sobre "Posicionamento"' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(conversationsOf('Posicionamento')).findByText('Falem de entrega em casa')).toBeTruthy();
    expect(apis[CLIENT_ID].bodies).toEqual([
      { subject: { sectionKey: 'positioning' }, body: 'Falem de entrega em casa' },
      { subject: { sectionKey: 'positioning' }, body: 'Falem de entrega em casa' }
    ]);
  });

  it('says it in the client language and reads the study again when the agency archived the persona or emptied the part under the client', async () => {
    const { impl, apis, setStudy } = makeWorld();
    renderPortal(impl);
    await page();

    suggest('Seu João');
    const personaDialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Seu João"' });
    fireEvent.change(within(personaDialog).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: 'Ele gosta de pão doce' } });
    setStudy(CLIENT_ID, portalStudyBody({ ...FULL_STUDY_FILLED }, [portalPersona(MARIA_ID, 'Dona Maria', { description: 'Mora perto da padaria', pains: 'Falta de tempo' })]));
    apis[CLIENT_ID].failNextWrite(() => apiError(409, 'PERSONA_ARCHIVED'));
    fireEvent.click(within(personaDialog).getByRole('button', { name: 'Enviar' }));
    const personaAlert = await within(personaDialog).findByRole('alert');
    expect(personaAlert.textContent).toBe('Esta parte não está mais disponível para conversa.');
    expect(personaAlert.textContent).not.toMatch(/persona/i);
    await waitFor(() => expect(screen.queryByText('Seu João')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(sectionOf('Quem é seu público')).getByRole('heading', { level: 3, name: 'Dona Maria' })).toBeTruthy();

    suggest('Posicionamento');
    const sectionDialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Posicionamento"' });
    fireEvent.change(within(sectionDialog).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: 'Falem de entrega' } });
    setStudy(CLIENT_ID, portalStudyBody({ ...FULL_STUDY_FILLED, positioning: { body: '   ' } }, [portalPersona(MARIA_ID, 'Dona Maria', { description: 'Mora perto da padaria' })]));
    apis[CLIENT_ID].failNextWrite(() => apiError(409, 'SECTION_NOT_FILLED'));
    fireEvent.click(within(sectionDialog).getByRole('button', { name: 'Enviar' }));
    expect((await within(sectionDialog).findByRole('alert')).textContent).toBe('Sua agência está preparando esta parte.');
    await waitFor(() => expect(within(sectionOf('Posicionamento')).getByText(NOT_PREPARED)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Sugerir sobre Posicionamento' })).toBeNull();
  });

  it('marks as stale the conversations and the roster the agency caches in this browser, and only those, after a suggestion', async () => {
    const { impl } = makeWorld({ alsoCollaborator: true });
    const { queryClient } = renderPortal(impl);
    await page();
    const keys = {
      conversation: ['conversation', 'agency', CLIENT_ID, 'threads', 'x'],
      roster: ['agency', AGENCY_ID, 'clients', { page: 1, search: '', status: 'active' }],
      // The real key of the collaborators list: an object at the same position as the roster's.
      unrelated: ['agency', AGENCY_ID, 'collaborators', { page: 1, q: '', role: '', jobTitle: '', status: 'active' }],
      // Same prefix as the roster, but not the roster: a suggestion moves none of them.
      detail: ['agency', AGENCY_ID, 'clients', 'detail', CLIENT_ID],
      brandStudy: ['agency', AGENCY_ID, 'clients', 'brand-study', CLIENT_ID],
      members: ['agency', AGENCY_ID, 'clients', CLIENT_ID, 'members', { page: 1, status: 'active' }]
    } as const;
    for (const key of Object.values(keys)) queryClient.setQueryData(key, {});
    const stale = (key: readonly unknown[]): boolean | undefined => queryClient.getQueryState(key)?.isInvalidated;
    expect(Object.values(keys).map(stale)).toEqual([false, false, false, false, false, false]);

    suggest('Cores');
    const dialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Cores"' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: 'Mais verde' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(stale(keys.conversation)).toBe(true);
    expect(stale(keys.roster)).toBe(true);
    expect(stale(keys.unrelated)).toBe(false);
    expect(stale(keys.detail)).toBe(false);
    expect(stale(keys.brandStudy)).toBe(false);
    expect(stale(keys.members)).toBe(false);
  });

  it('shows the agency answer with the name and photo of who answered, the day in São Paulo, and no Resolver', async () => {
    const { impl, apis } = makeWorld();
    apis[CLIENT_ID].seed({ sectionKey: 'tone_of_voice' }, [
      { side: 'client', body: 'Acho formal demais', at: EARLIER },
      { side: 'agency', body: 'Reescrevi o exemplo', at: LATE }
    ]);
    renderPortal(impl);
    await page();

    const region = conversationsOf('Como sua marca fala');
    expect(await within(region).findByText('1 com resposta da agência')).toBeTruthy();
    expect(rowsOf(region)[0]!.textContent).toBe('Aberta por Maria (cliente)Agência · 12/10Reescrevi o exemploa agência respondeu');
    fireEvent.click(within(region).getByRole('button', { name: /Reescrevi o exemplo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Como sua marca fala' });
    const answer = (await within(dialog).findByText('Reescrevi o exemplo')).closest('li') as HTMLElement;
    expect(within(answer).getByText('Ana')).toBeTruthy();
    expect(answer.querySelector('img')?.getAttribute('src')).toBe('https://photos.example.test/ana.png');
    expect(within(answer).getByText(/12\/10 22:30/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
  });

  it('tells who concluded a conversation, by name, and the client comment reopens it', async () => {
    const { impl, apis } = makeWorld();
    apis[CLIENT_ID].seed({ sectionKey: 'colors' }, [
      { side: 'client', body: 'Troquem o verde', at: EARLIER },
      { side: 'agency', body: 'Troquei para vinho', at: LATE }
    ], { at: RESOLVED_AT, by: 'Ana' });
    renderPortal(impl);
    await page();

    const region = conversationsOf('Cores');
    await within(region).findByText('Troquei para vinho');
    expect(rowsOf(region)[0]!.textContent).toBe('Aberta por Maria (cliente)Agência · 12/10Troquei para vinhoconcluída');
    fireEvent.click(within(region).getByRole('button', { name: /Troquei para vinho/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Cores' });
    expect(await within(dialog).findByText('Concluída por Ana em 12/10')).toBeTruthy();
    expect(within(dialog).queryByText(/A agência concluiu esta conversa/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Ficou ótimo, obrigada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Ficou ótimo, obrigada');
    await waitFor(() => expect(within(dialog).queryByText(/Concluída por/)).toBeNull());
    expect(rowsOf(region)[0]!.textContent).toContain('aberta');
    expect(rowsOf(region)[0]!.textContent).not.toContain('concluída');
  });

  it('names whoever concluded the conversation, whoever it was, and says only that the agency did when the name is null', async () => {
    const { impl, apis } = makeWorld();
    apis[CLIENT_ID].seed({ sectionKey: 'colors' }, [
      { side: 'client', body: 'Troquem o verde', at: EARLIER },
      { side: 'agency', body: 'Troquei para vinho', at: LATE }
    ], { at: RESOLVED_AT, by: 'Beatriz Lima' });
    apis[CLIENT_ID].seed({ sectionKey: 'branding' }, [
      { side: 'client', body: 'Mudem o tom', at: EARLIER },
      { side: 'agency', body: 'Mudei o tom', at: LATE }
    ], { at: RESOLVED_AT, by: null });
    renderPortal(impl);
    await page();

    fireEvent.click(await within(conversationsOf('Cores')).findByRole('button', { name: /Troquei para vinho/ }));
    const named = await screen.findByRole('dialog', { name: 'Cores' });
    expect(await within(named).findByText('Concluída por Beatriz Lima em 12/10')).toBeTruthy();
    fireEvent.click(within(named).getByRole('button', { name: 'Fechar conversa' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(await within(conversationsOf('Sobre sua marca')).findByRole('button', { name: /Mudei o tom/ }));
    const unnamed = await screen.findByRole('dialog', { name: 'Sobre sua marca' });
    expect(await within(unnamed).findByText('A agência concluiu esta conversa em 12/10')).toBeTruthy();
    expect(within(unnamed).queryByText(/Concluída por/)).toBeNull();
    expect(unnamed.textContent).not.toContain('null');
  });

  it('serves only the client of the address, for a person who is also a collaborator and has two clients, and acts on that client', async () => {
    const { impl, calls, apis } = makeWorld({ alsoCollaborator: true });
    apis[CLIENT_ID].seed({ sectionKey: 'branding' }, [{ side: 'client', body: 'Isto é da Padaria', at: LATE }]);
    apis[SECOND_ID].seed({ sectionKey: 'branding' }, [{ side: 'client', body: 'Isto é da Confeitaria', at: LATE }]);
    apis[SECOND_ID].seed({ personaId: LIA_ID }, [{ side: 'client', body: 'Ela também pede encomenda', at: LATE }]);
    const { probe } = renderPortal(impl);
    await page();
    expect(await within(conversationsOf('Sobre sua marca')).findByText('Isto é da Padaria')).toBeTruthy();

    // Opening a conversation shows no Resolver, whatever the same person may do in the agency.
    fireEvent.click(within(conversationsOf('Sobre sua marca')).getByRole('button', { name: /Isto é da Padaria/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Sobre sua marca' });
    await within(dialog).findByText('Isto é da Padaria');
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));

    probe.navigate(marcaUrl(SECOND_ID));
    expect(await screen.findByText('Confeitaria artesanal')).toBeTruthy();
    expect(screen.queryByText('Padaria de bairro desde 1990')).toBeNull();
    expect(await within(conversationsOf('Sobre sua marca')).findByText('Isto é da Confeitaria')).toBeTruthy();
    expect(screen.queryByText('Isto é da Padaria')).toBeNull();
    expect(await within(conversationsOf('Dona Lia')).findByText('Ela também pede encomenda')).toBeTruthy();
    expect(screen.queryByText('Seu João')).toBeNull();

    suggest('Dona Lia');
    const lia = await screen.findByRole('dialog', { name: 'Sugerir sobre "Dona Lia"' });
    fireEvent.change(within(lia).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: 'Ela atende de noite' } });
    fireEvent.click(within(lia).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    suggest('Como sua marca fala');
    const second = await screen.findByRole('dialog', { name: 'Sugerir sobre "Como sua marca fala"' });
    fireEvent.change(within(second).getByRole('textbox', { name: 'Escreva sua sugestão' }), { target: { value: 'Mais doce ainda' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(apis[SECOND_ID].bodies).toEqual([
      { subject: { personaId: LIA_ID }, body: 'Ela atende de noite' },
      { subject: { sectionKey: 'tone_of_voice' }, body: 'Mais doce ainda' }
    ]);
    expect(apis[CLIENT_ID].bodies).toEqual([]);
    expect(calls.some((call) => call.includes('/agencies/'))).toBe(false);
    expect(probe.pathname).toBe(marcaUrl(SECOND_ID));
  });

  it('does not show a persona the payload marks as archived: the page fails closed', async () => {
    const study = portalStudyBody({ branding: { body: 'Padaria de bairro' } }, [{ ...portalPersona(JOAO_ID, 'Seu João'), status: 'archived' }]);
    const { impl } = makeWorld({ studies: { [CLIENT_ID]: study, [SECOND_ID]: SECOND_STUDY } });
    renderPortal(impl);

    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toContain('Não foi possível carregar a sua marca. Tente de novo.');
    expect(screen.queryByText('Seu João')).toBeNull();
  });

  it('shows skeletons while the study loads, and the error with a retry that recovers', async () => {
    let release: () => void = () => undefined;
    const holdStudy = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeWorld({ holdStudy });
    renderPortal(impl);

    const loading = await screen.findByLabelText('Carregando sua marca');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Sua marca' })).toBeNull();
    release();
    await page();
    expect(screen.queryByLabelText('Carregando sua marca')).toBeNull();
    cleanup();

    const failing = makeWorld({ failStudy: () => apiError(404, 'NOT_FOUND') });
    renderPortal(failing.impl);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar a sua marca. Tente de novo.');
    expect(screen.queryByText('Padaria de bairro desde 1990')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Padaria de bairro desde 1990')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is reached from the bottom bar and from the Início action, each click on its own address', async () => {
    const { impl, calls } = makeWorld();
    const { probe } = renderPortal(impl, `/portal/${CLIENT_ID}/inicio`);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    fireEvent.click(within(nav()).getByRole('link', { name: 'Marca' }));
    await page();
    expect(probe.pathname).toBe(marcaUrl());
    expect(within(nav()).getByRole('link', { name: 'Marca' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(within(nav()).getByRole('link', { name: 'Início' }));
    fireEvent.click(await screen.findByRole('link', { name: /Conheça o estudo da sua marca/ }));
    await page();
    expect(probe.pathname).toBe(marcaUrl());
    expect(calls.filter((call) => call === `GET /clients/${CLIENT_ID}/brand-study`).length).toBeGreaterThan(0);
  });

  it('never shows an internal term, nor who edited a part', async () => {
    const { impl, apis } = makeWorld();
    apis[CLIENT_ID].seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'Mais simples', at: LATE }]);
    renderPortal(impl);
    const main = await page();
    await within(main).findByText('Mais simples');

    expect(main.textContent).not.toMatch(/\b(thread|status|arquivad\w*|onboarding|persona|editado por|resolvid\w*)\b/i);
  });
});
