import type {
  Content,
  ContentDetail,
  ContentListItem,
  ContentTask,
  CreateContentRequest,
  StoryScriptListItem,
  UpdateContentRequest
} from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

import { CONTENT_READ_PERMISSION } from './policy.js';

export type ContentTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

interface ContentRow {
  readonly id: string;
  readonly client_id: string;
  readonly title: string;
  readonly platform: Content['platform'];
  readonly format: Content['format'];
  readonly publish_on: string;
  readonly publish_at_time: string | null;
  readonly caption: string | null;
  readonly folder_id: string;
  readonly cover_asset_id: string | null;
  readonly owner_user_id: string;
  readonly owner_membership_id: string | null;
  readonly owner_name: string | null;
  readonly status: Content['status'];
  readonly revision: number;
  readonly approver_side: 'agency' | 'client' | null;
  readonly approver_name: string | null;
  readonly approved_at: Date | null;
  readonly approved_by_agency_reason: string | null;
  readonly published_on: string | null;
  readonly cancelled_at: Date | null;
  readonly created_at: Date;
}

interface ListRow {
  readonly id: string;
  readonly title: string;
  readonly platform: ContentListItem['platform'];
  readonly format: ContentListItem['format'];
  readonly publish_on: string;
  readonly publish_at_time: string | null;
  readonly status: ContentListItem['status'];
  readonly owner_membership_id: string | null;
  readonly owner_name: string | null;
  readonly cover_asset_id: string | null;
  readonly revision: number;
  readonly published_on: string | null;
  readonly tasks_total: string | number;
  readonly tasks_approved: string | number;
}

interface ScriptRow {
  readonly id: string;
  readonly script_on: string;
  readonly status: StoryScriptListItem['status'];
}

// Dates are read as text and the time as HH:MM: the driver would turn a `date` into an instant in the server's zone.
const CONTENT_COLUMNS = `
  content.id, content.client_id, content.title, content.platform, content.format,
  content.publish_on::text as publish_on, to_char(content.publish_at_time, 'HH24:MI') as publish_at_time,
  content.caption, content.folder_id, content.cover_asset_id, content.owner_user_id, owner_link.id as owner_membership_id,
  owner_account.name as owner_name, content.status, content.revision,
  case when content.approved_by is null then null when content.approved_by_agency_reason is not null then 'agency' else 'client' end as approver_side,
  approver_account.name as approver_name, content.approved_at, content.approved_by_agency_reason,
  content.published_on::text as published_on, content.cancelled_at, content.created_at
`;

/**
 * The person in charge is shown by the link they have with the agency of the client (the one id of a collaborator the API gives) and
 * the name of that link's account; a link that was removed still names who was in charge. The link is unique per agency and person.
 */
const OWNER_JOINS = `
  join public.clients owner_client on owner_client.id = content.client_id
  left join public.agency_memberships owner_link
    on owner_link.agency_id = owner_client.agency_id and owner_link.user_id = content.owner_user_id
  left join auth."user" owner_account on owner_account.id = owner_link.user_id
`;

/** True when the person is tied to the agency the way an approval outside the platform needs: a link, or the ownership of the agency. */
const agencyTie = (person: string, agency: string): string => `(
  exists (select 1 from public.agency_memberships tie where tie.agency_id = ${agency} and tie.user_id = ${person})
  or exists (select 1 from public.agencies tie_agency where tie_agency.id = ${agency} and tie_agency.owner_user_id = ${person})
)`;

/**
 * Who approved is named without an id, by the link of the side they approved from: a collaborator of the agency for an approval outside
 * the platform, a person of the client's portal for the approval of the client. The side is how it was approved (the reason is written
 * only by the approval outside the platform), so a person who is both is named by the side they used.
 */
const APPROVER_JOIN = `
  left join auth."user" approver_account on approver_account.id = content.approved_by and (
    case when content.approved_by_agency_reason is not null
      then ${agencyTie('content.approved_by', 'owner_client.agency_id')}
      else exists (
        select 1 from public.client_memberships portal_link
        where portal_link.client_id = content.client_id and portal_link.user_id = content.approved_by
      )
    end
  )
`;

