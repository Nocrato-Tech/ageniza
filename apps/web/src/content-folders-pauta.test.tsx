// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiError, assetFixture, folderFixture, foldersUrl, idOf, makeFetch, makeWorld, renderFolders, type World } from './content-folders-fixture.js';
import { declarationsFor, readStyles } from './styles/theme-colors';

const VIDEOS = idOf('f', 1);
const IMAGES = idOf('f', 2);
const READ_ONLY = ['conteudo.visualizar', 'cliente.visualizar'];
const css = readStyles('globals.css');
const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/** Sends nothing anywhere: the storage is down, which is how an upload ends in "Tentar de novo". */
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
const view = (): HTMLElement => screen.getByRole('region', { name: 'Pastas do cliente' });
const inputOf = (): HTMLInputElement => screen.getByLabelText('Enviar mídia');
const photo = () => new File([new Uint8Array(2_000)], 'foto.jpg', { type: 'image/jpeg' });
const watchPicker = (): { opened: () => number } => {
  let opened = 0;
  inputOf().addEventListener('click', (event) => { opened += 1; event.preventDefault(); });
  return { opened: () => opened };
};

describe('the Pastas view in the Pauta: one place to act in each state', () => {
  it('offers the picker as a button next to the title of a folder that has media, and not twice', async () => {
    open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), `&pasta=${VIDEOS}`);
    await screen.findByRole('list', { name: 'Mídias da pasta' });

    const buttons = screen.getAllByRole('button', { name: 'Enviar mídia' });
    expect(buttons).toHaveLength(1);
    const picker = watchPicker();
    fireEvent.click(buttons[0]!);
    expect(picker.opened()).toBe(1);
    expect(inputOf().getAttribute('aria-hidden')).toBe('true');
    expect(inputOf().tabIndex).toBe(-1);
  });

  it('puts the picker in the empty state of a folder with no media, in place of the button beside the title', async () => {
    open(makeWorld(), `&pasta=${VIDEOS}`);
    const empty = (await screen.findByText('Nenhuma mídia nesta pasta ainda.')).closest('.ui-empty-state') as HTMLElement;

    expect(empty.querySelector('h4')?.textContent).toBe('Nenhuma mídia nesta pasta ainda.');
    expect(within(empty).getByText('Envie imagens ou vídeos para esta pasta.')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Enviar mídia' });
    expect(buttons).toHaveLength(1);
    expect(empty.contains(buttons[0]!)).toBe(true);
    const picker = watchPicker();
    fireEvent.click(buttons[0]!);
    expect(picker.opened()).toBe(1);
  });

  it('keeps the chosen file on screen while the folder is empty', async () => {
    open(makeWorld(), `&pasta=${VIDEOS}`);
    await screen.findByText('Nenhuma mídia nesta pasta ainda.');

    fireEvent.change(inputOf(), { target: { files: [photo()] } });

    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('asks nothing of whoever cannot operate: no picker, no description, no button in the empty state', async () => {
    open(makeWorld({ permissions: READ_ONLY }), `&pasta=${VIDEOS}`);
    const empty = (await screen.findByText('Nenhuma mídia nesta pasta ainda.')).closest('.ui-empty-state') as HTMLElement;

    expect(within(empty).queryByRole('button')).toBeNull();
    expect(empty.querySelector('.ui-empty-state__description')).toBeNull();
    expect(screen.queryByLabelText('Enviar mídia')).toBeNull();
  });

  it('has one "Nova pasta", inside the empty state, when the client has no folder', async () => {
    open(makeWorld({ folders: [] }));
    const empty = (await screen.findByText('Nenhuma pasta ainda. Crie a primeira.')).closest('.ui-empty-state') as HTMLElement;

    const buttons = screen.getAllByRole('button', { name: 'Nova pasta' });
    expect(buttons).toHaveLength(1);
    expect(empty.contains(buttons[0]!)).toBe(true);
    expect(within(empty).getByText('As pastas guardam as mídias deste cliente.')).toBeTruthy();
    fireEvent.click(buttons[0]!);
    expect(screen.getByRole('dialog', { name: 'Nova pasta' })).toBeTruthy();
  });

  it('has one "Nova pasta de trabalho", inside the empty state, and beside the title once there is a work folder', async () => {
    open(makeWorld({ folders: [folderFixture(1, 'Vídeos', { isDefault: true })] }), `&pasta=${VIDEOS}`);
    const empty = (await screen.findByText('Nenhuma pasta de trabalho nesta pasta.')).closest('.ui-empty-state') as HTMLElement;

    const buttons = screen.getAllByRole('button', { name: 'Nova pasta de trabalho' });
    expect(buttons).toHaveLength(1);
    expect(empty.contains(buttons[0]!)).toBe(true);
    cleanup();

    open(makeWorld(), `&pasta=${VIDEOS}`);
    await screen.findByRole('link', { name: 'Gravação de outubro' });
    const beside = screen.getAllByRole('button', { name: 'Nova pasta de trabalho' });
    expect(beside).toHaveLength(1);
    expect(beside[0]!.closest('.content-folders__heading')).not.toBeNull();
  });

  it('answers a folder that does not exist with the way back, as a link', async () => {
    open(makeWorld(), `&pasta=${idOf('9', 1)}`);
    const empty = (await screen.findByText('Pasta não encontrada.')).closest('.ui-empty-state') as HTMLElement;

    const back = within(empty).getByRole('link', { name: 'Voltar às pastas' });
    expect(back.getAttribute('href')).toMatch(/\?vista=pastas$/);
    expect(empty.querySelector('h3')?.textContent).toBe('Pasta não encontrada.');
    expect(back.classList.contains('ui-button')).toBe(true);
    expect(back.closest('.ui-empty-state__action')).not.toBeNull();
  });

  it('draws the Padrão mark as a Pill and the folder as an icon, with no character in its place', async () => {
    open(makeWorld());
    const link = await screen.findByRole('link', { name: 'Imagens Padrão' });

    expect(link.querySelector('.ui-pill')?.textContent).toBe('Padrão');
    expect(link.querySelector('.content-folder__icon svg')).not.toBeNull();
    expect(link.querySelector('.content-folder__icon')?.textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Campanha de Natal' }).querySelector('.ui-pill')).toBeNull();
  });

  it('marks a video that is processing with an icon and the words, and a failed one with an icon and the words', async () => {
    const world = makeWorld({
      assets: [
        assetFixture(1, IMAGES),
        assetFixture(2, IMAGES, { category: 'video', contentType: 'video/mp4', videoProcessingStatus: 'processing' }),
        assetFixture(3, IMAGES, { category: 'video', contentType: 'video/mp4', videoProcessingStatus: 'failed' })
      ]
    });
    open(world, `&pasta=${IMAGES}`);

    const processing = (await screen.findByText('Processando vídeo')).closest('.ui-pill') as HTMLElement;
    expect(processing.querySelector('svg')).not.toBeNull();
    const failed = screen.getByText('Falha no processamento do vídeo');
    expect(failed.className).toBe('folder-media__failure');
    expect(failed.querySelector('svg')).not.toBeNull();
    expect(screen.getAllByText('Processando vídeo')).toHaveLength(1);
  });

  it('shows no full indigo action inside the view in any state: the page keeps the only one', async () => {
    const world = makeWorld({ assets: [assetFixture(1, IMAGES)] });
    open(world);
    await screen.findByRole('link', { name: 'Imagens Padrão' });
    expect(view().querySelectorAll('.ui-button--primary')).toHaveLength(0);
    cleanup();

    open(world, `&pasta=${IMAGES}`);
    await screen.findByRole('list', { name: 'Mídias da pasta' });
    fireEvent.change(inputOf(), { target: { files: [photo()] } });
    expect(view().querySelectorAll('.ui-button--primary')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(view().querySelectorAll('.ui-button--primary')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe('A conexão caiu durante o envio. Tente de novo.');
  });

  it('keeps the picker on screen after a file the retry cannot fix, so the person picks another', async () => {
    open(makeWorld({ assets: [assetFixture(1, IMAGES)] }), `&pasta=${IMAGES}`);
    await screen.findByRole('list', { name: 'Mídias da pasta' });
    fireEvent.change(inputOf(), { target: { files: [new File([new Uint8Array(10)], 'x.bin', { type: '' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Este formato de arquivo não é aceito.');
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Enviar mídia' })).toHaveLength(1);
  });

  it.each([
    ['folders', '', 'Não foi possível carregar as pastas. Tente de novo.', '/media-folders'],
    ['media', `&pasta=${IMAGES}`, 'Não foi possível carregar as mídias. Tente de novo.', '/assets']
  ])('answers the %s that did not load with an icon, the words and a secondary "Tentar de novo"', async (_what, search, message, suffix) => {
    const world = makeWorld({ override: (method, path) => (method === 'GET' && path.endsWith(suffix) ? apiError(500, 'INTERNAL_ERROR', 'boom') : undefined) });
    open(world, search);

    const text = await screen.findByText(message, undefined, { timeout: 5000 });
    expect(text.querySelector('svg')).not.toBeNull();
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });
    expect(retry.classList.contains('ui-button--secondary')).toBe(true);
    expect(retry.closest('.content-folders__error')?.querySelectorAll('.ui-button--primary')).toHaveLength(0);
  }, 15_000);

  it('draws an icon on the path between folders and on the download and removal of each media', async () => {
    open(makeWorld({ assets: [assetFixture(1, VIDEOS)] }), `&pasta=${VIDEOS}`);
    await screen.findByRole('list', { name: 'Mídias da pasta' });

    for (const control of [screen.getByRole('button', { name: /^Baixar/ }), screen.getByRole('button', { name: /^Remover/ })]) {
      expect(control.querySelector('svg')).not.toBeNull();
    }
    expect(screen.getByRole('navigation', { name: 'Caminho da pasta' }).querySelectorAll('svg')).toHaveLength(1);
    expect(screen.getByText('Imagem').querySelector('svg')).not.toBeNull();
  });

  it('gives the buttons of a media the touch size on a phone, and one column to the folders and the media', () => {
    expect(declarationsFor(css, '.folder-media__actions .ui-button--sm').get('min-height')).toBe('2.75rem');
    for (const selector of ['.content-folders__list', '.folder-media__grid']) {
      expect(declarationsFor(css, selector).get('grid-template-columns'), selector).toBe('minmax(0, 1fr)');
    }
  });

  it('shows the progress as a bar and a number, and never as the indigo of the action', () => {
    expect(declarationsFor(css, '.media-uploader__progress::-webkit-progress-value').get('background')).toBe('var(--text-primary)');
    expect(declarationsFor(css, '.media-uploader__progress::-moz-progress-bar').get('background')).toBe('var(--text-primary)');
    expect(declarationsFor(css, '.media-uploader__percent').get('font-variant-numeric')).toBe('tabular-nums');
  });

  it('draws icons with lucide and not with characters in the three files of the view', () => {
    for (const file of ['content-folders.tsx', 'media-uploader.tsx', 'media-thumbnail.tsx']) {
      expect(source(file), file).not.toMatch(/[▤▣▶›‹]/u);
    }
    expect(source('styles/globals.css')).not.toContain("content: '›'");
  });

  it('keeps the grids and the card of the view from growing past their column', () => {
    for (const selector of ['.content-folders,\n.content-folders__section', '.media-uploader', '.folder-media']) {
      const block = css.slice(css.indexOf(`${selector} {`));
      expect(block.slice(0, block.indexOf('}')), selector).toContain('grid-template-columns: minmax(0, 1fr)');
    }
    expect(css).toContain('repeat(auto-fill, minmax(min(100%, 14rem), 1fr))');
  });
});
