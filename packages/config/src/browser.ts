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
}
export interface BrowserEnvironment {
  MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}
const browserSchema = z.object({
  VITE_API_BASE_URL: z.string().url('must be a valid API URL'),
  VITE_SUPABASE_URL: z.string().url('must be a valid Supabase URL'),
  VITE_SUPABASE_ANON_KEY: z.string().min(1, 'is required')
});

/** Loads only explicit public Vite variables; server variables never enter this configuration object. */
export const loadWebConfig = (env: BrowserEnvironment): BrowserConfig => {
  const environment = loadRuntimeEnvironment(env.MODE, 'Vite mode');
  const result = browserSchema.safeParse({
    VITE_API_BASE_URL: env.VITE_API_BASE_URL,
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY
  });
  if (!result.success) throw new ConfigValidationError('Web', formatZodIssues(result.error.issues));

  const config = result.data;
  assertRuntimeUrlSafety(environment, 'VITE_API_BASE_URL', config.VITE_API_BASE_URL, { requireHttpsInProduction: true });
  assertRuntimeUrlSafety(environment, 'VITE_SUPABASE_URL', config.VITE_SUPABASE_URL, { requireHttpsInProduction: true });
  return { environment, apiBaseUrl: config.VITE_API_BASE_URL, supabaseUrl: config.VITE_SUPABASE_URL, supabaseAnonKey: config.VITE_SUPABASE_ANON_KEY };
};
