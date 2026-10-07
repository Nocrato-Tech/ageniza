import { captureUnexpectedError, type CoreLogger } from '@ageniza/core';
import { PgBoss, type JobWithMetadata } from 'pg-boss';

/**
 * Schema created by the job-queue migration in packages/database. The worker runs pg-boss with
 * migrate and createSchema disabled, so it never runs DDL and fails to start on a version mismatch.
 */
export const QUEUE_SCHEMA = 'pgboss';

/** Below the worker's Compose stop_grace_period (60s), so draining ends before Docker sends SIGKILL. */
export const QUEUE_SHUTDOWN_TIMEOUT_MS = 45_000;

export interface DurableJob<TPayload extends object> {
  readonly id: string;
  readonly name: string;
  readonly payload: TPayload;
  /** 1 on the first run. Delivery is at least once, so a handler can see the same job again. */
  readonly attempt: number;
}

export interface DurableJobContext {
  readonly logger: CoreLogger;
  /** Aborted when the worker stops; stop promptly and let the job be retried. */
  readonly signal: AbortSignal;
}

/**
 * A durable job type. The queue is not an authorization boundary: a handler must revalidate the tenant
 * and capability for any identifiers in the payload, and payloads must never carry secrets.
 */
export interface DurableJobDefinition<TPayload extends object> {
  readonly name: string;
  readonly handler: (job: DurableJob<TPayload>, context: DurableJobContext) => Promise<void>;
  /** Retries after the first attempt. At least 1, so a job interrupted by a deploy runs again. */
  readonly retryLimit?: number;
  /** First retry delay; later retries back off exponentially up to retryDelayMaxSeconds. */
  readonly retryDelaySeconds?: number;
  readonly retryDelayMaxSeconds?: number;
  /** An active job still running after this long is treated as crashed and retried. */
  readonly expireInSeconds?: number;
  /**
   * Caps how many of THIS job run at once, independently of the worker-wide concurrency. A
   * CPU-bound job (ffmpeg) needs a tighter bound than the worker as a whole, and lowering the
   * global setting to suit it would throttle every unrelated job too.
   */
  readonly concurrency?: number;
  /**
   * Sends the job on a cron schedule, in the given IANA time zone. Registered again at every start,
   * as an upsert keyed by the job name, so a restart never adds a second schedule. A tick missed
   * while no worker runs is not replayed: the next tick is the next run, or `runOnStart`.
   */
  readonly schedule?: { readonly cron: string; readonly timeZone: string };
  /**
   * Sends one job every time the queue starts, after the handler is registered. For a job whose schedule
   * can be missed while no worker runs and that is idempotent, so a restart catches up at once instead of
   * waiting for the next tick. Two workers starting together send two, which the handler must tolerate.
   */
  readonly runOnStart?: boolean;
}

export interface DurableQueue {
  /** Registers a job type; call before start. */
  register<TPayload extends object>(definition: DurableJobDefinition<TPayload>): void;
  start(): Promise<void>;
  send<TPayload extends object>(name: string, payload: TPayload): Promise<string>;
  /** Stops fetching, waits for running jobs, then fails whatever is left so it is retried. */
  stop(): Promise<void>;
}

export interface CreateDurableQueueOptions {
  readonly connectionString: string;
  readonly logger: CoreLogger;
  readonly concurrency: number;
  /** Test hooks; production uses the defaults. */
  readonly shutdownTimeoutMs?: number;
  readonly superviseIntervalSeconds?: number;
  readonly cronMonitorIntervalSeconds?: number;
  readonly pollingIntervalSeconds?: number;
}

const defaults = {
  retryLimit: 3,
  retryDelaySeconds: 10,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900
} as const;

/** Where a job goes after its last retry fails, kept visible until pg-boss retention removes it. */
export const deadLetterQueueName = (name: string): string => `${name}.dead`;

/**
 * A job's own cap never raises the worker-wide ceiling: WORKER_CONCURRENCY stays the budget for
 * the whole process, and a job may only ask for less of it.
 */
export const jobConcurrency = (jobLimit: number | undefined, workerLimit: number): number =>
  jobLimit === undefined ? workerLimit : Math.min(jobLimit, workerLimit);

const elapsedMs = (startedAt: number): number => Math.round((performance.now() - startedAt) * 100) / 100;

