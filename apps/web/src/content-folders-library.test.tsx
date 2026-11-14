// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENCY_A, apiError, assetFixture, foldersUrl, idOf, json, makeFetch, makeWorld, padaria, renderFolders, usageFixture, type World
} from './content-folders-fixture.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

// 01:30Z is 22h30 of Oct 11 in São Paulo: "today" is the 11th.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});

const VIDEOS = idOf('f', 1);
const IMAGES = idOf('f', 2);
const CAMPANHA = idOf('f', 5);
const FACHADA = idOf('a', 1);
const CARDAPIO = idOf('a', 2);
const FORNO = idOf('a', 3);
const LOGO = idOf('a', 4);
const base = `/agencies/${AGENCY_A}/clients/${padaria.id}`;

/** The board's library: the folder in use with two files, a video, a logo, and a file nobody uses. */
const boardWorld = (overrides: Partial<World> = {}): World => makeWorld({
  inUseFolderId: CAMPANHA,
  assets: [
    assetFixture(1, CAMPANHA, {
      name: 'padaria-fachada-natal.jpg', sizeBytes: 4_404_019, createdAt: '2026-10-11T12:12:00.000Z', altText: 'Fachada enfeitada para o Natal.',
      usage: [usageFixture(1, { title: 'Cardápio de Natal', status: 'awaiting_approval' })]
    }),
    assetFixture(2, CAMPANHA, {
      name: 'cardapio-natal-2026.pdf', category: 'pdf', contentType: 'application/pdf', sizeBytes: 3_355_443, width: null, height: null,
      createdAt: '2026-10-10T19:40:00.000Z', usage: [usageFixture(2, { title: 'Cardápio da semana', status: 'awaiting_approval' }), usageFixture(3, { title: 'Feriado', status: 'published', asMedia: false, asCover: true })]
    }),
    assetFixture(3, VIDEOS, {
      name: 'forno-novo-reels.mp4', category: 'video', contentType: 'video/mp4', sizeBytes: 50_331_648, createdAt: '2026-10-05T14:05:00.000Z',
      videoProcessingStatus: 'ready', usage: [usageFixture(4, { title: 'Pão de fermentação natural', status: 'approved' })]
    }),
    assetFixture(4, IMAGES, {
      name: 'logo-padaria-central.svg', category: 'logo', contentType: 'image/svg+xml', sizeBytes: 38_000, width: null, height: null, createdAt: '2026-10-03T13:30:00.000Z'
    })
  ],
  ...overrides
});

