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
  readonly idFor: SeedId;
  /** The id the database gave each demo client, by the key of its spec: the seed does not choose it. */
  readonly clientIds: ReadonlyMap<string, string>;
  readonly agencyId: string;
  readonly people: ContentDemoPeople;
}

type Category = 'image' | 'video';
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
  /** A conversation of the person of the portal and the agency about the content. */
  readonly conversation?: readonly { readonly side: 'agency' | 'client'; readonly body: string }[];
}

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
    conversation: [
      { side: 'client', body: 'Gostei do vídeo! Dá para mostrar o forno no final?' },
      { side: 'agency', body: 'Dá, sim. Incluímos o forno nos últimos segundos e avisamos aqui.' }
    ]
  },
  {
    key: 'padaria-pao-de-ontem', client: PADARIA, title: 'O pão de ontem vira torrada', format: 'image', offset: -1,
    caption: 'Nada se joga fora na nossa cozinha.',
    folder: { name: 'Imagens' }, media: [{ key: 'torrada-1', category: 'image' }], target: 'awaiting_approval', actor: 'admin'
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
    folder: { name: 'Imagens' }, media: [{ key: 'promo-1', category: 'image' }], target: 'approved', actor: 'admin'
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
    folder: { name: 'Vídeos' }, media: [{ key: 'checkup-1', category: 'video' }], target: 'approved', actor: 'manager',
    approvalReason: 'Aprovado por telefone com a Dra. Paula.'
  },
  {
    key: 'cafe-coado', client: CAFE, title: 'Lançamento do café coado na hora', format: 'image', offset: 1,
    caption: 'Grão da serra, moído na hora.',
    folder: { name: 'Imagens' }, media: [{ key: 'coado-1', category: 'image' }], target: 'awaiting_approval', actor: 'admin'
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
  const { database, idFor, clientIds, agencyId, people } = input;
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
    await as('admin', async (transaction) => {
      const found = await raw<Rows<{ id: string }>>(transaction, 'select id from public.media_assets where id = ?::uuid', [id]);
      if (found.rows[0] !== undefined) return;
      const extension = media.category === 'image' ? 'png' : 'mp4';
      const contentType = media.category === 'image' ? 'image/png' : 'video/mp4';
      await insertPendingAsset(transaction, {
        id,
        agencyId,
        category: media.category,
        declaredContentType: contentType,
        extension,
        objectKey: `${agencyId}/${id}/original.${extension}`,
        uploadObjectKey: `staging/${agencyId}/${id}/upload.${extension}`,
        declaredSizeBytes: 48_211,
        clientId: clientId(client),
        folderId
      });
      await markAssetConfirmed(transaction, id, 48_211, contentType, media.category);
    });
    return id;
  };

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
      if (next === 'awaiting_approval') await as(spec.actor, (transaction) => submitContent(transaction, contentId));
      else if (next === 'adjusting') {
        await as('portal', (transaction) => requestContentChanges(transaction, { contentId, revision: current.revision, comment: spec.changeRequest ?? 'Pedido de ajuste.' }));
      } else if (next === 'approved') {
        if (spec.approvalReason === undefined) await as('portal', (transaction) => approveContent(transaction, { contentId, revision: current.revision }));
        else await as(spec.actor, (transaction) => approveContentByAgency(transaction, { contentId, revision: current.revision, reason: spec.approvalReason! }));
      } else if (next === 'published') await as(spec.actor, (transaction) => publishContent(transaction, { contentId, publishedOn: publishOn }));
      else if (next === 'cancelled') await as(spec.actor, (transaction) => cancelContent(transaction, contentId));
    }
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
