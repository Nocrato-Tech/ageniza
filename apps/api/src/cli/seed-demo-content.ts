import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

import {
  insertContent,
  replaceContentMedia,
  type ContentTransaction
} from '../modules/contents/service.js';
import { approveContent, requestContentChanges } from '../modules/contents/portal-service.js';
import { approveContentTask, deliverContentTask, insertContentTask } from '../modules/contents/task-service.js';
import { approveContentByAgency, cancelContent, publishContent, saoPauloDay, submitContent } from '../modules/contents/transition-service.js';
import { insertFolder } from '../modules/media/folder-service.js';
import { insertPendingAsset, markAssetConfirmed } from '../modules/media/service.js';
import { insertScenes, insertScript, recordScript, sendScript } from '../modules/story-scripts/service.js';

/**
 * The demo data of Conteúdo (issue #608): own folders, media, a content in every state, subtasks in every state, story scripts and the
 * conversations of two contents. It goes through the same functions the routes call, as the person the rule names (the Admin plans and
 * moves, the person of the portal approves and asks for changes, the production person delivers), so every state is reached by a legal
 * transition and every INSERT is the one the application role can make.
 *
 * No `id` is chosen in a table that does not take one (#580, #601, #604): contents, subtasks, scripts, scenes, folders and the
 * conversations of a content get their own, and are found again by a natural key (the client and the title, the client and the day, the
 * content and the title; a conversation by its content, a comment by its conversation, author, side and text). Only `media_assets`,
 * which still accepts the id (#601, item 1), takes a derived one.
 *
 * The media are rows with no object in the bucket: the demo needs the rules and the screens, not the files. A card or a post draws
 * no picture for them, and a signed address for one answers 404 when it is opened.
 */

export type SeedId = (key: string) => string;

export interface ContentDemoPeople {
  /** Plans, moves and publishes; holds every permission of Conteúdo. */
  readonly admin: string;
  /** An account manager: operates, approves for the agency and cancels. */
  readonly manager: string;
  /** Production: the person of the subtasks. */
  readonly production: string;
  /** The person of the portal of `portalClientKey`. */
  readonly portal: string;
}

export interface ContentDemoInput {
  readonly database: DatabaseClient;
  /** The migration owner: the only writer that can put an approval deadline in the past, which no function of the product accepts. */
  readonly owner: DatabaseClient;
  readonly idFor: SeedId;
  /** The id the database gave each demo client, by the key of its spec: the seed does not choose it. */
  readonly clientIds: ReadonlyMap<string, string>;
  readonly agencyId: string;
  readonly people: ContentDemoPeople;
}

type Category = 'image' | 'video' | 'logo' | 'pdf';
type Format = 'image' | 'carousel' | 'reels';
type Target = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
type Actor = keyof ContentDemoPeople;

interface FolderSpec {
  /** A default folder of the client, by its name, or an own folder of the first level. */
  readonly name: string;
  /** The working folder inside it. */
  readonly child?: string;
}

interface TaskSpec {
  readonly title: string;
  readonly dueOffset: number;
  readonly state: 'pending' | 'delivered' | 'approved';
}

export interface ContentSpec {
  readonly key: string;
  readonly client: string;
  readonly title: string;
  readonly format: Format;
  /** Days from today, in São Paulo: negative is late, 0 to 2 is due soon. */
  readonly offset: number;
  readonly time?: string;
  readonly caption: string;
  readonly folder: FolderSpec;
  readonly media: readonly { readonly key: string; readonly category: Category }[];
  readonly target: Target;
  /** Who plans it, and so who is in charge of it. */
  readonly actor: 'admin' | 'manager';
  readonly tasks?: readonly TaskSpec[];
  readonly changeRequest?: string;
  readonly approvalReason?: string;
  /** What the client wrote when it approved. */
  readonly approvalNote?: string;
  /** The round the content is sent with: the deadline in hours from now (negative is overdue) and the note to the client. */
  readonly round?: { readonly hours: number; readonly note?: string };
  /** A conversation of the person of the portal and the agency about the content. */
  readonly conversation?: readonly { readonly side: 'agency' | 'client'; readonly body: string }[];
}

