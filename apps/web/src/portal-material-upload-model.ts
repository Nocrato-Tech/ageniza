import {
  AnnouncePortalMaterialUploadsResponseSchema,
  CompletePortalMaterialUploadResponseSchema,
  CreatePortalMaterialUploadResponseSchema,
  PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  PORTAL_MATERIAL_UPLOAD_TYPES,
  PortalMaterialUploadListResponseSchema,
  type PortalMaterialUploadCategory,
  type PortalMaterialUploadContentType
} from '@ageniza/contracts';

import { apiPath } from './api-path.js';
import { HttpClientError, type HttpClient } from './http.js';
import { PORTAL_PAUSED_REASON } from './plan-notice.js';

const BASE = '/clients/:clientId/material-requests/:threadId/uploads';

export const uploadsPath = (clientId: string, threadId: string): string => apiPath(BASE, { clientId, threadId });
export const portalUploadsKey = (clientId: string, threadId: string) => ['portal', clientId, 'material-requests', 'uploads', threadId] as const;

const typesOf = (category: PortalMaterialUploadCategory): string[] =>
  Object.entries(PORTAL_MATERIAL_UPLOAD_TYPES).filter(([, rule]) => rule.category === category).map(([type]) => type);

export const IMAGE_ACCEPT = typesOf('image').join(',');
export const AUDIO_ACCEPT = typesOf('audio').join(',');

/** The type without its parameters (`audio/webm;codecs=opus` is `audio/webm`), as the contract compares it. */
export const baseType = (type: string): string => type.split(';')[0]?.trim().toLowerCase() ?? '';

export const categoryOfType = (type: string): PortalMaterialUploadCategory | undefined =>
  PORTAL_MATERIAL_UPLOAD_TYPES[baseType(type) as PortalMaterialUploadContentType]?.category;

/** What a browser records, in the order we prefer: the Safari one first, then what Chrome and Firefox write. All of them are in the contract. */
const RECORDER_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'] as const;

export const pickRecorderType = (supports: (type: string) => boolean): string | undefined =>
  RECORDER_TYPES.find((type) => categoryOfType(type) === 'audio' && supports(type));

export const recordingFileName = (type: string, now: Date): string => {
  const extension = PORTAL_MATERIAL_UPLOAD_TYPES[baseType(type) as PortalMaterialUploadContentType]?.extension ?? 'm4a';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `depoimento-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${extension}`;
};

/** What the person reads: never the plan, the quota or the storage of the agency, only that the file did not go. */
export class PortalUploadError extends Error {
  public constructor(public readonly userMessage: string, public readonly fatal = false) {
    super(userMessage);
    this.name = 'PortalUploadError';
  }
}

const REJECTION_TEXT: Readonly<Record<string, string>> = {
  empty_object: 'O arquivo está vazio. Escolha outro.',
  content_type_mismatch: 'O arquivo não é uma foto nem um áudio válido. Escolha outro.',
  too_large: 'O arquivo passa do tamanho máximo de 25 MB.',
  invalid_dimensions: 'A imagem tem um tamanho que não é aceito. Escolha outra.',
  request_full: 'Este pedido já recebeu o máximo de 20 arquivos.',
  agency_unavailable: PORTAL_PAUSED_REASON
};

const GENERIC = 'Não foi possível enviar o arquivo. Tente de novo.';

export const uploadErrorOf = (error: unknown): PortalUploadError => {
  if (error instanceof PortalUploadError) return error;
  if (!(error instanceof HttpClientError)) return new PortalUploadError(GENERIC);
  switch (error.code) {
    case 'UPLOAD_REJECTED': {
      const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;
      return new PortalUploadError(typeof reason === 'string' ? REJECTION_TEXT[reason] ?? 'O arquivo foi recusado. Escolha outro.' : 'O arquivo foi recusado. Escolha outro.');
    }
    case 'PAYLOAD_TOO_LARGE': return new PortalUploadError(REJECTION_TEXT.too_large ?? GENERIC);
    case 'UNSUPPORTED_MEDIA_TYPE': return new PortalUploadError('Envie uma foto (PNG, JPEG, WebP ou GIF) ou um áudio.');
    case 'REQUEST_FULL': return new PortalUploadError(REJECTION_TEXT.request_full ?? GENERIC, true);
    case 'REQUEST_RESOLVED': return new PortalUploadError('Este pedido já foi resolvido e não recebe mais arquivos.', true);
    case 'UPLOAD_UNAVAILABLE':
    case 'AGENCY_READ_ONLY': return new PortalUploadError(PORTAL_PAUSED_REASON, true);
    case 'NETWORK_ERROR': return new PortalUploadError('A conexão caiu durante o envio. Tente de novo.');
    default:
      if (error.status === 404) return new PortalUploadError('Este pedido não está mais disponível.', true);
      return new PortalUploadError(GENERIC);
  }
};

