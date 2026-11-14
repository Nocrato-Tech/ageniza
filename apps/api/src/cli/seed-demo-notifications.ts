import { raw, type DatabaseClient } from '@ageniza/database';

/**
 * The notifications of the demo (specs/notificacoes.md): a few of each of the five kinds for the owner of the agency and for a person of
 * the production, some read and some not, so the bell has something in it. The events of the seed that already notify (the portal approving,
 * the clients answering a request) do it for the person in charge of each content or request; these are the ones for the two people the
 * demo logs in as. They are made by the function the events call (`add_notification`), as the owner of the schema, since nobody else can
 * write the table, and found again by recipient, kind and subject, so a rerun adds none; the instant and the read mark follow the spec.
 */

/**
 * A database that was already used (an older seed, a screen that moved a content, something deleted) may not hold what a notification
 * points at: a content that was cancelled or sent back has no round, a request or a content may be gone, and the function writes nothing
 * for an archived client. Then that notification is skipped; the seed never fails over it.
 */

const PADARIA = 'client:padaria-central';

type Recipient = 'owner' | 'production';

interface NotificationSpec {
  readonly recipient: Recipient;
  readonly kind: 'content_approved' | 'content_changes_requested' | 'approval_deadline_passed' | 'material_request_answered' | 'invitation_accepted';
  /** The title of the content or of the request for material; none for an invitation. */
  readonly title?: string;
  readonly client: string;
  readonly minutesAgo: number;
  /** Minutes ago it was read; absent is unread. */
  readonly readMinutesAgo?: number;
}

const NOTIFICATIONS: readonly NotificationSpec[] = [
  { recipient: 'owner', kind: 'material_request_answered', title: 'Fotos novas do balcão de pães', client: PADARIA, minutesAgo: 6 },
  { recipient: 'owner', kind: 'content_approved', title: 'Promoção da semana: combo café e pão', client: PADARIA, minutesAgo: 45 },
  { recipient: 'owner', kind: 'approval_deadline_passed', title: 'O pão de ontem vira torrada', client: PADARIA, minutesAgo: 150 },
  { recipient: 'owner', kind: 'content_changes_requested', title: 'Café da manhã em família', client: PADARIA, minutesAgo: 26 * 60, readMinutesAgo: 20 * 60 },
  { recipient: 'owner', kind: 'invitation_accepted', client: PADARIA, minutesAgo: 3 * 24 * 60, readMinutesAgo: 3 * 24 * 60 - 30 },
  { recipient: 'production', kind: 'content_approved', title: 'Pão de queijo em dobro às quartas', client: PADARIA, minutesAgo: 3 * 60 },
  { recipient: 'production', kind: 'content_changes_requested', title: 'Café da manhã em família', client: PADARIA, minutesAgo: 26 * 60, readMinutesAgo: 22 * 60 },
  { recipient: 'production', kind: 'material_request_answered', title: 'Lista de preços atualizada', client: PADARIA, minutesAgo: 2 * 24 * 60, readMinutesAgo: 47 * 60 }
];

export interface NotificationsDemoInput {
  /** The migration owner: the only role that can run the functions that write a notification. */
  readonly owner: DatabaseClient;
  readonly clientIds: ReadonlyMap<string, string>;
  readonly agencyId: string;
  readonly recipients: Readonly<Record<Recipient, string>>;
}

interface Rows<TRow> {
  readonly rows: readonly TRow[];
}

const SUMMARY = {
  content_approved: "app_private.notification_summary(app_private.notification_clip(?, 50) || ' aprovou ', ?, '')",
  content_changes_requested: "app_private.notification_summary(app_private.notification_clip(?, 50) || ' pediu ajuste em ', ?, '')",
  approval_deadline_passed: "app_private.notification_summary('O prazo de ', ?, ' venceu')"
} as const;

