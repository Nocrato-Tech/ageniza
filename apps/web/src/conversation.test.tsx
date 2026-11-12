// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidDayMessage } from '@ageniza/ui';

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
  readonly blockedReason?: string;
  readonly planBlockedReason?: string;
  readonly pageSize?: number;
  /** Holds every write until it resolves, to look at the screen while a send is pending. */
  readonly gate?: Promise<void>;
  /** Holds the reads of one route until the promise resolves, to look at the loading state. */
  readonly holdReads?: { readonly promise: Promise<void>; readonly path: 'threads' | 'comments' };
  /** Holds the reads of one state, while `release` is unset, to see the screen between the two answers. */
  readonly slowState?: { readonly state: 'open' | 'resolved'; promise?: Promise<void> };
  /** Answers instead of the fixture, for a failure the fixture cannot model. */
  readonly fail?: (url: URL, method: string) => Response | undefined;
}

const mount = (options: Options = {}) => {
  const scope = options.scope ?? agencyScope;
  const api = createConversationApi({ side: scope.side, clientId: CLIENT_ID, pageSize: options.pageSize });
  const onWritten = vi.fn();
  const onStale = vi.fn();
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // The server answers a tick later, so a test can fill it right after mounting, before the first read.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const failed = options.fail?.(url, method);
    if (failed !== undefined) return failed;
    if (method === 'POST' && options.gate !== undefined) await options.gate;
    if (method === 'GET' && options.slowState?.promise !== undefined && url.pathname.endsWith('/threads') && url.searchParams.get('state') === options.slowState.state) await options.slowState.promise;
    if (method === 'GET' && options.holdReads !== undefined && url.pathname.endsWith(options.holdReads.path)) await options.holdReads.promise;
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
    blockedReason: options.blockedReason,
    planBlockedReason: options.planBlockedReason,
    onWritten,
    onStale
  };
  const view = () => <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}><Conversation {...props} /></ApiClientProvider>
  </QueryClientProvider>;
  const queryClient = createQueryClient();
  const rendered = render(view());
  return { api, onWritten, onStale, rendered, queryClient };
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
      'Aberta por Ana (agência)Agência · 12/10Mandei três opções novasaberta',
      'Aberta por Maria (cliente)Cliente · 12/10Acho formal demais para o nosso públicoaguardando você',
      'Aberta por Ana (agência)Agência · 12/10Ajustamos o exemplo de legendaresolvida'
    ]);
    // One awaiting thread, so the header says it once.
    expect(within(region).getByText('1 aguardando')).toBeTruthy();
  });

  it('says the status in a Pill with its icon, filled only on the thread that awaits the viewer', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'agency', body: 'Ajustamos o exemplo de legenda', at: EARLIER }], { at: LATE, by: 'Ana' });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais para o nosso público', at: LATE }]);
    api.seed(TONE, [{ side: 'agency', body: 'Mandei três opções novas', at: LATE }]);

    const region = await area();
    await within(region).findByText('Acho formal demais para o nosso público');
    const statusOf = (excerpt: string): HTMLElement => rowsOf(region).find((row) => row.textContent?.includes(excerpt))!.querySelector<HTMLElement>('.conversation__status')!;

    expect([statusOf('Acho formal').textContent, statusOf('Mandei').textContent, statusOf('Ajustamos').textContent]).toEqual(['aguardando você', 'aberta', 'resolvida']);
    expect(statusOf('Acho formal').classList.contains('ui-pill--accent')).toBe(true);
    for (const excerpt of ['Mandei', 'Ajustamos']) {
      expect(statusOf(excerpt).classList.contains('ui-pill--neutral'), excerpt).toBe(true);
      expect(statusOf(excerpt).classList.contains('ui-pill--accent'), excerpt).toBe(false);
    }
    for (const excerpt of ['Acho formal', 'Mandei', 'Ajustamos']) expect(statusOf(excerpt).querySelector('.ui-icon svg'), excerpt).not.toBeNull();
    const header = region.querySelector<HTMLElement>('.conversation__header .conversation__status')!;
    expect(header.textContent).toBe('1 aguardando');
    expect(header.classList.contains('ui-pill--accent')).toBe(true);
  });

  it('shows the empty state with the new-conversation button for who can write, and without it for who only reads', async () => {
    const writer = mount();
    const region = await area();
    await within(region).findByText('Nenhuma conversa sobre esta parte');
    expect(within(region).getByRole('button', { name: 'Nova conversa sobre Tom de voz' })).toBeTruthy();
    expect(within(region).getByRole('heading', { name: 'Conversas (0)' })).toBeTruthy();
    expect([...writer.api.calls].sort()).toEqual([
      `GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?sectionKey=tone_of_voice&state=open&pageSize=100`,
      `GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?sectionKey=tone_of_voice&state=resolved&pageSize=100`
    ]);
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
      // Opened by the client, last word by the agency: each side is named next to its own words.
      'Aberta por Maria (cliente)Agência · 12/10Vou reescrever hojeaberta',
      'Aberta por Maria (cliente)Cliente · 12/10Outra conversaaguardando você'
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

  it('describes the box by the refusal, which carries the error icon, and puts the focus back on it', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    const box = within(dialog).getByRole('textbox', { name: 'Escrever resposta' });
    expect(box.getAttribute('aria-invalid')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    const message = within(dialog).getByText('Escreva a mensagem.');
    expect(message.querySelector('.ui-icon svg')).not.toBeNull();
    expect(message.getAttribute('role')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe(message.id);

    fireEvent.change(box, { target: { value: 'ok' } });
    expect(within(dialog).queryByText('Escreva a mensagem.')).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('resolves exactly the opened thread, who resolved and when stay readable, and an answer reopens it', async () => {
    const { api, onWritten } = mount();
    const other = api.seed(TONE, [{ side: 'client', body: 'Outra conversa aberta', at: EARLIER }]);
    const target = api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    const dialog = await openRow(region, /Acho formal demais/);

    expect(within(region).getByText('2 aguardando')).toBeTruthy();
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
      'Aberta por Maria (cliente)Cliente · 12/10Outra conversa abertaaguardando você',
      'Aberta por Maria (cliente)Cliente · 12/10Acho formal demaisresolvida'
    ]));
    // The resolved thread's last word is the client's, yet it no longer awaits: only the other one does.
    expect(within(region).getByText('1 aguardando')).toBeTruthy();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Reescrevi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Reescrevi');
    // Answered, the thread is open again: Resolver is back and the "Resolvida" line is gone.
    await within(dialog).findByRole('button', { name: 'Resolver' });
    expect(within(dialog).queryByText(/Resolvida por/)).toBeNull();
    await waitFor(() => expect(rowsOf(region).map((row) => row.textContent)).toEqual([
      'Aberta por Maria (cliente)Agência · 12/10Reescreviaberta',
      'Aberta por Maria (cliente)Cliente · 12/10Outra conversa abertaaguardando você'
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
  ])('is read-only %s: no new-conversation button, no composer, no Resolver', async (_name, options) => {
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
    expect(api.calls[0]).toBe(`GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?personaId=${PERSONA_ID}&state=open&pageSize=100`);
  });

  it('works for the client side on its own routes, with no Resolver and its own wording', async () => {
    const { api } = mount({ scope: clientScope });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: EARLIER }, { side: 'agency', body: 'Reescrevi o exemplo', at: LATE }]);
    const region = await area();
    await within(region).findByText('Reescrevi o exemplo');
    expect(within(region).getByText('1 com resposta da agência')).toBeTruthy();
    expect(rowsOf(region)[0]!.textContent).toBe('Aberta por Maria (cliente)Agência · 12/10Reescrevi o exemploa agência respondeu');
    expect(api.calls[0]).toBe(`GET /clients/${CLIENT_ID}/threads?sectionKey=tone_of_voice&state=open&pageSize=100`);

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

  it('suggests, on the client side, with its own words, and the agency side keeps the plus-icon "conversa" button', async () => {
    const client = mount({ scope: clientScope });
    const region = await area();
    await within(region).findByText('Nenhuma conversa sobre esta parte');
    const button = within(region).getByRole('button', { name: 'Sugerir sobre Tom de voz' });
    expect(button.textContent).toBe('Sugerir');
    expect(within(region).queryByRole('button', { name: /conversa/i })).toBeNull();

    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Sugerir sobre "Tom de voz"' });
    expect(within(dialog).getByRole('textbox', { name: 'Escreva sua sugestão' }).getAttribute('placeholder')).toBe('Escreva aqui');
    expect(within(dialog).getByText('A agência vai ver e responder por aqui.')).toBeTruthy();
    expect(within(dialog).getByText('Depois de enviada, a mensagem não pode ser editada nem apagada.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Enviar' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Iniciar conversa' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar sugestão' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.api.calls.some((call) => call.startsWith('POST'))).toBe(false);
    cleanup();

    mount({ scope: agencyScope });
    const agency = await area();
    const plus = await within(agency).findByRole('button', { name: 'Nova conversa sobre Tom de voz' });
    expect(plus.textContent).toBe('conversa');
    expect(plus.querySelector('.ui-icon[aria-hidden="true"] svg')).not.toBeNull();
    fireEvent.click(plus);
    const opened = await screen.findByRole('dialog', { name: 'Nova conversa sobre Tom de voz' });
    expect(within(opened).getByRole('button', { name: 'Iniciar conversa' })).toBeTruthy();
    expect(within(opened).getByRole('button', { name: 'Fechar nova conversa' })).toBeTruthy();
    expect(within(opened).queryByText('A agência vai ver e responder por aqui.')).toBeNull();
    expect(within(opened).getByRole('textbox', { name: 'Escreva a primeira mensagem' }).getAttribute('placeholder')).toBeNull();
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

  const longConversation = (count: number) => Array.from({ length: count }, (_, index) => ({
    side: index % 2 === 0 ? ('client' as const) : ('agency' as const),
    body: `mensagem ${String(index + 1).padStart(3, '0')}`,
    at: new Date(Date.parse(EARLIER) + index * 60_000).toISOString()
  }));

  it('opens a long conversation on its newest messages and pages back to the earlier ones', async () => {
    const { api } = mount();
    api.seed(TONE, longConversation(120));
    const dialog = await openRow(await area(), /mensagem 120/);
    // Page 3 of 3: the last message is on screen at once, the first 100 are one click away.
    await within(dialog).findByText('mensagem 120');
    expect(within(dialog).getByText('mensagem 101')).toBeTruthy();
    expect(within(dialog).queryByText('mensagem 100')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Ver mensagens mais novas' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ver mensagens anteriores' }));
    await within(dialog).findByText('mensagem 100');
    expect(within(dialog).getByText('mensagem 051')).toBeTruthy();
    expect(within(dialog).getAllByRole('listitem').map((item) => item.querySelector('.conversation__comment-body')?.textContent).slice(0, 2)).toEqual(['mensagem 051', 'mensagem 052']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ver mensagens anteriores' }));
    await within(dialog).findByText('mensagem 001');
    expect(within(dialog).queryByRole('button', { name: 'Ver mensagens anteriores' })).toBeNull();
    expect(api.calls.filter((call) => call.includes('/comments?page=')).map((call) => call.slice(call.indexOf('?')))).toEqual(['?page=3', '?page=2', '?page=1']);
  });

  it('shows the answer that makes a conversation grow onto a new page', async () => {
    const { api } = mount();
    api.seed(TONE, longConversation(50));
    const dialog = await openRow(await area(), /mensagem 050/);
    await within(dialog).findByText('mensagem 050');
    expect(within(dialog).queryByRole('button', { name: 'Ver mensagens anteriores' })).toBeNull();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'A resposta nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    // Comment 51 lives on page 2; the screen follows the thread there and offers the earlier page.
    await within(dialog).findByText('A resposta nova');
    expect(await within(dialog).findByRole('button', { name: 'Ver mensagens anteriores' })).toBeTruthy();
  });

  it('shows skeletons while the list loads and while the conversation loads', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { api } = mount({ holdReads: { promise: held, path: 'threads' } });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    expect(region.querySelector('.conversation__threads-skeleton')?.getAttribute('aria-busy')).toBe('true');
    expect(region.querySelectorAll('.conversation__threads-skeleton > *')).toHaveLength(2);
    release();
    await within(region).findByText('Acho formal demais');
    expect(region.querySelector('.conversation__threads-skeleton')).toBeNull();
    cleanup();

    let releaseComments: () => void = () => undefined;
    const heldComments = new Promise<void>((resolve) => { releaseComments = resolve; });
    const second = mount({ holdReads: { promise: heldComments, path: 'comments' } });
    second.api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    // Three comments' worth of skeleton, and no composer story yet: the conversation is not there.
    expect(dialog.querySelector('.conversation__comments-skeleton')?.getAttribute('aria-busy')).toBe('true');
    expect(dialog.querySelectorAll('.conversation__comments-skeleton > *')).toHaveLength(3);
    releaseComments();
    await within(dialog).findAllByRole('listitem');
    expect(dialog.querySelector('.conversation__comments-skeleton')).toBeNull();
  });

  it('says so and offers to try again when the messages of a conversation cannot be loaded', async () => {
    let failing = true;
    const { api } = mount({
      fail: (url, method) => (failing && method === 'GET' && url.pathname.endsWith('/comments') ? apiError(403, 'FORBIDDEN') : undefined)
    });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    await within(dialog).findByText('Não foi possível carregar a conversa.');
    expect(within(dialog).queryByRole('list')).toBeNull();
    failing = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await within(dialog).findByText('Acho formal demais');
    expect(within(dialog).queryByText('Não foi possível carregar a conversa.')).toBeNull();
  });

  it('says who resolved neutrally when the server has no name for them', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: EARLIER }], { at: LATE, by: null });
    const dialog = await openRow(await area(), /Acho formal demais/);
    await within(dialog).findByText('Resolvida pela agência em 12/10');
  });

  it('does not let the typed text change while a send is pending', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = mount({ gate });
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const dialog = await openRow(await area(), /Acho formal demais/);
    const box = within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(false);
    fireEvent.change(box, { target: { value: 'Resposta' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await waitFor(() => expect(box.readOnly).toBe(true));
    release();
    await within(dialog).findByText('Resposta');
  });

  it('names an opener the server has no name for without repeating the side', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    api.threads[0]!.openedBy.name = null;
    const region = await area();
    await waitFor(() => expect(rowsOf(region)).toHaveLength(1));
    await within(region).findByText('Acho formal demais');
    expect(rowsOf(region)[0]!.querySelector('.conversation__thread-meta')?.textContent).toBe('Aberta pelo cliente');
  });

  it('lists the thread with the latest activity first, like the API', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Antiga, respondida agora', at: EARLIER }]);
    api.seed(TONE, [{ side: 'client', body: 'Nova, sem resposta', at: LATE }]);
    const region = await area();
    await within(region).findByText('Nova, sem resposta');
    const dialog = await openRow(region, /Antiga, respondida agora/);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Respondi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Respondi');
    await waitFor(() => expect(rowsOf(region).map((row) => row.querySelector('.conversation__thread-excerpt')?.textContent)).toEqual(['Respondi', 'Nova, sem resposta']));
  });

  it.each(['open', 'resolved'] as const)('says when only the 100 most recent %s conversations are shown', async (state) => {
    const { api } = mount();
    for (let index = 0; index < 101; index += 1) {
      api.seed(TONE, [{ side: 'client', body: `pergunta ${index}`, at: EARLIER }], state === 'resolved' ? { at: LATE, by: 'Ana' } : undefined);
    }
    const region = await area();
    await within(region).findByText('Mostrando as 100 conversas mais recentes.');
    expect(rowsOf(region)).toHaveLength(100);
    expect(within(region).getByRole('heading', { name: 'Conversas (101)' })).toBeTruthy();
  });

  it('shows an old open thread even when more than 100 resolved ones are newer', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Aberta antiga', at: '2026-09-01T12:00:00.000Z' }]);
    for (let index = 0; index < 100; index += 1) {
      api.seed(TONE, [{ side: 'agency', body: `resolvida ${index}`, at: EARLIER }], { at: LATE, by: 'Ana' });
    }
    const region = await area();
    await within(region).findByText('Aberta antiga');
    expect(within(region).getByRole('heading', { name: 'Conversas (101)' })).toBeTruthy();
    expect(rowsOf(region)).toHaveLength(101);
    expect(rowsOf(region)[0]!.textContent).toContain('Aberta antiga');
    expect(within(region).getByText('1 aguardando')).toBeTruthy();
  });

  it('says so when only one of the two reads fails, shows nothing half-loaded, and the retry reads both again', async () => {
    let failing = true;
    const { api } = mount({ fail: (url) => (failing && url.searchParams.get('state') === 'resolved' ? apiError(403, 'FORBIDDEN') : undefined) });
    api.seed(TONE, [{ side: 'client', body: 'Aberta que não aparece sozinha', at: LATE }]);
    const region = await area();
    await within(region).findByText('Não foi possível carregar as conversas.');
    expect(within(region).queryByText('Aberta que não aparece sozinha')).toBeNull();
    expect(within(region).queryByText('Nenhuma conversa sobre esta parte')).toBeNull();
    failing = false;
    fireEvent.click(within(region).getByRole('button', { name: 'Tentar de novo' }));
    await within(region).findByText('Aberta que não aparece sozinha');
    expect(within(region).queryByText('Não foi possível carregar as conversas.')).toBeNull();
  });

  describe('when a thread changes state, the list and the open conversation never lose or repeat it', () => {
    const consoleError = vi.spyOn(console, 'error');
    afterEach(() => { consoleError.mockClear(); });
    const noRepeatedKey = (): void => {
      expect(consoleError.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([]);
    };

    it('keeps the conversation and the typed draft while Resolver waits for the slow read of the resolved ones', async () => {
      let release: () => void = () => undefined;
      const slowState = { state: 'resolved' as const, promise: undefined as Promise<void> | undefined };
      const { api } = mount({ slowState });
      api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
      const region = await area();
      const dialog = await openRow(region, /Acho formal demais/);
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'rascunho em andamento' } });

      slowState.promise = new Promise<void>((resolve) => { release = resolve; });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Resolver' }));
      await waitFor(() => expect(api.calls.filter((call) => call.includes('state=open'))).toHaveLength(2));
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });

      expect(screen.getByRole('dialog', { name: 'Tom de voz' })).toBe(dialog);
      expect((within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('rascunho em andamento');
      expect(rowsOf(region)).toHaveLength(1);
      expect(within(region).getByRole('heading', { name: 'Conversas (1)' })).toBeTruthy();

      release();
      await within(dialog).findByText('Resolvida por Ana em 12/10');
      expect(rowsOf(region)).toHaveLength(1);
      expect((within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('rascunho em andamento');
      noRepeatedKey();
    });

    it('keeps the conversation on screen while an answer to a resolved one waits for the slow read of the open ones', async () => {
      let release: () => void = () => undefined;
      const slowState = { state: 'open' as const, promise: undefined as Promise<void> | undefined };
      const { api } = mount({ slowState });
      api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: EARLIER }], { at: LATE, by: 'Ana' });
      const region = await area();
      const dialog = await openRow(region, /Acho formal demais/);

      slowState.promise = new Promise<void>((resolve) => { release = resolve; });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Reabrindo' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
      await waitFor(() => expect(api.calls.filter((call) => call.includes('state=resolved'))).toHaveLength(2));
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });

      expect(screen.getByRole('dialog', { name: 'Tom de voz' })).toBe(dialog);
      expect(rowsOf(region)).toHaveLength(1);

      release();
      await within(dialog).findByRole('button', { name: 'Resolver' });
      expect(rowsOf(region)).toHaveLength(1);
      expect(within(region).getByRole('heading', { name: 'Conversas (1)' })).toBeTruthy();
      noRepeatedKey();
    });

    it('does not repeat the conversation when one of the two reads after the write fails', async () => {
      let failing = false;
      let refused = 0;
      mount({ fail: (url) => {
        if (!failing || url.searchParams.get('state') !== 'open') return undefined;
        refused += 1;
        return apiError(403, 'FORBIDDEN');
      } }).api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
      const region = await area();
      const dialog = await openRow(region, /Acho formal demais/);

      failing = true;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Resolver' }));
      await waitFor(() => expect(refused).toBe(1));
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });

      expect(rowsOf(region)).toHaveLength(1);
      expect(within(region).getByRole('heading', { name: 'Conversas (1)' })).toBeTruthy();
      expect(screen.getByRole('dialog', { name: 'Tom de voz' })).toBe(dialog);
      noRepeatedKey();
    });
  });
});

