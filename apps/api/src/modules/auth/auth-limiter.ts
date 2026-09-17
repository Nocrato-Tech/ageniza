import { createHash } from 'node:crypto';

import { HttpError } from '@ageniza/core';

import { AUTH_RATE_LIMITS, type AuthRateLimitWindow } from './policy.js';

export type AuthLimiterRoute = 'login' | 'forgot';

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

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const hashAuthEmail = (email: string): string => hash(normalizeEmail(email));
export const hashAuthIp = (ip: string): string => hash(ip);

/** The IP + e-mail dimension: the key must include the IP, otherwise it degrades into a
 * global-by-email limit that lets one attacker lock another account out by cycling IPs. */
export const authLimiterIpEmailKey = (route: AuthLimiterRoute, ip: string, email: string): string =>
  `${route}:ip-email:${hashAuthIp(ip)}:${hashAuthEmail(email)}`;

/** The e-mail-global dimension: deliberately IP-independent so it stays loose. */
export const authLimiterEmailKey = (route: AuthLimiterRoute, email: string): string =>
  `${route}:email:${hashAuthEmail(email)}`;

const rateLimitedError = (): HttpError => new HttpError({
  statusCode: 429,
  code: 'RATE_LIMITED',
  message: 'Too many requests'
});

const isRateLimitedError = (error: unknown): error is HttpError =>
  error instanceof HttpError && error.statusCode === 429 && error.code === 'RATE_LIMITED';

/**
 * Process-local fixed-window limiter for the auth dimensions that Fastify's per-IP limiter
 * cannot express: IP + e-mail (tight) and e-mail-global (loose). The map intentionally has no
 * persistence; counters reset on every deploy or restart (accepted for the MVP single instance).
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

  /** Consumes both the IP+email and email-global windows atomically for one request. */
  public consume(route: AuthLimiterRoute, ip: string, email: string): void {
    const now = this.now();
    const policy = this.limits[route];
    const entries: readonly { key: string; limit: AuthRateLimitWindow }[] = [
      { key: authLimiterIpEmailKey(route, ip, email), limit: policy.ipEmail },
      { key: authLimiterEmailKey(route, email), limit: policy.emailGlobal }
    ];
    const resolved = entries.map(({ key, limit }) => ({ key, limit, counter: this.store.get(key) }));

    if (resolved.some(({ counter, limit }) => counter !== undefined && counter.resetAt > now && counter.count >= limit.max)) {
      throw rateLimitedError();
    }

    for (const { key, limit, counter } of resolved) {
      if (counter === undefined || counter.resetAt <= now) {
        this.store.set(key, { count: 1, resetAt: now + limit.windowMs });
      } else {
        counter.count += 1;
      }
    }
  }

  /** Alias useful to route handlers that express the operation as an assertion. */
  public assertAllowed(route: AuthLimiterRoute, ip: string, email: string): void {
    this.consume(route, ip, email);
  }

  /** Attempts a consume and returns false for the same public rate-limit error. */
  public tryConsume(route: AuthLimiterRoute, ip: string, email: string): boolean {
    try {
      this.consume(route, ip, email);
      return true;
    } catch (error) {
      if (isRateLimitedError(error)) return false;
      throw error;
    }
  }

  /** Backwards-friendly name for callers that treat a check as a consuming operation. */
  public check(route: AuthLimiterRoute, ip: string, email: string): boolean {
    return this.tryConsume(route, ip, email);
  }

  public clear(): void {
    this.store.clear();
  }
}

export const createAuthLimiter = (options: AuthLimiterOptions = {}): InMemoryAuthLimiter => new InMemoryAuthLimiter(options);
