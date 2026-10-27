// @vitest-environment jsdom
import { QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENCY_NAME,
  APPROVAL_TOKEN,
  asset,
  CLIENT_NAME,
  contentId,
  createApprovalApi,
  PERSON_EMAIL,
  type ApprovalApi,
  type ApprovalControls,
  type SeedContent
} from './approval-link-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { URL_MARGIN_MS } from './signed-url.js';

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

const visitor = { status: 'ready' as const, isAuthenticated: false, user: null };

beforeEach(() => { window.history.replaceState(null, '', '/'); });

interface Mounted {
  readonly api: ApprovalApi;
  readonly unmount: () => void;
}

/** Opens the page the way the e-mail does: the token in the fragment of the address bar, and nothing else. */
const open = (seeds: readonly SeedContent[], options: { fragment?: string; strict?: boolean; controls?: Partial<ApprovalControls>; entry?: string; setup?: (api: ApprovalApi) => void } = {}): Mounted => {
  const api = createApprovalApi(seeds, options.controls);
  options.setup?.(api);
  const fragment = options.fragment === undefined ? `#${APPROVAL_TOKEN}` : options.fragment;
  window.history.replaceState(null, '', `/aprovar${fragment}`);
  const client = new HttpClient('http://127.0.0.1:3001', api.impl);
  const tree = (
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[options.entry ?? '/aprovar']}>
          <ApplicationRoutes session={visitor} />
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  );
  const view = render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
  return { api, unmount: view.unmount };
};

const pendingHeading = (): Promise<HTMLElement> => screen.findByRole('heading', { level: 2, name: /^Para aprovar/ });
const loaded = async (seeds: readonly SeedContent[], options: Parameters<typeof open>[1] = {}): Promise<Mounted> => {
  const mounted = open(seeds, options);
  await pendingHeading();
  return mounted;
};
const card = (title: string): HTMLElement => screen.getByRole('article', { name: title });
const buttonsOf = (title: string): string[] => within(card(title)).queryAllByRole('button').map((button) => button.textContent.trim());

const A = { id: contentId(1), title: 'Lançamento da primavera' };
const B = { id: contentId(2), title: 'Promoção de outubro' };
const sessionCalls = (api: ApprovalApi) => api.callsTo('POST', /\/portal-approval\/session$/);
const batchCalls = (api: ApprovalApi) => api.callsTo('GET', /\/portal-approval\/batch$/);
const decisionCalls = (api: ApprovalApi) => api.calls.filter((call) => call.method === 'POST' && /\/(approve|request-changes)$/.test(call.path));

