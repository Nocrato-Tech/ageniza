import { raw } from '@ageniza/database';

type Transaction = Parameters<typeof raw>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export type StoryScriptStatus = 'draft' | 'sent' | 'recorded';

export interface SceneRow {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly guidance: string | null;
}

export interface ScriptRow {
  readonly id: string;
  readonly script_on: string;
  readonly status: StoryScriptStatus;
  readonly recorded_at: Date | null;
  readonly recorded_by_name: string | null;
  readonly has_recorder: boolean;
  readonly created_at: Date;
  readonly scenes: readonly SceneRow[];
}

export type ClientScope = 'not-found' | 'archived' | 'active';

/**
 * Whether the client is this agency's, and open to writes. It reads through the helpers the policies use, so a role
 * that holds only `conteudo.*` (and cannot read `clients`) is judged like any other, and another agency's client is
 * the same answer as an absent one.
 */
export const clientScopeOf = async (transaction: Transaction, agencyId: string, clientId: string): Promise<ClientScope> => {
  const result = await raw<RawRows<{ agency_id: string | null; active: boolean }>>(transaction, `
    select app_private.client_agency_id(?::uuid) as agency_id, app_private.client_is_active(?::uuid) as active
  `, [clientId, clientId]);
  const row = result.rows[0];
  if (row === undefined || row.agency_id !== agencyId) return 'not-found';
  return row.active ? 'active' : 'archived';
};

// The day is read as text: a `date` column parsed into a JS Date moves with the server's time zone.
const SCRIPT_COLUMNS = `
  script.id, script.script_on::text as script_on, script.status, script.recorded_at, script.created_at,
  recorder.name as recorded_by_name, (recorder.recorded_by is not null) as has_recorder,
  coalesce((
    select jsonb_agg(jsonb_build_object('id', scene.id, 'position', scene.position, 'text', scene.text, 'guidance', scene.guidance) order by scene.position)
    from public.story_script_scenes scene
    where scene.script_id = script.id
  ), '[]'::jsonb) as scenes
`;

// The recorder is read by the function that answers for both sides: the portal cannot read another person's link.
const SCRIPT_FROM = `
  from public.story_scripts script
  left join lateral app_private.story_script_recorder(script.id) recorder on true
`;

/** The agency's read of one script of the client: any state, which is what the policy lets who reads Conteúdo see. */
export const loadAgencyScript = async (transaction: Transaction, clientId: string, scriptId: string): Promise<ScriptRow | undefined> => {
  const result = await raw<RawRows<ScriptRow>>(transaction, `
    select ${SCRIPT_COLUMNS}
    ${SCRIPT_FROM}
    where script.id = ?::uuid and script.client_id = ?::uuid
  `, [scriptId, clientId]);
  return result.rows[0];
};

/**
 * The portal's read of one script of the client. Row-level security says who may read a row, not from which side:
 * a person who is also a collaborator reads drafts through the agency branch of the policy, so the rule that the
 * portal never sees one is written here, in the SQL, and never left to the policy.
 */
export const loadPortalScript = async (transaction: Transaction, clientId: string, scriptId: string): Promise<ScriptRow | undefined> => {
  const result = await raw<RawRows<ScriptRow>>(transaction, `
    select ${SCRIPT_COLUMNS}
    ${SCRIPT_FROM}
    where script.id = ?::uuid
      and script.client_id = ?::uuid
      and script.status in ('sent', 'recorded')
  `, [scriptId, clientId]);
  return result.rows[0];
};

/**
 * The sent and recorded scripts of the client whose day is inside the period, oldest day first. It asks for one row
 * more than the ceiling, so the caller can tell "exactly the ceiling" from "more", and never truncates.
 */
export const listPortalScripts = async (
  transaction: Transaction,
  clientId: string,
  period: { readonly from: string; readonly to: string },
  limit: number
): Promise<ScriptRow[]> => {
  const result = await raw<RawRows<ScriptRow>>(transaction, `
    select ${SCRIPT_COLUMNS}
    ${SCRIPT_FROM}
    where script.client_id = ?::uuid
      and script.status in ('sent', 'recorded')
      and script.script_on between ?::date and ?::date
    order by script.script_on, script.created_at, script.id
    limit ?
  `, [clientId, period.from, period.to, limit]);
  return [...result.rows];
};

