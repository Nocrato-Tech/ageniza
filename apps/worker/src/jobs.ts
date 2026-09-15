import { retry, type CoreLogger, type RetryOptions } from '@ageniza/core';

export interface WorkerJob<TPayload> {
  readonly name: string;
  readonly payload: TPayload;
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

    const work = retry(
      async (attempt) => {
        options.logger.debug({ job: job.name, attempt }, 'Processing worker job');
        await definition.handler(job, {
          logger: options.logger.child({ job: job.name, attempt }),
          signal: controller.signal
        });
      },
      {
        ...definition.retry,
        onRetry: async (context) => {
          options.logger.warn(
            { job: job.name, attempt: context.attempt, delayMs: context.delayMs, err: context.error },
            'Retrying worker job'
          );
          await definition.retry?.onRetry?.(context);
        }
      }
    );

    inFlight.add(work);
    try {
      await work;
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
