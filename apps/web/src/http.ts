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

const invalidRequest = (message: string): HttpClientError => new HttpClientError(message, { code: 'INVALID_REQUEST' });

const resolveRelativePath = (baseUrl: string, path: string): URL => {
  if (path.length === 0 || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) {
    throw invalidRequest('Request paths must be relative to the configured API origin.');
  }
  let resolved: URL;
  try {
    resolved = new URL(path, baseUrl);
  } catch (error: unknown) {
    throw new HttpClientError('Request path is invalid.', { code: 'INVALID_REQUEST', cause: error });
  }
  const base = new URL(baseUrl);
  if (resolved.origin !== base.origin) throw invalidRequest('Request paths must stay on the configured API origin.');
  return resolved;
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
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async request<TResponse>(options: RequestOptions<TResponse>): Promise<TResponse> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw invalidRequest('Request timeout must be a finite, positive number.');
    }
    const url = resolveRelativePath(this.baseUrl, options.path);
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
