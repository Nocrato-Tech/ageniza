import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

/**
 * The portal side of the demo: people the agency added to a client's portal who have not entered yet (with the name it typed), and the
 * requests for material the agency opened. Both go through what the product uses: the access through `app_private.add_client_portal_access`
 * (the only writer of the table), the request as the Admin under the policy of `client_threads`.
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

export interface PortalDemoInput {
  readonly database: DatabaseClient;
  readonly adminUserId: string;
  readonly clientIds: ReadonlyMap<string, string>;
  readonly emailFor: (localPart: string) => string;
}

export const ensurePortalDemo = async (input: PortalDemoInput): Promise<void> => {
  const { database, adminUserId, clientIds, emailFor } = input;
  const as = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
    withAuthenticatedUserTransaction(database, createVerifiedUserClaims({ userId: adminUserId }), work);
  const clientId = (key: string): string => {
    const id = clientIds.get(key);
    if (id === undefined) throw new Error(`The demo portal names the client ${key}, which the seed did not create.`);
    return id;
  };

  for (const access of INVITED_ACCESSES) {
    await as((transaction) => raw(transaction, 'select * from app_private.add_client_portal_access(?::uuid, ?, ?)', [clientId(access.client), emailFor(access.emailLocal), access.name]));
  }

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
  }
};
