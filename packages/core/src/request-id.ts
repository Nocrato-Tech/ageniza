import { randomUUID } from 'node:crypto';

declare const requestIdBrand: unique symbol;

export type RequestId = string & { readonly [requestIdBrand]: 'RequestId' };

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Generates a UUID suitable for correlating one request or message flow. */
export const createRequestId = (): RequestId => randomUUID() as RequestId;

/** Uses a supplied correlation ID when valid; otherwise generates a new one. */
export const resolveRequestId = (value: unknown): RequestId => {
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (candidate.length > 0 && candidate.length <= MAX_REQUEST_ID_LENGTH && REQUEST_ID_PATTERN.test(candidate)) {
      return candidate as RequestId;
    }
  }
  return createRequestId();
};