const held = (): { promise: Promise<void>; release: () => void } => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('the page of the approval link (#717)', () => {
  it('uses a token of the shape the API issues', () => {
    expect(APPROVAL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  describe('opening the link', () => {
    it('erases the fragment from the address bar before the first request leaves, and exchanges the token once, in the body, with credentials', async () => {
      const { api } = await loaded([A]);
      expect(window.location.hash).toBe('');
      expect(window.location.href).not.toContain(APPROVAL_TOKEN);
      expect(window.location.pathname).toBe('/aprovar');
      expect(sessionCalls(api)).toHaveLength(1);
      expect(sessionCalls(api)[0]).toMatchObject({ body: { token: APPROVAL_TOKEN }, credentials: 'include', search: '', hashAtSend: '' });
      expect(api.calls.every((call) => call.hashAtSend === '')).toBe(true);
    });

    it('never puts the token in the address of a request: no query, no path, and it is not sent a second time', async () => {
      const { api } = await loaded([{ ...A, media: [{ id: asset(1), kind: 'image' }] }]);
      await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` });
      for (const call of api.calls) {
        expect(call.path).not.toContain(APPROVAL_TOKEN);
        expect(call.search).not.toContain(APPROVAL_TOKEN);
        if (!/\/media\/[^/]+\/url$/.test(call.path)) expect(call.search).toBe('');
        expect(call.credentials).toBe('include');
      }
      expect(api.calls.filter((call) => JSON.stringify(call.body ?? null).includes(APPROVAL_TOKEN))).toHaveLength(1);
    });

    it('keeps the address bar on /aprovar and does not push a history entry: the back button holds no token', async () => {
      const before = window.history.length;
      await loaded([A]);
      expect(window.history.length).toBe(before);
    });

    it('decides nothing by opening: the only POST is the exchange, and every content keeps its state', async () => {
      const { api } = await loaded([A, B]);
      await screen.findAllByRole('button', { name: 'Aprovar' });
      expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual(['/portal-approval/session']);
      expect(api.rows.map((row) => row.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    });

    it('exchanges the token once even when the page is mounted twice (Strict Mode)', async () => {
      const { api } = await loaded([A], { strict: true });
      expect(sessionCalls(api)).toHaveLength(1);
      expect(batchCalls(api)).toHaveLength(1);
    });

    it('reads the lot straight away when there is no fragment (a reload after it was erased), without asking for a new session', async () => {
      const { api } = await loaded([A], { fragment: '', setup: (server) => { server.world.cookie = true; } });
      expect(sessionCalls(api)).toHaveLength(0);
      expect(batchCalls(api)).toHaveLength(1);
      expect(screen.getByRole('article', { name: A.title })).toBeTruthy();
    });

    it('shows the dead-link screen for an address with no fragment and no session', async () => {
      open([A], { fragment: '' });
      expect(await screen.findByRole('heading', { level: 1, name: 'Este link não vale mais' })).toBeTruthy();
    });

    it('treats a fragment that is not a token as a wrong link: no request at all, and the fragment is erased', async () => {
      const { api } = open([A], { fragment: '#main-content' });
      expect(await screen.findByRole('heading', { level: 1, name: 'Este link não vale mais' })).toBeTruthy();
      expect(api.calls).toHaveLength(0);
      expect(window.location.hash).toBe('');
    });

    it('does not touch the account session of the product: no request outside /portal-approval', async () => {
      const { api } = await loaded([A]);
      expect(api.calls.every((call) => call.path.startsWith('/portal-approval/'))).toBe(true);
    });

    it('does not complain when the page is closed while the answer is on its way', async () => {
      const gate = held();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { api, unmount } = open([A], { controls: { hold: { exchange: gate.promise } } });
      await waitFor(() => { expect(sessionCalls(api)).toHaveLength(1); });
      unmount();
      gate.release();
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });
  });

  describe('the referrer', () => {
    it('sets no-referrer on a document that says otherwise, for as long as the page is open, and puts it back', async () => {
      const meta = document.createElement('meta');
      meta.name = 'referrer';
      meta.content = 'strict-origin-when-cross-origin';
      document.head.append(meta);
      const { unmount } = open([A]);
      expect(meta.content).toBe('no-referrer');
      unmount();
      expect(meta.content).toBe('strict-origin-when-cross-origin');
      meta.remove();
    });

    it('adds the meta when the document has none, and removes it with the page', () => {
      const { unmount } = open([A]);
      const added = document.head.querySelectorAll('meta[name="referrer"]');
      expect(added).toHaveLength(1);
      expect((added[0] as HTMLMetaElement).content).toBe('no-referrer');
      unmount();
      expect(document.head.querySelectorAll('meta[name="referrer"]')).toHaveLength(0);
    });

    it('is also in the static document, so it holds before any script runs', () => {
      const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
      expect(html).toMatch(/<meta name="referrer" content="no-referrer"\s*\/>/);
    });
  });

  describe('the states of the page', () => {
    it('says it is loading, with the shape of the page, until the lot arrives', async () => {
      const gate = held();
      open([A], { controls: { hold: { batch: gate.promise } } });
      expect((await screen.findByRole('status')).textContent).toBe('Carregando os conteúdos…');
      expect(screen.getByLabelText('Carregando os conteúdos').getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByRole('article')).toBeNull();
      gate.release();
      expect(await pendingHeading()).toBeTruthy();
      expect(screen.queryByText('Carregando os conteúdos…')).toBeNull();
    });

    it('is one screen for a dead link: no reason, no content, no decision, and the lot is never asked for', async () => {
      const { api } = open([A], { setup: (server) => { server.world.linkAlive = false; } });
      expect(await screen.findByRole('heading', { level: 1, name: 'Este link não vale mais' })).toBeTruthy();
      expect(screen.getByText('Abra o e-mail mais recente ou peça um novo link à agência.')).toBeTruthy();
      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
      expect(document.body.textContent).not.toMatch(/venceu|expirou|revogad|arquivad|suspens/i);
      expect(batchCalls(api)).toHaveLength(0);
    });

    it('is the same screen for a token the server finds malformed (400), so the page never tells which part was wrong', async () => {
      open([A], { controls: { fail: { exchange: () => new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'MENSAGEM DO SERVIDOR' } }), { status: 400, headers: { 'content-type': 'application/json' } }) } } });
      expect(await screen.findByRole('heading', { level: 1, name: 'Este link não vale mais' })).toBeTruthy();
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
    });

    it('tells the session ended, and asks to open the link of the e-mail again, when the link dies after the lot was read', async () => {
      const { api } = await loaded([A, B]);
      api.world.sessionLive = false;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Sua sessão venceu' })).toBeTruthy();
      expect(screen.getByText('Abra o link do e-mail de novo para continuar. Se o link ainda valer, ele abre uma sessão nova.')).toBeTruthy();
      expect(screen.queryByRole('article')).toBeNull();
      expect(api.row(A.id).status).toBe('awaiting_approval');
    });

    it('says there is nothing to approve when every content was decided, and still shows them with no buttons', async () => {
      await loaded([{ ...A, status: 'approved' }, { ...B, status: 'adjusting' }]);
      expect(screen.getByText('Nada para aprovar agora')).toBeTruthy();
      expect(screen.getByText('Os conteúdos deste e-mail já foram decididos.')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 2, name: 'Outros conteúdos deste e-mail' })).toBeTruthy();
      expect(buttonsOf(A.title)).toEqual([]);
      expect(buttonsOf(B.title)).toEqual([]);
      expect(within(card(A.title)).getByText('Aprovado')).toBeTruthy();
      expect(within(card(B.title)).getByText('Em ajuste')).toBeTruthy();
    });

    it('says the lot is empty when there is no content at all', async () => {
      await loaded([]);
      expect(screen.getByText('Não há conteúdos neste e-mail no momento.')).toBeTruthy();
      expect(screen.queryByText('Nada para aprovar agora')).toBeNull();
    });

    const rateLimited = (): Response => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'MENSAGEM DO SERVIDOR' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } });

    it('says the limit was reached, and the retry exchanges the same token again', async () => {
      const { api } = open([A], { controls: { fail: { exchange: rateLimited } } });
      expect((await screen.findByRole('alert')).textContent).toContain('Muitas tentativas agora. Espere alguns minutos e tente de novo.');
      expect(screen.queryByRole('article')).toBeNull();
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
      delete api.controls.fail.exchange;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      await pendingHeading();
      expect(sessionCalls(api).map((call) => call.body)).toEqual([{ token: APPROVAL_TOKEN }, { token: APPROVAL_TOKEN }]);
      expect(window.location.hash).toBe('');
    });

    it('says the limit was reached when the lot is what was refused, and retries only the lot', async () => {
      const { api } = open([A], { controls: { fail: { batch: rateLimited } } });
      expect((await screen.findByRole('alert')).textContent).toContain('Muitas tentativas agora');
      delete api.controls.fail.batch;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      await pendingHeading();
      expect(sessionCalls(api)).toHaveLength(1);
      expect(batchCalls(api)).toHaveLength(2);
    });

    it('says the network failed, with a retry that works, and never shows the server text', async () => {
      const { api } = open([A], { controls: { fail: { batch: () => 'network' } } });
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Não foi possível carregar os conteúdos. Confira a conexão e tente de novo.');
      expect(document.body.textContent).not.toContain('Failed to fetch');
      delete api.controls.fail.batch;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
      await pendingHeading();
      expect(screen.getByRole('article', { name: A.title })).toBeTruthy();
      expect(sessionCalls(api)).toHaveLength(1);
    });

    it('says the same for a server error as for a network failure', async () => {
      open([A], { controls: { fail: { batch: () => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }), { status: 500, headers: { 'content-type': 'application/json' } }) } } });
      expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar os conteúdos.');
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
    });
  });

  describe('what the person reads', () => {
    it('shows who sent it, for whom, until when the link lasts (a day of São Paulo), and the title of the page', async () => {
      await loaded([A]);
      expect(screen.getByRole('heading', { level: 1, name: 'Conteúdos para aprovar' })).toBeTruthy();
      expect(screen.getByText(`${AGENCY_NAME} enviou conteúdos de ${CLIENT_NAME} para a sua aprovação. Este link vale até 3 de novembro.`)).toBeTruthy();
      expect(document.title).toBe('Conteúdos para aprovar — Ageniza');
    });

    it('draws each content as a card on the phone of the feed, with its state, format, day in São Paulo, time, whole caption and the client', async () => {
      await loaded([{ ...A, format: 'reels', publishOn: '2026-10-12', publishAtTime: '18:30', caption: 'Primeira linha\nSegunda linha' }]);
      const article = card(A.title);
      expect(within(article).getByRole('heading', { level: 3, name: A.title })).toBeTruthy();
      const meta = within(article).getByRole('list', { name: 'Dados do conteúdo' });
      expect(within(meta).getByText('Aguardando aprovação')).toBeTruthy();
      expect(within(meta).getByText('Reels')).toBeTruthy();
      expect(within(meta).getByText('segunda-feira, 12 de outubro de 2026').getAttribute('datetime')).toBe('2026-10-12');
      expect(meta.textContent).toContain('18:30');
      const phone = within(article).getByRole('group', { name: `Prévia de ${A.title} no celular` });
      expect(phone.querySelector('.content-phone')).not.toBeNull();
      expect(phone.querySelector('.content-phone__island')).not.toBeNull();
      expect(phone.textContent).toContain(CLIENT_NAME);
      expect(within(phone).getByText((_text, element) => element?.className === 'approval-post__caption' && element.textContent === 'Primeira linha\nSegunda linha')).toBeTruthy();
    });

    it('says a post has no caption and no media, instead of drawing an empty phone', async () => {
      await loaded([{ ...A, caption: null, media: [] }]);
      expect(within(card(A.title)).getByText('Este post não tem legenda.')).toBeTruthy();
      expect(within(card(A.title)).getByText('Este conteúdo ainda não tem mídia.')).toBeTruthy();
    });

    it('shows a content in production as its title, day and format only: no phone, no caption, no buttons', async () => {
      await loaded([A, { id: contentId(3), title: 'Em produção ainda', status: 'in_production', format: 'carousel', publishOn: '2026-10-20' }]);
      const article = card('Em produção ainda');
      expect(within(article).getByText('Em produção')).toBeTruthy();
      expect(within(article).getByText('Carrossel')).toBeTruthy();
      expect(within(article).getByText('terça-feira, 20 de outubro de 2026')).toBeTruthy();
      expect(within(article).getByText('Este conteúdo ainda está em produção. Quando estiver pronto, ele chega aqui para você aprovar.')).toBeTruthy();
      expect(within(article).queryByRole('group')).toBeNull();
      expect(buttonsOf('Em produção ainda')).toEqual([]);
    });

    it('draws the buttons by canDecide and nothing else: a content that waits but cannot be decided has none, and so do the decided ones', async () => {
      await loaded([
        A,
        { id: contentId(2), title: 'Aguarda mas travado', status: 'awaiting_approval', locked: true },
        { id: contentId(3), title: 'Já aprovado', status: 'approved' },
        { id: contentId(4), title: 'Em ajuste', status: 'adjusting' },
        { id: contentId(5), title: 'Já publicado', status: 'published' }
      ]);
      expect(buttonsOf(A.title)).toEqual(['Pedir ajuste', 'Aprovar']);
      for (const title of ['Aguarda mas travado', 'Já aprovado', 'Em ajuste', 'Já publicado']) expect(buttonsOf(title)).toEqual([]);
      expect(screen.getAllByRole('button', { name: 'Aprovar' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Pedir ajuste' })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 2, name: 'Para aprovar (1)' })).toBeTruthy();
      expect(within(card('Já publicado')).getByText('Publicado')).toBeTruthy();
    });

    it('puts the contents to decide first and the others after them', async () => {
      await loaded([{ id: contentId(3), title: 'Já aprovado', status: 'approved' }, A]);
      const titles = screen.getAllByRole('article').map((article) => article.querySelector('h3')?.textContent);
      expect(titles).toEqual([A.title, 'Já aprovado']);
    });
  });

  describe('the media on the phone', () => {
    it('asks for the signed address of the original and draws it as the picture of the post', async () => {
      const { api } = await loaded([{ ...A, media: [{ id: asset(7), kind: 'image' }] }]);
      const picture = await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` });
      expect(picture.getAttribute('src')).toMatch(new RegExp(`^https://storage.example.test/${asset(7)}/original\\?n=\\d+$`));
      const media = api.callsTo('GET', /\/media\/[^/]+\/url$/);
      expect(media.map((call) => `${call.path}${call.search}`)).toEqual([`/portal-approval/contents/${A.id}/media/${asset(7)}/url?variant=original`]);
    });

    it('moves through a carousel with Anterior and Próxima, asking for each picture as it is shown', async () => {
      const { api } = await loaded([{ ...A, format: 'carousel', media: [{ id: asset(1), kind: 'image' }, { id: asset(2), kind: 'image' }, { id: asset(3), kind: 'image' }] }]);
      await screen.findByRole('img', { name: `${A.title}: mídia 1 de 3` });
      expect(within(card(A.title)).getByText('1 de 3')).toBeTruthy();
      expect((within(card(A.title)).getByRole('button', { name: /Anterior/ }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(card(A.title)).getByRole('button', { name: /Próxima/ }));
      const second = await screen.findByRole('img', { name: `${A.title}: mídia 2 de 3` });
      expect(second.getAttribute('src')).toContain(`/${asset(2)}/original`);
      expect(within(card(A.title)).getByText('2 de 3')).toBeTruthy();
      expect(api.callsTo('GET', /\/media\/[^/]+\/url$/).map((call) => call.path.split('/')[5])).toEqual([asset(1), asset(2)]);
    });

    it('draws a video with its frame as the poster, asked as the thumbnail', async () => {
      const { api } = await loaded([{ ...A, format: 'reels', coverAssetId: asset(9), media: [{ id: asset(4), kind: 'video' }] }]);
      const video = await screen.findByLabelText(`${A.title}: mídia 1 de 1`);
      expect(video.tagName).toBe('VIDEO');
      await waitFor(() => { expect(video.getAttribute('poster')).toMatch(new RegExp(`/${asset(9)}/thumbnail\\?n=\\d+$`)); });
      expect(video.getAttribute('src')).toContain(`/${asset(4)}/original`);
      expect(api.callsTo('GET', /\/media\/[^/]+\/url$/).map((call) => call.search).sort()).toEqual(['?variant=original', '?variant=thumbnail']);
    });

    it('asks again, shortly before it lapses, for the signed address of a picture that stays on screen', async () => {
      const { api } = await loaded([A], { controls: { mediaTtlMs: URL_MARGIN_MS + 1_200 } });
      const first = (await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` })).getAttribute('src');
      expect(first).toContain('?n=1');
      await waitFor(() => { expect(api.callsTo('GET', /\/media\/[^/]+\/url$/).length).toBeGreaterThanOrEqual(2); }, { timeout: 4_000 });
      await waitFor(() => { expect(screen.getByRole('img', { name: `${A.title}: mídia 1 de 1` }).getAttribute('src')).not.toBe(first); });
      expect(screen.getByRole('img', { name: `${A.title}: mídia 1 de 1` }).getAttribute('src')).toMatch(/\?n=[2-9]$/);
    }, 10_000);

    it('asks again when the tab comes back to the front after the address lapsed (a phone freezes the timer of a hidden tab), and not while it is still fresh', async () => {
      const { api } = await loaded([A]);
      const first = (await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` })).getAttribute('src');
      expect(first).toContain('?n=1');
      const mediaCalls = () => api.callsTo('GET', /\/media\/[^/]+\/url$/);
      // Back to the front with five minutes of address still ahead: nothing to ask.
      act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 60); });
      expect(mediaCalls()).toHaveLength(1);
      // The person comes back ten minutes later; only the clock moves, the page's own timer never fired.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 10 * 60_000);
        act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
        await waitFor(() => { expect(mediaCalls()).toHaveLength(2); });
        await waitFor(() => { expect(screen.getByRole('img', { name: `${A.title}: mídia 1 de 1` }).getAttribute('src')).toContain('?n=2'); });
      } finally {
        vi.useRealTimers();
        focusManager.setFocused(undefined);
      }
    });

    it('says the media could not load when the signed address is refused, and asks again on the retry', async () => {
      const { api } = await loaded([A], { controls: { fail: { media: () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'MENSAGEM DO SERVIDOR' } }), { status: 404, headers: { 'content-type': 'application/json' } }) } } });
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
      delete api.controls.fail.media;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` })).toBeTruthy();
    });

    it('asks for a new address when the browser refuses the one it has (it lapsed), instead of leaving a broken picture', async () => {
      const { api } = await loaded([A]);
      const picture = await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` });
      fireEvent.error(picture);
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => { expect(api.callsTo('GET', /\/media\/[^/]+\/url$/)).toHaveLength(2); });
      await waitFor(() => { expect(screen.getByRole('img', { name: `${A.title}: mídia 1 de 1` }).getAttribute('src')).toContain('?n=2'); });
    });

    it('keeps the failure on screen until the new address is there: the refused picture is never drawn again meanwhile', async () => {
      const { api } = await loaded([A]);
      fireEvent.error(await screen.findByRole('img', { name: `${A.title}: mídia 1 de 1` }));
      expect(await screen.findByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      const gate = held();
      api.controls.hold.media = gate.promise;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Tentar de novo' }));
      await waitFor(() => { expect(api.callsTo('GET', /\/media\/[^/]+\/url$/)).toHaveLength(2); });
      expect(screen.queryByRole('img', { name: `${A.title}: mídia 1 de 1` })).toBeNull();
      expect(screen.getByText('Não foi possível carregar esta mídia.')).toBeTruthy();
      gate.release();
      await waitFor(() => { expect(screen.getByRole('img', { name: `${A.title}: mídia 1 de 1` }).getAttribute('src')).toContain('?n=2'); });
    });
  });

  describe('Aprovar', () => {
    it('sends the revision the person read, and only that, to the content of its card', async () => {
      const { api } = await loaded([{ ...A, revision: 4 }, { ...B, revision: 9 }]);
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      await waitFor(() => { expect(decisionCalls(api)).toHaveLength(1); });
      expect(decisionCalls(api)[0]).toMatchObject({ method: 'POST', path: `/portal-approval/contents/${A.id}/approve`, body: { revision: 4 }, search: '', credentials: 'include' });
    });

    it('moves the content out of the list to decide, says so, and the server state is the one that changed', async () => {
      const { api } = await loaded([A, B]);
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      const notice = await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(api.row(A.id).status).toBe('approved');
      expect(api.row(B.id).status).toBe('awaiting_approval');
      expect(screen.getByRole('heading', { level: 2, name: 'Para aprovar (1)' })).toBeTruthy();
      expect(buttonsOf(A.title)).toEqual([]);
      expect(within(card(A.title)).getByText('Aprovado')).toBeTruthy();
      expect(buttonsOf(B.title)).toEqual(['Pedir ajuste', 'Aprovar']);
      expect(document.activeElement).toBe(notice.closest('.approval__notice'));
      const sections = screen.getAllByRole('region');
      expect(within(sections.find((section) => section.getAttribute('aria-labelledby') === 'approval-others-title')!).getByRole('article', { name: A.title })).toBeTruthy();
    });

    it('shows the sending state, keeps the other cards still while it lasts, and does not repeat the request on a double click', async () => {
      const gate = held();
      const { api } = await loaded([A, B], { controls: { hold: {} } });
      api.controls.hold.decision = gate.promise;
      const button = within(card(A.title)).getByRole('button', { name: 'Aprovar' });
      act(() => { button.click(); button.click(); });
      await waitFor(() => { expect(decisionCalls(api)).toHaveLength(1); });
      expect(within(card(A.title)).getByRole('button', { name: 'Aprovar' }).getAttribute('aria-busy')).toBe('true');
      expect((within(card(B.title)).getByRole('button', { name: 'Aprovar' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(card(B.title)).getByRole('button', { name: 'Aprovar' }));
      gate.release();
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(decisionCalls(api)).toHaveLength(1);
    });

    it('acts on the content of the card that was pressed, not on the first one', async () => {
      const { api } = await loaded([A, B]);
      fireEvent.click(within(card(B.title)).getByRole('button', { name: 'Aprovar' }));
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(api.row(B.id).status).toBe('approved');
      expect(api.row(A.id).status).toBe('awaiting_approval');
      expect(buttonsOf(A.title)).toEqual(['Pedir ajuste', 'Aprovar']);
    });

    it('says it failed, in the card, and leaves the content to be approved again', async () => {
      const { api } = await loaded([A], { controls: { fail: { decision: () => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }), { status: 500, headers: { 'content-type': 'application/json' } }) } } });
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect((await within(card(A.title)).findByRole('alert')).textContent).toBe('Não foi possível aprovar. Tente de novo.');
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
      expect(buttonsOf(A.title)).toEqual(['Pedir ajuste', 'Aprovar']);
      delete api.controls.fail.decision;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(api.row(A.id).status).toBe('approved');
    });

    it('says the limit was reached on a decision without leaving the page, and the buttons are back', async () => {
      await loaded([A], { controls: { fail: { decision: () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'MENSAGEM DO SERVIDOR' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } }) } } });
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect((await within(card(A.title)).findByRole('alert')).textContent).toBe('Muitas tentativas agora. Espere alguns minutos e tente de novo.');
      expect(buttonsOf(A.title)).toEqual(['Pedir ajuste', 'Aprovar']);
    });

    it('keeps the focus on Aprovar while it sends: the button is aria-disabled, never natively disabled, so the keyboard stays where it was', async () => {
      const gate = held();
      const { api } = await loaded([A], { controls: { hold: { decision: gate.promise } } });
      const button = within(card(A.title)).getByRole('button', { name: 'Aprovar' }) as HTMLButtonElement;
      button.focus();
      fireEvent.click(button);
      await waitFor(() => { expect(decisionCalls(api)).toHaveLength(1); });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.disabled).toBe(false);
      expect(document.activeElement).toBe(button);
      gate.release();
      await screen.findByText('Conteúdo aprovado. Obrigado!');
    });

    it('says to try again on a conflict of the database that is not a change of the content (TRY_AGAIN), without reading the lot again', async () => {
      const { api } = await loaded([A], { controls: { fail: { decision: () => new Response(JSON.stringify({ error: { code: 'TRY_AGAIN', message: 'MENSAGEM DO SERVIDOR' } }), { status: 409, headers: { 'content-type': 'application/json' } }) } } });
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect((await within(card(A.title)).findByRole('alert')).textContent).toBe('Não foi possível agora. Tente de novo em instantes.');
      expect(batchCalls(api)).toHaveLength(1);
      expect(buttonsOf(A.title)).toEqual(['Pedir ajuste', 'Aprovar']);
    });

    it('reads the lot again when the revision changed, says why, and the next approval carries the new revision', async () => {
      const { api } = await loaded([{ ...A, revision: 1 }]);
      api.row(A.id).revision = 2;
      api.row(A.id).title = 'Título novo da agência';
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect((await screen.findByRole('alert')).textContent).toBe('A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.');
      await waitFor(() => { expect(batchCalls(api)).toHaveLength(2); });
      expect(await screen.findByRole('article', { name: 'Título novo da agência' })).toBeTruthy();
      expect(api.row(A.id).status).toBe('awaiting_approval');
      fireEvent.click(within(card('Título novo da agência')).getByRole('button', { name: 'Aprovar' }));
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(decisionCalls(api).map((call) => call.body)).toEqual([{ revision: 1 }, { revision: 2 }]);
    });

    it('reads the lot again when somebody else decided first, and shows the content as it is now, with no buttons', async () => {
      const { api } = await loaded([A, B]);
      api.row(A.id).status = 'approved';
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect((await screen.findByRole('alert')).textContent).toBe('A situação deste conteúdo mudou enquanto você o via. Mostramos a situação atual.');
      await waitFor(() => { expect(batchCalls(api)).toHaveLength(2); });
      await waitFor(() => { expect(buttonsOf(A.title)).toEqual([]); });
      expect(within(card(A.title)).getByText('Aprovado')).toBeTruthy();
      expect(buttonsOf(B.title)).toEqual(['Pedir ajuste', 'Aprovar']);
    });

    it('holds every button while the lot is read again, so no click carries a revision about to be replaced', async () => {
      const { api } = await loaded([A, B]);
      api.row(A.id).revision = 5;
      const gate = held();
      api.controls.hold.batch = gate.promise;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      await waitFor(() => { expect(batchCalls(api)).toHaveLength(2); });
      await waitFor(() => { expect(screen.getAllByRole('button', { name: 'Aprovar' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true); });
      for (const button of screen.getAllByRole('button', { name: /Aprovar|Pedir ajuste/ })) fireEvent.click(button);
      expect(decisionCalls(api)).toHaveLength(1);
      gate.release();
      await waitFor(() => { expect(screen.getAllByRole('button', { name: 'Aprovar' }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true); });
      expect(decisionCalls(api)).toHaveLength(1);
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      await screen.findByText('Conteúdo aprovado. Obrigado!');
      expect(decisionCalls(api).map((call) => call.body)).toEqual([{ revision: 1 }, { revision: 5 }]);
    });

    it('goes to the "session ended" screen when the link no longer answers, and nothing was decided', async () => {
      const { api } = await loaded([A]);
      api.world.linkAlive = false;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Aprovar' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Sua sessão venceu' })).toBeTruthy();
      expect(api.row(A.id).status).toBe('awaiting_approval');
    });
  });

  describe('Pedir ajuste', () => {
    const ask = async (title: string, comment: string): Promise<void> => {
      fireEvent.click(within(card(title)).getByRole('button', { name: 'Pedir ajuste' }));
      fireEvent.change(await screen.findByLabelText('O que precisa mudar?'), { target: { value: comment } });
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    };

    it('opens a dialog that asks what must change, and asks nothing of the server by opening it', async () => {
      const { api } = await loaded([A]);
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Pedir ajuste' }));
      expect(await screen.findByLabelText('O que precisa mudar?')).toBeTruthy();
      expect(screen.getByText('A agência vai ver a sua mensagem.')).toBeTruthy();
      expect(decisionCalls(api)).toHaveLength(0);
    });

    it('requires the comment: a blank one is refused on the screen, with the words, and no request is sent', async () => {
      const { api } = await loaded([A]);
      await ask(A.title, '   ');
      expect(await screen.findByText('Escreva o que precisa mudar.')).toBeTruthy();
      expect(decisionCalls(api)).toHaveLength(0);
      expect(api.row(A.id).status).toBe('awaiting_approval');
    });

    it('sends the revision and the trimmed comment to the content of its card, and moves the content to the others as "Em ajuste"', async () => {
      const { api } = await loaded([{ ...A, revision: 3 }, { ...B, revision: 8 }]);
      await ask(B.title, '  Trocar a foto da capa por uma com mais luz.  ');
      await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem.');
      expect(decisionCalls(api)).toHaveLength(1);
      expect(decisionCalls(api)[0]).toMatchObject({ path: `/portal-approval/contents/${B.id}/request-changes`, body: { revision: 8, comment: 'Trocar a foto da capa por uma com mais luz.' } });
      expect(api.row(B.id).status).toBe('adjusting');
      expect(api.row(A.id).status).toBe('awaiting_approval');
      expect(buttonsOf(B.title)).toEqual([]);
      expect(within(card(B.title)).getByText('Em ajuste')).toBeTruthy();
      expect(screen.queryByLabelText('O que precisa mudar?')).toBeNull();
      expect(screen.getByRole('heading', { level: 2, name: 'Para aprovar (1)' })).toBeTruthy();
    });

    it('keeps the dialog and what was typed when the sending fails, and the retry sends the very same text', async () => {
      const { api } = await loaded([A], { controls: { fail: { decision: () => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }), { status: 500, headers: { 'content-type': 'application/json' } }) } } });
      await ask(A.title, 'Mudar a legenda');
      expect((await screen.findByText('Não foi possível enviar o pedido. Tente de novo.')).textContent).toBeTruthy();
      expect((screen.getByLabelText('O que precisa mudar?') as HTMLTextAreaElement).value).toBe('Mudar a legenda');
      expect(document.body.textContent).not.toContain('MENSAGEM DO SERVIDOR');
      delete api.controls.fail.decision;
      fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem.');
      expect(decisionCalls(api).map((call) => call.body)).toEqual([{ revision: 1, comment: 'Mudar a legenda' }, { revision: 1, comment: 'Mudar a legenda' }]);
    });

    it('says the characters are not accepted when the server refuses the text itself', async () => {
      await loaded([A]);
      await ask(A.title, 'Texto\u0000invisível');
      expect(await screen.findByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
      expect((screen.getByLabelText('O que precisa mudar?') as HTMLTextAreaElement).value).toBe('Texto\u0000invisível');
    });

    it('closes the dialog, reads the lot again and says why when the revision changed under the request', async () => {
      const { api } = await loaded([A]);
      api.row(A.id).revision = 2;
      await ask(A.title, 'Mudar a legenda');
      expect((await screen.findByRole('alert')).textContent).toBe('A agência alterou este conteúdo depois que você o abriu. Mostramos a versão atual: leia de novo antes de aprovar.');
      await waitFor(() => { expect(batchCalls(api)).toHaveLength(2); });
      expect(screen.queryByLabelText('O que precisa mudar?')).toBeNull();
      expect(api.row(A.id).status).toBe('awaiting_approval');
    });

    it('does not send twice when the send button is pressed twice in a row', async () => {
      const gate = held();
      const { api } = await loaded([A]);
      api.controls.hold.decision = gate.promise;
      fireEvent.click(within(card(A.title)).getByRole('button', { name: 'Pedir ajuste' }));
      fireEvent.change(await screen.findByLabelText('O que precisa mudar?'), { target: { value: 'Mudar' } });
      const send = screen.getByRole('button', { name: 'Enviar pedido' });
      act(() => { send.click(); send.click(); });
      await waitFor(() => { expect(decisionCalls(api)).toHaveLength(1); });
      gate.release();
      await screen.findByText('Pedido de ajuste enviado. A agência vai ver a sua mensagem.');
      expect(decisionCalls(api)).toHaveLength(1);
    });
  });

  describe('Criar conta para ver o portal', () => {
    it('is a link to /criar-conta, and the sign-up opens with the address the access was given to, saying nothing about an account', async () => {
      await loaded([A]);
      const link = screen.getByRole('link', { name: 'Criar conta para ver o portal' });
      expect(link.getAttribute('href')).toBe('/criar-conta');
      expect(document.body.textContent).not.toMatch(/já tem conta|já possui|conta existente/i);
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { level: 1, name: 'Criar conta' })).toBeTruthy();
      expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe(PERSON_EMAIL);
      expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('');
    });

    it('is offered even when there is nothing left to approve', async () => {
      await loaded([{ ...A, status: 'approved' }]);
      expect(screen.getByRole('link', { name: 'Criar conta para ver o portal' })).toBeTruthy();
    });
  });
  describe('CSS contract', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selectors: match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
      body: match[2]!
    }));
    const body = (selector: string): string => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join('\n');

    it.each(['.approval__main', '.approval-card'])('lets %s shrink inside its track: one column that may be narrower than its longest word', (selector) => {
      expect(body(selector)).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
      expect(body(selector)).toMatch(/min-width:\s*0;/);
    });

    it('keeps the two decision buttons side by side in tracks that can shrink, each filling its own', () => {
      expect(body('.approval-card__actions')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.2fr\);/);
      expect(body('.approval-card__actions .ui-button')).toMatch(/width:\s*100%;/);
    });

    it('fits the phone of the feed to the card: no minimum height of its own, and never wider than the card', () => {
      expect(body('.approval-card .content-phone')).toMatch(/width:\s*min\(100%, 22rem\);/);
      expect(body('.approval-card .content-phone__screen')).toMatch(/min-height:\s*0;/);
    });

    it('draws every picture whole in a 4:5 frame, so a wide image is never cut and a tall one never pushes the card', () => {
      expect(body('.approval-post__stage')).toMatch(/aspect-ratio:\s*4 \/ 5;/);
      expect(body('.approval-post__stage')).toMatch(/overflow:\s*hidden;/);
      expect(body('.approval-post__item')).toMatch(/object-fit:\s*contain;/);
    });

    it('declares no colour of its own: only the tokens', () => {
      const own = rules.filter((rule) => rule.selectors.some((selector) => selector.startsWith('.approval'))).map((rule) => rule.body).join('\n');
      expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(own).not.toMatch(/\brgba?\(/);
    });
  });
});
