import type { MaybePromise } from './types.js';

export interface RetryContext { attempt: number; delayMs: number; error: unknown; }
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  shouldRetry?: (error: unknown, attempt: number) => MaybePromise<boolean>;
  onRetry?: (context: RetryContext) => MaybePromise<void>;
}
export type RetryOperation<T> = (attempt: number) => MaybePromise<T>;

export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
/** Computes a capped exponential delay for a one-based failed attempt number. */
export const retryDelay = (attempt: number, baseDelayMs: number, maxDelayMs: number): number => {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  if (!Number.isFinite(baseDelayMs) || !Number.isFinite(maxDelayMs) || baseDelayMs < 0 || maxDelayMs < 0) {
    throw new RangeError('retry delays must be finite, non-negative numbers');
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
};

/** Retries an async operation with bounded exponential backoff. */
export const retry = async <T>(operation: RetryOperation<T>, options: RetryOptions = {}): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1_000;
  const pause = options.sleep ?? sleep;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  if (!Number.isFinite(baseDelayMs) || !Number.isFinite(maxDelayMs) || baseDelayMs < 0 || maxDelayMs < 0) {
    throw new RangeError('retry delays must be finite, non-negative numbers');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const canRetry = attempt < maxAttempts && ((await options.shouldRetry?.(error, attempt)) ?? true);
      if (!canRetry) throw error;
      const delayMs = retryDelay(attempt, baseDelayMs, maxDelayMs);
      await options.onRetry?.({ attempt, delayMs, error });
      await pause(delayMs);
    }
  }
  throw new Error('Retry exhausted unexpectedly');
};
