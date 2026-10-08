// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Conversation, type ConversationProps } from './conversation.js';
import { apiError, createConversationApi } from './conversation-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';

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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PERSONA_ID = 'dddddddd-1111-4111-8111-111111111111';
const TONE = { sectionKey: 'tone_of_voice' } as const;
// 01:30 UTC of the 13th is 22:30 of the 12th in São Paulo: every label must read 12/10.
const LATE = '2026-10-13T01:30:00.000Z';
const EARLIER = '2026-10-12T15:00:00.000Z';

type Scope = ConversationProps['scope'];
const agencyScope: Scope = { side: 'agency', agencyId: AGENCY_ID, clientId: CLIENT_ID };
const clientScope: Scope = { side: 'client', clientId: CLIENT_ID };

interface Options {
  readonly scope?: Scope;
  readonly subject?: ConversationProps['subject'];
  readonly subjectLabel?: string;
  readonly canWrite?: boolean;
  readonly readOnly?: boolean;
  readonly pageSize?: number;
  /** Holds every write until it resolves, to look at the screen while a send is pending. */
  readonly gate?: Promise<void>;
  /** Answers instead of the fixture, for a failure the fixture cannot model. */
  readonly fail?: (url: URL, method: string) => Response | undefined;
}

const mount = (options: Options = {}) => {
  const scope = options.scope ?? agencyScope;
  const api = createConversationApi({ side: scope.side, clientId: CLIENT_ID, pageSize: options.pageSize });
  const onWritten = vi.fn();
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // The server answers a tick later, so a test can fill it right after mounting, before the first read.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const failed = options.fail?.(url, method);
    if (failed !== undefined) return failed;
    if (method === 'POST' && options.gate !== undefined) await options.gate;
    const answered = api.handle(url, method, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    if (answered !== undefined) return answered;
    throw new Error(`unexpected ${method} ${url}`);
  };
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const props: ConversationProps = {
    scope,
    subject: options.subject ?? TONE,
    subjectLabel: options.subjectLabel ?? 'Tom de voz',
    canWrite: options.canWrite ?? true,
    readOnly: options.readOnly ?? false,
    onWritten
  };
  const view = () => <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}><Conversation {...props} /></ApiClientProvider>
  </QueryClientProvider>;
  const queryClient = createQueryClient();
  const rendered = render(view());
  return { api, onWritten, rendered, queryClient };
};

const area = async (label = 'Tom de voz'): Promise<HTMLElement> => await screen.findByRole('region', { name: `Conversas sobre ${label}` });
/** The thread rows only: the open conversation's own list lives inside the same region. */
const rowsOf = (region: HTMLElement): HTMLElement[] => Array.from(region.querySelectorAll<HTMLElement>('.conversation__threads > li'));
const openRow = async (region: HTMLElement, excerpt: RegExp | string): Promise<HTMLElement> => {
  fireEvent.click(await within(region).findByRole('button', { name: excerpt }));
  return await screen.findByRole('dialog', { name: 'Tom de voz' });
};

