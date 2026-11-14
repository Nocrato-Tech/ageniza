// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiError, assetFixture, foldersUrl, idOf, makeFetch, makeWorld, renderFolders, type World } from './content-folders-fixture.js';
import { readGlobalCss } from './styles/read-css';
import { declarationsFor, readStyles } from './styles/theme-colors';

const VIDEOS = idOf('f', 1);
const IMAGES = idOf('f', 2);
const READ_ONLY = ['conteudo.visualizar', 'cliente.visualizar'];
const css = readStyles('globals.css');
const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

class DownXhr {
  public upload = { onprogress: null };
  public onerror: (() => void) | null = null;
  public open(): void { /* the request is never made */ }
  public setRequestHeader(): void { /* nothing to set */ }
  public abort(): void { /* nothing to abort */ }
  public send(): void { queueMicrotask(() => this.onerror?.()); }
}

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
  vi.stubGlobal('XMLHttpRequest', DownXhr);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = (world: World, search = '') => renderFolders(makeFetch(world), foldersUrl(search));
const view = (): HTMLElement => screen.getByRole('region', { name: 'Biblioteca de mídia' });
const inputOf = (): HTMLInputElement => screen.getByLabelText('Enviar mídia');
const photo = () => new File([new Uint8Array(2_000)], 'foto.jpg', { type: 'image/jpeg' });
const block = (selector: string): string => {
  const text = css.replace(/\r\n/g, '\n');
  const from = text.indexOf(`${selector} {`);
  return from < 0 ? '' : text.slice(from, text.indexOf('}', from));
};

