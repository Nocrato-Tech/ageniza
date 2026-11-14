import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import type { ContentWorld } from './content-world.js';

// What the tests of the notifications share. The owner plants a notification of any shape (it is the only role that may write the table),
// so the policy and the functions that read it are attacked on rows the events would not always make; every read runs as `ageniza_app`.
export type NotificationKind =
  | 'content_approved'
  | 'content_changes_requested'
  | 'material_request_answered'
  | 'approval_deadline_passed'
  | 'invitation_accepted';

export interface NotificationRow {
  readonly id: string;
  readonly agency_id: string;
  readonly recipient_user_id: string;
  readonly kind: NotificationKind;
  readonly content_id: string | null;
  readonly thread_id: string | null;
  readonly invitation_id: string | null;
  readonly client_id: string | null;
  readonly approval_round_id: string | null;
  readonly summary: string;
  readonly created_at: Date;
  readonly read_at: Date | null;
}

export interface SeedNotification {
  readonly kind: NotificationKind;
  readonly recipient: string;
  /** The subject, made when it is not given: a content, a request for material or an invitation of agency A. */
  readonly contentId?: string;
  readonly threadId?: string;
  readonly invitationId?: string;
  readonly roundId?: string;
  readonly clientId?: string;
  readonly agencyId?: string;
  readonly purpose?: 'collaborator_invite' | 'client_invite';
  readonly summary?: string;
  readonly readAt?: Date;
}

export interface NotificationFixtures {
  owner(): Knex;
  seed(input: SeedNotification): Promise<string>;
  /** The invitation of the agency A, as the owner would have made it, with a token the test can accept. */
  invitation(input: {
    readonly purpose: 'collaborator_invite' | 'client_invite' | 'agency_activation';
    readonly email: string;
    readonly invitedBy: string | null;
    readonly clientId?: string;
    readonly agencyId?: string;
  }): Promise<{ id: string; token: string; tokenHash: string }>;
  /** A request for material of a client, opened by a person of the agency. */
  materialRequest(input?: { readonly clientId?: string; readonly openedBy?: string; readonly title?: string | null; readonly resolved?: boolean }): Promise<string>;
  /** The round of a content, written by the owner (the application role cannot), with its deadline. */
  round(contentId: string, input: { readonly dueAt: string; readonly sequence?: number }): Promise<string>;
  rowsOf(recipient: string): Promise<NotificationRow[]>;
  rowsFor(subject: { readonly contentId?: string; readonly threadId?: string; readonly invitationId?: string }): Promise<NotificationRow[]>;
  /** The ids of the notifications `user` reads, as `ageniza_app` with that person bound. */
  visibleTo(user: string): Promise<string[]>;
  row(id: string): Promise<NotificationRow>;
  /** Runs `work` while any notification written for the agency is followed by a failure, so that what the event did before it must be undone with it. */
  failAfterNotificationWrite<T>(agencyId: string, work: () => Promise<T>): Promise<T>;
  cleanUp(): Promise<void>;
}

