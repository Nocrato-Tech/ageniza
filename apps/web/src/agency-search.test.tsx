// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencySearchResponse } from '@ageniza/contracts';

import { AgencySearch, AgencySearchPhone } from './agency-search.js';
import { markTerm, queryableTerm } from './agency-search-model.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';

vi.mock('./agency.js', () => ({ useAgencyContext: () => ({ agencyId: '11111111-1111-4111-8111-111111111111' }) }));

const AGENCY = '11111111-1111-4111-8111-111111111111';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLIENT = id(1);
const FOLDER_TOP = id(50);
const FOLDER_SUB = id(51);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const client = { id: CLIENT, name: 'Padaria Central', photoUrl: null, instagramHandle: 'padariacentral', archived: false };
const content = { id: id(2), clientId: CLIENT, clientName: 'Padaria Central', title: 'Promoção de pães', format: 'reels', status: 'approved', overdue: false, scheduled: false, publishOn: '2026-11-20' } as const;
const file = { id: id(3), clientId: CLIENT, clientName: 'Padaria Central', folderId: FOLDER_SUB, name: 'padaria-fachada.jpg', category: 'image', thumbnailAssetId: null } as const;

const answerOf = (data: Partial<AgencySearchResponse['data']>, q = 'padar'): AgencySearchResponse => ({
  data: { clients: [], contents: [], files: [], ...data },
  meta: { q }
});

const folder = (folderId: string, parentId: string | null) => ({
  id: folderId, parentId, name: 'Pasta', isDefault: false, createdAt: '2026-11-01T00:00:00.000Z',
  counts: { image: 1, video: 0, pdf: 0, audio: 0, logo: 0 }, assetCount: 1, totalSizeBytes: 10, lastChangedAt: '2026-11-01T00:00:00.000Z', lastUploadedBy: null, inUseNow: false
});

interface Call { q: string; signal: AbortSignal | undefined }
interface World {
  calls: Call[];
  folderCalls: number;
  thumbnailCalls: string[];
  /** What the search answers; a promise holds the answer until the test lets it go. */
  reply: (call: Call) => Response | Promise<Response>;
}
let world: World;
let probe: { pathname: string; search: string };

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

beforeEach(() => {
  vi.useFakeTimers();
  world = { calls: [], folderCalls: 0, thumbnailCalls: [], reply: () => json(answerOf({})) };
  probe = { pathname: '', search: '' };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** The API answers in a macrotask, as a network does. */
const httpClient = (): HttpClient => new HttpClient('http://127.0.0.1:3001', async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === `/agencies/${AGENCY}/search`) {
    const call = { q: url.searchParams.get('q') ?? '', signal: init?.signal ?? undefined };
    world.calls.push(call);
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { Promise.resolve(world.reply(call)).then(resolve, reject); }, 0);
      call.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
    });
  }
  if (url.pathname === `/agencies/${AGENCY}/clients/${CLIENT}/media-folders/summary`) {
    world.folderCalls += 1;
    return json({ data: [folder(FOLDER_TOP, null), folder(FOLDER_SUB, FOLDER_TOP)], meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 } });
  }
  if (url.pathname === `/agencies/${AGENCY}/media/${id(77)}/download-url`) {
    world.thumbnailCalls.push(url.search);
    return json({ url: 'https://storage.test/thumb.jpg', expiresAt: '2099-01-01T00:00:00.000Z' });
  }
  throw new Error(`unexpected ${url.pathname}`);
});

function Probe() {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

const renderSearch = (phone = false): void => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={httpClient()}>
        <MemoryRouter initialEntries={[`/agencia/${AGENCY}`]}>
          <Probe />
          {phone ? <AgencySearchPhone agencyId={AGENCY} /> : <AgencySearch agencyId={AGENCY} />}
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  );
};

