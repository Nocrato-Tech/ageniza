import { captureUnexpectedError, resolveRequestId, retry, type CoreLogger, type RetryOptions } from '@ageniza/core';

export interface WorkerJob<TPayload> {
  readonly name: string;
  readonly payload: TPayload;
  /** Optional caller-provided flow identifier; payloads themselves are never logged. */
  readonly correlationId?: string;
}

export interface JobContext {
  readonly logger: CoreLogger;
  readonly signal: AbortSignal;
}

export type JobHandler<TPayload> = (job: WorkerJob<TPayload>, context: JobContext) => Promise<void>;

export interface RegisteredJob<TPayload> {
  readonly name: string;
  readonly handler: JobHandler<TPayload>;
  readonly retry?: RetryOptions;
}

export interface JobProcessor {
  submit<TPayload>(job: WorkerJob<TPayload>, definition: RegisteredJob<TPayload>): Promise<void>;
  stopAccepting(): void;
  drain(): Promise<void>;
  readonly inFlight: number;
  readonly accepting: boolean;
}

/** Explicitly processes submitted work; durable dispatch needs an approved concrete store. */
export const createJobProcessor = (options: { logger: CoreLogger; signal?: AbortSignal }): JobProcessor => {
  let accepting = true;
  const controller = new AbortController();
  const externalSignal = options.signal;

  const stop = (): void => {
    if (!accepting) return;
    accepting = false;
    externalSignal?.removeEventListener('abort', stop);
    controller.abort();
  };
  if (externalSignal?.aborted) stop();
  else externalSignal?.addEventListener('abort', stop, { once: true });

  const inFlight = new Set<Promise<void>>();

  const submit = async <TPayload>(
    job: WorkerJob<TPayload>,
    definition: RegisteredJob<TPayload>
  ): Promise<void> => {
    if (!accepting || controller.signal.aborted) {
      throw new Error('Worker is shutting down and no longer accepts jobs.');
    }
    if (job.name !== definition.name) {
      throw new Error(`Job '${job.name}' does not match handler '${definition.name}'.`);
    }

    const startedAt = performance.now();
    const correlationId = resolveRequestId(job.correlationId);
    const work = retry(
      async (attempt) => {
        const context = { operation: job.name, correlationId, attempt };
        options.logger.debug(context, 'Processing worker job');
        await definition.handler(job, {
          logger: options.logger.child({ job: job.name, ...context }),
          signal: controller.signal
        });
      },
      {
        ...definition.retry,
        onRetry: async (context) => {
          options.logger.warn(
            { operation: job.name, attempt: context.attempt, delayMs: context.delayMs, error: { name: context.error instanceof Error ? context.error.name : 'UnknownError', code: 'JOB_RETRY' } },
            'Retrying worker job'
          );
          await definition.retry?.onRetry?.(context);
        }
      }
    );

    inFlight.add(work);
    try {
      await work;
      options.logger.info({ operation: job.name, correlationId, status: 'ok', durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, 'Worker job completed');
    } catch (error) {
      const telemetry = { operation: job.name, correlationId, status: 'failed', durationMs: Math.round((performance.now() - startedAt) * 100) / 100 };
      options.logger.error({ ...telemetry, error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'JOB_FAILED' } }, 'Worker job failed unexpectedly');
      captureUnexpectedError(error, telemetry);
      throw error;
    } finally {
      inFlight.delete(work);
    }
  };

  return {
    submit,
    stopAccepting: stop,
    drain: async () => {
      await Promise.allSettled([...inFlight]);
    },
    get inFlight() {
      return inFlight.size;
    },
    get accepting() {
      return accepting;
    }
  };
};
