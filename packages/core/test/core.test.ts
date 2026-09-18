import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  HttpError,
  OperationalError,
  checkHealth,
  createLogger,
  redactSensitiveData,
  createReadiness,
  createRequestId,
  createShutdownManager,
  errorResponse,
  noContent,
  registerShutdownSignals,
  resolveRequestId,
  retry,
  retryDelay,
  serializeError,
  stripRequestUrl,
  shouldEnableSentry,
  withLogContext
} from '../src/index.js';

describe('logging and request IDs', () => {
  it('adds standard context fields with a Pino child logger', () => {
    const child = withLogContext(createLogger({ enabled: false }), {
      requestId: 'request-1', userId: 'user-1', agencyId: 'agency-1', module: 'api', action: 'read'
    });
    expect(child.bindings()).toMatchObject({ requestId: 'request-1', userId: 'user-1', agencyId: 'agency-1', module: 'api', action: 'read' });
  });

  it('retains deployment context in structured logger bindings', () => {
    const logger = withLogContext(createLogger({ enabled: false }), {
      environment: 'production', service: 'api', deployVersion: 'commit-123'
    });
    expect(logger.bindings()).toMatchObject({ environment: 'production', service: 'api', deployVersion: 'commit-123' });
  });

  it('redacts common credentials from structured logs', async () => {
    const destination = new PassThrough();
    const output: string[] = [];
    destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const logger = createLogger({}, destination);

    logger.info({ password: 'secret', accessToken: 'token', dsn: 'https://key@example/1', req: { headers: { authorization: 'Bearer token' } } }, 'safe');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output.join('')).not.toContain('secret');
    expect(output.join('')).not.toContain('Bearer token');
    expect(output.join('')).not.toContain('https://key@example/1');
    expect(output.join('')).toContain('[REDACTED]');
  });

  it('gates server Sentry to production with a DSN and never tests', () => {
    expect(shouldEnableSentry({ environment: 'production', dsn: 'https://public@example/1', release: 'abc' })).toBe(true);
    expect(shouldEnableSentry({ environment: 'local', dsn: 'https://public@example/1', release: 'abc' })).toBe(false);
    expect(shouldEnableSentry({ environment: 'production', release: 'abc', isTest: true })).toBe(false);
  });

  it('drops the request URL the Sentry SDK attaches, which redaction alone would not catch', () => {
    const token = 'invitation-token-in-a-path-segment';
    expect(stripRequestUrl({ request: { url: `https://app.test/invitations/${token}`, method: 'GET' } }))
      .toEqual({ request: { method: 'GET' } });
    expect(redactSensitiveData({ url: `https://app.test/invitations/${token}` })).toEqual({ url: `https://app.test/invitations/${token}` });
    expect(stripRequestUrl({ request: { method: 'GET' } })).toEqual({ request: { method: 'GET' } });
    expect(stripRequestUrl({})).toEqual({});
  });

  it('recursively redacts nested, case-variant credentials and Authorization bearer values', () => {
    expect(redactSensitiveData({ nested: { Authorization: 'Bearer should-not-leak', sentryDsn: 'https://secret@example/1' }, note: 'Authorization: Bearer should-not-leak' })).toEqual({
      nested: { Authorization: '[REDACTED]', sentryDsn: '[REDACTED]' },
      note: 'Authorization: Bearer [REDACTED]'
    });
  });

  it('generates IDs and preserves meaningful inbound IDs', () => {
    expect(createRequestId()).toMatch(/^[0-9a-f-]{36}$/i);
    expect(resolveRequestId(' request-1 ')).toBe('request-1');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(resolveRequestId('invalid id with spaces')).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('errors and HTTP responses', () => {
  it('serializes operational errors stably without a stack', () => {
    const error = new HttpError({ statusCode: 409, code: 'CONFLICT', message: 'Already exists', details: { resource: 'item' } });
    expect(serializeError(error)).toEqual({ name: 'HttpError', code: 'CONFLICT', message: 'Already exists', statusCode: 409, details: { resource: 'item' } });
    expect(errorResponse(error)).toEqual({ statusCode: 409, body: { error: serializeError(error) } });
    expect(errorResponse(new Error('secret')).body.error).toEqual({ name: 'Error', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(() => new HttpError({ statusCode: 200, code: 'INVALID', message: 'Invalid' })).toThrow(RangeError);
  });

  it('provides transport-neutral empty responses', () => {
    expect(noContent({ 'x-request-id': 'id-1' })).toEqual({ statusCode: 204, body: undefined, headers: { 'x-request-id': 'id-1' } });
    expect(serializeError(new OperationalError({ code: 'INVALID', message: 'Invalid' }))).toEqual({ name: 'OperationalError', code: 'INVALID', message: 'Invalid' });
  });
});

describe('retry', () => {
  it('retries with capped exponential delays using injected sleep', async () => {
    const operation = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw new Error('temporary');
      return 'done';
    });
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    await expect(retry(operation, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 15, sleep, onRetry })).resolves.toBe('done');
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 15);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(retryDelay(4, 10, 50)).toBe(50);
    expect(() => retryDelay(0, 10, 50)).toThrow(RangeError);
  });

  it('does not retry errors rejected by the policy', async () => {
    const error = new Error('permanent');
    const operation = vi.fn(async () => { throw error; });
    await expect(retry(operation, { shouldRetry: () => false })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown', () => {
  it('runs handlers in LIFO order and keeps running after failures', async () => {
    const manager = createShutdownManager();
    const calls: string[] = [];
    manager.add('first', () => { calls.push('first'); });
    manager.add('broken', () => { calls.push('broken'); throw new Error('failed'); });
    manager.add('last', () => { calls.push('last'); });
    await expect(manager.run('SIGTERM')).resolves.toMatchObject({ signal: 'SIGTERM', failures: [{ name: 'broken' }] });
    expect(calls).toEqual(['last', 'broken', 'first']);
  });

  it('registers and unregisters process signal listeners', async () => {
    const listeners = new Map<string, () => void>();
    const processLike = { on: vi.fn((signal: string, listener: () => void) => { listeners.set(signal, listener); }), off: vi.fn((signal: string) => { listeners.delete(signal); }) };
    const manager = createShutdownManager();
    const handler = vi.fn();
    manager.add('handler', handler);
    const unregister = registerShutdownSignals(manager, { process: processLike, signals: ['SIGINT'] });
    listeners.get('SIGINT')?.();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('SIGINT'));
    unregister();
    expect(processLike.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});

describe('health and readiness', () => {
  it('reports all health checks while retaining failures', async () => {
    await expect(checkHealth([{ name: 'database', check: () => undefined }, { name: 'cache', check: () => { throw new Error('unavailable'); } }])).resolves.toEqual({
      status: 'error',
      checks: [
        { name: 'database', status: 'ok' },
        { name: 'cache', status: 'error', error: { name: 'Error', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }
      ]
    });
  });

  it('allows readiness to change explicitly', () => {
    const readiness = createReadiness(false, { component: 'worker' });
    expect(readiness.report()).toEqual({ status: 'not_ready', details: { component: 'worker' } });
    readiness.setReady(true);
    expect(readiness.isReady()).toBe(true);
    expect(readiness.report().status).toBe('ready');
  });
});
