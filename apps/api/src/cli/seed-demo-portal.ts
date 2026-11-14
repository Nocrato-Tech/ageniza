import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

import { announcementBody } from '../modules/clients/material-upload-announcement.js';

/**
 * The portal side of the demo: people the agency added to a client's portal who have not entered yet (with the name it typed), and the
 * requests for material the agency opened. Both go through what the product uses: the access through `app_private.add_client_portal_access`
 * (the only writer of the table), the request as the Admin under the policy of `client_threads`. The files the person of the portal sent to
 * one open request go through the two functions the portal uses (`start_portal_material_upload`, `confirm_portal_material_upload`), as her,
 * and the comment that announces them is hers too. Like the other demo media, they are rows with no object in the bucket.
 */

interface Rows<TRow> {
  readonly rows: readonly TRow[];
}

const PADARIA = 'client:padaria-central';
const VIVER_BEM = 'client:clinica-viver-bem';

interface InvitedAccessSpec {
  readonly client: string;
  /** Local part of the address; the domain is the run's. */
  readonly emailLocal: string;
  readonly name: string;
}

const INVITED_ACCESSES: readonly InvitedAccessSpec[] = [
  { client: PADARIA, emailLocal: 'convidado.marcos', name: 'Marcos Tavares' },
  { client: PADARIA, emailLocal: 'convidado.fernanda', name: 'Fernanda Rocha' },
  { client: VIVER_BEM, emailLocal: 'convidado.alice', name: 'Alice Prado' }
];

interface MaterialRequestSpec {
  readonly client: string;
  readonly title: string;
  /** Days from today in São Paulo, from 0 to 90. */
  readonly dueInDays: number;
  readonly body: string;
}

const MATERIAL_REQUESTS: readonly MaterialRequestSpec[] = [
  {
    client: PADARIA, title: 'Fotos novas do balcão de pães', dueInDays: 3,
    body: 'Oi, João! Para o post de sábado, pode mandar três fotos do balcão com a fornada nova? Pode ser pelo celular, com boa luz.'
  },
  {
    client: PADARIA, title: 'Lista de preços atualizada', dueInDays: 10,
    body: 'Precisamos da tabela de preços de dezembro para fechar os cartazes e o cardápio do Instagram.'
  },
  {
    client: VIVER_BEM, title: 'Foto da equipe para o Dia do Médico', dueInDays: 1,
    body: 'Dra. Alice, pode enviar uma foto da equipe reunida? Vamos usar no post de amanhã.'
  }
];

interface ClientUploadSpec {
  readonly fileName: string;
  readonly contentType: 'image/jpeg' | 'image/png';
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}

/** What the person of the portal already sent to an open request, by the title of the request. */
const CLIENT_UPLOADS: Readonly<Record<string, readonly ClientUploadSpec[]>> = {
  'Fotos novas do balcão de pães': [
    { fileName: 'balcao-fornada-1.jpg', contentType: 'image/jpeg', sizeBytes: 1_843_200, width: 3024, height: 4032 },
    { fileName: 'balcao-fornada-2.jpg', contentType: 'image/jpeg', sizeBytes: 2_097_152, width: 3024, height: 4032 },
    { fileName: 'balcao-paes-luz-da-manha.png', contentType: 'image/png', sizeBytes: 3_145_728, width: 1920, height: 1080 }
  ]
};

// The defaults of a deployment and the reservation window the API hands the functions; the demo agency has no quota of its own.
const UPLOAD_SETTINGS = { quotaBytes: 5 * 1024 ** 3, quotaObjects: 500, reservationSeconds: 900 } as const;

export interface PortalDemoInput {
  readonly database: DatabaseClient;
  readonly adminUserId: string;
  /** The person of the portal of the first client: the one who sends the files. */
  readonly portalUserId: string;
  readonly clientIds: ReadonlyMap<string, string>;
  readonly emailFor: (localPart: string) => string;
}