const open = (world: World, search = '') => renderFolders(makeFetch(world), foldersUrl(search));
const table = async (name: string) => within(await screen.findByRole('table', { name }));
const nameButton = (name: string): HTMLElement => screen.getByRole('button', { name });
const rowOf = (name: string): HTMLElement => nameButton(name).closest<HTMLElement>('[role="row"]')!;
const openMenu = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Ações de ${name}` }));
  return within(screen.getByRole('menu', { name: `Ações de ${name}` }));
};
const panelNode = (): HTMLElement => document.querySelector<HTMLElement>('aside.media-detail')!;
const panel = () => within(panelNode());
const main = (): HTMLElement => document.querySelector<HTMLElement>('main') ?? document.body;
const writes = (world: World) => world.bodies.map((entry) => ({ method: entry.method, path: entry.path.replace(base, ''), body: entry.body }));

describe('the library as the board draws it', () => {
  it('shows the search, the primary, the quick access, the folders and the recent files with every text of the board', async () => {
    open(boardWorld());

    expect(await screen.findByRole('heading', { name: 'Acesso rápido' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Buscar nesta biblioteca' }).getAttribute('placeholder')).toBe('Buscar nesta biblioteca');
    expect(screen.getByRole('button', { name: 'Enviar arquivos' })).toBeTruthy();

    const inUse = screen.getByRole('link', { name: /^Pasta em uso agora/ });
    expect(inUse.textContent).toContain('Campanha de Natal');
    expect(inUse.textContent).toContain('2 arquivos · 7,4 MB · atualizada hoje');
    expect(inUse.textContent).toContain('Abrir a pasta');
    expect(within(inUse).getByRole('img', { name: 'Enviado por: Marina Bastos' })).toBeTruthy();

    const pdf = await screen.findByRole('button', { name: /^cardapio-natal-2026\.pdf 3,2 MB Usado em 2 posts/ });
    await waitFor(() => expect(pdf.textContent).toContain('Aguardando aprovação'));
    const photo = screen.getByRole('button', { name: /^padaria-fachada-natal\.jpg 4,2 MB Usado em 1 post/ });
    await waitFor(() => expect(photo.textContent).toContain('Aguardando aprovação'));
    expect(screen.queryByRole('button', { name: /^forno-novo-reels\.mp4 .*Usado em/ })).toBeNull();

    expect(screen.getByRole('heading', { name: 'Pastas' })).toBeTruthy();
    expect(screen.getByText('Cada pasta diz o que guarda.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Campanha de Natal 2 arquivos 7,4 MB' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vídeos Padrão 1 vídeo 48 MB' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Imagens Padrão 1 logo 37,1 KB' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Carrosséis Padrão Vazia' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nova pasta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ações da pasta Campanha de Natal' })).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'Enviados recentemente' })).toBeTruthy();
    const recents = await table('Enviados recentemente');
    expect(recents.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Nome', 'Tipo', 'Usado em', 'Quando', 'Ações do arquivo']);
    const rows = recents.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['padaria-fachada-natal.jpg', 'Foto', '1 post', 'Hoje, 9h12', ''],
      ['cardapio-natal-2026.pdf', 'PDF', '2 posts', 'Ontem, 16h40', ''],
      ['forno-novo-reels.mp4', 'Vídeo', '1 post', '5 out, 11h05', ''],
      ['logo-padaria-central.svg', 'Logo', 'Ainda não usado', '3 out, 10h30', '']
    ]);
    expect(screen.queryByRole('link', { name: 'Ver todos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver todas' })).toBeNull();
  });

  it('opens the folder in use from its block, and from its menu, with the state of the roster', async () => {
    const state = { clientListUrl: '/agencia/x/clientes?page=2' };
    const { probe } = renderFolders(makeFetch(boardWorld()), { pathname: foldersUrl().split('?')[0]!, search: '', state });

    fireEvent.click(await screen.findByRole('link', { name: /^Pasta em uso agora/ }));
    expect(await screen.findByRole('heading', { name: 'Campanha de Natal' })).toBeTruthy();
    expect(new URLSearchParams(probe.search).get('pasta')).toBe(CAMPANHA);
    expect(probe.state).toEqual(state);
    fireEvent.click(screen.getByRole('link', { name: 'Pastas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ações da pasta Imagens' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Abrir' }));
    await waitFor(() => expect(new URLSearchParams(probe.search).get('pasta')).toBe(IMAGES));
    expect(probe.state).toEqual(state);
  });

  it('leaves the block of the folder in use out when no folder is in use, and "Ver todas" shows the folders past the first five', async () => {
    const world = makeWorld({ inUseFolderId: undefined, folders: [
      ...[1, 2, 3, 4].map((index) => ({ ...makeWorld().folders[index - 1]! })),
      ...Array.from({ length: 4 }, (_value, index) => ({ ...makeWorld().folders[4]!, id: idOf('f', 20 + index), name: `Extra ${index + 1}` }))
    ] });
    open(world);

    await screen.findByRole('heading', { name: 'Pastas' });
    expect(screen.queryByRole('heading', { name: 'Acesso rápido' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /Vazia$/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas' }));
    expect(screen.getAllByRole('link', { name: /Vazia$/ })).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Ver menos' })).toBeTruthy();
  });

  it('shows "Ver todos" when the library holds more than the five recent files, and lists them all by pages of the address', async () => {
    const many = Array.from({ length: 23 }, (_value, index) => assetFixture(index + 1, IMAGES, {
      name: `foto-${String(index + 1).padStart(2, '0')}.jpg`, createdAt: new Date(Date.UTC(2026, 9, 1) + (index + 1) * 60_000).toISOString()
    }));
    const { probe } = open(makeWorld({ assets: many }));

    await table('Enviados recentemente');
    expect(screen.getAllByRole('row')).toHaveLength(6);
    fireEvent.click(screen.getByRole('link', { name: 'Ver todos' }));
    expect(await screen.findByRole('heading', { name: 'Todos os arquivos' })).toBeTruthy();
    expect(new URLSearchParams(probe.search).get('todos')).toBe('1');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(21));
    expect(screen.getByText('23 arquivos')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(new URLSearchParams(probe.search).get('pagina')).toBe('2'));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Caminho da pasta' })).getByRole('link', { name: 'Pastas' }));
    expect(await screen.findByRole('heading', { name: 'Enviados recentemente' })).toBeTruthy();
    expect(probe.search).toBe('');
  });
});

describe('the detail panel', () => {
  it('opens from the row with the name, the type, the usage, the information and the actions, and closes by "Fechar detalhes"', async () => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(nameButton('padaria-fachada-natal.jpg'));
    const side = panel();
    expect(side.getByRole('heading', { name: 'padaria-fachada-natal.jpg' })).toBeTruthy();
    expect(side.getByText('Foto · 4,2 MB · enviada hoje')).toBeTruthy();
    expect(side.getByRole('tab', { name: 'Detalhes' }).getAttribute('aria-selected')).toBe('true');
    expect((side.getByRole('tab', { name: 'Atividade' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await side.findByText('Cardápio de Natal')).toBeTruthy();
    expect(side.getByRole('heading', { name: 'Usada em' })).toBeTruthy();
    expect(side.getByText('Mídia')).toBeTruthy();
    expect(side.getByText('Aguardando aprovação')).toBeTruthy();
    expect(side.getByRole('heading', { name: 'Informações' })).toBeTruthy();
    const info = Array.from(panelNode().querySelectorAll('dt, dd')).map((node) => node.textContent);
    expect(info).toEqual(['Pasta', 'Campanha de Natal', 'Dimensões', '3024 × 4032', 'Enviada por', 'Marina Bastos', 'Em', '11 out 2026, 9h12']);
    expect((side.getByRole('textbox', { name: /Texto alternativo/ }) as HTMLTextAreaElement).value).toBe('Fachada enfeitada para o Natal.');
    expect(side.getByText('Para acessibilidade')).toBeTruthy();
    expect(side.getByRole('button', { name: 'Baixar' })).toBeTruthy();
    expect(side.getByRole('button', { name: 'Excluir' })).toBeTruthy();
    expect(world.calls.filter((call) => /\/usage/.test(call)).some((call) => call.includes(`/media/${FACHADA}/usage`))).toBe(true);

    fireEvent.click(side.getByRole('button', { name: 'Fechar detalhes' }));
    expect(document.querySelector('aside.media-detail')).toBeNull();
  });

  it('shows the panel of the row that was chosen and of no other, and the rows of its usage with their state', async () => {
    open(boardWorld());
    await table('Enviados recentemente');

    fireEvent.click(nameButton('padaria-fachada-natal.jpg'));
    expect(await panel().findByText('Cardápio de Natal')).toBeTruthy();
    fireEvent.click(nameButton('cardapio-natal-2026.pdf'));

    const side = panel();
    expect(side.getByRole('heading', { name: 'cardapio-natal-2026.pdf' })).toBeTruthy();
    expect(side.getByText('PDF · 3,2 MB · enviada ontem')).toBeTruthy();
    expect(await side.findByText('Cardápio da semana')).toBeTruthy();
    expect(side.getByText('Feriado')).toBeTruthy();
    expect(side.getByText('Capa')).toBeTruthy();
    expect(side.getByText('Publicado')).toBeTruthy();
    expect(side.queryByText('Cardápio de Natal')).toBeNull();
    expect(side.getByText('—', { selector: 'dd' })).toBeTruthy();
    expect(side.queryByRole('textbox', { name: /Texto alternativo/ })).toBeNull();
    expect(rowOf('cardapio-natal-2026.pdf').getAttribute('aria-selected')).toBe('true');
    expect(rowOf('padaria-fachada-natal.jpg').getAttribute('aria-selected')).toBe('false');
  });

  it('says where the file is not used, and that the usage could not be read', async () => {
    const world = boardWorld({ override: (_method, path) => (path.includes(`/media/${CARDAPIO}/usage`) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(nameButton('logo-padaria-central.svg'));
    expect(await panel().findByText('Este arquivo ainda não foi usado em um conteúdo.')).toBeTruthy();
    fireEvent.click(nameButton('cardapio-natal-2026.pdf'));
    expect((await panel().findByText('Não foi possível ver onde este arquivo é usado.', undefined, { timeout: 5000 })).getAttribute('role')).toBe('alert');
  }, 15_000);

  it('opens "Usar em um conteúdo" on the new content of the client with the chosen file, keeping the state of the roster, only for a photo or a video', async () => {
    const state = { clientListUrl: '/agencia/x/clientes?page=2' };
    renderFolders(makeFetch(boardWorld()), { pathname: foldersUrl().split('?')[0]!, search: '', state });
    await table('Enviados recentemente');

    fireEvent.click(nameButton('forno-novo-reels.mp4'));
    const link = panel().getByRole('link', { name: 'Usar em um conteúdo' });
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}/novo?midia=${FORNO}`);
    fireEvent.click(nameButton('cardapio-natal-2026.pdf'));
    expect(panel().queryByRole('link', { name: 'Usar em um conteúdo' })).toBeNull();
    fireEvent.click(nameButton('padaria-fachada-natal.jpg'));
    expect(panel().getByRole('link', { name: 'Usar em um conteúdo' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}/novo?midia=${FACHADA}`);
  });

  it('downloads the file of the panel in a new tab, and of no other', async () => {
    const opened: Array<{ href: string; target: string; rel: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push({ href: this.href, target: this.target, rel: this.rel });
    });
    const world = boardWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'cardapio-natal-2026.pdf' }));
    fireEvent.click(panel().getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened).toEqual([{ href: `https://storage.test/${CARDAPIO}/original`, target: '_blank', rel: 'noopener noreferrer' }]);
    expect(world.calls.filter((call) => /variant=original/.test(call))).toEqual([`GET /agencies/${AGENCY_A}/media/${CARDAPIO}/download-url?variant=original`]);
  });

  it('deletes the file of the panel after the confirmation, closes the panel and shows no other file gone', async () => {
    const world = boardWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'cardapio-natal-2026.pdf' }));
    fireEvent.click(panel().getByRole('button', { name: 'Excluir' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Excluir arquivo?' }));
    expect(dialog.getByText('Excluir "cardapio-natal-2026.pdf"? Ele deixa a biblioteca e não poderá mais ser baixado.')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'cardapio-natal-2026.pdf' })).toBeNull());
    expect(document.querySelector('aside.media-detail')).toBeNull();
    expect(world.assets.map((asset) => asset.removed)).toEqual([undefined, true, undefined, undefined]);
    expect(screen.getByRole('button', { name: 'padaria-fachada-natal.jpg' })).toBeTruthy();
  });

  describe('the alternative text', () => {
    it('saves what was typed with its own button, and sends only the text', async () => {
      const world = boardWorld();
      open(world);

      fireEvent.click(await screen.findByRole('button', { name: 'padaria-fachada-natal.jpg' }));
      expect(panel().queryByRole('button', { name: 'Salvar texto alternativo' })).toBeNull();
      fireEvent.change(panel().getByRole('textbox', { name: /Texto alternativo/ }), { target: { value: '  Fachada da padaria à noite.  ' } });
      fireEvent.click(panel().getByRole('button', { name: 'Salvar texto alternativo' }));

      await waitFor(() => expect(world.assets[0]?.altText).toBe('Fachada da padaria à noite.'));
      expect(writes(world)).toEqual([{ method: 'PATCH', path: `/media/${FACHADA}`, body: { altText: 'Fachada da padaria à noite.' } }]);
      await waitFor(() => expect(panel().queryByRole('button', { name: 'Salvar texto alternativo' })).toBeNull());
      expect((panel().getByRole('textbox', { name: /Texto alternativo/ }) as HTMLTextAreaElement).value).toBe('Fachada da padaria à noite.');
    });

    it('keeps what was typed when the API refuses, and says so', async () => {
      const world = boardWorld({ override: (method, path) => (method === 'PATCH' && path.endsWith(`/media/${FACHADA}`) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
      open(world);

      fireEvent.click(await screen.findByRole('button', { name: 'padaria-fachada-natal.jpg' }));
      fireEvent.change(panel().getByRole('textbox', { name: /Texto alternativo/ }), { target: { value: 'Outro texto' } });
      fireEvent.click(panel().getByRole('button', { name: 'Salvar texto alternativo' }));

      expect((await panel().findByText('Não foi possível salvar o texto alternativo. Tente de novo.', undefined, { timeout: 5000 })).textContent).toBeTruthy();
      expect((panel().getByRole('textbox', { name: /Texto alternativo/ }) as HTMLTextAreaElement).value).toBe('Outro texto');
    }, 15_000);

    it('cannot be edited by whoever only reads', async () => {
      open(boardWorld({ permissions: ['conteudo.visualizar', 'cliente.visualizar'] }));

      fireEvent.click(await screen.findByRole('button', { name: 'padaria-fachada-natal.jpg' }));
      const field = panel().getByRole('textbox', { name: /Texto alternativo/ }) as HTMLTextAreaElement;
      expect(field.readOnly).toBe(true);
      fireEvent.change(field, { target: { value: 'x' } });
      expect(panel().queryByRole('button', { name: 'Salvar texto alternativo' })).toBeNull();
      expect(panel().queryByRole('button', { name: 'Excluir' })).toBeNull();
      expect(panel().queryByRole('link', { name: 'Usar em um conteúdo' })).toBeNull();
      expect(panel().getByRole('button', { name: 'Baixar' })).toBeTruthy();
    });
  });
});

describe('the menu of a row acts on that row', () => {
  it('opens the panel of the row whose "Abrir" was chosen', async () => {
    open(boardWorld());
    await table('Enviados recentemente');

    fireEvent.click(openMenu('cardapio-natal-2026.pdf').getByRole('menuitem', { name: 'Abrir' }));
    expect(panel().getByRole('heading', { name: 'cardapio-natal-2026.pdf' })).toBeTruthy();
  });

  it('downloads the row it belongs to, and says in the page when the download could not be prepared', async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { opened.push(this.href); });
    const world = boardWorld({ override: (_method, path, search) => (path.endsWith(`/media/${FORNO}/download-url`) && search.includes('original') ? apiError(404, 'NOT_FOUND', 'Media asset not found.') : undefined) });
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('padaria-fachada-natal.jpg').getByRole('menuitem', { name: 'Baixar' }));
    await waitFor(() => expect(opened).toEqual([`https://storage.test/${FACHADA}/original`]));

    fireEvent.click(openMenu('forno-novo-reels.mp4').getByRole('menuitem', { name: 'Baixar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível preparar o download. Tente de novo.');
    expect(opened).toHaveLength(1);
  });

  it('renames the row it belongs to: the dialog starts with its name, closes on success and the new name shows in the table', async () => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('cardapio-natal-2026.pdf').getByRole('menuitem', { name: 'Renomear' }));
    const field = screen.getByRole('textbox', { name: 'Nome do arquivo' }) as HTMLInputElement;
    expect(field.value).toBe('cardapio-natal-2026.pdf');
    fireEvent.change(field, { target: { value: '  cardapio-final.pdf ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));

    expect(await screen.findByRole('button', { name: 'cardapio-final.pdf' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(world)).toEqual([{ method: 'PATCH', path: `/media/${CARDAPIO}`, body: { name: 'cardapio-final.pdf' } }]);
    expect(world.assets.map((asset) => asset.name)).toEqual(['padaria-fachada-natal.jpg', 'cardapio-final.pdf', 'forno-novo-reels.mp4', 'logo-padaria-central.svg']);
  });

  it.each([
    ['empty', '   ', 'Informe o nome do arquivo.'],
    ['with a slash', 'pasta/arquivo.pdf', 'Use um nome de até 255 caracteres, sem barras nem caracteres invisíveis.']
  ])('refuses a file name that is %s before any request', async (_case, typed, message) => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('cardapio-natal-2026.pdf').getByRole('menuitem', { name: 'Renomear' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do arquivo' }), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(world.bodies).toEqual([]);
  });

  it('keeps the rename dialog and what was typed when the API refuses, and the next try closes it', async () => {
    let refused = true;
    const world = boardWorld({ override: (method, path) => (refused && method === 'PATCH' && path.endsWith(`/media/${CARDAPIO}`) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('cardapio-natal-2026.pdf').getByRole('menuitem', { name: 'Renomear' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do arquivo' }), { target: { value: 'novo.pdf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));

    expect((await screen.findByRole('alert', undefined, { timeout: 5000 })).textContent).toBe('Não foi possível renomear o arquivo. Tente de novo.');
    expect((screen.getByRole('textbox', { name: 'Nome do arquivo' }) as HTMLInputElement).value).toBe('novo.pdf');
    refused = false;
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));
    expect(await screen.findByRole('button', { name: 'novo.pdf' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 15_000);

  it('moves the row it belongs to to the folder chosen, and refuses to "move" it to where it already is', async () => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('forno-novo-reels.mp4').getByRole('menuitem', { name: 'Mover para' }));
    const select = screen.getByRole('combobox', { name: 'Pasta de destino' }) as HTMLSelectElement;
    expect(select.value).toBe(VIDEOS);
    expect(Array.from(select.options).map((option) => option.textContent)).toContain('Vídeos / Gravação de outubro');
    fireEvent.click(screen.getByRole('button', { name: 'Mover arquivo' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Escolha outra pasta.');
    expect(world.bodies).toEqual([]);

    fireEvent.change(select, { target: { value: CAMPANHA } });
    fireEvent.click(screen.getByRole('button', { name: 'Mover arquivo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(world)).toEqual([{ method: 'POST', path: `/media/${FORNO}/move`, body: { folderId: CAMPANHA } }]);
    expect(world.assets.map((asset) => asset.folderId)).toEqual([CAMPANHA, CAMPANHA, CAMPANHA, IMAGES]);
  });

  it('keeps the move dialog with the words of the API when the file is in use', async () => {
    const world = boardWorld();
    world.assets[1] = { ...world.assets[1]!, inUse: true };
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('cardapio-natal-2026.pdf').getByRole('menuitem', { name: 'Mover para' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Pasta de destino' }), { target: { value: IMAGES } });
    fireEvent.click(screen.getByRole('button', { name: 'Mover arquivo' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Esta mídia está em um conteúdo e não pode ser movida para outra pasta.');
    expect(screen.getByRole('dialog', { name: 'Mover para' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Pasta de destino' }) as HTMLSelectElement).value).toBe(IMAGES);
    expect(world.assets[1]?.folderId).toBe(CAMPANHA);
  });

  it('deletes the row it belongs to after the confirmation, and refuses the one in use with the reason of the API, each on its own', async () => {
    const world = boardWorld();
    world.assets[0] = { ...world.assets[0]!, inUse: true };
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('padaria-fachada-natal.jpg').getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Excluir arquivo?' })).getByRole('button', { name: 'Excluir' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.');
    expect(world.assets.map((asset) => asset.removed)).toEqual([undefined, undefined, undefined, undefined]);
    expect(screen.getByRole('button', { name: 'padaria-fachada-natal.jpg' })).toBeTruthy();

    fireEvent.click(openMenu('forno-novo-reels.mp4').getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Excluir arquivo?' })).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'forno-novo-reels.mp4' })).toBeNull());
    expect(world.assets.map((asset) => asset.removed)).toEqual([undefined, undefined, true, undefined]);
    expect(world.calls.filter((call) => /\/remove$/.test(call)).map((call) => call.split('/').slice(-2)[0])).toEqual([FACHADA, FORNO]);
  });

  it('removes nothing when the confirmation is cancelled', async () => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    fireEvent.click(openMenu('forno-novo-reels.mp4').getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Excluir arquivo?' })).getByRole('button', { name: 'Cancelar' }));

    expect(world.calls.filter((call) => /\/remove$/.test(call))).toEqual([]);
    expect(screen.getByRole('button', { name: 'forno-novo-reels.mp4' })).toBeTruthy();
  });
});

describe('the menu of a folder acts on that folder', () => {
  it('renames only a folder of its own: a default one has just "Abrir"', async () => {
    const world = boardWorld();
    open(world);

    await screen.findByRole('heading', { name: 'Pastas' });
    fireEvent.click(screen.getByRole('button', { name: 'Ações da pasta Vídeos' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Abrir']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Ações da pasta Campanha de Natal' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Abrir', 'Renomear', 'Excluir']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Renomear' }));
    const field = screen.getByRole('textbox', { name: 'Nome da pasta' }) as HTMLInputElement;
    expect(field.value).toBe('Campanha de Natal');
    fireEvent.change(field, { target: { value: 'Natal 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));

    expect(await screen.findByRole('link', { name: /^Natal 2026/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(world)).toEqual([{ method: 'PATCH', path: `/media-folders/${CAMPANHA}`, body: { name: 'Natal 2026' } }]);
  });

  it('keeps the dialog and the typed name when the rename is refused', async () => {
    const world = boardWorld({ override: (method, path) => (method === 'PATCH' && path.endsWith(`/media-folders/${CAMPANHA}`) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Ações da pasta Campanha de Natal' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Renomear' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da pasta' }), { target: { value: 'Natal 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar nome' }));

    expect((await screen.findByRole('alert', undefined, { timeout: 5000 })).textContent).toBe('Não foi possível renomear a pasta. Tente de novo.');
    expect((screen.getByRole('textbox', { name: 'Nome da pasta' }) as HTMLInputElement).value).toBe('Natal 2026');
  }, 15_000);

  it('deletes an empty folder after the confirmation, and says why when the folder still holds files', async () => {
    const world = boardWorld();
    world.folders.push({ ...world.folders[4]!, id: idOf('f', 30), name: 'Brindes' });
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver todas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ações da pasta Campanha de Natal' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Excluir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir pasta?' });
    expect(within(dialog).getByText('Excluir a pasta "Campanha de Natal"? Só uma pasta vazia pode ser excluída.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Esta pasta tem arquivos. Mova ou exclua os arquivos antes.');
    expect(world.folders.some((folder) => folder.id === CAMPANHA)).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Ações da pasta Brindes' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Excluir pasta?' })).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Brindes/ })).toBeNull());
    expect(world.calls.filter((call) => call.startsWith('DELETE'))).toEqual([`DELETE ${base}/media-folders/${CAMPANHA}`, `DELETE ${base}/media-folders/${idOf('f', 30)}`]);
  });

  it('leaves the open folder when it is deleted, and goes back to the folders', async () => {
    const world = makeWorld();
    const { probe } = open(world, `&pasta=${CAMPANHA}`);

    await screen.findByRole('heading', { name: 'Campanha de Natal' });
    fireEvent.click(screen.getByRole('button', { name: 'Ações da pasta Campanha de Natal' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Excluir pasta?' })).getByRole('button', { name: 'Excluir' }));

    expect(await screen.findByRole('heading', { name: 'Pastas' })).toBeTruthy();
    expect(probe.search).toBe('');
  });
});

describe('the search of the library', () => {
  it('asks the API for the text typed, in the address, shows the matching files and clears with "Limpar busca"', async () => {
    const world = boardWorld();
    const { probe } = open(world);
    await table('Enviados recentemente');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar nesta biblioteca' }), { target: { value: 'Cardápio' } });

    expect(await screen.findByRole('heading', { name: 'Resultados da busca' })).toBeTruthy();
    expect(new URLSearchParams(probe.search).get('busca')).toBe('Cardápio');
    const results = await table('Resultados da busca');
    expect(results.getAllByRole('row').slice(1)).toHaveLength(1);
    expect(results.getByRole('button', { name: 'cardapio-natal-2026.pdf' })).toBeTruthy();
    expect(world.calls.some((call) => call.includes('/media?page=1&pageSize=20&q=Card%C3%A1pio'))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Acesso rápido' })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar nesta biblioteca' }), { target: { value: 'zzz' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Limpar busca' }));
    expect(await screen.findByRole('heading', { name: 'Enviados recentemente' })).toBeTruthy();
    expect((screen.getByRole('searchbox', { name: 'Buscar nesta biblioteca' }) as HTMLInputElement).value).toBe('');
    expect(probe.search).toBe('');
  });

  it('says no file matched, with the text searched', async () => {
    open(boardWorld(), '&busca=nada');

    expect(await screen.findByText('Nenhum arquivo encontrado para “nada”.')).toBeTruthy();
    expect((screen.getByRole('searchbox', { name: 'Buscar nesta biblioteca' }) as HTMLInputElement).value).toBe('nada');
  });
});

describe('a logo in SVG is an image or a download, never the page', () => {
  it('draws the thumbnail of an SVG logo as an img whose source is the signed address, with no svg, object, iframe or embed from the file', async () => {
    const { container } = open(boardWorld());
    await table('Enviados recentemente');

    await waitFor(() => expect(container.querySelector(`img[src="https://storage.test/${LOGO}/thumbnail"]`)).not.toBeNull());
    fireEvent.click(nameButton('logo-padaria-central.svg'));
    await waitFor(() => expect(container.querySelectorAll(`img[src="https://storage.test/${LOGO}/thumbnail"]`).length).toBeGreaterThanOrEqual(2));

    expect(container.querySelector('object, iframe, embed, foreignObject')).toBeNull();
    expect(container.querySelector('[srcdoc], [data]')).toBeNull();
    const strangers = Array.from(container.querySelectorAll('svg')).filter((node) => !node.classList.contains('lucide'));
    expect(strangers).toEqual([]);
    for (const image of Array.from(main().querySelectorAll('.media-thumbnail img'))) expect(image.getAttribute('src')).toMatch(/^https:\/\/storage\.test\//);
  });

  it('downloads the SVG through the signed address, in a new tab, and never writes its content into the page', async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { opened.push(`${this.href} ${this.target}`); });
    const { container } = open(boardWorld());

    fireEvent.click(await screen.findByRole('button', { name: 'logo-padaria-central.svg' }));
    fireEvent.click(panel().getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(opened).toEqual([`https://storage.test/${LOGO}/original _blank`]));
    expect(container.querySelector('object, iframe, embed')).toBeNull();
  });

  it('never makes an address that is not http(s) the source of a thumbnail or the target of a download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const world = boardWorld({ override: (_method, path) => (path.endsWith('/download-url') ? json({ url: 'javascript:alert(1)', expiresAt: '2026-10-12T01:45:00.000Z' }) : undefined) });
    open(world);

    await table('Enviados recentemente');
    await waitFor(() => expect(world.calls.filter((call) => /variant=thumbnail/.test(call)).length).toBeGreaterThan(0));
    expect(main().querySelector('.media-thumbnail img')).toBeNull();
    fireEvent.click(nameButton('logo-padaria-central.svg'));
    fireEvent.click(panel().getByRole('button', { name: 'Baixar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível preparar o download. Tente de novo.');
    expect(click).not.toHaveBeenCalled();
  });

  it('asks no thumbnail for a PDF, which has none: the shape of its type stands in', async () => {
    const world = boardWorld();
    open(world);
    await table('Enviados recentemente');

    await waitFor(() => expect(world.calls.filter((call) => /variant=thumbnail/.test(call)).length).toBeGreaterThan(0));
    expect(world.calls.filter((call) => call.includes(`/media/${CARDAPIO}/download-url`))).toEqual([]);
    expect(rowOf('cardapio-natal-2026.pdf').querySelector('.media-thumbnail--pdf.media-thumbnail--placeholder')).not.toBeNull();
  });
});

describe('the library on a client with no file in a folder', () => {
  it('lists the files of an open folder only, with the table named "Arquivos" and no "Ver todos"', async () => {
    const world = boardWorld();
    open(world, `&pasta=${CAMPANHA}`);

    const files = await table('Arquivos');
    expect(files.getAllByRole('row').slice(1)).toHaveLength(2);
    expect(files.getByRole('button', { name: 'padaria-fachada-natal.jpg' })).toBeTruthy();
    expect(files.queryByRole('button', { name: 'forno-novo-reels.mp4' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ver todos' })).toBeNull();
  });
});
