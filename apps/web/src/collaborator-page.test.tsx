// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { readGlobalCss } from './styles/read-css';

afterEach(cleanup);

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const AGENCY = '11111111-1111-4111-8111-111111111111';
const SESSION = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ROLES = [
  { id: '0a000000-0000-4000-8000-000000000001', key: 'account_manager', name: 'Gestor de conta' },
  { id: '0a000000-0000-4000-8000-000000000002', key: 'admin', name: 'Admin' },
  { id: '0a000000-0000-4000-8000-000000000004', key: 'production', name: 'Produção' }
];

const person = (letter: string, name: string, extra: Record<string, unknown> = {}) => ({
  membershipId: `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`,
  name,
  email: `${name.split(' ')[0]!.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}@example.test`,
  photoUrl: null,
  jobTitle: 'Editor de Vídeo',
  role: { key: 'production', name: 'Produção' },
  isOwner: false,
  isSelf: false,
  status: 'active',
  // 01:30Z of the 12th is still the 11th in São Paulo.
  joinedAt: '2026-03-12T01:30:00.000Z',
  ...extra
});

const owner = person('a', 'Marina Bastos', { jobTitle: 'Fundadora', role: { key: 'admin', name: 'Admin' }, isOwner: true });
const joao = person('b', 'João Pedro Alves', { jobTitle: 'Social media sênior', role: { key: 'account_manager', name: 'Gestor de conta' } });
const julia = person('c', 'Júlia Prado', { jobTitle: 'Designer' });
const PEOPLE = [owner, joao, julia];

const CLIENT_BAKERY = '70000000-0000-4000-8000-000000000001';
const CLIENT_PILATES = '70000000-0000-4000-8000-000000000002';
const CONTENT_CARDAPIO = '80000000-0000-4000-8000-000000000001';
const CONTENT_AULA = '80000000-0000-4000-8000-000000000002';

const OPEN_CONTENTS = {
  summary: { clients: 3, contents: 6, awaiting: 2 },
  data: [
    {
      client: { id: CLIENT_BAKERY, name: 'Padaria Central' },
      contents: 4,
      awaiting: 1,
      now: [{ contentId: CONTENT_CARDAPIO, title: 'Cardápio de Natal', state: 'awaiting_approval' }]
    },
    {
      client: { id: CLIENT_PILATES, name: 'Studio Vida Pilates' },
      contents: 1,
      awaiting: 0,
      now: [{ contentId: CONTENT_AULA, title: 'Aula experimental de sábado', state: 'in_production' }]
    }
  ]
};

const ALL_PERMISSIONS = ['colaborador.visualizar', 'conteudo.visualizar', 'colaborador.alterar_funcao', 'colaborador.alterar_papel', 'colaborador.remover'];

interface Scenario {
  readonly permissions?: readonly string[];
  readonly isOwner?: boolean;
  readonly people?: readonly ReturnType<typeof person>[];
  readonly openContents?: () => Response;
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const people = scenario.people ?? PEOPLE;
  const permissions = scenario.permissions ?? ALL_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/auth/session')) return json(SESSION);
    if (/\/agencies\/[^/]+\/me$/.test(url.pathname)) {
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: scenario.isOwner ?? false, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions });
    }
    if (url.pathname.endsWith('/roles')) return json({ data: ROLES });
    if (url.pathname.endsWith('/open-contents')) return scenario.openContents?.() ?? json(OPEN_CONTENTS);
    if (url.pathname.endsWith('/collaborators/job-titles')) return json({ data: [] });
    const remove = /\/collaborators\/([^/]+)\/remove$/.exec(url.pathname);
    if (remove !== null && method === 'POST') return json({ ...people.find((item) => item.membershipId === remove[1])!, status: 'removed' });
    const detail = /\/collaborators\/([^/]+)$/.exec(url.pathname);
    if (detail !== null) {
      const found = people.find((item) => item.membershipId === detail[1]);
      if (found === undefined) return json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      if (method === 'PATCH') return json({ ...found, ...JSON.parse(String(init?.body)) });
      return json(found);
    }
    if (/\/collaborators$/.test(url.pathname)) {
      const q = url.searchParams.get('q')?.toLowerCase();
      const shown = q === undefined ? people : people.filter((item) => `${item.name} ${item.email}`.toLowerCase().includes(q));
      return json({ data: shown, meta: { page: 1, pageSize: 24, totalItems: shown.length, totalPages: shown.length === 0 ? 0 : 1 } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  return <ApplicationRoutes session={useAuthSession(store)} />;
}

interface Probe { pathname: string; search: string; state: unknown }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
  });
  return null;
}