/** Takes the row lock that `send_story_script` takes, so an edit and a send of one script never interleave. */
export const lockScript = async (
  transaction: Transaction,
  clientId: string,
  scriptId: string
): Promise<{ readonly status: StoryScriptStatus } | undefined> => {
  const result = await raw<RawRows<{ status: StoryScriptStatus }>>(transaction, `
    select status from public.story_scripts where id = ?::uuid and client_id = ?::uuid for update
  `, [scriptId, clientId]);
  return result.rows[0];
};

export const insertScript = async (transaction: Transaction, input: { readonly clientId: string; readonly scriptOn: string }): Promise<string> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.story_scripts (client_id, script_on) values (?::uuid, ?::date) returning id
  `, [input.clientId, input.scriptOn]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The insert of a story script returned no row.');
  return row.id;
};

export const updateScriptDay = async (transaction: Transaction, scriptId: string, scriptOn: string): Promise<void> => {
  await raw(transaction, 'update public.story_scripts set script_on = ?::date where id = ?::uuid', [scriptOn, scriptId]);
};

export const loadSceneIds = async (transaction: Transaction, scriptId: string): Promise<string[]> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    select id from public.story_script_scenes where script_id = ?::uuid order by position
  `, [scriptId]);
  return result.rows.map((row) => row.id);
};

export interface SceneWrite {
  readonly position: number;
  readonly text: string;
  readonly guidance: string | null;
}

export const insertScenes = async (
  transaction: Transaction,
  script: { readonly id: string; readonly clientId: string },
  scenes: readonly SceneWrite[]
): Promise<void> => {
  if (scenes.length === 0) return;
  await raw(transaction, `
    insert into public.story_script_scenes (script_id, client_id, position, text, guidance)
    values ${scenes.map(() => '(?::uuid, ?::uuid, ?::integer, ?::text, ?::text)').join(', ')}
  `, scenes.flatMap((scene) => [script.id, script.clientId, scene.position, scene.text, scene.guidance]));
};

/**
 * Changes the text, guidance and place of existing scenes in ONE statement: the position key is checked at the end
 * of it, so two scenes can swap places. The scenes of another script never match.
 */
export const updateScenes = async (
  transaction: Transaction,
  scriptId: string,
  scenes: ReadonlyArray<SceneWrite & { readonly id: string }>
): Promise<number> => {
  if (scenes.length === 0) return 0;
  const result = await raw<{ readonly rowCount: number | null }>(transaction, `
    update public.story_script_scenes scene
    set position = edit.position, text = edit.text, guidance = edit.guidance
    from (values ${scenes.map(() => '(?::uuid, ?::integer, ?::text, ?::text)').join(', ')}) as edit(id, position, text, guidance)
    where scene.id = edit.id and scene.script_id = ?::uuid
  `, [...scenes.flatMap((scene) => [scene.id, scene.position, scene.text, scene.guidance]), scriptId]);
  return result.rowCount ?? 0;
};

/** `app_private.send_story_script`: checks the caller before the lock and answers `A0050`, `A0051` or `A0052`. */
export const sendScript = async (transaction: Transaction, scriptId: string): Promise<void> => {
  await raw(transaction, 'select app_private.send_story_script(?::uuid)', [scriptId]);
};

/** `app_private.record_story_script`: only an active person of the client's portal records; answers `A0050` or `A0052`. */
export const recordScript = async (transaction: Transaction, scriptId: string): Promise<void> => {
  await raw(transaction, 'select app_private.record_story_script(?::uuid)', [scriptId]);
};

/** Whether the person still has an active link to this client of an active agency: what the portal guard proved. */
export const portalAccessHolds = async (transaction: Transaction, clientId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ allowed: boolean }>>(transaction, `
    select exists (
      select 1
      from public.client_memberships membership
      join public.clients client on client.id = membership.client_id
      join public.agencies agency on agency.id = client.agency_id
      where client.id = ?::uuid
        and membership.user_id = app_private.current_user_id()
        and membership.status = 'active'
        and client.status = 'active'
        and agency.status = 'active'
    ) as allowed
  `, [clientId]);
  return result.rows[0]?.allowed === true;
};
