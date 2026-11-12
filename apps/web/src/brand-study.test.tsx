// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras, emptyPersonaProfile, type PersonaProfileFixture } from './client-registration-fixture.js';
import { createConversationApi } from './conversation-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const agencyMe = (permissions: readonly string[], readOnly = false) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly }, permissions
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
  ...clientRegistrationExtras,
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

interface PersonaFixture extends PersonaProfileFixture {
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
  ...emptyPersonaProfile(),
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
// 01:30 UTC of the 13th is 22:30 of the 12th in São Paulo: the label must read 12/10.
const BRANDING_EDITED_AT = '2026-10-13T01:30:00.000Z';

const studyOf = (over: Partial<{ filled: number; sections: SectionFixture[]; personas: PersonaFixture[] }> = {}) => ({
  filled: 5,
  sections: [
    sectionOf('branding', { body: 'Marca acolhedora do bairro', updatedBy: ANY_USER, updatedAt: BRANDING_EDITED_AT }),
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
  /** The plan is read only (a trial that ended): every write control stays on screen but blocked. */
  readonly planReadOnly?: boolean;
  readonly client?: () => Response | Promise<Response>;
  readonly study?: () => Response | Promise<Response>;
  readonly putSection?: (sectionKey: string, body: unknown) => Response | Promise<Response>;
  readonly createPersona?: (body: unknown) => Response | Promise<Response>;
  readonly patchPersona?: (personaId: string, body: unknown) => Response | Promise<Response>;
  readonly archivePersona?: (personaId: string) => Response | Promise<Response>;
  readonly unarchivePersona?: (personaId: string) => Response | Promise<Response>;
  /** The conversation routes of #128; an empty one answers when the scenario brings none. */
  readonly conversation?: ReturnType<typeof createConversationApi>;
}

/** Behaves like the real API: the brand-study routes of #127 plus the detail of #124. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const permissions = scenario.permissions ?? ADMIN_PERMISSIONS;
  const conversation = scenario.conversation ?? createConversationApi({ side: 'agency', clientId: CLIENT_ID });
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const talked = conversation.handle(url, method, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    if (talked !== undefined) return talked;
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(permissions, scenario.planReadOnly ?? false));
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
  state: unknown;
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function Probe({ probe }: { probe: ProbeTarget }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

const studyUrl = `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}/estudo-de-marca`;

const renderStudy = (impl: typeof fetch, entry: string | { pathname: string; search?: string; state?: unknown } = studyUrl) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', search: '', state: undefined, navigate: () => undefined };
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

/** The panel of one section: the card with its controls and the conversations beside it. Only the open one is reachable. */
const panelOf = (container: HTMLElement, title: string): HTMLElement => {
  const panel = container.querySelector<HTMLElement>(`section.brand-panel[aria-label="${title}"]`);
  if (panel === null) throw new Error(`The ${title} section was not rendered.`);
  return panel;
};

/** Opens a section through its link in the index, the way a person does. */
const openSection = async (title: string): Promise<void> => {
  const link = await screen.findByRole('link', { name: new RegExp(`^${title}(\\s|$)`) });
  fireEvent.click(link);
  await waitFor(() => expect(link.getAttribute('aria-current')).toBe('page'));
};

const sectionCard = async (container: HTMLElement, title: string): Promise<HTMLElement> => {
  await openSection(title);
  return panelOf(container, title);
};

/** Opens Personas and then one persona's profile: the element that holds her name as its heading. */
const openPersona = async (name: string): Promise<HTMLElement> => {
  await openSection('Personas');
  fireEvent.click(await screen.findByRole('link', { name: new RegExp(name) }));
  const heading = await screen.findByRole('heading', { level: 3, name });
  const profile = heading.closest<HTMLElement>('.brand-persona');
  if (profile === null) throw new Error('The persona profile was not rendered.');
  return profile;
};

describe('brand study tab (#138)', () => {
  const SECTIONS = ['Branding', 'Tom de voz', 'Cores', 'Posicionamento', 'Arquétipo', 'Personas', 'Observações'];

  it('lists the seven sections in the index in the SPEC order, says which are filled and shows only the open one', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('5 de 7 preenchidas')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Seções do estudo de marca' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Branding preenchida',
      'Tom de voz não preenchida',
      'Cores preenchida',
      'Posicionamento não preenchida',
      'Arquétipo preenchida',
      'Personas preenchida',
      'Observações não preenchida'
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'branding', 'tom-de-voz', 'cores', 'posicionamento', 'arquetipo', 'personas', 'observacoes'
    ].map((slug) => `${studyUrl}?secao=${slug}`));
    // Without a parameter the first section is open: one panel on screen, one heading of a section.
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['page', null, null, null, null, null, null]);
    expect(container.querySelectorAll('.brand-panel:not([hidden])')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual(['Branding']);
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    // "editado por" carries the last editor and the agency day: 01:30Z of the 13th is 12/10 in SP.
    expect(within(panelOf(container, 'Branding')).getByText('editado por Ana · 12/10')).toBeTruthy();
  });

  it('opens each section from the index with its content and its own conversations area', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    for (const label of SECTIONS) {
      const panel = await sectionCard(container, label);
      expect(container.querySelectorAll('.brand-panel:not([hidden])')).toHaveLength(1);
      expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual([label]);
      // Every section carries its own conversations area, named after it, with the way to start one.
      const area = await within(panel).findByRole('region', { name: `Conversas sobre ${label}` });
      await waitFor(() => expect(within(area).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy());
      expect(within(area).getByRole('button', { name: `Nova conversa sobre ${label}` })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /^Nova conversa sobre/ })).toHaveLength(1);
    }

    // Empty sections say so instead of disappearing; Branding, Cores and Arquétipo are filled.
    for (const label of ['Tom de voz', 'Posicionamento', 'Observações']) {
      expect(within(await sectionCard(container, label)).getByText('Ainda não preenchida')).toBeTruthy();
    }
    expect(within(await sectionCard(container, 'Arquétipo')).getByText('Cuidador')).toBeTruthy();
    const colors = await sectionCard(container, 'Cores');
    expect(within(colors).getByText('Vinho')).toBeTruthy();
    expect(within(colors).getByText('#7A1F2B')).toBeTruthy();
    expect(within(colors).getByText('Creme')).toBeTruthy();
    expect(within(colors).getByText('#F3E9DC')).toBeTruthy();
  });

  it('shows the colours as swatches painted with their code, and the archetype as the highlight of its card', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const colors = await sectionCard(container, 'Cores');
    const swatches = Array.from(colors.querySelectorAll<HTMLElement>('.brand-colors__swatch'));
    expect(swatches.map((swatch) => swatch.style.background)).toEqual(['rgb(122, 31, 43)', 'rgb(243, 233, 220)']);
    expect(colors.querySelector('.brand-colors__item')?.textContent).toBe('Vinho#7A1F2B');

    const archetype = within(await sectionCard(container, 'Arquétipo')).getByText('Cuidador');
    expect(archetype.className).toBe('brand-archetype');
  });

  it('gives every edit control a name that says its target', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const names: ReadonlyArray<readonly [string, string]> = [
      ['Branding', 'Editar Branding'],
      ['Tom de voz', 'Preencher Tom de voz'],
      ['Cores', 'Editar Cores'],
      ['Posicionamento', 'Preencher Posicionamento'],
      ['Arquétipo', 'Editar Arquétipo'],
      ['Personas', 'Nova persona'],
      ['Observações', 'Preencher Observações']
    ];
    for (const [label, control] of names) {
      expect(within(await sectionCard(container, label)).getByRole('button', { name: control })).toBeTruthy();
    }
  });

  it('keeps the editor of a section open, with its draft, while another section is visited', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    const branding = within(panelOf(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    expect(branding.value).toBe('Marca acolhedora do bairro');
    fireEvent.change(branding, { target: { value: 'Rascunho que não pode sumir' } });

    fireEvent.click(within(await sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
    expect(within(panelOf(container, 'Tom de voz')).getByRole('textbox', { name: 'Editar Tom de voz' })).toBeTruthy();

    // Back in Branding the same editor is still open with what was typed; no visit refetched the study.
    const again = within(await sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    expect(again).toBe(branding);
    expect(again.value).toBe('Rascunho que não pode sumir');
    expect(calls.filter((call) => call.endsWith('/brand-study'))).toHaveLength(1);
  });

  it('puts the focus back on the field that a refused section edit is about, with no alert of its own', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
    const card = await sectionCard(container, 'Tom de voz');
    const editor = within(card).getByRole('textbox', { name: 'Editar Tom de voz' });
    // The editor takes the focus on its own a tick after it opens: wait for that before moving away from it.
    await waitFor(() => expect(document.activeElement).toBe(editor));
    within(card).getByRole('button', { name: 'Salvar' }).focus();
    fireEvent.click(within(card).getByRole('button', { name: 'Salvar' }));

    const message = await within(card).findByText('Escreva o conteúdo da seção.');
    expect(document.activeElement).toBe(editor);
    expect(editor.getAttribute('aria-describedby')).toBe(message.id);
    expect(message.getAttribute('role')).toBeNull();
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(calls.some((call) => call.startsWith('PUT') || call.startsWith('PATCH'))).toBe(false);
  });

  it('puts the focus on the archetype list when none is chosen', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Editar Arquétipo' }));
    const card = await sectionCard(container, 'Arquétipo');
    const select = within(card).getByLabelText('Arquétipo');
    fireEvent.change(select, { target: { value: '' } });
    within(card).getByRole('button', { name: 'Salvar' }).focus();
    fireEvent.click(within(card).getByRole('button', { name: 'Salvar' }));

    await within(card).findByText('Escolha um arquétipo da lista.');
    expect(document.activeElement).toBe(select);
  });

  it('keeps the typed text on a save error and lets the same edit be retried', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      putSection: (sectionKey, body) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        return json(sectionOf(sectionKey, { body: (body as { body: string }).body, updatedBy: ANY_USER, updatedAt: BRANDING_EDITED_AT }));
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    const textarea = within(panelOf(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Texto novo do branding' } });
    fireEvent.click(within(panelOf(container, 'Branding')).getByRole('button', { name: 'Salvar' }));

    expect(await within(panelOf(container, 'Branding')).findByText('Não foi possível salvar. Tente de novo.')).toBeTruthy();
    expect(textarea.value).toBe('Texto novo do branding');
    expect(screen.queryByText('private diagnostic')).toBeNull();

    fireEvent.click(within(panelOf(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(panelOf(container, 'Branding')).findByText('Texto novo do branding')).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('maps a 400 from the section save and a 409 of an archived client to their messages', async () => {
    const { impl } = makeFetch({
      putSection: (sectionKey, body) => {
        if ((body as { body: string }).body === 'forcar 400') {
          return json({ error: { code: 'VALIDATION_ERROR', message: 'private diagnostic' } }, 400);
        }
        return json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    fireEvent.change(within(await sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }), { target: { value: 'forcar 400' } });
    fireEvent.click(within(await sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(await sectionCard(container, 'Branding')).findByText('Revise os dados informados.')).toBeTruthy();

    fireEvent.change(within(await sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }), { target: { value: 'outro texto' } });
    fireEvent.click(within(await sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(await sectionCard(container, 'Branding')).findByText('Cliente arquivado: o estudo de marca está somente leitura.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
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
          updatedAt: BRANDING_EDITED_AT
        });
        studyData = { ...studyData, filled: 6, sections: studyData.sections.map((section) => (section.key === sectionKey ? updated : section)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 6 } };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('5 de 7 preenchidas')).toBeTruthy();

    fireEvent.click(within(await sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
    fireEvent.change(within(await sectionCard(container, 'Tom de voz')).getByRole('textbox', { name: 'Editar Tom de voz' }), { target: { value: 'Falamos simples' } });
    fireEvent.click(within(await sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('6 de 7 preenchidas')).toBeTruthy();
    expect(within(await sectionCard(container, 'Tom de voz')).getByText('editado por Ana · 12/10')).toBeTruthy();
    // The General tab's counter comes from the invalidated detail query, not a page reload.
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();
    expect(screen.getByText('6 de 7')).toBeTruthy();
  });

  it('refuses a bad hex without a request, moves the counter and the General tab on save, and sends colors: [] on the last removal', async () => {
    const bodies: unknown[] = [];
    // Starting with an empty Cores keeps the section unfilled, so saving it moves `filled` and the
    // counter assertion proves the study + detail invalidation (review of #388 r3).
    let studyData = { ...studyOf(), filled: 4, sections: studyOf().sections.map((section) => (section.key === 'colors' ? sectionOf('colors') : section)) };
    let detailData = { ...padaria, summary: { ...padaria.summary, brandStudyFilled: 4 } };
    const { impl, calls } = makeFetch({
      client: () => json(detailData),
      study: () => json(studyData),
      putSection: (sectionKey, body) => {
        bodies.push(body);
        const colors = (body as { colors: Array<{ name: string; hex: string }> }).colors;
        const updated = sectionOf(sectionKey, { colors, updatedBy: ANY_USER, updatedAt: BRANDING_EDITED_AT });
        const filled = colors.length === 0 ? 4 : 5;
        studyData = { ...studyData, filled, sections: studyData.sections.map((section) => (section.key === sectionKey ? updated : section)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: filled } };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('4 de 7 preenchidas')).toBeTruthy();
    expect(within(await sectionCard(container, 'Cores')).getByText('Ainda não preenchida')).toBeTruthy();

    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Preencher Cores' }));
    fireEvent.change(within(await sectionCard(container, 'Cores')).getByLabelText('Nome da cor 1'), { target: { value: 'Vinho' } });
    fireEvent.change(within(await sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: 'zzz' } });
    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    expect(await within(await sectionCard(container, 'Cores')).findByText('Cada cor precisa de um nome e de um código hexadecimal como #7A1F2B.')).toBeTruthy();
    expect(bodies).toEqual([]);
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);

    // Fixing the hex saves: the editor closes over the new list, the last editor shows and the
    // counter moves (from the invalidated study and detail, not from a local guess).
    fireEvent.change(within(await sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: '#112233' } });
    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ colors: [{ name: 'Vinho', hex: '#112233' }] }]));
    await waitFor(() => expect(within(panelOf(container, 'Cores')).queryByLabelText('Nome da cor 1')).toBeNull());
    expect(within(await sectionCard(container, 'Cores')).getByText('#112233')).toBeTruthy();
    expect(within(await sectionCard(container, 'Cores')).getByText('editado por Ana · 12/10')).toBeTruthy();
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();

    // Back to the study, removing the only row is clearing the section: it travels as colors: []
    // and the counter returns.
    fireEvent.click(screen.getByRole('link', { name: 'Estudo de marca' }));
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Editar Cores' }));
    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Remover a cor 1' }));
    fireEvent.click(within(await sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ colors: [] });
    expect(await screen.findByText('4 de 7 preenchidas')).toBeTruthy();
    await waitFor(() => expect(within(panelOf(container, 'Cores')).getByText('Ainda não preenchida')).toBeTruthy());
  });

  // specs/clientes.md section 3: the archetype is one of twelve; each pair is written out by value
  // so the screen cannot drift together with the contract constant (issue #464).
  const SPEC_ARCHETYPES: readonly (readonly [string, string])[] = [
  ['innocent', 'Inocente'],
  ['sage', 'Sábio'],
  ['explorer', 'Explorador'],
  ['outlaw', 'Fora-da-lei'],
  ['magician', 'Mago'],
  ['hero', 'Herói'],
  ['lover', 'Amante'],
  ['jester', 'Bobo da corte'],
  ['everyman', 'Cara comum'],
  ['caregiver', 'Cuidador'],
  ['ruler', 'Governante'],
  ['creator', 'Criador']
];

  it('offers exactly the twelve archetypes of the SPEC, each sending its key and showing its Portuguese label', async () => {
    const { impl } = makeFetch({ client: () => json(padaria), study: () => json({ ...studyOf(), sections: studyOf().sections.map((section) => (section.key === 'archetype' ? sectionOf('archetype') : section)) }) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(await sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Preencher Arquétipo' }));
    const select = within(await sectionCard(container, 'Arquétipo')).getByRole('combobox', { name: 'Arquétipo' });
    const options = Array.from(select.querySelectorAll('option')).filter((option) => option.value !== '');
    expect(options.map((option) => [option.value, option.textContent])).toEqual(SPEC_ARCHETYPES.map(([key, label]) => [key, label]));
  });

  it.each(SPEC_ARCHETYPES)('shows the archetype %s as %s', async (key, label) => {
    const study = { ...studyOf(), sections: studyOf().sections.map((section) => (section.key === 'archetype' ? sectionOf('archetype', { archetype: key }) : section)) };
    const { impl } = makeFetch({ client: () => json(padaria), study: () => json(study) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(within(await sectionCard(container, 'Arquétipo')).getByText(label)).toBeTruthy();
  });

  it('edits the archetype by its Portuguese label, sends the key, moves the counter and the General tab', async () => {
    const bodies: unknown[] = [];
    // Empty archetype means an unfilled section: saving it moves `filled` (review of #388 r3).
    let studyData = { ...studyOf(), filled: 4, sections: studyOf().sections.map((section) => (section.key === 'archetype' ? sectionOf('archetype') : section)) };
    let detailData = { ...padaria, summary: { ...padaria.summary, brandStudyFilled: 4 } };
    const { impl } = makeFetch({
      client: () => json(detailData),
      study: () => json(studyData),
      putSection: (sectionKey, body) => {
        bodies.push(body);
        const updated = sectionOf(sectionKey, { archetype: (body as { archetype: string }).archetype, updatedBy: ANY_USER, updatedAt: BRANDING_EDITED_AT });
        studyData = { ...studyData, filled: 5, sections: studyData.sections.map((section) => (section.key === sectionKey ? updated : section)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 5 } };
        return json(updated);
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('4 de 7 preenchidas')).toBeTruthy();

    fireEvent.click(within(await sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Preencher Arquétipo' }));
    fireEvent.change(within(await sectionCard(container, 'Arquétipo')).getByRole('combobox', { name: 'Arquétipo' }), { target: { value: 'hero' } });
    fireEvent.click(within(await sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ archetype: 'hero' }]));
    expect(await within(await sectionCard(container, 'Arquétipo')).findByText('Herói')).toBeTruthy();
    expect(within(await sectionCard(container, 'Arquétipo')).queryByRole('combobox')).toBeNull();
    expect(within(await sectionCard(container, 'Arquétipo')).getByText('editado por Ana · 12/10')).toBeTruthy();
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();
  });

  it('puts the focus on the name when the edit of a persona is refused', async () => {
    const { impl } = makeFetch();
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    const dialog = await openPersona('Dona Maria');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nome' }), { target: { value: '   ' } });
    within(dialog).getByRole('button', { name: 'Salvar' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await within(dialog).findByText('Informe o nome da persona.');
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Nome' }));
  });

  it('keeps reading and opening personas for a reader role, with no editing control at all', async () => {
    const { impl } = makeFetch({ permissions: READER_PERMISSIONS });
    const { container } = renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    // No section of the index offers a way to write, whichever is open.
    for (const label of SECTIONS) {
      await openSection(label);
      expect(screen.queryByRole('button', { name: /^Editar/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Preencher/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Nova persona' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Nova conversa/ })).toBeNull();
    }
    expect(within(await sectionCard(container, 'Tom de voz')).getByText('Ainda não preenchida')).toBeTruthy();

    // Reading the archived list is reading: the list opens, the Desarquivar action does not exist.
    await openSection('Personas');
    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    expect(screen.getByText('Dona Aposentada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();

    // Opening a persona is reading, not editing: the profile shows the fields without its actions.
    const profile = await openPersona('Dona Maria');
    expect(within(profile).getByText('Dona da padaria')).toBeTruthy();
    const area = within(profile).getByRole('region', { name: 'Conversas sobre Dona Maria' });
    await waitFor(() => expect(within(area).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy());
    expect(within(area).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
    expect(within(profile).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(profile).queryByRole('button', { name: 'Arquivar' })).toBeNull();
  });

  it('shows no editing control on an archived client, even inside a persona and the archived list', async () => {
    const { impl } = makeFetch({ client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }) });
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    for (const label of SECTIONS) {
      await openSection(label);
      expect(screen.queryByRole('button', { name: /^Editar/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Preencher/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Nova persona' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Nova conversa/ })).toBeNull();
    }

    await openSection('Personas');
    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    expect(screen.getByText('Dona Aposentada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();

    const profile = await openPersona('Dona Maria');
    expect(within(profile).getByText('Dona da padaria')).toBeTruthy();
    expect(within(profile).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(profile).queryByRole('button', { name: 'Arquivar' })).toBeNull();
  });

  it('creates a persona from the modal, refusing an empty name and a name over 120 bytes first', async () => {
    const bodies: unknown[] = [];
    let studyData = studyOf({ personas: [], filled: 4 });
    let detailData = { ...padaria, summary: { ...padaria.summary, brandStudyFilled: 4 } };
    const { impl } = makeFetch({
      client: () => json(detailData),
      study: () => json(studyData),
      createPersona: (body) => {
        bodies.push(body);
        const created = { ...donaMaria, ...(body as object) };
        // The first active persona makes the section count: `filled` moves (SPEC §3).
        studyData = { ...studyData, filled: 5, personas: [created] };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 5 } };
        return json(created, 201);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    await openSection('Personas');
    expect(screen.getByText('Nenhuma persona ainda')).toBeTruthy();
    expect(screen.getByText('4 de 7 preenchidas')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Nova persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova persona' });
    within(dialog).getByRole('button', { name: 'Criar persona' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Informe o nome da persona.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Nome' }));
    expect(bodies).toEqual([]);

    const name = within(dialog).getByRole('textbox', { name: 'Nome' });
    fireEvent.change(name, { target: { value: 'x'.repeat(121) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('O nome da persona pode ter no máximo 120 bytes.')).toBeTruthy();
    expect(bodies).toEqual([]);

    fireEvent.change(name, { target: { value: 'Dona Maria' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Dona da padaria' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));

    await waitFor(() => expect(bodies).toEqual([{ name: 'Dona Maria', description: 'Dona da padaria', pains: null, desires: null, objections: null }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('link', { name: /Dona Maria/ })).toBeTruthy();
    // The counter here and on the General tab follow the invalidated study and detail.
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();
  });

  it('keeps the create modal draft on server errors and maps 400, 403 and CLIENT_ARCHIVED', async () => {
    const { impl } = makeFetch({
      createPersona: (body) => {
        const name = (body as { name: string }).name;
        if (name === 'Nome ruim') {
          return json({ error: { code: 'VALIDATION_ERROR', message: 'private diagnostic', details: { issues: [{ path: 'name', code: 'custom' }] } } }, 400);
        }
        if (name === 'Sem permissão') return json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403);
        if (name === 'Cliente arquivado') return json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409);
        return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    await openSection('Personas');
    fireEvent.click(screen.getByRole('button', { name: 'Nova persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova persona' });
    const name = within(dialog).getByRole('textbox', { name: 'Nome' });

    fireEvent.change(name, { target: { value: 'Nome ruim' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('O nome contém caracteres que não são aceitos.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');

    fireEvent.change(name, { target: { value: 'Sem permissão' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Você não tem permissão para editar o estudo de marca.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');

    fireEvent.change(name, { target: { value: 'Cliente arquivado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Cliente arquivado: o estudo de marca está somente leitura.')).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Falha geral' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Não foi possível salvar. Tente de novo.')).toBeTruthy();
    // The typed name survives every refusal.
    expect((within(dialog).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement).value).toBe('Falha geral');
  });

  it('opens a persona as a profile: identity, one card for each field, edits only what changed and archives with confirmation', async () => {
    const patches: unknown[] = [];
    let studyData = studyOf();
    let detailData = padaria;
    let detailGets = 0;
    const { impl } = makeFetch({
      client: () => { detailGets += 1; return json(detailData); },
      study: () => json(studyData),
      patchPersona: (personaId, body) => {
        patches.push({ personaId, body });
        const updated = { ...donaMaria, ...(body as object) };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      },
      archivePersona: (personaId) => {
        const updated = { ...donaMaria, status: 'archived' as const };
        // No active persona is left, so the section stops counting (SPEC §3).
        studyData = { ...studyData, filled: 4, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 4 } };
        return json(updated);
      }
    });
    const { container, probe } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const profile = await openPersona('Dona Maria');
    expect(probe.search).toBe(`?secao=personas&persona=${donaMaria.id}`);
    expect(profile.querySelector('.brand-persona__identity .ui-avatar')?.textContent).toBe('DM');
    expect(within(profile).getByText('Dona da padaria')).toBeTruthy();
    // Pains, desires and objections are one card each, titled by the field.
    const cards = Array.from(profile.querySelectorAll<HTMLElement>('.brand-persona__card'));
    expect(cards.map((card) => [card.querySelector('h4')?.textContent, card.querySelector('p')?.textContent])).toEqual([
      ['Dores', 'Pouco tempo'],
      ['Desejos', 'Clientes fiéis'],
      ['Objeções', 'Preço']
    ]);
    const area = within(profile).getByRole('region', { name: 'Conversas sobre Dona Maria' });
    await waitFor(() => expect(within(area).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy());
    expect(within(area).getByRole('button', { name: 'Nova conversa sobre Dona Maria' })).toBeTruthy();

    fireEvent.click(within(profile).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(profile).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Dona da padaria e do bairro' } });
    fireEvent.click(within(profile).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(patches).toEqual([{ personaId: donaMaria.id, body: { description: 'Dona da padaria e do bairro' } }]));
    // The profile stays open on the same persona and reads from the invalidated study; the detail (General) was refetched too.
    expect(await screen.findByText('Dona da padaria e do bairro')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Descrição' })).toBeNull();
    expect(probe.search).toBe(`?secao=personas&persona=${donaMaria.id}`);
    await waitFor(() => expect(detailGets).toBeGreaterThan(1));

    // Archiving asks first, saying what happens to the portal and to the conversations; nothing is sent before.
    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    const description = await screen.findByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.');
    const confirm = description.closest('.ui-dialog');
    if (confirm === null) throw new Error('The archive confirmation was not rendered.');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));

    // The profile is gone, back on the grid: the active list loses her and she moves into the collapsed Arquivadas list.
    await waitFor(() => expect(probe.search).toBe('?secao=personas'));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Dona Maria/ })).toBeNull());
    expect(screen.queryByRole('heading', { level: 3, name: 'Dona Maria' })).toBeNull();
    const archivedToggle = screen.getByRole('button', { name: 'Arquivadas (2)' });
    expect(archivedToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(archivedToggle);
    const archived = container.querySelector<HTMLElement>('.brand-personas__archived');
    if (archived === null) throw new Error('The archived list was not rendered.');
    expect(within(archived).getByText('Dona Maria')).toBeTruthy();
    expect(within(archived).getByRole('button', { name: 'Desarquivar Dona Maria' })).toBeTruthy();
    expect(within(archived).getByRole('button', { name: 'Desarquivar Dona Aposentada' })).toBeTruthy();
    // Archiving the last active persona moves the counter, here and on the General tab.
    expect(await screen.findByText('4 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('4 de 7')).toBeTruthy();
  });

  it('keeps the edit draft on a persona save error, with the server message mapped', async () => {
    const { impl } = makeFetch({
      patchPersona: () => json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const profile = await openPersona('Dona Maria');
    fireEvent.click(within(profile).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(profile).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Rascunho que não pode sumir' } });
    fireEvent.click(within(profile).getByRole('button', { name: 'Salvar' }));

    expect(await within(profile).findByText('Não foi possível salvar. Tente de novo.')).toBeTruthy();
    expect(profile.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('heading', { level: 3, name: 'Dona Maria' })).toBeTruthy();
    // The editor must still be open: re-query the live form and check the draft stayed there
    // (review of #388 r3 — a detached node would keep its old value).
    const liveDraft = within(profile).getByRole('textbox', { name: 'Descrição' }) as HTMLTextAreaElement;
    expect(liveDraft.value).toBe('Rascunho que não pode sumir');
    expect(within(profile).getByRole('button', { name: 'Salvar' })).toBeTruthy();
  });

  it('maps an archive refusal and keeps the retry available', async () => {
    let attempts = 0;
    let studyData = studyOf();
    const { impl } = makeFetch({
      study: () => json(studyData),
      archivePersona: (personaId) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409);
        const updated = { ...donaMaria, status: 'archived' as const };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const profile = await openPersona('Dona Maria');
    const confirmArchive = async (): Promise<void> => {
      fireEvent.click(within(profile).getByRole('button', { name: 'Arquivar' }));
      const description = await screen.findByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.');
      const confirm = description.closest('.ui-dialog');
      if (confirm === null) throw new Error('The archive confirmation was not rendered.');
      fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));
    };
    await confirmArchive();

    expect(await within(profile).findByText('Cliente arquivado: o estudo de marca está somente leitura.')).toBeTruthy();
    expect(profile.textContent).not.toContain('private diagnostic');

    // The retry that lands archives the persona.
    await confirmArchive();
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Dona Maria/ })).toBeNull());
  });

  it('reactivates an archived persona, reports an unarchive failure and moves the counters', async () => {
    // Only an archived persona: unarchiving it brings the section back to filled (SPEC §3).
    let studyData = studyOf({ personas: [donaAposentada], filled: 4 });
    let detailData = { ...padaria, summary: { ...padaria.summary, brandStudyFilled: 4 } };
    let attempts = 0;
    const { impl } = makeFetch({
      client: () => json(detailData),
      study: () => json(studyData),
      unarchivePersona: (personaId) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403);
        const updated = { ...donaAposentada, status: 'active' as const };
        studyData = { ...studyData, filled: 5, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        detailData = { ...detailData, summary: { ...detailData.summary, brandStudyFilled: 5 } };
        return json(updated);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('4 de 7 preenchidas')).toBeTruthy();
    await openSection('Personas');

    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desarquivar Dona Aposentada' }));
    expect(await screen.findByText('Você não tem permissão para editar o estudo de marca.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Desarquivar Dona Aposentada' }));
    expect(await screen.findByRole('link', { name: /Dona Aposentada/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Arquivadas (1)' })).toBeNull());
    // The counter here and on the General tab follow the invalidated study and detail.
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();
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
    // The failure kind: the empty sections and personas are never drawn for a study that did not answer.
    expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
    expect(screen.queryByText('Nenhuma persona ainda')).toBeNull();
    const attemptsBeforeRetry = attempts;
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Marca acolhedora do bairro')).toBeTruthy();
    expect(attempts).toBeGreaterThan(attemptsBeforeRetry);
  });

  it('keeps the retry busy and in place while it repeats, and a second click sends no second read', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({
      study: async () => {
        reads += 1;
        if (reads <= 2) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
        await held;
        return json(studyOf());
      }
    });
    renderStudy(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    const retry = within(alert).getByRole('button', { name: 'Tentar de novo' });
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByRole('alert')).toBe(alert);
    expect(document.activeElement).toBe(retry);
    const readsInFlight = reads;
    fireEvent.click(retry);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(readsInFlight);

    release();
    expect(await screen.findByText('Marca acolhedora do bairro')).toBeTruthy();
  });
});

describe('brand study conversations (#142)', () => {
  const NOW_LATE = '2026-10-13T01:30:00.000Z';

  it('opens a conversation on exactly the section it was asked on, and the write moves the Geral summary and the roster', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    let detailData = padaria;
    const { impl, calls } = makeFetch({ conversation, client: () => json(detailData) });
    const { container, queryClient } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    // A cached roster page and the detail of the Geral tab: both must be read again after the write.
    const rosterKey = ['agency', AGENCY_A, 'clients', { page: 1, search: '', status: 'active' }];
    queryClient.setQueryData(rosterKey, { data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    const detailReads = () => calls.filter((call) => call === `GET /agencies/${AGENCY_A}/clients/${CLIENT_ID}`).length;
    const before = detailReads();

    const tone = await sectionCard(container, 'Tom de voz');
    fireEvent.click(within(tone).getByRole('button', { name: 'Nova conversa sobre Tom de voz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova conversa sobre Tom de voz' });
    detailData = { ...padaria, summary: { ...padaria.summary, threadsAwaitingAgency: 1 } };
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'O tom está formal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Iniciar conversa' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(conversation.bodies).toEqual([{ subject: { sectionKey: 'tone_of_voice' }, body: 'O tom está formal' }]);
    await within(tone).findByText('O tom está formal');
    // Only the section it was opened on shows it; the other six still say there is nothing.
    for (const label of ['Branding', 'Cores', 'Posicionamento', 'Arquétipo', 'Personas', 'Observações']) {
      const area = await within(await sectionCard(container, label)).findByRole('region', { name: `Conversas sobre ${label}` });
      await waitFor(() => expect(within(area).getByText('Nenhuma conversa sobre esta parte')).toBeTruthy());
    }
    await waitFor(() => expect(detailReads()).toBeGreaterThan(before));
    expect(queryClient.getQueryState(rosterKey)?.isInvalidated).toBe(true);
  });

  it('opens a persona conversation inside the persona profile, on that persona and not on the section', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    conversation.seed({ personaId: donaMaria.id }, [{ side: 'client', body: 'Ela não compra assim', at: NOW_LATE }]);
    conversation.seed({ sectionKey: 'personas' }, [{ side: 'client', body: 'Faltam personas jovens', at: NOW_LATE }]);
    const { impl } = makeFetch({ conversation });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    // The section's own area lists the section thread, not the persona's.
    const personasArea = await within(await sectionCard(container, 'Personas')).findByRole('region', { name: 'Conversas sobre Personas' });
    await within(personasArea).findByText('Faltam personas jovens');
    expect(within(personasArea).queryByText('Ela não compra assim')).toBeNull();

    const profile = await openPersona('Dona Maria');
    const area = within(profile).getByRole('region', { name: 'Conversas sobre Dona Maria' });
    await within(area).findByText('Ela não compra assim');
    expect(within(area).queryByText('Faltam personas jovens')).toBeNull();
    fireEvent.click(within(area).getByRole('button', { name: 'Nova conversa sobre Dona Maria' }));
    const novo = await screen.findByRole('dialog', { name: 'Nova conversa sobre Dona Maria' });
    fireEvent.change(within(novo).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Falemos dela' } });
    fireEvent.click(within(novo).getByRole('button', { name: 'Iniciar conversa' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nova conversa sobre Dona Maria' })).toBeNull());
    expect(conversation.bodies).toEqual([{ subject: { personaId: donaMaria.id }, body: 'Falemos dela' }]);
    await within(area).findByText('Falemos dela');
  });

  it('lets who only reads see every conversation and write none', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'O tom está formal', at: NOW_LATE }]);
    const { impl } = makeFetch({ permissions: READER_PERMISSIONS, conversation });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    fireEvent.click(await within(await sectionCard(container, 'Tom de voz')).findByRole('button', { name: /O tom está formal/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Tom de voz' });
    expect(within(dialog).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Nova conversa/ })).toBeNull();
  });

  it('keeps a conversation of an archived client readable and closed to writing', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'O tom está formal', at: NOW_LATE }]);
    const { impl } = makeFetch({ conversation, client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    fireEvent.click(await within(await sectionCard(container, 'Tom de voz')).findByRole('button', { name: /O tom está formal/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Tom de voz' });
    expect(within(dialog).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Nova conversa/ })).toBeNull();
  });

  it('closes the conversation on Esc leaving the persona profile open, and nests its heading under the persona name', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    conversation.seed({ personaId: donaMaria.id }, [{ side: 'client', body: 'Ela não compra assim', at: NOW_LATE }]);
    const { impl } = makeFetch({ conversation });
    const { probe } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const persona = await openPersona('Dona Maria');
    const area = within(persona).getByRole('region', { name: 'Conversas sobre Dona Maria' });
    // The profile titles itself with an h3 (the persona's name), so its conversations heading is an h4.
    expect(within(area).getByRole('heading', { level: 4, name: /^Conversas/ })).toBeTruthy();
    fireEvent.click(await within(area).findByRole('button', { name: /Ela não compra assim/ }));
    const inner = await screen.findByRole('dialog', { name: 'Dona Maria' });

    fireEvent(inner, new Event('cancel', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { level: 3, name: 'Dona Maria' })).toBeTruthy();
    expect(probe.search).toBe(`?secao=personas&persona=${donaMaria.id}`);
  });
});

describe('brand study in the Pauta (#637)', () => {
  const emptySections = (keys: string[]) => studyOf().sections.map((section) => (keys.includes(section.key) ? sectionOf(section.key) : section));

  it('draws each empty section as an empty state: what is missing, what it asks for and the one way to fill it', async () => {
    const { impl } = makeFetch({ study: () => json({ ...studyOf(), sections: emptySections(['colors', 'archetype']) }) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const cases = [
      ['Tom de voz', 'Registre como a marca fala com o público.'],
      ['Cores', 'Cadastre as cores da marca, cada uma com nome e código.'],
      ['Posicionamento', 'Diga onde a marca se coloca diante dos concorrentes.'],
      ['Arquétipo', 'Escolha o arquétipo que melhor descreve a marca.'],
      ['Observações', 'Anote o que a equipe precisa lembrar sobre este cliente.']
    ] as const;
    for (const [label, hint] of cases) {
      const empty = (await sectionCard(container, label)).querySelector<HTMLElement>('.ui-empty-state');
      if (empty === null) throw new Error(`The ${label} section has no empty state.`);
      expect(within(empty).getByText('Ainda não preenchida')).toBeTruthy();
      expect(within(empty).getByText(hint)).toBeTruthy();
      expect(within(empty).getByRole('button', { name: `Preencher ${label}` })).toBeTruthy();
    }
    expect((await sectionCard(container, 'Branding')).querySelector('.ui-empty-state')).toBeNull();
  });

  it('says only that a section is missing to who cannot fill it: no hint, no button', async () => {
    const { impl } = makeFetch({ permissions: READER_PERMISSIONS });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const empty = (await sectionCard(container, 'Tom de voz')).querySelector<HTMLElement>('.ui-empty-state');
    if (empty === null) throw new Error('The Tom de voz section has no empty state.');
    expect(within(empty).getByText('Ainda não preenchida')).toBeTruthy();
    expect(within(empty).queryByText('Registre como a marca fala com o público.')).toBeNull();
    expect(within(empty).queryByRole('button')).toBeNull();
  });

  it('keeps the way to add a persona in the empty state while there is none, and in the header once there is one', async () => {
    const none = makeFetch({ study: () => json(studyOf({ personas: [], filled: 4 })) });
    const first = renderStudy(none.impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    const empty = (await sectionCard(first.container, 'Personas')).querySelector<HTMLElement>('.ui-empty-state');
    if (empty === null) throw new Error('The Personas section has no empty state.');
    expect(within(empty).getByText('Nenhuma persona ainda')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Nova persona' })).toHaveLength(1);
    expect(within(empty).getByRole('button', { name: 'Nova persona' })).toBeTruthy();

    cleanup();
    const some = makeFetch();
    const second = renderStudy(some.impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    const personas = await sectionCard(second.container, 'Personas');
    expect(personas.querySelector('.ui-empty-state')).toBeNull();
    expect(within(personas).getAllByRole('button', { name: 'Nova persona' })).toHaveLength(1);
    expect(within(personas).getByRole('link', { name: /Dona Maria/ }).querySelector('.ui-avatar')?.textContent).toBe('DM');
  });
});

describe('brand study index, address and persona profile (telas-melhorias S13)', () => {
  const donaJoana: PersonaFixture = {
    ...donaMaria,
    id: 'cccccccc-3333-4333-8333-333333333333',
    name: 'Seu Joaquim',
    description: 'Cliente de todo dia',
    pains: 'Fila longa',
    desires: 'Pão quente',
    objections: 'Distância'
  };
  const twoPersonas = () => studyOf({ personas: [donaMaria, donaJoana, donaAposentada] });
  const NOW_LATE = '2026-10-13T01:30:00.000Z';
  const roster = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;

  const ADDRESSES: ReadonlyArray<readonly [string, string, string]> = [
    ['no parameter', '', 'Branding'],
    ['a section', '?secao=tom-de-voz', 'Tom de voz'],
    ['the colours', '?secao=cores', 'Cores'],
    ['the last section', '?secao=observacoes', 'Observações'],
    ['an unknown section', '?secao=nao-existe', 'Branding'],
    ['an empty section', '?secao=', 'Branding'],
    ['a name that every object has', '?secao=constructor', 'Branding'],
    ['an unknown persona in Personas', '?secao=personas&persona=00000000-0000-4000-8000-00000000dead', 'Personas'],
    ['an unknown persona alone', '?persona=nao-existe', 'Branding'],
    ['a valid persona beside another section', `?secao=cores&persona=${donaMaria.id}`, 'Cores'],
    ['a valid persona beside an invalid section', `?secao=xyz&persona=${donaMaria.id}`, 'Branding']
  ];

  it.each(ADDRESSES)('opens the first valid section for %s, with no error', async (_case, search, title) => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl, { pathname: studyUrl, search });

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual([title]);
    expect(container.querySelectorAll('.brand-panel:not([hidden])')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    const current = within(screen.getByRole('navigation', { name: 'Seções do estudo de marca' })).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.querySelector('.brand-index__label')?.textContent)).toEqual([title]);
  });

  it.each(['?persona=' + donaMaria.id, `?secao=personas&persona=${donaMaria.id}`])('opens the profile of the persona named by %s, on Personas', async (search) => {
    const { impl } = makeFetch();
    const { probe } = renderStudy(impl, { pathname: studyUrl, search });

    expect(await screen.findByRole('heading', { level: 3, name: 'Dona Maria' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Personas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Personas/ }).getAttribute('aria-current')).toBe('page');
    expect(probe.search).toBe(search);
  });

  it('moves between sections through the index, puts each in the address and keeps the way back to the roster', async () => {
    const { impl } = makeFetch();
    const { probe } = renderStudy(impl, { pathname: studyUrl, state: { clientListUrl: roster } });
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByRole('link', { name: 'Voltar para Clientes' }).getAttribute('href')).toBe(roster);

    await openSection('Tom de voz');
    expect(probe.search).toBe('?secao=tom-de-voz');
    expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual(['Tom de voz']);
    await openSection('Observações');
    expect(probe.search).toBe('?secao=observacoes');
    expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual(['Observações']);
    // Going through the index never drops the address the roster handed over.
    expect(probe.state).toEqual({ clientListUrl: roster });
    expect(screen.getByRole('link', { name: 'Voltar para Clientes' }).getAttribute('href')).toBe(roster);

    // The browser's back returns to the previous section.
    await act(async () => { probe.navigate(-1); });
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual(['Tom de voz']));
    expect(probe.search).toBe('?secao=tom-de-voz');
  });

  it('goes from the grid of personas to a profile and back, with the roster address kept and the focus following', async () => {
    const { impl } = makeFetch();
    const { probe } = renderStudy(impl, { pathname: studyUrl, search: '?secao=personas', state: { clientListUrl: roster } });
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    // The grid: one card for each active persona, with initials, name and short description; the archived one is not a card.
    const card = screen.getByRole('link', { name: /Dona Maria/ });
    expect(card.querySelector('.ui-avatar')?.textContent).toBe('DM');
    expect(within(card).getByText('Dona da padaria')).toBeTruthy();
    expect(card.getAttribute('href')).toBe(`${studyUrl}?secao=personas&persona=${donaMaria.id}`);
    expect(screen.getAllByRole('link', { name: /Dona/ }).map((link) => link.getAttribute('href'))).not.toContain(null);
    expect(screen.getByRole('button', { name: 'Nova persona' })).toBeTruthy();

    fireEvent.click(card);
    const name = await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });
    expect(probe.search).toBe(`?secao=personas&persona=${donaMaria.id}`);
    expect(probe.state).toEqual({ clientListUrl: roster });
    expect(document.activeElement).toBe(name);
    // The profile has no grid and no "Nova persona": one thing at a time.
    expect(screen.queryByRole('button', { name: 'Nova persona' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Dona Maria/ })).toBeNull();

    const back = screen.getByRole('link', { name: 'Voltar para Personas' });
    expect(back.getAttribute('href')).toBe(`${studyUrl}?secao=personas`);
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByRole('heading', { level: 3, name: 'Personas' })).toBeTruthy());
    expect(probe.search).toBe('?secao=personas');
    expect(probe.state).toEqual({ clientListUrl: roster });
    expect(screen.queryByRole('heading', { level: 3, name: 'Dona Maria' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Dona Maria/ }));
  });

  it('leaves the profile through the index too, and Personas then shows the grid again', async () => {
    const { impl } = makeFetch();
    const { probe } = renderStudy(impl, { pathname: studyUrl, search: `?persona=${donaMaria.id}` });
    await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });

    await openSection('Cores');
    expect(probe.search).toBe('?secao=cores');
    await openSection('Personas');
    expect(probe.search).toBe('?secao=personas');
    expect(screen.getAllByRole('heading', { level: 3 }).map((element) => element.textContent)).toEqual(['Personas']);
    expect(screen.getByRole('link', { name: /Dona Maria/ })).toBeTruthy();
  });

  it('shows how many conversations wait for the agency on each section and on each persona, and the count follows an answer', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    // Tom de voz: two wait for the agency, one was answered by it and one was resolved.
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'O tom está formal', at: NOW_LATE }]);
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'Falta humor', at: NOW_LATE }]);
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'Já respondida', at: NOW_LATE }, { side: 'agency', body: 'Ajustamos', at: '2026-10-13T02:30:00.000Z' }]);
    conversation.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'Já resolvida', at: NOW_LATE }], { at: '2026-10-13T03:30:00.000Z', by: null });
    // Personas: one on the section and one on Dona Maria; none on Seu Joaquim; the archived persona's is not counted.
    conversation.seed({ sectionKey: 'personas' }, [{ side: 'client', body: 'Faltam personas jovens', at: NOW_LATE }]);
    conversation.seed({ personaId: donaMaria.id }, [{ side: 'client', body: 'Ela não compra assim', at: NOW_LATE }]);
    conversation.seed({ personaId: donaAposentada.id }, [{ side: 'client', body: 'Persona antiga', at: NOW_LATE }]);
    const { impl } = makeFetch({ conversation, study: () => json(twoPersonas()) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const nav = screen.getByRole('navigation', { name: 'Seções do estudo de marca' });
    const tone = within(nav).getByRole('link', { name: /^Tom de voz/ });
    expect(await within(tone).findByText('2 aguardando')).toBeTruthy();
    expect(await within(within(nav).getByRole('link', { name: /^Personas/ })).findByText('2 aguardando')).toBeTruthy();
    // A section with nothing waiting says nothing.
    expect(within(within(nav).getByRole('link', { name: /^Branding/ })).queryByText(/aguardando/)).toBeNull();
    expect(within(within(nav).getByRole('link', { name: /^Cores/ })).queryByText(/aguardando/)).toBeNull();

    await openSection('Personas');
    const maria = screen.getByRole('link', { name: /Dona Maria/ });
    expect(await within(maria).findByText('1 aguardando')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: /Seu Joaquim/ })).queryByText(/aguardando/)).toBeNull();

    // Answering a conversation of Tom de voz takes it off the count, with no reload.
    await openSection('Tom de voz');
    fireEvent.click(await within(panelOf(container, 'Tom de voz')).findByRole('button', { name: /O tom está formal/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Tom de voz' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Vamos ajustar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await waitFor(() => expect(within(tone).getByText('1 aguardando')).toBeTruthy());
    // Personas still counts its own two.
    expect(within(within(nav).getByRole('link', { name: /^Personas/ })).getByText('2 aguardando')).toBeTruthy();
  });

  it('runs an action on the persona that was opened, never on the other one', async () => {
    const patches: unknown[] = [];
    const archived: string[] = [];
    let studyData = twoPersonas();
    const { impl } = makeFetch({
      study: () => json(studyData),
      patchPersona: (personaId, body) => {
        patches.push({ personaId, body });
        const target = studyData.personas.find((persona) => persona.id === personaId)!;
        const updated = { ...target, ...(body as object) };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      },
      archivePersona: (personaId) => {
        archived.push(personaId);
        const target = studyData.personas.find((persona) => persona.id === personaId)!;
        const updated = { ...target, status: 'archived' as const };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      }
    });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    // The second one: her own fields, her own edit.
    const joaquim = await openPersona('Seu Joaquim');
    expect(within(joaquim).getByText('Cliente de todo dia')).toBeTruthy();
    expect(within(joaquim).getByText('Fila longa')).toBeTruthy();
    expect(within(joaquim).queryByText('Pouco tempo')).toBeNull();
    fireEvent.click(within(joaquim).getByRole('button', { name: 'Editar' }));
    expect((within(joaquim).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement).value).toBe('Seu Joaquim');
    fireEvent.change(within(joaquim).getByRole('textbox', { name: 'Dores' }), { target: { value: 'Fila enorme' } });
    fireEvent.click(within(joaquim).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(patches).toEqual([{ personaId: donaJoana.id, body: { pains: 'Fila enorme' } }]));
    expect(await screen.findByText('Fila enorme')).toBeTruthy();

    // Archiving from this profile archives her and only her.
    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    expect(screen.getByText('Arquivar Seu Joaquim?')).toBeTruthy();
    const confirm = screen.getByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.').closest('.ui-dialog');
    if (confirm === null) throw new Error('The archive confirmation was not rendered.');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() => expect(archived).toEqual([donaJoana.id]));
    // Back on the grid she is gone from the active cards, and the first persona is untouched with her own description.
    const maria = await screen.findByRole('link', { name: /Dona Maria/ });
    expect(screen.queryByRole('link', { name: /Seu Joaquim/ })).toBeNull();
    expect(within(maria).getByText('Dona da padaria')).toBeTruthy();
    expect(patches).toHaveLength(1);
  });

  it('opens an archived persona by its address as a read-only profile, with her conversations readable', async () => {
    const conversation = createConversationApi({ side: 'agency', clientId: CLIENT_ID });
    conversation.seed({ personaId: donaAposentada.id }, [{ side: 'client', body: 'Persona antiga', at: NOW_LATE }]);
    const { impl } = makeFetch({ conversation });
    renderStudy(impl, { pathname: studyUrl, search: `?persona=${donaAposentada.id}` });

    const heading = await screen.findByRole('heading', { level: 3, name: 'Dona Aposentada' });
    const profile = heading.closest<HTMLElement>('.brand-persona');
    if (profile === null) throw new Error('The persona profile was not rendered.');
    expect(within(profile).getByText('Arquivada')).toBeTruthy();
    expect(within(profile).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(profile).queryByRole('button', { name: 'Arquivar' })).toBeNull();
    const area = within(profile).getByRole('region', { name: 'Conversas sobre Dona Aposentada' });
    fireEvent.click(await within(area).findByRole('button', { name: /Persona antiga/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Dona Aposentada' });
    expect(within(dialog).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    expect(within(area).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
  });

  it('links each archived persona to her profile from the archived list', async () => {
    const { impl } = makeFetch();
    renderStudy(impl, { pathname: studyUrl, search: '?secao=personas' });
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    const link = screen.getByRole('link', { name: 'Dona Aposentada' });
    expect(link.getAttribute('href')).toBe(`${studyUrl}?secao=personas&persona=${donaAposentada.id}`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 3, name: 'Dona Aposentada' })).toBeTruthy();
  });

  it('keeps the draft of a persona edit when the person leaves the profile through the index, the way back or the browser', async () => {
    const { impl } = makeFetch({ study: () => json(twoPersonas()) });
    const { probe } = renderStudy(impl, { pathname: studyUrl, search: `?secao=personas&persona=${donaMaria.id}` });
    const profile = await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });
    fireEvent.click(within(profile.closest<HTMLElement>('.brand-persona')!).getByRole('button', { name: 'Editar' }));
    const typeInPains = (value: string): void => { fireEvent.change(screen.getByRole('textbox', { name: 'Dores' }), { target: { value } }); };
    const painsNow = (): string => (screen.getByRole('textbox', { name: 'Dores' }) as HTMLTextAreaElement).value;
    typeInPains('Fila enorme na hora do almoço');

    // Through the index: another section and back to Personas, which shows the grid; the card opens the form with the text.
    await openSection('Cores');
    await openSection('Personas');
    expect(screen.queryByRole('textbox', { name: 'Dores' })).toBeNull();

    // The draft belongs to Dona Maria: Seu Joaquim opens as a reading, with none of her text.
    fireEvent.click(screen.getByRole('link', { name: /Seu Joaquim/ }));
    await screen.findByRole('heading', { level: 3, name: 'Seu Joaquim' });
    expect(screen.queryByRole('textbox', { name: 'Dores' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(screen.queryByDisplayValue('Fila enorme na hora do almoço')).toBeNull();
    expect(screen.getByText('Fila longa')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Voltar para Personas' }));

    fireEvent.click(await screen.findByRole('link', { name: /Dona Maria/ }));
    await screen.findByRole('textbox', { name: 'Dores' });
    expect(painsNow()).toBe('Fila enorme na hora do almoço');

    // Through "Voltar para Personas".
    typeInPains('Fila enorme e pouco tempo');
    fireEvent.click(screen.getByRole('link', { name: 'Voltar para Personas' }));
    await screen.findByRole('link', { name: /Dona Maria/ });
    fireEvent.click(screen.getByRole('link', { name: /Dona Maria/ }));
    await screen.findByRole('textbox', { name: 'Dores' });
    expect(painsNow()).toBe('Fila enorme e pouco tempo');

    // Through the browser's back: the grid, then forward to the profile.
    typeInPains('Fila enorme, pouco tempo e preço');
    await act(async () => { probe.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Dores' })).toBeNull());
    await act(async () => { probe.navigate(1); });
    await screen.findByRole('textbox', { name: 'Dores' });
    expect(painsNow()).toBe('Fila enorme, pouco tempo e preço');

    // Cancelling is what discards it: the next edit starts from the saved text.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(document.querySelector<HTMLElement>('.brand-persona')!).getByRole('button', { name: 'Editar' }));
    expect(painsNow()).toBe('Pouco tempo');
  });

  it('opens as a reading, without the form or a save, a persona archived after the edit was left, and drops the draft', async () => {
    let studyData = studyOf();
    const { impl, calls } = makeFetch({ study: () => json(studyData) });
    const { queryClient } = renderStudy(impl, { pathname: studyUrl, search: `?secao=personas&persona=${donaMaria.id}` });
    const profile = (await screen.findByRole('heading', { level: 3, name: 'Dona Maria' })).closest<HTMLElement>('.brand-persona')!;
    fireEvent.click(within(profile).getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Dores' }), { target: { value: 'Fila enorme' } });
    await openSection('Cores');

    // Someone else archives her; the study is read again.
    studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === donaMaria.id ? { ...persona, status: 'archived' as const } : persona)) };
    await act(async () => { await queryClient.invalidateQueries(); });
    await openSection('Personas');
    fireEvent.click(await screen.findByRole('button', { name: 'Arquivadas (2)' }));
    fireEvent.click(screen.getByRole('link', { name: 'Dona Maria' }));

    await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });
    expect(screen.getByText('Arquivada')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Dores' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(screen.getByText('Pouco tempo')).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('PATCH'))).toEqual([]);
  });

  it('keeps the way back to the roster after archiving from the profile and in the link of an archived persona', async () => {
    let studyData = studyOf();
    const { impl } = makeFetch({
      study: () => json(studyData),
      archivePersona: (personaId) => {
        const updated = { ...donaMaria, status: 'archived' as const };
        studyData = { ...studyData, personas: studyData.personas.map((persona) => (persona.id === personaId ? updated : persona)) };
        return json(updated);
      }
    });
    const { probe } = renderStudy(impl, { pathname: studyUrl, search: `?secao=personas&persona=${donaMaria.id}`, state: { clientListUrl: roster } });
    await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });

    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    const confirm = screen.getByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.').closest('.ui-dialog');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() => expect(probe.search).toBe('?secao=personas'));
    expect(probe.state).toEqual({ clientListUrl: roster });
    expect(screen.getByRole('link', { name: 'Voltar para Clientes' }).getAttribute('href')).toBe(roster);

    // The archived list links to the profile of each one without dropping the address either.
    fireEvent.click(await screen.findByRole('button', { name: 'Arquivadas (2)' }));
    fireEvent.click(screen.getByRole('link', { name: 'Dona Aposentada' }));
    await screen.findByRole('heading', { level: 3, name: 'Dona Aposentada' });
    expect(probe.search).toBe(`?secao=personas&persona=${donaAposentada.id}`);
    expect(probe.state).toEqual({ clientListUrl: roster });
  });

  it('blocks every write control with the reason while the plan is read only, and keeps the reading', async () => {
    const { impl, calls } = makeFetch({ planReadOnly: true, study: () => json(twoPersonas()) });
    const { container } = renderStudy(impl, { pathname: studyUrl, search: '?secao=personas' });
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    const blocked = (button: HTMLElement): void => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.querySelector('.ui-button__tip')?.textContent ?? '').not.toBe('');
    };

    blocked(screen.getByRole('button', { name: 'Nova persona' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nova persona' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: /Dona Maria/ }));
    await screen.findByRole('heading', { level: 3, name: 'Dona Maria' });
    for (const name of ['Editar', 'Arquivar']) {
      blocked(within(document.querySelector<HTMLElement>('.brand-persona')!).getByRole('button', { name }));
      fireEvent.click(within(document.querySelector<HTMLElement>('.brand-persona')!).getByRole('button', { name }));
    }
    expect(screen.queryByRole('textbox', { name: 'Dores' })).toBeNull();
    expect(screen.queryByText('Arquivar Dona Maria?')).toBeNull();
    expect(screen.getByText('Pouco tempo')).toBeTruthy();

    await openSection('Branding');
    blocked(within(panelOf(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    await openSection('Tom de voz');
    blocked(within(panelOf(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
    expect(calls.filter((call) => call.startsWith('POST') || call.startsWith('PUT') || call.startsWith('PATCH'))).toEqual([]);
  });

  it('tells filled from not filled by the icon of each link in the index, not only by the hidden word', async () => {
    const { impl } = makeFetch();
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const nav = screen.getByRole('navigation', { name: 'Seções do estudo de marca' });
    const marks = within(nav).getAllByRole('link').map((link) => [
      link.querySelector('.brand-index__label')?.textContent,
      link.querySelector('svg')?.classList.contains('lucide-check') ? 'check' : 'circle',
      link.textContent?.includes('não preenchida') ? 'no' : 'yes'
    ]);
    expect(marks).toEqual([
      ['Branding', 'check', 'yes'],
      ['Tom de voz', 'circle', 'no'],
      ['Cores', 'check', 'yes'],
      ['Posicionamento', 'circle', 'no'],
      ['Arquétipo', 'check', 'yes'],
      ['Personas', 'check', 'yes'],
      ['Observações', 'circle', 'no']
    ]);
  });

  it('counts a text of only spaces as not filled, as the API does', async () => {
    const study = studyOf();
    const { impl } = makeFetch({ study: () => json({ ...study, sections: study.sections.map((section) => (section.key === 'branding' ? { ...section, body: '   ' } : section)) }) });
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(within(screen.getByRole('navigation', { name: 'Seções do estudo de marca' })).getByRole('link', { name: /^Branding/ }).textContent).toContain('não preenchida');
  });

  it('mounts the conversations of the open section only: one listing per section and per active persona for the counts, plus the open section\'s own pair', async () => {
    const { impl, calls } = makeFetch();
    renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    await waitFor(() => expect(calls.filter((call) => call.startsWith('GET') && call.endsWith('/threads')).length).toBeGreaterThanOrEqual(10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 7 sections + 1 active persona for the counts, plus the open and resolved listings of the open section: 10, not 7 x 2 more.
    expect(calls.filter((call) => call.startsWith('GET') && call.endsWith('/threads'))).toHaveLength(10);
  });

  it('draws an empty section as the first-use state, never as good news or a failure', async () => {
    const { impl } = makeFetch({ study: () => json({ ...studyOf(), personas: [] }) });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    for (const label of ['Tom de voz', 'Posicionamento', 'Observações', 'Personas']) {
      const empty = (await sectionCard(container, label)).querySelector<HTMLElement>('.ui-empty-state');
      if (empty === null) throw new Error(`The ${label} section has no empty state.`);
      expect(empty.classList.contains('ui-empty-state--good-news')).toBe(false);
      expect(empty.classList.contains('ui-empty-state--failure')).toBe(false);
      expect(empty.getAttribute('role')).toBeNull();
    }
  });
});