const renderAt = (impl: typeof fetch, entry: string) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', state: null };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return probe;
};

const pageOf = (target: { membershipId: string }) => `/agencia/${AGENCY}/colaboradores/${target.membershipId}`;
const profileOf = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('heading', { level: 1, name })).closest<HTMLElement>('.collaborator-page__main')!;
const openContentsCalls = (calls: string[]) => calls.filter((call) => call.includes('/open-contents'));

describe('the header of the profile', () => {
  it('shows the photo, name, role tag, job title, e-mail, entry date in São Paulo and the summary', async () => {
    const { impl } = makeFetch();
    renderAt(impl, pageOf(joao));
    const profile = await profileOf('João Pedro Alves');

    expect(within(profile).getAllByText('Gestor de conta').length).toBeGreaterThan(0);
    expect(profile.querySelector('.collaborator-profile__role--violet')?.textContent).toBe('Gestor de conta');
    expect(within(profile).getAllByText('Social media sênior').length).toBeGreaterThan(0);
    expect(within(profile).getAllByText('joao@example.test').length).toBeGreaterThan(0);
    expect(within(profile).getByText(/Na agência desde/).textContent).toBe('Na agência desde 11/03/2026');
    expect(profile.querySelector('.collaborator-profile__head .ui-avatar')).not.toBeNull();
    expect(await within(profile).findByText('3 clientes · 6 conteúdos · 2 aguardando')).toBeTruthy();
    expect(within(profile).queryByText('Dona da agência')).toBeNull();
  });

  it('shows the crown and "Dona da agência" for the owner, beside the role', async () => {
    const { impl } = makeFetch();
    renderAt(impl, pageOf(owner));
    const profile = await profileOf('Marina Bastos');
    expect(within(profile).getByText('Dona da agência')).toBeTruthy();
    expect(profile.querySelector('.collaborator-profile__role svg.lucide-crown')).not.toBeNull();
    expect(within(profile).getAllByText('Admin').length).toBeGreaterThan(0);
  });
});

