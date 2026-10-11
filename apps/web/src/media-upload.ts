import {
  CompleteMediaUploadResponseSchema,
  CreateMediaUploadResponseSchema,
  RequestMediaUploadPartsResponseSchema
} from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import { HttpClientError, type HttpClient } from './http.js';

/** What the person is told; the API's own sentences and the storage's are never repeated. */
export type UploadFailure =
  | 'unsupported-type' | 'too-large' | 'empty' | 'quota' | 'archived' | 'forbidden' | 'not-found' | 'rejected'
  | 'storage' | 'missing-etag' | 'network' | 'unknown';

export class UploadError extends Error {
  public constructor(public readonly failure: UploadFailure) {
    super(failure);
    this.name = 'UploadError';
  }
}

export const UPLOAD_FAILURE_TEXT: Readonly<Record<UploadFailure, string>> = {
  'unsupported-type': 'Este formato de arquivo não é aceito.',
  'too-large': 'O arquivo é maior que o limite aceito.',
  empty: 'O arquivo está vazio.',
  quota: 'O armazenamento da agência está cheio.',
  archived: 'O cliente está arquivado e não recebe mídia.',
  forbidden: 'Você não tem permissão para enviar mídia.',
  'not-found': 'A pasta não existe mais.',
  rejected: 'O arquivo foi recusado na conferência. Escolha outro.',
  storage: 'O envio do arquivo falhou. Tente de novo.',
  'missing-etag': 'O envio de uma parte não foi confirmado. Tente de novo.',
  network: 'A conexão caiu durante o envio. Tente de novo.',
  unknown: 'Não foi possível enviar a mídia. Tente de novo.'
};

const PART_BATCH = 100;

const failureOf = (error: unknown): UploadError => {
  if (error instanceof UploadError) return error;
  if (error instanceof HttpClientError) {
    if (error.code === 'UNSUPPORTED_MEDIA_TYPE') return new UploadError('unsupported-type');
    if (error.code === 'PAYLOAD_TOO_LARGE') return new UploadError('too-large');
    if (error.code === 'QUOTA_EXCEEDED') return new UploadError('quota');
    if (error.code === 'CLIENT_ARCHIVED') return new UploadError('archived');
    if (error.code === 'UPLOAD_REJECTED') return new UploadError('rejected');
    if (error.status === 403) return new UploadError('forbidden');
    if (error.status === 404) return new UploadError('not-found');
  }
  return new UploadError('unknown');
};

/** An XHR is what reports how many bytes left the browser; `fetch` cannot. */
const putBlob = (url: string, blob: Blob, contentType: string | null, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string | null> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new UploadError('network')); return; }
    const xhr = new XMLHttpRequest();
    const abort = (): void => { xhr.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const settle = (): void => { signal.removeEventListener('abort', abort); };
    xhr.open('PUT', url);
    if (contentType !== null) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(event.loaded, blob.size)); };
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'));
      else reject(new UploadError('storage'));
    };
    xhr.onerror = () => { settle(); reject(new UploadError('network')); };
    xhr.onabort = () => { settle(); reject(new UploadError('network')); };
    xhr.send(blob);
  });

export interface UploadRequest {
  readonly httpClient: HttpClient;
  readonly agencyId: string;
  readonly clientId: string;
  readonly folderId: string;
  readonly file: File;
  /** Whole bytes already sent, from 0 to the file size. */
  readonly onProgress: (sentBytes: number) => void;
  readonly signal: AbortSignal;
}

/**
 * The direct upload of the media API: reserve, send to the storage (one PUT, or the parts of a multipart one) and confirm.
 * Everything that can fail ends as an `UploadError`, so the screen words it and keeps the chosen file.
 */
export const uploadMedia = async ({ httpClient, agencyId, clientId, folderId, file, onProgress, signal }: UploadRequest): Promise<string> => {
  if (file.size === 0) throw new UploadError('empty');
  if (file.type === '') throw new UploadError('unsupported-type');
  try {
    const reserved = await httpClient.request({
      path: apiPath('/agencies/:agencyId/media/uploads', { agencyId }),
      method: 'POST',
      body: { fileName: file.name, contentType: file.type, declaredSizeBytes: file.size, clientId, folderId },
      response: CreateMediaUploadResponseSchema,
      signal
    });
    const params = { agencyId, assetId: reserved.assetId };
    onProgress(0);

    if (reserved.upload.type === 'single') {
      await putBlob(reserved.upload.url, file, file.type, onProgress, signal);
      await httpClient.request({
        path: apiPath('/agencies/:agencyId/media/uploads/:assetId/complete', params),
        method: 'POST',
        body: {},
        response: CompleteMediaUploadResponseSchema,
        signal
      });
      return reserved.assetId;
    }

    const { partSizeBytes, partCount } = reserved.upload;
    const parts: Array<{ partNumber: number; eTag: string }> = [];
    let sent = 0;
    for (let first = 1; first <= partCount; first += PART_BATCH) {
      const numbers = Array.from({ length: Math.min(PART_BATCH, partCount - first + 1) }, (_value, index) => first + index);
      const signed = await httpClient.request({
        path: apiPath('/agencies/:agencyId/media/uploads/:assetId/parts', params),
        method: 'POST',
        body: { partNumbers: numbers },
        response: RequestMediaUploadPartsResponseSchema,
        signal
      });
      for (const part of signed.parts) {
        const blob = file.slice((part.partNumber - 1) * partSizeBytes, part.partNumber * partSizeBytes);
        const eTag = await putBlob(part.url, blob, null, (loaded) => { onProgress(sent + loaded); }, signal);
        if (eTag === null || eTag === '') throw new UploadError('missing-etag');
        sent += blob.size;
        onProgress(sent);
        parts.push({ partNumber: part.partNumber, eTag });
      }
    }
    await httpClient.request({
      path: apiPath('/agencies/:agencyId/media/uploads/:assetId/complete', params),
      method: 'POST',
      body: { parts },
      response: CompleteMediaUploadResponseSchema,
      signal
    });
    return reserved.assetId;
  } catch (error) {
    throw failureOf(error);
  }
};
