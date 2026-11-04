import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => { const store = new Map<string, string>(); return { default: { getItem: async (key: string) => store.get(key) ?? null, setItem: async (key: string, value: string) => { store.set(key, value); } } }; });
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import { demoRepository, seed, transition } from './demo';
import type { PostInput, Side } from './types';

describe('integrated local workspace', () => {
  let side: Side;
  beforeEach(() => { side = 'agency'; });
  it('persists creation, media selection and client approval across repository instances', async () => {
    const repo = demoRepository(() => side); await repo.reset!();
    const sample = seed().posts[1];
    const input: PostInput = { ...sample, title: 'Um conteúdo novo' };
    const created = await repo.save(input);
    expect(created.status).toBe('in_production');
    const submitted = await repo.move(created, 'submit');
    side = 'client';
    await expect(repo.move(submitted, 'changes', '   ')).rejects.toThrow();
    const adjusted = await repo.move(submitted, 'changes', 'Trocar a chamada.');
    expect(adjusted.comments.at(-1)?.body).toBe('Trocar a chamada.');
    side = 'agency';
    const resubmitted = await repo.move(adjusted, 'submit');
    side = 'client';
    const approved = await repo.move(resubmitted, 'approve');
    expect(approved.status).toBe('approved');
    expect((await demoRepository(() => side).detail(approved.clientId, approved.id)).status).toBe('approved');
  });
  it('blocks submission until all tasks are approved and does not mutate the original', () => {
    const post = seed().posts[0];
    expect(() => transition(post, 'submit', 'agency')).toThrow('tarefas');
    expect(post.status).toBe('in_production');
    expect(() => transition({ ...post, tasks: [], mediaIds: [] }, 'submit', 'agency')).toThrow('mídias');
    expect(() => transition({ ...post, tasks: [] }, 'submit', 'client')).toThrow();
    expect(transition({ ...post, tasks: [] }, 'submit', 'agency').status).toBe('awaiting_approval');
  });
  it('returns approved material to review when the public caption changes, preserving approval on title-only edits', async () => {
    const repo = demoRepository(() => side); await repo.reset!();
    const original = seed().posts[2];
    const titleOnly = await repo.save({ ...original, title: 'Outro título interno' }, original.id);
    expect(titleOnly.status).toBe('approved');
    const changed = await repo.save({ ...titleOnly, caption: 'Legenda revisada.' }, original.id);
    expect(changed.status).toBe('awaiting_approval');
    expect(changed.revision).toBeGreaterThan(titleOnly.revision);
  });
  it('refuses stale approval and reading another client, and keeps reset isolated', async () => {
    const repo = demoRepository(() => side); await repo.reset!();
    const original = seed().posts[1];
    await repo.save({ ...original, caption: 'Nova legenda' }, original.id);
    side = 'client';
    await expect(repo.move(original, 'approve')).rejects.toThrow('mudou');
    await expect(repo.detail('wine', original.id)).rejects.toThrow('não encontrado');
    side = 'agency';
    await repo.reset!();
    expect((await repo.detail(original.clientId, original.id)).caption).toBe(original.caption);
  });
});
