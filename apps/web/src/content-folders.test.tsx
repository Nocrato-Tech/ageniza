// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiError, assetFixture, deferred, folderFixture, foldersUrl, idOf, json, makeFetch, makeWorld, padaria, renderFolders, type World
} from './content-folders-fixture.js';
import { sizeLabel } from './content-folders.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});

const VIDEOS = idOf('f', 1);
const IMAGES = idOf('f', 2);
const WORK = idOf('f', 6);
/** What the area needs to open (Conteúdos and the client's record), and nothing to write. */
const READ_ONLY = ['conteudo.visualizar', 'cliente.visualizar'];
const calendarUrl = `/agencia/11111111-1111-4111-8111-111111111111/conteudos/${padaria.id}`;

const open = (world: World, entry?: Parameters<typeof renderFolders>[1]) => renderFolders(makeFetch(world), entry);
const heading = (name: string) => screen.findByRole('heading', { name, level: 3 });
const mediaCalls = (world: World): string[] => world.calls.filter((call) => /\/assets(\?|$)/.test(call));

describe('the Pastas view: navigation and the address', () => {
  it('opens from the tab, lists the default and own folders of the first level and none of the calendar', async () => {
    const world = makeWorld();
    const { probe } = open(world, calendarUrl);

    fireEvent.click(await screen.findByRole('tab', { name: 'Pastas' }));
    await heading('Pastas');

    expect(probe.search).toBe('?vista=pastas');
    expect(screen.getByRole('tab', { name: 'Pastas' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Calendário' }).getAttribute('aria-selected')).toBe('false');
    for (const name of ['Vídeos Padrão', 'Imagens Padrão', 'Carrosséis Padrão', 'Ensaio fotográfico Padrão', 'Campanha de Natal']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('link', { name: 'Gravação de outubro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hoje' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Escala do calendário' })).toBeNull();
  });

  it('opens a first-level folder: it is in the address, with its work folders and media', async () => {
    const world = makeWorld({ assets: [assetFixture(1, VIDEOS)] });
    const { probe } = open(world);

    fireEvent.click(await screen.findByRole('link', { name: 'Vídeos Padrão' }));
    await heading('Vídeos');

    expect(new URLSearchParams(probe.search).get('pasta')).toBe(VIDEOS);
    expect(new URLSearchParams(probe.search).get('vista')).toBe('pastas');
    expect(screen.getByRole('heading', { name: 'Pastas de trabalho', level: 4 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gravação de outubro' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nova pasta de trabalho' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nova pasta' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Caminho da pasta' })).getByRole('link', { name: 'Pastas' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
    expect(mediaCalls(world)).toEqual([`GET /agencies/11111111-1111-4111-8111-111111111111/clients/${padaria.id}/media-folders/${VIDEOS}/assets?page=1&pageSize=48`]);
  });

  it('opens a work folder and stops there: no third level is offered, and the way back is in the address', async () => {
    const world = makeWorld({ assets: [assetFixture(1, WORK)] });
    const { probe } = open(world, foldersUrl(`&pasta=${VIDEOS}&pagina=2`));

    fireEvent.click(await screen.findByRole('link', { name: 'Gravação de outubro' }));
    await heading('Gravação de outubro');

    const params = new URLSearchParams(probe.search);
    expect(params.get('pasta')).toBe(VIDEOS);
    expect(params.get('subpasta')).toBe(WORK);
    expect(params.has('pagina')).toBe(false);
    expect(screen.queryByRole('button', { name: /nova pasta/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Pastas de trabalho' })).toBeNull();
    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();

    const path = within(screen.getByRole('navigation', { name: 'Caminho da pasta' }));
    expect(path.getByText('Gravação de outubro').getAttribute('aria-current')).toBe('page');
    fireEvent.click(path.getByRole('link', { name: 'Vídeos' }));
    await screen.findByRole('heading', { name: 'Pastas de trabalho' });
    expect(new URLSearchParams(probe.search).has('subpasta')).toBe(false);
    expect(new URLSearchParams(probe.search).get('pasta')).toBe(VIDEOS);

    fireEvent.click(screen.getByRole('link', { name: 'Pastas' }));
    await screen.findByRole('link', { name: 'Imagens Padrão' });
    expect(probe.search).toBe('?vista=pastas');
  });

  it('lands on the same folder after a reload, with no click', async () => {
    const world = makeWorld({ assets: [assetFixture(1, WORK)] });
    open(world, foldersUrl(`&pasta=${VIDEOS}&subpasta=${WORK}`));

    await heading('Gravação de outubro');
    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
    expect(mediaCalls(world)).toEqual([expect.stringContaining(`/media-folders/${WORK}/assets?`)]);
  });

  it.each([
    ['a folder that is not an id', 'pasta=nao-e-um-id'],
    ['a folder of another client', `pasta=${idOf('9', 1)}`],
    ['a work folder where a first-level one belongs', `pasta=${WORK}`],
    ['a work folder with no first-level folder', `subpasta=${WORK}`],
    ['a first-level folder where a work folder belongs', `pasta=${VIDEOS}&subpasta=${IMAGES}`],
    ['a work folder of another first-level folder', `pasta=${IMAGES}&subpasta=${WORK}`]
  ])('says the folder was not found for %s, and asks for no media', async (_case, search) => {
    const world = makeWorld();
    const { probe } = open(world, foldersUrl(`&${search}`));

    expect(await screen.findByText('Pasta não encontrada.')).toBeTruthy();
    expect(mediaCalls(world)).toEqual([]);
    fireEvent.click(screen.getByRole('link', { name: 'Voltar às pastas' }));
    await screen.findByRole('link', { name: 'Imagens Padrão' });
    expect(probe.search).toBe('?vista=pastas');
  });

  it('carries the navigation state of the roster on every link of the view', async () => {
    const state = { clientListUrl: '/agencia/x/clientes?page=2' };
    const { probe } = open(makeWorld(), { pathname: `/agencia/11111111-1111-4111-8111-111111111111/conteudos/${padaria.id}`, search: '?vista=pastas', state });

    fireEvent.click(await screen.findByRole('link', { name: 'Vídeos Padrão' }));
    await heading('Vídeos');
    expect(probe.state).toEqual(state);
    fireEvent.click(screen.getByRole('link', { name: 'Gravação de outubro' }));
    await heading('Gravação de outubro');
    expect(probe.state).toEqual(state);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Caminho da pasta' })).getByRole('link', { name: 'Vídeos' }));
    await screen.findByRole('heading', { name: 'Pastas de trabalho' });
    expect(probe.state).toEqual(state);
    fireEvent.click(screen.getByRole('link', { name: 'Pastas' }));
    await screen.findByRole('link', { name: 'Imagens Padrão' });
    expect(probe.state).toEqual(state);
  });

  it('carries the navigation state through "Voltar às pastas" as well', async () => {
    const state = { clientListUrl: '/agencia/x/clientes?page=2' };
    const { probe } = open(makeWorld(), { pathname: calendarUrl, search: `?vista=pastas&pasta=${idOf('9', 1)}`, state });

    fireEvent.click(await screen.findByRole('link', { name: 'Voltar às pastas' }));
    await screen.findByRole('link', { name: 'Imagens Padrão' });
    expect(probe.state).toEqual(state);
  });

  it('leaves the folder out of the address when the person goes back to the calendar', async () => {
    const { probe } = open(makeWorld(), foldersUrl(`&pasta=${VIDEOS}&subpasta=${WORK}&pagina=2`));
    await heading('Gravação de outubro');

    fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
    await screen.findByRole('group', { name: 'Período' });
    expect(probe.search).toBe('');
  });
});

describe('the Pastas view: the calendar behind it', () => {
  it('does not show a calendar error over the folders when the person comes back to them', async () => {
    const world = makeWorld({
      override: (_method, path) => (/\/contents$/.test(path) ? apiError(400, 'VALIDATION_ERROR', 'Request validation failed') : undefined)
    });
    const { probe } = open(world, foldersUrl(`&pasta=${VIDEOS}`));
    await heading('Vídeos');

    fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
    expect(await screen.findByText('Não foi possível carregar os conteúdos. Tente de novo.')).toBeTruthy();
    act(() => { probe.navigate(foldersUrl(`&pasta=${VIDEOS}`)); });

    await heading('Vídeos');
    expect(screen.queryByText('Não foi possível carregar os conteúdos. Tente de novo.')).toBeNull();
    expect(screen.queryByText('Página não encontrada')).toBeNull();
  });

  it('does not ask the calendar at all when it opens on the folders', async () => {
    const world = makeWorld();
    open(world, foldersUrl());

    await heading('Pastas');
    expect(world.calls.filter((call) => /\/contents\?/.test(call))).toEqual([]);
  });

  it('keeps the read-only note of the calendar off the folders of an archived client', async () => {
    open(makeWorld({ clientStatus: 'archived' }), foldersUrl());
    await heading('Pastas');
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByText('Cliente arquivado: o calendário é só leitura.')).toBeNull();
  });

  it('does not turn the not-found of the calendar into the not-found of the folders', async () => {
    const world = makeWorld({
      override: (_method, path) => (/\/contents$/.test(path) ? apiError(404, 'NOT_FOUND', 'Client not found.') : undefined)
    });
    const { probe } = open(world, foldersUrl(`&pasta=${VIDEOS}`));
    await heading('Vídeos');

    fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    act(() => { probe.navigate(foldersUrl(`&pasta=${VIDEOS}`)); });

    await heading('Vídeos');
    expect(screen.queryByRole('heading', { name: 'Página não encontrada' })).toBeNull();
  });
});

describe('the Pastas view: states', () => {
  it('shows a skeleton while the folders load, then the folders', async () => {
    const held = deferred<void>();
    const { container } = open(makeWorld({ foldersGate: held.promise }));

    await waitFor(() => expect(container.querySelector('.content-folders__skeleton')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: 'Pastas', level: 3 })).toBeNull();

    held.resolve();
    await heading('Pastas');
    expect(container.querySelector('.content-folders__skeleton')).toBeNull();
  });

  it('shows the error with "Tentar de novo", and the retry brings the folders back', async () => {
    let attempts = 0;
    const world = makeWorld({
      override: (method, path) => {
        if (method !== 'GET' || !path.endsWith('/media-folders')) return undefined;
        attempts += 1;
        return attempts <= 2 ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined;
      }
    });
    open(world);

    expect(await screen.findByText('Não foi possível carregar as pastas. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Imagens Padrão' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('link', { name: 'Imagens Padrão' })).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar as pastas. Tente de novo.')).toBeNull();
  }, 15_000);

  it('says there are no folders, and invites only whoever can create one', async () => {
    open(makeWorld({ folders: [] }));
    expect(await screen.findByText('Nenhuma pasta ainda. Crie a primeira.')).toBeTruthy();
    cleanup();

    open(makeWorld({ folders: [], permissions: READ_ONLY }));
    expect(await screen.findByText('Nenhuma pasta ainda.')).toBeTruthy();
    expect(screen.queryByText('Nenhuma pasta ainda. Crie a primeira.')).toBeNull();
  });

  it('says a first-level folder has no work folder and no media', async () => {
    open(makeWorld({ folders: [folderFixture(1, 'Vídeos', { isDefault: true })] }), foldersUrl(`&pasta=${VIDEOS}`));

    expect(await screen.findByText('Nenhuma pasta de trabalho nesta pasta.')).toBeTruthy();
    expect(await screen.findByText('Nenhuma mídia nesta pasta ainda.')).toBeTruthy();
  });

  it('shows the media error with "Tentar de novo", and the retry brings the media back', async () => {
    let attempts = 0;
    const world = makeWorld({
      assets: [assetFixture(1, VIDEOS)],
      override: (method, path) => {
        if (method !== 'GET' || !path.endsWith('/assets')) return undefined;
        attempts += 1;
        return attempts <= 2 ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined;
      }
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    expect(await screen.findByText('Não foi possível carregar as mídias. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
  }, 15_000);

  it('shows a skeleton while the media load', async () => {
    const held = deferred<void>();
    const { container } = open(makeWorld({ assetsGate: () => held.promise }), foldersUrl(`&pasta=${VIDEOS}`));

    await heading('Vídeos');
    await waitFor(() => expect(container.querySelector('.folder-media__skeleton')).not.toBeNull());
    expect(screen.queryByText('Nenhuma mídia nesta pasta ainda.')).toBeNull();
    held.resolve();
    await screen.findByText('Nenhuma mídia nesta pasta ainda.');
    expect(container.querySelector('.folder-media__skeleton')).toBeNull();
  });

  it('reads every page of the folders, so none is hidden behind the first', async () => {
    const own = Array.from({ length: 101 }, (_value, index) => folderFixture(200 + index, `Pasta ${String(index + 1).padStart(3, '0')}`));
    const world = makeWorld({ folders: own });
    open(world);

    expect(await screen.findByRole('link', { name: 'Pasta 101' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pasta 001' })).toBeTruthy();
    expect(world.calls.filter((call) => /\/media-folders\?/.test(call)).map((call) => call.split('?')[1])).toEqual(['page=1&pageSize=100', 'page=2&pageSize=100']);
    expect(screen.queryByText(/Mostrando/)).toBeNull();
  });

  it('says how many folders it shows when there are more than it reads', async () => {
    const own = Array.from({ length: 1001 }, (_value, index) => folderFixture(200 + index, `Pasta ${String(index + 1).padStart(4, '0')}`));
    open(makeWorld({ folders: own }));

    expect(await screen.findByText('Mostrando 1000 de 1001 pastas.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Pasta 1001' })).toBeNull();
  });
});

describe('the Pastas view: who writes', () => {
  it('lets whoever can only read navigate and see, and offers no write', async () => {
    const world = makeWorld({ permissions: READ_ONLY, assets: [assetFixture(1, VIDEOS)] });
    open(world);

    expect(await screen.findByRole('link', { name: 'Vídeos Padrão' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /nova pasta/i })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Vídeos Padrão' }));
    await heading('Vídeos');
    expect(screen.getByRole('link', { name: 'Gravação de outubro' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /nova pasta/i })).toBeNull();
    expect(await screen.findByRole('button', { name: /^Baixar Imagem/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
  });

  it('offers the writes to whoever has conteudo.operar', async () => {
    open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), foldersUrl(`&pasta=${VIDEOS}`));

    expect(await screen.findByRole('button', { name: 'Nova pasta de trabalho' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Remover Imagem/ })).toBeTruthy();
  });

  it('offers no write on an archived client, and none while the client is still unknown', async () => {
    const held = deferred<void>();
    const world = makeWorld({ clientStatus: 'archived', clientGate: held.promise, assets: [assetFixture(1, VIDEOS)] });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /nova pasta/i })).toBeNull();
    held.resolve();
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /nova pasta/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Baixar Imagem/ })).toBeTruthy();
  });
});

describe('sizeLabel', () => {
  it.each([
    [0, '0 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1,5 KB'],
    [1024 ** 2 - 1024, '1.023 KB'], [1024 ** 2, '1 MB'], [2_411_724, '2,3 MB'],
    [1024 ** 3 - 1024 ** 2, '1.023 MB'], [1024 ** 3, '1 GB'], [3 * 1024 ** 3, '3 GB']
  ])('writes %i bytes as %s', (bytes, expected) => {
    expect(sizeLabel(bytes)).toBe(expected);
  });
});

describe('creating a folder', () => {
  const nameField = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox', { name: 'Nome da pasta' });

  it('creates an own folder in the first level, closes on success and shows it', async () => {
    const world = makeWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta' }));
    expect(screen.getByRole('dialog', { name: 'Nova pasta' })).toBeTruthy();
    fireEvent.change(nameField(), { target: { value: '  Brindes  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));

    expect(await screen.findByRole('link', { name: 'Brindes' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(world.bodies).toEqual([{ method: 'POST', path: `/agencies/11111111-1111-4111-8111-111111111111/clients/${padaria.id}/media-folders`, body: { name: 'Brindes' } }]);
  });

  it('creates a work folder inside the open folder, and only there', async () => {
    const world = makeWorld();
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta de trabalho' }));
    expect(screen.getByRole('dialog', { name: 'Nova pasta de trabalho' })).toBeTruthy();
    fireEvent.change(nameField(), { target: { value: 'Take 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));

    expect(await screen.findByRole('link', { name: 'Take 2' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(world.bodies.map((entry) => entry.body)).toEqual([{ name: 'Take 2', parentId: VIDEOS }]);
    expect(world.folders.find((folder) => folder.name === 'Take 2')?.parentId).toBe(VIDEOS);
  });

  it.each([
    ['empty', '   ', 'Informe o nome da pasta.'],
    ['longer than 80', 'a'.repeat(81), 'O nome pode ter até 80 caracteres.'],
    ['with an invisible character', 'Bri​ndes', 'Use um nome sem caracteres invisíveis ou de controle.']
  ])('refuses a name that is %s before any request', async (_case, typed, message) => {
    const world = makeWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta' }));
    fireEvent.change(nameField(), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(world.bodies).toEqual([]);
  });

  it('accepts a name of exactly 80 characters', async () => {
    const world = makeWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta' }));
    fireEvent.change(nameField(), { target: { value: 'b'.repeat(80) } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(world.bodies.map((entry) => entry.body)).toEqual([{ name: 'b'.repeat(80) }]);
  });

  it.each([
    ['a failure', () => apiError(500, 'INTERNAL_ERROR', 'boom'), 'Não foi possível criar a pasta. Tente de novo.'],
    ['a refused name', () => apiError(400, 'VALIDATION_ERROR', 'Request validation failed'), 'Use um nome sem caracteres invisíveis ou de controle.'],
    ['a refused permission', () => apiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'), 'Você não tem permissão para fazer isso.'],
    ['an archived client', () => apiError(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.'), 'Cliente arquivado não pode ser editado.']
  ])('keeps the dialog and what was typed on %s, and the next try closes it', async (_case, refusal, message) => {
    let refused = true;
    const world = makeWorld({ override: (method, path) => (refused && method === 'POST' && path.endsWith('/media-folders') ? refusal() : undefined) });
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta' }));
    fireEvent.change(nameField(), { target: { value: 'Brindes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('dialog', { name: 'Nova pasta' })).toBeTruthy();
    expect(nameField().value).toBe('Brindes');
    expect(screen.queryByRole('link', { name: 'Brindes' })).toBeNull();

    refused = false;
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }));
    expect(await screen.findByRole('link', { name: 'Brindes' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes without a request on "Fechar nova pasta"', async () => {
    const world = makeWorld();
    open(world);

    fireEvent.click(await screen.findByRole('button', { name: 'Nova pasta' }));
    fireEvent.change(nameField(), { target: { value: 'Brindes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar nova pasta' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(world.bodies).toEqual([]);
  });
});

describe('the media of a folder', () => {
  const OCT_11 = '2026-10-12T01:30:00.000Z';

  it('shows each media with its kind, its day in São Paulo and its size, the latest first', async () => {
    const world = makeWorld({
      assets: [
        assetFixture(1, VIDEOS, { createdAt: '2026-10-10T15:00:00.000Z', sizeBytes: 900 }),
        assetFixture(2, VIDEOS, { createdAt: OCT_11, sizeBytes: 2_411_724 }),
        assetFixture(3, VIDEOS, { createdAt: '2026-10-11T15:00:00.000Z', sizeBytes: 1536, category: 'video', contentType: 'video/mp4', videoProcessingStatus: 'processing' }),
        assetFixture(4, VIDEOS, { createdAt: '2026-10-09T15:00:00.000Z', sizeBytes: 3 * 1024 ** 3, category: 'video', contentType: 'video/mp4', videoProcessingStatus: 'failed' })
      ]
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    const list = await screen.findByRole('list', { name: 'Mídias da pasta' });
    const tiles = within(list).getAllByRole('listitem');
    expect(tiles.map((tile) => tile.querySelector('.folder-media__title')?.textContent)).toEqual(['Imagem', 'Vídeo', 'Imagem', 'Vídeo']);
    expect(tiles.map((tile) => tile.querySelector('.folder-media__meta')?.textContent)).toEqual([
      '11/10/2026 · 2,3 MB', '11/10/2026 · 1,5 KB', '10/10/2026 · 900 B', '09/10/2026 · 3 GB'
    ]);
    expect(within(tiles[1]!).getByText('Processando vídeo')).toBeTruthy();
    expect(within(tiles[3]!).getByText('Falha no processamento do vídeo')).toBeTruthy();
    expect(screen.getAllByText(/Processando vídeo|Falha no processamento/)).toHaveLength(2);
  });

  it('draws the thumbnail from the thumbnail variant, and the shape of the kind while a video has none', async () => {
    const world = makeWorld({
      assets: [
        assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z' }),
        assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z', category: 'video', contentType: 'video/mp4', videoProcessingStatus: 'processing' })
      ]
    });
    const { container } = open(world, foldersUrl(`&pasta=${VIDEOS}`));

    await waitFor(() => expect(container.querySelectorAll('.media-thumbnail img')).toHaveLength(1));
    expect(container.querySelector('.media-thumbnail img')?.getAttribute('src')).toBe(`https://storage.test/${idOf('a', 1)}/thumbnail`);
    expect(container.querySelectorAll('.media-thumbnail--placeholder')).toHaveLength(1);
    const downloads = world.calls.filter((call) => /download-url/.test(call));
    expect(downloads.sort()).toEqual([
      `GET /agencies/11111111-1111-4111-8111-111111111111/media/${idOf('a', 1)}/download-url?variant=thumbnail`,
      `GET /agencies/11111111-1111-4111-8111-111111111111/media/${idOf('a', 2)}/download-url?variant=thumbnail`
    ]);
  });

  it('asks for a thumbnail only once its tile was on screen', async () => {
    const watched: Array<(visible: boolean) => void> = [];
    class FakeObserver {
      public constructor(private readonly callback: IntersectionObserverCallback) {}
      public observe(element: Element): void {
        watched.push((visible) => { this.callback([{ isIntersecting: visible, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver); });
      }
      public disconnect(): void { /* nothing is held */ }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const world = makeWorld({ assets: [assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z' }), assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z' })] });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    await waitFor(() => expect(watched).toHaveLength(2));
    expect(world.calls.filter((call) => /download-url/.test(call))).toEqual([]);
    act(() => { watched[1]!(false); });
    expect(world.calls.filter((call) => /download-url/.test(call))).toEqual([]);
    act(() => { watched[1]!(true); });

    await waitFor(() => expect(world.calls.filter((call) => /download-url/.test(call))).toEqual([
      `GET /agencies/11111111-1111-4111-8111-111111111111/media/${idOf('a', 2)}/download-url?variant=thumbnail`
    ]));
  });

  it('never makes an address that is not http(s) the source of a thumbnail or the target of a download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const world = makeWorld({
      assets: [assetFixture(1, VIDEOS)],
      override: (_method, path) => (path.endsWith('/download-url') ? json({ url: 'ftp://storage.test/a.jpg', expiresAt: '2026-10-12T01:45:00.000Z' }) : undefined)
    });
    const { container } = open(world, foldersUrl(`&pasta=${VIDEOS}`));

    await waitFor(() => expect(world.calls.filter((call) => /variant=thumbnail/.test(call))).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /^Baixar/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível preparar o download. Tente de novo.');
    expect(click).not.toHaveBeenCalled();
    expect(container.querySelector('.media-thumbnail img')).toBeNull();
  });

  it('falls back to the shape of the kind when the browser cannot draw the thumbnail', async () => {
    const world = makeWorld({ assets: [assetFixture(1, VIDEOS)] });
    const { container } = open(world, foldersUrl(`&pasta=${VIDEOS}`));

    const image = await waitFor(() => {
      const found = container.querySelector('.media-thumbnail img');
      if (found === null) throw new Error('not yet');
      return found;
    });
    fireEvent.error(image);

    await waitFor(() => expect(container.querySelector('.media-thumbnail img')).toBeNull());
    expect(container.querySelectorAll('.media-thumbnail--placeholder')).toHaveLength(1);
  });

  it('downloads the original of the media whose button was pressed, in a new tab, and of no other', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push({ href: this.href, target: this.target, rel: this.rel });
    });
    const opened: Array<{ href: string; target: string; rel: string }> = [];
    const world = makeWorld({ assets: [assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z' }), assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z' })] });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    const second = await waitFor(() => {
      const tiles = screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'));
      if (tiles.length !== 2) throw new Error('not yet');
      return tiles[1]!;
    });
    fireEvent.click(within(second).getByRole('button', { name: /^Baixar Imagem de 10\/10\/2026, 2,3 MB$/ }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(opened).toEqual([{ href: `https://storage.test/${idOf('a', 2)}/original`, target: '_blank', rel: 'noopener noreferrer' }]);
    expect(world.calls.filter((call) => /variant=original/.test(call))).toEqual([
      `GET /agencies/11111111-1111-4111-8111-111111111111/media/${idOf('a', 2)}/download-url?variant=original`
    ]);
  });

  it('says the download could not be prepared, in the tile that asked', async () => {
    const world = makeWorld({
      assets: [assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z' }), assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z' })],
      override: (_method, path, search) => (path.endsWith(`/media/${idOf('a', 2)}/download-url`) && search.includes('original') ? apiError(404, 'NOT_FOUND', 'Media asset not found.') : undefined)
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    const tiles = await waitFor(() => {
      const found = screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'));
      if (found.length !== 2) throw new Error('not yet');
      return found;
    });
    fireEvent.click(within(tiles[1]!).getByRole('button', { name: /^Baixar/ }));

    expect((await within(tiles[1]!).findByRole('alert')).textContent).toBe('Não foi possível preparar o download. Tente de novo.');
    expect(within(tiles[0]!).queryByRole('alert')).toBeNull();
  });

  it('removes the media chosen and refuses the one in use with the reason the API gives, each in its own tile', async () => {
    const world = makeWorld({
      assets: [
        assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z', inUse: true }),
        assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z' })
      ]
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));
    const tiles = await waitFor(() => {
      const found = screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'));
      if (found.length !== 2) throw new Error('not yet');
      return found;
    });
    const inUse = tiles[0]!;
    const free = tiles[1]!;

    fireEvent.click(within(inUse).getByRole('button', { name: /^Remover/ }));
    const confirm = screen.getByRole('dialog', { name: 'Remover mídia?' });
    expect(confirm.textContent).toContain('Imagem de 11/10/2026, 2,3 MB');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remover' }));

    expect((await within(inUse).findByRole('alert')).textContent).toBe('Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(world.assets.map((asset) => asset.removed)).toEqual([undefined, undefined]);
    expect(within(free).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'))).toHaveLength(2);

    fireEvent.click(within(free).getByRole('button', { name: /^Remover/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remover mídia?' })).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'))).toHaveLength(1));
    expect(world.assets.map((asset) => asset.removed)).toEqual([undefined, true]);
    expect(world.calls.filter((call) => /\/remove$/.test(call)).map((call) => call.split('/').slice(-2)[0])).toEqual([idOf('a', 1), idOf('a', 2)]);
    expect(within(inUse).getByRole('alert')).toBeTruthy();
  });

  it('removes nothing when the confirmation is cancelled', async () => {
    const world = makeWorld({ assets: [assetFixture(1, VIDEOS)] });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    fireEvent.click(await screen.findByRole('button', { name: /^Remover/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remover mídia?' })).getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(world.calls.filter((call) => /\/remove$/.test(call))).toEqual([]);
    expect(screen.getByRole('button', { name: /^Baixar/ })).toBeTruthy();
  });

  it('takes a removed media off the screen at once, with no download to offer, before the list answers again', async () => {
    const held = deferred<void>();
    let lists = 0;
    const world = makeWorld({
      assets: [assetFixture(1, VIDEOS, { createdAt: '2026-10-12T01:30:00.000Z' }), assetFixture(2, VIDEOS, { createdAt: '2026-10-11T01:30:00.000Z' })],
      assetsGate: () => { lists += 1; return lists === 2 ? held.promise : undefined; }
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));
    const first = await waitFor(() => {
      const found = screen.getAllByRole('listitem').filter((item) => item.classList.contains('folder-media'));
      if (found.length !== 2) throw new Error('not yet');
      return found[0]!;
    });

    fireEvent.click(within(first).getByRole('button', { name: /^Remover/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remover mídia?' })).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(1));
    expect(lists).toBe(2);
    expect(first.isConnected).toBe(false);
    expect(world.calls.filter((call) => call.includes(`/media/${idOf('a', 1)}/download-url?variant=original`))).toEqual([]);
    held.resolve();
    await waitFor(() => expect(mediaCalls(world)).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(1);
  });

  it.each([
    ['already removed by someone else', () => apiError(404, 'NOT_FOUND', 'Media asset not found.'), 'Esta mídia não está mais nesta pasta.'],
    ['refused by the permission', () => apiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'), 'Você não tem permissão para fazer isso.'],
    ['an archived client', () => apiError(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.'), 'Cliente arquivado não pode ser editado.'],
    ['a failure, whose text is not the screen\'s to repeat', () => apiError(500, 'INTERNAL_ERROR', 'relation "media_assets" does not exist'), 'Não foi possível remover a mídia. Tente de novo.']
  ])('says the removal was %s, and the media stays where it is', async (_case, refusal, message) => {
    const world = makeWorld({
      assets: [assetFixture(1, VIDEOS)],
      override: (method, path) => (method === 'POST' && path.endsWith('/remove') ? refusal() : undefined)
    });
    open(world, foldersUrl(`&pasta=${VIDEOS}`));

    fireEvent.click(await screen.findByRole('button', { name: /^Remover/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remover mídia?' })).getByRole('button', { name: 'Remover' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText(/relation/)).toBeNull();
    expect(world.assets[0]?.removed).toBeUndefined();
  });

  describe('more media than one page', () => {
    const many = (count: number) => Array.from({ length: count }, (_value, index) =>
      assetFixture(index + 1, VIDEOS, { createdAt: new Date(Date.UTC(2026, 9, 1) + (index + 1) * 60_000).toISOString(), sizeBytes: (index + 1) * 1000 }));

    it('pages by the address: the oldest is on the second page, and each page is a click', async () => {
      const world = makeWorld({ assets: many(49) });
      const { probe } = open(world, foldersUrl(`&pasta=${VIDEOS}`));

      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(48));
      expect(screen.getByText('49 mídias')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Página 2' }));

      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(1));
      expect(new URLSearchParams(probe.search).get('pagina')).toBe('2');
      expect(screen.getByRole('button', { name: /^Baixar Imagem de 30\/09\/2026, 1000 B$/ })).toBeTruthy();
      expect(mediaCalls(world).at(-1)).toContain('page=2&pageSize=48');

      fireEvent.click(screen.getByRole('button', { name: 'Página 1' }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(48));
      expect(new URLSearchParams(probe.search).has('pagina')).toBe(false);
    });

    it('lands on the second page after a reload', async () => {
      const world = makeWorld({ assets: many(49) });
      open(world, foldersUrl(`&pasta=${VIDEOS}&pagina=2`));

      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(1));
      expect(mediaCalls(world)).toEqual([expect.stringContaining('page=2&pageSize=48')]);
    });

    it.each(['abc', '0', '-1', '1.5', ''])('reads the first page when the address says "%s"', async (raw) => {
      const world = makeWorld({ assets: many(2) });
      open(world, foldersUrl(`&pasta=${VIDEOS}&pagina=${raw}`));

      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(2));
      expect(mediaCalls(world)).toEqual([expect.stringContaining('page=1&pageSize=48')]);
    });

    it('offers the last page when the one asked for is past the end, and after the last media of a page is removed', async () => {
      const world = makeWorld({ assets: many(49) });
      const { probe } = open(world, foldersUrl(`&pasta=${VIDEOS}&pagina=3`));

      expect(await screen.findByText('Esta página não tem mídias.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Ir para a última página' }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(1));
      expect(new URLSearchParams(probe.search).get('pagina')).toBe('2');

      fireEvent.click(screen.getByRole('button', { name: /^Remover/ }));
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Remover mídia?' })).getByRole('button', { name: 'Remover' }));
      expect(await screen.findByText('Esta página não tem mídias.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Baixar/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Ir para a última página' }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Baixar/ })).toHaveLength(48));
      expect(new URLSearchParams(probe.search).has('pagina')).toBe(false);
    });
  });

  it('never shows an answer of the API as markup', async () => {
    const world = makeWorld({ folders: [folderFixture(1, '<img src=x onerror=alert(1)>', { isDefault: true })] });
    const { container } = open(world);

    expect(await screen.findByRole('link', { name: '<img src=x onerror=alert(1)> Padrão' })).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});

describe('the calendar is not asked while the folders are open', () => {
  it('asks the contents of the period only on the calendar and the feed', async () => {
    const world = makeWorld({
      override: (_method, path) => (/\/contents$/.test(path) ? json({ data: { contents: [], storyScripts: [] }, meta: { from: '2026-10-01', to: '2026-10-31', count: 0 } }) : undefined)
    });
    open(world, calendarUrl);
    await screen.findByRole('group', { name: 'Período' });
    expect(world.calls.filter((call) => /\/contents\?/.test(call))).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Pastas' }));
    await heading('Pastas');
    expect(world.calls.filter((call) => /\/contents\?/.test(call))).toHaveLength(1);
  });
});
