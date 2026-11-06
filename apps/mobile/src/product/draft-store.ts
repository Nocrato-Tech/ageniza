import { CONTENT_CAPTION_MAX_LENGTH, CONTENT_CAROUSEL_MAX_MEDIA, CONTENT_TITLE_MAX_LENGTH, ContentFormatSchema } from '@ageniza/contracts';
import type { EditorDraft } from './editor-state';

export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type DraftScope = { userId: string; context: { type: 'agency' | 'client'; id: string } };
const PREFIX = 'ageniza:editor-draft:v1:';
const MAX_BYTES = 48 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const optionalIdentifier = (value: unknown): value is string => value === '' || identifier(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && Array.from(value).length <= max;

function storageKey(scope: DraftScope, key: string): string | undefined {
  if (!scope || !identifier(scope.userId) || !scope.context
    || !['agency', 'client'].includes(scope.context.type)
    || !identifier(scope.context.id) || !identifier(key)) return undefined;
  return `${PREFIX}${scope.userId}:${scope.context.type}:${scope.context.id}:${key}`;
}
function cleanDraft(value: unknown): EditorDraft | undefined {
  if (!record(value) || !record(value.input)) return undefined;
  const input = value.input;
  const format = ContentFormatSchema.safeParse(input.format);
  if (!optionalIdentifier(input.clientId) || !optionalIdentifier(input.folderId) || !optionalIdentifier(input.ownerId)
    || !text(input.title, CONTENT_TITLE_MAX_LENGTH) || !text(input.caption, CONTENT_CAPTION_MAX_LENGTH)
    || !text(input.date, 10) || !text(input.time, 5) || !format.success
    || !Array.isArray(input.mediaIds) || input.mediaIds.length > CONTENT_CAROUSEL_MAX_MEDIA
    || !input.mediaIds.every(identifier) || !(input.coverId === null || identifier(input.coverId))) return undefined;
  if (value.createdId !== undefined && !identifier(value.createdId)
    || value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) return undefined;
  return {
    input: {
      clientId: input.clientId, folderId: input.folderId, ownerId: input.ownerId, title: input.title,
      caption: input.caption, date: input.date, time: input.time, format: format.data,
      mediaIds: [...input.mediaIds] as string[], coverId: input.coverId
    },
    ...(value.createdId !== undefined ? { createdId: value.createdId as string } : {}),
    ...(value.revision !== undefined ? { revision: value.revision as number } : {})
  };
}
function remove(storage: DraftStorage, key: string): boolean {
  try { storage.removeItem(key); return true; } catch { return false; }
}
export function writeDraft(storage: DraftStorage, scope: DraftScope, key: string, draft: EditorDraft | undefined): boolean {
  const name = storageKey(scope, key);
  if (!name) return false;
  if (draft === undefined) return remove(storage, name);
  const clean = cleanDraft(draft);
  if (!clean) return false;
  try {
    const encoded = JSON.stringify({ version: 1, savedAt: Date.now(), draft: clean });
    if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) return false;
    storage.setItem(name, encoded);
    return true;
  } catch { return false; }
}
export function readDraft(storage: DraftStorage, scope: DraftScope, key: string): EditorDraft | undefined {
  const name = storageKey(scope, key);
  if (!name) return undefined;
  try {
    const encoded = storage.getItem(name);
    if (encoded === null) return undefined;
    if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) { remove(storage, name); return undefined; }
    const envelope: unknown = JSON.parse(encoded);
    const now = Date.now();
    const valid = record(envelope) && envelope.version === 1 && typeof envelope.savedAt === 'number'
      && Number.isSafeInteger(envelope.savedAt) && envelope.savedAt <= now && now - envelope.savedAt < TTL_MS;
    const clean = valid ? cleanDraft(envelope.draft) : undefined;
    if (!clean) remove(storage, name);
    return clean;
  } catch { remove(storage, name); return undefined; }
}
export function clearDrafts(storage: DraftStorage): boolean {
  try {
    const names: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name?.startsWith(PREFIX)) names.push(name);
    }
    let cleared = true;
    for (const name of names) if (!remove(storage, name)) cleared = false;
    return cleared;
  } catch { return false; }
}