/** Runs one job with structured telemetry. Payloads and error messages are never logged. */
export const runDurableJob = async <TPayload extends object>(
  definition: DurableJobDefinition<TPayload>,
  job: JobWithMetadata<TPayload>,
  logger: CoreLogger
): Promise<void> => {
  const attempt = job.retryCount + 1;
  const jobLogger = logger.child({ queue: job.name, jobId: job.id, attempt });
  const startedAt = performance.now();
  jobLogger.debug('Processing durable job');
  try {
    await definition.handler({ id: job.id, name: job.name, payload: job.data, attempt }, { logger: jobLogger, signal: job.signal });
    jobLogger.info({ status: 'completed', durationMs: elapsedMs(startedAt) }, 'Durable job completed');
  } catch (error) {
    const durationMs = elapsedMs(startedAt);
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    if (job.retryCount < job.retryLimit) {
      jobLogger.warn({ status: 'retrying', durationMs, error: { name: errorName, code: 'DURABLE_JOB_RETRY' } }, 'Durable job failed and will be retried');
    } else {
      jobLogger.error({ status: 'failed', durationMs, error: { name: errorName, code: 'DURABLE_JOB_FAILED' } }, 'Durable job failed permanently');
      captureUnexpectedError(error, { operation: job.name, status: 'failed', durationMs });
    }
    throw error;
  }
};

export const createDurableQueue = (options: CreateDurableQueueOptions): DurableQueue => {
  const logger = options.logger.child({ module: 'queue' });
  const definitions = new Map<string, DurableJobDefinition<object>>();
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: QUEUE_SCHEMA,
    application_name: 'ageniza-worker-queue',
    // One connection per concurrent fetch loop plus room for supervision.
    max: options.concurrency + 2,
    migrate: false,
    createSchema: false,
    // Supervision expires jobs abandoned by a crash so they are retried; it needs only data access.
    supervise: true,
    ...(options.superviseIntervalSeconds === undefined ? {} : { superviseIntervalSeconds: options.superviseIntervalSeconds }),
    ...(options.cronMonitorIntervalSeconds === undefined ? {} : { cronMonitorIntervalSeconds: options.cronMonitorIntervalSeconds }),
    // REINDEX needs index ownership, which the application role deliberately lacks.
    reindex: false,
    // The cron monitor sends the jobs that declare a `schedule`; it writes only rows of the pgboss
    // schema the role already has data access to, and one worker at a time wins each pass.
    schedule: true,
    useListenNotify: false,
    persistWarnings: false,
    persistQueueStats: false
  });
  // Without a listener an 'error' event would crash the process; messages can contain SQL, so log names only.
  boss.on('error', (error) => {
    logger.error({ error: { name: error.name, code: 'QUEUE_ERROR' } }, 'Durable queue error');
    captureUnexpectedError(error, { operation: 'queue', status: 'failed' });
  });
  boss.on('warning', (warning) => {
    logger.warn({ warning: warning.message }, 'Durable queue warning');
  });

  let started = false;

  return {
    register(definition) {
      if (started) throw new Error('Register durable jobs before the queue starts.');
      if (definitions.has(definition.name)) throw new Error(`Durable job '${definition.name}' is already registered.`);
      const retryLimit = definition.retryLimit ?? defaults.retryLimit;
      if (!Number.isInteger(retryLimit) || retryLimit < 1) {
        throw new Error(`Durable job '${definition.name}' needs retryLimit of at least 1 so interrupted work runs again.`);
      }
      definitions.set(definition.name, definition as DurableJobDefinition<object>);
    },
    async start() {
      started = true;
      await boss.start();
      for (const definition of definitions.values()) {
        const deadLetter = deadLetterQueueName(definition.name);
        const queueOptions = {
          retryLimit: definition.retryLimit ?? defaults.retryLimit,
          retryDelay: definition.retryDelaySeconds ?? defaults.retryDelaySeconds,
          retryBackoff: true,
          retryDelayMax: definition.retryDelayMaxSeconds ?? defaults.retryDelayMaxSeconds,
          expireInSeconds: definition.expireInSeconds ?? defaults.expireInSeconds,
          deadLetter
        };
        await boss.createQueue(deadLetter);
        // createQueue ignores an existing queue, so apply changed retry settings explicitly.
        await boss.createQueue(definition.name, queueOptions);
        await boss.updateQueue(definition.name, queueOptions);
        if (definition.schedule !== undefined) {
          await boss.schedule(definition.name, definition.schedule.cron, {}, { tz: definition.schedule.timeZone });
        }
        // includeMetadata stays a literal so the handler is typed with retryCount, which gives the attempt.
        const workOptions = {
          batchSize: 1,
          localConcurrency: jobConcurrency(definition.concurrency, options.concurrency),
          includeMetadata: true as const,
          ...(options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds })
        };
        await boss.work<object, void, typeof workOptions>(definition.name, workOptions, async (jobs) => {
          for (const job of jobs) await runDurableJob(definition, job, logger);
        });
        if (definition.runOnStart === true) await boss.send(definition.name, {});
      }
      logger.info({ queues: [...definitions.keys()], concurrency: options.concurrency }, 'Durable queue started');
    },
    async send(name, payload) {
      const id = await boss.send(name, payload);
      if (id === null) throw new Error(`Durable queue refused a job for '${name}'.`);
      return id;
    },
    async stop() {
      await boss.stop({ graceful: true, close: true, timeout: options.shutdownTimeoutMs ?? QUEUE_SHUTDOWN_TIMEOUT_MS });
    }
  };
};
