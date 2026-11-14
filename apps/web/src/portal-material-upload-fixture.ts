const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR', details?: unknown): Response =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

export interface StoredUpload { id: string; name: string; contentType: string; sizeBytes: number; status: 'pending' | 'confirmed'; category: 'image' | 'audio' }

/** The upload routes of the portal as the API answers them, for one request of one client. */
export const createPortalUploadsApi = (clientId: string, threadId: string, pageSize = 48) => {
  const base = `/clients/${clientId}/material-requests/${threadId}/uploads`;
  const files: StoredUpload[] = [];
  const calls: string[] = [];
  const announced: string[][] = [];
  const reserved: Array<{ fileName: string; contentType: string; declaredSizeBytes: number }> = [];
  const state: { rejectNames: Map<string, string>; resolved: boolean; failAnnounce: number } = { rejectNames: new Map(), resolved: false, failAnnounce: 0 };
  let sequence = 0;

  const handle = (url: URL, method: string, body?: unknown): Response | undefined => {
    if (!url.pathname.startsWith(base)) return undefined;
    const rest = url.pathname.slice(base.length);
    calls.push(`${method} ${rest === '' ? '/' : rest}`);
    if (rest === '' && method === 'POST') {
      if (state.resolved) return failure(409, 'REQUEST_RESOLVED');
      const input = body as { fileName: string; contentType: string; declaredSizeBytes: number };
      reserved.push(input);
      sequence += 1;
      const id = `a1a1a1a1-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      const category = input.contentType.startsWith('audio/') ? 'audio' as const : 'image' as const;
      files.push({ id, name: input.fileName, contentType: input.contentType, sizeBytes: input.declaredSizeBytes, status: 'pending', category });
      return json({ assetId: id, category, contentType: input.contentType, upload: { type: 'single', url: `https://storage.test/put/${id}`, expiresAt: '2026-10-08T12:15:00.000Z' } }, 201);
    }
    const complete = /^\/([^/]+)\/complete$/.exec(rest);
    if (complete !== null && method === 'POST') {
      const file = files.find((candidate) => candidate.id === complete[1]);
      if (file === undefined) return failure(404, 'NOT_FOUND');
      const reason = state.rejectNames.get(file.name);
      if (reason !== undefined) {
        files.splice(files.indexOf(file), 1);
        return failure(422, 'UPLOAD_REJECTED', 'O arquivo foi recusado.', { reason });
      }
      file.status = 'confirmed';
      return json({ assetId: file.id, status: 'confirmed', sizeBytes: file.sizeBytes, contentType: file.contentType });
    }
    if (rest === '/announce' && method === 'POST') {
      if (state.failAnnounce > 0) { state.failAnnounce -= 1; return failure(500, 'INTERNAL_ERROR'); }
      const ids = (body as { assetIds: string[] }).assetIds;
      announced.push(ids);
      return json({ id: 'c3c3c3c3-0000-4000-8000-000000000001', body: `enviou ${ids.length}`, side: 'client', author: null, createdAt: '2026-10-08T12:00:00.000Z' }, 201);
    }
    if (rest === '' && method === 'GET') {
      const number = Number(url.searchParams.get('page') ?? '1');
      const rows = files.map((file) => ({
        id: file.id, status: file.status, category: file.category, contentType: file.contentType, sizeBytes: file.sizeBytes, name: file.name,
        width: file.category === 'image' ? 800 : null, height: file.category === 'image' ? 600 : null,
        url: file.status === 'confirmed' ? `https://storage.test/get/${file.id}` : null, createdAt: '2026-10-08T12:00:00.000Z'
      }));
      return json({ data: rows.slice((number - 1) * pageSize, number * pageSize), meta: { page: number, pageSize, totalItems: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } });
    }
    return failure(404, 'NOT_FOUND');
  };

  return {
    handle, files, calls, announced, reserved, state,
    seed: (name: string, contentType = 'image/png'): StoredUpload => {
      sequence += 1;
      const file: StoredUpload = { id: `b1b1b1b1-0000-4000-8000-${String(sequence).padStart(12, '0')}`, name, contentType, sizeBytes: 2048, status: 'confirmed', category: contentType.startsWith('audio/') ? 'audio' : 'image' };
      files.push(file);
      return file;
    }
  };
};

/** The storage as the browser sees it: a PUT with progress that answers with a status. */
export class FakeXhr {
  public static all: FakeXhr[] = [];
  public static status = 200;
  public upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } = { onprogress: null };
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public status = 0;
  public method = '';
  public url = '';
  public headers: Record<string, string> = {};
  public constructor() { FakeXhr.all.push(this); }
  public open(method: string, url: string): void { this.method = method; this.url = url; }
  public setRequestHeader(name: string, value: string): void { this.headers[name.toLowerCase()] = value; }
  public abort(): void { this.onabort?.(); }
  public send(body: Blob): void {
    // A macrotask, as the network answers.
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size });
      this.status = FakeXhr.status;
      this.onload?.();
    }, 0);
  }
}
