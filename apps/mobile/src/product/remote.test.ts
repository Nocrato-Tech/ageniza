import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { Post } from './types';
import { remoteRepository } from './remote';
const clientId = '11111111-1111-4111-8111-111111111111';
const contentId = '22222222-2222-4222-8222-222222222222';
const agencyId = '33333333-3333-4333-8333-333333333333';
const post: Post = { id: contentId, clientId, title: 'Post', caption: 'Legenda', date: '2026-11-12', time: '', format: 'image', status: 'awaiting_approval', revision: 7, ownerId: '', folderId: '', coverId: null, mediaIds: [], comments: [], tasks: [] };
function client(request: ReturnType<typeof vi.fn>): ApiClient { return { request, clearSession: async () => {}, onExpired: () => {}, onAccessRequired: () => {} } as ApiClient; }
describe('real API adapter boundaries', () => {
  it('keeps client decisions scoped to the portal, with the revision read', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { id: contentId, title: 'Post', format: 'image', status: 'approved', publishOn: '2026-11-12', caption: 'Legenda', revision: 7, media: [], coverAssetId: null });
    const repo = remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false });
    await repo.move(post, 'approve');
    expect(request).toHaveBeenCalledWith(`/clients/${clientId}/contents/${contentId}/approve`, { method: 'POST', body: { revision: 7 } });
    expect(request.mock.calls.every(([path]) => !String(path).startsWith('/agencies'))).toBe(true);
    request.mockClear();
    await expect(repo.move(post, 'submit')).rejects.toThrow('agência');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects blank client adjustments before sending and never approves through an agency session', async () => {
    const request = vi.fn();
    await expect(remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false }).move(post, 'changes', '  ')).rejects.toThrow();
    await expect(remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false }).move(post, 'approve')).rejects.toThrow('acesso próprio');
    expect(request).not.toHaveBeenCalled();
  });
  it('honors portal read-only status and does not synthesize private content fields', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/contents?') ? { data: [{ id: contentId, title: 'Em produção', format: 'image', status: 'in_production', publishOn: '2026-11-12' }] } : { name: 'Clínica', instagramHandle: 'clinica', agencyReadOnly: true });
    const data = await remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false }).load('2026-11-01', '2026-11-30');
    expect(data.readOnly).toBe(true);
    expect(data.posts[0].caption).toBe(''); expect(data.posts[0].tasks).toEqual([]); expect(data.posts[0].mediaIds).toEqual([]);
    expect(data.people).toEqual([]);
  });
});
