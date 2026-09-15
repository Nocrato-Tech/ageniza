import { createServer, type RequestListener, type Server } from 'node:http';
import { PassThrough } from 'node:stream';

import type { WorkerConfig } from '@ageniza/config/server';
import { createLogger, type SignalProcess } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { createJobProcessor } from './jobs.js';
import { smokeJob } from './smoke-job.js';
import { createWorkerRuntime, type CreateWorkerRuntimeOptions } from './worker.js';

const config: WorkerConfig = {
  service: 'worker',
  environment: 'test',
  databaseUrl: 'postgresql://127.0.0.1:54322/postgres',
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseServiceRoleKey: 'test',
  deployVersion: 'test-commit',
  healthHost: '127.0.0.1',
  healthPort: 0,
  smokeJob: false
};

const createTestDatabase = (): DatabaseClient => ({
  knex: { raw: vi.fn(async () => undefined) } as unknown as DatabaseClient['knex'],
  pool: { min: 0, max: 1, idleTimeoutMillis: 1, acquireTimeoutMillis: 1 },
  close: vi.fn(async () => undefined),
  transaction: vi.fn()
});

const createTestRuntime = (
  overrides: Partial<CreateWorkerRuntimeOptions> = {}
): { runtime: ReturnType<typeof createWorkerRuntime>; server: Server; database: DatabaseClient } => {
  let server: Server | undefined;
  const database = overrides.database ?? createTestDatabase();
  const runtime = createWorkerRuntime({
    config,
    logger: createLogger({ enabled: false }),
    database,
    registerSignals: false,
    createHealthServer: (listener: RequestListener) => {
      server = createServer(listener);
      return server;
    },
    ...overrides
  });
  if (server === undefined) throw new Error('Test health server was not created.');
  return { runtime, server, database };
};

const probe = async (server: Server, path: string): Promise<Response> => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test health server is not listening.');
  return fetch(`http://127.0.0.1:${address.port}${path}`);
};

