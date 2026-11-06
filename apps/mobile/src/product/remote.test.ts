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
  it('creates with exactly the selected media in one write, keeping a cover out of the reel list', async () => {
    const videoId = '44444444-4444-4444-8444-444444444444';
    const coverId = '55555555-5555-4555-8555-555555555555';
    const request = vi.fn(async (path: string, options?: { method?: string }) => options?.method === 'POST' ? { id: contentId } : path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : path.includes('/assets') ? { data: [], meta: { totalPages: 1 } } : { ...post, folderId: clientId, publishOn: post.date, media: [], tasks: [] });
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
    await repo.save({ ...post, format: 'reels', folderId: clientId, mediaIds: [videoId], coverId });
    const writes = request.mock.calls.filter(([, options]) => options?.method === 'POST' || options?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ method: 'POST', body: expect.objectContaining({ mediaAssetIds: [videoId], coverAssetId: coverId }) });
  });
  it('reports uploaded bytes only after successful parts and ready only after server confirmation', async () => {
    let finish: () => void = () => {};
    const confirmed = new Promise<void>((resolve) => { finish = resolve; });
    const request = vi.fn(async (path: string, options?: { body?: { partNumbers?: number[] } }) => {
      if (path.endsWith('/media/uploads')) return { assetId: contentId, category: 'video', upload: { type: 'multipart', partCount: 2, partSizeBytes: 3 } };
      if (path.endsWith('/parts')) return { parts: [{ url: `https://storage.test/${options?.body?.partNumbers?.[0]}` }] };
      if (path.endsWith('/complete')) await confirmed;
      return {};
    });
    const put = vi.fn(async () => new Response('', { status: 200, headers: { etag: 'part-etag' } }));
    vi.stubGlobal('fetch', put);
    const progress = vi.fn();
    try {
      const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
      const pending = repo.upload(clientId, clientId, { uri: '', name: 'Reel.mp4', mimeType: 'video/mp4', size: 6, file: new File(['abcdef'], 'Reel.mp4') }, progress);
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'confirming', completedBytes: 6, totalBytes: 6 })));
      expect(progress.mock.calls.some(([state]) => state.phase === 'ready')).toBe(false);
      expect(progress.mock.calls.filter(([state]) => state.phase === 'sending').map(([state]) => state.completedBytes)).toEqual([0, 3, 6]);
      finish(); await pending;
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready', name: 'Reel.mp4' }));
    } finally { finish(); vi.unstubAllGlobals(); }
  });
  it('reports the created id before a later detail reload fails, allowing a PATCH retry', async () => {
    const mediaId = '44444444-4444-4444-8444-444444444444';
    const input = { ...post, folderId: clientId, coverId: null, mediaIds: [mediaId] };
    const request = vi.fn().mockResolvedValueOnce({ id: contentId }).mockRejectedValueOnce(new Error('network'));
    const repo = remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false });
    const created = vi.fn();
    await expect(repo.save(input, undefined, created)).rejects.toThrow('network');
    expect(created).toHaveBeenCalledExactlyOnceWith(contentId);
    expect(created.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
    request.mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : path.includes('media-folders') ? { data: [], meta: { totalPages: 1 } } : { ...post, folderId: clientId, publishOn: post.date, media: [], tasks: [] });
    await repo.save(input, contentId, created);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls[2]).toEqual([`/agencies/${agencyId}/clients/${clientId}/contents/${contentId}`, { method: 'PATCH', body: expect.objectContaining({ mediaAssetIds: [mediaId] }) }]);
  });

  it('keeps client decisions scoped to the portal, with the revision read', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/threads') ? { data: [], meta: { totalPages: 1 } } : { id: contentId, title: 'Post', format: 'image', status: 'approved', publishOn: '2026-11-12', caption: 'Legenda', revision: 7, media: [], coverAssetId: null });
    const repo = remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false });
    await repo.move(post, 'approve');
    expect(request).toHaveBeenCalledWith(`/clients/${clientId}/contents/${contentId}/approve`, { method: 'POST', body: { revision: 7 } });
    expect(request.mock.calls.every(([path]) => !String(path).startsWith('/agencies'))).toBe(true);
    await repo.move({ ...post, status: 'approved' }, 'withdraw-approval');
    expect(request).toHaveBeenCalledWith(`/clients/${clientId}/contents/${contentId}/withdraw-approval`, { method: 'POST', body: { revision: 7 } });
    request.mockClear();
    await expect(repo.move(post, 'submit')).rejects.toThrow('agência');
    expect(request).not.toHaveBeenCalled();
    await expect(remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false }).move(post, 'withdraw-approval')).rejects.toThrow('acesso próprio');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects blank client adjustments before sending and never approves through an agency session', async () => {
    const request = vi.fn();
    await expect(remoteRepository(client(request), { type: 'client', clientId, clientName: 'Clínica', agencyId, agencyName: 'Agência', onboardingPending: false }).move(post, 'changes', '  ')).rejects.toThrow();
    await expect(remoteRepository(client(request), { type: 'agency', agencyId, agencyName: 'Agência', roleKey: 'admin', roleName: 'Admin', isOwner: false }).move(post, 'approve')).rejects.toThrow('acesso próprio');
    expect(request).not.toHaveBeenCalled();
  });
  it('honors portal read-only status and does not synthesize private content fields', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.includes('/awaiting-approval?') ? { data: [], meta: { totalPages: 1 } } : path.includes('/contents?') ? { data: [{ id: contentId, title: 'Em produção', format: 'image', status: 'in_production', publishOn: '2026-11-12' }] } : { name: 'Clínica', instagramHandle: 'clinica', agencyReadOnly: true });
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


describe('portal approval inbox', () => {
  it('loads every pending page independently of the calendar month and only from its own portal', async () => {
    const first = { ...post, publishOn: '2026-10-15', thumbnailAssetId: null };
    const second = { ...post, id: '44444444-4444-4444-8444-444444444444', publishOn: '2026-12-10', thumbnailAssetId: null };
    const request = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/awaiting-approval?')) return { data: [path.includes('page=2&') ? second : first], meta: { totalPages: 2 } };
      if (path.includes('/contents?')) return { data: [] };
      return { name: 'Marca', instagramHandle: null, agencyReadOnly: false, onboardingSeenAt: '2026-10-01' };
    });
    const repo = remoteRepository(client(request), { type: 'client', clientId, clientName: 'Marca', agencyId, agencyName: 'Agência', onboardingPending: false });
    const data = await repo.load('2026-11-01', '2026-11-30');
    expect(data.posts).toEqual([]);
    expect(data.pendingApprovals?.map((item) => [item.id, item.date])).toEqual([[contentId, '2026-10-15'], [second.id, '2026-12-10']]);
    expect(request.mock.calls.filter(([path]) => String(path).includes('/awaiting-approval?'))).toEqual([[`/clients/${clientId}/contents/awaiting-approval?page=1&pageSize=100`], [`/clients/${clientId}/contents/awaiting-approval?page=2&pageSize=100`]]);
    expect(request.mock.calls.every(([path]) => String(path).startsWith(`/clients/${clientId}`))).toBe(true);
    expect(data.pendingApprovals?.every((item) => item.caption === '' && item.mediaIds.length === 0)).toBe(true);
  });
});
