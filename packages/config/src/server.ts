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

/** S3-compatible object storage for direct-to-bucket media upload (issue #21). Cloudflare R2 in
 * production; MinIO locally. All five are required together, and required in production. */
export interface StorageConfig {
  /** Endpoint the API itself calls (HeadObject, multipart control operations). */
  readonly endpoint: string;
  /**
   * Endpoint embedded in presigned URLs, which the *browser* calls directly. Equal to `endpoint`
   * for R2 (one globally reachable endpoint) and for a host-run API talking to local MinIO.
   * Differs only when the API runs inside the local Compose network (`minio:9000`) while the
   * browser reaches the same MinIO through its published port (`127.0.0.1:9000`).
   */
  readonly publicEndpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** MinIO and R2 both accept path-style addressing; this avoids per-bucket DNS/virtual-host setup. */
  readonly forcePathStyle: boolean;
  /** Presigned PUT/part URL lifetime. Short-lived by design; the client re-requests on expiry. */
  readonly uploadUrlExpirySeconds: number;
  /** Presigned GET lifetime, issued only at social-publish time (issue #21 scope). */
  readonly downloadUrlExpirySeconds: number;
  /** Files at or above this size use multipart upload instead of a single presigned PUT. */
  readonly multipartThresholdBytes: number;
  /** Size of every multipart part except the last. Must be >= 5 MiB (S3/R2 multipart minimum). */
  readonly multipartPartBytes: number;
  readonly maxImageBytes: number;
  readonly maxVideoBytes: number;
  /** Default per-tenant quota; `agency_storage_quotas` may override it per agency. */
  readonly quotaDefaultBytes: number;
  readonly quotaDefaultObjectCount: number;
}
export interface ApiConfig extends ServerConfig {
  service: 'api';
  /** Undefined only where storage is genuinely unused (e.g. lightweight app tests); required in production. */
  storage?: StorageConfig;
  /** Better Auth signing/encryption secret; never expose this to browser code. */
  authSecret: string;
  /** Version of the terms document recorded when an invitation is accepted. */
  authTermsVersion: string;
  /** Version of the privacy document recorded when an invitation is accepted. */
  authPrivacyVersion: string;
  /** Trusted browser application origin used for auth redirects and cookies. */
  appPublicUrl: string;
  host: string;
  port: number;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  /** Explicit proxy networks only. An empty list means Fastify does not trust forwarding headers. */
  trustedProxyCidrs: readonly string[];
}
/** Object storage the worker talks to directly (issue #24): download the confirmed original,
 * upload the generated thumbnail/preview. Unlike `StorageConfig`, the worker never presigns a
 * browser-facing URL, so it needs no `publicEndpoint`/expiry/multipart/quota fields. */
export interface WorkerStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly forcePathStyle: boolean;
}

/** Video processing limits and ffmpeg invocation settings (issue #24). */
export interface MediaProcessingConfig {
  /** Wall-clock timeout for one ffmpeg/ffprobe invocation; enforced by killing the process, not
   * merely advisory. A stuck ffmpeg dies here well before the job's own pg-boss `expireInSeconds`. */
  readonly ffmpegTimeoutSeconds: number;
  /** A video probed longer than this fails explicitly instead of burning CPU on a huge encode. */
  readonly maxDurationSeconds: number;
  readonly thumbnailWidthPixels: number;
  /** Output height cap; a shorter source is never upscaled. */
  readonly previewMaxHeightPixels: number;
  /** Hard cap passed to ffmpeg's own `-fs`, guarding local disk even if the bitrate estimate is wrong. */
  readonly previewMaxOutputBytes: number;
}

export interface WorkerConfig extends ServerConfig {
  service: 'worker';
  healthHost: '127.0.0.1' | '::1' | '0.0.0.0';
  healthPort: number;
  smokeJob: boolean;
  /** Durable queue handlers run at once; low because the VPS shares CPU with PostgreSQL and the API. */
  concurrency: number;
  /** Undefined only where video processing is genuinely unused (e.g. lightweight worker tests);
   * required in production because thumbnail/preview generation (issue #24) is core to the product. */
  storage?: WorkerStorageConfig;
  mediaProcessing: MediaProcessingConfig;
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

/** B11: substrings that mark a Better Auth secret as an unrotated example/placeholder value, one
 * that keeps showing up verbatim in local `.env.example` files and dev docs. Case-insensitive. */
const EXAMPLE_SECRET_MARKERS = ['placeholder', 'change-me', 'changeme', 'replace', 'example', 'test'] as const;

const containsExampleSecretMarker = (value: string): boolean => {
  const lower = value.toLowerCase();
  return EXAMPLE_SECRET_MARKERS.some((marker) => lower.includes(marker));
};

const authDocumentVersion = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD');

const storageEnvironmentShape = {
  R2_ENDPOINT: optionalUrl('must be a valid storage endpoint URL'),
  R2_REGION: z.string().trim().min(1).max(64).default('auto'),
  R2_ACCESS_KEY_ID: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional()
  ),
  R2_SECRET_ACCESS_KEY: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(1).optional()
  ),
  R2_BUCKET: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).max(63).optional()
  ),
  R2_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true')
} as const;