describe('Clientes e o que está com ele', () => {
  it('lists the clients with their counts and "Com ele agora:", with the state of each content', async () => {
    const { impl } = makeFetch();
    renderAt(impl, pageOf(joao));
    const card = await screen.findByRole('region', { name: 'Clientes e o que está com ele' });

    expect(within(card).getByText('Padaria Central')).toBeTruthy();
    expect(within(card).getByText('4 conteúdos · 1 aguardando')).toBeTruthy();
    expect(within(card).getByText('Studio Vida Pilates')).toBeTruthy();
    expect(within(card).getByText('1 conteúdo · 0 aguardando')).toBeTruthy();
    expect(within(card).getAllByText('Com ele agora:')).toHaveLength(2);
    expect(card.querySelector('.ui-status-tag--waiting')?.textContent).toBe('Aguardando aprovação');
    expect(card.querySelector('.ui-status-tag--production')?.textContent).toBe('Em produção');
  });

  it('takes each content to its own place in the calendar of its own client', async () => {
    const { impl } = makeFetch();
    const probe = renderAt(impl, pageOf(joao));
    const card = await screen.findByRole('region', { name: 'Clientes e o que está com ele' });

    expect(within(card).getByRole('link', { name: /Cardápio de Natal/ }).getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT_BAKERY}/${CONTENT_CARDAPIO}`);
    const second = within(card).getByRole('link', { name: /Aula experimental de sábado/ });
    expect(second.getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT_PILATES}/${CONTENT_AULA}`);
    fireEvent.click(second);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT_PILATES}/${CONTENT_AULA}`));
  });

  it('shows a short empty state, and a zero summary, when nothing is open with the person', async () => {
    const { impl } = makeFetch({ openContents: () => json({ summary: { clients: 0, contents: 0, awaiting: 0 }, data: [] }) });
    renderAt(impl, pageOf(joao));
    const card = await screen.findByRole('region', { name: 'Clientes e o que está com ele' });
    expect(within(card).getByText('Nenhum conteúdo aberto com esta pessoa.')).toBeTruthy();
    expect(await screen.findByText('0 clientes · 0 conteúdos · 0 aguardando')).toBeTruthy();
  });

  it('does not exist, and is not even requested, without conteudo.visualizar', async () => {
    const { impl, calls } = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    await screen.findByText('João Pedro Alves', { selector: '.collaborator-page__person-name' });
    expect(screen.queryByText('Clientes e o que está com ele')).toBeNull();
    expect(screen.queryByText(/clientes · .* conteúdos/)).toBeNull();
    expect(openContentsCalls(calls)).toEqual([]);
  });

  it('asks only for the person of the page', async () => {
    const { impl, calls } = makeFetch();
    renderAt(impl, pageOf(joao));
    await screen.findByRole('region', { name: 'Clientes e o que está com ele' });
    expect(openContentsCalls(calls)).toEqual([`GET /agencies/${AGENCY}/collaborators/${joao.membershipId}/open-contents`]);
  });

  it.each([403, 500])('leaves the card and the summary out when the answer is %i, without breaking the page', async (status) => {
    const { impl, calls } = makeFetch({ openContents: () => json({ error: { code: 'X', message: 'private' } }, status) });
    renderAt(impl, pageOf(joao));
    const profile = await profileOf('João Pedro Alves');
    await waitFor(() => expect(openContentsCalls(calls).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText('Clientes e o que está com ele')).toBeNull());
    expect(within(profile).queryByText(/aguardando$/)).toBeNull();
    expect(within(profile).getByRole('tab', { name: 'Detalhes' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('private');
  });
});

describe('the list beside the profile', () => {
  it('changes the person when another is chosen, marking the open one', async () => {
    const { impl } = makeFetch();
    const probe = renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    const list = screen.getByRole('complementary', { name: 'Equipe' });
    const current = await within(list).findByRole('link', { name: /João Pedro Alves/ });
    expect(current.getAttribute('aria-current')).toBe('page');

    fireEvent.click(within(list).getByRole('link', { name: /Júlia Prado/ }));
    await profileOf('Júlia Prado');
    expect(probe.pathname).toBe(pageOf(julia));
    expect(within(list).getByRole('link', { name: /Júlia Prado/ }).getAttribute('aria-current')).toBe('page');
    expect(within(list).getByRole('link', { name: /João Pedro Alves/ }).hasAttribute('aria-current')).toBe(false);
  });

  it('filters the people by the search, by name or e-mail', async () => {
    const { impl, calls } = makeFetch();
    renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    const list = screen.getByRole('complementary', { name: 'Equipe' });
    await within(list).findByRole('link', { name: /Marina Bastos/ });

    fireEvent.change(within(list).getByRole('searchbox', { name: 'Buscar pessoa' }), { target: { value: 'julia' } });
    await waitFor(() => expect(within(list).queryByRole('link', { name: /Marina Bastos/ })).toBeNull());
    expect(within(list).getByRole('link', { name: /Júlia Prado/ })).toBeTruthy();
    expect(calls).toContain(`GET /agencies/${AGENCY}/collaborators?page=1&pageSize=24&q=julia`);

    fireEvent.change(within(list).getByRole('searchbox', { name: 'Buscar pessoa' }), { target: { value: 'zzz' } });
    expect(await within(list).findByText('Nenhuma pessoa encontrada.')).toBeTruthy();
  });

  it('keeps the search and the way back to the list when the person changes', async () => {
    const { impl } = makeFetch();
    const probe = renderAt(impl, `${pageOf(joao)}?q=a`);
    await profileOf('João Pedro Alves');
    const list = screen.getByRole('complementary', { name: 'Equipe' });
    fireEvent.click(await within(list).findByRole('link', { name: /Júlia Prado/ }));
    await profileOf('Júlia Prado');
    expect(probe.search).toBe('?q=a');
    expect(probe.state).toEqual({ collaboratorListUrl: `/agencia/${AGENCY}/colaboradores` });
  });

  it('offers "Voltar à equipe" for the narrow screen, which leads to the team list', async () => {
    const { impl } = makeFetch();
    const probe = renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    fireEvent.click(screen.getByRole('link', { name: 'Voltar à equipe' }));
    await screen.findByRole('heading', { level: 1, name: 'Colaboradores' });
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/colaboradores`);
  });

  it('opens the page from a badge of the team grid, with the crown on the owner', async () => {
    const { impl } = makeFetch();
    const probe = renderAt(impl, `/agencia/${AGENCY}/colaboradores`);
    const crowned = await screen.findByRole('link', { name: 'Ver detalhes de Marina Bastos' });
    expect(within(crowned).getByText('Dona da agência')).toBeTruthy();
    expect(crowned.querySelector('.ui-badge-card__role--indigo svg.lucide-crown')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Ver detalhes de João Pedro Alves' }).querySelector('.ui-badge-card__role--violet')).not.toBeNull();
    fireEvent.click(crowned);
    await profileOf('Marina Bastos');
    expect(probe.pathname).toBe(pageOf(owner));
  });
});

