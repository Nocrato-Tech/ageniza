import { createServer, type RequestListener, type Server } from 'node:http';

import type { WorkerConfig } from '@ageniza/config/server';
import {
  checkHealth,
  captureUnexpectedError,
  createReadiness,
  createShutdownManager,
  flushServerSentry,
  withLogContext,
  type CoreLogger,
  type HealthReport,
  type Readiness,
  type ShutdownResult,
  type SignalProcess
} from '@ageniza/core';
import { createDatabaseClient, type DatabaseClient } from '@ageniza/database';

import { createJobProcessor, type JobProcessor } from './jobs.js';

type WorkerSignal = 'SIGINT' | 'SIGTERM';
type ReadinessCheck = () => Promise<void>;

export interface WorkerRuntime {
  readonly logger: CoreLogger;
  readonly database: DatabaseClient;
  readonly jobs: JobProcessor;
  readonly readiness: Readiness;
  health(): Promise<HealthReport>;
  start(): Promise<void>;
  shutdown(signal?: WorkerSignal): Promise<ShutdownResult>;
}

export interface CreateWorkerRuntimeOptions {
  readonly config: WorkerConfig;
  readonly logger: CoreLogger;
  readonly database?: DatabaseClient;
  readonly registerSignals?: boolean;
  readonly process?: SignalProcess;
  readonly readinessCheck?: ReadinessCheck;
  readonly createHealthServer?: (listener: RequestListener) => Server;
}

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const writeJson = (
  response: Parameters<RequestListener>[1],
  statusCode: number,
  body: Readonly<Record<string, unknown>>
): void => {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
};

/** Composes shared config, logger, Knex, internal probes, jobs, and shutdown exactly once. */
export const createWorkerRuntime = (options: CreateWorkerRuntimeOptions): WorkerRuntime => {
  const logger = withLogContext(options.logger, { module: 'worker', environment: options.config.environment, service: options.config.service, deployVersion: options.config.deployVersion });
  const database = options.database ?? createDatabaseClient({ connectionString: options.config.databaseUrl });
  const readiness = createReadiness(false, { service: 'worker' });
  const jobs = createJobProcessor({ logger });
  const shutdownManager = createShutdownManager();
  shutdownManager.add('sentry', async () => { await flushServerSentry(); });
  const processRef = options.process ?? process;
  const checkDatabase = options.readinessCheck ?? (async () => {
    await database.knex.raw('select 1');
  });

  const health = (): Promise<HealthReport> => {
    if (!readiness.isReady()) {
      return checkHealth([{ name: 'worker', check: () => { throw new Error('Worker is not ready.'); } }]);
    }
    return checkHealth([
      { name: 'worker', check: () => undefined },
      { name: 'database', check: checkDatabase }
    ]);
  };

  const handleProbe: RequestListener = (request, response) => {
    const startedAt = performance.now();
    const sendProbe = (statusCode: number, body: Readonly<Record<string, unknown>>): void => {
      writeJson(response, statusCode, body);
      const context = { route: request.url, operation: `${request.method} ${request.url}`, statusCode, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 };
      if (statusCode >= 400) logger.warn(context, 'Health probe failed');
      else logger.debug(context, 'Health probe completed');
    };
    if (request.method !== 'GET') {
      sendProbe(405, { status: 'method_not_allowed' });
      return;
    }
    if (request.url === '/health') {
      sendProbe(200, { status: 'ok' });
      return;
    }
    if (request.url !== '/ready') {
      sendProbe(404, { status: 'not_found' });
      return;
    }

    void health()
      .then((report) => {
        const ready = report.status === 'ok';
        sendProbe(ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      })
      .catch(() => {
        sendProbe(503, { status: 'not_ready' });
      });
  };

  const server = (options.createHealthServer ?? createServer)(handleProbe);
  let unregisterSignals: (() => void) | undefined;
  let listenPromise: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let stopping = false;

  shutdownManager.add('database', async () => {
    await database.close();
  });
  shutdownManager.add('jobs', async () => {
    jobs.stopAccepting();
    await jobs.drain();
  });
  shutdownManager.add('health-server', async () => {
    if (server.listening) await close(server);
  });
  shutdownManager.add('signals', () => {
    unregisterSignals?.();
  });
  shutdownManager.add('readiness', () => {
    readiness.setReady(false);
  });

  const runShutdown = async (signal?: WorkerSignal): Promise<ShutdownResult> => {
    stopping = true;
    readiness.setReady(false);
    jobs.stopAccepting();
    if (listenPromise !== undefined) {
      try {
        await listenPromise;
      } catch {
        // The startup path reports the original listener failure.
      }
    }
    const result = await shutdownManager.run(signal);
    if (result.failures.length > 0) {
      logger.error({ failedHandlers: result.failures.map((failure) => failure.name) }, 'Worker shutdown completed with failures');
    } else {
      logger.info({ signal }, 'Worker shutdown completed');
    }
    return result;
  };

  const runtime: WorkerRuntime = {
    logger,
    database,
    jobs,
    readiness,
    health,
    start() {
      if (stopping) return Promise.reject(new Error('Worker is shutting down and cannot start.'));
      startPromise ??= (async () => {
        try {
          listenPromise = listen(server, options.config.healthHost, options.config.healthPort);
          await listenPromise;
          if (stopping) throw new Error('Worker stopped during startup.');
          await checkDatabase();
          if (stopping) throw new Error('Worker stopped during startup.');
          readiness.setReady(true);
          logger.info(
            {
              environment: options.config.environment,
              healthHost: options.config.healthHost,
              healthPort: options.config.healthPort
            },
            'Worker ready'
          );
        } catch (error) {
          captureUnexpectedError(error, { environment: options.config.environment, service: options.config.service, deployVersion: options.config.deployVersion, operation: 'worker.startup', status: 'failed' });
          await runShutdown();
          throw error;
        }
      })();
      return startPromise;
    },
    shutdown: runShutdown
  };

  if (options.registerSignals ?? true) {
    const listeners = (['SIGINT', 'SIGTERM'] as const).map((signal) => ({
      signal,
      listener: (): void => {
        void runtime.shutdown(signal);
      }
    }));
    for (const { signal, listener } of listeners) processRef.on(signal, listener);
    unregisterSignals = () => {
      for (const { signal, listener } of listeners) processRef.off(signal, listener);
    };
  }

  return runtime;
};