const apiSchema = sharedServerSchema.extend({
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters; supplied values are redacted'),
  AUTH_TERMS_VERSION: authDocumentVersion,
  AUTH_PRIVACY_VERSION: authDocumentVersion,
  APP_PUBLIC_URL: z.string().trim().url('must be a valid URL origin; supplied values are redacted'),
  API_HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_CORS_ORIGINS: z.string().default('http://127.0.0.1:5173').transform(commaSeparatedValues),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(50 * 1024 * 1024).default(1_048_576),
  API_TRUSTED_PROXY_CIDRS: z.string().default('').transform(commaSeparatedValues),
  // Object storage (issue #21): R2 in production, MinIO locally. All required together.
  ...storageEnvironmentShape,
  R2_PUBLIC_ENDPOINT: optionalUrl('must be a valid storage endpoint URL'),
  MEDIA_UPLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  MEDIA_MULTIPART_THRESHOLD_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(8 * 1024 * 1024),
  MEDIA_MULTIPART_PART_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(8 * 1024 * 1024),
  MEDIA_MAX_BYTES_IMAGE: z.coerce.number().int().min(1).default(25 * 1024 * 1024),
  MEDIA_MAX_BYTES_VIDEO: z.coerce.number().int().min(1).default(5 * 1024 * 1024 * 1024),
  STORAGE_QUOTA_DEFAULT_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024 * 1024),
  STORAGE_QUOTA_DEFAULT_OBJECT_COUNT: z.coerce.number().int().min(1).default(2_000)
});
const workerSchema = sharedServerSchema.extend({
  // Binding all interfaces is reserved for the isolated local container network.
  WORKER_HEALTH_HOST: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_SMOKE_JOB: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Bounded on purpose: raising it trades API and database headroom on a shared VPS for throughput.
  // CPU-heavy jobs cap themselves further through the queue's per-job `concurrency` (video
  // processing, issue #24, runs one at a time), so this ceiling stays for lighter jobs.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  // Object storage (issue #24): same Cloudflare R2 bucket/credentials as the API (issue #21); the
  // worker downloads the confirmed original and uploads thumbnail/preview outputs directly, with
  // no presigning. All four are required together, exactly like the API's copy of these settings.
  ...storageEnvironmentShape,
  // ffmpeg/ffprobe invocation timeout per call. Three calls run per job (probe, thumbnail, preview).
  MEDIA_PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1_800).default(240),
  // A video probed longer than this is rejected explicitly instead of processed.
  MEDIA_PROCESSING_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(24 * 3_600).default(1_800),
  MEDIA_THUMBNAIL_WIDTH_PIXELS: z.coerce.number().int().min(16).max(4_096).default(640),
  MEDIA_PREVIEW_MAX_HEIGHT_PIXELS: z.coerce.number().int().min(16).max(2_160).default(720),
  MEDIA_PREVIEW_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_048_576).default(300 * 1024 * 1024)
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

interface StorageEnvironmentValues {
  readonly R2_ENDPOINT?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly R2_BUCKET?: string;
}