interface MediaInfo {
  readonly fileName: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt: string;
  readonly uploader: 'admin' | 'manager';
}

const MEDIA_INFO: Readonly<Record<string, MediaInfo>> = {
  'pais-1': { fileName: 'dia-dos-pais-mesa.png', width: 1080, height: 1350, alt: 'Mesa de café da manhã com pães, café e uma xícara para o pai', uploader: 'admin' },
  'pais-2': { fileName: 'dia-dos-pais-balcao.png', width: 1080, height: 1350, alt: 'Balcão da padaria com a cesta de presente do Dia dos Pais', uploader: 'admin' },
  'receita-1': { fileName: 'receita-pao-de-queijo.mp4', alt: 'Passo a passo do pão de queijo, da massa ao forno', uploader: 'admin' },
  'torrada-1': { fileName: 'torrada-pao-de-ontem.png', width: 1080, height: 1080, alt: 'Fatias de pão de ontem douradas, servidas como torrada', uploader: 'admin' },
  'familia-1': { fileName: 'cafe-em-familia-1.png', width: 1080, height: 1350, alt: 'Família reunida ao redor da mesa de domingo', uploader: 'admin' },
  'familia-2': { fileName: 'cafe-em-familia-2.png', width: 1080, height: 1350, alt: 'Mesa de café da manhã com pouca luz', uploader: 'admin' },
  'familia-3': { fileName: 'cafe-em-familia-3.png', width: 1080, height: 1350, alt: 'Criança servindo suco na mesa de domingo', uploader: 'admin' },
  'promo-1': { fileName: 'combo-cafe-e-pao.png', width: 1080, height: 1080, alt: 'Combo de café com leite e pão na chapa sobre a bancada', uploader: 'admin' },
  'bastidores-1': { fileName: 'fornada-das-cinco.mp4', alt: 'Padeiros tirando a fornada das cinco do forno', uploader: 'admin' },
  'queijo-1': { fileName: 'pao-de-queijo-em-dobro.png', width: 1080, height: 1080, alt: 'Duas bandejas de pão de queijo recém-saído do forno', uploader: 'admin' },
  'checkup-1': { fileName: 'checkup-anual.mp4', alt: 'Médica explicando quais exames fazer no check-up anual', uploader: 'manager' },
  'vacina-1': { fileName: 'calendario-de-vacinas.png', width: 1080, height: 1350, alt: 'Calendário de vacinação da família em tons de azul', uploader: 'manager' },
  'coado-1': { fileName: 'cafe-coado-na-hora.png', width: 1080, height: 1350, alt: 'Café sendo coado na hora em um filtro de pano', uploader: 'admin' },
  'lib-logo-padaria': { fileName: 'logo-padaria-central.png', width: 1200, height: 1200, alt: 'Logotipo da Padaria Central: um pão em vermelho terracota', uploader: 'admin' },
  'lib-manual-padaria': { fileName: 'manual-da-marca-padaria-central.pdf', alt: 'Manual da marca da Padaria Central', uploader: 'admin' },
  'lib-fachada-viver-bem': { fileName: 'fachada-clinica-viver-bem.png', width: 1920, height: 1080, alt: 'Fachada da Clínica Viver Bem em um fim de tarde', uploader: 'manager' }
};

interface LibraryMediaSpec {
  readonly key: string;
  readonly client: string;
  readonly category: Category;
  readonly folder: FolderSpec;
}

/** Media that sit in the library of a client without being in any content. */
const LIBRARY_MEDIA: readonly LibraryMediaSpec[] = [
  { key: 'lib-logo-padaria', client: 'client:padaria-central', category: 'logo', folder: { name: 'Imagens' } },
  { key: 'lib-manual-padaria', client: 'client:padaria-central', category: 'pdf', folder: { name: 'Campanha de Natal' } },
  { key: 'lib-fachada-viver-bem', client: 'client:clinica-viver-bem', category: 'image', folder: { name: 'Imagens' } }
];

