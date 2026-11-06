import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { ContentCaptionSchema, ContentDaySchema, ContentTitleSchema, ContentTimeSchema, CommentBodySchema, ClientNameSchema, MediaFolderNameSchema } from '@ageniza/contracts';
import { monthPeriod } from '../contents/period';
import type { Asset, Data, Post, PostInput, Repository, Side } from './types';
import { newId } from './types';

const key = 'ageniza.mobile.demo.v2';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function seed(): Data {
  const month = monthPeriod().from.slice(0, 7);
  const clients = [{ id: 'vida', name: 'Clínica Vida', handle: 'clinicavida' }, { id: 'wine', name: 'Wine Cup', handle: 'winecup' }, { id: 'fator', name: 'Fator A', handle: 'fatora' }];
  const people = [{ id: 'ana', name: 'Ana Costa', job: 'Designer gráfico', role: 'Produção', email: 'ana@example.com' }, { id: 'pedro', name: 'Pedro Lima', job: 'Editor de vídeo', role: 'Produção', email: 'pedro@example.com' }, { id: 'julia', name: 'Júlia Santos', job: 'Social media', role: 'Gestor de conta', email: 'julia@example.com' }];
  const titles = ['Pequenos hábitos, mais vida', 'Conheça nosso espaço', 'Cuidado na sua rotina', 'Um brinde aos encontros', 'Sua marca em movimento', 'Uma pausa para cuidar'];
  const statuses: Post['status'][] = ['in_production', 'awaiting_approval', 'approved', 'adjusting', 'published', 'awaiting_approval'];
  const posts: Post[] = titles.map((title, index) => ({ id: `post-${index + 1}`, clientId: index < 3 || index === 5 ? 'vida' : index === 3 ? 'wine' : 'fator', title, caption: 'Pequenos hábitos fazem parte de uma rotina com mais bem-estar. Qual cuidado você reserva para hoje?\n\n#ClínicaVida #BemEstar #SuaRotina', format: index === 0 ? 'reels' : index === 1 || index === 3 ? 'carousel' : 'image', status: statuses[index], date: `${month}-${String(4 + index * 3).padStart(2, '0')}`, time: index % 2 ? '10:00' : '18:00', ownerId: people[index % 3].id, folderId: `${index === 3 ? 'wine' : index === 4 ? 'fator' : 'vida'}-campaign`, mediaIds: index === 1 ? ['sample-2', 'sample-3'] : index === 3 ? ['sample-4', 'wine-extra'] : [`sample-${index + 1}`], coverId: index === 0 ? 'sample-2' : `sample-${index + 1}`, revision: 1, tasks: index === 0 ? [{ id: 'task-1', title: 'Roteiro e gravação', assigneeId: 'ana', dueOn: `${month}-03`, status: 'approved' }, { id: 'task-2', title: 'Capa e legenda revisadas', assigneeId: 'julia', dueOn: `${month}-03`, status: 'approved' }, { id: 'task-3', title: 'Validar edição final', assigneeId: 'ana', dueOn: `${month}-04`, status: 'pending' }] : [], comments: index === 3 ? [{ id: 'comment-1', side: 'client', name: 'Cliente de demonstração', body: 'Podemos destacar mais o encontro com os amigos na legenda?', createdAt: new Date().toISOString() }] : [] }));
  return { version: 2, clients, people, posts, folders: clients.flatMap((client) => [{ id: `${client.id}-campaign`, clientId: client.id, name: 'Campanhas' }, { id: `${client.id}-identity`, clientId: client.id, name: 'Identidade' }]), assets: [...posts.map((post, index): Asset => ({ id: `sample-${index + 1}`, clientId: post.clientId, folderId: post.folderId, name: index === 0 ? 'habitos-reel.mp4' : `capa-${index + 1}.png`, kind: index === 0 ? 'video' : 'image', size: 2400000, sample: true })), { id: 'wine-extra', clientId: 'wine', folderId: 'wine-campaign', name: 'encontros-2.png', kind: 'image', size: 1200000, sample: true }], activities: [{ id: 'activity-1', title: 'Revisão final pendente', body: 'Pequenos hábitos, mais vida · Clínica Vida', postId: 'post-1', read: false, at: new Date().toISOString() }], profile: { name: 'Marcos Oliveira', agency: 'Agência Vértice' }, permissions: ['*'], readOnly: false };
}

