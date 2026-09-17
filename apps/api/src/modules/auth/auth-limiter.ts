import { createHash } from 'node:crypto';

import { HttpError } from '@ageniza/core';

import { AUTH_RATE_LIMITS, type AuthRateLimitWindow } from './policy.js';

export type AuthLimiterRoute = 'login' | 'forgot';
export type AuthLimiterDimension = 'ip' | 'email';

export interface AuthWindowCounter {
  count: number;
  resetAt: number;
}

export type AuthLimiterStore = Map<string, AuthWindowCounter>;

export interface AuthLimiterOptions {
  /** Injected clock for deterministic tests and controlled deployments. */
  now?: () => number;
  /** Optional store injection; the default is process-local memory. */
  store?: AuthLimiterStore;
  /** Optional policy injection for tests or a deliberately different deployment policy. */
  limits?: Pick<typeof AUTH_RATE_LIMITS, AuthLimiterRoute>;
}

export const hashAuthEmail = (email: string): string => createHash('sha256').update(email, 'utf8').digest('hex');

/** Builds the only keys allowed in the auth limiter; email is never retained in plaintext. */
export const authLimiterKey = (route: AuthLimiterRoute, dimension: AuthLimiterDimension, email: string): string =>
  `${route}:${dimension}:${hashAuthEmail(email.trim().toLowerCase())}`;

const rateLimitedError = (): HttpError => new HttpError({
  statusCode: 429,
  code: 'RATE_LIMITED',
  message: 'Too many requests'
});

/**
 * Process-local fixed-window limiter for the auth dimensions that Fastify's
 * per-IP limiter cannot express. The map intentionally has no persistence.
 */
export class InMemoryAuthLimiter {
  private readonly now: () => number;
  private readonly store: AuthLimiterStore;
  private readonly limits: Pick<typeof AUTH_RATE_LIMITS, AuthLimiterRoute>;

  public constructor(options: AuthLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new Map<string, AuthWindowCounter>();
    this.limits = options.limits ?? {
      login: AUTH_RATE_LIMITS.login,
      forgot: AUTH_RATE_LIMITS.forgot
    };
  }

  /** Consume both IP+email and email-global windows atomically. */
  public consume(route: AuthLimiterRoute, email: string): void {
    const now = this.now();
    const policy = this.limits[route];
    const dimensions: readonly [AuthLimiterDimension, AuthRateLimitWindow][] = [
      ['ip', policy.ipEmail],
      ['email', policy.emailGlobal]
    ];
    const entries = dimensions.map(([dimension, limit]) => ({
      key: authLimiterKey(route, dimension, email),
      limit,
      counter: this.store.get(authLimiterKey(route, dimension, email))
    }));

    if (entries.some(({ counter, limit }) => counter !== undefined && counter.resetAt > now && counter.count >= limit.max)) {
      throw rateLimitedError();
    }

    for (const { key, limit, counter } of entries) {
      if (counter === undefined || counter.resetAt <= now) {
        this.store.set(key, { count: 1, resetAt: now + limit.windowMs });
      } else {
        counter.count += 1;
      }
    }
  }

  /** Alias useful to route handlers that express the operation as an assertion. */
  public assertAllowed(route: AuthLimiterRoute, email: string): void {
    this.consume(route, email);
  }

  /** Attempts a consume and returns false for the same public rate-limit error. */
  public tryConsume(route: AuthLimiterRoute, email: string): boolean {
    try {
      this.consume(route, email);
      return true;
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 429 && 'code' in error && error.code === 'RATE_LIMITED') return false;
      throw error;
    }
  }

  /** Backwards-friendly name for callers that treat a check as a consuming operation. */
  public check(route: AuthLimiterRoute, email: string): boolean {
    return this.tryConsume(route, email);
  }

  public clear(): void {
    this.store.clear();
  }
}

export const createAuthLimiter = (options: AuthLimiterOptions = {}): InMemoryAuthLimiter => new InMemoryAuthLimiter(options);