export const ensureNotificationsDemo = async (input: NotificationsDemoInput): Promise<void> => {
  const { owner, clientIds, agencyId, recipients } = input;

  for (const spec of NOTIFICATIONS) {
    const clientId = clientIds.get(spec.client);
    if (clientId === undefined) throw new Error(`The demo notifications name the client ${spec.client}, which the seed did not create.`);
    const recipient = recipients[spec.recipient];
    const title = spec.title ?? '';
    if (spec.kind !== 'invitation_accepted' && title === '') throw new Error(`The demo notification ${spec.kind} needs the title of its subject.`);

    await owner.transaction(async (transaction) => {
      const client = (await raw<Rows<{ name: string }>>(transaction, 'select name from public.clients where id = ?::uuid', [clientId])).rows[0];
      if (client === undefined) throw new Error(`The demo client ${spec.client} could not be read.`);

      let subject: { readonly kind: 'content' | 'thread' | 'invitation'; readonly id: string };
      if (spec.kind === 'invitation_accepted') {
        const invitation = (await raw<Rows<{ id: string }>>(transaction, `
          select id from public.invitations
          where agency_id = ?::uuid and invited_by_user_id = ?::uuid and purpose = 'collaborator_invite' and accepted_by_user_id is not null
          order by created_at, id limit 1
        `, [agencyId, recipient])).rows[0];
        if (invitation === undefined) return;
        subject = { kind: 'invitation', id: invitation.id };
      } else if (spec.kind === 'material_request_answered') {
        const thread = (await raw<Rows<{ id: string }>>(transaction, `
          select id from public.client_threads where client_id = ?::uuid and is_material_request and title = ? order by created_at, id limit 1
        `, [clientId, title])).rows[0];
        if (thread === undefined) return;
        subject = { kind: 'thread', id: thread.id };
      } else {
        const content = (await raw<Rows<{ id: string }>>(transaction, 'select id from public.contents where client_id = ?::uuid and title = ?', [clientId, title])).rows[0];
        if (content === undefined) return;
        subject = { kind: 'content', id: content.id };
      }

      const existing = (await raw<Rows<{ id: string }>>(transaction, `
        select id from public.notifications
        where recipient_user_id = ?::uuid and kind = ? and coalesce(content_id, thread_id, invitation_id) = ?::uuid
        order by created_at, id limit 1
      `, [recipient, spec.kind, subject.id])).rows[0];

      let notificationId: string | undefined = existing?.id;
      if (notificationId === undefined) {
        if (spec.kind === 'invitation_accepted') {
          notificationId = (await raw<Rows<{ id: string | null }>>(transaction, `
            select app_private.add_notification(
              'invitation_accepted', ?::uuid, ?::uuid, null, null, null, ?::uuid, null,
              app_private.notification_clip(coalesce((select account.name from auth."user" account join public.invitations invitation on invitation.accepted_by_user_id = account.id where invitation.id = ?::uuid), 'Alguém'), 100) || ' aceitou o seu convite'
            ) as id
          `, [recipient, agencyId, subject.id, subject.id])).rows[0]?.id ?? undefined;
        } else if (spec.kind === 'material_request_answered') {
          notificationId = (await raw<Rows<{ id: string | null }>>(transaction, `
            select app_private.add_notification(
              'material_request_answered', ?::uuid, ?::uuid, ?::uuid, null, ?::uuid, null, null,
              app_private.notification_summary(app_private.notification_clip(?, 50) || ' respondeu ', ?, '')
            ) as id
          `, [recipient, agencyId, clientId, subject.id, client.name, title])).rows[0]?.id ?? undefined;
        } else {
          const round = spec.kind === 'approval_deadline_passed'
            ? (await raw<Rows<{ id: string }>>(transaction, 'select id from public.content_approval_rounds where content_id = ?::uuid order by sequence desc limit 1', [subject.id])).rows[0]?.id ?? null
            : null;
          if (spec.kind === 'approval_deadline_passed' && round === null) return;
          const summary = spec.kind === 'approval_deadline_passed' ? [title] : [client.name, title];
          notificationId = (await raw<Rows<{ id: string | null }>>(transaction, `
            select app_private.add_notification(?, ?::uuid, ?::uuid, ?::uuid, ?::uuid, null, null, ?::uuid, ${SUMMARY[spec.kind]}) as id
          `, [spec.kind, recipient, agencyId, clientId, subject.id, round, ...summary])).rows[0]?.id ?? undefined;
        }
      }
      if (notificationId === undefined) return;

      await raw(transaction, `
        update public.notifications
        set created_at = now() - make_interval(mins => ?::integer),
            read_at = case when ?::integer is null then null else now() - make_interval(mins => ?::integer) end
        where id = ?::uuid
      `, [spec.minutesAgo, spec.readMinutesAgo ?? null, spec.readMinutesAgo ?? null, notificationId]);
    });
  }
};
