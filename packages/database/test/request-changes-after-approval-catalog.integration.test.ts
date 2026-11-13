import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addedKeys, changedKeys, migrateAcross, removedKeys, type MigratedAcross } from './support/catalog-snapshot.js';

// Scope redesign-igual, subtask W11-S1 (acceptance: the catalog before and after the migration that lets the client ask for changes in an
// approved content). The migration may add one function and replace the bodies of three: it must change the grant, the policy, the RLS flag,
// the owner, the security mode or the search path of nothing, and no table, column, constraint, index or trigger.
const THIS_MIGRATION = '20261113000200_request_changes_after_approval.mjs';
const HELPER = '(p_status text, p_publish_on date)';
const REQUEST = '(p_content_id uuid, p_revision integer, p_body text)';
const LINK = '(p_session_hash text, p_content_id uuid, p_revision integer, p_body text)';

let migrated: MigratedAcross;

beforeAll(async () => {
  migrated = await migrateAcross(THIS_MIGRATION, 'changesapproved', async (scratch) => {
    const { rows } = await scratch.raw<{ rows: Array<{ found: boolean }> }>(`select exists (select 1 from pg_catalog.pg_proc where proname = 'content_accepts_changes_request') as found`);
    expect(rows[0]!.found).toBe(false);
  });
}, 300_000);

afterAll(async () => {
  await migrated?.cleanUp();
});

interface FunctionGrants { app: boolean; public: boolean; definer: boolean; config: string[]; owner: string }
const grantsOf = (key: string): FunctionGrants => JSON.parse(migrated.after.privileges.get(key)!) as FunctionGrants;
const bodyOf = (snapshot: 'before' | 'after', key: string): string => JSON.parse(migrated[snapshot].structure.get(key)!) as string;

describe('what the migration does to the privileges of the catalog', () => {
  it('has a snapshot worth comparing: the tables and the functions of the schemas, and their defaults', () => {
    expect(migrated.before.privileges.size).toBeGreaterThan(100);
    expect(migrated.before.privileges.get('table public.contents')).toContain('"SELECT":true');
    expect(migrated.before.privileges.get(`function app_private.request_content_changes${REQUEST}`)).toContain('"app":true');
  });

  it('adds one function and no other object, and removes nothing', () => {
    expect(addedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([`function app_private.content_accepts_changes_request${HELPER}`]);
    expect(removedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([]);
  });

  it('changes the privileges, the policies, the owner and the security mode of nothing that already existed: no table, no function, no default', () => {
    expect(changedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([]);
  });

  it('closes the helper to PUBLIC and to the application role, which reaches it only through the two functions that run as the owner of the schema', () => {
    const helper = grantsOf(`function app_private.content_accepts_changes_request${HELPER}`);
    expect(helper).toMatchObject({ app: false, public: false, definer: false, config: ['search_path=""'] });
  });

  it('keeps the two functions that ask the helper open to the application role only, definers with a fixed search_path and the same owner', () => {
    const request = grantsOf(`function app_private.request_content_changes${REQUEST}`);
    const link = grantsOf(`function app_private.request_changes_by_portal_approval${LINK}`);
    expect(request).toMatchObject({ app: true, public: false, definer: true, config: ['search_path=""'] });
    expect(link).toMatchObject({ app: true, public: false, definer: true, config: ['search_path=""'] });
    expect(link.owner).toBe(request.owner);
  });

  it('reads the clock when it is called: the helper is volatile', async () => {
    const { rows } = await migrated.scratch.raw<{ rows: Array<{ provolatile: string }> }>(
      `select provolatile from pg_catalog.pg_proc where proname = 'content_accepts_changes_request'`
    );
    expect(rows).toEqual([{ provolatile: 'v' }]);
  });
});

describe('what the migration does to the objects of the catalog', () => {
  it('adds the body of the helper, and no column, constraint, index or trigger, and removes nothing', () => {
    expect(addedKeys(migrated.before.structure, migrated.after.structure)).toEqual([`body app_private.content_accepts_changes_request${HELPER}`]);
    expect(removedKeys(migrated.before.structure, migrated.after.structure)).toEqual([]);
  });

  it('changes the text of three functions that already existed, the guard of the contents and the two that ask for changes, and nothing else', () => {
    expect(changedKeys(migrated.before.structure, migrated.after.structure)).toEqual([
      'body app_private.contents_guard()',
      `body app_private.request_changes_by_portal_approval${LINK}`,
      `body app_private.request_content_changes${REQUEST}`
    ]);
  });

  it('gives the guard its old body plus one transition, approved to adjusting, and the clearing of the approval when it enters "adjusting"', () => {
    const key = 'body app_private.contents_guard()';
    const before = bodyOf('before', key);
    const after = bodyOf('after', key);
    expect(after).not.toBe(before);
    const restored = after
      .replace("('awaiting_approval', 'adjusting'), ('approved', 'adjusting'),", "('awaiting_approval', 'adjusting'),")
      .replace("if new.status in ('awaiting_approval', 'adjusting') then", "if new.status = 'awaiting_approval' then");
    expect(restored).toBe(before);
    expect(after.split("('approved', 'adjusting')")).toHaveLength(2);
  });

  it.each([
    ['request_content_changes', REQUEST],
    ['request_changes_by_portal_approval', LINK]
  ])('gives %s its old body, with the planned day read from the locked row and the one test of the helper in the place of the state test, and nothing else', (name, signature) => {
    const key = `body app_private.${name}${signature}`;
    const before = bodyOf('before', key);
    const after = bodyOf('after', key);
    expect(after).not.toBe(before);
    const restored = after
      .replace(/\n[ \t]+v_publish_on date;/, '')
      .replace(/\n[ \t]+-- The state and the planned day are read from the locked row[^\n]*/, '')
      .replace('content.status, content.revision, content.publish_on into v_status, v_revision, v_publish_on', 'content.status, content.revision into v_status, v_revision')
      .replace('if not app_private.content_accepts_changes_request(v_status, v_publish_on) then', "if v_status <> 'awaiting_approval' then")
      .replace('Only a content awaiting approval, or an approved one planned for after today, gets a request for changes.', 'Only a content awaiting approval gets a request for changes.');
    expect(restored).toBe(before);
  });

  it('writes the helper as one test of the state and the day: awaiting approval, or approved with a planned day after today of São Paulo, at the clock of the call', () => {
    const body = bodyOf('after', `body app_private.content_accepts_changes_request${HELPER}`).replace(/\s+/g, ' ').trim();
    expect(body).toBe(
      "select p_status = 'awaiting_approval' or (p_status = 'approved' and p_publish_on > app_private.sao_paulo_date(pg_catalog.clock_timestamp()))"
    );
  });
});
