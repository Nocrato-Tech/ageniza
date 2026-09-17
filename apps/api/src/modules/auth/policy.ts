/** A fixed-window rate-limit policy shared by auth routes and their limiters. */
export interface AuthRateLimitWindow {
  readonly max: number;
  readonly windowMs: number;
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

export const AUTH_RATE_LIMITS = {
  login: {
    ip: { max: 100, windowMs: FIFTEEN_MINUTES_MS },
    ipEmail: { max: 10, windowMs: FIFTEEN_MINUTES_MS },
    emailGlobal: { max: 50, windowMs: ONE_HOUR_MS }
  },
  forgot: {
    ip: { max: 30, windowMs: FIFTEEN_MINUTES_MS },
    ipEmail: { max: 3, windowMs: FIFTEEN_MINUTES_MS },
    emailGlobal: { max: 10, windowMs: ONE_HOUR_MS }
  },
  reset: {
    ip: { max: 30, windowMs: FIFTEEN_MINUTES_MS }
  }
} as const satisfies Readonly<Record<string, Readonly<Record<string, AuthRateLimitWindow>>>>;

/** Absolute maximum session lifetime; refreshes may not extend a session past this policy. */
export const AUTH_SESSION_MAX_AGE_DAYS = 30;
export const AUTH_SESSION_MAX_AGE_SECONDS = AUTH_SESSION_MAX_AGE_DAYS * 24 * 60 * 60;
export const AUTH_SESSION_MAX_AGE_MS = AUTH_SESSION_MAX_AGE_SECONDS * 1_000;

export type AuthRateLimitRoute = keyof typeof AUTH_RATE_LIMITS;