describe('worker runtime', () => {
  it('serves liveness and continuously gates readiness on the database', async () => {
    let finishStartup: (() => void) | undefined;
    let databaseHealthy = true;
    let checks = 0;
    const readinessCheck = vi.fn(async () => {
      checks += 1;
      if (checks === 1) {
        await new Promise<void>((resolve) => {
          finishStartup = resolve;
        });
      }
      if (!databaseHealthy) throw new Error('database unavailable');
    });
    const { runtime, server } = createTestRuntime({ readinessCheck });

    const starting = runtime.start();
    await vi.waitFor(() => expect(server.listening).toBe(true));
    expect((await probe(server, '/health')).status).toBe(200);
    expect((await probe(server, '/ready')).status).toBe(503);

    finishStartup?.();
    await starting;
    expect((await probe(server, '/ready')).status).toBe(200);

    databaseHealthy = false;
    expect((await probe(server, '/ready')).status).toBe(503);
    expect(await (await probe(server, '/missing')).json()).toEqual({ status: 'not_found' });
    expect((await probe(server, '/health')).headers.get('cache-control')).toBe('no-store');
    await runtime.shutdown();
  });

  it('processes a smoke job and retries bounded failures', async () => {
    const { runtime } = createTestRuntime({ readinessCheck: async () => undefined });
    const processed = vi.fn();
    await runtime.start();
    await runtime.jobs.submit(
      { name: 'worker.smoke', payload: { message: 'test' } },
      smokeJob(processed)
    );

    let attempts = 0;
    await runtime.jobs.submit(
      { name: 'retry', payload: {} },
      {
        name: 'retry',
        retry: { maxAttempts: 2, baseDelayMs: 0, sleep: async () => undefined },
        handler: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient');
        }
      }
    );

    expect(processed).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
    await runtime.shutdown();
  });

  it('preserves valid job correlation IDs and generates one when callers omit them', async () => {
    const jobs = createJobProcessor({ logger: createLogger({ enabled: false }) });
    const observed: string[] = [];
    const definition = {
      name: 'correlated',
      handler: async (_job: { name: string; payload: unknown }, context: { logger: ReturnType<typeof createLogger> }) => {
        observed.push(String(context.logger.bindings().correlationId));
      }
    };
    await jobs.submit({ name: 'correlated', payload: {}, correlationId: 'flow-42' }, definition);
    await jobs.submit({ name: 'correlated', payload: {} }, definition);
    expect(observed[0]).toBe('flow-42');
    expect(observed[1]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('records one final failure after retries without logging payloads', async () => {
    const destination = new PassThrough();
    const output: string[] = [];
    destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const jobs = createJobProcessor({ logger: createLogger({}, destination) });
    await expect(jobs.submit(
      { name: 'fails', payload: { password: 'not-logged' }, correlationId: 'flow-42' },
      { name: 'fails', retry: { maxAttempts: 2, baseDelayMs: 0, sleep: async () => undefined }, handler: async () => { throw new Error('Authorization: Bearer not-logged'); } }
    )).rejects.toThrow('Authorization');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const records = output.join('').trim().split('\n').map((line) => JSON.parse(line) as { msg: string; operation?: string; status?: string });
    expect(records.filter((record) => record.msg === 'Retrying worker job')).toHaveLength(1);
    expect(records.filter((record) => record.msg === 'Worker job failed unexpectedly')).toEqual([expect.objectContaining({ operation: 'fails', status: 'failed' })]);
    expect(output.join('')).not.toContain('not-logged');
  });

  it('rejects new jobs, aborts handlers, drains work, and closes the database once', async () => {
    const client = createTestDatabase();
    const { runtime } = createTestRuntime({ database: client });
    let release: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const pending = runtime.jobs.submit(
      { name: 'slow', payload: {} },
      {
        name: 'slow',
        handler: async (_job, context) => {
          receivedSignal = context.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
    );

    const closing = runtime.shutdown('SIGTERM');
    expect(receivedSignal?.aborted).toBe(true);
    await expect(runtime.jobs.submit(
      { name: 'slow', payload: {} },
      { name: 'slow', handler: async () => undefined }
    )).rejects.toThrow('no longer accepts');
    release?.();
    await pending;
    const [first, second] = await Promise.all([closing, runtime.shutdown('SIGTERM')]);
    expect(first.failures).toEqual([]);
    expect(second).toBe(first);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('stops accepting jobs when an external abort signal fires', async () => {
    const external = new AbortController();
    const jobs = createJobProcessor({
      logger: createLogger({ enabled: false }),
      signal: external.signal
    });
    external.abort();
    expect(jobs.accepting).toBe(false);
    await expect(jobs.submit(
      { name: 'ignored', payload: {} },
      { name: 'ignored', handler: async () => undefined }
    )).rejects.toThrow('no longer accepts');
  });

  it('cleans up a listener and database after startup readiness fails', async () => {
    const client = createTestDatabase();
    const { runtime, server } = createTestRuntime({
      database: client,
      readinessCheck: async () => {
        throw new Error('database unavailable');
      }
    });
    await expect(runtime.start()).rejects.toThrow('database unavailable');
    expect(server.listening).toBe(false);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('routes process signals through the same idempotent shutdown path', async () => {
    const listeners = new Map<string, () => void>();
    const processStub: SignalProcess = {
      on: (signal, listener) => {
        listeners.set(signal, listener);
      },
      off: (signal) => {
        listeners.delete(signal);
      }
    };
    const client = createTestDatabase();
    const { runtime, server } = createTestRuntime({
      database: client,
      process: processStub,
      registerSignals: true,
      readinessCheck: async () => undefined
    });
    await runtime.start();
    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
    expect(runtime.readiness.isReady()).toBe(false);
    expect(server.listening).toBe(false);
  });
});
