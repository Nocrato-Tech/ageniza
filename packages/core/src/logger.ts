import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  agencyId?: string;
  environment?: string;
  service?: string;
  deployVersion?: string;
  route?: string;
  operation?: string;
  statusCode?: number;
  /** Non-HTTP outcome for background operations, such as `ok` or `failed`. */
  status?: string;
  durationMs?: number;
  module?: string;
  action?: string;
}

export type CoreLogger = Logger;

export const SENSITIVE_LOG_PATHS = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'cookie',
  '*.cookie',
  'Cookie',
  '*.Cookie',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'dsn',
  '*.dsn',
  'serviceRoleKey',
  '*.serviceRoleKey',
  'sentryDsn',
  '*.sentryDsn',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'databaseUrl',
  '*.databaseUrl',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie'
];

const SENSITIVE_KEY = /password|authorization|cookie|access[_-]?token|refresh[_-]?token|service[_-]?role|secret|dsn/i;
const SENSITIVE_VALUE = /((?:(?:password|access[_-]?token|refresh[_-]?token|service[_-]?role|secret)\s*[=:]\s*)|(?:authorization\s*[=:]\s*(?:bearer\s+)?)|(?:cookie\s*[=:]\s*))([^\s,;]+)/gi;

/** Produces a safe value for errors and external telemetry without logging request payloads. */
export const redactSensitiveData = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(SENSITIVE_VALUE, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveData(entry)
    ]));
  }
  return value;
};

const redactionOptions = (custom: LoggerOptions['redact']): NonNullable<LoggerOptions['redact']> => {
  if (Array.isArray(custom)) return [...SENSITIVE_LOG_PATHS, ...custom];
  if (custom !== undefined) return { ...custom, paths: [...SENSITIVE_LOG_PATHS, ...custom.paths] };
  return { paths: SENSITIVE_LOG_PATHS, censor: '[REDACTED]' };
};

/** Creates a structured Pino logger with mandatory secret redaction defaults. */
export const createLogger = (options: LoggerOptions = {}, destination?: DestinationStream): Logger =>
  pino({ ...options, redact: redactionOptions(options.redact) }, destination);

/** Adds the standard request and domain-boundary context fields to a logger. */
export const withLogContext = (logger: Logger, context: LogContext): Logger => logger.child(context);
