import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { Context } from '@ageniza/contracts';
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import { allowsDemoWorkspace, demoAgencyName } from './config';
import { createDemoWorkspace, populateDemoWorkspace } from './workspace';

const agencyId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const agency: Extract<Context, { type: 'agency' }> = { type: 'agency', agencyId, agencyName: demoAgencyName, isOwner: true, roleKey: 'owner', roleName: 'Proprietário' };
const now = new Date('2026-11-05T12:00:00Z');
function world() {
  let next = 3;
  const id = () => `${String(next++).padStart(8, '0')}-3333-4333-8333-333333333333`;
  const clients: { id: string; name: string }[] = [];
  const folders: { id: string; name: string; client: string }[] = [];
  const assets: { id: string; folder: string; category: string }[] = [];
  const posts: { id: string; client: string; title: string; publishOn: string; tasks: { title: string }[] }[] = [];
  const uploads = new Map<string, string>();
  let failTitle = '';
  const request = vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
    const body = options?.body as Record<string, string>;
    const method = options?.method ?? 'GET';
    if (path === '/agencies') return { context: agency };
    if (!path.startsWith(`/agencies/${agencyId}/`)) throw new Error('Cross-agency request');
    if (path.includes('/collaborators')) return { data: [{ membershipId: memberId, isSelf: true }], meta: { totalPages: 1 } };
    const client = path.split('/clients/')[1]?.split('/')[0];
    if (/\/clients\?/.test(path)) return { data: [...clients], meta: { totalPages: 1 } };
    if (path.endsWith('/clients') && method === 'POST') { const row = { id: id(), name: body.name }; clients.push(row); return row; }
    if (/\/media-folders\?/.test(path)) return { data: folders.filter((row) => row.client === client), meta: { totalPages: 1 } };
    if (path.endsWith('/media-folders')) { const row = { id: id(), name: body.name, client: client! }; folders.push(row); return row; }
    if (/\/assets\?/.test(path)) return { data: assets.filter((row) => row.folder === path.split('/media-folders/')[1].split('/')[0]), meta: { totalPages: 1 } };
    if (path.endsWith('/media/uploads')) { const assetId = id(); uploads.set(assetId, body.folderId); return { assetId, upload: { type: 'single', url: 'https://storage.example.test/upload' } }; }
    if (path.endsWith('/complete')) { const assetId = path.split('/uploads/')[1].split('/')[0]; assets.push({ id: assetId, folder: uploads.get(assetId)!, category: 'image' }); return; }
    if (/\/contents\?/.test(path)) return { data: { contents: posts.filter((row) => row.client === client) }, meta: {} };
    if (path.endsWith('/contents') && method === 'POST') {
      if (body.title === failTitle) throw new Error('network interrupted');
      const row = { id: id(), client: client!, title: body.title, publishOn: body.publishOn, tasks: [] }; posts.push(row); return row;
    }
    const postId = path.split('/contents/')[1]?.split('/')[0];
    const post = posts.find((row) => row.id === postId);
    if (path.endsWith('/tasks') && post) { post.tasks.push({ title: body.title }); return; }
    if (post) return post;
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const api = { request } as unknown as ApiClient;
  return { api, request, clients, posts, folders, assets, fail: (title: string) => { failTitle = title; } };
}

describe('demo uses real endpoint contracts', () => {
  it('creates only through the authenticated agency endpoint', async () => {
    const w = world();
    expect(await createDemoWorkspace(w.api)).toEqual(agency);
    expect(w.request).toHaveBeenCalledExactlyOnceWith('/agencies', { method: 'POST', body: { name: demoAgencyName } });
  });
  it('writes synthetic content to the selected agency and reuses server records on retry', async () => {
    const w = world(); const transport = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const populate = () => populateDemoWorkspace(w.api, agency, new Blob(['png']), vi.fn(), now, transport);
    w.fail('Check-up: por onde começar?');
    await expect(populate()).rejects.toThrow('network interrupted');
    expect(w.clients).toHaveLength(1); expect(w.posts).toHaveLength(1);
    w.fail(''); await populate(); await populate();
    expect(w.clients).toHaveLength(2); expect(w.folders).toHaveLength(2); expect(w.assets).toHaveLength(2); expect(w.posts).toHaveLength(6);
    expect(w.posts.every((post) => post.tasks.length === 1 && post.publishOn.startsWith('2026-11-'))).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(w.request.mock.calls.some(([path]) => path.includes('/invitations') || path.includes('/simulated-payment'))).toBe(false);
  });
  it('refuses a normal agency or a non-owner before reading or writing', async () => {
    const w = world();
    for (const context of [{ ...agency, isOwner: false }, { ...agency, agencyName: 'Actual agency' }]) await expect(populateDemoWorkspace(w.api, context, new Blob(), vi.fn(), now)).rejects.toThrow('agência de demonstração');
    expect(w.request).not.toHaveBeenCalled();
  });
  it('fails visibly when upload fails instead of pretending media and posts exist', async () => {
    const w = world();
    await expect(populateDemoWorkspace(w.api, agency, new Blob(['png']), vi.fn(), now, vi.fn().mockResolvedValue(new Response(null, { status: 403 })))).rejects.toThrow('enviar a capa');
    expect(w.assets).toHaveLength(0); expect(w.posts).toHaveLength(0);
  });
  it('enables only explicitly flagged web exports with the development API', () => {
    expect(allowsDemoWorkspace('web', 'true', 'https://dev.ageniza.com.br/api')).toBe(true);
    for (const [platform, flag, url] of [['ios', 'true', 'https://dev.ageniza.com.br/api'], ['web', '', 'https://dev.ageniza.com.br/api'], ['web', 'true', 'https://ageniza.com.br/api'], ['web', 'true', 'https://dev.ageniza.com.br.evil.test/api'], ['web', 'true', 'https://user:password@dev.ageniza.com.br/api']]) expect(allowsDemoWorkspace(platform, flag, url)).toBe(false);
  });
});
