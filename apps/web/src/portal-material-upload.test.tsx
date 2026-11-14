// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaterialRequest } from '@ageniza/contracts';

import { ApiClientProvider, HttpClient, HttpClientError } from './http.js';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PortalMaterialRequests } from './portal-material-requests.js';
import { PortalRequestsPage } from './portal-requests.js';
import { PortalUploadActions, PortalUploadDialog } from './portal-material-upload.js';
import { pickRecorderType, uploadErrorOf } from './portal-material-upload-model.js';
import { createPortalMaterialRequestsApi } from './portal-material-requests-fixture.js';
import { createPortalUploadsApi, FakeXhr } from './portal-material-upload-fixture.js';
import { createQueryClient } from './query.js';

vi.mock('./portal.js', () => ({
  usePortalClient: () => ({ agencyName: 'Agência Um', agencyReadOnly: false })
}));

afterEach(cleanup);

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const THREAD_ID = 'e1e1e1e1-0000-4000-8000-000000000001';

const request: MaterialRequest = { threadId: THREAD_ID, title: 'Fotos da vitrine', body: 'Mande fotos da vitrine nova', dueOn: null, createdAt: '2026-10-07T12:00:00.000Z', state: 'open' };

const png = (name: string, size = 1024): File => new File([new Uint8Array(size).fill(1)], name, { type: 'image/png' });

let uploads: ReturnType<typeof createPortalUploadsApi>;
const fetched: string[] = [];