export function validateInput(input: PostInput) {
  ContentTitleSchema.parse(input.title); ContentCaptionSchema.parse(input.caption); ContentDaySchema.parse(input.date);
  if (input.time) ContentTimeSchema.parse(input.time);
  if (!input.clientId || !input.folderId) throw new Error('Selecione o cliente e a pasta de mídia.');
}
export function transition(post: Post, action: Parameters<Repository['move']>[1], side: Side, comment = '', date?: string): Post {
  const next = clone(post);
  if (action === 'submit') {
    if (side !== 'agency' || !['in_production', 'adjusting'].includes(post.status)) throw new Error('Este conteúdo não pode ser enviado agora.');
    if (!post.mediaIds.length || post.format === 'carousel' && (post.mediaIds.length < 2 || post.mediaIds.length > 20) || post.format !== 'carousel' && post.mediaIds.length !== 1 || post.tasks.some((task) => task.status !== 'approved')) throw new Error('Confira as mídias do formato e aprove todas as tarefas antes de enviar.');
    next.status = 'awaiting_approval';
  } else if (action === 'withdraw-approval') {
    if (side !== 'client' || post.status !== 'approved') throw new Error('Só é possível desfazer a aprovação antes da publicação.');
    next.status = 'awaiting_approval';
  } else if (action === 'approve' || action === 'changes') {
    if (side !== 'client' || post.status !== 'awaiting_approval') throw new Error('Esta publicação não está aguardando sua aprovação.');
    if (action === 'changes') CommentBodySchema.parse(comment);
    next.status = action === 'approve' ? 'approved' : 'adjusting';
  } else {
    if (side !== 'agency') throw new Error('Esta ação é exclusiva da agência.');
    if (action === 'approveByAgency') { if (post.status !== 'awaiting_approval') throw new Error('Envie o conteúdo para aprovação antes.'); CommentBodySchema.parse(comment); next.status = 'approved'; }
    if (action === 'unpublish') { if (post.status !== 'published') throw new Error('O conteúdo não está publicado.'); next.status = 'approved'; }
    if (action === 'publish') { if (post.status !== 'approved') throw new Error('A publicação precisa estar aprovada.'); if ((date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) > new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })) throw new Error('A data da publicação não pode ser futura.'); next.status = 'published'; }
    if (action === 'cancel') { if (post.status === 'published') throw new Error('Uma publicação concluída não pode ser cancelada.'); next.status = 'cancelled'; }
    if (action === 'reschedule') { if (post.status !== 'cancelled') throw new Error('Apenas conteúdos cancelados podem ser reagendados.'); if (date) { ContentDaySchema.parse(date); next.date = date; } next.status = 'in_production'; }
  }
  return next;
}

