import { ApiErrorResponseSchema, type RequestId } from '@ageniza/contracts';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';

export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface RequestOptions<TResponse> {
  path: string;
  response: ZodType<TResponse>;
  method?: HttpMethod;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpClientHooks {
  /** Called when the API rejects a request because the session no longer exists. */
  onSessionEnded?: () => void;
}

export class HttpClientError extends Error {
  public constructor(
    message: string,
    public readonly options: { code: string; status?: number; requestId?: RequestId; details?: unknown; cause?: unknown }
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpClientError';
  }

  public get code(): string { return this.options.code; }
  public get status(): number | undefined { return this.options.status; }
  public get requestId(): RequestId | undefined { return this.options.requestId; }
  public get details(): unknown { return this.options.details; }
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** A 401 with one of these codes means the session is gone; SESSION_EXPIRED is the 30-day ceiling. */
const SESSION_DEAD_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED']);

const invalidRequest = (message: string): HttpClientError => new HttpClientError(message, { code: 'INVALID_REQUEST' });

/**
 * The single barrier against a caller-built path escaping its intended route. `new URL` normalizes
 * `..`, treats `#` as a fragment and `//` as a new authority, so a path assembled from a URL
 * parameter (which React Router hands over already decoded) could otherwise turn the victim's
 * session into a request to another API route. Every segment is checked as raw text and as decoded
 * text, because `%2F`, `%2E%2E` and `%23` all reach the same place after the URL parser.
 */
const assertSafeRequestPath = (path: string): void => {
  if (path.length === 0 || !path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw invalidRequest('Request paths must be relative to the configured API origin.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\#]/.test(path)) {
    throw invalidRequest('Request paths must not contain a fragment, a backslash or a control character.');
  }
  // The URL parser strips spaces and C0 controls from both ends of the WHOLE input before it normalizes anything, so `/.. ` reads
  // as `/..` there and leaves the base path, while the segment above would have been checked as `.. `.
  if (path.startsWith(' ') || path.endsWith(' ')) {
    throw invalidRequest('Request paths must not start or end with a space.');
  }
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  if (query.includes('?')) throw invalidRequest('Request paths may declare at most one query string.');
  for (const segment of pathname.slice(1).split('/')) {
    if (segment.length === 0) throw invalidRequest('Request paths must not contain an empty segment.');
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidRequest('Request paths must be valid percent-encoding.');
    }
    if (decoded === '.' || decoded === '..') throw invalidRequest('Request paths must not contain a relative segment.');
    if (/[/\\?#]/.test(decoded)) throw invalidRequest('Request path segments must not decode to a separator or a fragment.');
  }
};

/**
 * The second barrier, on the result: the address the URL parser made of the base and the path is on the same origin and still
 * under the path of the base. It does not trust the first barrier (the parser strips spaces from the ends of its input and
 * normalizes `..` after that, which is how `/.. ` once left `/api`). Exported only so a test can hit it alone.
 */
export const joinUnderBase = (base: URL, basePath: string, path: string): URL => {
  let resolved: URL;
  try {
    resolved = new URL(`${base.origin}${basePath}${path}`);
  } catch (error: unknown) {
    throw new HttpClientError('Request path is invalid.', { code: 'INVALID_REQUEST', cause: error });
  }
  if (resolved.origin !== base.origin) throw invalidRequest('Request paths must stay on the configured API origin.');
  // The parser never sees a relative or empty segment (checked above), but the resolved pathname
  // is re-checked so a future normalization cannot reintroduce one silently.
  if (resolved.pathname.includes('//') || /(^|\/)\.\.?(\/|$)/.test(resolved.pathname)) {
    throw invalidRequest('Request paths must not contain a relative segment.');
  }
  if (!resolved.pathname.startsWith(`${basePath}/`)) throw invalidRequest('Request paths must stay under the path of the API base.');
  return resolved;
};

/**
 * The one rule that turns a configured API base and a request path into an address, for a request and for a navigation alike.
 * The base keeps its own path (`https://<domain>/api`, with or without a trailing slash): `new URL(path, base)` would throw it
 * away, since a path that starts with `/` replaces the whole path of the base. The path is checked first (no other origin, no
 * relative or empty segment, no separator in any encoding), and the result is checked again: same origin, and still under the
 * path of the base, so nothing that reached the parser can have walked out of it.
 */
const resolveApiUrl = (baseUrl: string, path: string): URL => {
  assertSafeRequestPath(path);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch (error: unknown) {
    throw new HttpClientError('The API base address is invalid.', { code: 'INVALID_REQUEST', cause: error });
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  if (base.search !== '' || base.hash !== '' || basePath.includes('//')) {
    throw invalidRequest('The API base address must not carry a query, a fragment or an empty segment.');
  }
  return joinUnderBase(base, basePath, path);
};

const createRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const parseJson = async (response: Response): Promise<unknown | undefined> => {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
};

const safeResponseRequestId = (response: Response, payload: unknown): RequestId | undefined => {
  const fromBody = ApiErrorResponseSchema.safeParse(payload);
  const fromHeader = response.headers.get('x-request-id');
  const result = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).safeParse(fromHeader);
  if (fromBody.success) return fromBody.data.meta?.requestId ?? (result.success ? result.data : undefined);
  return result.success ? result.data : undefined;
};

const combineSignals = (externalSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} => {
  const controller = new AbortController();
  let timedOut = false;
  const abortExternal = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener('abort', abortExternal, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortExternal);
    }
  };
};

/** Fetch wrapper that validates every response and exposes only stable, public error details. */
export class HttpClient {
  private readonly fetchImplementation: typeof fetch;

  public constructor(
    private readonly baseUrl: string,
    fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly hooks: HttpClientHooks = {}
  ) {
    // Chromium requires the native `fetch` to run with `globalThis` as its receiver; calling it as
    // a method of this client (or with `this` undefined) throws "TypeError: Illegal invocation".
    // Always invoke the received implementation with `globalThis`, whatever `this` the client has.
    this.fetchImplementation = (input, init) => Reflect.apply(fetchImplementation, globalThis, [input, init]);
  }

  // A 401 ends the session only while one is confirmed, and only when the request was sent inside
  // it: a visitor's 401 is ordinary, and a late 401 from a session already ended must not end the next.
  private sessionGeneration = 0;
  private sessionArmed = false;

  /**
   * The address the *browser* is sent to for an API route that is a navigation, not a request (the start of the Google
   * sign-in). It resolves with the same rule as a request: the path of the configured base (`https://<domain>/api`) is kept.
   */
  public browserUrl(path: string): string {
    return resolveApiUrl(this.baseUrl, path).toString();
  }

  /** Called once the API has proven a session exists; requests sent from now on can end it. */
  public confirmSession(): void {
    this.sessionGeneration += 1;
    this.sessionArmed = true;
  }

  public async request<TResponse>(options: RequestOptions<TResponse>): Promise<TResponse> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw invalidRequest('Request timeout must be a finite, positive number.');
    }
    const url = resolveApiUrl(this.baseUrl, options.path);
    const generation = this.sessionGeneration;
    const requestId = createRequestId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const combined = combineSignals(options.signal, timeoutMs);
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    headers.set('x-request-id', requestId);
    // The API authenticates by httpOnly cookie (ADR 0011); an Authorization header from a caller
    // would be the page trying to carry a credential it must never hold.
    headers.delete('authorization');
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    try {
      const response = await this.fetchImplementation(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combined.signal,
        credentials: 'include'
      });
      const payload = await parseJson(response);
      const responseRequestId = safeResponseRequestId(response, payload);

      if (!response.ok) {
        const parsedError = ApiErrorResponseSchema.safeParse(payload);
        if (parsedError.success) {
          // INVALID_CREDENTIALS is also a 401, but it answers a login attempt, not a dead session.
          if (response.status === 401 && SESSION_DEAD_CODES.has(parsedError.data.error.code)) this.endSession(generation);
          throw new HttpClientError(parsedError.data.error.message, {
            code: parsedError.data.error.code,
            status: response.status,
            requestId: parsedError.data.meta?.requestId ?? responseRequestId,
            details: parsedError.data.error.details
          });
        }
        throw new HttpClientError('The service returned an unexpected error response.', {
          code: 'HTTP_ERROR', status: response.status, requestId: responseRequestId
        });
      }

      const parsedResponse = options.response.safeParse(payload);
      if (!parsedResponse.success) {
        throw new HttpClientError('The service returned an invalid response.', {
          code: 'INVALID_RESPONSE', status: response.status, requestId: responseRequestId, cause: parsedResponse.error
        });
      }
      return parsedResponse.data;
    } catch (error: unknown) {
      if (error instanceof HttpClientError) throw error;
      if (combined.signal.aborted) {
        throw new HttpClientError(combined.didTimeout() ? 'The request timed out.' : 'The request was cancelled.', {
          code: combined.didTimeout() ? 'TIMEOUT' : 'ABORTED', cause: error
        });
      }
      throw new HttpClientError('The network request failed.', { code: 'NETWORK_ERROR', cause: error });
    } finally {
      combined.cleanup();
    }
  }

  private endSession(generation: number): void {
    if (!this.sessionArmed || generation !== this.sessionGeneration) return;
    this.sessionArmed = false;
    this.sessionGeneration += 1;
    this.hooks.onSessionEnded?.();
  }
}

const ApiClientContext = createContext<HttpClient | null>(null);

export function ApiClientProvider({ client, children }: { client: HttpClient; children: ReactNode }) {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

/** Accesses the configured transport without passing clients through page components. */
export const useApiClient = (): HttpClient => {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('ApiClientProvider is required.');
  return client;
};
