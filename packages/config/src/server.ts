import { isIP } from 'node:net';

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
export interface ApiConfig extends ServerConfig {
  service: 'api';
  host: string;
  port: number;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  /** Explicit proxy networks only. An empty list means Fastify does not trust forwarding headers. */
  trustedProxyCidrs: readonly string[];
}
export interface WorkerConfig extends ServerConfig {
  service: 'worker';
  healthHost: '127.0.0.1' | '::1' | '0.0.0.0';
  healthPort: number;
  smokeJob: boolean;
}
type ServerEnvironment = Record<string, string | undefined>;

const sharedServerSchema = z.object({
  APP_ENV: z.string(),
  DATABASE_URL: z.string().url('must be a valid database URL'),
  SUPABASE_URL: z.string().url('must be a valid Supabase URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'is required'),
  APP_CONTAINER_LOCAL: z.enum(['true', 'false']).optional().default('false')
});
const commaSeparatedValues = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);

const isIpOrCidr = (value: string): boolean => {
  const [address, prefix, ...extra] = value.split('/');
  if (extra.length > 0 || address === undefined) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
};

const apiSchema = sharedServerSchema.extend({
  API_HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_CORS_ORIGINS: z.string().default('http://127.0.0.1:5173').transform(commaSeparatedValues),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(50 * 1024 * 1024).default(1_048_576),
  API_TRUSTED_PROXY_CIDRS: z.string().default('').transform(commaSeparatedValues)
});
const workerSchema = sharedServerSchema.extend({
  // Binding all interfaces is reserved for the isolated local container network.
  WORKER_HEALTH_HOST: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_SMOKE_JOB: z.enum(['true', 'false']).default('false').transform((value) => value === 'true')
});

const loadServerConfig = (service: ApiConfig['service'] | WorkerConfig['service'], env: ServerEnvironment): ServerConfig => {
  const environment = loadRuntimeEnvironment(env.APP_ENV);
  const result = sharedServerSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', formatZodIssues(result.error.issues));

  const config = result.data;
  const allowDockerHostGateway = config.APP_CONTAINER_LOCAL === 'true';
  if (allowDockerHostGateway && environment === 'production') {
    throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', [{
      path: 'APP_CONTAINER_LOCAL',
      message: 'must be false in production'
    }]);
  }
  assertRuntimeUrlSafety(environment, 'SUPABASE_URL', config.SUPABASE_URL, { requireHttpsInProduction: true, allowDockerHostGateway });
  assertRuntimeUrlSafety(environment, 'DATABASE_URL', config.DATABASE_URL, { allowDockerHostGateway });
  return { environment, databaseUrl: config.DATABASE_URL, supabaseUrl: config.SUPABASE_URL, supabaseServiceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY };
};

/** Loads server-only API settings. Never import this module from browser code. */
export const loadApiConfig = (env: ServerEnvironment): ApiConfig => {
  const result = apiSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError('API', formatZodIssues(result.error.issues));
  const serverConfig = loadServerConfig('api', env);
  for (const origin of result.data.API_CORS_ORIGINS) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigValidationError('API', [{ path: 'API_CORS_ORIGINS', message: 'must contain valid origins; supplied values are redacted' }]);
    }
    if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ConfigValidationError('API', [{ path: 'API_CORS_ORIGINS', message: 'must contain origins without paths; supplied values are redacted' }]);
    }
    assertRuntimeUrlSafety(serverConfig.environment, 'API_CORS_ORIGINS', origin, { requireHttpsInProduction: true });
  }
  if (result.data.API_TRUSTED_PROXY_CIDRS.some((value) => value === '*' || value.toLowerCase() === 'true')) {
    throw new ConfigValidationError('API', [{ path: 'API_TRUSTED_PROXY_CIDRS', message: 'must name explicit proxy networks; supplied values are redacted' }]);
  }
  if (result.data.API_TRUSTED_PROXY_CIDRS.some((value) => !isIpOrCidr(value))) {
    throw new ConfigValidationError('API', [{ path: 'API_TRUSTED_PROXY_CIDRS', message: 'must contain only valid IP addresses or CIDR networks; supplied values are redacted' }]);
  }
  return {
    service: 'api',
    ...serverConfig,
    host: result.data.API_HOST,
    port: result.data.PORT,
    corsOrigins: result.data.API_CORS_ORIGINS,
    bodyLimitBytes: result.data.API_BODY_LIMIT_BYTES,
    trustedProxyCidrs: result.data.API_TRUSTED_PROXY_CIDRS
  };
};
/** Loads server-only worker settings. Never import this module from browser code. */
export const loadWorkerConfig = (env: ServerEnvironment): WorkerConfig => {
  const result = workerSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError('Worker', formatZodIssues(result.error.issues));
  const serverConfig = loadServerConfig('worker', env);
  if (result.data.WORKER_HEALTH_HOST === '0.0.0.0' && env.APP_CONTAINER_LOCAL !== 'true') {
    throw new ConfigValidationError('Worker', [{ path: 'WORKER_HEALTH_HOST', message: '0.0.0.0 is allowed only with APP_CONTAINER_LOCAL=true' }]);
  }
  if (serverConfig.environment === 'production' && result.data.WORKER_SMOKE_JOB) {
    throw new ConfigValidationError('Worker', [{ path: 'WORKER_SMOKE_JOB', message: 'must be false in production' }]);
  }
  return {
    service: 'worker',
    ...serverConfig,
    healthHost: result.data.WORKER_HEALTH_HOST,
    healthPort: result.data.WORKER_HEALTH_PORT,
    smokeJob: result.data.WORKER_SMOKE_JOB
  };
};
/** Allows entrypoints to skip test-runner startup without reading env ad hoc. */
export const isTestProcess = (env: { APP_ENV?: string; NODE_ENV?: string }): boolean =>
  env.APP_ENV === 'test' || env.APP_ENV === 'ci' || env.NODE_ENV === 'test';
