import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export interface LogContext {
  requestId?: string;
  userId?: string;
  agencyId?: string;
  module?: string;
  action?: string;
}

export type CoreLogger = Logger;

export const SENSITIVE_LOG_PATHS = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'serviceRoleKey',
  '*.serviceRoleKey',
  'SUPABASE_SERVICE_ROLE_KEY',
  '*.SUPABASE_SERVICE_ROLE_KEY',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie'
];

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
