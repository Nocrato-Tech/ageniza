import { beforeEach, expect, it, vi } from 'vitest';
import { clearDrafts, readDraft, writeDraft, type DraftScope, type DraftStorage } from './draft-store';
import type { EditorDraft } from './editor-state';

class Storage implements DraftStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const scope: DraftScope = { userId: 'user-1', context: { type: 'agency', id: 'agency-1' } };
const draft: EditorDraft = { input: { clientId: 'client-1', title: '', caption: '', format: 'image', date: '', time: '', ownerId: '', folderId: '', mediaIds: [], coverId: null } };
beforeEach(() => { vi.useRealTimers(); });
it('round-trips incomplete editor work and replaces exactly one scoped draft', () => {
  const storage = new Storage();
  expect(writeDraft(storage, scope, 'new', draft)).toBe(true);
  expect(readDraft(storage, scope, 'new')).toEqual(draft);
  const next = { ...draft, input: { ...draft.input, title: 'Ideia incompleta' }, createdId: 'content-1', revision: 2 };
  expect(writeDraft(storage, scope, 'new', next)).toBe(true);
  expect(readDraft(storage, scope, 'new')).toEqual(next);
  expect(storage.length).toBe(1);
});
it('isolates two users, agency/client contexts and content keys with no global fallback', () => {
  const storage = new Storage();
  writeDraft(storage, scope, 'new', draft);
  expect(readDraft(storage, { ...scope, userId: 'user-2' }, 'new')).toBeUndefined();
  expect(readDraft(storage, { ...scope, context: { type: 'client', id: 'agency-1' } }, 'new')).toBeUndefined();
  expect(readDraft(storage, { ...scope, context: { type: 'agency', id: 'agency-2' } }, 'new')).toBeUndefined();
  expect(readDraft(storage, scope, 'content-1')).toBeUndefined();
  expect(writeDraft(storage, { ...scope, userId: '' }, 'new', draft)).toBe(false);
  expect(writeDraft(storage, scope, 'https://token.example', draft)).toBe(false);
  expect(readDraft(storage, scope, 'new')).toEqual(draft);
});
it('expires after exactly 24 hours and discards future or missing timestamps', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  const storage = new Storage();
  writeDraft(storage, scope, 'new', draft);
  vi.setSystemTime(new Date('2026-11-07T11:59:59.999Z'));
  expect(readDraft(storage, scope, 'new')).toEqual(draft);
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  expect(readDraft(storage, scope, 'new')).toBeUndefined();
  expect(storage.length).toBe(0);
  writeDraft(storage, scope, 'new', draft);
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  expect(readDraft(storage, scope, 'new')).toBeUndefined();
  writeDraft(storage, scope, 'new', draft);
  const name = storage.key(0)!;
  const envelope = JSON.parse(storage.getItem(name)!); delete envelope.savedAt;
  storage.setItem(name, JSON.stringify(envelope));
  expect(readDraft(storage, scope, 'new')).toBeUndefined();
});
it('clears only the editor draft namespace across accounts and reports storage failures', () => {
  const storage = new Storage();
  storage.setItem('theme', 'dark'); storage.setItem('ageniza:other-feature', 'keep');
  writeDraft(storage, scope, 'new', draft);
  writeDraft(storage, { ...scope, userId: 'user-2' }, 'content-2', draft);
  expect(clearDrafts(storage)).toBe(true);
  expect([...storage.values.keys()]).toEqual(['theme', 'ageniza:other-feature']);
  expect(writeDraft(storage, scope, 'new', undefined)).toBe(true);
  const blocked = { get length(): number { throw new Error('blocked'); }, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
  expect(clearDrafts(blocked)).toBe(false);
});
it('stores only editorial fields and identifiers, never incidental tokens, media URLs or blobs', () => {
  const storage = new Storage();
  const extra = { ...draft, token: 'secret-token', mediaUrl: 'https://signed.example', blob: new Uint8Array([1]), input: { ...draft.input, accessToken: 'another-secret', uri: 'blob:private' } };
  expect(writeDraft(storage, scope, 'new', extra)).toBe(true);
  const encoded = storage.getItem(storage.key(0)!)!;
  expect(encoded).not.toMatch(/secret|signed\.example|blob:private|accessToken|mediaUrl/);
  expect(readDraft(storage, scope, 'new')).toEqual(draft);
  expect(writeDraft(storage, scope, 'new', { ...draft, input: { ...draft.input, mediaIds: ['https://signed.example'] } })).toBe(false);
  expect(writeDraft(storage, scope, 'new', { ...draft, input: { ...draft.input, coverId: 'blob:private' } })).toBe(false);
});
it('discards corrupt, oversized, wrong-version and invalid-shaped storage without throwing', () => {
  const storage = new Storage();
  writeDraft(storage, scope, 'new', draft);
  const name = storage.key(0)!;
  for (const encoded of ['{broken', 'a'.repeat(48 * 1024 + 1), JSON.stringify({ version: 2, savedAt: Date.now(), draft }), JSON.stringify({ version: 1, savedAt: Date.now(), draft: { ...draft, input: { ...draft.input, mediaIds: [null] } } })]) {
    storage.setItem(name, encoded);
    expect(readDraft(storage, scope, 'new')).toBeUndefined();
    expect(storage.getItem(name)).toBeNull();
  }
});
it('handles quota, blocked reads and blocked deletion without clearing unrelated storage', () => {
  const storage = new Storage();
  storage.setItem('other', 'keep');
  const quota = { ...storage, length: 1, key: storage.key.bind(storage), getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem() { throw new Error('QuotaExceededError'); } };
  expect(writeDraft(quota, scope, 'new', draft)).toBe(false);
  expect(readDraft({ ...quota, getItem() { throw new Error('SecurityError'); } }, scope, 'new')).toBeUndefined();
  expect(writeDraft({ ...quota, removeItem() { throw new Error('SecurityError'); } }, scope, 'new', undefined)).toBe(false);
  expect(storage.getItem('other')).toBe('keep');
});
it('rejects malformed editorial fields and revision without altering the stored draft', () => {
  const storage = new Storage();
  writeDraft(storage, scope, 'new', draft);
  expect(writeDraft(storage, scope, 'new', { ...draft, revision: 0 })).toBe(false);
  expect(writeDraft(storage, scope, 'new', { ...draft, revision: NaN })).toBe(false);
  expect(writeDraft(storage, scope, 'new', { ...draft, input: { ...draft.input, title: 'x'.repeat(121) } })).toBe(false);
  expect(writeDraft(storage, scope, 'new', { ...draft, input: { ...draft.input, mediaIds: Array.from({ length: 21 }, (_, i) => `media-${i}`) } })).toBe(false);
  expect(readDraft(storage, scope, 'new')).toEqual(draft);
  expect(writeDraft(storage, scope, 'new', undefined)).toBe(true);
  expect(readDraft(storage, scope, 'new')).toBeUndefined();
});