interface OwnFolderSpec {
  readonly client: string;
  readonly name: string;
  readonly child: string;
}

const OWN_FOLDERS: readonly OwnFolderSpec[] = [
  { client: 'client:padaria-central', name: 'Campanha de Natal', child: 'Bastidores' }
];

const PADARIA = 'client:padaria-central';
const VIVER_BEM = 'client:clinica-viver-bem';
const CAFE = 'client:cafe-do-alto';

export const DEMO_CONTENTS: readonly ContentSpec[] = [
  {
    key: 'padaria-fermentacao', client: PADARIA, title: 'O segredo da fermentação natural', format: 'image', offset: 9,
    caption: 'Doze horas de espera para um pão que dura a manhã inteira. #fermentacaonatural',
    folder: { name: 'Imagens' }, media: [], target: 'in_production', actor: 'admin',
    tasks: [
      { title: 'Fotografar a massa crescendo', dueOffset: 5, state: 'pending' },
      { title: 'Escrever a legenda', dueOffset: 4, state: 'delivered' },
      { title: 'Tratar as imagens', dueOffset: 3, state: 'approved' }
    ]
  },
  {
    key: 'padaria-dia-dos-pais', client: PADARIA, title: 'Dia dos Pais na Padaria Central', format: 'carousel', offset: -2,
    caption: 'Café da manhã para quem sempre acordou cedo por nós.',
    folder: { name: 'Carrosséis' }, media: [{ key: 'pais-1', category: 'image' }, { key: 'pais-2', category: 'image' }], target: 'in_production', actor: 'admin'
  },
  {
    key: 'padaria-receita-sabado', client: PADARIA, title: 'Receita de sábado: pão de queijo', format: 'reels', offset: 2, time: '09:30',
    caption: 'O jeito mineiro, sem pressa e com muito queijo.',
    folder: { name: 'Vídeos' }, media: [{ key: 'receita-1', category: 'video' }], target: 'awaiting_approval', actor: 'admin',
    round: { hours: 20, note: 'Oi, Sofia! Segue o vídeo da receita de sábado. Consegue aprovar até amanhã cedo?' },
    conversation: [
      { side: 'client', body: 'Gostei do vídeo! Dá para mostrar o forno no final?' },
      { side: 'agency', body: 'Dá, sim. Incluímos o forno nos últimos segundos e avisamos aqui.' }
    ]
  },
  {
    key: 'padaria-pao-de-ontem', client: PADARIA, title: 'O pão de ontem vira torrada', format: 'image', offset: -1,
    caption: 'Nada se joga fora na nossa cozinha.',
    folder: { name: 'Imagens' }, media: [{ key: 'torrada-1', category: 'image' }], target: 'awaiting_approval', actor: 'admin',
    round: { hours: -30, note: 'Precisamos da sua aprovação para publicar ainda esta semana.' }
  },
  {
    key: 'padaria-cafe-em-familia', client: PADARIA, title: 'Café da manhã em família', format: 'carousel', offset: 4,
    caption: 'Domingo é dia de mesa grande.',
    folder: { name: 'Carrosséis' }, media: [{ key: 'familia-1', category: 'image' }, { key: 'familia-2', category: 'image' }, { key: 'familia-3', category: 'image' }],
    target: 'adjusting', actor: 'admin', changeRequest: 'Trocar a segunda foto: a mesa ficou escura demais.'
  },
  {
    key: 'padaria-promocao', client: PADARIA, title: 'Promoção da semana: combo café e pão', format: 'image', offset: 1, time: '08:00',
    caption: 'Combo de segunda a quarta, das 6h às 10h.',
    folder: { name: 'Imagens' }, media: [{ key: 'promo-1', category: 'image' }], target: 'approved', actor: 'admin',
    approvalNote: 'Aprovado! Pode publicar às 8h, o combo já está no balcão.'
  },
  {
    key: 'padaria-queijo-em-dobro', client: PADARIA, title: 'Pão de queijo em dobro às quartas', format: 'image', offset: 3, time: '12:00',
    caption: 'Toda quarta, o segundo pão de queijo sai por nossa conta.',
    folder: { name: 'Imagens' }, media: [{ key: 'queijo-1', category: 'image' }], target: 'approved', actor: 'admin',
    approvalNote: 'Adorei a foto. Vamos avisar o time do balcão sobre a promoção.'
  },
  {
    key: 'padaria-bastidores', client: PADARIA, title: 'Bastidores da fornada das cinco', format: 'reels', offset: -3,
    caption: 'Quem acorda a cidade antes do sol.',
    folder: { name: 'Campanha de Natal', child: 'Bastidores' }, media: [{ key: 'bastidores-1', category: 'video' }], target: 'published', actor: 'admin'
  },
  {
    key: 'padaria-campanha-antiga', client: PADARIA, title: 'Campanha de aniversário (cancelada)', format: 'image', offset: 15,
    caption: 'Cancelada: o aniversário mudou de data.',
    folder: { name: 'Imagens' }, media: [], target: 'cancelled', actor: 'admin'
  },
  {
    key: 'viver-bem-dicas', client: VIVER_BEM, title: 'Cinco dicas para dormir melhor', format: 'image', offset: -1,
    caption: 'A rotina do sono começa à tarde.',
    folder: { name: 'Imagens' }, media: [], target: 'in_production', actor: 'manager'
  },
  {
    key: 'viver-bem-checkup', client: VIVER_BEM, title: 'Check-up anual: o que pedir', format: 'reels', offset: 2,
    caption: 'Exames de rotina que vale agendar neste semestre.',
    folder: { name: 'Vídeos' }, media: [{ key: 'checkup-1', category: 'video' }], target: 'approved', actor: 'manager', time: '10:00',
    approvalReason: 'Aprovado por telefone com a Dra. Paula.'
  },
  {
    key: 'viver-bem-vacinas', client: VIVER_BEM, title: 'Vacinação em dia: o calendário da família', format: 'image', offset: 1,
    caption: 'Um calendário simples para ninguém perder o reforço.',
    folder: { name: 'Imagens' }, media: [{ key: 'vacina-1', category: 'image' }], target: 'awaiting_approval', actor: 'manager',
    round: { hours: -5, note: 'Dra. Alice, conseguimos aprovar hoje? O post sai amanhã.' }
  },
  {
    key: 'cafe-coado', client: CAFE, title: 'Lançamento do café coado na hora', format: 'image', offset: 1,
    caption: 'Grão da serra, moído na hora.',
    folder: { name: 'Imagens' }, media: [{ key: 'coado-1', category: 'image' }], target: 'awaiting_approval', actor: 'admin',
    round: { hours: 48 }
  }
];

