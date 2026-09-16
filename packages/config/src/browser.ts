import { z } from 'zod';

import { ConfigValidationError, formatZodIssues } from './errors.js';
import { assertRuntimeUrlSafety, loadRuntimeEnvironment, type RuntimeEnvironment } from './runtime.js';

export { ConfigValidationError } from './errors.js';
export type { RuntimeEnvironment } from './runtime.js';

export interface BrowserConfig {
  environment: RuntimeEnvironment;
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  sentryDsn?: string;
  deployVersion: string;
}
export interface BrowserEnvironment {
  MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SENTRY_DSN?: string;
  VITE_APP_VERSION?: string;
}
const optionalUrl = (message: string) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().url(message).optional()
);
const browserSchema = z.object({
  VITE_API_BASE_URL: z.string().url('must be a valid API URL'),
  VITE_SUPABASE_URL: z.string().url('must be a valid Supabase URL'),
  VITE_SUPABASE_ANON_KEY: z.string().min(1, 'is required'),
  VITE_SENTRY_DSN: optionalUrl('must be a valid public Sentry DSN'),
  VITE_APP_VERSION: z.string().trim().min(1).max(128).optional().default('unknown')
});

/** Loads only explicit public Vite variables; server variables never enter this configuration object. */
export const loadWebConfig = (env: BrowserEnvironment): BrowserConfig => {
  const environment = loadRuntimeEnvironment(env.MODE, 'Vite mode');
  const result = browserSchema.safeParse({
    VITE_API_BASE_URL: env.VITE_API_BASE_URL,
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
    VITE_SENTRY_DSN: env.VITE_SENTRY_DSN,
    VITE_APP_VERSION: env.VITE_APP_VERSION
  });
  if (!result.success) throw new ConfigValidationError('Web', formatZodIssues(result.error.issues));

  const config = result.data;
  assertRuntimeUrlSafety(environment, 'VITE_API_BASE_URL', config.VITE_API_BASE_URL, { requireHttpsInProduction: true });
  assertRuntimeUrlSafety(environment, 'VITE_SUPABASE_URL', config.VITE_SUPABASE_URL, { requireHttpsInProduction: true });
  if (environment === 'production' && config.VITE_SENTRY_DSN !== undefined && new URL(config.VITE_SENTRY_DSN).protocol !== 'https:') {
    throw new ConfigValidationError('Web', [{ path: 'VITE_SENTRY_DSN', message: 'must use HTTPS in production; supplied values are redacted' }]);
  }
  return { environment, apiBaseUrl: config.VITE_API_BASE_URL, supabaseUrl: config.VITE_SUPABASE_URL, supabaseAnonKey: config.VITE_SUPABASE_ANON_KEY, sentryDsn: config.VITE_SENTRY_DSN, deployVersion: config.VITE_APP_VERSION };
};
