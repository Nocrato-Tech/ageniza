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
  it('sends the read revision and reason for an agency approval, and refuses empty reasons', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { ...post, publishOn: post.date, media: [], tasks: [] });
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
    await expect(repo.move(post, 'approveByAgency', '  ')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await repo.move(post, 'approveByAgency', 'Aprovado pela cliente em reunião.');
    expect(request).toHaveBeenCalledWith(`/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/approve-by-agency`, { method: 'POST', body: { revision: 7, reason: 'Aprovado pela cliente em reunião.' } });
  });
  it('sends the actual publication date and the new schedule without changing the status on the client', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { ...post, publishOn: post.date, media: [], tasks: [] });
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
    await repo.move(post, 'publish', undefined, '2026-11-03');
    expect(request).toHaveBeenCalledWith(`/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/publish`, { method: 'POST', body: { publishedOn: '2026-11-03' } });
    await repo.move(post, 'reschedule', undefined, '2026-11-20');
    expect(request).toHaveBeenCalledWith(`/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/reschedule`, { method: 'POST', body: { publishOn: '2026-11-20' } });
    request.mockClear();
    await expect(repo.move(post, 'reschedule', undefined, '2026-02-30')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(post.status).toBe('awaiting_approval');
  });
  it('keeps portal media kinds for mixed carousels without requesting an agency library', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { ...post, publishOn: post.date, revision: 7, media: [{ id: 'video', position: 1, kind: 'video' }, { id: 'image', position: 2, kind: 'image' }] });
    const repo = remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false });
    expect((await repo.detail(clientId, contentId)).mediaKinds).toEqual({ video: 'video', image: 'image' });
    expect(request.mock.calls.every(([path]) => !String(path).startsWith('/agencies'))).toBe(true);
  });
  it('edits only the addressed task and requires the description and assignee contract', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { ...post, publishOn: post.date, media: [], tasks: [] });
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
    await repo.updateTask(post, { id: contentId, title: 'Revisar vídeo', description: 'Conferir a legenda.', assigneeId: clientId, dueOn: '2026-11-04', status: 'pending' });
    expect(request).toHaveBeenCalledWith(`/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/tasks/${contentId}`, { method: 'PATCH', body: { title: 'Revisar vídeo', description: 'Conferir a legenda.', assigneeMembershipId: clientId, dueOn: '2026-11-04' } });
  });
  it('loads the agency dashboard without scanning every media folder', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.endsWith('/me') ? { permissions: ['cliente.visualizar', 'conteudo.visualizar'], plan: { readOnly: false } } : path.includes('/clients?') ? { data: [{ id: clientId, name: 'Marca', instagramHandle: 'marca' }], meta: { totalPages: 1 } } : { data: { contents: [], storyScripts: [] } });
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'production', roleName: 'Produção', isOwner: false });
    const data = await repo.load('2026-11-01', '2026-11-30');
    expect(data.assets).toEqual([]);
    expect(request.mock.calls.some(([path]) => String(path).includes('media-folders'))).toBe(false);
  });
});
