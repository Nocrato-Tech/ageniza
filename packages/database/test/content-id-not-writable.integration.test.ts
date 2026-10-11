import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

// Issue #580. `id` is never writable by the application role: a caller that picks the key of its own row can collide with or squat
// a key that something else derives from. The tables of Conteúdo took `id` out of their column-level INSERT grant; the catalog test
// reads the live grants of the whole schema, so a table (new or old) that accepts an `id` again is red unless it is on the list of
// exceptions below, and each exception is on it with its reason and the issue that retires it. The numbers of the columns left are
// written out, so nothing else moves with the revoke.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await application?.close();
  await owner?.close();
});

/** Where the code still names the id on INSERT: not allowed to grow, and retired one by one by issue #601. */
const ID_EXCEPTIONS: Readonly<Record<string, string>> = {
  media_assets: '#601: the API makes the id first, because the object keys are built with it and cannot be updated',
  client_threads: '#601: the conversation service and the demo seed name the id of the thread',
  client_thread_comments: '#601: the demo seed names the id of the comment',
  clients: '#601: the demo seed names the id of the client',
  client_personas: '#601: the demo seed names the id of the persona'
};

/** The tables of Conteúdo that have, or had, an `id` to take away; the first five are the ones this issue revoked. */
const REVOKED_TABLES = ['contents', 'content_tasks', 'story_scripts', 'story_script_scenes', 'media_folders'] as const;

/** What a route writes on INSERT, column by column: the revoke takes `id` out and nothing else. */
const INSERT_COLUMNS: Readonly<Record<(typeof REVOKED_TABLES)[number], readonly string[]>> = {
  contents: ['caption', 'client_id', 'cover_asset_id', 'folder_id', 'format', 'owner_user_id', 'platform', 'publish_at_time', 'publish_on', 'title'],
  content_tasks: ['assignee_user_id', 'client_id', 'content_id', 'description', 'due_on', 'title'],
  story_scripts: ['client_id', 'script_on'],
  story_script_scenes: ['client_id', 'guidance', 'position', 'script_id', 'text'],
  media_folders: ['client_id', 'name', 'parent_id']
};

const tablesAcceptingId = async (): Promise<string[]> => {
  const { rows } = await raw<{ rows: readonly { name: string }[] }>(getOwner().knex, `
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and pg_catalog.has_column_privilege('ageniza_app', c.oid, a.attnum, 'INSERT')
    order by 1
  `, []);
  return rows.map((row) => row.name);
};

const insertColumns = async (table: string): Promise<string[]> => {
  const { rows } = await raw<{ rows: readonly { name: string }[] }>(getOwner().knex, `
    select a.attname as name
    from pg_catalog.pg_attribute a
    where a.attrelid = ?::regclass and a.attnum > 0 and not a.attisdropped
      and pg_catalog.has_column_privilege('ageniza_app', a.attrelid, a.attnum, 'INSERT')
    order by 1
  `, [`public.${table}`]);
  return rows.map((row) => row.name);
};

const asApplication = async (statement: string): Promise<unknown> => {
  const transaction = await getApplication().knex.transaction();
  try {
    await transaction.raw(statement);
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    await transaction.rollback();
  }
};

describe('no table of public accepts a chosen id on INSERT, but the listed exceptions (issue #580)', () => {
  it('has exactly the exceptions on the list: a table that accepts an id again turns this red, and so does an exception that was fixed and not removed', async () => {
    expect(await tablesAcceptingId()).toEqual(Object.keys(ID_EXCEPTIONS).sort());
  });

  it.each(Object.entries(ID_EXCEPTIONS))('%s is a listed exception with its reason and the issue that retires it', (_table, reason) => {
    expect(reason).toMatch(/^#601: .{20,}/);
  });

  it('leaves two tables of the module out of the list for a reason of their own: content_media has no id and notification_queue has no INSERT for the role', async () => {
    const { rows } = await raw<{ rows: readonly { has_id: boolean }[] }>(getOwner().knex, `
      select exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.content_media'::regclass and attname = 'id' and not attisdropped) as has_id
    `, []);
    expect(rows[0]!.has_id).toBe(false);
    expect(await insertColumns('notification_queue')).toEqual([]);
  });
});

describe('the five tables of Conteúdo that no code names an id for (issue #580)', () => {
  it.each(REVOKED_TABLES)('%s: INSERT is the columns the routes write, and `id` is not one of them', async (table) => {
    expect(await insertColumns(table)).toEqual(INSERT_COLUMNS[table]);
  });

  it.each(REVOKED_TABLES)('%s: an INSERT that chooses the id is refused by the privilege (42501), not by a policy', async (table) => {
    const error = await asApplication(`insert into public.${table} (id) values (gen_random_uuid())`);
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(new RegExp(`permission denied for table ${table}`)) });
  });

  it.each(REVOKED_TABLES)('%s: an INSERT with no id still reaches the policy, which is what the routes do', async (table) => {
    const columns = INSERT_COLUMNS[table];
    const error = await asApplication(`insert into public.${table} (${columns[0]!}) values (null)`);
    // Past the privilege the statement is judged by the table: the policy or a constraint, never "permission denied".
    expect(error).not.toMatchObject({ message: expect.stringMatching(/permission denied/) });
  });

  it.each(REVOKED_TABLES)('%s: the default of the id stays, so a row made with no id still gets one', async (table) => {
    const { rows } = await raw<{ rows: readonly { column_default: string | null }[] }>(getOwner().knex, `
      select column_default from information_schema.columns where table_schema = 'public' and table_name = ? and column_name = 'id'
    `, [table]);
    expect(rows[0]?.column_default).toMatch(/gen_random_uuid\(\)/);
  });

  it.each(REVOKED_TABLES)('%s: the application role keeps reading the id', async (table) => {
    const { rows } = await raw<{ rows: readonly { can: boolean }[] }>(getOwner().knex, `
      select pg_catalog.has_column_privilege('ageniza_app', ?::regclass, 'id', 'select') as can
    `, [`public.${table}`]);
    expect(rows[0]!.can).toBe(true);
  });
});
