import { HttpError, serializeError, type SerializedError } from './errors.js';

export interface HttpResponse<T> {
  statusCode: number;
  body: T;
  headers?: Readonly<Record<string, string>>;
}

export interface ErrorBody { error: SerializedError; }

/** Creates an adapter-neutral HTTP response value. */
export const httpResponse = <T>(statusCode: number, body: T, headers?: Readonly<Record<string, string>>): HttpResponse<T> => ({ statusCode, body, ...(headers === undefined ? {} : { headers }) });

export const ok = <T>(body: T, headers?: Readonly<Record<string, string>>): HttpResponse<T> => httpResponse(200, body, headers);
export const created = <T>(body: T, headers?: Readonly<Record<string, string>>): HttpResponse<T> => httpResponse(201, body, headers);
export const noContent = (headers?: Readonly<Record<string, string>>): HttpResponse<undefined> => httpResponse(204, undefined, headers);

/** Converts a thrown value into a response value; adapters own actual transport writes. */
export const errorResponse = (error: unknown): HttpResponse<ErrorBody> => {
  const serialized = serializeError(error);
  return httpResponse(error instanceof HttpError ? error.statusCode : 500, { error: serialized });
};
