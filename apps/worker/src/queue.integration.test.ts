import { randomUUID } from 'node:crypto';

import { createLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, raw, type DatabaseClient, resolveIntegrationDatabaseUrls } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDurableQueue, deadLetterQueueName, type CreateDurableQueueOptions, type DurableJobDefinition, type DurableQueue } from './queue.js';

// Runs against the migrated local database (`pnpm db:migrate`) as the application role, so it also
// proves the queue works with data access alone: no CREATE, ALTER, or ownership in the pgboss schema.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const prefix = `test.${randomUUID().slice(0, 8)}`;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const running = new Set<DurableQueue>();

beforeAll(() => {
  assertLocalDatabaseUrl(applicationUrl);
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  try {
    await Promise.allSettled([...running].map((queue) => queue.stop()));
    // Source queues reference their dead letter queue, so they go first.
    await owner?.knex.raw("select pgboss.delete_queue(name) from pgboss.queue where name like ? and name not like '%.dead'", [`${prefix}.%`]);
    await owner?.knex.raw('select pgboss.delete_queue(name) from pgboss.queue where name like ?', [`${prefix}.%`]);
  } finally {
    await application?.close();
    await owner?.close();
  }
});

const openQueue = async (
  definitions: ReadonlyArray<DurableJobDefinition<object>>,
  overrides: Partial<CreateDurableQueueOptions> = {}
): Promise<DurableQueue> => {
  const queue = createDurableQueue({
    connectionString: applicationUrl,
    logger: createLogger({ enabled: false }),
    concurrency: 1,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 1,
    ...overrides
  });
  for (const definition of definitions) queue.register(definition);
  running.add(queue);
  await queue.start();
  return queue;
};

const closeQueue = async (queue: DurableQueue): Promise<void> => {
  await queue.stop();
  running.delete(queue);
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const stateOf = async (id: string): Promise<string | undefined> => {
  const result = await raw<{ rows: Array<{ state: string }> }>(getApplication().knex, 'select state::text as state from pgboss.job where id = ?', [id]);
  return result.rows[0]?.state;
};

const statesIn = async (name: string): Promise<string[]> => {
  const result = await raw<{ rows: Array<{ state: string }> }>(getApplication().knex, 'select state::text as state from pgboss.job where name = ? order by created_on', [name]);
  return result.rows.map((row) => row.state);
};

const waitForState = (id: string, state: string, timeout = 20_000): Promise<void> =>
  vi.waitFor(async () => {
    expect(await stateOf(id)).toBe(state);
  }, { timeout, interval: 250 });

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('durable job queue on PostgreSQL', { timeout: 60_000 }, () => {
  it('keeps a job sent while no worker runs and processes it after a restart', async () => {
    const name = `${prefix}.restart`;
    const seen: Array<{ payload: object; attempt: number }> = [];
    const definition: DurableJobDefinition<object> = {
      name,
      handler: async (job) => {
        seen.push({ payload: job.payload, attempt: job.attempt });
      }
    };

    // A first worker creates the queue and goes away before any job exists.
    await closeQueue(await openQueue([definition]));

    // The job is sent while nothing consumes the queue, and stays stored.
    const producer = await openQueue([]);
    const id = await producer.send(name, { assetId: 'asset-1' });
    await closeQueue(producer);
    expect(await statesIn(name)).toEqual(['created']);

    const worker = await openQueue([definition]);
    await waitForState(id, 'completed');
    expect(seen).toEqual([{ payload: { assetId: 'asset-1' }, attempt: 1 }]);
    await closeQueue(worker);
  });

  it('retries a transient failure with backoff and then completes it', async () => {
    const name = `${prefix}.transient`;
    const attempts: Array<{ attempt: number; at: number }> = [];
    const worker = await openQueue([{
      name,
      retryLimit: 2,
      retryDelaySeconds: 1,
      handler: async (job) => {
        attempts.push({ attempt: job.attempt, at: Date.now() });
        if (job.attempt === 1) throw new Error('temporary outage');
      }
    }]);
    const id = await worker.send(name, {});
    await waitForState(id, 'completed');
    expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    // With backoff the first retry waits between half and all of retryDelaySeconds.
    const [first, second] = attempts;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(450);
    await closeQueue(worker);
  });

  it('records a permanent failure and keeps the job visible in its dead letter queue', async () => {
    const name = `${prefix}.permanent`;
    let attempts = 0;
    const worker = await openQueue([{
      name,
      retryLimit: 1,
      retryDelaySeconds: 1,
      handler: async () => {
        attempts += 1;
        throw new Error('corrupt input');
      }
    }]);
    const id = await worker.send(name, { assetId: 'asset-2' });
    await waitForState(id, 'failed');
    expect(attempts).toBe(2);
    await vi.waitFor(async () => {
      expect(await statesIn(deadLetterQueueName(name))).toEqual(['created']);
    }, { timeout: 5_000, interval: 250 });
    await closeQueue(worker);
  });

  it('lets a running job finish when the worker stops', async () => {
    const name = `${prefix}.drain`;
    const started = deferred();
    const worker = await openQueue([{
      name,
      handler: async () => {
        started.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }]);
    const id = await worker.send(name, {});
    await started.promise;
    await closeQueue(worker);
    expect(await stateOf(id)).toBe('completed');
  });

  it('hands a job that outlives the shutdown drain to the next worker', async () => {
    const name = `${prefix}.interrupted`;
    const attempts: number[] = [];
    const started = deferred();
    const release = new AbortController();
    const definition: DurableJobDefinition<object> = {
      name,
      retryLimit: 2,
      retryDelaySeconds: 1,
      handler: async (job, { signal }) => {
        attempts.push(job.attempt);
        if (job.attempt > 1) return;
        started.resolve();
        // Simulates work longer than the drain window; released by the test once the worker is gone.
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          release.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('interrupted by shutdown');
      }
    };

    const first = await openQueue([definition], { shutdownTimeoutMs: 1_000 });
    const id = await first.send(name, {});
    await started.promise;
    await closeQueue(first);
    release.abort();
    // The drain gave up, so the job was failed back into retry rather than lost or left active.
    expect(await stateOf(id)).toBe('retry');

    const second = await openQueue([definition]);
    await waitForState(id, 'completed');
    expect(attempts).toEqual([1, 2]);
    await closeQueue(second);
  });
});