interface ScriptSpec {
  readonly client: string;
  readonly offset: number;
  readonly send: boolean;
  /** Marked as recorded by the person of the portal, once it was sent. */
  readonly record?: boolean;
  readonly scenes: readonly { readonly text: string; readonly guidance: string | null }[];
}

const SCRIPTS: readonly ScriptSpec[] = [
  {
    client: PADARIA, offset: 0, send: true,
    scenes: [
      { text: 'Bom dia! Hoje a fornada saiu mais cedo.', guidance: 'Mostre o balcão ainda vazio, com a luz da manhã.' },
      { text: 'Este é o pão de queijo que vocês pediram.', guidance: 'Aproxime da bandeja e deixe o vapor aparecer.' },
      { text: 'Passem aqui até as dez. Esperamos vocês!', guidance: null }
    ]
  },
  {
    client: PADARIA, offset: 1, send: false,
    scenes: [
      { text: 'Amanhã tem pão novo no cardápio.', guidance: 'Grave na bancada, com as mãos na massa.' },
      { text: 'Quem adivinha o sabor?', guidance: null }
    ]
  },
  {
    client: PADARIA, offset: -1, send: true, record: true,
    scenes: [
      { text: 'Ontem a fila chegou até a esquina.', guidance: 'Grave da porta, com a fila ao fundo.' },
      { text: 'Obrigado por cada bom dia.', guidance: null }
    ]
  }
];