const ownerOf = (row: { readonly owner_membership_id: string | null; readonly owner_name: string | null }): Content['owner'] =>
  row.owner_membership_id === null || row.owner_name === null ? null : { membershipId: row.owner_membership_id, name: row.owner_name };

/**
 * The user behind an active link of a collaborator of this agency who can see Conteúdo, or `undefined` for a link that is absent,
 * removed, of another agency, of a client's portal (a portal link has its own table, so its id is no id here) or of a person who
 * cannot read Conteúdo. A person is named by a link, never by an id. The trigger `A0073` asks the same of the database
 * (`app_private.agency_user_can`, which `ageniza_app` cannot call), so this is the same rule read by the route before any write.
 */
export const resolveCollaboratorLink = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly membershipId: string }
): Promise<string | undefined> => {
  const result = await raw<RawRows<{ user_id: string }>>(transaction, `
    select membership.user_id
    from public.agency_memberships membership
    join public.agencies agency on agency.id = membership.agency_id
    where membership.id = ?::uuid and membership.agency_id = ?::uuid and membership.status = 'active' and agency.status = 'active'
      and exists (select 1 from public.permissions permission where permission.key = ?)
      and (
        agency.owner_user_id = membership.user_id
        or exists (
          select 1
          from public.roles role
          join public.role_permissions role_permission on role_permission.role_id = role.id
          where role.id = membership.role_id
            and (role.agency_id is null or role.agency_id = agency.id)
            and role_permission.permission_key = ?
        )
      )
  `, [input.membershipId, input.agencyId, CONTENT_READ_PERMISSION, CONTENT_READ_PERMISSION]);
  return result.rows[0]?.user_id;
};

/** The state of a client of the agency, `undefined` for one that is not in it (or that this person cannot read). */
export const loadClientStatus = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly clientId: string }
): Promise<'active' | 'archived' | undefined> => {
  const result = await raw<RawRows<{ status: 'active' | 'archived' }>>(transaction, `
    select status from public.clients where id = ?::uuid and agency_id = ?::uuid
  `, [input.clientId, input.agencyId]);
  return result.rows[0]?.status;
};

/**
 * Both kinds of item of a period, each read one past the ceiling so the caller can tell "at the ceiling" from
 * "over it" without counting what it will refuse. One kind alone over the ceiling is over it for the two.
 */
export const listPeriod = async (
  transaction: ContentTransaction,
  input: { readonly clientId: string; readonly from: string; readonly to: string; readonly limit: number }
): Promise<{ readonly contents: ContentListItem[]; readonly storyScripts: StoryScriptListItem[] }> => {
  const contents = await raw<RawRows<ListRow>>(transaction, `
    select
      content.id, content.title, content.platform, content.format, content.publish_on::text as publish_on,
      to_char(content.publish_at_time, 'HH24:MI') as publish_at_time, content.status,
      owner_link.id as owner_membership_id, owner_account.name as owner_name,
      content.cover_asset_id, content.revision, content.published_on::text as published_on,
      tasks.total as tasks_total, tasks.approved as tasks_approved
    from public.contents content
    ${OWNER_JOINS}
    left join lateral (
      select count(*) as total, count(*) filter (where task.status = 'approved') as approved
      from public.content_tasks task
      where task.content_id = content.id
    ) tasks on true
    where content.client_id = ?::uuid and content.publish_on between ?::date and ?::date
    order by content.publish_on, content.publish_at_time, content.id
    limit ?
  `, [input.clientId, input.from, input.to, input.limit]);

  const scripts = await raw<RawRows<ScriptRow>>(transaction, `
    select script.id, script.script_on::text as script_on, script.status
    from public.story_scripts script
    where script.client_id = ?::uuid and script.script_on between ?::date and ?::date
    order by script.script_on, script.id
    limit ?
  `, [input.clientId, input.from, input.to, input.limit]);

  return {
    contents: contents.rows.map((row) => ({
      id: row.id,
      title: row.title,
      platform: row.platform,
      format: row.format,
      publishOn: row.publish_on,
      publishAtTime: row.publish_at_time,
      status: row.status,
      owner: ownerOf(row),
      coverAssetId: row.cover_asset_id,
      revision: Number(row.revision),
      publishedOn: row.published_on,
      tasksTotal: Number(row.tasks_total),
      tasksApproved: Number(row.tasks_approved)
    })),
    storyScripts: scripts.rows.map((row) => ({ id: row.id, scriptOn: row.script_on, status: row.status }))
  };
};

