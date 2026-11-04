export interface SessionStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}
export interface CookieCodec {
  getCookie(value: string | null): string;
  getSetCookie(header: string, previous?: string): string;
  hasBetterAuthCookies(header: string, prefix: string): boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function createApiClient(baseUrl: string, storage: SessionStorage, native: boolean, cookies: CookieCodec, transport: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '10.0.2.2'].includes(base.hostname)) {
    throw new Error('A API deve usar HTTPS fora do ambiente local.');
  }
  let epoch = 0;
  let writes = Promise.resolve();
  let ignoreStoredSession = false;
  let onExpired = () => {};
  let onAccessRequired = () => {};
  function enqueueWrite(action: () => Promise<void>) {
    const operation = writes.then(action);
    writes = operation.catch(() => {});
    return operation;
  }
  async function clearSession() {
    epoch += 1;
    ignoreStoredSession = true;
    await enqueueWrite(() => { ignoreStoredSession = true; return storage.clear(); });
  }
  async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Caminho de API inválido.');
    const requestEpoch = epoch;
    await writes;
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (native) {
      headers.set('expo-origin', 'ageniza://');
      const cookie = cookies.getCookie(ignoreStoredSession ? null : await storage.get());
      if (cookie) headers.set('Cookie', cookie);
    }
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort);
    if (options.signal?.aborted) controller.abort();
    try {
      response = await transport(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: options.method ?? 'GET', headers, credentials: native ? 'omit' : 'include',
        body: options.body === undefined ? options.method === 'POST' ? '' : undefined : JSON.stringify(options.body),
        signal: controller.signal, redirect: 'error'
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiError(0, 'NETWORK_ERROR', 'Não foi possível conectar. Confira sua internet e tente de novo.');
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
    if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== base.origin) {
      throw new ApiError(0, 'UNSAFE_REDIRECT', 'O servidor respondeu com um redirecionamento inesperado. Tente novamente mais tarde.');
    }
    if (requestEpoch !== epoch) throw new ApiError(401, 'STALE_SESSION', 'Sua sessão mudou. Entre novamente.');
    if (response.status === 401 && path !== '/auth/login') {
      try { await clearSession(); } finally { onExpired(); }
    }
    const setCookie = response.headers.get('set-cookie');
    if (native && response.ok && setCookie && cookies.hasBetterAuthCookies(setCookie, 'ageniza')) {
      await enqueueWrite(async () => {
        if (requestEpoch !== epoch) return;
        const previous = ignoreStoredSession ? undefined : await storage.get() ?? undefined;
        try { await storage.set(cookies.getSetCookie(setCookie, previous)); if (requestEpoch === epoch) ignoreStoredSession = false; }
        catch (cause) { ignoreStoredSession = true; throw cause; }
      });
      if (requestEpoch !== epoch) throw new ApiError(401, 'STALE_SESSION', 'Sua sessão mudou. Entre novamente.');
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 403 && ['TERMS_NOT_ACCEPTED', 'EMAIL_NOT_CONFIRMED'].includes(payload?.error?.code)) onAccessRequired();
      if (payload?.error?.code === 'CSRF_REJECTED') throw new ApiError(403, 'CSRF_REJECTED', 'O servidor ainda não liberou o acesso deste app. A equipe precisa habilitar ageniza:// no ambiente de desenvolvimento.');
      throw new ApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED',
        payload?.error?.message ?? 'Não foi possível concluir. Tente de novo.');
    }
    return payload as T;
  }
  return { request, clearSession, onExpired: (listener: () => void) => { onExpired = listener; }, onAccessRequired: (listener: () => void) => { onAccessRequired = listener; } };
}
export type ApiClient = ReturnType<typeof createApiClient>;