const mount = (children: React.ReactNode, route?: (url: URL, method: string, body?: unknown) => Response | undefined) => {
  const client = new HttpClient('http://127.0.0.1:3001', async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    fetched.push(`${method} ${url.pathname}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    return route?.(url, method, body) ?? uploads.handle(url, method, body) ?? new Response('{}', { status: 404 });
  });
  return render(<QueryClientProvider client={createQueryClient()}><ApiClientProvider client={client}>{children}</ApiClientProvider></QueryClientProvider>);
};

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (label: string, files: File[]): void => { fireEvent.change(screen.getByLabelText(label), { target: { files } }); };
const settle = async (): Promise<void> => { await waitFor(() => { expect(screen.queryByText('Enviando os arquivos…')).toBeNull(); }); };

beforeEach(() => {
  FakeXhr.all = [];
  FakeXhr.status = 200;
  fetched.length = 0;
  uploads = createPortalUploadsApi(CLIENT_ID, THREAD_ID);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('sending photos to an open request', () => {
  it('reserves, PUTs to the signed address and confirms each file, then announces once with the confirmed ids', async () => {
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('a.png'), png('b.png')]);
    await waitFor(() => { expect(uploads.announced).toHaveLength(1); });
    await settle();
    expect(uploads.reserved.map((item) => item.fileName)).toEqual(['a.png', 'b.png']);
    expect(uploads.reserved[0]?.contentType).toBe('image/png');
    expect(FakeXhr.all.map((xhr) => `${xhr.method} ${xhr.url.replace(/[0-9a-f-]{36}$/, '<id>')}`)).toEqual(['PUT https://storage.test/put/<id>', 'PUT https://storage.test/put/<id>']);
    expect(FakeXhr.all[0]?.headers['content-type']).toBe('image/png');
    expect(uploads.announced[0]).toEqual(uploads.files.map((file) => file.id));
    expect(uploads.calls.filter((call) => call === 'POST /announce')).toHaveLength(1);
    expect(uploads.calls.filter((call) => call.endsWith('/complete'))).toHaveLength(2);
    expect(within(dialog()).getAllByText(/^Enviado/)).toHaveLength(2);
    expect(within(dialog()).getByText('2 arquivos enviados.')).toBeTruthy();
  });

  it('announces only the confirmed files when the bytes of one are turned down, and says it in neutral words', async () => {
    uploads.state.rejectNames.set('ruim.png', 'agency_unavailable');
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('boa.png'), png('ruim.png')]);
    await waitFor(() => { expect(uploads.announced).toHaveLength(1); });
    await settle();
    const confirmed = uploads.files.filter((file) => file.status === 'confirmed').map((file) => file.id);
    expect(uploads.announced[0]).toEqual(confirmed);
    expect(uploads.announced[0]).toHaveLength(1);
    const text = dialog().textContent ?? '';
    expect(text).toContain('O envio de arquivos está pausado no momento. Tente mais tarde ou fale com a sua agência.');
    expect(text).not.toMatch(/plano|cota|armazenamento|assinatura|espaço/i);
    expect(within(dialog()).getByText('1 arquivo enviado, 1 não foi enviado.')).toBeTruthy();
  });

  it('does not announce when no file was confirmed', async () => {
    uploads.state.rejectNames.set('x.png', 'content_type_mismatch');
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('x.png')]);
    await within(dialog()).findByText('O arquivo não é uma foto nem um áudio válido. Escolha outro.');
    await settle();
    expect(uploads.announced).toHaveLength(0);
    expect(uploads.calls).not.toContain('POST /announce');
  });

  it('refuses in the browser what the contract never takes, without asking the API for a reservation', async () => {
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), new File([], 'vazio.png', { type: 'image/png' })]);
    await within(dialog()).findByText('Envie uma foto (PNG, JPEG, WebP ou GIF).');
    expect(within(dialog()).getByText('O arquivo está vazio. Escolha outro.')).toBeTruthy();
    await settle();
    expect(uploads.reserved).toHaveLength(0);
    expect(uploads.announced).toHaveLength(0);
  });

  it('shows the failure of the storage and does not announce what never got there', async () => {
    FakeXhr.status = 403;
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('a.png')]);
    await within(dialog()).findByText('Não foi possível enviar o arquivo. Tente de novo.');
    await settle();
    expect(uploads.calls.some((call) => call.endsWith('/complete'))).toBe(false);
    expect(uploads.announced).toHaveLength(0);
  });

  it('retries the announcement without repeating the batch when it failed', async () => {
    uploads.state.failAnnounce = 1;
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('a.png')]);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Avisar de novo' }));
    await waitFor(() => { expect(uploads.announced).toHaveLength(1); });
    expect(uploads.reserved).toHaveLength(1);
  });

  it('closes the offer when the request was resolved meanwhile', async () => {
    uploads.state.resolved = true;
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    pick('Escolher fotos', [png('a.png'), png('b.png')]);
    await within(dialog()).findAllByText('Este pedido já foi resolvido e não recebe mais arquivos.');
    expect(screen.queryByRole('button', { name: 'Escolher fotos' })).toBeNull();
    expect(uploads.reserved).toHaveLength(0);
  });

  it('has no action on a request that is not open', () => {
    mount(<PortalUploadActions clientId={CLIENT_ID} request={{ ...request, state: 'resolved' }} />);
    expect(screen.queryByRole('button', { name: 'Enviar fotos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gravar depoimento' })).toBeNull();
  });
});

describe('the text of a paused upload', () => {
  it.each(['UPLOAD_UNAVAILABLE', 'AGENCY_READ_ONLY'])('speaks of the upload, not of the approval, for %s', (code) => {
    const error = uploadErrorOf(new HttpClientError('x', { code, status: 409 }));
    expect(error.message).toBe('O envio de arquivos está pausado no momento. Tente mais tarde ou fale com a sua agência.');
    expect(error.message).not.toMatch(/aprovação|avisada|plano|cota|armazenamento/i);
  });
});

describe('the files already sent', () => {
  it('lists photos as thumbnails and audio as a player from the signed address, and pages on demand', async () => {
    uploads = createPortalUploadsApi(CLIENT_ID, THREAD_ID, 2);
    uploads.seed('um.png');
    uploads.seed('depoimento.m4a', 'audio/mp4');
    uploads.seed('tres.png');
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="photos" onClose={() => undefined} />);
    expect(await within(await screen.findByRole('dialog')).findByText('Arquivos já enviados (3)')).toBeTruthy();
    expect(within(dialog()).getByAltText('um.png').getAttribute('src')).toMatch(/^https:\/\/storage\.test\/get\//);
    expect(within(dialog()).getByLabelText('Ouvir depoimento.m4a').getAttribute('src')).toMatch(/^https:\/\/storage\.test\/get\//);
    expect(within(dialog()).queryByAltText('tres.png')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Ver mais arquivos' }));
    expect(await within(dialog()).findByAltText('tres.png')).toBeTruthy();
    expect(fetched.filter((call) => call === `GET /clients/${CLIENT_ID}/material-requests/${THREAD_ID}/uploads`)).toHaveLength(2);
    expect(within(dialog()).queryByRole('button', { name: 'Ver mais arquivos' })).toBeNull();
  });
});

describe('recording a testimony', () => {
  class FakeRecorder {
    public static supported = ['audio/webm;codecs=opus', 'audio/webm'];
    public static last: FakeRecorder | undefined;
    public static isTypeSupported = (type: string): boolean => FakeRecorder.supported.includes(type);
    public state: 'inactive' | 'recording' = 'inactive';
    public mimeType: string;
    public ondataavailable: ((event: { data: Blob }) => void) | null = null;
    public onstop: (() => void) | null = null;
    public constructor(public readonly stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; FakeRecorder.last = this; }
    public start(): void { this.state = 'recording'; }
    public stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2000).fill(2)], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const stopTrack = vi.fn();

  beforeEach(() => {
    stopTrack.mockClear();
    FakeRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm'];
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });

  it('asks for the microphone, records, stops, lets the person listen and sends the file through the same cycle', async () => {
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="testimony" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Gravar depoimento' }));
    await within(dialog()).findByRole('button', { name: 'Parar' });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeRecorder.last?.mimeType).toBe('audio/webm;codecs=opus');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Parar' }));
    expect((await within(dialog()).findByLabelText('Ouvir o depoimento gravado')).getAttribute('src')).toBe('blob:test');
    expect(stopTrack).toHaveBeenCalled();
    expect(uploads.reserved).toHaveLength(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar depoimento' }));
    await waitFor(() => { expect(uploads.announced).toHaveLength(1); });
    expect(uploads.reserved[0]?.contentType).toBe('audio/webm');
    expect(uploads.reserved[0]?.fileName).toMatch(/^depoimento-\d{8}-\d{4}\.webm$/);
    expect(FakeXhr.all[0]?.headers['content-type']).toBe('audio/webm');
  });

  it('prefers the MP4 a Safari records, and falls back to choosing a file when the browser records nothing the contract takes', () => {
    expect(pickRecorderType((type) => ['audio/mp4', 'audio/webm'].includes(type))).toBe('audio/mp4');
    expect(pickRecorderType((type) => type === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(pickRecorderType((type) => type === 'audio/aac')).toBeUndefined();
  });

  it('offers a file of audio when the browser records no accepted type', async () => {
    FakeRecorder.supported = [];
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="testimony" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    expect(within(dialog()).getByText('Este navegador não grava áudio. Escolha um arquivo de áudio do seu aparelho.')).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Gravar depoimento' })).toBeNull();
    pick('Escolher um arquivo de áudio', [new File([new Uint8Array(500)], 'voz.mp3', { type: 'audio/mpeg' })]);
    await waitFor(() => { expect(uploads.announced).toHaveLength(1); });
    expect(uploads.reserved[0]?.contentType).toBe('audio/mpeg');
  });

  it('tells the person who denied the microphone how to go on, and keeps the file choice', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    mount(<PortalUploadDialog clientId={CLIENT_ID} request={request} mode="testimony" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Gravar depoimento' }));
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(dialog().textContent).toContain('Sem acesso ao microfone');
    expect(within(dialog()).getByRole('button', { name: 'Gravar depoimento' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Escolher um arquivo de áudio' })).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(uploads.reserved).toHaveLength(0);
  });
});

describe('where the actions are', () => {
  it('shows "Enviar fotos" and "Gravar depoimento" on each open request of the Início, and opens the dialog of the chosen one', async () => {
    const requests = createPortalMaterialRequestsApi(CLIENT_ID);
    const row = requests.seed({ title: 'Fotos da vitrine', body: 'Mande fotos' });
    uploads = createPortalUploadsApi(CLIENT_ID, row.threadId);
    mount(<PortalMaterialRequests clientId={CLIENT_ID} />, (url, method, body) => requests.handle(url, method, body) ?? uploads.handle(url, method, body));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar fotos' }));
    expect(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Escolher fotos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gravar depoimento' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ver o pedido/ })).toBeTruthy();
  });

  it('offers the same two actions beside "Responder" on Pedidos da agência', async () => {
    const requests = createPortalMaterialRequestsApi(CLIENT_ID);
    const row = requests.seed({ title: 'Fotos da vitrine', body: 'Mande fotos' });
    uploads = createPortalUploadsApi(CLIENT_ID, row.threadId);
    mount(
      <MemoryRouter initialEntries={[`/portal/${CLIENT_ID}/pedidos`]}>
        <Routes><Route path="/portal/:clienteId/pedidos" element={<PortalRequestsPage />} /></Routes>
      </MemoryRouter>,
      (url, method, body) => requests.handle(url, method, body) ?? uploads.handle(url, method, body)
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Gravar depoimento' }));
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Gravar depoimento' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Responder/ }).length).toBeGreaterThan(0);
  });
});