export const loadContent = async (
  transaction: ContentTransaction,
  input: { readonly clientId: string; readonly contentId: string }
): Promise<ContentRow | undefined> => {
  const result = await raw<RawRows<ContentRow>>(transaction, `
    select ${CONTENT_COLUMNS}
    from public.contents content
    ${OWNER_JOINS}
    ${APPROVER_JOIN}
    where content.id = ?::uuid and content.client_id = ?::uuid
  `, [input.contentId, input.clientId]);
  return result.rows[0];
};

export const contentFromRow = (row: ContentRow): Content => ({
  id: row.id,
  clientId: row.client_id,
  title: row.title,
  platform: row.platform,
  format: row.format,
  publishOn: row.publish_on,
  publishAtTime: row.publish_at_time,
  caption: row.caption,
  folderId: row.folder_id,
  coverAssetId: row.cover_asset_id,
  owner: ownerOf(row),
  status: row.status,
  revision: Number(row.revision),
  approvedBy: row.approver_side === null ? null : { name: row.approver_name ?? '', side: row.approver_side },
  approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
  approvedByAgencyReason: row.approved_by_agency_reason,
  publishedOn: row.published_on,
  cancelledAt: row.cancelled_at === null ? null : new Date(row.cancelled_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString()
});

/** The owner is omitted, never sent as null, so the column default (who creates) applies. */
export const insertContent = async (
  transaction: ContentTransaction,
  input: { readonly clientId: string; readonly body: Omit<CreateContentRequest, 'ownerMembershipId'>; readonly ownerUserId: string | undefined }
): Promise<string> => {
  const { body } = input;
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.contents (client_id, title, platform, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id)
    values (?::uuid, ?, ?, ?, ?::date, ?::time, ?, ?::uuid, ?::uuid, coalesce(?::uuid, app_private.current_user_id()))
    returning id
  `, [
    input.clientId, body.title, body.platform ?? 'instagram', body.format, body.publishOn,
    body.publishAtTime ?? null, body.caption ?? null, body.folderId, body.coverAssetId ?? null, input.ownerUserId ?? null
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Content insert did not return a row.');
  return row.id;
};

/**
 * What a PATCH writes into the row: the body without the link that names the owner, and the user that link resolved to. The route
 * resolves the link, because the column holds a user and no caller is given one.
 */
export type ContentChanges = Omit<UpdateContentRequest, 'ownerMembershipId'> & { readonly ownerUserId?: string };

/** Body field -> column and cast: the only columns a PATCH writes, in the order of the grant. */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ContentChanges, string, string]> = [
  ['title', 'title', ''],
  ['format', 'format', ''],
  ['publishOn', 'publish_on', '::date'],
  ['publishAtTime', 'publish_at_time', '::time'],
  ['caption', 'caption', ''],
  ['folderId', 'folder_id', '::uuid'],
  ['coverAssetId', 'cover_asset_id', '::uuid'],
  ['ownerUserId', 'owner_user_id', '::uuid']
];

/** Whether the body carries a column of the row, as opposed to only the media list. */
export const changesColumns = (changes: ContentChanges): boolean =>
  UPDATABLE_COLUMNS.some(([key]) => changes[key] !== undefined);

/** `false` when no row of the client matched: the row went away, or the policy no longer lets this person write it. */
export const updateContent = async (
  transaction: ContentTransaction,
  input: { readonly clientId: string; readonly contentId: string; readonly changes: ContentChanges }
): Promise<boolean> => {
  const assignments: string[] = [];
  const bindings: Array<string | null> = [];
  for (const [key, column, cast] of UPDATABLE_COLUMNS) {
    const value = input.changes[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?${cast}`);
    bindings.push(value as string | null);
  }
  if (assignments.length === 0) throw new Error('A content update carries at least one column.');
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.contents set ${assignments.join(', ')}
    where id = ?::uuid and client_id = ?::uuid
    returning id
  `, [...bindings, input.contentId, input.clientId]);
  return result.rows[0] !== undefined;
};

/** The whole ordered list, by the function that checks the folder, the format and the state (never a delta). */
export const replaceContentMedia = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly assetIds: readonly string[] }
): Promise<void> => {
  // The ids are UUIDs the contract already checked; the array literal is the one way to hand the function a list.
  await raw(transaction, 'select app_private.set_content_media(?::uuid, ?::uuid[])', [input.contentId, `{${input.assetIds.join(',')}}`]);
};

/**
 * The subtasks of a content, or the one of `taskId`, as the agency reads them: the person in charge by the link of the agency of the
 * client, and who approved by name and side. The id of a task that is not of this content is no row, never a row of another content.
 */
export const loadContentTasks = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly taskId?: string }
): Promise<ContentTask[]> => {
  const result = await raw<RawRows<{
    id: string;
    title: string;
    description: string | null;
    assignee_membership_id: string | null;
    assignee_name: string | null;
    due_on: string;
    status: ContentTask['status'];
    return_comment: string | null;
    approved: boolean;
    approver_name: string | null;
    approved_at: Date | null;
  }>>(transaction, `
    select task.id, task.title, task.description, assignee_link.id as assignee_membership_id, assignee_account.name as assignee_name,
      task.due_on::text as due_on, task.status, task.return_comment, (task.approved_by is not null) as approved,
      approver_account.name as approver_name, task.approved_at
    from public.content_tasks task
    join public.clients task_client on task_client.id = task.client_id
    left join public.agency_memberships assignee_link
      on assignee_link.agency_id = task_client.agency_id and assignee_link.user_id = task.assignee_user_id
    left join auth."user" assignee_account on assignee_account.id = assignee_link.user_id
    left join auth."user" approver_account on approver_account.id = task.approved_by
      and ${agencyTie('task.approved_by', 'task_client.agency_id')}
    where task.content_id = ?::uuid and (?::uuid is null or task.id = ?::uuid)
    order by task.due_on, task.created_at, task.id
  `, [input.contentId, input.taskId ?? null, input.taskId ?? null]);

  return result.rows.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    assignee: task.assignee_membership_id === null || task.assignee_name === null ? null : { membershipId: task.assignee_membership_id, name: task.assignee_name },
    dueOn: task.due_on,
    status: task.status,
    returnComment: task.return_comment,
    // A subtask is approved by the person in charge of the content or by who approves for the agency: always the agency side.
    approvedBy: task.approved ? { name: task.approver_name ?? '', side: 'agency' as const } : null,
    approvedAt: task.approved_at === null ? null : new Date(task.approved_at).toISOString()
  }));
};

export const loadContentDetail = async (
  transaction: ContentTransaction,
  row: ContentRow
): Promise<ContentDetail> => {
  const media = await raw<RawRows<{ id: string; position: number }>>(transaction, `
    select item.asset_id as id, item.position
    from public.content_media item
    where item.content_id = ?::uuid
    order by item.position
  `, [row.id]);

  const tasks = await loadContentTasks(transaction, { contentId: row.id });

  const conversation = await raw<RawRows<{ thread_id: string; comment_count: string | number; last_comment_at: Date | null }>>(transaction, `
    select thread.id as thread_id, count(comment.id) as comment_count, max(comment.created_at) as last_comment_at
    from public.client_threads thread
    left join public.client_thread_comments comment on comment.thread_id = thread.id
    where thread.content_id = ?::uuid
    group by thread.id
  `, [row.id]);
  const thread = conversation.rows[0];

  return {
    ...contentFromRow(row),
    media: media.rows.map((item) => ({ id: item.id, position: Number(item.position) })),
    tasks,
    conversation: thread === undefined
      ? { threadId: null, commentCount: 0, lastCommentAt: null }
      : {
          threadId: thread.thread_id,
          commentCount: Number(thread.comment_count),
          lastCommentAt: thread.last_comment_at === null ? null : new Date(thread.last_comment_at).toISOString()
        }
  };
};
