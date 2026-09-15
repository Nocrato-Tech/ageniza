import { z } from 'zod';

import { ConfigValidationError, formatZodIssues } from './errors.js';
import { assertRuntimeUrlSafety, loadRuntimeEnvironment, type RuntimeEnvironment } from './runtime.js';

export { ConfigValidationError } from './errors.js';
export type { RuntimeEnvironment } from './runtime.js';

export interface ServerConfig {
  environment: RuntimeEnvironment;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}
export interface ApiConfig extends ServerConfig { service: 'api'; port: number; }
export interface WorkerConfig extends ServerConfig { service: 'worker'; }
type ServerEnvironment = Record<string, string | undefined>;

const sharedServerSchema = z.object({
  APP_ENV: z.string(),
  DATABASE_URL: z.string().url('must be a valid database URL'),
  SUPABASE_URL: z.string().url('must be a valid Supabase URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'is required')
});
const apiSchema = sharedServerSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001)
});

const loadServerConfig = (service: ApiConfig['service'] | WorkerConfig['service'], env: ServerEnvironment): ServerConfig => {
  const environment = loadRuntimeEnvironment(env.APP_ENV);
  const result = sharedServerSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', formatZodIssues(result.error.issues));

  const config = result.data;
  assertRuntimeUrlSafety(environment, 'SUPABASE_URL', config.SUPABASE_URL, { requireHttpsInProduction: true });
  assertRuntimeUrlSafety(environment, 'DATABASE_URL', config.DATABASE_URL);
  return { environment, databaseUrl: config.DATABASE_URL, supabaseUrl: config.SUPABASE_URL, supabaseServiceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY };
};

/** Loads server-only API settings. Never import this module from browser code. */
export const loadApiConfig = (env: ServerEnvironment): ApiConfig => {
  const result = apiSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError('API', formatZodIssues(result.error.issues));
  return { service: 'api', ...loadServerConfig('api', env), port: result.data.PORT };
};
/** Loads server-only worker settings. Never import this module from browser code. */
export const loadWorkerConfig = (env: ServerEnvironment): WorkerConfig => ({ service: 'worker', ...loadServerConfig('worker', env) });
/** Allows entrypoints to skip test-runner startup without reading env ad hoc. */
export const isTestProcess = (env: { APP_ENV?: string; NODE_ENV?: string }): boolean =>
  env.APP_ENV === 'test' || env.APP_ENV === 'ci' || env.NODE_ENV === 'test';
