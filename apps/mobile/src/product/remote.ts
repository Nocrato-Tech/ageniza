import type { AgencyMeResponse, ClientListResponse, CollaboratorListResponse, ContentDetail, ContentPeriodResponse, Context, CreateMediaUploadResponse, MediaFolder, MediaFolderAsset, PortalClientResponse, PortalContentDetail, PortalContentPeriodResponse, RequestMediaUploadPartsResponse } from '@ageniza/contracts';
import { CreateContentRequestSchema, UpdateContentRequestSchema, CreateContentTaskRequestSchema, PortalApproveContentRequestSchema, PortalRequestContentChangesRequestSchema, CreateClientRequestSchema, UpdateMyProfileRequestSchema, CreateMediaFolderRequestSchema, CommentBodySchema, UpdateContentTaskRequestSchema, ApproveContentByAgencyRequestSchema, PublishContentRequestSchema, RescheduleContentRequestSchema } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';
import type { Asset, Client, Comment, Data, Folder, Post, PostInput, Repository } from './types';

type Page<T> = { data: T[]; meta: { totalPages: number } };
export function remoteRepository(api: ApiClient, context: Context): Repository {
  const agency = context.type === 'agency';
  const root = agency ? `/agencies/${context.agencyId}` : '';
  const base = (clientId: string) => agency ? `${root}/clients/${clientId}` : `/clients/${context.type === 'client' ? context.clientId : clientId}`;
  const agencyOnly = () => { if (!agency) throw new Error('Esta ação é exclusiva da agência.'); };
  async function all<T>(path: string): Promise<T[]> { const items: T[] = []; let page = 1; let last = 1; do { const result = await api.request<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`); items.push(...result.data); last = result.meta.totalPages; page += 1; } while (page <= last); return items; }
  const libraries = new Map<string, { folders: Folder[]; assets: Asset[] }>();
  const empty: Data = { version: 2, clients: [], posts: [], people: [], folders: [], assets: [], activities: [], profile: { name: 'Minha conta', agency: agency ? context.agencyName : context.clientName }, permissions: [], readOnly: false };
  function fromDetail(clientId: string, value: ContentDetail | PortalContentDetail): Post {
    const full = 'revision' in value;
    return { id: value.id, clientId, title: value.title, format: value.format, status: value.status, date: value.publishOn, time: 'publishAtTime' in value ? value.publishAtTime ?? '' : '', caption: full ? value.caption ?? '' : '', revision: full ? value.revision : 0, folderId: 'folderId' in value ? value.folderId : '', ownerId: 'owner' in value ? value.owner?.membershipId ?? '' : '', mediaIds: full ? value.media.map((item) => item.id) : [], mediaKinds: full ? Object.fromEntries(value.media.flatMap((item) => 'kind' in item ? [[item.id, item.kind]] : [])) : {}, coverId: 'coverAssetId' in value ? value.coverAssetId : null, tasks: 'tasks' in value ? value.tasks.map((task) => ({ id: task.id, title: task.title, description: task.description, assigneeId: task.assignee?.membershipId ?? '', dueOn: task.dueOn, status: task.status })) : [], comments: [] };
  }
  const repo: Repository = {
    demo: false, context,
    load: async (from, to) => {
      const data = { ...empty, clients: [] as Client[], posts: [] as Post[], folders: [] as Folder[], assets: [] as Asset[] };
      if (agency) {
        const me = await api.request<AgencyMeResponse>(`${root}/me`);
        data.permissions = me.permissions; data.readOnly = me.plan.readOnly;
        const clients = me.permissions.includes('cliente.visualizar') ? await all<ClientListResponse['data'][number]>(`${root}/clients`) : [];
        data.clients = clients.map((client) => ({ id: client.id, name: client.name, handle: client.instagramHandle ?? '', photoUrl: client.photoUrl }));
        if (me.permissions.includes('colaborador.visualizar')) { const people = await all<CollaboratorListResponse['data'][number]>(`${root}/collaborators`); data.people = people.map((person) => ({ id: person.membershipId, name: person.name, job: person.jobTitle ?? '', role: person.role.name, email: person.email, self: person.isSelf, owner: person.isOwner })); const self = data.people.find((person) => person.self); if (self) data.profile = { ...data.profile, name: self.name }; }
        if (me.permissions.includes('conteudo.visualizar')) {
          for (let index = 0; index < data.clients.length; index += 4) {
            const batches = await Promise.all(data.clients.slice(index, index + 4).map(async (client) => {
              const period = await api.request<ContentPeriodResponse>(`${base(client.id)}/contents?from=${from}&to=${to}`);
              return period.data.contents.map((post) => ({ ...fromDetail(client.id, { ...post, caption: null, folderId: '', media: [], tasks: [], approvedBy: null, approvedAt: null, approvedByAgencyReason: null, cancelledAt: null, createdAt: '', clientId: client.id, conversation: { threadId: null, commentCount: 0, lastCommentAt: null } }), thumbnailId: post.thumbnailAssetId }));
            }));
            data.posts.push(...batches.flat());
          }
          for (const library of libraries.values()) { data.folders.push(...library.folders); data.assets.push(...library.assets); }
        }
      } else {
        const clientId = context.clientId;
        const client = await api.request<PortalClientResponse>(base(clientId));
        data.clients = [{ id: clientId, name: client.name, handle: client.instagramHandle ?? '', photoUrl: client.photoUrl }];
        data.readOnly = client.agencyReadOnly; data.onboardingPending = client.onboardingSeenAt === null;
        const period = await api.request<PortalContentPeriodResponse>(`${base(clientId)}/contents?from=${from}&to=${to}`);
        data.posts = period.data.map((post) => ({ ...fromDetail(clientId, post.status === 'in_production' ? post : { ...post, revision: 0, caption: null, media: [] }), thumbnailId: 'thumbnailAssetId' in post ? post.thumbnailAssetId : null }));
      }
      data.activities = data.posts.filter((post) => agency ? post.status === 'adjusting' || post.status === 'awaiting_approval' : post.status === 'awaiting_approval' || post.status === 'published').map((post) => ({ id: `${post.id}:${post.status}:${post.revision}`, title: post.status === 'adjusting' ? 'Ajuste solicitado' : post.status === 'published' ? 'Conteúdo publicado' : agency ? 'Aguardando o cliente' : 'Sua aprovação está pendente', body: post.title, postId: post.id, read: false, at: post.date }));
      return data;
    },
    detail: async (clientId, id) => {
      const value = await api.request<ContentDetail | PortalContentDetail>(`${base(clientId)}/contents/${id}`);
      const post = fromDetail(clientId, value);
      if (agency && post.folderId && post.mediaIds.length) { const assets = await all<MediaFolderAsset>(`${base(clientId)}/media-folders/${post.folderId}/assets`); post.mediaKinds = Object.fromEntries(assets.filter((asset) => post.mediaIds.includes(asset.id)).map((asset) => [asset.id, asset.category])); }
      if (agency || post.status !== 'in_production') { const threads = await all<{ id: string }>(`${base(clientId)}/threads?contentId=${id}`); for (const thread of threads) { const comments = await all<{ id: string; body: string; side: 'agency' | 'client'; author: { name: string } | null; createdAt: string }>(`${base(clientId)}/threads/${thread.id}/comments`); post.comments.push(...comments.map((comment): Comment => ({ ...comment, name: comment.author?.name ?? 'Agência' }))); } }
      return post;
    },
    save: async (input: PostInput, id, onCreated) => {
      agencyOnly();
      const fields = { title: input.title, format: input.format, publishOn: input.date, publishAtTime: input.time || null, caption: input.caption, folderId: input.folderId, coverAssetId: input.coverId, ...(input.ownerId ? { ownerMembershipId: input.ownerId } : {}) };
      const value = await api.request<ContentDetail>(`${base(input.clientId)}/contents${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: id ? UpdateContentRequestSchema.parse({ ...fields, mediaAssetIds: input.mediaIds }) : CreateContentRequestSchema.parse(fields) });
      if (!id) onCreated?.(value.id);
      if (!id && input.mediaIds.length) await api.request(`${base(input.clientId)}/contents/${value.id}`, { method: 'PATCH', body: UpdateContentRequestSchema.parse({ mediaAssetIds: input.mediaIds }) });
      return repo.detail(input.clientId, value.id);
    },
    move: async (post, action, comment, date) => {
      if (action === 'approve' || action === 'changes') { if (agency) throw new Error('A aprovação deve ser feita no acesso próprio do cliente.'); }
      else agencyOnly();
      const endpoint = action === 'changes' ? 'request-changes' : action === 'approveByAgency' ? 'approve-by-agency' : action;
      const body = action === 'approve' ? PortalApproveContentRequestSchema.parse({ revision: post.revision }) : action === 'changes' ? PortalRequestContentChangesRequestSchema.parse({ revision: post.revision, comment }) : action === 'approveByAgency' ? ApproveContentByAgencyRequestSchema.parse({ revision: post.revision, reason: comment }) : action === 'publish' ? PublishContentRequestSchema.parse(date ? { publishedOn: date } : {}) : action === 'reschedule' ? RescheduleContentRequestSchema.parse(date ? { publishOn: date } : {}) : {};
      await api.request(`${base(post.clientId)}/contents/${post.id}/${endpoint}`, { method: 'POST', body });
      return repo.detail(post.clientId, post.id);
    },
    task: async (post, task, action, comment) => { agencyOnly(); await api.request(`${base(post.clientId)}/contents/${post.id}/tasks/${task.id}/${action}`, { method: 'POST', body: action === 'return' ? { comment: CommentBodySchema.parse(comment) } : {} }); return repo.detail(post.clientId, post.id); },
    updateTask: async (post, task) => { agencyOnly(); await api.request(`${base(post.clientId)}/contents/${post.id}/tasks/${task.id}`, { method: 'PATCH', body: UpdateContentTaskRequestSchema.parse({ title: task.title, description: task.description, assigneeMembershipId: task.assigneeId, dueOn: task.dueOn }) }); return repo.detail(post.clientId, post.id); },
    addTask: async (post, input) => { agencyOnly(); await api.request(`${base(post.clientId)}/contents/${post.id}/tasks`, { method: 'POST', body: CreateContentTaskRequestSchema.parse({ title: input.title, description: input.description, assigneeMembershipId: input.assigneeId, dueOn: input.dueOn }) }); return repo.detail(post.clientId, post.id); },
    comment: async (post, body) => { await api.request(`${base(post.clientId)}/threads`, { method: 'POST', body: { subject: { contentId: post.id }, body: CommentBodySchema.parse(body) } }); return repo.detail(post.clientId, post.id); },
    addClient: async (name) => { agencyOnly(); const client = await api.request<{ id: string; name: string }>(`${root}/clients`, { method: 'POST', body: CreateClientRequestSchema.parse({ name }) }); return { id: client.id, name: client.name, handle: '' }; },
    addFolder: async (clientId, name, parentId) => { agencyOnly(); const folder = await api.request<MediaFolder>(`${base(clientId)}/media-folders`, { method: 'POST', body: CreateMediaFolderRequestSchema.parse({ name, ...(parentId ? { parentId } : {}) }) }); return { id: folder.id, clientId, name: folder.name, parentId: folder.parentId }; },
    library: async (clientId) => {
      agencyOnly();
      const folders = await all<MediaFolder>(`${base(clientId)}/media-folders`);
      const library = { folders: folders.map((folder) => ({ id: folder.id, clientId, name: folder.name, parentId: folder.parentId })), assets: [] as Asset[] };
      for (let index = 0; index < folders.length; index += 4) {
        const batches = await Promise.all(folders.slice(index, index + 4).map(async (folder) => (await all<MediaFolderAsset>(`${base(clientId)}/media-folders/${folder.id}/assets`)).map((asset) => ({ id: asset.id, clientId, folderId: folder.id, name: `${asset.category}-${asset.id.slice(0, 8)}`, kind: asset.category, size: asset.sizeBytes }))));
        library.assets.push(...batches.flat());
      }
      libraries.set(clientId, library); return library;
    },
    removeAsset: async (asset) => { agencyOnly(); await api.request(`${base(asset.clientId)}/media-folders/${asset.folderId}/assets/${asset.id}/remove`, { method: 'POST' }); libraries.delete(asset.clientId); },
    upload: async (clientId, folderId, file) => {
      agencyOnly(); const blob = file.file ?? await (await fetch(file.uri)).blob();
      const created = await api.request<CreateMediaUploadResponse>(`${root}/media/uploads`, { method: 'POST', body: { fileName: file.name, contentType: file.mimeType, declaredSizeBytes: blob.size, clientId, folderId } });
      if (created.upload.type === 'single') { const response = await fetch(created.upload.url, { method: 'PUT', headers: { 'Content-Type': file.mimeType }, body: blob }); if (!response.ok) throw new Error('O envio falhou. Tente selecionar o arquivo novamente.'); await api.request(`${root}/media/uploads/${created.assetId}/complete`, { method: 'POST', body: {} }); }
      else { const parts = []; for (let number = 1; number <= created.upload.partCount; number += 1) { const signed = await api.request<RequestMediaUploadPartsResponse>(`${root}/media/uploads/${created.assetId}/parts`, { method: 'POST', body: { partNumbers: [number] } }); const response = await fetch(signed.parts[0].url, { method: 'PUT', body: blob.slice((number - 1) * created.upload.partSizeBytes, number * created.upload.partSizeBytes) }); const eTag = response.headers.get('etag'); if (!response.ok || !eTag) throw new Error('Não foi possível confirmar uma parte do vídeo. Tente novamente.'); parts.push({ partNumber: number, eTag }); } await api.request(`${root}/media/uploads/${created.assetId}/complete`, { method: 'POST', body: { parts } }); }
      return { id: created.assetId, clientId, folderId, name: file.name, kind: created.category, size: blob.size };
    },
    assetUrl: async (clientId, postId, id, variant = 'original') => { const path = agency ? `${root}/media/${id}/download-url?variant=${variant}` : `${base(clientId)}/contents/${postId}/media/${id}/url?variant=${variant}`; return (await api.request<{ url: string }>(path)).url; },
    profile: async (name) => { await api.request('/me/profile', { method: 'PATCH', body: UpdateMyProfileRequestSchema.parse({ name }) }); }
  };
  return repo;
}