describe('conversation of a content (#266)', () => {
  const CONTENT_ID = 'c0c0c0c0-1111-4111-8111-111111111111';
  const CONTENT = { contentId: CONTENT_ID } as const;
  const TITLE = 'Lançamento do pão';
  const NOT_OPEN = 'A conversa só aceita mensagens a partir de "Aguardando aprovação". Este conteúdo está em produção ou foi cancelado.';
  const IN_PRODUCTION = 'A conversa só aceita mensagens a partir de "Aguardando aprovação"; este conteúdo ainda está em produção.';
  const mountContent = (options: Options = {}) => mount({ subject: CONTENT, subjectLabel: TITLE, ...options });
  const contentArea = async (): Promise<HTMLElement> => await screen.findByRole('region', { name: `Conversa sobre ${TITLE}` });
  const openContentThread = async (region: HTMLElement, excerpt: RegExp | string): Promise<HTMLElement> => {
    fireEvent.click(await within(region).findByRole('button', { name: excerpt }));
    return await screen.findByRole('dialog', { name: `Conversa sobre ${TITLE}` });
  };
  const answerBox = (dialog: HTMLElement): HTMLTextAreaElement => within(dialog).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement;

  it('asks for the conversation of that content and of no other, with its own title and empty state', async () => {
    const { api } = mountContent();
    api.seed({ contentId: 'c0c0c0c0-2222-4222-8222-222222222222' }, [{ side: 'client', body: 'Mensagem de outro conteúdo', at: LATE }]);
    api.seed({ sectionKey: 'tone_of_voice' }, [{ side: 'client', body: 'Mensagem do estudo', at: LATE }]);

    const region = await contentArea();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');
    expect(within(region).getByRole('heading', { name: 'Conversa' })).toBeTruthy();
    expect([...api.calls].sort()).toEqual([
      `GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?contentId=${CONTENT_ID}&state=open&pageSize=100`,
      `GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?contentId=${CONTENT_ID}&state=resolved&pageSize=100`
    ]);
    expect(within(region).queryByText(/Mensagem de outro conteúdo|Mensagem do estudo/)).toBeNull();
  });

  it('opens the one conversation of the content with the new-conversation button, writes the content as the subject and then offers no second one', async () => {
    const { api, onWritten } = mountContent();
    const region = await contentArea();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');

    fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${TITLE}` }));
    const dialog = await screen.findByRole('dialog', { name: `Nova conversa sobre ${TITLE}` });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos usar outra foto?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Iniciar conversa' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toEqual([{ subject: CONTENT, body: 'Podemos usar outra foto?' }]);
    await within(region).findByText('Podemos usar outra foto?');
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
  });

  it('offers no new conversation while the list is still loading, because the content may already have one', async () => {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    mountContent({ holdReads: { promise, path: 'threads' } });
    const region = await contentArea();
    expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
    release();
    await within(region).findByRole('button', { name: `Nova conversa sobre ${TITLE}` });
  });

  it('shows the thread of the content with the side, the name by the link and the day in São Paulo of each message, and no id', async () => {
    const { api } = mountContent();
    api.seed(CONTENT, [
      { side: 'client', body: 'Gostei, mas troquem a foto', at: EARLIER },
      { side: 'agency', body: 'Trocamos hoje', at: LATE }
    ]);
    const region = await contentArea();
    const dialog = await openContentThread(region, /Trocamos hoje/);
    await within(dialog).findByText('Trocamos hoje');

    const metas = Array.from(dialog.querySelectorAll('.conversation__comment-meta')).map((meta) => meta.textContent);
    expect(metas).toEqual(['Maria · cliente · 12/10 12:00', 'Ana · agência · 12/10 22:30']);
    expect(dialog.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(region.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('renders what the client wrote as text, never as HTML', async () => {
    const hostile = '<script>window.__hacked = 1</script><img src="x" onerror="window.__hacked = 2"><b>negrito</b> ‮atrás⁧';
    const { api } = mountContent();
    api.seed(CONTENT, [{ side: 'client', body: hostile, at: LATE }]);
    const region = await contentArea();
    const dialog = await openContentThread(region, /negrito/);

    const body = await within(dialog).findByText((_text, element) => element?.classList.contains('conversation__comment-body') === true);
    expect(body.textContent).toBe(hostile);
    expect(body.children).toHaveLength(0);
    expect(dialog.querySelector('script, img, b')).toBeNull();
    expect(region.querySelector('script, img, b')).toBeNull();
    expect((window as unknown as { __hacked?: number }).__hacked).toBeUndefined();
  });

  it.each([
    ['a bidi override', 'texto ‮oculto'],
    ['a bidi isolate', 'texto ⁧oculto'],
    ['a combining grapheme joiner', 'texto͏oculto'],
    ['a Braille blank', 'texto⠀oculto'],
    ['a control character', 'texto\u0007oculto']
  ])('refuses %s with the one rule of the product, without calling the server', async (_name, text) => {
    const { api } = mountContent();
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const dialog = await openContentThread(await contentArea(), /Gostei/);

    fireEvent.change(answerBox(dialog), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
    expect(api.bodies).toEqual([]);
    expect(answerBox(dialog).value).toBe(text);
  });

  it('names the other two refusals of the rule: nothing to say, and more than 5.000 bytes', async () => {
    const { api } = mountContent();
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const dialog = await openContentThread(await contentArea(), /Gostei/);

    fireEvent.change(answerBox(dialog), { target: { value: '   \n  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('Escreva a mensagem.')).toBeTruthy();
    fireEvent.change(answerBox(dialog), { target: { value: 'é'.repeat(2501) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    expect(within(dialog).getByText('A mensagem pode ter no máximo 5.000 bytes.')).toBeTruthy();
    expect(api.bodies).toEqual([]);
  });

  it('accepts what the rule accepts: a family emoji, and exactly 5.000 bytes', async () => {
    const { api } = mountContent();
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const dialog = await openContentThread(await contentArea(), /Gostei/);
    const family = `${'é'.repeat(100)} 👨‍👩‍👧`;
    fireEvent.change(answerBox(dialog), { target: { value: family } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await waitFor(() => expect(api.bodies).toEqual([{ body: family }]));

    const exact = 'é'.repeat(2500);
    fireEvent.change(answerBox(dialog), { target: { value: exact } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await waitFor(() => expect(api.bodies).toEqual([{ body: family }, { body: exact }]));
  });

  it('keeps the typed answer when the send fails, and clears it when it goes through', async () => {
    const { api } = mountContent();
    const threadId = api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const dialog = await openContentThread(await contentArea(), /Gostei/);

    api.failNextWrite(() => apiError(500, 'INTERNAL_ERROR'));
    fireEvent.change(answerBox(dialog), { target: { value: 'Combinado, sigo assim' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText('Não foi possível enviar. Tente de novo.');
    expect(answerBox(dialog).value).toBe('Combinado, sigo assim');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(answerBox(dialog).value).toBe(''));
    await within(dialog).findByText('Combinado, sigo assim');
    expect(api.calls).toContain(`POST /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads/${threadId}/comments`);
    expect(within(dialog).queryByText('Não foi possível enviar. Tente de novo.')).toBeNull();
  });

  it('says why nobody can write while the content is not open, and still reads and resolves', async () => {
    const { api } = mountContent({ blockedReason: IN_PRODUCTION });
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const region = await contentArea();
    expect(within(region).getByText(IN_PRODUCTION)).toBeTruthy();
    const dialog = await openContentThread(region, /Gostei/);
    expect(within(dialog).getByText(IN_PRODUCTION)).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Responder' })).toBeNull();
    expect(within(dialog).queryByText('Esta conversa é somente leitura.')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolver' }));
    await waitFor(() => expect(api.calls.filter((call) => call.endsWith('/resolve'))).toHaveLength(1));
  });

  it('offers no new conversation to a content that is not open, and says why even with no thread', async () => {
    const reason = 'Este conteúdo foi cancelado: a conversa não recebe mais mensagens.';
    mountContent({ blockedReason: reason });
    const region = await contentArea();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');
    expect(within(region).getByText(reason)).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
  });

  it('does not say why to who could not write anyway: that person reads "somente leitura"', async () => {
    const { api } = mountContent({ canWrite: false, blockedReason: IN_PRODUCTION });
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const region = await contentArea();
    const dialog = await openContentThread(region, /Gostei/);
    expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
    expect(within(dialog).queryByText(IN_PRODUCTION)).toBeNull();
    expect(within(dialog).getByText('Esta conversa é somente leitura.')).toBeTruthy();
  });

  it('answers the 409 of a content that is not open with its own words, keeps the text, and tells the screen around it', async () => {
    const { api, onStale, onWritten } = mountContent();
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const dialog = await openContentThread(await contentArea(), /Gostei/);

    api.failNextWrite(() => apiError(409, 'CONTENT_NOT_OPEN', 'MENSAGEM DO SERVIDOR'));
    fireEvent.change(answerBox(dialog), { target: { value: 'Texto que não pode sumir' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Responder' }));
    await within(dialog).findByText(NOT_OPEN);
    expect(within(dialog).queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(answerBox(dialog).value).toBe('Texto que não pode sumir');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('answers the 409 of opening the conversation of a content that is not open, in the dialog, keeping the text', async () => {
    const { api } = mountContent();
    const region = await contentArea();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');
    fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${TITLE}` }));
    const dialog = await screen.findByRole('dialog', { name: `Nova conversa sobre ${TITLE}` });

    api.failNextWrite(() => apiError(409, 'CONTENT_NOT_OPEN'));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Texto que não pode sumir' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Iniciar conversa' }));
    await within(dialog).findByText(NOT_OPEN);
    expect((within(dialog).getByRole('textbox', { name: 'Escreva a primeira mensagem' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
  });

  it('shows a skeleton while the conversation loads, and the error with "Tentar de novo" when it cannot, then recovers', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const loading = mountContent({ holdReads: { promise: held, path: 'threads' } });
    loading.api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const region = await contentArea();
    expect(region.querySelector('.conversation__threads-skeleton')?.getAttribute('aria-busy')).toBe('true');
    release();
    await within(region).findByText('Gostei');
    expect(region.querySelector('.conversation__threads-skeleton')).toBeNull();
    cleanup();

    let failing = true;
    const { api } = mountContent({
      fail: (url, method) => (failing && method === 'GET' && url.pathname.endsWith('/threads') ? apiError(403, 'FORBIDDEN') : undefined)
    });
    api.seed(CONTENT, [{ side: 'client', body: 'Gostei', at: LATE }]);
    const failed = await contentArea();
    await within(failed).findByText('Não foi possível carregar as conversas.');
    expect(within(failed).queryByText('Nenhuma conversa sobre este conteúdo')).toBeNull();
    expect(within(failed).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
    failing = false;
    fireEvent.click(within(failed).getByRole('button', { name: 'Tentar de novo' }));
    await within(failed).findByText('Gostei');
  });

  it('opens a long conversation of a content on its newest messages, and pages back to the earlier ones', async () => {
    const { api } = mountContent();
    api.seed(CONTENT, Array.from({ length: 51 }, (_, index) => ({
      side: index % 2 === 0 ? ('client' as const) : ('agency' as const),
      body: `mensagem ${String(index + 1).padStart(3, '0')}`,
      at: new Date(Date.parse(EARLIER) + index * 60_000).toISOString()
    })));
    const dialog = await openContentThread(await contentArea(), /mensagem 051/);
    await within(dialog).findByText('mensagem 051');
    expect(within(dialog).queryByText('mensagem 001')).toBeNull();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Ver mensagens anteriores' }));
    await within(dialog).findByText('mensagem 001');
  });
});