/** The states a content passes through to reach its target, in order; a legal transition connects each pair. */
const PATH: Readonly<Record<Target, readonly Target[]>> = {
  in_production: ['in_production'],
  awaiting_approval: ['in_production', 'awaiting_approval'],
  adjusting: ['in_production', 'awaiting_approval', 'adjusting'],
  approved: ['in_production', 'awaiting_approval', 'approved'],
  published: ['in_production', 'awaiting_approval', 'approved', 'published'],
  cancelled: ['in_production', 'cancelled']
};

const addDays = (day: string, count: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);

interface Rows<TRow> {
  readonly rows: readonly TRow[];
}

export const ensureContentDemo = async (input: ContentDemoInput): Promise<void> => {
  const { database, owner, idFor, clientIds, agencyId, people } = input;
  const as = <TResult>(actor: Actor, work: (transaction: ContentTransaction) => Promise<TResult>): Promise<TResult> =>
    withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: people[actor] }), work);
  const clientId = (key: string): string => {
    const id = clientIds.get(key);
    if (id === undefined) throw new Error(`The demo content names the client ${key}, which the seed did not create.`);
    return id;
  };

  const today = await as('admin', (transaction) => saoPauloDay(transaction));

  // The first level own folders and their working folders.
  const ensureFolder = async (actor: Actor, client: string, name: string, parentId: string | null): Promise<string> =>
    as(actor, async (transaction) => {
      const found = await raw<Rows<{ id: string }>>(transaction, `
        select id from public.media_folders
        where client_id = ?::uuid and name = ? and parent_id is not distinct from ?::uuid
      `, [clientId(client), name, parentId]);
      const existing = found.rows[0];
      if (existing !== undefined) return existing.id;
      return (await insertFolder(transaction, { clientId: clientId(client), parentId, name })).id;
    });
  const folderIdOf = async (client: string, spec: FolderSpec): Promise<string> => {
    const first = await ensureFolder('admin', client, spec.name, null);
    return spec.child === undefined ? first : ensureFolder('admin', client, spec.child, first);
  };
  for (const own of OWN_FOLDERS) await folderIdOf(own.client, { name: own.name, child: own.child });

  const ensureMedia = async (client: string, folderId: string, media: { readonly key: string; readonly category: Category }): Promise<string> => {
    const id = idFor(`media:${media.key}`);
    const info = MEDIA_INFO[media.key];
    if (info === undefined) throw new Error(`The demo media ${media.key} has no description.`);
    const extension = { image: 'png', logo: 'png', video: 'mp4', pdf: 'pdf' }[media.category];
    const contentType = { image: 'image/png', logo: 'image/png', video: 'video/mp4', pdf: 'application/pdf' }[media.category];
    await as(info.uploader, async (transaction) => {
      const found = await raw<Rows<{ id: string }>>(transaction, 'select id from public.media_assets where id = ?::uuid', [id]);
      if (found.rows[0] === undefined) {
        await insertPendingAsset(transaction, {
          id,
          agencyId,
          category: media.category,
          declaredContentType: contentType,
          extension,
          fileName: info.fileName,
          objectKey: `${agencyId}/${id}/original.${extension}`,
          uploadObjectKey: `staging/${agencyId}/${id}/upload.${extension}`,
          declaredSizeBytes: 48_211,
          clientId: clientId(client),
          folderId
        });
        await markAssetConfirmed(
          transaction, id, 48_211, contentType, media.category,
          info.width === undefined || info.height === undefined ? undefined : { width: info.width, height: info.height }
        );
      }
      await raw(transaction, 'update public.media_assets set file_name = ?, alt_text = ?, updated_at = now() where id = ?::uuid', [info.fileName, info.alt, id]);
    });
    return id;
  };
  for (const library of LIBRARY_MEDIA) await ensureMedia(library.client, await folderIdOf(library.client, library.folder), library);

  const statusOf = (actor: Actor, contentId: string): Promise<{ status: Target; revision: number }> =>
    as(actor, async (transaction) => {
      const result = await raw<Rows<{ status: Target; revision: number }>>(transaction, 'select status, revision from public.contents where id = ?::uuid', [contentId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error('A seeded content could not be read back.');
      return row;
    });

  const moveTo = async (spec: ContentSpec, contentId: string, publishOn: string): Promise<void> => {
    const path = PATH[spec.target];
    for (let step = 0; step < path.length; step += 1) {
      const current = await statusOf(spec.actor, contentId);
      const at = path.indexOf(current.status);
      if (at === -1 || at === path.length - 1) return;
      const next = path[at + 1]!;
      if (next === 'awaiting_approval') {
        // The function takes only a deadline still to come: one already overdue is set afterwards, by `refreshRound`.
        const hours = Math.max(spec.round?.hours ?? 48, 1);
        const round = { dueAt: new Date(Date.now() + hours * 3_600_000).toISOString(), ...(spec.round?.note === undefined ? {} : { note: spec.round.note }) };
        await as(spec.actor, (transaction) => submitContent(transaction, contentId, spec.round === undefined ? {} : round));
      }
      else if (next === 'adjusting') {
        await as('portal', (transaction) => requestContentChanges(transaction, { contentId, revision: current.revision, comment: spec.changeRequest ?? 'Pedido de ajuste.' }));
      } else if (next === 'approved') {
        if (spec.approvalReason === undefined) await as('portal', (transaction) => approveContent(transaction, { contentId, revision: current.revision, ...(spec.approvalNote === undefined ? {} : { note: spec.approvalNote }) }));
        else await as(spec.actor, (transaction) => approveContentByAgency(transaction, { contentId, revision: current.revision, reason: spec.approvalReason! }));
      } else if (next === 'published') await as(spec.actor, (transaction) => publishContent(transaction, { contentId, publishedOn: publishOn }));
      else if (next === 'cancelled') await as(spec.actor, (transaction) => cancelContent(transaction, contentId));
    }
  };

  /** Puts the deadline of the round of a waiting content where the demo says, relative to now, so a rerun keeps "vencido" and "a vencer" true. */
  const refreshRound = async (spec: ContentSpec, contentId: string): Promise<void> => {
    if (spec.round === undefined || spec.target !== 'awaiting_approval') return;
    const dueAt = new Date(Date.now() + spec.round.hours * 3_600_000).toISOString();
    await owner.transaction((transaction) => raw(transaction, `
      update public.content_approval_rounds
      set due_at = ?::timestamptz,
          due_on = app_private.sao_paulo_date(?::timestamptz),
          sent_at = least(sent_at, ?::timestamptz - interval '48 hours'),
          note = ?
      where content_id = ?::uuid
        and sequence = (select max(latest.sequence) from public.content_approval_rounds latest where latest.content_id = ?::uuid)
    `, [dueAt, dueAt, dueAt, spec.round?.note ?? null, contentId, contentId]));
  };

  const ensureTasks = async (spec: ContentSpec, contentId: string): Promise<void> => {
    for (const task of spec.tasks ?? []) {
      const found = await as('admin', (transaction) => raw<Rows<{ id: string; status: TaskSpec['state'] }>>(transaction, `
        select id, status from public.content_tasks where content_id = ?::uuid and title = ?
      `, [contentId, task.title]));
      let taskId = found.rows[0]?.id;
      let status = found.rows[0]?.status;
      if (taskId === undefined) {
        taskId = await as('admin', (transaction) => insertContentTask(transaction, {
          contentId,
          clientId: clientId(spec.client),
          body: { title: task.title, dueOn: addDays(today, task.dueOffset) },
          assigneeUserId: people.production
        }));
        status = 'pending';
      }
      if (task.state !== 'pending' && status === 'pending') {
        await as('production', (transaction) => deliverContentTask(transaction, taskId!));
        status = 'delivered';
      }
      if (task.state === 'approved' && status === 'delivered') await as('admin', (transaction) => approveContentTask(transaction, taskId!));
    }
  };

  const ensureConversation = async (spec: ContentSpec, contentId: string): Promise<void> => {
    if (spec.conversation === undefined) return;
    const opener = spec.conversation[0]!;
    const found = await as('admin', (transaction) => raw<Rows<{ id: string }>>(transaction, 'select id from public.client_threads where content_id = ?::uuid', [contentId]));
    const threadId = found.rows[0]?.id ?? (await as(opener.side === 'client' ? 'portal' : spec.actor, async (transaction) => {
      const inserted = await raw<Rows<{ id: string }>>(transaction, `
        insert into public.client_threads (client_id, content_id, opened_by, opened_side)
        values (?::uuid, ?::uuid, app_private.current_user_id(), ?)
        returning id
      `, [clientId(spec.client), contentId, opener.side]);
      const row = inserted.rows[0];
      if (row === undefined) throw new Error(`The conversation of the demo content ${spec.key} could not be created.`);
      return row.id;
    }));
    for (const comment of spec.conversation) {
      await as(comment.side === 'client' ? 'portal' : spec.actor, (transaction) => raw(transaction, `
        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        select ?::uuid, ?::uuid, app_private.current_user_id(), ?, ?
        where not exists (
          select 1 from public.client_thread_comments existing
          where existing.thread_id = ?::uuid and existing.author_user_id = app_private.current_user_id() and existing.author_side = ? and existing.body = ?
        )
      `, [threadId, clientId(spec.client), comment.side, comment.body, threadId, comment.side, comment.body]));
    }
  };

  for (const spec of DEMO_CONTENTS) {
    const folderId = await folderIdOf(spec.client, spec.folder);
    const assetIds: string[] = [];
    for (const media of spec.media) assetIds.push(await ensureMedia(spec.client, folderId, media));
    const publishOn = addDays(today, spec.offset);

    const found = await as(spec.actor, (transaction) => raw<Rows<{ id: string }>>(transaction, `
      select id from public.contents where client_id = ?::uuid and title = ?
    `, [clientId(spec.client), spec.title]));
    let contentId = found.rows[0]?.id;
    if (contentId === undefined) {
      contentId = await as(spec.actor, async (transaction) => {
        const id = await insertContent(transaction, {
          clientId: clientId(spec.client),
          body: {
            title: spec.title,
            format: spec.format,
            publishOn,
            ...(spec.time === undefined ? {} : { publishAtTime: spec.time }),
            caption: spec.caption,
            folderId
          },
          ownerUserId: undefined
        });
        if (assetIds.length > 0) await replaceContentMedia(transaction, { contentId: id, assetIds });
        return id;
      });
    }
    await ensureTasks(spec, contentId);
    await moveTo(spec, contentId, publishOn);
    await refreshRound(spec, contentId);
    await ensureConversation(spec, contentId);
  }

  for (const script of SCRIPTS) {
    const scriptOn = addDays(today, script.offset);
    await as('admin', async (transaction) => {
      const found = await raw<Rows<{ id: string; status: string }>>(transaction, `
        select id, status from public.story_scripts where client_id = ?::uuid and script_on = ?::date
      `, [clientId(script.client), scriptOn]);
      let scriptId = found.rows[0]?.id;
      let status = found.rows[0]?.status;
      if (scriptId === undefined) {
        scriptId = await insertScript(transaction, { clientId: clientId(script.client), scriptOn });
        await insertScenes(transaction, { id: scriptId, clientId: clientId(script.client) }, script.scenes.map((scene, index) => ({ position: index + 1, text: scene.text, guidance: scene.guidance })));
        status = 'draft';
      }
      if (script.send && status === 'draft') await sendScript(transaction, scriptId);
    });
    if (script.record === true) {
      await as('portal', async (transaction) => {
        const found = await raw<Rows<{ id: string; status: string }>>(transaction, `
          select id, status from public.story_scripts where client_id = ?::uuid and script_on = ?::date
        `, [clientId(script.client), scriptOn]);
        const row = found.rows[0];
        if (row !== undefined && row.status === 'sent') await recordScript(transaction, row.id);
      });
    }
  }
};
