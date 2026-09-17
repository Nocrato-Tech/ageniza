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
  /**
   * Hard cap on the number of tracked entries (M3), enforced after each purge sweep by evicting
   * the oldest entries by insertion order (the `Map` iteration order) until the store is back
   * under the cap. Injectable for tests; defaults to 100,000 in production.
   */
  maxEntries?: number;
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
/** Sweep the store for expired entries every this many `consume` calls (M3): an O(n) pass, but
 * amortized to O(1) per call, and the only way this process-local map ever shrinks. */
const PURGE_EVERY_N_CALLS = 1_000;
const DEFAULT_MAX_ENTRIES = 100_000;

export class InMemoryAuthLimiter {
  private readonly now: () => number;
  private readonly store: AuthLimiterStore;
  private readonly limits: Pick<typeof AUTH_RATE_LIMITS, AuthLimiterRoute>;
  private readonly maxEntries: number;
  private callsSincePurge = 0;

  public constructor(options: AuthLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new Map<string, AuthWindowCounter>();
    this.limits = options.limits ?? {
      login: AUTH_RATE_LIMITS.login,
      forgot: AUTH_RATE_LIMITS.forgot
    };
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Consumes both the IP+email and email-global windows atomically for one request. */
  public consume(route: AuthLimiterRoute, ip: string, email: string): void {
    this.maybePurge();

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

    this.enforceMaxEntries();
  }

  /**
   * Every `PURGE_EVERY_N_CALLS` calls, drops every entry whose window has already lapsed
   * (`resetAt <= now`). An active key's window is never lapsed by definition (its own `consume`
   * call keeps `resetAt` in the future), so this never loses a live counter (M3).
   */
  private maybePurge(): void {
    this.callsSincePurge += 1;
    if (this.callsSincePurge < PURGE_EVERY_N_CALLS) return;
    this.callsSincePurge = 0;

    const now = this.now();
    for (const [key, counter] of this.store) {
      if (counter.resetAt <= now) this.store.delete(key);
    }
  }

  /**
   * Caps the number of tracked entries after a purge/consume by evicting the oldest entries in
   * insertion order (the `Map`'s own iteration order) until the store is back under the cap.
   */
  private enforceMaxEntries(): void {
    const overflow = this.store.size - this.maxEntries;
    if (overflow <= 0) return;

    const iterator = this.store.keys();
    for (let removed = 0; removed < overflow; removed += 1) {
      const next = iterator.next();
      if (next.done === true) break;
      this.store.delete(next.value);
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