export const ensurePortalDemo = async (input: PortalDemoInput): Promise<void> => {
  const { database, adminUserId, portalUserId, clientIds, emailFor } = input;
  const as = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
    withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: adminUserId }), work);
  const asPortal = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
    withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: portalUserId }), work);
  const clientId = (key: string): string => {
    const id = clientIds.get(key);
    if (id === undefined) throw new Error(`The demo portal names the client ${key}, which the seed did not create.`);
    return id;
  };

  for (const access of INVITED_ACCESSES) {
    await as((transaction) => raw(transaction, 'select * from app_private.add_client_portal_access(?::uuid, ?, ?)', [clientId(access.client), emailFor(access.emailLocal), access.name]));
  }

  const ensureClientUploads = async (request: MaterialRequestSpec, uploads: readonly ClientUploadSpec[]): Promise<void> => {
    // A request the agency resolved by hand takes no more files: it stays as it is.
    const threadId = (await as((transaction) => raw<Rows<{ id: string }>>(transaction, `
      select id from public.client_threads
      where client_id = ?::uuid and is_material_request and title = ? and resolved_at is null order by created_at, id limit 1
    `, [clientId(request.client), request.title]))).rows[0]?.id;
    if (threadId === undefined) return;

    await asPortal(async (transaction) => {
      const sent = await raw<Rows<{ file_name: string | null }>>(transaction, `
        select file_name from app_private.list_portal_material_uploads(?::uuid, ?::uuid, 100, 0) where asset_id is not null
      `, [clientId(request.client), threadId]);
      const names = new Set(sent.rows.map((row) => row.file_name));
      for (const upload of uploads) {
        if (names.has(upload.fileName)) continue;
        const started = await raw<Rows<{ asset_id: string }>>(transaction, `
          select asset_id from app_private.start_portal_material_upload(?::uuid, ?::uuid, ?::text, ?::bigint, ?::text, ?::bigint, ?::bigint, ?::integer)
        `, [clientId(request.client), threadId, upload.contentType, upload.sizeBytes, upload.fileName, UPLOAD_SETTINGS.quotaBytes, UPLOAD_SETTINGS.quotaObjects, UPLOAD_SETTINGS.reservationSeconds]);
        const assetId = started.rows[0]?.asset_id;
        if (assetId === undefined) throw new Error(`The demo upload ${upload.fileName} did not start.`);
        const verdict = await raw<Rows<{ outcome: string; reason: string | null }>>(transaction, `
          select outcome, reason from app_private.confirm_portal_material_upload(?::uuid, ?::bigint, ?::text, ?::integer, ?::integer, ?::bigint, ?::bigint, ?::integer)
        `, [assetId, upload.sizeBytes, upload.contentType, upload.width, upload.height, UPLOAD_SETTINGS.quotaBytes, UPLOAD_SETTINGS.quotaObjects, UPLOAD_SETTINGS.reservationSeconds]);
        if (verdict.rows[0]?.outcome !== 'confirmed') throw new Error(`The demo upload ${upload.fileName} was not confirmed: ${verdict.rows[0]?.reason ?? 'no answer'}.`);
      }

      const announcement = announcementBody({ images: uploads.length, audios: 0 });
      await raw(transaction, `
        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        select ?::uuid, ?::uuid, app_private.current_user_id(), 'client', ?
        where not exists (
          select 1 from public.client_thread_comments existing
          where existing.thread_id = ?::uuid and existing.author_side = 'client' and existing.body = ?
        )
      `, [threadId, clientId(request.client), announcement, threadId, announcement]);
    });
  };

  for (const request of MATERIAL_REQUESTS) {
    await as(async (transaction) => {
      const found = await raw<Rows<{ id: string }>>(transaction, `
        select id from public.client_threads where client_id = ?::uuid and is_material_request and title = ? order by created_at, id limit 1
      `, [clientId(request.client), request.title]);
      const threadId = found.rows[0]?.id ?? (await raw<Rows<{ id: string }>>(transaction, `
        insert into public.client_threads (client_id, is_material_request, due_on, title, opened_by, opened_side)
        values (?::uuid, true, app_private.sao_paulo_date(now()) + ?::integer, ?, app_private.current_user_id(), 'agency')
        returning id
      `, [clientId(request.client), request.dueInDays, request.title])).rows[0]?.id;
      if (threadId === undefined) throw new Error(`The demo request for material ${request.title} could not be created.`);
      await raw(transaction, `
        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        select ?::uuid, ?::uuid, app_private.current_user_id(), 'agency', ?
        where not exists (select 1 from public.client_thread_comments existing where existing.thread_id = ?::uuid)
      `, [threadId, clientId(request.client), request.body, threadId]);
    });

    const uploads = CLIENT_UPLOADS[request.title];
    if (uploads !== undefined) await ensureClientUploads(request, uploads);
  }
};
