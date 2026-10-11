// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiError, assetFixture, deferred, foldersUrl, idOf, makeFetch, makeWorld, padaria, renderFolders, UPLOAD_PART_BYTES, type World
} from './content-folders-fixture.js';

const IMAGES = idOf('f', 2);
const VIDEOS = idOf('f', 1);
const WORK = idOf('f', 6);
const MIB = 1024 * 1024;

interface StorageAnswer { readonly status: number; readonly eTag?: string }
type StorageHandler = (request: FakeXhr) => Promise<StorageAnswer | 'network'> | StorageAnswer | 'network';

/** The storage as the browser sees it: a PUT that reports progress, answers with a status and, for a part, an ETag. */
class FakeXhr {
  public static all: FakeXhr[] = [];
  public static handler: StorageHandler = () => ({ status: 200, eTag: '"etag"' });
  public upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } = { onprogress: null };
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public status = 0;
  public method = '';
  public url = '';
  public headers: Record<string, string> = {};
  public body: Blob | null = null;
  private eTag: string | null = null;
  public aborted = false;
  private done = false;

  public constructor() { FakeXhr.all.push(this); }
  public open(method: string, url: string): void { this.method = method; this.url = url; }
  public setRequestHeader(name: string, value: string): void { this.headers[name.toLowerCase()] = value; }
  public getResponseHeader(name: string): string | null { return name.toLowerCase() === 'etag' ? this.eTag : null; }
  public progress(loaded: number): void { this.upload.onprogress?.({ lengthComputable: true, loaded }); }
  public abort(): void { if (!this.done) { this.done = true; this.aborted = true; this.onabort?.(); } }
  public send(body: Blob): void {
    this.body = body;
    void Promise.resolve(FakeXhr.handler(this)).then((answer) => {
      if (this.done) return;
      this.done = true;
      if (answer === 'network') { this.onerror?.(); return; }
      this.status = answer.status;
      this.eTag = answer.eTag ?? null;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  FakeXhr.all = [];
  FakeXhr.handler = () => ({ status: 200, eTag: '"etag"' });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const READ_ONLY = ['conteudo.visualizar', 'cliente.visualizar'];
const open = (world: World, search = `&pasta=${IMAGES}`) => renderFolders(makeFetch(world), foldersUrl(search));
const picture = (name = 'foto.jpg', bytes = 2_000) => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
const choose = async (file: File) => {
  const input = await screen.findByLabelText('Enviar mídia');
  fireEvent.change(input, { target: { files: [file] } });
  return input as HTMLInputElement;
};
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
const uploadsOf = (world: World) => world.calls.filter((call) => /media\/uploads/.test(call));
const sent = (world: World, suffix: string) => world.bodies.find((entry) => entry.path.endsWith(suffix))?.body;
const alertText = async (text: string) => {
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(text);
};

describe('uploading media into a folder', () => {
  it('sends a small file in one PUT, confirms it, and the media appears in the grid', async () => {
    const world = makeWorld();
    open(world);
    const input = await choose(picture('foto.jpg', 2_000));

    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
    expect(uploadsOf(world)).toEqual([]);
    send();

    expect((await screen.findByRole('status')).textContent).toBe('Mídia enviada.');
    expect(sent(world, '/media/uploads')).toEqual({ fileName: 'foto.jpg', contentType: 'image/jpeg', declaredSizeBytes: 2_000, clientId: padaria.id, folderId: IMAGES });
    expect(FakeXhr.all).toHaveLength(1);
    expect(FakeXhr.all[0]?.method).toBe('PUT');
    expect(FakeXhr.all[0]?.url).toBe(`https://storage.test/put/${world.pending[0]?.assetId}`);
    expect(FakeXhr.all[0]?.headers['content-type']).toBe('image/jpeg');
    expect(FakeXhr.all[0]?.body?.size).toBe(2_000);
    expect(sent(world, '/complete')).toEqual({});
    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar Imagem de 11/10/2026, 2 KB' })).toBeTruthy();
    expect(input.value).toBe('');
    expect(screen.queryByText('foto.jpg · 2 KB')).toBeNull();
  });

  it('shows the progress of the bytes sent while it sends, and names the file in the bar', async () => {
    const gate = deferred<StorageAnswer>();
    FakeXhr.handler = () => gate.promise;
    open(makeWorld());
    await choose(picture('foto.jpg', 1_000));
    send();

    const bar = await screen.findByRole('progressbar', { name: 'Enviando foto.jpg' }) as HTMLProgressElement;
    await waitFor(() => { expect(FakeXhr.all).toHaveLength(1); });
    act(() => { FakeXhr.all[0]!.progress(250); });
    expect(bar.value).toBe(25);
    act(() => { FakeXhr.all[0]!.progress(1_000); });
    expect(bar.value).toBe(100);
    expect(screen.getByRole('button', { name: 'Cancelar envio' })).toBeTruthy();
    expect((screen.getByLabelText('Enviar mídia') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();

    gate.resolve({ status: 200 });
    await screen.findByText('Mídia enviada.');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('sends a large file by parts, in order, with the ETag of each one in the confirmation', async () => {
    const world = makeWorld();
    FakeXhr.handler = (request) => ({ status: 200, eTag: `"tag-${request.url.split('/').pop()}"` });
    open(world, `&pasta=${VIDEOS}`);
    await choose(new File([new Uint8Array(12 * MIB)], 'ensaio.mp4', { type: 'video/mp4' }));
    send();

    await screen.findByText('Mídia enviada.');
    expect(world.pending[0]?.multipart).toBe(true);
    expect(FakeXhr.all.map((request) => request.body?.size)).toEqual([UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, 2 * MIB]);
    expect(FakeXhr.all.map((request) => request.url.split('/').pop())).toEqual(['1', '2', '3']);
    expect(FakeXhr.all.every((request) => request.headers['content-type'] === undefined)).toBe(true);
    expect(sent(world, '/parts')).toEqual({ partNumbers: [1, 2, 3] });
    expect(sent(world, '/complete')).toEqual({
      parts: [{ partNumber: 1, eTag: '"tag-1"' }, { partNumber: 2, eTag: '"tag-2"' }, { partNumber: 3, eTag: '"tag-3"' }]
    });
  });

  it('counts the bytes of the parts already sent in the progress of a multipart upload', async () => {
    const gate = deferred<StorageAnswer>();
    FakeXhr.handler = (request) => (request.url.endsWith('/1') ? { status: 200, eTag: '"a"' } : gate.promise);
    open(makeWorld(), `&pasta=${VIDEOS}`);
    await choose(new File([new Uint8Array(10 * MIB)], 'ensaio.mp4', { type: 'video/mp4' }));
    send();

    const bar = await screen.findByRole('progressbar', { name: 'Enviando ensaio.mp4' }) as HTMLProgressElement;
    await waitFor(() => { expect(FakeXhr.all).toHaveLength(2); });
    await waitFor(() => { expect(bar.value).toBe(50); });
    act(() => { FakeXhr.all[1]!.progress(MIB); });
    expect(bar.value).toBe(60);
    gate.resolve({ status: 200, eTag: '"b"' });
    await screen.findByText('Mídia enviada.');
  });

  it('asks for the parts of a file of more than 100 in batches, and confirms only after the last one, with every ETag in order', async () => {
    const world = makeWorld({ partBytes: 1_000 });
    FakeXhr.handler = (request) => ({ status: 200, eTag: `"tag-${request.url.split('/').pop()}"` });
    open(world, `&pasta=${VIDEOS}`);
    await choose(new File([new Uint8Array(250_500)], 'longo.mp4', { type: 'video/mp4' }));
    send();

    await screen.findByText('Mídia enviada.');
    const asked = world.bodies.filter((entry) => entry.path.endsWith('/parts')).map((entry) => (entry.body as { partNumbers: number[] }).partNumbers);
    expect(asked.map((numbers) => [numbers[0], numbers.length])).toEqual([[1, 100], [101, 100], [201, 51]]);
    expect(FakeXhr.all).toHaveLength(251);
    expect(FakeXhr.all.map((request) => request.url.split('/').pop())).toEqual(Array.from({ length: 251 }, (_value, index) => String(index + 1)));
    const confirmed = sent(world, '/complete') as { parts: Array<{ partNumber: number; eTag: string }> };
    expect(confirmed.parts).toEqual(Array.from({ length: 251 }, (_value, index) => ({ partNumber: index + 1, eTag: `"tag-${index + 1}"` })));
    const steps = world.calls.map((call) => call.split(' ')[0] + ' ' + call.split('?')[0].split('/').slice(-1)[0]).filter((call) => /parts|complete/.test(call));
    expect(steps).toEqual(['POST parts', 'POST parts', 'POST parts', 'POST complete']);
  });

  it('uploads into the folder that is open: the work folder, not its parent', async () => {
    const world = makeWorld();
    open(world, `&pasta=${VIDEOS}&subpasta=${WORK}`);
    await choose(picture());
    send();
    await screen.findByText('Mídia enviada.');

    expect(world.pending[0]?.folderId).toBe(WORK);
    expect((sent(world, '/media/uploads') as { folderId: string }).folderId).toBe(WORK);
  });
});

describe('a failed upload keeps the file the person chose', () => {
  it('keeps the file and offers to try again when the storage refuses, and the retry is a whole new upload', async () => {
    let attempts = 0;
    FakeXhr.handler = () => { attempts += 1; return attempts === 1 ? { status: 403 } : { status: 200 }; };
    const world = makeWorld();
    open(world);
    await choose(picture('foto.jpg', 2_000));
    send();

    await alertText('O envio do arquivo falhou. Tente de novo.');
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect((screen.getByLabelText('Enviar mídia') as HTMLInputElement).disabled).toBe(false);
    expect(world.assets).toHaveLength(0);
    expect(sent(world, '/complete')).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByText('Mídia enviada.');
    expect(world.pending).toHaveLength(2);
    expect(world.assets).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the file when the connection drops', async () => {
    FakeXhr.handler = () => 'network';
    open(makeWorld());
    await choose(picture());
    send();

    await alertText('A conexão caiu durante o envio. Tente de novo.');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
  });

  it('does not confirm a part the storage gave no ETag for, and keeps the file', async () => {
    FakeXhr.handler = () => ({ status: 200 });
    const world = makeWorld();
    open(world, `&pasta=${VIDEOS}`);
    await choose(new File([new Uint8Array(6 * MIB)], 'ensaio.mp4', { type: 'video/mp4' }));
    send();

    await alertText('O envio de uma parte não foi confirmado. Tente de novo.');
    expect(sent(world, '/complete')).toBeUndefined();
    expect(FakeXhr.all).toHaveLength(1);
    expect(screen.getByText('ensaio.mp4 · 6 MB')).toBeTruthy();
    expect(world.assets).toHaveLength(0);
  });

  it('cancels the sending with its own words: the request stops, nothing is confirmed, the file stays and it can be sent again', async () => {
    let attempts = 0;
    FakeXhr.handler = () => { attempts += 1; return attempts === 1 ? new Promise<StorageAnswer>(() => undefined) : { status: 200 }; };
    const world = makeWorld();
    open(world);
    await choose(picture());
    send();
    await waitFor(() => { expect(FakeXhr.all).toHaveLength(1); });

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));

    expect((await screen.findByRole('status')).textContent).toBe('Envio cancelado. O arquivo continua escolhido.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/conexão caiu/)).toBeNull();
    expect(FakeXhr.all[0]?.aborted).toBe(true);
    expect(sent(world, '/complete')).toBeUndefined();
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();

    send();
    await screen.findByText('Mídia enviada.');
    expect(FakeXhr.all[1]?.aborted).toBe(false);
    expect(world.assets).toHaveLength(1);
  });

  it('cancels while the API still reserves the upload: no storage request is made', async () => {
    const gate = deferred<Response>();
    const world = makeWorld();
    const real = makeFetch(world);
    // A held request ends the way a real fetch does when its signal aborts.
    const held: typeof fetch = (input, init) => {
      if (init?.method !== 'POST' || !String(input).endsWith('/media/uploads')) return real(input, init);
      return new Promise<Response>((resolve, reject) => {
        void gate.promise.then(resolve);
        init.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')); });
      });
    };
    renderFolders(held, foldersUrl(`&pasta=${IMAGES}`));
    await choose(picture());
    send();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar envio' }));

    expect((await screen.findByRole('status')).textContent).toBe('Envio cancelado. O arquivo continua escolhido.');
    expect(FakeXhr.all).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a folder change in the middle of a sending stops it and leaves nothing of it in the new folder', async () => {
    FakeXhr.handler = () => new Promise<StorageAnswer>(() => undefined);
    const world = makeWorld();
    const { probe } = open(world, `&pasta=${VIDEOS}`);
    await choose(picture());
    send();
    await waitFor(() => { expect(FakeXhr.all).toHaveLength(1); });

    act(() => { probe.navigate(foldersUrl(`&pasta=${IMAGES}`)); });

    await waitFor(() => { expect(FakeXhr.all[0]?.aborted).toBe(true); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('foto.jpg · 2 KB')).toBeNull();
    expect((screen.getByLabelText('Enviar mídia') as HTMLInputElement).disabled).toBe(false);
    expect(sent(world, '/complete')).toBeUndefined();
  });

  it.each([
    ['reserving', '/media/uploads'],
    ['confirming', '/complete']
  ])('tells the client was archived when the API answers 409 while %s, and offers no retry', async (_step, suffix) => {
    const world = makeWorld({ override: (method, path) => (method === 'POST' && path.endsWith(suffix)
      ? apiError(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.') : undefined) });
    renderFolders(makeFetch(world), foldersUrl(`&pasta=${IMAGES}`));
    await choose(picture());
    send();

    await alertText('O cliente está arquivado e não recebe mídia.');
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
    expect(world.assets).toHaveLength(0);
  });

  it('tells the folder is gone when the API answers 404', async () => {
    const world = makeWorld({ override: (method, path) => (method === 'POST' && path.endsWith('/media/uploads')
      ? apiError(404, 'NOT_FOUND', 'Folder not found.') : undefined) });
    renderFolders(makeFetch(world), foldersUrl(`&pasta=${IMAGES}`));
    await choose(picture());
    send();

    await alertText('A pasta não existe mais.');
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
  });

  it('stops the request when the screen goes away, and what the storage answers afterwards changes nothing', async () => {
    const gate = deferred<StorageAnswer>();
    FakeXhr.handler = () => gate.promise;
    const world = makeWorld();
    const { unmount } = open(world);
    await choose(picture());
    send();
    await waitFor(() => { expect(FakeXhr.all).toHaveLength(1); });

    unmount();
    gate.resolve({ status: 200 });
    await act(async () => { await gate.promise; });

    expect(sent(world, '/complete')).toBeUndefined();
    expect(world.assets).toHaveLength(0);
  });

  it.each([
    ['a type the API does not accept', 'application/pdf', 'doc.pdf', 2_000, 'Este formato de arquivo não é aceito.'],
    ['a file over the limit', 'image/jpeg', 'enorme.jpg', 101 * MIB, 'O arquivo é maior que o limite aceito.']
  ])('says in its own words that %s is refused, and asks to pick another file', async (_case, type, name, bytes, text) => {
    open(makeWorld());
    await choose(new File([new Uint8Array(bytes)], name, { type }));
    send();

    await alertText(text);
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(FakeXhr.all).toHaveLength(0);
    expect(screen.getByText((content) => content.startsWith(`${name} · `))).toBeTruthy();
  });

  it('refuses an empty file and a file with no type without asking the API', async () => {
    const world = makeWorld();
    open(world);
    await choose(new File([], 'vazio.jpg', { type: 'image/jpeg' }));
    send();
    await alertText('O arquivo está vazio.');

    await choose(new File([new Uint8Array(10)], 'sem-tipo', { type: '' }));
    send();
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Este formato de arquivo não é aceito.'); });
    expect(uploadsOf(world)).toEqual([]);
  });

  it('tells a full storage apart and offers the retry', async () => {
    open(makeWorld({ quotaFull: true }));
    await choose(picture());
    send();

    await alertText('O armazenamento da agência está cheio.');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(FakeXhr.all).toHaveLength(0);
  });

  it('shows its own text when the API rejects the object at confirmation, never the API text', async () => {
    const world = makeWorld({ rejectUpload: true });
    open(world);
    await choose(picture());
    send();

    await alertText('O arquivo foi recusado na conferência. Escolha outro.');
    expect(screen.queryByText(/content_type_mismatch/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(world.assets).toHaveLength(0);
  });

  it('does not show a text of the API for an error it does not know', async () => {
    const world = makeWorld({ override: (method, path) => (method === 'POST' && path.endsWith('/media/uploads') ? apiError(500, 'INTERNAL', 'SELECT * FROM secret') : undefined) });
    renderFolders(makeFetch(world), foldersUrl(`&pasta=${IMAGES}`));
    await choose(picture());
    send();

    await alertText('Não foi possível enviar a mídia. Tente de novo.');
    expect(screen.queryByText(/SELECT/)).toBeNull();
  });

  it('says it when the API forbids the upload, with the file still chosen', async () => {
    const world = makeWorld({ override: (method, path) => (method === 'POST' && path.endsWith('/media/uploads') ? apiError(403, 'FORBIDDEN', 'no') : undefined) });
    renderFolders(makeFetch(world), foldersUrl(`&pasta=${IMAGES}`));
    await choose(picture());
    send();

    await alertText('Você não tem permissão para enviar mídia.');
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();
  });

  it('takes a new choice as a clean start: the old failure goes away', async () => {
    FakeXhr.handler = () => ({ status: 500 });
    open(makeWorld());
    await choose(picture('um.jpg'));
    send();
    await alertText('O envio do arquivo falhou. Tente de novo.');

    await choose(picture('dois.jpg'));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('dois.jpg · 2 KB')).toBeTruthy();
    expect(screen.queryByText('um.jpg · 2 KB')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });
});

describe('who can upload', () => {
  it('offers no upload to someone who only reads', async () => {
    open(makeWorld({ permissions: READ_ONLY, assets: [assetFixture(1, IMAGES)] }));

    expect(await screen.findByRole('list', { name: 'Mídias da pasta' })).toBeTruthy();
    expect(screen.queryByLabelText('Enviar mídia')).toBeNull();
  });

  it('offers no upload for an archived client', async () => {
    open(makeWorld({ clientStatus: 'archived' }));

    await screen.findByRole('heading', { name: 'Mídias', level: 3 });
    expect(screen.queryByLabelText('Enviar mídia')).toBeNull();
  });
});

describe('the file belongs to the folder it was chosen in', () => {
  it('drops the chosen file when the person goes to another folder', async () => {
    const world = makeWorld();
    const { probe } = open(world, `&pasta=${VIDEOS}`);
    await choose(picture());
    expect(screen.getByText('foto.jpg · 2 KB')).toBeTruthy();

    act(() => { probe.navigate(foldersUrl(`&pasta=${IMAGES}`)); });

    await waitFor(() => { expect(screen.queryByText('foto.jpg · 2 KB')).toBeNull(); });
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(uploadsOf(world)).toEqual([]);
  });
});