/** Rules the browser can check before it asks the API for a reservation; the API and the database still decide. */
export const problemWithFile = (file: File, category: PortalMaterialUploadCategory): string | undefined => {
  if (file.size === 0) return 'O arquivo está vazio. Escolha outro.';
  if (categoryOfType(file.type) !== category) {
    return category === 'image' ? 'Envie uma foto (PNG, JPEG, WebP ou GIF).' : 'Este áudio não é aceito. Envie um arquivo MP3, M4A, WAV, WebM ou OGG.';
  }
  if (file.size > PORTAL_MATERIAL_UPLOAD_MAX_BYTES) return REJECTION_TEXT.too_large;
  return undefined;
};

/** An XHR is what reports how many bytes left the browser; `fetch` cannot. */
const putBlob = (url: string, blob: Blob, contentType: string, onProgress: (sent: number) => void, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new PortalUploadError('Envio cancelado.')); return; }
    const xhr = new XMLHttpRequest();
    const abort = (): void => { xhr.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const settle = (): void => { signal.removeEventListener('abort', abort); };
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(event.loaded, blob.size)); };
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PortalUploadError(GENERIC));
    };
    xhr.onerror = () => { settle(); reject(new PortalUploadError('A conexão caiu durante o envio. Tente de novo.')); };
    xhr.onabort = () => { settle(); reject(new PortalUploadError('Envio cancelado.')); };
    xhr.send(blob);
  });

export interface PortalUploadRequest {
  readonly httpClient: HttpClient;
  readonly clientId: string;
  readonly threadId: string;
  readonly file: File;
  readonly category: PortalMaterialUploadCategory;
  readonly onProgress: (sentBytes: number) => void;
  readonly signal: AbortSignal;
}

/** The cycle of the portal: reserve, one PUT straight to the signed address and confirm. Every failure ends as a `PortalUploadError`. */
export const uploadPortalFile = async ({ httpClient, clientId, threadId, file, category, onProgress, signal }: PortalUploadRequest): Promise<string> => {
  const problem = problemWithFile(file, category);
  if (problem !== undefined) throw new PortalUploadError(problem);
  try {
    const base = uploadsPath(clientId, threadId);
    const reserved = await httpClient.request({
      path: base,
      method: 'POST',
      body: { fileName: file.name, contentType: baseType(file.type), declaredSizeBytes: file.size },
      response: CreatePortalMaterialUploadResponseSchema,
      signal
    });
    onProgress(0);
    await putBlob(reserved.upload.url, file, reserved.contentType, onProgress, signal);
    await httpClient.request({
      path: `${base}/${reserved.assetId}/complete`,
      method: 'POST',
      body: {},
      response: CompletePortalMaterialUploadResponseSchema,
      signal
    });
    return reserved.assetId;
  } catch (error: unknown) {
    throw uploadErrorOf(error);
  }
};

export const announceUploads = (httpClient: HttpClient, clientId: string, threadId: string, assetIds: readonly string[]) => httpClient.request({
  path: `${uploadsPath(clientId, threadId)}/announce`,
  method: 'POST',
  body: { assetIds },
  response: AnnouncePortalMaterialUploadsResponseSchema
});

export const listUploads = (httpClient: HttpClient, clientId: string, threadId: string, page: number, signal?: AbortSignal) => httpClient.request({
  path: `${uploadsPath(clientId, threadId)}?page=${page}`,
  response: PortalMaterialUploadListResponseSchema,
  signal
});
