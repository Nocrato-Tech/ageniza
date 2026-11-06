import type { Context, CreateAgencyResponse, CreateMediaUploadResponse, ContentDetail, ContentFeedResponse, ContentPeriodResponse, CollaboratorListResponse, MediaFolderAsset } from '@ageniza/contracts';
import { CreateAgencyRequestSchema, CreateClientRequestSchema, CreateContentRequestSchema, CreateContentTaskRequestSchema } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';
import { monthPeriod } from '../contents/period';
import { demoAgencyName } from './config';

type Agency = Extract<Context, { type: 'agency' }>;
type Page<T> = { data: T[]; meta: { totalPages: number } };
export async function createDemoWorkspace(api: ApiClient): Promise<Agency> {
  const result = await api.request<CreateAgencyResponse>('/agencies', { method: 'POST', body: CreateAgencyRequestSchema.parse({ name: demoAgencyName }) });
  return result.context;
}

export async function populateDemoWorkspace(api: ApiClient, context: Agency, image: Blob, progress: (text: string) => void, now = new Date(), transport: typeof fetch = fetch) {
  if (!context.isOwner || context.agencyName !== demoAgencyName) throw new Error('Os exemplos só podem ser preparados na sua agência de demonstração.');
  const root = `/agencies/${context.agencyId}`;
  async function all<T>(path: string): Promise<T[]> {
    const rows: T[] = []; let page = 1; let last = 1;
    do { const result = await api.request<Page<T>>(`${path}?page=${page}&pageSize=100`); rows.push(...result.data); last = result.meta.totalPages; page += 1; } while (page <= last);
    return rows;
  }
  const people = await all<CollaboratorListResponse['data'][number]>(`${root}/collaborators`);
  const self = people.find((person) => person.isSelf);
  if (!self) throw new Error('Não foi possível encontrar seu vínculo na equipe. Atualize e tente novamente.');
  const clients = await all<{ id: string; name: string }>(`${root}/clients`);
  const period = monthPeriod(0, now);
  const day = (value: number) => `${period.from.slice(0, 8)}${String(value).padStart(2, '0')}`;
  const brands = [
    { name: 'Clínica Vida · Exemplo', titles: ['Pequenos hábitos, mais saúde', 'Check-up: por onde começar?', 'Cuidar de você é prioridade'] },
    { name: 'Espaço Equilíbrio · Exemplo', titles: ['Movimento para o seu dia', 'Uma pausa para respirar', 'Bem-estar em cada escolha'] }
  ];
  for (const brand of brands) {
    progress(`Preparando ${brand.name}`);
    let client = clients.find((value) => value.name === brand.name);
    if (!client) { client = await api.request<{ id: string; name: string }>(`${root}/clients`, { method: 'POST', body: CreateClientRequestSchema.parse({ name: brand.name }) }); clients.push(client); }
    const base = `${root}/clients/${client.id}`;
    const folders = await all<{ id: string; name: string }>(`${base}/media-folders`);
    let folder = folders.find((value) => value.name === 'Conteúdos de demonstração');
    if (!folder) folder = await api.request<{ id: string; name: string }>(`${base}/media-folders`, { method: 'POST', body: { name: 'Conteúdos de demonstração' } });
    const assets = await all<MediaFolderAsset>(`${base}/media-folders/${folder.id}/assets`);
    let assetId = assets.find((value) => value.category === 'image')?.id;
    if (!assetId) {
      progress(`Enviando capa de ${brand.name}`);
      const upload = await api.request<CreateMediaUploadResponse>(`${root}/media/uploads`, { method: 'POST', body: { fileName: 'saude-demonstracao.png', contentType: 'image/png', declaredSizeBytes: image.size, clientId: client.id, folderId: folder.id } });
      if (upload.upload.type !== 'single') throw new Error('A imagem de exemplo precisa de envio simples.');
      const response = await transport(upload.upload.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: image, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('Não foi possível enviar a capa. Os registros já criados foram preservados.');
      await api.request(`${root}/media/uploads/${upload.assetId}/complete`, { method: 'POST', body: {} });
      assetId = upload.assetId;
    }
    // The month asked for lists every format; the whole feed (image, carousel and reels only) finds what an earlier run created in another month.
    const month = await api.request<ContentPeriodResponse>(`${base}/contents?from=${period.from}&to=${period.to}`);
    const existing: { id: string; title: string; publishOn: string }[] = [...month.data.contents];
    for (let cursor: string | null = null, first = true; first || cursor !== null; first = false) {
      const page: ContentFeedResponse = await api.request<ContentFeedResponse>(`${base}/contents/feed${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`);
      existing.push(...page.data.contents.filter((item) => !existing.some((known) => known.id === item.id))); cursor = page.data.nextCursor;
    }
    for (const [index, title] of brand.titles.entries()) {
      progress(`Preparando conteúdo: ${title}`);
      let post: Pick<ContentDetail, 'id' | 'publishOn'> | undefined = existing.find((value) => value.title === title);
      if (!post) {
        const created = await api.request<ContentDetail>(`${base}/contents`, { method: 'POST', body: CreateContentRequestSchema.parse({ title, format: 'image', publishOn: day([5, 15, 25][index]), publishAtTime: '10:00', folderId: folder.id, mediaAssetIds: [assetId], caption: `${title}. Informação de exemplo para demonstrar o planejamento de conteúdo da agência.\n\nEste material é fictício e não constitui orientação médica.`, ownerMembershipId: self.membershipId }) });
        post = created;
      }
      const detail = await api.request<ContentDetail>(`${base}/contents/${post.id}`);
      if (!detail.tasks.some((task) => task.title === 'Revisar legenda e identidade visual')) await api.request(`${base}/contents/${post.id}/tasks`, { method: 'POST', body: CreateContentTaskRequestSchema.parse({ title: 'Revisar legenda e identidade visual', assigneeMembershipId: self.membershipId, dueOn: post.publishOn }) });
    }
  }
  progress('Exemplos salvos na API. Tudo pronto para usar o app.');
}