describe('who sees what in the profile (specs/colaboradores.md, "Variação por quem olha")', () => {
  const ACTIONS = ['Salvar', 'Remover do quadro'] as const;
  const has = (profile: HTMLElement, name: string, role: 'button' | 'textbox' | 'combobox') => within(profile).queryByRole(role, { name }) !== null;

  it.each([
    ['Admin', ALL_PERMISSIONS, { cargo: true, papel: true, save: true, remove: true }],
    ['Gestor de conta', ['colaborador.visualizar', 'colaborador.alterar_funcao'], { cargo: true, papel: false, save: true, remove: false }],
    ['Produção', ['colaborador.visualizar'], { cargo: false, papel: false, save: false, remove: false }]
  ] as const)('shows %s exactly its actions', async (_label, permissions, expected) => {
    const { impl } = makeFetch({ permissions });
    renderAt(impl, pageOf(julia));
    const profile = await profileOf('Júlia Prado');
    await within(profile).findByRole('tab', { name: 'Detalhes' });
    expect(has(profile, 'Cargo', 'textbox')).toBe(expected.cargo);
    expect(has(profile, 'Papel', 'combobox')).toBe(expected.papel);
    expect(has(profile, ACTIONS[0], 'button')).toBe(expected.save);
    expect(has(profile, ACTIONS[1], 'button')).toBe(expected.remove);
    expect(within(profile).getByText('A troca de e-mail é feita pela operação.')).toBeTruthy();
  });

  it('shows the own person the name and photo to edit, the role as reading, and no removal', async () => {
    const own = { ...julia, isSelf: true };
    const { impl } = makeFetch({ people: [owner, joao, own] });
    renderAt(impl, pageOf(own));
    const profile = await profileOf('Júlia Prado');
    expect(within(profile).getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(within(profile).getByRole('button', { name: 'Trocar foto' })).toBeTruthy();
    expect(has(profile, 'Cargo', 'textbox')).toBe(false);
    expect(has(profile, 'Papel', 'combobox')).toBe(false);
    expect(has(profile, 'Remover do quadro', 'button')).toBe(false);
    expect(within(profile).getByText(/Na agência desde/)).toBeTruthy();
  });

  it('offers no removal and no role edit when the one looked at is the owner', async () => {
    const { impl } = makeFetch({ isOwner: true });
    renderAt(impl, pageOf(owner));
    const profile = await profileOf('Marina Bastos');
    await within(profile).findByRole('tab', { name: 'Detalhes' });
    expect(has(profile, 'Remover do quadro', 'button')).toBe(false);
    expect(has(profile, 'Papel', 'combobox')).toBe(false);
    expect(has(profile, 'Cargo', 'textbox')).toBe(false);
  });
});

describe('Salvar and Remover act on the person of the page', () => {
  it('saves the cargo of the person opened from the list, not the one opened before', async () => {
    const { impl, calls } = makeFetch();
    renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    fireEvent.click(await within(screen.getByRole('complementary', { name: 'Equipe' })).findByRole('link', { name: /Júlia Prado/ }));
    const profile = await profileOf('Júlia Prado');

    const cargo = await within(profile).findByRole('textbox', { name: 'Cargo' });
    expect((cargo as HTMLInputElement).value).toBe('Designer');
    fireEvent.change(cargo, { target: { value: 'Diretora de arte' } });
    fireEvent.click(within(profile).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls).toContain(`PATCH /agencies/${AGENCY}/collaborators/${julia.membershipId}`));
    expect(calls.filter((call) => call.startsWith('PATCH'))).toEqual([`PATCH /agencies/${AGENCY}/collaborators/${julia.membershipId}`]);
  });

  it('removes the person of the page and returns to the team list', async () => {
    const { impl, calls } = makeFetch();
    const probe = renderAt(impl, pageOf(joao));
    await profileOf('João Pedro Alves');
    fireEvent.click(await screen.findByRole('button', { name: 'Remover do quadro' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Remover João Pedro Alves do quadro?' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(calls).toContain(`POST /agencies/${AGENCY}/collaborators/${joao.membershipId}/remove`));
    await screen.findByRole('heading', { level: 1, name: 'Colaboradores' });
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/colaboradores`);
  });
});

describe('the team grid and the invitations, as the board draws them', () => {
  const css = readGlobalCss().replace(/\r\n/g, '\n');

  it('opens three columns from 64rem, and follows the width below it', () => {
    expect(css).toMatch(/\.collaborators__grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 12rem\), 1fr\)\);/);
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*\.collaborators__grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  });

  it('keeps the list beside the profile from 64rem only, with the way back for the narrow screen', () => {
    expect(css).toMatch(/\.collaborator-page__list \{[^}]*display: none;/);
    expect(css).toMatch(/@media \(min-width: 64rem\) \{[^@]*\.collaborator-page__back \{\s*display: none;/);
  });

  it('shows the summary, the invitation deadlines and the info note', async () => {
    const future = (days: number) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return date.toISOString(); };
    const base = makeFetch({ permissions: [...ALL_PERMISSIONS, 'colaborador.convidar', 'convite.reenviar', 'convite.cancelar'] });
    const impl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/invitations')) {
        return json({
          data: [
            { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', email: 'leticia@exemplo.com.br', purpose: 'collaborator_invite', role: { key: 'production', name: 'Produção' }, client: null, createdAt: '2026-10-01T12:00:00.000Z', expiresAt: future(5) },
            { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', email: 'caio@exemplo.com.br', purpose: 'collaborator_invite', role: { key: 'account_manager', name: 'Gestor de conta' }, client: null, createdAt: '2026-10-01T12:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' }
          ],
          meta: { page: 1, pageSize: 24, totalItems: 2, totalPages: 1 }
        });
      }
      return base.impl(input, init);
    };
    renderAt(impl, `/agencia/${AGENCY}/colaboradores`);
    expect(await screen.findByText('3 de 3 pessoas')).toBeTruthy();
    expect(await screen.findByText('expira em 5 dias')).toBeTruthy();
    expect(screen.getByText('expirado')).toBeTruthy();
    expect(screen.getByText('Depois de reenviar, o link anterior deixa de valer e aparece o botão “Copiar link”. Convide por e-mail e escolha o papel: a pessoa entra na equipe assim que aceitar.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Convidar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Convidar colaborador' });
    expect(within(dialog).getByText('Define o que a pessoa poderá fazer.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o e-mail e o papel. A pessoa recebe um link para entrar na equipe.')).toBeTruthy();
    await act(async () => undefined);
  });
});