describe('conversation component (#142)', () => {
  it('lists open threads first and resolved after, each with who opened it, the agency day and the sinal of who is awaited', async () => {
    const { api } = mount();
    // Seeded oldest to newest: the fixture lists the latest first, like the API.
    api.seed(TONE, [{ side: 'agency', body: 'Ajustamos o exemplo de legenda', at: EARLIER }], { at: LATE, by: 'Ana' });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais para o nosso público', at: LATE }]);
    api.seed(TONE, [{ side: 'agency', body: 'Mandei três opções novas', at: LATE }]);

    const region = await area();
    await within(region).findByText('Acho formal demais para o nosso público');
    expect(within(region).getByRole('heading', { name: 'Conversas (3)' })).toBeTruthy();
    const rows = rowsOf(region);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Ana (agência) · 12/10Mandei três opções novasaberta',
      'Maria (cliente) · 12/10Acho formal demais para o nosso públicoaguardando você',
      'Ana (agência) · 12/10Ajustamos o exemplo de legendaresolvida'
    ]);
    // One awaiting thread, so the header says it once.
    expect(within(region).getByText('1 aguardando')).toBeTruthy();
  });

  it('shows the empty state with + conversa for who can write, and without it for who only reads', async () => {
    const writer = mount();
    const region = await area();
    await within(region).findByText('Nenhuma conversa sobre esta parte');
    expect(within(region).getByRole('button', { name: 'Nova conversa sobre Tom de voz' })).toBeTruthy();
    expect(within(region).getByRole('heading', { name: 'Conversas (0)' })).toBeTruthy();
    expect(writer.api.calls).toEqual([`GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?sectionKey=tone_of_voice&pageSize=100`]);
    cleanup();

    mount({ canWrite: false });
    const reading = await area();
    await within(reading).findByText('Nenhuma conversa sobre esta parte');
    expect(within(reading).queryByRole('button')).toBeNull();
  });

  it('shows the side of every author, with name and time in São Paulo, and no control to edit or delete', async () => {
    const { api } = mount();
    api.seed(TONE, [
      { side: 'client', body: 'Acho formal demais', at: EARLIER },
      { side: 'agency', body: 'Faz sentido, reescrevo', at: LATE }
    ]);
    const region = await area();
    const dialog = await openRow(region, /Faz sentido/);

    const comments = await within(dialog).findAllByRole('listitem');
    const meta = (comment: HTMLElement) => comment.querySelector('.conversation__comment-meta')?.textContent;
    expect(comments.map(meta)).toEqual(['Maria · cliente · 12/10 12:00', 'Ana · agência · 12/10 22:30']);
    expect(comments.map((comment) => comment.querySelector('.conversation__comment-body')?.textContent)).toEqual(['Acho formal demais', 'Faz sentido, reescrevo']);
    // The photo of the author is the avatar; Maria has none and falls back to the initial.
    expect(comments[0]!.querySelector('img')).toBeNull();
    expect(comments[0]!.querySelector('.ui-avatar__initials')?.textContent).toBe('M');
    expect(comments[1]!.querySelector('img')?.getAttribute('src')).toBe('https://photos.example.test/ana.png');
    expect(within(dialog).getByText('Depois de enviada, a mensagem não pode ser editada nem apagada.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /editar|apagar|excluir|remover/i })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /reabrir/i })).toBeNull();
  });

  it('answers on the right thread, keeps the text while sending, then clears it and tells the screen around it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api, onWritten } = mount({ gate });
    const other = api.seed(TONE, [{ side: 'client', body: 'Outra conversa', at: EARLIER }]);
    const target = api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);

    const region = await area();
    const dialog = await openRow(region, /Acho formal demais/);
    const box = within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  Vou reescrever hoje  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));

    // Pending: the text is still in the field and the button says it is working.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Responder' }).getAttribute('aria-busy')).toBe('true'));
    expect(box.value).toBe('  Vou reescrever hoje  ');
    expect(api.bodies).toEqual([]);
    release();

    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe(''));
    expect(api.bodies).toEqual([{ body: 'Vou reescrever hoje' }]);
    expect(api.calls).toContain(`POST /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads/${target}/comments`);
    expect(api.calls.some((call) => call.startsWith('POST') && call.includes(other))).toBe(false);
    await within(dialog).findByText('Vou reescrever hoje');
    expect(onWritten).toHaveBeenCalledTimes(1);
    // The list behind the dialog re-read: the answered thread no longer awaits, the other one still does.
    await waitFor(() => expect(rowsOf(region).map((row) => row.textContent)).toEqual([
      'Maria (cliente) · 12/10Vou reescrever hojeaberta',
      'Maria (cliente) · 12/10Outra conversaaguardando você'
    ]));
    expect(within(region).getByText('1 aguardando')).toBeTruthy();
  });

  it('keeps the typed text and offers to try again when the send fails, and sends it on the retry', async () => {
    const { api, onWritten } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);

    api.failNextWrite(() => apiError(500, 'INTERNAL_ERROR'));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Minha resposta' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));

    await within(dialog).findByText('Não foi possível enviar. Tente de novo.');
    expect((within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('Minha resposta');
    expect(onWritten).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await within(dialog).findByText('Minha resposta');
    expect(api.bodies).toEqual([{ body: 'Minha resposta' }, { body: 'Minha resposta' }]);
    expect(within(dialog).queryByText('Não foi possível enviar. Tente de novo.')).toBeNull();
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Cliente arquivado: a conversa está somente leitura.'],
    [409, 'PERSONA_ARCHIVED', 'Persona arquivada: a conversa está somente leitura.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para conversar aqui.'],
    [404, 'NOT_FOUND', 'Esta conversa não existe mais.']
  ])('names the failure of a write answered %i %s and keeps the text', async (status, code, message) => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    api.failNextWrite(() => apiError(status, code));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Texto longo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText(message);
    expect((within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('Texto longo');
  });

  it('refuses an empty message, control characters and an oversized one without calling the server', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    const box = within(dialog).getByRole('textbox', { name: 'Escrever resposta' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('Escreva a mensagem.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'a\u0000b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'é'.repeat(2501) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('A mensagem pode ter no máximo 5.000 bytes.')).toBeTruthy();
    expect(api.bodies).toEqual([]);
  });

  it('resolves exactly the opened thread, who resolved and when stay readable, and an answer reopens it', async () => {
    const { api, onWritten } = mount();
    const other = api.seed(TONE, [{ side: 'client', body: 'Outra conversa aberta', at: EARLIER }]);
    const target = api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    const dialog = await openRow(region, /Acho formal demais/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolver' }));
    await within(dialog).findByText('Resolvida por Ana em 12/10');
    expect(api.calls.filter((call) => call.includes('/resolve'))).toEqual([`POST /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads/${target}/resolve`]);
    expect(api.threads.find((thread) => thread.id === other)?.resolvedAt).toBeNull();
    expect(onWritten).toHaveBeenCalledTimes(1);
    // Resolved: the button is gone and there is no way to reopen except answering.
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /reabrir/i })).toBeNull();

    // Behind the dialog the list moved the resolved thread to the end.
    await waitFor(() => expect(rowsOf(region).map((row) => row.textContent)).toEqual([
      'Maria (cliente) · 12/10Outra conversa abertaaguardando você',
      'Maria (cliente) · 12/10Acho formal demaisresolvida'
    ]));

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Reescrevi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Reescrevi');
    // Answered, the thread is open again: Resolver is back and the "Resolvida" line is gone.
    await within(dialog).findByRole('button', { name: 'Resolver' });
    expect(within(dialog).queryByText(/Resolvida por/)).toBeNull();
    await waitFor(() => expect(rowsOf(region).map((row) => row.textContent)).toEqual([
      'Maria (cliente) · 12/10Reescreviaberta',
      'Maria (cliente) · 12/10Outra conversa abertaaguardando você'
    ]));
  });

  it('shows the resolve error and keeps the thread open when the server refuses', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    api.failNextWrite(() => apiError(403, 'FORBIDDEN'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolver' }));
    await within(dialog).findByText('Você não tem permissão para conversar aqui.');
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeTruthy();
    expect(within(dialog).queryByText(/Resolvida por/)).toBeNull();
  });

  it('opens a new conversation about the subject, closes on success and refreshes the list', async () => {
    const { api, onWritten } = mount();
    const region = await area();
    await within(region).findByText('Nenhuma conversa sobre esta parte');

    fireEvent.click(within(region).getByRole('button', { name: 'Nova conversa sobre Tom de voz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova conversa sobre Tom de voz' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos falar mais de perto?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Iniciar conversa' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toEqual([{ subject: TONE, body: 'Podemos falar mais de perto?' }]);
    await within(region).findByText('Podemos falar mais de perto?');
    expect(within(region).getByRole('heading', { name: 'Conversas (1)' })).toBeTruthy();
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it('keeps what was typed in the new-conversation dialog when the server fails', async () => {
    const { api } = mount();
    const region = await area();
    await within(region).findByText('Nenhuma conversa sobre esta parte');
    fireEvent.click(within(region).getByRole('button', { name: 'Nova conversa sobre Tom de voz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova conversa sobre Tom de voz' });

    api.failNextWrite(() => apiError(409, 'CLIENT_ARCHIVED'));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Texto que não pode sumir' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Iniciar conversa' }));
    await within(dialog).findByText('Cliente arquivado: a conversa está somente leitura.');
    expect((within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
    expect(api.threads).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar nova conversa' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['without write permission', { canWrite: false }],
    ['on a read-only subject', { readOnly: true }]
  ])('is read-only %s: no + conversa, no composer, no Resolver', async (_name, options) => {
    const { api } = mount(options);
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
    const dialog = await openRow(region, /Acho formal demais/);
    expect(within(dialog).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Responder' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    await within(dialog).findByText('Acho formal demais');
  });

  it('serves a persona as the subject through the same component', async () => {
    const { api } = mount({ subject: { personaId: PERSONA_ID }, subjectLabel: 'Dona Maria' });
    api.seed({ personaId: PERSONA_ID }, [{ side: 'client', body: 'Ela não é assim', at: LATE }]);
    api.seed(TONE, [{ side: 'client', body: 'Isto é de outra parte', at: LATE }]);
    const region = await area('Dona Maria');
    await within(region).findByText('Ela não é assim');
    expect(within(region).queryByText('Isto é de outra parte')).toBeNull();
    expect(api.calls[0]).toBe(`GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?personaId=${PERSONA_ID}&pageSize=100`);
  });

  it('works for the client side on its own routes, with no Resolver and its own wording', async () => {
    const { api } = mount({ scope: clientScope });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: EARLIER }, { side: 'agency', body: 'Reescrevi o exemplo', at: LATE }]);
    const region = await area();
    await within(region).findByText('Reescrevi o exemplo');
    expect(within(region).getByText('1 com resposta da agência')).toBeTruthy();
    expect(rowsOf(region)[0]!.textContent).toBe('Maria (cliente) · 12/10Reescrevi o exemploa agência respondeu');
    expect(api.calls[0]).toBe(`GET /clients/${CLIENT_ID}/threads?sectionKey=tone_of_voice&pageSize=100`);

    const dialog = await openRow(region, /Reescrevi o exemplo/);
    expect(within(dialog).queryByRole('button', { name: 'Resolver' })).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Ficou ótimo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Ficou ótimo');
    expect(api.calls.some((call) => new RegExp(`^POST /clients/${CLIENT_ID}/threads/.+/comments$`).test(call))).toBe(true);
    expect(api.calls.some((call) => call.includes('/agencies/'))).toBe(false);
    // The side is never sent: the server stamps it from the route.
    expect(api.bodies).toEqual([{ body: 'Ficou ótimo' }]);
  });

  it('says so and offers to try again when the list cannot be loaded, then recovers', async () => {
    let failing = true;
    const { api } = mount({
      fail: (url, method) => (failing && method === 'GET' && url.pathname.endsWith('/threads') ? apiError(403, 'FORBIDDEN') : undefined)
    });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    await within(region).findByText('Não foi possível carregar as conversas.');
    expect(within(region).queryByText('Nenhuma conversa sobre esta parte')).toBeNull();
    failing = false;
    fireEvent.click(within(region).getByRole('button', { name: 'Tentar de novo' }));
    await within(region).findByText('Acho formal demais');
    expect(within(region).queryByText('Não foi possível carregar as conversas.')).toBeNull();
  });

  it('pages the comments of a long conversation and offers to see more', async () => {
    const { api } = mount();
    const comments = Array.from({ length: 51 }, (_, index) => ({
      side: index % 2 === 0 ? ('client' as const) : ('agency' as const),
      body: `mensagem ${String(index + 1).padStart(2, '0')}`,
      at: new Date(Date.parse(EARLIER) + index * 60_000).toISOString()
    }));
    api.seed(TONE, comments);
    const dialog = await openRow(await area(), /mensagem 51/);
    await within(dialog).findByText('mensagem 50');
    expect(within(dialog).queryByText('mensagem 51')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ver mais mensagens' }));
    await within(dialog).findByText('mensagem 51');
    expect(within(dialog).queryByRole('button', { name: 'Ver mais mensagens' })).toBeNull();
    expect(api.calls.filter((call) => call.includes('/comments?page='))).toHaveLength(2);
  });
});
