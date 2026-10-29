import { createServer, type RequestListener, type Server } from 'node:http';
import { PassThrough } from 'node:stream';

import type { WorkerConfig } from '@ageniza/config/server';
import { createLogger, type SignalProcess } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { describe, expect, it, vi } from 'vitest';

import { createJobProcessor } from './jobs.js';
import type { DurableQueue } from './queue.js';
import { smokeJob } from './smoke-job.js';
import { actorContextPurgeIntervalMs, createWorkerRuntime, type CreateWorkerRuntimeOptions } from './worker.js';

const config: WorkerConfig = {
  service: 'worker',
  environment: 'test',
  databaseUrl: 'postgresql://127.0.0.1:54322/ageniza',
  deployVersion: 'test-commit',
  healthHost: '127.0.0.1',
  healthPort: 0,
  smokeJob: false,
  concurrency: 1,
  mediaProcessing: {
    ffmpegTimeoutSeconds: 240,
    maxDurationSeconds: 1_800,
    thumbnailWidthPixels: 640,
    previewMaxHeightPixels: 720,
    previewMaxOutputBytes: 300 * 1024 * 1024
  }
};

const createTestQueue = (): DurableQueue => ({
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  send: vi.fn(async () => 'job-id'),
  stop: vi.fn(async () => undefined)
});

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
    queue: createTestQueue(),
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

  it('starts the durable queue before reporting ready and stops it before closing the database', async () => {
    const order: string[] = [];
    const client = createTestDatabase();
    vi.mocked(client.close).mockImplementation(async () => {
      order.push('database.close');
    });
    const queue: DurableQueue = {
      ...createTestQueue(),
      start: vi.fn(async () => {
        order.push('queue.start');
      }),
      stop: vi.fn(async () => {
        order.push('queue.stop');
      })
    };
    const { runtime } = createTestRuntime({
      database: client,
      queue,
      readinessCheck: async () => {
        order.push('database.check');
      }
    });
    await runtime.start();
    expect(runtime.readiness.isReady()).toBe(true);
    await runtime.shutdown('SIGTERM');
    expect(order).toEqual(['database.check', 'queue.start', 'queue.stop', 'database.close']);
  });

  it('sweeps the actor context on an interval and stops sweeping after shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const client = createTestDatabase();
      const { runtime } = createTestRuntime({ database: client, readinessCheck: async () => undefined });
      await runtime.start();
      expect(client.knex.raw).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(actorContextPurgeIntervalMs);
      expect(client.knex.raw).toHaveBeenCalledWith('select app_private.purge_actor_context()');

      await runtime.shutdown();
      vi.mocked(client.knex.raw).mockClear();
      await vi.advanceTimersByTimeAsync(actorContextPurgeIntervalMs);
      expect(client.knex.raw).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sweeping after a purge failure without an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = createTestDatabase();
      vi.mocked(client.knex.raw).mockRejectedValue(new Error('database unavailable'));
      const { runtime } = createTestRuntime({ database: client, readinessCheck: async () => undefined });
      await runtime.start();

      await vi.advanceTimersByTimeAsync(actorContextPurgeIntervalMs);
      await vi.advanceTimersByTimeAsync(actorContextPurgeIntervalMs);
      expect(client.knex.raw).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      await runtime.shutdown();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });

  it('does not become ready when the durable queue cannot start', async () => {
    const client = createTestDatabase();
    const queue: DurableQueue = {
      ...createTestQueue(),
      start: vi.fn(async () => {
        throw new Error('pg-boss database requires migrations');
      })
    };
    const { runtime, server } = createTestRuntime({ database: client, queue, readinessCheck: async () => undefined });
    await expect(runtime.start()).rejects.toThrow('requires migrations');
    expect(runtime.readiness.isReady()).toBe(false);
    expect(server.listening).toBe(false);
    expect(queue.stop).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('registers the daily archive of ended contracts on the queue, scheduled, with or without object storage', () => {
    const queue = createTestQueue();
    createTestRuntime({ queue });
    const registered = vi.mocked(queue.register).mock.calls.map(([definition]) => definition);
    const archive = registered.find((definition) => definition.name === 'clients.archive-due');
    expect(archive?.schedule).toEqual({ cron: '10 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(archive?.runOnStart).toBe(true);
    expect(registered.filter((definition) => definition.name === 'clients.archive-due')).toHaveLength(1);
    // Video processing needs storage and is absent from this config; the archive does not need it.
    expect(registered.map((definition) => definition.name)).toEqual(['clients.archive-due', 'accounts.purge-unconfirmed']);
  });

  it('registers the purge of the unconfirmed accounts, daily at 04:10, whether or not object storage is configured', () => {
    const queue = createTestQueue();
    createTestRuntime({ queue });
    const registered = vi.mocked(queue.register).mock.calls.map(([definition]) => definition);
    const purge = registered.find((definition) => definition.name === 'accounts.purge-unconfirmed');
    expect(purge?.schedule).toEqual({ cron: '10 4 * * *', timeZone: 'America/Sao_Paulo' });
    expect(purge?.runOnStart).toBe(true);
    expect(registered.filter((definition) => definition.name === 'accounts.purge-unconfirmed')).toHaveLength(1);
  });

  it('registers the purge of the removed media, daily, together with the video processing, only when object storage is configured', () => {
    const withStorage = createTestQueue();
    createTestRuntime({
      queue: withStorage,
      config: { ...config, storage: { endpoint: 'http://127.0.0.1:9000', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'bucket', forcePathStyle: true } }
    });
    const registered = vi.mocked(withStorage.register).mock.calls.map(([definition]) => definition);
    expect(registered.map((definition) => definition.name)).toEqual(['clients.archive-due', 'accounts.purge-unconfirmed', 'media.process-video', 'media.purge-removed']);
    const purge = registered.find((definition) => definition.name === 'media.purge-removed');
    expect(purge?.schedule).toEqual({ cron: '40 3 * * *', timeZone: 'America/Sao_Paulo' });
    expect(purge?.runOnStart).toBe(true);

    const withoutStorage = createTestQueue();
    createTestRuntime({ queue: withoutStorage });
    expect(vi.mocked(withoutStorage.register).mock.calls.map(([definition]) => definition.name)).not.toContain('media.purge-removed');
  });

  it('registers the e-mail to the clients when the transport and the origin of the web app are configured, once a minute', () => {
    const queue = createTestQueue();
    const emailSender = { send: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    createTestRuntime({ queue, emailSender, config: { ...config, appPublicUrl: 'http://127.0.0.1:5173' } });

    const registered = vi.mocked(queue.register).mock.calls.map(([definition]) => definition);
    const email = registered.find((definition) => definition.name === 'notifications.send-client-content-emails');
    expect(email?.schedule).toEqual({ cron: '* * * * *', timeZone: 'America/Sao_Paulo' });
    expect(email?.runOnStart).toBe(true);
    expect(registered.map((definition) => definition.name)).toEqual(['clients.archive-due', 'accounts.purge-unconfirmed', 'notifications.send-client-content-emails']);
  });

  it.each([
    ['the transport', { appPublicUrl: 'http://127.0.0.1:5173' }, undefined],
    ['the origin of the web app', {}, { send: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }]
  ])('does not register the e-mail to the clients without %s, and says so', (_missing, extraConfig, emailSender) => {
    const queue = createTestQueue();
    const output: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    createTestRuntime({ queue, logger: createLogger({}, destination), ...(emailSender === undefined ? {} : { emailSender }), config: { ...config, ...extraConfig } });

    expect(vi.mocked(queue.register).mock.calls.map(([definition]) => definition.name)).toEqual(['clients.archive-due', 'accounts.purge-unconfirmed']);
    expect(output.join('')).toContain('the e-mails to the clients will not be sent');
  });

  describe('the renewal of the subscriptions (issue #772)', () => {
    const AGENCY = '0b1f6c9e-1111-4222-8333-444455556666';
    const renewalDatabase = (): DatabaseClient => ({
      ...createTestDatabase(),
      knex: {
        raw: vi.fn(async (sql: string) => {
          if (sql.includes('agencies_due_for_renewal')) return { rows: [{ id: AGENCY }] };
          if (sql.includes('renewal_quote')) return { rows: [{ period_end: new Date('2026-11-29T12:00:00.000Z'), amount_cents: 9_700, provider: 'simulado' }] };
          if (sql.includes('renew_subscription')) return { rows: [{ renewed: true }] };
          return undefined;
        })
      } as unknown as DatabaseClient['knex']
    });
    const providerOf = () => {
      const charge = vi.fn(async (request: { amountCents: number; idempotencyKey: string }) =>
        ({ status: 'approved' as const, providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents }));
      return { charge, provider: { name: 'simulado' as const, charge, refund: vi.fn(async () => ({ status: 'refunded' as const })) } };
    };

    it('registers it every five minutes when a payment provider exists, and not without one, saying so', () => {
      const withProvider = createTestQueue();
      createTestRuntime({ queue: withProvider, paymentProvider: providerOf().provider });
      const registered = vi.mocked(withProvider.register).mock.calls.map(([definition]) => definition);
      expect(registered.map((definition) => definition.name)).toEqual(['clients.archive-due', 'accounts.purge-unconfirmed', 'subscriptions.renew-due']);
      const renewal = registered.find((definition) => definition.name === 'subscriptions.renew-due');
      expect(renewal?.schedule).toEqual({ cron: '*/5 * * * *', timeZone: 'America/Sao_Paulo' });
      expect(renewal?.runOnStart).toBe(true);

      const withoutProvider = createTestQueue();
      const output: string[] = [];
      const destination = new PassThrough();
      destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      createTestRuntime({ queue: withoutProvider, logger: createLogger({}, destination) });
      expect(vi.mocked(withoutProvider.register).mock.calls.map(([definition]) => definition.name)).not.toContain('subscriptions.renew-due');
      expect(output.join('')).toContain('the subscriptions will not be renewed');
    });

    it('charges the renewals with the provider it was given, and passes the simulated outcome of the config to it', async () => {
      for (const simulatedRenewalOutcome of ['declined', 'approved', undefined] as const) {
        const queue = createTestQueue();
        const { provider, charge } = providerOf();
        createTestRuntime({
          queue,
          database: renewalDatabase(),
          paymentProvider: provider,
          config: { ...config, ...(simulatedRenewalOutcome === undefined ? {} : { simulatedRenewalOutcome }) }
        });
        const renewal = vi.mocked(queue.register).mock.calls.map(([definition]) => definition).find((definition) => definition.name === 'subscriptions.renew-due')!;

        await renewal.handler({ id: 'job-1', name: 'subscriptions.renew-due', payload: {}, attempt: 1 }, { logger: createLogger({ enabled: false }), signal: new AbortController().signal });

        expect(charge).toHaveBeenCalledTimes(1);
        const request = charge.mock.calls[0]![0] as { testOutcome?: string };
        if (simulatedRenewalOutcome === undefined) expect(request).not.toHaveProperty('testOutcome');
        else expect(request.testOutcome).toBe(simulatedRenewalOutcome);
      }
    });
  });

  it('closes the e-mail transport on shutdown', async () => {
    const emailSender = { send: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const { runtime } = createTestRuntime({ emailSender, config: { ...config, appPublicUrl: 'http://127.0.0.1:5173' } });

    await runtime.shutdown();

    expect(emailSender.close).toHaveBeenCalledOnce();
  });

  it('runs smoke mode without a durable queue, since it has no database', () => {
    const runtime = createWorkerRuntime({
      config: { ...config, smokeJob: true },
      logger: createLogger({ enabled: false }),
      database: createTestDatabase(),
      registerSignals: false
    });
    expect(runtime.queue).toBeUndefined();
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
