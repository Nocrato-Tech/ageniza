// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { apiError, createConversationApi } from './conversation-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { createPortalContentsApi, portalContentError, type PortalContentSeed } from './portal-content-fixture.js';
import { portalClientBody } from './portal-fixture.js';
import { ApplicationRoutes } from './routes.js';
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

const CLIENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CLIENT = 'bbbbbbbb-2222-4222-8222-222222222222';
const AGENCY = '11111111-1111-4111-8111-111111111111';
const CONTENT = 'cccccccc-3333-4333-8333-333333333333';
const OTHER_CONTENT = 'dddddddd-4444-4444-8444-444444444444';
const asset = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-12-01T00:00:00.000Z' } };
const contextsBody = { contexts: [{ type: 'client', clientId: CLIENT, clientName: 'Padaria Central', agencyId: AGENCY, agencyName: 'Agência Um', onboardingPending: false }] };
const legalAccepted = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};

interface Options {
  readonly holdWrite?: Promise<void>;
  readonly holdRead?: Promise<void>;
  readonly mediaUrl?: (assetId: string, variant: string) => string;
}

const setup = (options: Options = {}) => {
  const conversation = createConversationApi({ side: 'client', clientId: CLIENT });
  const contents = createPortalContentsApi(CLIENT, conversation, options.mediaUrl);
  const portalCalls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname.endsWith('/auth/session')) return json(sessionBody);
    if (url.pathname.endsWith('/me/contexts')) return json(contextsBody);
    if (url.pathname.endsWith('/me/legal-acceptances')) return json(legalAccepted);
    if (url.pathname === `/clients/${CLIENT}`) { portalCalls.push(`${method} ${url.pathname}`); return json(portalClientBody(CLIENT, 'Padaria Central')); }
    if (url.pathname.startsWith(`/clients/${CLIENT}/threads`)) {
      const answered = conversation.handle(url, method, body);
      if (answered !== undefined) return answered;
    }
    if (url.pathname.startsWith(`/clients/${CLIENT}/contents/`)) {
      if (method === 'POST' && options.holdWrite !== undefined) await options.holdWrite;
      if (method === 'GET' && !url.pathname.includes('/media/') && options.holdRead !== undefined) await options.holdRead;
      const answered = contents.handle(url, method, body);
      if (answered !== undefined) return answered;
    }
    throw new Error(`unexpected ${method} ${url.pathname}${url.search}`);
  };
  return { impl, contents, conversation, portalCalls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const postUrl = (contentId = CONTENT, clientId = CLIENT): string => `/portal/${clientId}/conteudos/${contentId}`;

const renderPost = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = postUrl()) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const store = createAuthSessionStore(client);
  const probe = { pathname: '' };
  function Probe() { useCommittedLocation((location) => { probe.pathname = location.pathname; }); return null; }
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <Probe />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe };
};

const open = async (seed: Partial<PortalContentSeed> = {}, options: Options = {}) => {
  const scenario = setup(options);
  scenario.contents.seed({ id: CONTENT, clientId: CLIENT, ...seed });
  const view = renderPost(scenario.impl);
  return { ...scenario, ...view };
};

const title = (name: string) => screen.findByRole('heading', { level: 1, name });
const sentBodies = (contents: ReturnType<typeof setup>['contents'], action: string): unknown[] =>
  contents.bodies.filter((entry) => entry.path.endsWith(`/${action}`)).map((entry) => entry.body);