export const createNotificationFixtures = (w: ContentWorld): NotificationFixtures => {
  const { ids } = w;
  const owner = (): Knex => w.getOwner().knex;
  const invitationIds: string[] = [];
  const threadIds: string[] = [];

  const invitation: NotificationFixtures['invitation'] = async ({ purpose, email, invitedBy, clientId, agencyId }) => {
    const id = randomUUID();
    const token = `notif-${id}`;
    const tokenHash = (await owner().raw<{ rows: Array<{ hash: string }> }>("select encode(sha256(convert_to(?, 'UTF8')), 'hex') as hash", [token])).rows[0]!.hash;
    invitationIds.push(id);
    const role = await owner()('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
    await owner()('invitations').insert({
      id,
      agency_id: agencyId ?? ids.agencyA,
      purpose,
      email,
      role_id: purpose === 'collaborator_invite' ? (role?.id as string) : null,
      client_id: purpose === 'client_invite' ? (clientId ?? ids.clientA1) : null,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 86_400_000),
      invited_by_user_id: invitedBy
    });
    return { id, token, tokenHash };
  };

  const materialRequest: NotificationFixtures['materialRequest'] = async (input = {}) => {
    const id = randomUUID();
    threadIds.push(id);
    await owner()('client_threads').insert({
      id,
      client_id: input.clientId ?? ids.clientA1,
      is_material_request: true,
      opened_by: input.openedBy ?? ids.adminA,
      opened_side: 'agency',
      title: input.title === undefined ? 'Fotos da equipe' : input.title,
      ...(input.resolved === true ? { resolved_at: new Date(), resolved_by: input.openedBy ?? ids.adminA } : {})
    });
    return id;
  };

  const round: NotificationFixtures['round'] = async (contentId, { dueAt, sequence = 1 }) => {
    const content = await owner()('contents').where({ id: contentId }).first('client_id');
    const id = randomUUID();
    await owner().raw(
      `insert into public.content_approval_rounds (id, batch_id, client_id, content_id, sequence, sent_by, due_at, due_on)
       values (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer, ?::uuid, ?::timestamptz, app_private.sao_paulo_date(?::timestamptz))`,
      [id, randomUUID(), content?.client_id as string, contentId, sequence, ids.productionA, dueAt, dueAt]
    );
    return id;
  };

  const seed: NotificationFixtures['seed'] = async (input) => {
    const clientId = input.clientId ?? ids.clientA1;
    const agencyId = input.agencyId ?? ids.agencyA;
    let contentId = input.contentId;
    let threadId = input.threadId;
    let invitationId = input.invitationId;
    let roundId = input.roundId;
    const aboutContent = input.kind === 'content_approved' || input.kind === 'content_changes_requested' || input.kind === 'approval_deadline_passed';

    const agencyPerson = agencyId === ids.agencyB ? ids.adminB : ids.adminA;
    if (aboutContent && contentId === undefined) contentId = await w.seedContent(clientId, { status: 'awaiting_approval', owner: agencyId === ids.agencyB ? ids.adminB : ids.productionA });
    if (input.kind === 'approval_deadline_passed' && roundId === undefined) roundId = await round(contentId!, { dueAt: new Date(Date.now() - 3_600_000).toISOString() });
    if (input.kind === 'material_request_answered' && threadId === undefined) threadId = await materialRequest({ clientId, openedBy: agencyPerson });
    if (input.kind === 'invitation_accepted' && invitationId === undefined) {
      const email = `${randomUUID()}@notifications.test`;
      invitationId = (await invitation({ purpose: input.purpose ?? 'collaborator_invite', email, invitedBy: input.recipient, ...(input.purpose === 'client_invite' ? { clientId } : {}) })).id;
    }

    const id = randomUUID();
    await owner()('notifications').insert({
      id,
      agency_id: agencyId,
      recipient_user_id: input.recipient,
      kind: input.kind,
      content_id: contentId ?? null,
      thread_id: threadId ?? null,
      invitation_id: invitationId ?? null,
      client_id: input.kind === 'invitation_accepted' && input.purpose !== 'client_invite' ? null : clientId,
      approval_round_id: roundId ?? null,
      summary: input.summary ?? `Resumo ${id.slice(0, 8)}`,
      read_at: input.readAt ?? null
    });
    return id;
  };

  return {
    owner,
    seed,
    invitation,
    materialRequest,
    round,
    rowsOf: async (recipient) =>
      (await owner()('notifications').where({ recipient_user_id: recipient }).orderBy('created_at').orderBy('id')) as NotificationRow[],
    rowsFor: async (subject) => {
      const query = owner()('notifications');
      if (subject.contentId !== undefined) query.where({ content_id: subject.contentId });
      if (subject.threadId !== undefined) query.where({ thread_id: subject.threadId });
      if (subject.invitationId !== undefined) query.where({ invitation_id: subject.invitationId });
      return (await query.orderBy('created_at').orderBy('id')) as NotificationRow[];
    },
    visibleTo: async (user) =>
      (await w.asUser(user, (t) => t('notifications').select('id'))).map((row: { id: string }) => row.id).sort(),
    row: async (id) => (await owner()('notifications').where({ id }).first()) as NotificationRow,
    failAfterNotificationWrite: async (agencyId, work) => {
      await owner().raw(`
        create function public.inject_failure_after_notification() returns trigger language plpgsql
        as $body$ begin raise exception using errcode = 'P0001', message = 'injected after the notification'; end; $body$
      `);
      await owner().raw(`
        create trigger inject_failure_after_notification after insert on public.notifications for each row
        when (new.agency_id = '${agencyId}'::uuid) execute function public.inject_failure_after_notification()
      `);
      try {
        return await work();
      } finally {
        await owner().raw('drop trigger if exists inject_failure_after_notification on public.notifications');
        await owner().raw('drop function if exists public.inject_failure_after_notification()');
      }
    },
    cleanUp: async () => {
      const knex = owner();
      await knex('notifications').whereIn('invitation_id', invitationIds).delete();
      await knex('audit.events').whereIn('target_id', invitationIds).delete();
      await knex('invitations').whereIn('id', invitationIds).delete();
      await knex('notifications').whereIn('thread_id', threadIds).delete();
      await knex('client_thread_comments').whereIn('thread_id', threadIds).delete();
      await knex('client_threads').whereIn('id', threadIds).delete();
    }
  };
};