export function demoRepository(side: () => Side): Repository {
  let data: Data | undefined;
  let writes = Promise.resolve();
  const get = async () => { if (!data) { const saved = await AsyncStorage.getItem(key); try { const parsed = saved ? JSON.parse(saved) as Data : null; data = parsed?.version === 2 ? parsed : seed(); } catch { data = seed(); } } return data; };
  const persist = async () => { const encoded = JSON.stringify(data); writes = writes.catch(() => {}).then(() => AsyncStorage.setItem(key, encoded)); await writes; };
  async function store(post: Post, title: string) { const d = await get(); d.posts = d.posts.some((item) => item.id === post.id) ? d.posts.map((item) => item.id === post.id ? post : item) : [...d.posts, post]; d.activities.unshift({ id: newId(), title, body: post.title, postId: post.id, read: false, at: new Date().toISOString() }); await persist(); return clone(post); }
  const repo: Repository = {
    demo: true,
    load: async () => clone(await get()),
    detail: async (clientId, id) => { const post = (await get()).posts.find((item) => item.id === id && item.clientId === clientId); if (!post) throw new Error('Conteúdo não encontrado.'); return clone(post); },
    save: async (input, id) => { if (side() !== 'agency') throw new Error('O cliente não edita conteúdo.'); validateInput(input); const d = await get(); const previous = d.posts.find((item) => item.id === id); const { clientId, title, caption, format, date, time, ownerId, folderId, mediaIds, coverId } = input; const post: Post = { ...(previous ?? { id: newId(), status: 'in_production', revision: 0, tasks: [], comments: [] }), clientId, title, caption, format, date, time, ownerId, folderId, mediaIds, coverId, revision: (previous?.revision ?? 0) + 1 }; if (previous?.status === 'published' || previous?.status === 'cancelled') throw new Error('Este conteúdo não pode ser editado.'); if (previous?.status === 'approved' && ['caption', 'format', 'coverId', 'mediaIds'].some((field) => JSON.stringify(previous[field as keyof Post]) !== JSON.stringify(post[field as keyof Post]))) post.status = 'awaiting_approval'; return store(post, previous ? 'Conteúdo atualizado' : 'Conteúdo criado'); },
    move: async (post, action, comment, date) => { const current = await repo.detail(post.clientId, post.id); if (current.revision !== post.revision) throw new Error('O conteúdo mudou. Abra a versão atual antes de decidir.'); if (action === 'submit') { const d = await get(); const files = current.mediaIds.map((id) => d.assets.find((asset) => asset.id === id)); if (files.some((file) => !file || file.clientId !== current.clientId || file.folderId !== current.folderId)) throw new Error('Use apenas mídias da pasta deste cliente.'); if (current.format === 'image' && files.some((file) => file?.kind !== 'image') || ['reels', 'long_video', 'vsl'].includes(current.format) && files.some((file) => file?.kind !== 'video')) throw new Error('O tipo de mídia não corresponde ao formato da publicação.'); } const next = transition(current, action, side(), comment, date); if (comment?.trim()) next.comments.push({ id: newId(), body: comment.trim(), side: side(), name: 'Cliente de demonstração', createdAt: new Date().toISOString() }); return store(next, action === 'approve' ? 'Aprovação recebida' : action === 'changes' ? 'Ajuste solicitado' : 'Etapa atualizada'); },
    task: async (post, task, action, comment) => { if (side() !== 'agency') throw new Error('Tarefas são internas.'); const current = await repo.detail(post.clientId, post.id); if (action === 'return') CommentBodySchema.parse(comment); const found = current.tasks.find((item) => item.id === task.id); if (!found || action === 'deliver' && found.status !== 'pending' || action !== 'deliver' && found.status !== 'delivered') throw new Error('A tarefa já mudou de etapa.'); found.status = action === 'deliver' ? 'delivered' : action === 'approve' ? 'approved' : 'pending'; return store(current, 'Tarefa atualizada'); },
    updateTask: async (post, task) => { if (side() !== 'agency') throw new Error('Tarefas são internas.'); ContentTitleSchema.parse(task.title); ContentDaySchema.parse(task.dueOn); const current = await repo.detail(post.clientId, post.id); current.tasks = current.tasks.map((item) => item.id === task.id ? { ...task } : item); return store(current, 'Tarefa atualizada'); },
    addTask: async (post, input) => { if (side() !== 'agency') throw new Error('Tarefas são internas.'); ContentTitleSchema.parse(input.title); ContentDaySchema.parse(input.dueOn); const current = await repo.detail(post.clientId, post.id); current.tasks.push({ ...input, id: newId(), status: 'pending' }); return store(current, 'Tarefa criada'); },
    comment: async (post, body) => { CommentBodySchema.parse(body); const current = await repo.detail(post.clientId, post.id); if (side() === 'client' && current.status === 'in_production') throw new Error('Este conteúdo ainda está em produção.'); current.comments.push({ id: newId(), body: body.trim(), side: side(), name: side() === 'agency' ? (await get()).profile.name : 'Cliente de demonstração', createdAt: new Date().toISOString() }); return store(current, 'Novo comentário'); },
    addClient: async (name) => { if (side() !== 'agency') throw new Error('Somente a agência cadastra clientes.'); const d = await get(); const parsed = ClientNameSchema.parse(name); if (d.clients.some((client) => client.name.toLocaleLowerCase() === parsed.toLocaleLowerCase())) throw new Error('Já existe um cliente com este nome.'); const client = { id: newId(), name: parsed, handle: '' }; d.clients.push(client); d.folders.push({ id: `${client.id}-campaign`, clientId: client.id, name: 'Geral' }); await persist(); return client; },
    addFolder: async (clientId, name) => { const folder = { id: newId(), clientId, name: MediaFolderNameSchema.parse(name) }; (await get()).folders.push(folder); await persist(); return folder; },
    library: async (clientId) => { const d = await get(); return clone({ folders: d.folders.filter((folder) => folder.clientId === clientId), assets: d.assets.filter((asset) => asset.clientId === clientId) }); },
    removeAsset: async (asset) => { if (side() !== 'agency') throw new Error('Somente a agência remove mídias.'); const d = await get(); if (d.posts.some((post) => ['awaiting_approval', 'approved', 'published'].includes(post.status) && (post.coverId === asset.id || post.mediaIds.includes(asset.id)))) throw new Error('A mídia está em uso por um conteúdo enviado, aprovado ou publicado.'); d.assets = d.assets.filter((item) => item.id !== asset.id); await persist(); },
    upload: async (clientId, folderId, file) => { if (!/^(image|video)\//.test(file.mimeType)) throw new Error('Escolha uma imagem ou vídeo.'); if (file.size > 8 * 1024 * 1024) throw new Error('Na demonstração, escolha um arquivo de até 8 MB.'); let uri = file.uri; if (Platform.OS === 'web' && file.file) uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file.file!); }); const asset = { id: newId(), clientId, folderId, name: file.name, kind: file.mimeType.startsWith('video') ? 'video' as const : 'image' as const, size: file.size, uri }; const d = await get(); d.assets.push(asset); try { await persist(); } catch { d.assets = d.assets.filter((item) => item.id !== asset.id); throw new Error('O armazenamento local está cheio. Use um arquivo menor.'); } return asset; },
    assetUrl: async (_clientId, _postId, id) => { const asset = (await get()).assets.find((item) => item.id === id); if (!asset?.uri) throw new Error('Esta é uma mídia ilustrativa do Figma.'); return asset.uri; },
    profile: async (name) => { if (!name.trim()) throw new Error('Informe seu nome.'); (await get()).profile.name = name.trim(); await persist(); },
    reset: async () => { data = seed(); await persist(); }
  };
  return repo;
}
