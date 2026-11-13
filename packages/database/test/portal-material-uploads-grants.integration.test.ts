import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addedKeys, changedKeys, migrateAcross, removedKeys, type MigratedAcross } from './support/catalog-snapshot.js';

// Scope redesign-igual, subtask W10-S3 (decision 2026-11-11, "o cliente envia material pelo portal"): the catalog before and after the migration
// that lets the person of the portal send material to a request. It adds two columns to the media, one unique key to the conversations and
// twelve functions, four of them open to the application role, and no policy: the portal reads the media through a function, never the table.
// It may change the grant, the policy, the RLS flag, the owner or the text of nothing else, and it rewrites no row of the media that exists.
const THIS_MIGRATION = '20261113000100_portal_material_uploads.mjs';

const IN_USE = '(p_agency_id uuid, p_pending_window_seconds integer, p_exclude_asset_id uuid)';
const MAX_BYTES = '()';
const MAX_FILES = '()';
const TYPE = '(p_content_type text)';
const SETTINGS = '(p_default_quota_bytes bigint, p_default_quota_object_count bigint, p_pending_window_seconds integer)';
const REFUSAL = '(p_agency_id uuid, p_thread_id uuid, p_size_bytes bigint, p_exclude_asset_id uuid, p_default_quota_bytes bigint, p_default_quota_object_count bigint, p_pending_window_seconds integer)';
const LOCK_OWN = '(p_asset_id uuid)';
const REQUIRE_REQUEST = '(p_client_id uuid, p_thread_id uuid)';
const LIST = '(p_client_id uuid, p_thread_id uuid, p_limit integer, p_offset bigint)';
const START = '(p_client_id uuid, p_thread_id uuid, p_content_type text, p_declared_size_bytes bigint, p_file_name text, p_default_quota_bytes bigint, p_default_quota_object_count bigint, p_pending_window_seconds integer)';
const CONFIRM = '(p_asset_id uuid, p_size_bytes bigint, p_content_type text, p_width integer, p_height integer, p_default_quota_bytes bigint, p_default_quota_object_count bigint, p_pending_window_seconds integer)';
const REJECT = '(p_asset_id uuid, p_reason text)';
const USAGE = '(p_agency_id uuid, p_pending_window_seconds integer, p_exclude_asset_id uuid)';

const OPEN = [
  `start_portal_material_upload${START}`, `confirm_portal_material_upload${CONFIRM}`, `reject_portal_material_upload${REJECT}`, `list_portal_material_uploads${LIST}`
];
const CLOSED = [
  `agency_storage_in_use${IN_USE}`, `portal_upload_max_bytes${MAX_BYTES}`, `portal_upload_max_files${MAX_FILES}`, `portal_upload_type${TYPE}`,
  `require_portal_upload_settings${SETTINGS}`, `portal_upload_refusal${REFUSAL}`, `lock_own_pending_portal_upload${LOCK_OWN}`,
  `require_portal_material_request${REQUIRE_REQUEST}`
];

let migrated: MigratedAcross;
let seeded: { asset: string; xmin: string };

beforeAll(async () => {
  migrated = await migrateAcross(THIS_MIGRATION, 'portaluploads', async (scratch) => {
    expect(await scratch.schema.hasColumn('media_assets', 'uploaded_by_side')).toBe(false);
    const [user, agency, client, asset] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await scratch('auth.user').insert({ id: user, name: 'Antes', email: `${user}@portal-uploads-grants.test`, emailVerified: true });
    await scratch('agencies').insert({ id: agency, name: `Agência ${agency}` });
    await scratch('clients').insert({ id: client, agency_id: agency, name: `Cliente ${client}` });
    const folder = (await scratch('media_folders').where({ client_id: client, is_default: true }).first('id'))!.id as string;
    await scratch('media_assets').insert({
      id: asset, agency_id: agency, client_id: client, folder_id: folder, category: 'image', declared_content_type: 'image/png', extension: 'png',
      object_key: `${agency}/${asset}/original.png`, upload_object_key: `staging/${agency}/${asset}/upload.png`, declared_size_bytes: 10, created_by_user_id: user
    });
    seeded = { asset, xmin: (await scratch.raw<{ rows: Array<{ xmin: string }> }>('select xmin::text from public.media_assets where id = ?::uuid', [asset])).rows[0]!.xmin };
  });
}, 300_000);

afterAll(async () => {
  await migrated?.cleanUp();
});

