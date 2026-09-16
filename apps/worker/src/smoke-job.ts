import type { RegisteredJob, WorkerJob } from './jobs.js';

export interface SmokeJobPayload {
  readonly message?: string;
}

export const smokeJob = (
  onProcessed?: (job: WorkerJob<SmokeJobPayload>) => void
): RegisteredJob<SmokeJobPayload> => ({
  name: 'worker.smoke',
  handler: async (job) => {
    onProcessed?.(job);
  }
});