const field = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Buscar' }) as HTMLInputElement;
const type = (value: string): void => { fireEvent.change(field(), { target: { value } }); };
const wait = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const open = (): void => { fireEvent.focus(field()); };
const key = (name: string): void => { fireEvent.keyDown(field(), { key: name }); };

describe('the term', () => {
  it.each([
    ['a', null], ['á', null], ['@a', null], ['@a ', null], ['  a  ', null], ['@', null], ['\t', null],
    ['ab', 'ab'], ['@ab', '@ab'], ['  pão  ', 'pão'], ['á b', 'á b']
  ])('%j is asked as %j', (raw, asked) => {
    expect(queryableTerm(raw)).toBe(asked);
  });

  it('marks the term in a name without regard to accents or case', () => {
    expect(markTerm('Promoção de Pães', 'PAES')).toEqual({ before: 'Promoção de ', hit: 'Pães', after: '' });
    expect(markTerm('Padaria', 'zzz')).toBeNull();
  });
});

describe('the call', () => {
  it('waits 250 ms after the last key and asks only for the last term', async () => {
    renderSearch();
    open();
    type('pad');
    await wait(100);
    type('pada');
    await wait(100);
    type('padar');
    await wait(249);
    expect(world.calls).toEqual([]);
    await wait(1);
    expect(world.calls.map((call) => call.q)).toEqual(['padar']);
  });

  it('cancels the call in flight when the term changes, and never shows its answer', async () => {
    let release: (() => void) | undefined;
    world.reply = (call) => call.q === 'pad'
      ? new Promise<Response>((resolve) => { release = () => { resolve(json(answerOf({ clients: [client] }, 'pad'))); }; })
      : json(answerOf({ contents: [content] }, 'padar'));
    renderSearch();
    open();
    type('pad');
    await wait(250);
    expect(world.calls[0]!.signal!.aborted).toBe(false);
    type('padar');
    expect(world.calls[0]!.signal!.aborted).toBe(true);
    await wait(250);
    release?.();
    await wait(10);
    expect(world.calls.map((call) => call.q)).toEqual(['pad', 'padar']);
    expect(screen.getByRole('group', { name: 'Conteúdos' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Clientes' })).toBeNull();
  });

  it.each(['a', 'á', '@a', '@a ', ' a '])('does not call the API for %j, below the minimum of searched characters', async (raw) => {
    renderSearch();
    open();
    type(raw);
    await wait(1000);
    expect(world.calls).toEqual([]);
    expect(screen.getByText('Digite o nome de um cliente, de um conteúdo ou de um arquivo.')).toBeTruthy();
  });

  it('calls again once the term reaches the minimum, with the term trimmed', async () => {
    renderSearch();
    open();
    type('@a ');
    await wait(500);
    type('@ab ');
    await wait(250);
    expect(world.calls.map((call) => call.q)).toEqual(['@ab']);
  });

  it('stops asking, and aborts, when the term is cleared again', async () => {
    renderSearch();
    open();
    type('pad');
    await wait(250);
    type('');
    expect(world.calls[0]!.signal!.aborted).toBe(true);
    await wait(500);
    expect(world.calls).toHaveLength(1);
  });
});

describe('the results', () => {
  it('shows only the groups that came, in order, each with its count', async () => {
    world.reply = () => json(answerOf({ clients: [client], files: [file] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    const groups = screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Clientes', 'Arquivos']);
    expect(screen.queryByRole('group', { name: 'Conteúdos' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Clientes' })).getByRole('option').textContent).toContain('@padariacentral');
    expect(within(screen.getByRole('group', { name: 'Arquivos' })).getByRole('option').textContent).toContain('Padaria Central · Foto');
  });

  it('says the state of a content as the agency reads it: Atrasado and Agendado come before the status', async () => {
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
    world.reply = () => json(answerOf({ contents: [{ ...content, overdue: true }, { ...content, id: id(9), scheduled: true, title: 'Outro' }] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    const rows = screen.getAllByRole('option').map((row) => row.textContent);
    expect(rows[0]).toContain('Padaria Central · Reels · Atrasado 2 dias');
    expect(rows[1]).toContain('Padaria Central · Reels · Agendado');
  });

  it('says how many days late a content is, counted in São Paulo days, each on its own row', async () => {
    vi.setSystemTime(new Date('2026-11-14T01:30:00Z'));
    world.reply = () => json(answerOf({ contents: [
      { ...content, overdue: true, publishOn: '2026-11-12' },
      { ...content, id: id(9), title: 'Outro', overdue: true, publishOn: '2026-11-11' }
    ] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    const rows = screen.getAllByRole('option');
    expect(rows[0]!.textContent).toContain('Padaria Central · Reels · Atrasado 1 dia');
    expect(rows[0]!.textContent).not.toContain('Atrasado 1 dias');
    expect(rows[1]!.textContent).toContain('Padaria Central · Reels · Atrasado 2 dias');
  });

  it('draws a name as text, never as markup', async () => {
    world.reply = () => json(answerOf({ files: [{ ...file, name: '<img src=x onerror="window.hacked=1">padaria.jpg' }] }));
    renderSearch();
    open();
    type('padaria');
    await wait(260);
    expect(screen.getByRole('option').querySelector('img')).toBeNull();
    expect(screen.getByRole('option').textContent).toContain('<img src=x');
  });

  it('shows skeleton lines while the first answer is on the way, and keeps the old list while a new term is asked', async () => {
    world.reply = (call) => call.q === 'padar' ? json(answerOf({ clients: [client] })) : new Promise<Response>(() => undefined);
    renderSearch();
    open();
    type('padar');
    await wait(250);
    expect(document.querySelector('.agency-search__skeleton')).not.toBeNull();
    await wait(10);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    type('padari');
    await wait(260);
    expect(document.querySelector('.agency-search__skeleton')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});

describe('the states', () => {
  it('says nothing was found for the term and clears the search from the button, with the focus back on the field', async () => {
    renderSearch();
    open();
    type('zzzz');
    await wait(260);
    expect(screen.getByRole('heading', { name: 'Nada encontrado para «zzzz»' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar a busca' }));
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(screen.getByText('Digite o nome de um cliente, de um conteúdo ou de um arquivo.')).toBeTruthy();
  });

  it('says it could not search and repeats from Tentar de novo', async () => {
    let failing = true;
    world.reply = () => failing ? json({ error: { code: 'INTERNAL', message: 'Falhou.' } }, 500) : json(answerOf({ clients: [client] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    expect(screen.getByRole('heading', { name: 'Não foi possível buscar' })).toBeTruthy();
    expect(screen.queryByText(/muitas buscas/)).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await wait(10);
    expect(world.calls).toHaveLength(2);
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('asks to wait a moment on a 429', async () => {
    world.reply = () => json({ error: { code: 'RATE_LIMITED', message: 'Muitas.' } }, 429, { 'retry-after': '30' });
    renderSearch();
    open();
    type('padar');
    await wait(260);
    expect(screen.getByText('Foram muitas buscas seguidas. Espere um instante e tente de novo.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });
});

describe('the keyboard and the destinations', () => {
  const everything = (): void => { world.reply = () => json(answerOf({ clients: [client], contents: [content], files: [file] })); };

  it('moves with the arrows, opens with Enter and keeps the focus on the field', async () => {
    everything();
    renderSearch();
    field().focus();
    type('padar');
    await wait(260);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(field().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    key('ArrowDown');
    key('ArrowDown');
    expect(field().getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    key('ArrowDown');
    expect(field().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    key('ArrowUp');
    expect(field().getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    expect(document.activeElement).toBe(field());
  });

  it('clears the term with the first Esc, keeping the panel and the focus, and closes with the second', async () => {
    everything();
    renderSearch();
    field().focus();
    type('padar');
    await wait(260);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    const foot = (): string => document.querySelector('.agency-search__foot')!.textContent!;
    expect(foot()).toContain('Esc limpar');
    key('Escape');
    expect(field().value).toBe('');
    expect(screen.getByRole('region', { name: 'Resultados da busca' })).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect(foot()).toContain('Esc fechar');
    key('Escape');
    expect(screen.queryByRole('region', { name: 'Resultados da busca' })).toBeNull();
    expect(document.activeElement).toBe(field());
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('region', { name: 'Resultados da busca' })).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  it('closes the panel with a foot of hints: the keys, and what the search looks in', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    const foot = document.querySelector('.agency-search__foot')!;
    expect(foot.textContent).toContain('↑↓ navegar');
    expect(foot.textContent).toContain('Enter abrir');
    expect(foot.textContent).toContain('Esc limpar');
    expect(foot.lastElementChild?.textContent).toBe('Clientes, conteúdos e arquivos');
  });

  it('shows the Enter hint on the active row only, hidden from the screen reader', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    const hints = document.querySelectorAll('.agency-search__enter');
    expect(hints).toHaveLength(1);
    expect(hints[0]!.textContent).toBe('Enter');
    expect(hints[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByRole('option')[0]!.contains(hints[0]!)).toBe(true);
    key('ArrowDown');
    expect(screen.getAllByRole('option')[1]!.querySelector('.agency-search__enter')).not.toBeNull();
    expect(screen.getAllByRole('option')[0]!.querySelector('.agency-search__enter')).toBeNull();
  });

  it('closes when the person presses outside the search', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('takes a client to the Visão geral of the client', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    fireEvent.click(screen.getAllByRole('option')[0]!);
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/geral`);
    expect(field().value).toBe('');
  });

  it('takes a content to the calendar of its client with the content open', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    key('ArrowDown');
    key('Enter');
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/${content.id}`);
  });

  it('takes a file to the Mídias tab at its folder, spelling a subfolder with its parent', async () => {
    everything();
    renderSearch();
    open();
    type('padar');
    await wait(260);
    key('ArrowUp');
    key('Enter');
    await wait(10);
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/midias`);
    expect(probe.search).toBe(`?pasta=${FOLDER_TOP}&subpasta=${FOLDER_SUB}`);
  });

  it('takes a file of a first-level folder with only the folder', async () => {
    world.reply = () => json(answerOf({ files: [{ ...file, folderId: FOLDER_TOP }] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    key('Enter');
    await wait(10);
    expect(probe.search).toBe(`?pasta=${FOLDER_TOP}`);
  });
});

describe('the thumbnail of a file', () => {
  const THUMBNAIL_ASSET = id(77);

  it('draws the picture the library uses when the file has one, and the icon of its type when it has none', async () => {
    world.reply = () => json(answerOf({ files: [{ ...file, thumbnailAssetId: THUMBNAIL_ASSET }, { ...file, id: id(4), name: 'padaria-cardapio.pdf', category: 'pdf', thumbnailAssetId: null }] }));
    renderSearch();
    open();
    type('padar');
    await wait(260);
    await wait(10);
    const [photo, pdf] = screen.getAllByRole('option');
    expect(photo!.querySelector('.agency-search__icon img')).not.toBeNull();
    expect(pdf!.querySelector('.agency-search__icon img')).toBeNull();
    expect(pdf!.querySelector('.agency-search__icon svg')).not.toBeNull();
    expect(world.thumbnailCalls).toEqual(['?variant=thumbnail']);
  });
});

describe('on a phone', () => {
  it('is an icon that opens a sheet with the field, and a result closes it and goes there', async () => {
    world.reply = () => json(answerOf({ clients: [client] }));
    renderSearch(true);
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    const input = screen.getByRole('combobox', { name: 'Buscar' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'padar' } });
    await wait(260);
    fireEvent.click(screen.getByRole('option'));
    expect(probe.pathname).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/geral`);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