describe('request for material (decision 2026-11-10)', () => {
  const MATERIAL = { materialRequest: true } as const;
  // 01:30 UTC of the 11th is 22:30 of the 10th in São Paulo: the agency's day is the 10th, the UTC day is the 11th.
  const NOW = new Date('2026-11-11T01:30:00.000Z');
  const mountMaterial = (options: Options = {}) => mount({ subject: MATERIAL, subjectLabel: 'Pedido de material', ...options });
  const materialArea = async (): Promise<HTMLElement> => await screen.findByRole('region', { name: 'Pedidos de material' });
  const rowOf = (region: HTMLElement, excerpt: string): HTMLElement => {
    const row = rowsOf(region).find((item) => item.textContent?.includes(excerpt));
    if (row === undefined) throw new Error(`no row with ${excerpt}`);
    return row;
  };
  const openDialog = async (region: HTMLElement): Promise<HTMLElement> => {
    fireEvent.click(await within(region).findByRole('button', { name: 'Pedir material' }));
    return await screen.findByRole('dialog', { name: 'Pedir material' });
  };
  const TITLE = 'Fotos da equipe';
  const writeTitle = (dialog: HTMLElement, title: string): void => {
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título do pedido' }), { target: { value: title } });
  };
  /** The text of the request; the title every request must have goes with it unless the test names another. */
  const write = (dialog: HTMLElement, text: string, title = TITLE): void => {
    writeTitle(dialog, title);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }), { target: { value: text } });
  };
  const pickDay = (dialog: HTMLElement, typed: string): void => {
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }), { target: { value: typed } });
  };
  const send = (dialog: HTMLElement, name = 'Enviar pedido'): void => { fireEvent.click(within(dialog).getByRole('button', { name })); };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('lists the requests with their own label and deadline, from the materialRequest query only', async () => {
    const { api } = mountMaterial();
    api.seed(MATERIAL, [{ side: 'agency', body: 'Envie 3 fotos da equipe', at: EARLIER }], undefined, '2026-11-20');
    api.seed(MATERIAL, [{ side: 'agency', body: 'Envie o logotipo', at: LATE }]);
    api.seed(TONE, [{ side: 'client', body: 'Isto é do tom de voz', at: LATE }]);

    const region = await materialArea();
    await within(region).findByText('Envie 3 fotos da equipe');
    expect(within(region).getByRole('heading', { name: 'Pedidos de material (2)' })).toBeTruthy();
    expect(within(region).queryByText('Isto é do tom de voz')).toBeNull();
    expect(rowOf(region, 'Envie 3 fotos da equipe').textContent).toBe('Pedido de materialEntregar até 20/11Aberta por Ana (agência)Agência · 12/10Envie 3 fotos da equipeaberta');
    expect(rowOf(region, 'Envie o logotipo').textContent).toBe('Pedido de materialAberta por Ana (agência)Agência · 12/10Envie o logotipoaberta');
    expect(api.calls[0]).toBe(`GET /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads?materialRequest=true&state=open&pageSize=100`);
  });

  it('says "venceu" for an open request whose São Paulo day has passed, and only then', async () => {
    const { api } = mountMaterial();
    api.seed(MATERIAL, [{ side: 'agency', body: 'passou ontem', at: EARLIER }], undefined, '2026-11-09');
    // 22:30 of the 10th in São Paulo: a deadline of the 10th is today there, and already yesterday on the UTC clock.
    api.seed(MATERIAL, [{ side: 'agency', body: 'vence hoje', at: EARLIER }], undefined, '2026-11-10');
    api.seed(MATERIAL, [{ side: 'agency', body: 'vence amanhã', at: EARLIER }], undefined, '2026-11-11');
    api.seed(MATERIAL, [{ side: 'agency', body: 'já resolvido', at: EARLIER }], { at: LATE, by: 'Ana' }, '2026-11-01');

    const region = await materialArea();
    await within(region).findByText('passou ontem');
    expect(within(rowOf(region, 'passou ontem')).getByText('venceu')).toBeTruthy();
    expect(rowOf(region, 'passou ontem').textContent).toContain('Entregar até 09/11venceu');
    expect(within(rowOf(region, 'vence hoje')).queryByText('venceu')).toBeNull();
    expect(rowOf(region, 'vence hoje').textContent).toContain('Entregar até 10/11');
    expect(within(rowOf(region, 'vence amanhã')).queryByText('venceu')).toBeNull();
    expect(within(rowOf(region, 'já resolvido')).queryByText('venceu')).toBeNull();
    expect(rowOf(region, 'já resolvido').textContent).toContain('Entregar até 01/11');
  });

  it('shows the label and the deadline again in the open request, with "venceu" when it passed', async () => {
    const { api } = mountMaterial();
    api.seed(MATERIAL, [{ side: 'agency', body: 'Envie 3 fotos da equipe', at: EARLIER }], undefined, '2026-11-09');
    const region = await materialArea();
    fireEvent.click(await within(region).findByRole('button', { name: /Envie 3 fotos/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
    expect(within(dialog).getByText(/Entregar até 09\/11/)).toBeTruthy();
    expect(within(dialog).getByText('venceu')).toBeTruthy();
    await within(dialog).findByText('Envie 3 fotos da equipe');
  });

  it('opens a request without a deadline: the subject and the text travel, no dueOn, and the dialog closes', async () => {
    const { api, onWritten } = mountMaterial();
    const region = await materialArea();
    await within(region).findByText('Nenhum pedido de material');
    const dialog = await openDialog(region);
    write(dialog, '  Envie 3 fotos da equipe  ');
    send(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toStrictEqual([{ subject: { materialRequest: true }, title: TITLE, body: 'Envie 3 fotos da equipe' }]);
    await within(region).findByText('Envie 3 fotos da equipe');
    expect(within(region).getByRole('heading', { name: 'Pedidos de material (1)' })).toBeTruthy();
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(api.calls).toContain(`POST /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads`);
  });

  it('asks for the title above the text, counts it trimmed and sends it trimmed', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    const titleField = within(dialog).getByRole('textbox', { name: 'Título do pedido' });
    const bodyField = within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' });
    expect(titleField.compareDocumentPosition(bodyField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByText('0/80')).toBeTruthy();

    write(dialog, 'Envie 3 fotos da equipe', `  ${TITLE}  `);
    expect(within(dialog).getByText('15/80')).toBeTruthy();
    send(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toStrictEqual([{ subject: { materialRequest: true }, title: TITLE, body: 'Envie 3 fotos da equipe' }]);
    expect(api.threads[0]?.title).toBe(TITLE);
  });

  it.each([
    ['empty', ''],
    ['made of spaces', '   ']
  ])('refuses a title that is %s without sending, on its own field, and sends once it is filled', async (_name, typed) => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Envie 3 fotos da equipe', typed);
    send(dialog);

    await within(dialog).findByText('Informe o título do pedido.');
    expect(within(dialog).getByRole('textbox', { name: 'Título do pedido' }).getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }).getAttribute('aria-invalid')).toBeNull();
    expect((within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Envie 3 fotos da equipe');
    expect(screen.getByRole('dialog', { name: 'Pedir material' })).toBeTruthy();
    expect(api.bodies).toHaveLength(0);

    writeTitle(dialog, TITLE);
    expect(within(dialog).queryByText('Informe o título do pedido.')).toBeNull();
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
  });

  it('refuses a title over 80 characters and one with invisible characters before sending', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Envie 3 fotos da equipe', 'a'.repeat(81));
    expect(within(dialog).getByText('81/80')).toBeTruthy();
    send(dialog);
    await within(dialog).findByText('O título passa de 80 caracteres.');
    expect(api.bodies).toHaveLength(0);

    // 80 characters including an invisible one: refused for it, not for the length.
    writeTitle(dialog, `${'a'.repeat(79)}${String.fromCharCode(0x200b)}`);
    send(dialog);
    await within(dialog).findByText('O título tem caracteres que não são aceitos.');
    expect(within(dialog).queryByText('O título passa de 80 caracteres.')).toBeNull();
    expect(api.bodies).toHaveLength(0);

    writeTitle(dialog, 'a'.repeat(80));
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
  });

  it('counts the title in characters, so the counter and the block agree on emoji: 80/80 sends, 81/80 is refused for its length', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    const camera = String.fromCodePoint(0x1f4f8);
    write(dialog, 'Envie 3 fotos da equipe', `a${camera.repeat(80)}`);
    expect(within(dialog).getByText('81/80')).toBeTruthy();
    send(dialog);
    await within(dialog).findByText('O título passa de 80 caracteres.');
    expect(api.bodies).toHaveLength(0);

    writeTitle(dialog, `a${camera.repeat(79)}`);
    expect(within(dialog).getByText('80/80')).toBeTruthy();
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
    expect(api.bodies[0]).toMatchObject({ title: `a${camera.repeat(79)}` });
  });

  it('puts the refusal of the server about the title on its field and keeps everything typed', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Envie 3 fotos da equipe');
    api.failNextWrite(() => new Response(JSON.stringify({ error: {
      code: 'VALIDATION_ERROR', message: 'Request validation failed',
      details: { issues: [{ path: 'title', code: 'custom', message: 'a request for material needs a title' }] }
    } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    send(dialog);

    await within(dialog).findByText('O título tem caracteres que não são aceitos.');
    expect(within(dialog).getByRole('textbox', { name: 'Título do pedido' }).getAttribute('aria-invalid')).toBe('true');
    expect((within(dialog).getByRole('textbox', { name: 'Título do pedido' }) as HTMLInputElement).value).toBe(TITLE);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(api.threads).toHaveLength(0);
  });

  it('counts a title typed alone for the discard guard', async () => {
    mountMaterial();
    const dialog = await openDialog(await materialArea());
    writeTitle(dialog, 'Fotos');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar pedido de material' }));
    await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' });
  });

  it('opens a request with a deadline typed or picked, sent as the São Paulo day', async () => {
    const { api } = mountMaterial();
    const region = await materialArea();
    const dialog = await openDialog(region);
    write(dialog, 'Envie 3 fotos da equipe');
    pickDay(dialog, '20/11/2026');
    send(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toStrictEqual([{ subject: { materialRequest: true }, title: TITLE, body: 'Envie 3 fotos da equipe', dueOn: '2026-11-20' }]);
    await within(region).findByText(/Entregar até 20\/11/);
  });

  it.each([
    ['a year of two digits', '20/11/26'],
    ['a day that does not exist', '31/02/2026'],
    ['half a date', '20/11']
  ])('refuses %s as "Data inválida" on the deadline, sends nothing and keeps the dialog open with what was typed', async (_name, typed) => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Envie 3 fotos da equipe');
    pickDay(dialog, typed);
    send(dialog);

    await within(dialog).findByText(invalidDayMessage);
    expect(within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }).getAttribute('aria-invalid')).toBe('true');
    expect((within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }) as HTMLInputElement).value).toBe(typed);
    expect((within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Envie 3 fotos da equipe');
    expect(screen.getByRole('dialog', { name: 'Pedir material' })).toBeTruthy();
    expect(api.bodies).toHaveLength(0);

    pickDay(dialog, '20112026');
    expect(within(dialog).queryByText(invalidDayMessage)).toBeNull();
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
    expect(api.bodies[0]).toMatchObject({ dueOn: '2026-11-20' });
  });

  it('counts a deadline typed incompletely as typed text for the discard guard', async () => {
    mountMaterial();
    const dialog = await openDialog(await materialArea());
    pickDay(dialog, '20/11');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar pedido de material' }));
    await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' });
  });

  it('still sends no deadline when the field was typed into and then emptied', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Envie 3 fotos da equipe');
    pickDay(dialog, '20/11/26');
    pickDay(dialog, '');
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
    expect(api.bodies[0]).toStrictEqual({ subject: { materialRequest: true }, title: TITLE, body: 'Envie 3 fotos da equipe' });
  });

  it('accepts the deadline from today to 90 days ahead on the São Paulo day, and refuses the days outside it before sending', async () => {
    const { api } = mountMaterial();
    const region = await materialArea();
    const dialog = await openDialog(region);
    write(dialog, 'Envie 3 fotos da equipe');

    // Today in São Paulo is 10/11; the UTC day is already the 11th.
    for (const outside of ['09/11/2026', '09/02/2027']) {
      pickDay(dialog, outside);
      send(dialog);
      await within(dialog).findByText('Escolha um prazo de hoje até 90 dias à frente.');
      expect(api.bodies).toHaveLength(0);
    }
    expect(screen.getByRole('dialog', { name: 'Pedir material' })).toBeTruthy();
    expect((within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Envie 3 fotos da equipe');

    pickDay(dialog, '10/11/2026');
    send(dialog);
    await waitFor(() => expect(api.bodies).toHaveLength(1));
    expect(api.bodies[0]).toMatchObject({ dueOn: '2026-11-10' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();

    const last = mountMaterial();
    const lastDialog = await openDialog(await materialArea());
    write(lastDialog, 'Outro pedido');
    pickDay(lastDialog, '08/02/2027');
    send(lastDialog);
    await waitFor(() => expect(last.api.bodies).toHaveLength(1));
    expect(last.api.bodies[0]).toMatchObject({ dueOn: '2027-02-08' });
  });

  it('puts the refusal of the server about the deadline on the field, in Portuguese, and keeps everything typed', async () => {
    const { api } = mountMaterial();
    const region = await materialArea();
    const dialog = await openDialog(region);
    write(dialog, 'Envie 3 fotos da equipe');
    pickDay(dialog, '20/11/2026');
    api.failNextWrite(() => new Response(JSON.stringify({ error: {
      code: 'VALIDATION_ERROR', message: 'Request validation failed',
      details: { issues: [{ path: 'dueOn', code: 'custom', message: 'the deadline is from today to 90 days ahead' }] }
    } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    send(dialog);

    await within(dialog).findByText('Escolha um prazo de hoje até 90 dias à frente.');
    expect(within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }).getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }).getAttribute('aria-invalid')).toBeNull();
    expect((within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Envie 3 fotos da equipe');
    expect((within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }) as HTMLInputElement).value).toBe('20/11/2026');
    expect(screen.getByRole('dialog', { name: 'Pedir material' })).toBeTruthy();
    expect(api.threads).toHaveLength(0);
  });

  it.each([
    ['an archived client', () => apiError(409, 'CLIENT_ARCHIVED'), 'Cliente arquivado: não é possível pedir material.'],
    ['a refused permission', () => apiError(403, 'FORBIDDEN'), 'Você não tem permissão para pedir material a este cliente.'],
    ['a client that is gone', () => apiError(404, 'NOT_FOUND'), 'Este cliente não existe mais.'],
    ['a refused text', () => apiError(400, 'VALIDATION_ERROR'), 'Revise o texto e tente de novo.'],
    ['a failing server', () => apiError(500, 'INTERNAL_ERROR'), 'Não foi possível enviar o pedido. Tente de novo.']
  ])('says in Portuguese why the request was refused (%s) and keeps what was typed', async (_name, make, text) => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    write(dialog, 'Texto que não pode sumir');
    pickDay(dialog, '20/11/2026');
    api.failNextWrite(make);
    send(dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect((within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
    expect((within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }) as HTMLInputElement).value).toBe('20/11/2026');
    // Trying again works and closes the dialog.
    send(dialog, 'Tentar de novo');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.bodies).toHaveLength(2);
  });

  it('refuses an empty text without sending, and asks before discarding what was typed', async () => {
    const { api } = mountMaterial();
    const dialog = await openDialog(await materialArea());
    send(dialog);
    await within(dialog).findByText('Escreva a mensagem.');
    expect(api.bodies).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar pedido de material' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();

    mountMaterial();
    const typed = await openDialog(await materialArea());
    write(typed, 'Rascunho');
    fireEvent.click(within(typed).getByRole('button', { name: 'Fechar pedido de material' }));
    const confirm = await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Continuar editando' }));
    expect((within(typed).getByRole('textbox', { name: 'O que você precisa do cliente' }) as HTMLTextAreaElement).value).toBe('Rascunho');
  });

  it('hides "Pedir material" from whoever cannot write and from a read-only client, and blocks it on an expired plan', async () => {
    const reader = mountMaterial({ canWrite: false });
    reader.api.seed(MATERIAL, [{ side: 'agency', body: 'Envie 3 fotos', at: LATE }]);
    const region = await materialArea();
    await within(region).findByText('Envie 3 fotos');
    expect(within(region).queryByRole('button', { name: 'Pedir material' })).toBeNull();
    cleanup();

    mountMaterial({ readOnly: true });
    await within(await materialArea()).findByText('Nenhum pedido de material');
    expect(screen.queryByRole('button', { name: 'Pedir material' })).toBeNull();
    cleanup();

    mountMaterial({ planBlockedReason: 'Renove o plano para escrever.' });
    const blocked = await within(await materialArea()).findByRole('button', { name: /Pedir material/ });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(blocked);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves exactly the request that was opened, with the other one still open', async () => {
    const { api } = mountMaterial();
    const first = api.seed(MATERIAL, [{ side: 'agency', body: 'Primeiro pedido', at: EARLIER }], undefined, '2026-11-20');
    const second = api.seed(MATERIAL, [{ side: 'agency', body: 'Segundo pedido', at: LATE }], undefined, '2026-11-25');
    const region = await materialArea();
    fireEvent.click(await within(region).findByRole('button', { name: /Segundo pedido/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Resolver' }));
    await waitFor(() => expect(api.calls).toContain(`POST /agencies/${AGENCY_ID}/clients/${CLIENT_ID}/threads/${second}/resolve`));
    expect(api.calls.some((call) => call.includes(`/threads/${first}/resolve`))).toBe(false);
    await waitFor(() => expect(rowOf(region, 'Segundo pedido').textContent).toContain('resolvida'));
    expect(rowOf(region, 'Primeiro pedido').textContent).toContain('aberta');
  });

  it('keeps the other subjects as they were: no material label, no deadline, no "Pedir material"', async () => {
    const { api } = mount();
    api.seed(TONE, [{ side: 'client', body: 'Acho formal demais', at: LATE }]);
    const region = await area();
    await within(region).findByText('Acho formal demais');
    expect(within(region).getByRole('heading', { name: 'Conversas (1)' })).toBeTruthy();
    expect(within(region).queryByText('Pedido de material')).toBeNull();
    expect(within(region).queryByText(/Entregar até/)).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Pedir material' })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Nova conversa sobre Tom de voz' })).toBeTruthy();
  });
});
