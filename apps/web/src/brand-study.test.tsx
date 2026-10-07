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

const openPersona = async (name: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
  return await screen.findByRole('dialog', { name });
};

describe('brand study tab (#138)', () => {
  it('renders the seven sections once each, in the SPEC order, with the counter and reserved lines', async () => {
    const { impl } = makeFetch();
    const { container } = renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('5 de 7 preenchidas')).toBeTruthy();
    const panel = container.querySelector<HTMLElement>('.client-detail__panel');
    if (panel === null) throw new Error('The tab panel was not rendered.');
    // The heading list itself proves order and uniqueness: "Personas" appears once (#138 review).
    const headings = within(panel).getAllByRole('heading', { level: 3 }).map((element) => element.textContent);
    expect(headings).toEqual(['Branding', 'Tom de voz', 'Cores', 'Posicionamento', 'Arquétipo', 'Personas', 'Observações']);
    expect(screen.getAllByRole('heading', { name: 'Personas' })).toHaveLength(1);
    // Every section reserves its own conversations area for #142; there is no fake control.
    expect(screen.getAllByText('Aqui vão ficar as conversas sobre esta parte da marca.')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /conversa/i })).toBeNull();
    // Empty sections say so instead of disappearing; Branding, Cores and Arquétipo are filled.
    expect(screen.getAllByText('Ainda não preenchida')).toHaveLength(3);
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    expect(screen.getByText('Cuidador')).toBeTruthy();
    expect(screen.getByText('Vinho')).toBeTruthy();
    expect(screen.getByText('#7A1F2B')).toBeTruthy();
    // "editado por" carries the last editor and the agency day: 01:30Z of the 13th is 12/10 in SP.
    expect(screen.getByText('editado por Ana · 12/10')).toBeTruthy();
  });

  it('gives every edit control a name that says its target', async () => {
    const { impl } = makeFetch();
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByRole('button', { name: 'Editar Branding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preencher Tom de voz' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editar Cores' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preencher Posicionamento' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editar Arquétipo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adicionar persona' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preencher Observações' })).toBeTruthy();
  });

  it('edits each section in place without reloading or closing the others', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    const branding = within(sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }) as HTMLTextAreaElement;
    expect(branding.value).toBe('Marca acolhedora do bairro');

    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
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
        return json(sectionOf(sectionKey, { body: (body as { body: string }).body, updatedBy: ANY_USER, updatedAt: BRANDING_EDITED_AT }));
      }
    });
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
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

    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Editar Branding' }));
    fireEvent.change(within(sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }), { target: { value: 'forcar 400' } });
    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(sectionCard(container, 'Branding')).findByText('Revise os dados informados.')).toBeTruthy();

    fireEvent.change(within(sectionCard(container, 'Branding')).getByRole('textbox', { name: 'Editar Branding' }), { target: { value: 'outro texto' } });
    fireEvent.click(within(sectionCard(container, 'Branding')).getByRole('button', { name: 'Salvar' }));
    expect(await within(sectionCard(container, 'Branding')).findByText('Cliente arquivado: o estudo de marca está somente leitura.')).toBeTruthy();
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

    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Preencher Tom de voz' }));
    fireEvent.change(within(sectionCard(container, 'Tom de voz')).getByRole('textbox', { name: 'Editar Tom de voz' }), { target: { value: 'Falamos simples' } });
    fireEvent.click(within(sectionCard(container, 'Tom de voz')).getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('6 de 7 preenchidas')).toBeTruthy();
    expect(within(sectionCard(container, 'Tom de voz')).getByText('editado por Ana · 12/10')).toBeTruthy();
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
    expect(within(sectionCard(container, 'Cores')).getByText('Ainda não preenchida')).toBeTruthy();

    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Preencher Cores' }));
    fireEvent.change(within(sectionCard(container, 'Cores')).getByLabelText('Nome da cor 1'), { target: { value: 'Vinho' } });
    fireEvent.change(within(sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: 'zzz' } });
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    expect(await within(sectionCard(container, 'Cores')).findByText('Cada cor precisa de um nome e de um código hexadecimal como #7A1F2B.')).toBeTruthy();
    expect(bodies).toEqual([]);
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);

    // Fixing the hex saves: the editor closes over the new list, the last editor shows and the
    // counter moves (from the invalidated study and detail, not from a local guess).
    fireEvent.change(within(sectionCard(container, 'Cores')).getByLabelText('Código da cor 1'), { target: { value: '#112233' } });
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ colors: [{ name: 'Vinho', hex: '#112233' }] }]));
    await waitFor(() => expect(within(sectionCard(container, 'Cores')).queryByLabelText('Nome da cor 1')).toBeNull());
    expect(within(sectionCard(container, 'Cores')).getByText('#112233')).toBeTruthy();
    expect(within(sectionCard(container, 'Cores')).getByText('editado por Ana · 12/10')).toBeTruthy();
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();

    // Back to the study, removing the only row is clearing the section: it travels as colors: []
    // and the counter returns.
    fireEvent.click(screen.getByRole('link', { name: 'Estudo de marca' }));
    await screen.findByRole('heading', { name: 'Estudo de marca' });
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Editar Cores' }));
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Remover a cor 1' }));
    fireEvent.click(within(sectionCard(container, 'Cores')).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ colors: [] });
    expect(await screen.findByText('4 de 7 preenchidas')).toBeTruthy();
    await waitFor(() => expect(within(sectionCard(container, 'Cores')).getByText('Ainda não preenchida')).toBeTruthy());
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

    fireEvent.click(within(sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Preencher Arquétipo' }));
    fireEvent.change(within(sectionCard(container, 'Arquétipo')).getByRole('combobox', { name: 'Arquétipo' }), { target: { value: 'hero' } });
    fireEvent.click(within(sectionCard(container, 'Arquétipo')).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ archetype: 'hero' }]));
    expect(await within(sectionCard(container, 'Arquétipo')).findByText('Herói')).toBeTruthy();
    expect(within(sectionCard(container, 'Arquétipo')).queryByRole('combobox')).toBeNull();
    expect(within(sectionCard(container, 'Arquétipo')).getByText('editado por Ana · 12/10')).toBeTruthy();
    expect(await screen.findByText('5 de 7 preenchidas')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('5 de 7')).toBeTruthy();
  });

  it('keeps reading and opening personas for a reader role, with no editing control at all', async () => {
    const { impl } = makeFetch({ permissions: READER_PERMISSIONS });
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Marca acolhedora do bairro')).toBeTruthy();
    expect(screen.getAllByText('Ainda não preenchida').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Editar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Preencher/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar persona' })).toBeNull();
    // Reading the archived list is reading: the list opens, the Desarquivar action does not exist.
    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    expect(screen.getByText('Dona Aposentada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();

    // Opening a persona is reading, not editing: the detail shows the fields without its actions.
    const dialog = await openPersona('Dona Maria');
    expect(within(dialog).getByText('Dona da padaria')).toBeTruthy();
    expect(within(dialog).getByText('Aqui vão ficar as conversas sobre esta persona.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Arquivar' })).toBeNull();
  });

  it('shows no editing control on an archived client, even inside a persona and the archived list', async () => {
    const { impl } = makeFetch({ client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }) });
    renderStudy(impl);

    await screen.findByRole('heading', { name: 'Estudo de marca' });
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Editar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Preencher/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar persona' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    expect(screen.getByText('Dona Aposentada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desarquivar/ })).toBeNull();

    const dialog = await openPersona('Dona Maria');
    expect(within(dialog).getByText('Dona da padaria')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Arquivar' })).toBeNull();
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
    expect(screen.getByText('Nenhuma persona ainda')).toBeTruthy();
    expect(screen.getByText('4 de 7 preenchidas')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova persona' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar persona' }));
    expect(await within(dialog).findByText('Informe o nome da persona.')).toBeTruthy();
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
    expect(await screen.findByRole('button', { name: /Dona Maria/ })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar persona' }));
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

  it('opens a persona with its four fields, edits only what changed and archives with confirmation', async () => {
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
    const { container } = renderStudy(impl);
    await screen.findByRole('heading', { name: 'Estudo de marca' });

    const dialog = await openPersona('Dona Maria');
    expect(within(dialog).getByText('Dona da padaria')).toBeTruthy();
    expect(within(dialog).getByText('Pouco tempo')).toBeTruthy();
    expect(within(dialog).getByText('Clientes fiéis')).toBeTruthy();
    expect(within(dialog).getByText('Preço')).toBeTruthy();
    expect(within(dialog).getByText('Aqui vão ficar as conversas sobre esta persona.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Dona da padaria e do bairro' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(patches).toEqual([{ personaId: donaMaria.id, body: { description: 'Dona da padaria e do bairro' } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The card reads from the invalidated study: the new description is what stays on screen,
    // and the detail (General) query was refetched with it.
    expect(await screen.findByText('Dona da padaria e do bairro')).toBeTruthy();
    await waitFor(() => expect(detailGets).toBeGreaterThan(1));

    // Archiving asks first, saying what happens to the portal and to the conversations.
    const reopened = await openPersona('Dona Maria');
    fireEvent.click(within(reopened).getByRole('button', { name: 'Arquivar' }));
    const description = await screen.findByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.');
    const confirm = description.closest('.ui-dialog');
    if (confirm === null) throw new Error('The archive confirmation was not rendered.');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));

    // The active grid loses her; she moves into the collapsed Arquivadas list.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Dona Maria/ })).toBeNull());
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

    const dialog = await openPersona('Dona Maria');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), { target: { value: 'Rascunho que não pode sumir' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Não foi possível salvar. Tente de novo.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('dialog', { name: 'Dona Maria' })).toBe(dialog);
    // The editor must still be open: re-query the live form and check the draft stayed there
    // (review of #388 r3 — a detached node would keep its old value).
    const liveDraft = within(dialog).getByRole('textbox', { name: 'Descrição' }) as HTMLTextAreaElement;
    expect(liveDraft.value).toBe('Rascunho que não pode sumir');
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeTruthy();
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

    const dialog = await openPersona('Dona Maria');
    const confirmArchive = async (): Promise<void> => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));
      const description = await screen.findByText('Ela some do portal e as conversas dela ficam somente leitura. Você pode desarquivar depois.');
      const confirm = description.closest('.ui-dialog');
      if (confirm === null) throw new Error('The archive confirmation was not rendered.');
      fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Arquivar' }));
    };
    await confirmArchive();

    expect(await within(dialog).findByText('Cliente arquivado: o estudo de marca está somente leitura.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');

    // The retry that lands archives the persona.
    await confirmArchive();
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Dona Maria/ })).toBeNull());
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

    fireEvent.click(screen.getByRole('button', { name: 'Arquivadas (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desarquivar Dona Aposentada' }));
    expect(await screen.findByText('Você não tem permissão para editar o estudo de marca.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Desarquivar Dona Aposentada' }));
    expect(await screen.findByRole('button', { name: /Dona Aposentada/ })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Marca acolhedora do bairro')).toBeTruthy();
  });
});
