import { serializeError, type SerializedError } from './errors.js';
import type { MaybePromise, StructuredData } from './types.js';

export interface HealthCheck { name: string; check: () => MaybePromise<void>; }
export interface HealthCheckResult { name: string; status: 'ok' | 'error'; error?: SerializedError; }
export interface HealthReport { status: 'ok' | 'error'; checks: readonly HealthCheckResult[]; }

/** Runs named infrastructure checks and returns a transport-neutral health report. */
export const checkHealth = async (checks: readonly HealthCheck[]): Promise<HealthReport> => {
  const results: HealthCheckResult[] = [];
  for (const { name, check } of checks) {
    try {
      await check();
      results.push({ name, status: 'ok' });
    } catch (error) {
      results.push({ name, status: 'error', error: serializeError(error) });
    }
  }
  return { status: results.some((result) => result.status === 'error') ? 'error' : 'ok', checks: results };
};

export interface Readiness {
  isReady(): boolean;
  setReady(value: boolean): void;
  report(): { status: 'ready' | 'not_ready'; details?: StructuredData };
}

/** Keeps explicit process readiness state without assuming an HTTP server. */
export const createReadiness = (initiallyReady = false, details?: StructuredData): Readiness => {
  let ready = initiallyReady;
  return {
    isReady: () => ready,
    setReady: (value) => { ready = value; },
    report: () => ({ status: ready ? 'ready' : 'not_ready', ...(details === undefined ? {} : { details }) })
  };
};
