import { isIP } from 'node:net';

import { z } from 'zod';

import { ConfigValidationError, formatZodIssues } from './errors.js';
import { assertRuntimeUrlSafety, loadRuntimeEnvironment, type RuntimeEnvironment } from './runtime.js';

export { ConfigValidationError } from './errors.js';
export type { RuntimeEnvironment } from './runtime.js';

export interface ServerConfig {
  environment: RuntimeEnvironment;
  databaseUrl: string;
  sentryDsn?: string;
  deployVersion: string;
  /** Transactional email; both are required together and only once a flow sends mail (issue #20). */
  smtpUrl?: string;
  emailFrom?: string;
}
export interface ApiConfig extends ServerConfig {
  service: 'api';
  /** Better Auth signing/encryption secret; never expose this to browser code. */
  authSecret: string;
  /** Trusted browser application origin used for auth redirects and cookies. */
  appPublicUrl: string;
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
  /** Durable queue handlers run at once; low because the VPS shares CPU with PostgreSQL and the API. */
  concurrency: number;
}
type ServerEnvironment = Record<string, string | undefined>;

const optionalUrl = (message: string) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().url(message).optional()
);

const sharedServerSchema = z.object({
  APP_ENV: z.string(),
  DATABASE_URL: z.string().url('must be a valid database URL'),
  SMTP_URL: optionalUrl('must be a valid smtp or smtps URL'),
  EMAIL_FROM: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).max(320).optional()
  ),
  SENTRY_DSN: optionalUrl('must be a valid Sentry DSN'),
  APP_VERSION: z.string().trim().min(1).max(128).optional().default('unknown'),
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
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters; supplied values are redacted'),
  APP_PUBLIC_URL: z.string().trim().url('must be a valid URL origin; supplied values are redacted'),
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
  WORKER_SMOKE_JOB: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Bounded on purpose: raising it trades API and database headroom on a shared VPS for throughput.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1)
});

const loadServerConfig = (service: ApiConfig['service'] | WorkerConfig['service'], env: ServerEnvironment): ServerConfig => {
  const environment = loadRuntimeEnvironment(env.APP_ENV);
  const result = sharedServerSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', formatZodIssues(result.error.issues));

  const config = result.data;
  const allowLocalContainerHosts = config.APP_CONTAINER_LOCAL === 'true';
  if (allowLocalContainerHosts && environment === 'production') {
    throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', [{
      path: 'APP_CONTAINER_LOCAL',
      message: 'must be false in production'
    }]);
  }
  assertRuntimeUrlSafety(environment, 'DATABASE_URL', config.DATABASE_URL, { allowLocalContainerHosts });
  if ((config.SMTP_URL === undefined) !== (config.EMAIL_FROM === undefined)) {
    throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', [{
      path: 'SMTP_URL',
      message: 'must be set together with EMAIL_FROM'
    }]);
  }
  if (config.SMTP_URL !== undefined) {
    const protocol = new URL(config.SMTP_URL).protocol;
    if (protocol !== 'smtp:' && protocol !== 'smtps:') {
      throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', [{ path: 'SMTP_URL', message: 'must use smtp or smtps; supplied values are redacted' }]);
    }
    assertRuntimeUrlSafety(environment, 'SMTP_URL', config.SMTP_URL, { allowLocalContainerHosts });
  }
  if (environment === 'production' && config.SENTRY_DSN !== undefined && new URL(config.SENTRY_DSN).protocol !== 'https:') {
    throw new ConfigValidationError(service === 'api' ? 'API' : 'Worker', [{ path: 'SENTRY_DSN', message: 'must use HTTPS in production; supplied values are redacted' }]);
  }
  return { environment, databaseUrl: config.DATABASE_URL, sentryDsn: config.SENTRY_DSN, deployVersion: config.APP_VERSION, smtpUrl: config.SMTP_URL, emailFrom: config.EMAIL_FROM };
};

/** Loads server-only API settings. Never import this module from browser code. */
export const loadApiConfig = (env: ServerEnvironment): ApiConfig => {
  const result = apiSchema.safeParse(env);
  if (!result.success) throw new ConfigValidationError('API', formatZodIssues(result.error.issues));
  const serverConfig = loadServerConfig('api', env);
  const parsedAppPublicUrl = new URL(result.data.APP_PUBLIC_URL);
  if (parsedAppPublicUrl.origin !== result.data.APP_PUBLIC_URL || parsedAppPublicUrl.pathname !== '/' || parsedAppPublicUrl.search || parsedAppPublicUrl.hash) {
    throw new ConfigValidationError('API', [{ path: 'APP_PUBLIC_URL', message: 'must be an origin without paths; supplied values are redacted' }]);
  }
  assertRuntimeUrlSafety(serverConfig.environment, 'APP_PUBLIC_URL', result.data.APP_PUBLIC_URL, { requireHttpsInProduction: true });
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
    authSecret: result.data.BETTER_AUTH_SECRET,
    appPublicUrl: result.data.APP_PUBLIC_URL,
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
    smokeJob: result.data.WORKER_SMOKE_JOB,
    concurrency: result.data.WORKER_CONCURRENCY
  };
};
/** Allows entrypoints to skip test-runner startup without reading env ad hoc. */
export const isTestProcess = (env: { APP_ENV?: string; NODE_ENV?: string }): boolean =>
  env.APP_ENV === 'test' || env.APP_ENV === 'ci' || env.NODE_ENV === 'test';