const validateStorageEnvironment = (
  service: 'API' | 'Worker',
  environment: RuntimeEnvironment,
  values: StorageEnvironmentValues,
  allowLocalContainerHosts: boolean
): boolean => {
  const present = [values.R2_ENDPOINT, values.R2_ACCESS_KEY_ID, values.R2_SECRET_ACCESS_KEY, values.R2_BUCKET]
    .map((value) => value !== undefined);
  const anyPresent = present.some(Boolean);
  const allPresent = present.every(Boolean);
  if (anyPresent && !allPresent) {
    throw new ConfigValidationError(service, [{
      path: 'R2_ENDPOINT',
      message: 'R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set together'
    }]);
  }
  if (environment === 'production' && !allPresent) {
    throw new ConfigValidationError(service, [{
      path: 'R2_ENDPOINT',
      message: 'R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required in production'
    }]);
  }
  if (values.R2_ENDPOINT !== undefined) {
    assertRuntimeUrlSafety(environment, 'R2_ENDPOINT', values.R2_ENDPOINT, {
      allowLocalContainerHosts,
      requireHttpsInProduction: true
    });
  }
  if (environment === 'production' && values.R2_SECRET_ACCESS_KEY !== undefined && containsExampleSecretMarker(values.R2_SECRET_ACCESS_KEY)) {
    throw new ConfigValidationError(service, [{
      path: 'R2_SECRET_ACCESS_KEY',
      message: 'must not be an example/placeholder value in production; supplied values are redacted'
    }]);
  }
  return allPresent;
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
  if (serverConfig.environment === 'production' && containsExampleSecretMarker(result.data.BETTER_AUTH_SECRET)) {
    throw new ConfigValidationError('API', [{
      path: 'BETTER_AUTH_SECRET',
      message: 'must not be an example/placeholder value in production; supplied values are redacted'
    }]);
  }
  if (serverConfig.environment === 'production' && (serverConfig.smtpUrl === undefined || serverConfig.emailFrom === undefined)) {
    throw new ConfigValidationError('API', [{
      path: 'SMTP_URL',
      message: 'SMTP_URL and EMAIL_FROM are required in production'
    }]);
  }
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

  // Object storage (issue #21): the four secrets/identifiers are required together, exactly like
  // SMTP_URL/EMAIL_FROM above, and required in production because direct-to-bucket upload is core
  // to the product. They stay optional outside production for tests/tooling that never touch storage.
  const allStoragePresent = validateStorageEnvironment('API', serverConfig.environment, result.data, result.data.APP_CONTAINER_LOCAL === 'true');
  if (result.data.R2_PUBLIC_ENDPOINT !== undefined) {
    // The browser calls this endpoint directly, so a container-only hostname is never acceptable
    // here even in APP_CONTAINER_LOCAL mode.
    assertRuntimeUrlSafety(serverConfig.environment, 'R2_PUBLIC_ENDPOINT', result.data.R2_PUBLIC_ENDPOINT, { requireHttpsInProduction: true });
  }
  if (result.data.MEDIA_MULTIPART_PART_BYTES > result.data.MEDIA_MULTIPART_THRESHOLD_BYTES) {
    throw new ConfigValidationError('API', [{ path: 'MEDIA_MULTIPART_PART_BYTES', message: 'must not exceed MEDIA_MULTIPART_THRESHOLD_BYTES' }]);
  }

  return {
    service: 'api',
    ...serverConfig,
    authSecret: result.data.BETTER_AUTH_SECRET,
    authTermsVersion: result.data.AUTH_TERMS_VERSION,
    authPrivacyVersion: result.data.AUTH_PRIVACY_VERSION,
    appPublicUrl: result.data.APP_PUBLIC_URL,
    host: result.data.API_HOST,
    port: result.data.PORT,
    corsOrigins: result.data.API_CORS_ORIGINS,
    bodyLimitBytes: result.data.API_BODY_LIMIT_BYTES,
    trustedProxyCidrs: result.data.API_TRUSTED_PROXY_CIDRS,
    storage: allStoragePresent ? {
      endpoint: result.data.R2_ENDPOINT!,
      publicEndpoint: result.data.R2_PUBLIC_ENDPOINT ?? result.data.R2_ENDPOINT!,
      region: result.data.R2_REGION,
      accessKeyId: result.data.R2_ACCESS_KEY_ID!,
      secretAccessKey: result.data.R2_SECRET_ACCESS_KEY!,
      bucket: result.data.R2_BUCKET!,
      forcePathStyle: result.data.R2_FORCE_PATH_STYLE,
      uploadUrlExpirySeconds: result.data.MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
      downloadUrlExpirySeconds: result.data.MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS,
      multipartThresholdBytes: result.data.MEDIA_MULTIPART_THRESHOLD_BYTES,
      multipartPartBytes: result.data.MEDIA_MULTIPART_PART_BYTES,
      maxImageBytes: result.data.MEDIA_MAX_BYTES_IMAGE,
      maxVideoBytes: result.data.MEDIA_MAX_BYTES_VIDEO,
      quotaDefaultBytes: result.data.STORAGE_QUOTA_DEFAULT_BYTES,
      quotaDefaultObjectCount: result.data.STORAGE_QUOTA_DEFAULT_OBJECT_COUNT
    } : undefined
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

  // Object storage (issue #24): required together, mirroring the API's R2 settings (issue #21).
  const allStoragePresent = validateStorageEnvironment('Worker', serverConfig.environment, result.data, env.APP_CONTAINER_LOCAL === 'true');

  return {
    service: 'worker',
    ...serverConfig,
    healthHost: result.data.WORKER_HEALTH_HOST,
    healthPort: result.data.WORKER_HEALTH_PORT,
    smokeJob: result.data.WORKER_SMOKE_JOB,
    concurrency: result.data.WORKER_CONCURRENCY,
    storage: allStoragePresent ? {
      endpoint: result.data.R2_ENDPOINT!,
      region: result.data.R2_REGION,
      accessKeyId: result.data.R2_ACCESS_KEY_ID!,
      secretAccessKey: result.data.R2_SECRET_ACCESS_KEY!,
      bucket: result.data.R2_BUCKET!,
      forcePathStyle: result.data.R2_FORCE_PATH_STYLE
    } : undefined,
    mediaProcessing: {
      ffmpegTimeoutSeconds: result.data.MEDIA_PROCESSING_TIMEOUT_SECONDS,
      maxDurationSeconds: result.data.MEDIA_PROCESSING_MAX_DURATION_SECONDS,
      thumbnailWidthPixels: result.data.MEDIA_THUMBNAIL_WIDTH_PIXELS,
      previewMaxHeightPixels: result.data.MEDIA_PREVIEW_MAX_HEIGHT_PIXELS,
      previewMaxOutputBytes: result.data.MEDIA_PREVIEW_MAX_OUTPUT_BYTES
    }
  };
};
/** Allows entrypoints to skip test-runner startup without reading env ad hoc. */
export const isTestProcess = (env: { APP_ENV?: string; NODE_ENV?: string }): boolean =>
  env.APP_ENV === 'test' || env.APP_ENV === 'ci' || env.NODE_ENV === 'test';