interface TableSnapshot {
  rls: boolean[];
  owner: string;
  app: Record<string, boolean>;
  public: Record<string, boolean>;
  columns: Record<string, Record<string, boolean>>;
  public_columns: Record<string, Record<string, boolean>>;
  policies: unknown[][];
}
interface FunctionSnapshot { app: boolean; public: boolean; definer: boolean; config: string[] | null; owner: string }

const table = (snapshot: Map<string, string>, name: string): TableSnapshot => JSON.parse(snapshot.get(`table public.${name}`)!) as TableSnapshot;
const grants = (signature: string): FunctionSnapshot => JSON.parse(migrated.after.privileges.get(`function app_private.${signature}`)!) as FunctionSnapshot;

describe('what the migration does to the privileges of the catalog', () => {
  it('has a snapshot worth comparing', () => {
    expect(migrated.before.privileges.size).toBeGreaterThan(100);
    expect(migrated.before.privileges.get('table public.media_assets')).toContain('"SELECT":true');
    expect(migrated.before.privileges.get(`function app_private.agency_media_usage${USAGE}`)).toContain('"app":true');
  });

  it('adds twelve functions and no other object, and removes nothing', () => {
    expect(addedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual(
      [...OPEN, ...CLOSED].map((signature) => `function app_private.${signature}`).sort()
    );
    expect(removedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([]);
  });

  it('changes the privileges of one object that already existed, the table of the media, and of nothing else: not the conversations, not the usage function', () => {
    expect(changedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual(['table public.media_assets']);
  });

  it('gives the media two columns the application role can only read, and no table grant, RLS flag, owner or privilege of its own the media did not have', () => {
    const before = table(migrated.before.privileges, 'media_assets');
    const after = table(migrated.after.privileges, 'media_assets');

    const added = ['uploaded_by_side', 'material_request_thread_id'];
    const withoutAdded = (columns: Record<string, Record<string, boolean>>) => Object.fromEntries(Object.entries(columns).filter(([name]) => !added.includes(name)));
    for (const column of added) {
      expect(after.columns[column], column).toEqual({ SELECT: true, INSERT: false, UPDATE: false, REFERENCES: false });
      expect(Object.values(after.public_columns[column]!).filter(Boolean), column).toEqual([]);
    }
    expect(withoutAdded(after.columns)).toEqual(before.columns);
    expect(withoutAdded(after.public_columns)).toEqual(before.public_columns);
    expect({ ...after, columns: null, public_columns: null, policies: null }).toEqual({ ...before, columns: null, public_columns: null, policies: null });
    expect(after.rls).toEqual([true, true]);
    expect(after.app).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
    expect(Object.values(after.public).filter(Boolean)).toEqual([]);
  });

  it('adds no policy to the media, and none to any other table: the portal reads the media through a function, never the table', () => {
    const policies = (snapshot: Map<string, string>): unknown[][] => table(snapshot, 'media_assets').policies;

    expect(policies(migrated.after.privileges)).toEqual(policies(migrated.before.privileges));
    expect(policies(migrated.before.privileges).length).toBeGreaterThan(0);
    expect([...migrated.after.privileges.keys()].filter((key) => key.startsWith('table ') && !migrated.before.privileges.has(key))).toEqual([]);
  });

  it('opens four functions to the application role only, definers with a fixed search_path, owned like the functions of the agency upload', () => {
    const owner = grants(`agency_media_usage${USAGE}`).owner;
    for (const signature of OPEN) {
      expect(grants(signature), signature).toMatchObject({ app: true, public: false, definer: true, config: ['search_path=""'], owner });
    }
  });

  it('keeps the helpers closed: no grant to the application role or to PUBLIC, and a fixed search_path on every one that is a definer', () => {
    const owner = grants(`agency_media_usage${USAGE}`).owner;
    for (const signature of CLOSED) {
      expect(grants(signature), signature).toMatchObject({ app: false, public: false, config: ['search_path=""'], owner });
    }
    for (const signature of ['agency_storage_in_use', 'portal_upload_refusal', 'lock_own_pending_portal_upload', 'require_portal_material_request']) {
      expect(grants(CLOSED.find((closed) => closed.startsWith(signature))!).definer, signature).toBe(true);
    }
  });

  it('leaves the usage function as it was for who may call it', () => {
    expect(migrated.after.privileges.get(`function app_private.agency_media_usage${USAGE}`)).toBe(migrated.before.privileges.get(`function app_private.agency_media_usage${USAGE}`));
  });
});

describe('what the migration does to the objects of the catalog', () => {
  it('adds the two columns, the constraints, the index and the body of twelve functions, and removes nothing', () => {
    expect(addedKeys(migrated.before.structure, migrated.after.structure)).toEqual([
      ...[...OPEN, ...CLOSED].map((signature) => `body app_private.${signature}`),
      'column public.media_assets.material_request_thread_id',
      'column public.media_assets.uploaded_by_side',
      'constraint public.client_threads.client_threads_id_client_id_key',
      'constraint public.media_assets.media_assets_client_upload_shape',
      'constraint public.media_assets.media_assets_request_needs_client',
      'constraint public.media_assets.media_assets_request_thread_fk',
      'constraint public.media_assets.media_assets_uploaded_by_side_check',
      'index public.client_threads_id_client_id_key',
      'index public.media_assets_material_request_idx'
    ].sort());
    expect(removedKeys(migrated.before.structure, migrated.after.structure)).toEqual([]);
  });

  it('changes the text of one function that already existed, the usage of the agency, and no column, constraint, index or trigger', () => {
    expect(changedKeys(migrated.before.structure, migrated.after.structure)).toEqual([`body app_private.agency_media_usage${USAGE}`]);
  });

  it('adds a side that is never empty and is the agency\'s by default, and a request that may be empty', () => {
    expect(JSON.parse(migrated.after.structure.get('column public.media_assets.uploaded_by_side')!)).toBe("text | nullable NO | default 'agency'::text | generated NEVER");
    expect(JSON.parse(migrated.after.structure.get('column public.media_assets.material_request_thread_id')!)).toBe('uuid | nullable YES | default - | generated NEVER');
  });

  it('holds the side and the request together, in the client of the request, and the side to the two values', () => {
    const definition = (name: string) => JSON.parse(migrated.after.structure.get(`constraint public.media_assets.${name}`)!) as string;

    expect(definition('media_assets_client_upload_shape')).toBe("CHECK (((uploaded_by_side = 'client'::text) = (material_request_thread_id IS NOT NULL)))");
    expect(definition('media_assets_request_needs_client')).toBe('CHECK (((material_request_thread_id IS NULL) OR (client_id IS NOT NULL)))');
    expect(definition('media_assets_uploaded_by_side_check')).toBe("CHECK ((uploaded_by_side = ANY (ARRAY['agency'::text, 'client'::text])))");
    expect(definition('media_assets_request_thread_fk')).toBe('FOREIGN KEY (material_request_thread_id, client_id) REFERENCES client_threads(id, client_id)');
    expect(JSON.parse(migrated.after.structure.get('constraint public.client_threads.client_threads_id_client_id_key')!)).toBe('UNIQUE (id, client_id)');
  });

  it('gives the usage function the same permission check, now over the one function that counts', () => {
    const key = `body app_private.agency_media_usage${USAGE}`;
    const before = JSON.parse(migrated.before.structure.get(key)!) as string;
    const after = JSON.parse(migrated.after.structure.get(key)!) as string;

    expect(after).toContain("app_private.has_agency_permission(p_agency_id, 'midia.enviar')");
    expect(after).toContain("app_private.has_agency_permission(p_agency_id, 'conteudo.operar')");
    expect(after).toContain('app_private.agency_storage_in_use(p_agency_id, p_pending_window_seconds, p_exclude_asset_id)');
    expect(after).not.toContain('public.media_assets');
    // What the sum counts moved, unchanged, to the function the portal's functions call too.
    const counted = JSON.parse(migrated.after.structure.get(`body app_private.agency_storage_in_use${IN_USE}`)!) as string;
    for (const condition of ['asset.purged_at is null', "asset.status = 'confirmed'", "asset.status = 'pending'", 'asset.updated_at >= pg_catalog.now()']) {
      expect(before, condition).toContain(condition);
      expect(counted, condition).toContain(condition);
    }
  });
});

describe('what the migration does to the rows that exist', () => {
  it('rewrites none: the media of before keeps its row, is the agency\'s and has no request', async () => {
    const row = await migrated.scratch('media_assets').where({ id: seeded.asset }).first();

    expect(row).toMatchObject({ uploaded_by_side: 'agency', material_request_thread_id: null });
    expect((await migrated.scratch.raw<{ rows: Array<{ xmin: string }> }>('select xmin::text from public.media_assets where id = ?::uuid', [seeded.asset])).rows[0]!.xmin).toBe(seeded.xmin);
  });

  it('is forward only: it has no way back', async () => {
    const migration = await import(new URL(`../migrations/${THIS_MIGRATION}`, import.meta.url).href) as { down(): Promise<void> };

    await expect(migration.down()).rejects.toThrow('forward-only');
  });
});