const askForChanges = async (comment: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Pedir ajuste' }));
  fireEvent.change(await screen.findByLabelText('O que precisa mudar?'), { target: { value: comment } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
};

describe('the post of the portal (#270)', () => {
  describe('what the person reads', () => {
    it('shows the title, the state, the format, the day in São Paulo, the whole caption and the two decisions', async () => {
      await open({ title: 'Lançamento da primavera', format: 'reels', publishOn: '2026-10-12', publishAtTime: '18:30', caption: 'Primeira linha\nSegunda linha' });
      expect(await title('Lançamento da primavera')).toBeTruthy();
      const meta = screen.getByRole('list', { name: 'Dados do conteúdo' });
      expect(within(meta).getByText('Aguardando aprovação')).toBeTruthy();
      expect(within(meta).getByText('Reels')).toBeTruthy();
      expect(within(meta).getByText('segunda-feira, 12 de outubro de 2026').getAttribute('datetime')).toBe('2026-10-12');
      expect(meta.textContent).toContain('18:30');
      expect(screen.getByRole('heading', { level: 2, name: 'Legenda' })).toBeTruthy();
      expect(document.querySelector('.portal-post__caption')?.textContent).toBe('Primeira linha\nSegunda linha');
      expect(screen.getByRole('heading', { level: 2, name: 'Sua decisão' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Pedir ajuste' })).toBeTruthy();
      expect(document.title).toBe('Lançamento da primavera — Portal do cliente — Ageniza');
    });

    it('says so when the post has no caption', async () => {
      await open({ caption: null });
      expect(await screen.findByText('Este post não tem legenda.')).toBeTruthy();
    });

    it('links back to the contents of the client', async () => {
      const { probe } = await open();
      const back = await screen.findByRole('link', { name: 'Conteúdos' });
      expect(back.getAttribute('href')).toBe(`/portal/${CLIENT}/conteudos`);
      fireEvent.click(back);
      await waitFor(() => { expect(probe.pathname).toBe(`/portal/${CLIENT}/conteudos`); });
    });

    it('shows only the title, the day and the format of a content in production, and asks for nothing else', async () => {
      const { contents, conversation } = await open({ state: 'in_production', title: 'Em produção', format: 'carousel', caption: 'LEGENDA SECRETA', publishAtTime: '09:00' });
      expect(await title('Em produção')).toBeTruthy();
      const meta = screen.getByRole('list', { name: 'Dados do conteúdo' });
      expect(within(meta).getByText('Em produção')).toBeTruthy();
      expect(within(meta).getByText('Carrossel')).toBeTruthy();
      expect(within(meta).getByText('segunda-feira, 12 de outubro de 2026')).toBeTruthy();
      expect(screen.getByText('Este conteúdo ainda está em produção. Quando estiver pronto, ele aparece aqui para você aprovar.')).toBeTruthy();
      expect(screen.queryByText('Legenda')).toBeNull();
      expect(screen.queryByText('LEGENDA SECRETA')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pedir ajuste' })).toBeNull();
      expect(screen.queryByRole('region', { name: /Conversa sobre/ })).toBeNull();
      expect(contents.calls.filter((call) => call.includes('/media/'))).toEqual([]);
      expect(conversation.calls).toEqual([]);
    });

    it.each([
      ['adjusting', 'Em ajuste', 'Foi pedido um ajuste. A agência vai revisar e enviar de novo para a sua aprovação.'],
      ['approved', 'Aprovado', 'Este conteúdo está aprovado. A agência cuida da publicação.'],
      ['published', 'Publicado', 'Este conteúdo já foi publicado.']
    ] as const)('says where a %s content stands and offers no decision', async (state, label, note) => {
      await open({ state, publishedOn: state === 'published' ? '2026-10-13' : null });
      await title('Lançamento da primavera');
      expect(within(screen.getByRole('list', { name: 'Dados do conteúdo' })).getByText(label)).toBeTruthy();
      expect(screen.getByText(note)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pedir ajuste' })).toBeNull();
      expect(screen.getByRole('region', { name: 'Conversa sobre Lançamento da primavera' })).toBeTruthy();
    });

    it('writes the day the post went live as text of São Paulo', async () => {
      await open({ state: 'published', publishedOn: '2026-10-13' });
      await title('Lançamento da primavera');
      expect(screen.getByText('terça-feira, 13 de outubro de 2026').getAttribute('datetime')).toBe('2026-10-13');
    });
  });

  describe('not found', () => {
    it.each([
      ['a content of another client', { id: OTHER_CONTENT, clientId: OTHER_CLIENT }],
      ['a cancelled content', { id: OTHER_CONTENT, clientId: CLIENT, state: 'cancelled' as const }]
    ])('answers "Página não encontrada" for %s, with the way home', async (_name, seed) => {
      const scenario = setup();
      scenario.contents.seed(seed);
      renderPost(scenario.impl, postUrl(OTHER_CONTENT));
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Voltar ao início' }).getAttribute('href')).toBe(`/portal/${CLIENT}/inicio`);
      expect(scenario.contents.calls).toEqual([`GET /clients/${CLIENT}/contents/${OTHER_CONTENT}`]);
      expect(screen.queryByText('Lançamento da primavera')).toBeNull();
    });

    it('answers "Página não encontrada" for an id the API does not know', async () => {
      const scenario = setup();
      renderPost(scenario.impl, postUrl(OTHER_CONTENT));
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    });

    it('does not even ask the API for an address that is not an id', async () => {
      const scenario = setup();
      renderPost(scenario.impl, `/portal/${CLIENT}/conteudos/nao-e-um-id`);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(scenario.contents.calls).toEqual([]);
    });

    it('does not show an answer that is not the content of the address', async () => {
      const scenario = setup();
      scenario.contents.seed({ id: CONTENT, clientId: CLIENT, title: 'Outro post' });
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === `/clients/${CLIENT}/contents/${OTHER_CONTENT}`) return scenario.impl(`http://127.0.0.1:3001/clients/${CLIENT}/contents/${CONTENT}`, init);
        return scenario.impl(input, init);
      };
      renderPost(impl, postUrl(OTHER_CONTENT));
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(screen.queryByText('Outro post')).toBeNull();
    });
  });

  describe('text of the server', () => {
    const SCRIPT = '<script>window.hacked = 1</script><img src=x onerror="window.hacked = 2">';
    const BIDI = 'abc\u202Edef\u2066ghi';

    it('draws the title, the caption and the names as text, never as markup', async () => {
      const { contents, conversation, container } = await open({ title: `Título ${SCRIPT} ${BIDI}`, caption: `Legenda ${SCRIPT} ${BIDI}` });
      conversation.seed({ contentId: CONTENT }, [{ side: 'agency', body: `Resposta ${SCRIPT} ${BIDI}`, at: '2026-10-13T01:30:00.000Z' }]);
      expect(contents.rows.size).toBe(1);
      await title(`Título ${SCRIPT} ${BIDI}`);
      expect(document.querySelector('.portal-post__caption')?.textContent).toBe(`Legenda ${SCRIPT} ${BIDI}`);
      expect(document.title).toBe(`Título ${SCRIPT} ${BIDI} — Portal do cliente — Ageniza`);
      fireEvent.click(await screen.findByRole('button', { name: /Aberta/ }));
      expect((await screen.findAllByText(`Resposta ${SCRIPT} ${BIDI}`)).length).toBeGreaterThan(0);
      expect(container.querySelector('script')).toBeNull();
      expect(document.querySelector('img[onerror], img[src="x"]')).toBeNull();
      expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
    });

    it('keeps the markup of a media label inert', async () => {
      await open({ title: SCRIPT });
      await title(SCRIPT);
      const image = await waitFor(() => {
        const found = document.querySelector('.portal-media__item');
        expect(found).not.toBeNull();
        return found as HTMLImageElement;
      });
      expect(image.getAttribute('alt')).toBe(`${SCRIPT}: mídia 1 de 1`);
      expect(document.querySelector('script')).toBeNull();
    });
  });

  describe('states of the screen', () => {
    it('shows a busy skeleton while the post is read', async () => {
      let release: () => void = () => undefined;
      const holdRead = new Promise<void>((resolveHold) => { release = resolveHold; });
      await open({}, { holdRead });
      const loading = await screen.findByLabelText('Carregando o conteúdo');
      expect(loading.getAttribute('aria-busy')).toBe('true');
      release();
      expect(await title('Lançamento da primavera')).toBeTruthy();
      expect(screen.queryByLabelText('Carregando o conteúdo')).toBeNull();
    });

    it('shows the error with a way to try again, and the post once it answers', async () => {
      const scenario = setup();
      scenario.contents.seed({ id: CONTENT, clientId: CLIENT });
      let failing = true;
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (failing && url.pathname === `/clients/${CLIENT}/contents/${CONTENT}`) return portalContentError(500, 'INTERNAL_ERROR', 'ERRO INTERNO DO SERVIDOR');
        return scenario.impl(input, init);
      };
      renderPost(impl);
      expect(await screen.findByText('Não foi possível carregar o conteúdo.', undefined, { timeout: 5000 })).toBeTruthy();
      expect(screen.queryByText('ERRO INTERNO DO SERVIDOR')).toBeNull();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      expect(await title('Lançamento da primavera')).toBeTruthy();
      expect(screen.queryByText('Não foi possível carregar o conteúdo.')).toBeNull();
    });

    it('says the conversation is empty when nobody wrote yet', async () => {
      await open();
      expect(await screen.findByText('Nenhuma conversa sobre este conteúdo')).toBeTruthy();
    });

    it('settles the one-time notice after the shell, and drops it when the person leaves', async () => {
      const scenario = setup();
      scenario.contents.seed({ id: CONTENT, clientId: CLIENT });
      renderPost(scenario.impl, { pathname: postUrl(), state: { invitationNotice: { agencyName: 'Agência Um' } } });
      await title('Lançamento da primavera');
      expect(await screen.findByText('Você já fazia parte de Agência Um. Nada mudou no seu acesso.')).toBeTruthy();
      fireEvent.click(screen.getByRole('link', { name: 'Conteúdos' }));
      await waitFor(() => { expect(screen.queryByText('Você já fazia parte de Agência Um. Nada mudou no seu acesso.')).toBeNull(); });
    });
  });

  describe('Aprovar', () => {
    it('sends the revision that was read, shows Aprovado and takes the decision away', async () => {
      const { contents, portalCalls } = await open({ revision: 7 });
      fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('Conteúdo aprovado. Obrigado!')).toBeTruthy();
      expect(sentBodies(contents, 'approve')).toEqual([{ revision: 7 }]);
      expect(contents.rows.get(CONTENT)?.state).toBe('approved');
      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull(); });
      expect(within(screen.getByRole('list', { name: 'Dados do conteúdo' })).getByText('Aprovado')).toBeTruthy();
      expect(screen.getByText('Este conteúdo está aprovado. A agência cuida da publicação.')).toBeTruthy();
      // The count of the Início lives in the client's answer: it is read again.
      await waitFor(() => { expect(portalCalls.length).toBeGreaterThan(1); });
    });

    it('sends one request however many times the button is pressed while it waits', async () => {
      let release: () => void = () => undefined;
      const holdWrite = new Promise<void>((resolveHold) => { release = resolveHold; });
      const { contents } = await open({}, { holdWrite });
      const approve = await screen.findByRole('button', { name: 'Aprovar' });
      fireEvent.click(approve);
      fireEvent.click(approve);
      fireEvent.click(approve);
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Pedir ajuste' }).hasAttribute('disabled')).toBe(true); });
      release();
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(sentBodies(contents, 'approve')).toHaveLength(1);
    });

    it('refuses what the agency changed meanwhile: its own text, the post read again, and the new revision on the next try', async () => {
      const { contents } = await open({ revision: 3, caption: 'Legenda antiga' });
      await screen.findByText('Legenda antiga');
      contents.editCaption(CONTENT, 'Legenda nova da agência');
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.')).toBeTruthy();
      expect(await screen.findByText('Legenda nova da agência')).toBeTruthy();
      expect(screen.queryByText('Legenda antiga')).toBeNull();
      expect(contents.rows.get(CONTENT)?.state).toBe('awaiting_approval');
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Aprovar' }).hasAttribute('disabled')).toBe(false); });
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('Conteúdo aprovado. Obrigado!')).toBeTruthy();
      expect(sentBodies(contents, 'approve')).toEqual([{ revision: 3 }, { revision: 4 }]);
      expect(screen.queryByText('A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.')).toBeNull();
    });

    it('refuses what is no longer waiting: its own text and the state read again', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Aprovar' });
      contents.setState(CONTENT, 'adjusting');
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.')).toBeTruthy();
      expect(await screen.findByText('Foi pedido um ajuste. A agência vai revisar e enviar de novo para a sua aprovação.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    });

    it('turns a content cancelled meanwhile into "não encontrado"', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Aprovar' });
      contents.setState(CONTENT, 'cancelled');
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    });

    it('words a lost race and any other failure without the text of the server', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Aprovar' });
      contents.failNextWrite(() => portalContentError(409, 'TRY_AGAIN', 'DEADLOCK DO SERVIDOR'));
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('Não foi possível agora. Tente de novo em instantes.')).toBeTruthy();
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Aprovar' }).hasAttribute('disabled')).toBe(false); });
      contents.failNextWrite(() => portalContentError(500, 'INTERNAL_ERROR', 'ERRO DO SERVIDOR'));
      fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByText('Não foi possível aprovar. Tente de novo.')).toBeTruthy();
      expect(screen.queryByText('ERRO DO SERVIDOR')).toBeNull();
      expect(screen.queryByText('DEADLOCK DO SERVIDOR')).toBeNull();
    });
  });

  describe('Pedir ajuste', () => {
    it('does not send without a comment: empty, only spaces and only invisible characters stay on the screen', async () => {
      const { contents } = await open();
      fireEvent.click(await screen.findByRole('button', { name: 'Pedir ajuste' }));
      const field = await screen.findByLabelText('O que precisa mudar?');
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      expect(await screen.findByText('Escreva o que precisa mudar.')).toBeTruthy();
      fireEvent.change(field, { target: { value: '   \n  ' } });
      expect(screen.queryByText('Escreva o que precisa mudar.')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      expect(await screen.findByText('Escreva o que precisa mudar.')).toBeTruthy();
      fireEvent.change(field, { target: { value: 'ajuste\u202E' } });
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      expect(await screen.findByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
      fireEvent.change(field, { target: { value: 'a'.repeat(5001) } });
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      expect(await screen.findByText('O pedido pode ter no máximo 5.000 bytes.')).toBeTruthy();
      expect(sentBodies(contents, 'request-changes')).toEqual([]);
      expect(contents.rows.get(CONTENT)?.state).toBe('awaiting_approval');
    });

    it('records the comment with the revision read, closes, shows Em ajuste and the conversation of the content', async () => {
      const { contents, conversation } = await open({ revision: 5 });
      await screen.findByText('Nenhuma conversa sobre este conteúdo');
      await askForChanges('  Troque a primeira foto  ');
      expect(await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem na conversa abaixo.')).toBeTruthy();
      expect(sentBodies(contents, 'request-changes')).toEqual([{ revision: 5, comment: 'Troque a primeira foto' }]);
      expect(screen.queryByLabelText('O que precisa mudar?')).toBeNull();
      expect(contents.rows.get(CONTENT)?.state).toBe('adjusting');
      expect(within(screen.getByRole('list', { name: 'Dados do conteúdo' })).getByText('Em ajuste')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
      const row = await screen.findByRole('button', { name: /Aberta por Maria \(cliente\)/ });
      expect(within(row).getByText('Troque a primeira foto')).toBeTruthy();
      expect(conversation.calls.some((call) => call.startsWith(`GET /clients/${CLIENT}/threads?contentId=${CONTENT}`))).toBe(true);
      fireEvent.click(row);
      const thread = await screen.findByRole('dialog', { name: `Conversa sobre Lançamento da primavera` });
      expect(await within(thread).findByText('Troque a primeira foto')).toBeTruthy();
      expect(within(thread).getByText('12/10 22:30', { exact: false })).toBeTruthy();
    });

    it('keeps what was typed when the request fails, and sends it on the next try', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Pedir ajuste' });
      contents.failNextWrite(() => portalContentError(500, 'INTERNAL_ERROR', 'ERRO DO SERVIDOR'));
      await askForChanges('Mude o tom');
      expect(await screen.findByText('Não foi possível enviar o pedido. Tente de novo.')).toBeTruthy();
      expect((screen.getByLabelText('O que precisa mudar?') as HTMLTextAreaElement).value).toBe('Mude o tom');
      expect(screen.queryByText('ERRO DO SERVIDOR')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem na conversa abaixo.');
      expect(sentBodies(contents, 'request-changes')).toEqual([{ revision: 1, comment: 'Mude o tom' }, { revision: 1, comment: 'Mude o tom' }]);
    });

    it('keeps the text and the dialog when the agency changed the post, and resends with the new revision', async () => {
      const { contents } = await open({ revision: 2 });
      await screen.findByRole('button', { name: 'Pedir ajuste' });
      contents.editCaption(CONTENT, 'Legenda reescrita');
      await askForChanges('Mude o fim');
      expect(await screen.findByText('A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.')).toBeTruthy();
      expect((screen.getByLabelText('O que precisa mudar?') as HTMLTextAreaElement).value).toBe('Mude o fim');
      await waitFor(() => { expect(contents.calls.filter((call) => call === `GET /clients/${CLIENT}/contents/${CONTENT}`).length).toBeGreaterThan(1); });
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem na conversa abaixo.');
      expect(sentBodies(contents, 'request-changes')).toEqual([{ revision: 2, comment: 'Mude o fim' }, { revision: 3, comment: 'Mude o fim' }]);
    });

    it('closes the dialog and says so when the content is no longer waiting', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Pedir ajuste' });
      contents.setState(CONTENT, 'approved');
      await askForChanges('Tarde demais');
      expect(await screen.findByText('A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.')).toBeTruthy();
      expect(screen.queryByLabelText('O que precisa mudar?')).toBeNull();
      expect(await screen.findByText('Este conteúdo está aprovado. A agência cuida da publicação.')).toBeTruthy();
    });

    it('says the text was not accepted when the server refuses the comment', async () => {
      const { contents } = await open();
      await screen.findByRole('button', { name: 'Pedir ajuste' });
      contents.failNextWrite(() => portalContentError(400, 'CONTENT_COMMENT_INVALID', 'MENSAGEM DO SERVIDOR'));
      await askForChanges('Texto aceito aqui');
      expect(await screen.findByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    });

    it('keeps the draft when the dialog is closed without sending', async () => {
      const { contents } = await open();
      fireEvent.click(await screen.findByRole('button', { name: 'Pedir ajuste' }));
      fireEvent.change(await screen.findByLabelText('O que precisa mudar?'), { target: { value: 'Rascunho' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fechar pedido de ajuste' }));
      expect(screen.queryByLabelText('O que precisa mudar?')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Pedir ajuste' }));
      expect((await screen.findByLabelText('O que precisa mudar?') as HTMLTextAreaElement).value).toBe('Rascunho');
      expect(sentBodies(contents, 'request-changes')).toEqual([]);
    });
  });

  describe('the conversation of the content', () => {
    it('reads the thread of this content, from the client side, and lets the person answer it', async () => {
      const { conversation } = await open();
      conversation.seed({ contentId: CONTENT }, [
        { side: 'client', body: 'Pedido anterior', at: '2026-10-13T01:30:00.000Z' },
        { side: 'agency', body: 'Ajustamos a legenda', at: '2026-10-13T01:40:00.000Z' }
      ]);
      conversation.seed({ contentId: OTHER_CONTENT }, [{ side: 'agency', body: 'Conversa de outro conteúdo', at: '2026-10-13T01:30:00.000Z' }]);
      const row = await screen.findByRole('button', { name: /Ajustamos a legenda/ });
      expect(screen.queryByText('Conversa de outro conteúdo')).toBeNull();
      fireEvent.click(row);
      const thread = await screen.findByRole('dialog', { name: 'Conversa sobre Lançamento da primavera' });
      fireEvent.change(await within(thread).findByLabelText('Escrever resposta'), { target: { value: 'Obrigada, ficou bom' } });
      fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
      await waitFor(() => { expect(conversation.bodies).toEqual([{ body: 'Obrigada, ficou bom' }]); });
      expect(conversation.calls.every((call) => call.includes(`/clients/${CLIENT}/threads`))).toBe(true);
    });
  });

  describe('the media', () => {
    const carousel = (count: number): Partial<PortalContentSeed> => ({
      format: 'carousel',
      media: Array.from({ length: count }, (_value, index) => ({ id: asset(index + 1), position: index + 1 })).reverse()
    });
    const shown = (): string | null => document.querySelector('.portal-media__item')?.getAttribute('src') ?? null;
    const region = (): HTMLElement => screen.getByRole('region', { name: 'Mídias do post' });

    it('shows the first media at full width, in position order, with its place and the original signed for the post', async () => {
      const { contents } = await open(carousel(3));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      expect(screen.getByText('1 de 3')).toBeTruthy();
      expect(document.querySelector('.portal-media__item')?.getAttribute('alt')).toBe('Lançamento da primavera: mídia 1 de 3');
      expect(contents.calls).toContain(`GET /clients/${CLIENT}/contents/${CONTENT}/media/${asset(1)}/url?variant=original`);
    });

    it('moves with Anterior and Próxima, which stop at the two ends', async () => {
      await open(carousel(3));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      const previous = screen.getByRole('button', { name: 'Anterior' });
      const next = screen.getByRole('button', { name: 'Próxima' });
      expect(previous.hasAttribute('disabled')).toBe(true);
      fireEvent.click(next);
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(2)}/original`); });
      expect(screen.getByText('2 de 3')).toBeTruthy();
      fireEvent.click(next);
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(3)}/original`); });
      expect(next.hasAttribute('disabled')).toBe(true);
      fireEvent.click(previous);
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(2)}/original`); });
    });

    it('moves with the keyboard: the arrows, Home and End, and not past the ends', async () => {
      await open(carousel(3));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      expect(region().getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(region(), { key: 'ArrowLeft' });
      expect(screen.getByText('1 de 3')).toBeTruthy();
      fireEvent.keyDown(region(), { key: 'ArrowRight' });
      await waitFor(() => { expect(screen.getByText('2 de 3')).toBeTruthy(); });
      fireEvent.keyDown(region(), { key: 'End' });
      await waitFor(() => { expect(screen.getByText('3 de 3')).toBeTruthy(); });
      fireEvent.keyDown(region(), { key: 'ArrowRight' });
      expect(screen.getByText('3 de 3')).toBeTruthy();
      fireEvent.keyDown(region(), { key: 'ArrowLeft' });
      await waitFor(() => { expect(screen.getByText('2 de 3')).toBeTruthy(); });
      fireEvent.keyDown(region(), { key: 'Home' });
      await waitFor(() => { expect(screen.getByText('1 de 3')).toBeTruthy(); });
    });

    it('leaves the arrows to the controls of a video', async () => {
      await open({ ...carousel(3), format: 'reels' });
      const video = await waitFor(() => {
        const found = document.querySelector('video');
        expect(found).not.toBeNull();
        return found as HTMLVideoElement;
      });
      fireEvent.keyDown(video, { key: 'ArrowRight' });
      expect(screen.getByText('1 de 3')).toBeTruthy();
    });

    it('moves with a swipe sideways and ignores a short one', async () => {
      await open(carousel(3));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      const swipe = (from: number, to: number): void => {
        fireEvent.touchStart(region(), { touches: [{ clientX: from }] });
        fireEvent.touchEnd(region(), { changedTouches: [{ clientX: to }] });
      };
      swipe(200, 180);
      expect(screen.getByText('1 de 3')).toBeTruthy();
      swipe(200, 100);
      await waitFor(() => { expect(screen.getByText('2 de 3')).toBeTruthy(); });
      swipe(100, 200);
      await waitFor(() => { expect(screen.getByText('1 de 3')).toBeTruthy(); });
      swipe(100, 200);
      expect(screen.getByText('1 de 3')).toBeTruthy();
    });

    it('does not swipe with two fingers', async () => {
      await open(carousel(3));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      fireEvent.touchStart(region(), { touches: [{ clientX: 200 }, { clientX: 220 }] });
      fireEvent.touchEnd(region(), { changedTouches: [{ clientX: 50 }] });
      expect(screen.getByText('1 de 3')).toBeTruthy();
    });

    it('jumps with the strip of thumbnails, all of them the thumbnail variant', async () => {
      const { contents } = await open(carousel(3));
      const strip = await screen.findByRole('list', { name: 'Miniaturas das mídias' });
      const thumbs = within(strip).getAllByRole('button');
      expect(thumbs.map((thumb) => thumb.getAttribute('aria-label'))).toEqual(['Ver mídia 1 de 3', 'Ver mídia 2 de 3', 'Ver mídia 3 de 3']);
      expect(thumbs[0]?.getAttribute('aria-current')).toBe('true');
      await waitFor(() => { expect(strip.querySelectorAll('img').length).toBe(3); });
      expect(Array.from(strip.querySelectorAll('img')).map((image) => image.getAttribute('src'))).toEqual([1, 2, 3].map((n) => `https://storage.test/${asset(n)}/thumbnail`));
      fireEvent.click(thumbs[2]!);
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(3)}/original`); });
      expect(thumbs[2]?.getAttribute('aria-current')).toBe('true');
      expect(thumbs[0]?.getAttribute('aria-current')).toBeNull();
      expect(contents.mediaRequests.filter((request) => request.variant === 'thumbnail').map((request) => request.assetId).sort()).toEqual([asset(1), asset(2), asset(3)]);
    });

    it('has no controls for a single media', async () => {
      await open({ format: 'image' });
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      expect(screen.queryByRole('button', { name: 'Próxima' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Miniaturas das mídias' })).toBeNull();
    });

    it('plays a video with its cover, the thumbnail variant, as the poster', async () => {
      const { contents } = await open({ format: 'reels', coverAssetId: asset(9) });
      const video = await waitFor(() => {
        const found = document.querySelector('video');
        expect(found?.getAttribute('poster')).toBe(`https://storage.test/${asset(9)}/thumbnail`);
        return found as HTMLVideoElement;
      });
      expect(video.getAttribute('src')).toBe(`https://storage.test/${asset(1)}/original`);
      expect(video.hasAttribute('controls')).toBe(true);
      expect(video.getAttribute('aria-label')).toBe('Lançamento da primavera: mídia 1 de 1');
      expect(document.querySelector('img.portal-media__item')).toBeNull();
      expect(contents.mediaRequests).toContainEqual({ assetId: asset(9), variant: 'thumbnail' });
    });

    it('uses the frame of the video as the poster when there is no cover, and none when the frame is not ready', async () => {
      const { contents } = await open({ format: 'long_video', coverAssetId: null });
      await waitFor(() => { expect(document.querySelector('video')?.getAttribute('poster')).toBe(`https://storage.test/${asset(1)}/thumbnail`); });
      expect(contents.mediaRequests).toContainEqual({ assetId: asset(1), variant: 'thumbnail' });
      cleanup();
      const scenario = setup();
      scenario.contents.seed({ id: CONTENT, clientId: CLIENT, format: 'vsl' });
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.searchParams.get('variant') === 'thumbnail') return portalContentError(409, 'VARIANT_NOT_READY');
        return scenario.impl(input, init);
      };
      renderPost(impl);
      await waitFor(() => { expect(document.querySelector('video')?.getAttribute('src')).toBe(`https://storage.test/${asset(1)}/original`); });
      expect(document.querySelector('video')?.hasAttribute('poster')).toBe(false);
    });

    it('draws an image of a carousel as a video when the browser cannot draw it as an image', async () => {
      await open(carousel(2));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      fireEvent.error(document.querySelector('img.portal-media__item')!);
      await waitFor(() => { expect(document.querySelector('video.portal-media__item')?.getAttribute('src')).toBe(`https://storage.test/${asset(1)}/original`); });
      expect(document.querySelector('img.portal-media__item')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
      await waitFor(() => { expect(document.querySelector('img.portal-media__item')?.getAttribute('src')).toBe(`https://storage.test/${asset(2)}/original`); });
    });

    it('says an image that does not load did not load, and offers to try again', async () => {
      await open({ format: 'image' });
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
      fireEvent.error(document.querySelector('img.portal-media__item')!);
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      expect(document.querySelector('video')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(1)}/original`); });
    });

    it('says the media did not load when the route refuses to sign it, and keeps the rest of the post', async () => {
      const scenario = setup();
      scenario.contents.seed({ id: CONTENT, clientId: CLIENT, format: 'carousel', media: [{ id: asset(1), position: 1 }, { id: asset(2), position: 2 }] });
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/media/${asset(1)}/url`)) return portalContentError(404, 'NOT_FOUND', 'Media asset not found.');
        return scenario.impl(input, init);
      };
      renderPost(impl);
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      expect(screen.queryByText('Media asset not found.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
      await waitFor(() => { expect(shown()).toBe(`https://storage.test/${asset(2)}/original`); });
    });

    it('never uses an address that is not http or https', async () => {
      await open({ format: 'image' }, { mediaUrl: () => 'javascript:window.hacked=1' });
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      expect(document.querySelector('.portal-media__item')).toBeNull();
    });

    it('says there is no media when an open post has none', async () => {
      await open({ media: [] });
      expect(await screen.findByText('Este conteúdo ainda não tem mídia.')).toBeTruthy();
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

    it('keeps the bottom bar the last piece of the shell with a short post, and the content taking the rest', async () => {
      const { container } = await open({ state: 'in_production' });
      await title('Lançamento da primavera');
      const shell = container.querySelector('.portal-shell') as HTMLElement;
      expect(Array.from(shell.children).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'header', 'main', 'nav']);
      expect(shell.lastElementChild).toBe(screen.getByRole('navigation', { name: 'Navegação do portal' }));
      // jsdom has no layout: the rules that hold a short page's bar at the bottom of a 360 px phone are read from the stylesheet.
      expect(rule('.portal-shell')).toMatch(/min-height:\s*100dvh;/);
      expect(rule('.portal-shell > .portal-content')).toMatch(/flex:\s*1;/);
      expect(rule('.portal-nav')).toMatch(/position:\s*sticky;/);
      expect(rule('.portal-nav')).toMatch(/bottom:\s*0;/);
    });

    it('lets every box shrink and every server text wrap, with no fixed width that could push 390 px sideways', () => {
      for (const selector of ['.portal-post', '.portal-post__section', '.portal-media', '.portal-media__stage', '.portal-media__strip']) {
        expect(rule(selector)).toMatch(/min-width:\s*0;/);
      }
      expect(rule('.portal-post h1')).toMatch(/overflow-wrap:\s*anywhere;/);
      const text = rule('.portal-post__caption,\n.portal-post__hint,\n.portal-post__request-label');
      expect(text).toMatch(/overflow-wrap:\s*anywhere;/);
      expect(rule('.portal-post__caption')).toMatch(/white-space:\s*pre-wrap;/);
      const item = rule('.portal-media__item');
      expect(item).toMatch(/width:\s*100%;/);
      expect(item).toMatch(/max-width:\s*100%;/);
      expect(rule('.portal-media__skeleton')).toMatch(/width:\s*100%;/);
      expect(rule('.portal-post__actions > .ui-button')).toMatch(/width:\s*100%;/);
      // The strip scrolls inside itself; the page does not.
      expect(rule('.portal-media__strip')).toMatch(/overflow-x:\s*auto;/);
      for (const selector of ['.portal-post', '.portal-post__section', '.portal-media', '.portal-media__stage', '.portal-media__item', '.portal-post__actions']) {
        expect(rule(selector)).not.toMatch(/(^|[^-])(width|min-width):\s*[\d.]+(px|rem)/);
      }
    });

    it('lets the swipe be ours sideways and the page scroll up and down', () => {
      expect(rule('.portal-media__stage')).toMatch(/touch-action:\s*pan-y;/);
    });
  });
});

describe('the fakes answer as the API does', () => {
  it('refuses a body that breaks the contract, and the preview variant, with a 400', async () => {
    const { impl, contents } = setup();
    contents.seed({ id: CONTENT, clientId: CLIENT });
    const send = async (path: string, body: unknown, method = 'POST') => impl(`http://127.0.0.1:3001${path}`, { method, body: JSON.stringify(body) });
    expect((await send(`/clients/${CLIENT}/contents/${CONTENT}/approve`, { revision: 1, extra: true })).status).toBe(400);
    expect((await send(`/clients/${CLIENT}/contents/${CONTENT}/request-changes`, { revision: 1, comment: '   ' })).status).toBe(400);
    expect((await impl(`http://127.0.0.1:3001/clients/${CLIENT}/contents/${CONTENT}/media/${asset(1)}/url?variant=preview`)).status).toBe(400);
    expect((await impl(`http://127.0.0.1:3001/clients/${CLIENT}/contents/${CONTENT}/media/${asset(9)}/url`)).status).toBe(404);
    expect(apiError(404, 'X').status).toBe(404);
  });
});
