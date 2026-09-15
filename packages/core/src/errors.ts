import type { StructuredData } from './types.js';

export interface OperationalErrorOptions {
  code: string;
  message: string;
  details?: StructuredData;
  cause?: unknown;
}

/** An anticipated, safe-to-handle failure with a stable machine-readable code. */
export class OperationalError extends Error {
  readonly code: string;
  readonly details?: StructuredData;

  constructor({ code, message, details, cause }: OperationalErrorOptions) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OperationalError';
    this.code = code;
    this.details = details;
  }
}

export interface HttpErrorOptions extends OperationalErrorOptions {
  statusCode: number;
}

/** An anticipated failure that can be represented by an HTTP status code. */
export class HttpError extends OperationalError {
  readonly statusCode: number;

  constructor({ statusCode, ...options }: HttpErrorOptions) {
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new RangeError('statusCode must be an integer between 400 and 599');
    }
    super(options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export interface SerializedError {
  name: string;
  code: string;
  message: string;
  statusCode?: number;
  details?: StructuredData;
}

/** Serializes errors into a stable, intentionally stack-free public shape. */
export const serializeError = (error: unknown): SerializedError => {
  if (error instanceof HttpError) {
    return { name: error.name, code: error.code, message: error.message, statusCode: error.statusCode, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof OperationalError) {
    return { name: error.name, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { name: 'Error', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
};