describe('the library: one place to act in each state', () => {
  it('opens the picker from the one "Escolher arquivo" of an empty folder, and from no other button', async () => {
    open(makeWorld(), `&pasta=${VIDEOS}`);
    const empty = (await screen.findByText('Nenhum arquivo nesta pasta ainda.')).closest('.ui-empty-state') as HTMLElement;

    const buttons = within(view()).getAllByRole('button', { name: 'Escolher arquivo' });
    expect(buttons).toHaveLength(1);
    expect(empty.contains(buttons[0]!)).toBe(true);
    let opened = 0;
    inputOf().addEventListener('click', (event) => { opened += 1; event.preventDefault(); });
    fireEvent.click(buttons[0]!);
    expect(opened).toBe(1);
    expect(inputOf().getAttribute('aria-hidden')).toBe('true');
    expect(inputOf().tabIndex).toBe(-1);
  });

  it('keeps the chosen file on screen while the folder is empty', async () => {
    open(makeWorld(), `&pasta=${VIDEOS}`);
    await screen.findByText('Nenhum arquivo nesta pasta ainda.');

    fireEvent.change(inputOf(), { target: { files: [photo()] } });

    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('asks nothing of whoever cannot operate: no picker, no description, no button in the empty state', async () => {
    open(makeWorld({ permissions: READ_ONLY }), `&pasta=${VIDEOS}`);
    const empty = (await screen.findByText('Nenhum arquivo nesta pasta ainda.')).closest('.ui-empty-state') as HTMLElement;

    expect(within(empty).queryByRole('button')).toBeNull();
    expect(empty.querySelector('.ui-empty-state__description')).toBeNull();
    expect(screen.queryByLabelText('Enviar mídia')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar arquivos' })).toBeNull();
  });

  it('has one "Nova pasta", inside the empty state, when the client has no folder', async () => {
    open(makeWorld({ folders: [] }));
    const empty = (await screen.findByText('Nenhuma pasta ainda. Crie a primeira.')).closest('.ui-empty-state') as HTMLElement;

    const buttons = screen.getAllByRole('button', { name: 'Nova pasta' });
    expect(buttons).toHaveLength(1);
    expect(empty.contains(buttons[0]!)).toBe(true);
    fireEvent.click(buttons[0]!);
    expect(screen.getByRole('dialog', { name: 'Nova pasta' })).toBeTruthy();
  });

  it('answers a folder that does not exist with the way back, as a secondary link', async () => {
    open(makeWorld(), `&pasta=${idOf('9', 1)}`);
    const empty = (await screen.findByText('Pasta não encontrada.')).closest('.ui-empty-state') as HTMLElement;

    const back = within(empty).getByRole('link', { name: 'Voltar às pastas' });
    expect(back.getAttribute('href')).toMatch(/\/clientes\/[^/]+\/midias$/);
    expect(back.classList.contains('ui-button--secondary')).toBe(true);
    expect(empty.querySelectorAll('.ui-button--primary')).toHaveLength(0);
  });

  it('puts the serious owl only in the failure states, never in an empty one', async () => {
    open(makeWorld({ folders: [] }));
    await screen.findByText('Nenhuma pasta ainda. Crie a primeira.');
    expect(view().querySelectorAll('.ui-empty-state--serious, .ui-mascot')).toHaveLength(0);
    cleanup();

    open(makeWorld({ override: (method, path) => (method === 'GET' && path.endsWith('/media-folders/summary') ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) }));
    await screen.findByText('Não foi possível carregar as pastas. Tente de novo.', undefined, { timeout: 5000 });
    expect(document.querySelectorAll('.ui-empty-state--serious')).toHaveLength(1);
  }, 15_000);

  it('marks a video that is processing and a failed one with the words, in the type column', async () => {
    open(makeWorld({
      assets: [
        assetFixture(1, IMAGES),
        assetFixture(2, IMAGES, { category: 'video', contentType: 'video/mp4', name: 'a.mp4', videoProcessingStatus: 'processing' }),
        assetFixture(3, IMAGES, { category: 'video', contentType: 'video/mp4', name: 'b.mp4', videoProcessingStatus: 'failed' })
      ]
    }), `&pasta=${IMAGES}`);

    await screen.findByRole('table', { name: 'Arquivos' });
    const rowOf = (name: string) => screen.getByRole('button', { name }).closest('[role="row"]') as HTMLElement;
    expect(within(rowOf('a.mp4')).getByText('Processando')).toBeTruthy();
    expect(within(rowOf('b.mp4')).getByText('Falhou')).toBeTruthy();
    expect(within(rowOf('arquivo-1.jpg')).queryByText(/Processando|Falhou/)).toBeNull();
  });

  it('keeps the toolbar as the only primary of the screen, in every state of the view', async () => {
    const world = makeWorld({ assets: [assetFixture(1, IMAGES)] });
    open(world);
    await screen.findByRole('link', { name: /^Imagens/ });
    expect(view().querySelectorAll('.ui-button--primary')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enviar arquivos' }).classList.contains('ui-button--primary')).toBe(true);
    cleanup();

    open(world, `&pasta=${IMAGES}`);
    await screen.findByRole('table', { name: 'Arquivos' });
    fireEvent.change(inputOf(), { target: { files: [photo()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(view().querySelectorAll('.ui-button--primary')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('A conexão caiu durante o envio. Tente de novo.');
  });

  it('turns the picker off while a file is on its way, and reads the progress once, from the bar', async () => {
    class PendingXhr extends DownXhr { public override send(): void { /* the storage never answers */ } }
    vi.stubGlobal('XMLHttpRequest', PendingXhr);
    open(makeWorld({ assets: [assetFixture(1, IMAGES)] }), `&pasta=${IMAGES}`);
    await screen.findByRole('table', { name: 'Arquivos' });
    fireEvent.change(inputOf(), { target: { files: [photo()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByRole('progressbar', { name: 'Enviando foto.jpg' })).toBeTruthy();
    expect(inputOf().disabled).toBe(true);
    expect(view().querySelector('.media-uploader__percent')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancelar envio' }).classList.contains('ui-button--secondary')).toBe(true);
  });

  it.each([
    ['folders', '', 'Não foi possível carregar as pastas. Tente de novo.', '/media-folders/summary'],
    ['files', `&pasta=${IMAGES}`, 'Não foi possível carregar os arquivos. Tente de novo.', '/media']
  ])('answers the %s that did not load with the owl, the words and the one "Tentar de novo" of its block', async (_what, search, message, suffix) => {
    const world = makeWorld({ override: (method, path) => (method === 'GET' && path.endsWith(suffix) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
    open(world, search);

    expect(await screen.findByText(message, undefined, { timeout: 5000 })).toBeTruthy();
    const failure = document.querySelector('.ui-empty-state--serious') as HTMLElement;
    expect(failure).not.toBeNull();
    const retry = within(failure).getByRole('button', { name: 'Tentar de novo' });
    expect(retry.classList.contains('ui-button--primary')).toBe(true);
    expect(failure.querySelectorAll('.ui-button--primary')).toHaveLength(1);
  }, 15_000);

  it('draws an icon on the path between folders and on every action of the row menu', async () => {
    open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), `&pasta=${VIDEOS}`);
    await screen.findByRole('table', { name: 'Arquivos' });

    expect(screen.getByRole('navigation', { name: 'Caminho da pasta' }).querySelectorAll('svg').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ações de arquivo-1.jpg' }));
    for (const item of within(screen.getByRole('menu')).getAllByRole('menuitem')) expect(item.querySelector('svg'), item.textContent ?? '').not.toBeNull();
  });
});

describe('the library on a phone (390 px)', () => {
  it('keeps every control of the table reachable: the name, the type and the menu stay, only "Quando" gives way', () => {
    const text = source('media-library-table.tsx');
    expect(text).toContain('keepOnPhone');
    expect(text).toContain('actionsLabel="Ações do arquivo"');
    expect(css).toContain('@media (max-width: 40rem)');
  });

  it('puts the folders two by two, the featured block on its own row and the toolbar search at full width', () => {
    const phone = css.replace(/\r\n/g, '\n').split('@media (max-width: 40rem)').slice(1).join('\n');
    expect(phone).toMatch(/\.folders \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(phone).toMatch(/\.quick__feature \{[^}]*grid-column: auto/);
    expect(phone).toMatch(/\.media-toolbar__search \{[^}]*max-width: none/);
    expect(phone).toMatch(/\.media-detail__actions \.ui-button/);
  });

  it('keeps the grids and the card of the view from growing past their column', () => {
    for (const selector of ['.content-folders,\n.content-folders__section,\n.media-layout__main', '.media-uploader']) {
      expect(block(selector), selector).toContain('grid-template-columns: minmax(0, 1fr)');
    }
    expect(declarationsFor(css, '.media-layout').get('min-width')).toBe('0');
    expect(declarationsFor(css, '.media-detail').get('min-width')).toBe('0');
    expect(declarationsFor(css, '.media-table__name').get('min-width')).toBe('0');
    expect(declarationsFor(css, '.media-table__label').get('overflow-wrap')).toBe('anywhere');
    expect(declarationsFor(css, '.quick__file').get('min-width')).toBe('0');
    expect(css).toContain('repeat(auto-fill, minmax(min(100%, 11.5rem), 1fr))');
  });

  it('shows the side panel beside the list only on a wide screen, and under it otherwise', () => {
    const text = css.replace(/\r\n/g, '\n');
    const wide = text.slice(text.indexOf('@media (min-width: 80rem)'));
    expect(wide).toMatch(/\.media-layout--detail \{[^}]*grid-template-columns/);
    expect(text.slice(0, text.indexOf('@media (min-width: 80rem)'))).not.toMatch(/\.media-layout--detail \{[^}]*position: sticky/);
  });
});

describe('what the screen draws', () => {
  it('shows the progress as a bar and a number, and never as the indigo of the action', () => {
    expect(declarationsFor(css, '.media-uploader__progress::-webkit-progress-value').get('background')).toBe('var(--text-primary)');
    expect(declarationsFor(css, '.media-uploader__progress::-moz-progress-bar').get('background')).toBe('var(--text-primary)');
    expect(declarationsFor(css, '.media-uploader__percent').get('font-variant-numeric')).toBe('tabular-nums');
  });

  it('draws icons with lucide and not with characters in the files of the view', () => {
    for (const file of ['content-folders.tsx', 'media-uploader.tsx', 'media-thumbnail.tsx', 'media-library-table.tsx', 'media-library-folders.tsx', 'media-library-detail.tsx']) {
      expect(source(file), file).not.toMatch(/[▤▣▶›‹]/u);
    }
    expect(readGlobalCss()).not.toContain("content: '›'");
  });

  it('turns a phone photo upright from its EXIF orientation, on every thumbnail', () => {
    expect(declarationsFor(css, '.media-thumbnail img').get('image-orientation')).toBe('from-image');
  });

  it('uses no raw color or font in the sheets of the library: tokens only', () => {
    for (const file of ['styles/screens/media-library.css', 'styles/screens/content-folders.css']) {
      const text = source(file);
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, file).not.toMatch(/rgba?\(/);
    }
  });
});

describe('the detail panel takes the focus when it opens out of sight', () => {
  const matchMedia = (wide: boolean) => vi.stubGlobal('matchMedia', () => ({ matches: wide, addEventListener: () => undefined, removeEventListener: () => undefined }));

  it('scrolls to it and focuses it when it opens under the list, and leaves the focus alone beside the list', async () => {
    matchMedia(false);
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), `&pasta=${VIDEOS}`);
      await screen.findByRole('table', { name: 'Arquivos' });
      fireEvent.click(screen.getByRole('button', { name: 'arquivo-1.jpg' }));

      expect(document.activeElement).toBe(document.querySelector('aside.media-detail'));
      expect(scroll).toHaveBeenCalledTimes(1);
      cleanup();

      matchMedia(true);
      scroll.mockClear();
      open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), `&pasta=${VIDEOS}`);
      await screen.findByRole('table', { name: 'Arquivos' });
      fireEvent.click(screen.getByRole('button', { name: 'arquivo-1.jpg' }));
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});
