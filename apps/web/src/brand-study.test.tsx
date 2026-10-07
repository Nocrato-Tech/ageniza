// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});

const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario'];
const READER_PERMISSIONS = ['cliente.visualizar'];

const padaria = {
  id: CLIENT_ID,
  name: 'Padaria Central',
  status: 'active',
  photoUrl: null,
  legalName: 'Padaria Central Ltda',
  taxId: '12345678000190',
  segment: 'Alimentação',
  website: null,
  instagramHandle: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  archivedAt: null,
  summary: { brandStudyFilled: 5, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
};

interface SectionFixture {
  key: string;
  body: string | null;
  colors: Array<{ name: string; hex: string }> | null;
  archetype: string | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
}

const sectionOf = (key: string, over: Partial<SectionFixture> = {}): SectionFixture => ({
  key, body: null, colors: null, archetype: null, updatedBy: null, updatedAt: null, ...over
});

interface PersonaFixture {
  id: string;
  name: string;
  description: string | null;
  pains: string | null;
  desires: string | null;
  objections: string | null;
  status: 'active' | 'archived';
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
}

const donaMaria: PersonaFixture = {
  id: 'dddddddd-1111-4111-8111-111111111111',
  name: 'Dona Maria',
  description: 'Dona da padaria',
  pains: 'Pouco tempo',
  desires: 'Clientes fiéis',
  objections: 'Preço',
  status: 'active',
  updatedBy: null,
  updatedAt: null
};
const donaAposentada: PersonaFixture = {
  ...donaMaria,
  id: 'eeeeeeee-2222-4222-8222-222222222222',
  name: 'Dona Aposentada',
  description: 'Persona antiga',
  status: 'archived'
};

const ANY_USER = { id: 'ffffffff-1111-4111-8111-111111111111', name: 'Ana' };

const studyOf = (over: Partial<{ filled: number; sections: SectionFixture[]; personas: PersonaFixture[] }> = {}) => ({
  filled: 5,
  sections: [
    sectionOf('branding', { body: 'Marca acolhedora do bairro', updatedBy: ANY_USER, updatedAt: '2026-10-12T12:00:00.000Z' }),
    sectionOf('tone_of_voice'),
    sectionOf('colors', { colors: [{ name: 'Vinho', hex: '#7A1F2B' }, { name: 'Creme', hex: '#F3E9DC' }] }),
    sectionOf('positioning'),
    sectionOf('archetype', { archetype: 'caregiver' }),
    sectionOf('personas'),
    sectionOf('observations')
  ],
  personas: [donaMaria, donaAposentada],
  ...over
});

interface Scenario {
  readonly permissions?: readonly string[];
  readonly client?: () => Response | Promise<Response>;
  readonly study?: () => Response | Promise<Response>;
  readonly putSection?: (sectionKey: string, body: unknown) => Response | Promise<Response>;
  readonly createPersona?: (body: unknown) => Response | Promise<Response>;
  readonly patchPersona?: (personaId: string, body: unknown) => Response | Promise<Response>;
  readonly archivePersona?: (personaId: string) => Response | Promise<Response>;
  readonly unarchivePersona?: (personaId: string) => Response | Promise<Response>;
}

/** Behaves like the real API: the brand-study routes of #127 plus the detail of #124. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const permissions = scenario.permissions ?? ADMIN_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(permissions));
    const section = /\/agencies\/([^/]+)\/clients\/([^/]+)\/brand-study\/sections\/([^/]+)$/.exec(path);
    if (section !== null && method === 'PUT') {
      if (scenario.putSection === undefined) throw new Error(`unexpected PUT ${url}`);
      return scenario.putSection(section[3]!, JSON.parse(String(init?.body)));
    }
    const study = /\/agencies\/([^/]+)\/clients\/([^/]+)\/brand-study$/.exec(path);
    if (study !== null) return scenario.study?.() ?? json(studyOf());
    const personaStatus = /\/agencies\/([^/]+)\/clients\/([^/]+)\/personas\/([^/]+)\/(archive|unarchive)$/.exec(path);
    if (personaStatus !== null && method === 'POST') {
      if (personaStatus[4] === 'archive') {
        if (scenario.archivePersona === undefined) throw new Error(`unexpected archive ${url}`);
        return scenario.archivePersona(personaStatus[3]!);
      }
      if (scenario.unarchivePersona === undefined) throw new Error(`unexpected unarchive ${url}`);
      return scenario.unarchivePersona(personaStatus[3]!);
    }
    const persona = /\/agencies\/([^/]+)\/clients\/([^/]+)\/personas\/([^/]+)$/.exec(path);
    if (persona !== null && method === 'PATCH') {
      if (scenario.patchPersona === undefined) throw new Error(`unexpected PATCH ${url}`);
      return scenario.patchPersona(persona[3]!, JSON.parse(String(init?.body)));
    }
    const personas = /\/agencies\/([^/]+)\/clients\/([^/]+)\/personas$/.exec(path);
    if (personas !== null && method === 'POST') {
      if (scenario.createPersona === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.createPersona(JSON.parse(String(init?.body)));
    }
    const detail = /\/agencies\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (detail !== null) {
      return scenario.client?.() ?? (detail[2] === CLIENT_ID ? json(padaria) : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
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

const studyUrl = `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}/estudo-de-marca`;

const renderStudy = (impl: typeof fetch, entry = studyUrl) => {
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

/** The section card whose heading is `title`; every control lives inside its own card. */
const sectionCard = (container: HTMLElement, title: string): HTMLElement => {
  const headings = Array.from(container.querySelectorAll<HTMLElement>('.brand-section__header h3'));
  const heading = headings.find((element) => element.textContent === title);
  const card = heading?.closest<HTMLElement>('.brand-section');
  if (card === undefined || card === null) throw new Error(`The ${title} section was not rendered.`);
  return card;
};

describe('brand study tab (#138)', () => {
  it('renders the seven sections always present and in the SPEC order, with the counter', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('5 de 7 preenchidas')).toBeTruthy();
    const headings = Array.from(container.querySelectorAll('.brand-section__header h3')).map((element) => element.textContent);
    expect(headings).toEqual(['Branding', 'Tom de voz', 'Cores', 'Posicionamento', 'Arquétipo', 'Personas', 'Observações']);
    // Empty sections say so instead of disappearing; Branding, Cores and Arquétipo are filled.
    expect(screen.getAllByText('Ainda não preenchida')).toHaveLength(3);
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    expect(screen.getByText('Cuidador')).toBeTruthy();
    expect(screen.getByText('Vinho')).toBeTruthy();
    expect(screen.getByText('#7A1F2B')).toBeTruthy();
    // "editado por" carries the last editor and the agency day, never a UTC-sliced date.
    expect(screen.getByText('editado por Ana · 12/10')).toBeTruthy();
    // The conversations area of #142 is reserved, with no fake control or count.
    expect(screen.getByRole('heading', { name: 'Conversas' })).toBeTruthy();
    expect(screen.getByText('As conversas com o cliente sobre cada parte da marca aparecem aqui.')).toBeTruthy();
  });

  it('edits each section in place without reloading or closing the others', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar' }));
    const branding = within(sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    expect(branding.value).toBe('Marca acolhedora do bairro');

    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher' }));
    expect(within(sectionCard(container, 'Tom de voz')).getByRole('textbox', { name: 'Editar Tom de voz' })).toBeTruthy();
    // Both editors stay open, and opening them never refetches the study.
    expect(branding.value).toBe('Marca acolhedora do bairro');
    expect(calls.filter((call) => call.endsWith('/brand-study'))).toHaveLength(1);
  });

  it('keeps the typed text on a save error and lets the same edit be retried', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      putSection: (sectionKey, body) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        return json(sectionOf(sectionKey, { body: (body as { body: string }).body, updatedBy: ANY_USER, updatedAt: '2026-10-12T12:00:00.000Z' }));
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar' }));
    const textarea = within(sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Texto novo do branding' } });
    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));

    expect(await within(sectionCard(container, 'Branding')).findByText('Não foi possível salvar. Tente de novo.')).toBeTruthy();
    expect(textarea.value).toBe('Texto novo do branding');
    expect(screen.queryByText('private diagnostic')).toBeNull();

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(sectionCard(container, 'Branding')).findByText('Texto novo do branding')).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('updates the counter and "editado por" without a reload, and invalidates the General tab', async () => {
    let studyData = studyOf();
    let detailData = padaria;
    const { impl } = makeFetch({
      client: () => json(detailData),
      study: () => json(studyData),
      putSection: (sectionKey, body) => {
        const updated = sectionOf(sectionKey, {
          body: (body as { body: string }).body,
          updatedBy: ANY_USER,
          updatedAt: '2026-10-12T12:00:00.000Z'
        });
        studyData = { ...studyData, filled: 6, sections: studyData.sections.map((section) => (section.key === sectionKey ? updated : section)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 6 } };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('5 de 7 preenchidas')).toBeTruthy();

    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher' }));
    fireEvent.change(within(sectionCard(container, 'Tom de voz')).getByRole('textbox', { name: 'Editar Tom de voz' }), { target: { value: 'Falamos simples' } });
    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('6 de 7 preenchidas')).toBeTruthy();
    expect(within(sectionCard(container, 'Tom de voz')).getByText('editado por Ana · 12/10')).toBeTruthy();
    // The General tab's counter comes from the invalidated detail query, not a page reload.
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();
    expect(screen.getByText('6 de 7')).toBeTruthy();
  });

  it('sends only the colors, refuses a bad hex without a request and round-trips the list', async () => {
    const bodies: unknown[] = [];
    const { impl, calls } = makeFetch({
      putSection: (sectionKey, body) => {
        bodies.push(body);
        return json(sectionOf(sectionKey, { colors: (body as { colors: Array<{ name: string; hex: string }> }).colors }));
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: 'zzz' } });
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    expect(await within(sectionCard(container, 'Cores')).findByText('Cada cor precisa de um nome e de um código hexadecimal como #7A1F2B.')).toBeTruthy();
    expect(bodies).toEqual([]);
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);

    fireEvent.change(within(sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: '#112233' } });
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ colors: [{ name: 'Vinho', hex: '#112233' }, { name: 'Creme', hex: '#F3E9DC' }] }]));
  });

  it('edits the archetype by its Portuguese label and sends the key', async () => {
    const bodies: unknown[] = [];
    let studyData = studyOf();
    const { impl } = makeFetch({
      study: () => json(studyData),
      putSection: (sectionKey, body) => {
        bodies.push(body);
        const updated = sectionOf(sectionKey, { archetype: (body as { archetype: string }).archetype });
        studyData = { ...studyData, sections: studyData.sections.map((section) => (section.key === sectionKey ? updated : section)) };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(sectionCard(container, 'Arquétipo')).getByRole('combobox', { name: 'Arquétipo' }), { target: { value: 'hero' } });
    fireEvent.click(within(sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ archetype: 'hero' }]));
    expect(await within(sectionCard(container, 'Arquétipo')).findByText('Herói')).toBeTruthy();
  });

  it('keeps reading and opening personas for a reader role, with no editing control at all', async () => {
    const { impl } = makeFetch({ permissions: READER_PERMISSIONS });
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    expect(screen.getAllByText('Ainda não preenchida').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preencher' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'persona' })).toBeNull();
    // Reading the archived list is reading: the list opens, the Desarquivar action does not exist.
    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    expect(screen.getByText('Dona Aposentada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();

    // Opening a persona is reading, not editing: the detail shows the fields without its actions.
    fireEvent.click(screen.getByRole('button', { name: /Dona Maria/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Dona Maria' });
    expect(within(dialog).getByText('Dona da padaria')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Arquivar' })).toBeNull();
  });

  it('shows no editing control on an archived client, for anyone', async () => {
    const { impl } = makeFetch({ client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }) });
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preencher' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'persona' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();
  });

  it('creates a persona from the modal, refusing an empty name first', async () => {
    const bodies: unknown[] = [];
    let studyData = studyOf({ personas: [] });
    const { impl } = makeFetch({
      study: () => json(studyData),
      createPersona: (body) => {
        bodies.push(body);
        const created = { ...donaMaria, ...(body as object) };
        studyData = { ...studyData, personas: [created] };
        return json(created, 201);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Nenhuma persona ainda')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova persona' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Informe o nome da persona.')).toBeTruthy();
    expect(bodies).toEqual([]);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Dona Maria' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Dona da padaria' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));

    await waitFor(() => expect(bodies).toEqual([{ name: 'Dona Maria', description: 'Dona da padaria', pains: null, desires: null, objections: null }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: /Dona Maria/ })).toBeTruthy();
  });

  it('opens a persona with its four fields, edits only what changed and archives with confirmation', async () => {
    const patches: unknown[] = [];
    let studyData = studyOf();
    const { impl } = makeFetch({
      study: () => json(studyData),
      patchPersona: (personaId, body) => {
        patches.push({ personaId, body });
        const updated = { ...donaMaria, ...(body as object) };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      },
      archivePersona: (personaId) => {
        const updated = { ...donaMaria, status: 'archived' as const };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(screen.getByRole('button', { name: /Dona Maria/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Dona Maria' });
    expect(within(dialog).getByText('Dona da padaria')).toBeTruthy();
    expect(within(dialog).getByText('Pouco tempo')).toBeTruthy();
    expect(within(dialog).getByText('Clientes fiéis')).toBeTruthy();
    expect(within(dialog).getByText('Preço')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Dona da padaria e do bairro' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(patches).toEqual([{ personaId: donaMaria.id, body: { description: 'Dona da padaria e do bairro' } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Archiving asks first, saying what happens to the portal and to the conversations.
    fireEvent.click(await screen.findByRole('button', { name: /Dona Maria/ }));
    const reopened = await screen.findByRole('dialog', { name: 'Dona Maria' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Arquivar' }));
    const description = await screen.findByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.');
    const confirm = description.closest('.ui-dialog');
    if (confirm === null) throw new Error('The archive confirmation was not rendered.');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));

    // The active grid loses her; she moves into the collapsed Arquivadas list.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Dona Maria/ })).toBeNull());
    expect(screen.getByRole('button', { name: 'Arquivadas (2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (2)' }));
    const archived = container.querySelector<HTMLElement>('.brand-personas__archived');
    if (archived === null) throw new Error('The archived list was not rendered.');
    expect(within(archived).getByText('Dona Maria')).toBeTruthy();
    expect(within(archived).getByRole('button', { name: 'Desarquivar Dona Maria' })).toBeTruthy();
    expect(within(archived).getByRole('button', { name: 'Desarquivar Dona Aposentada' })).toBeTruthy();
  });

  it('reactivates an archived persona from the collapsed list', async () => {
    let studyData = studyOf({ personas: [donaMaria, donaAposentada] });
    const { impl } = makeFetch({
      study: () => json(studyData),
      unarchivePersona: (personaId) => {
        const updated = { ...donaAposentada, status: 'active' as const };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desarquivar Dona Aposentada' }));

    // Back in the active grid; the collapsed affordance disappears with the empty archived list.
    expect(await screen.findByRole('button', { name: /Dona Aposentada/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Arquivadas (1)' })).toBeNull());
  });

  it('draws a skeleton of the seven sections while the study loads', async () => {
    const { impl } = makeFetch({ study: () => new Promise<Response>(() => undefined) });
    const { container } = renderStudy(impl);

    await waitFor(() => expect(container.querySelectorAll('.brand-section-skeleton')).toHaveLength(7));
  });

  it('offers a retry when the study fails, without echoing the API message', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      study: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : json(studyOf());
      }
    });
    renderStudy(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar o estudo de marca. Tente de novo.');
    expect(alert.textContent).not.toContain('private diagnostic');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Marca acolhedora do bairro')).toBeTruthy();
  });
});
