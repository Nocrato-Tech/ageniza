import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addedKeys, changedKeys, migrateAcross, removedKeys, type MigratedAcross } from './support/catalog-snapshot.js';

// Scope redesign-igual, subtask W5-S1c1 (acceptance g): the catalog before and after the migration that lets a charge record a declined payment.
// The migration may add one column, one constraint and one function, and replace the body of the function that confirms a charge: it must change
// the grant, the policy, the RLS flag, the owner or the text of nothing else.
const THIS_MIGRATION = '20261112000301_subscription_charge_declined.mjs';
const DECLINE = '(p_agency_id uuid, p_charge_id uuid)';
const CONFIRM = '(p_charge_id uuid, p_provider text, p_provider_ref text, p_charged_cents integer)';

let migrated: MigratedAcross;

beforeAll(async () => {
  migrated = await migrateAcross(THIS_MIGRATION, 'chargedeclined', async (scratch) => {
    expect(await scratch.schema.hasColumn('subscription_charges', 'declined_at')).toBe(false);
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

describe('what the migration does to the privileges of the catalog', () => {
  it('has a snapshot worth comparing: the tables and the functions of the schemas, and their defaults', () => {
    expect(migrated.before.privileges.size).toBeGreaterThan(100);
    expect(migrated.before.privileges.get('table public.subscription_charges')).toContain('"SELECT":true');
    expect(migrated.before.privileges.get(`function app_private.confirm_subscription_charge${CONFIRM}`)).toContain('"app":true');
  });

  it('adds one function and no other object, and removes nothing', () => {
    expect(addedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([`function app_private.decline_subscription_charge${DECLINE}`]);
    expect(removedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual([]);
  });

  it('changes the privileges of one object that already existed, the table of the charges, and of nothing else: not the functions, not the defaults', () => {
    expect(changedKeys(migrated.before.privileges, migrated.after.privileges)).toEqual(['table public.subscription_charges']);
  });

  it('changes that table by one column the application role can only read, and by no table grant, policy, RLS flag or owner', () => {
    const before = JSON.parse(migrated.before.privileges.get('table public.subscription_charges')!) as TableSnapshot;
    const after = JSON.parse(migrated.after.privileges.get('table public.subscription_charges')!) as TableSnapshot;
    expect(after.columns.declined_at).toEqual({ SELECT: true, INSERT: false, UPDATE: false, REFERENCES: false });
    const { declined_at: added, ...others } = after.columns;
    expect(added).toBeDefined();
    expect(others).toEqual(before.columns);
    // Nothing is granted to PUBLIC on the column either, and what PUBLIC had on the other columns stays.
    const { declined_at: addedForPublic, ...othersForPublic } = after.public_columns;
    expect(Object.values(addedForPublic!).filter(Boolean)).toEqual([]);
    expect(othersForPublic).toEqual(before.public_columns);
    expect({ ...after, columns: null, public_columns: null }).toEqual({ ...before, columns: null, public_columns: null });
    expect(after.rls).toEqual([true, true]);
    expect(Object.values(after.app).filter(Boolean)).toEqual([]);
    expect(Object.values(after.public).filter(Boolean)).toEqual([]);
    expect(after.policies.map((policy) => [policy[0], policy[1]])).toEqual([['subscription_charges_select', 'r']]);
  });

  it('opens the new function to the application role only, a definer with a fixed search_path, owned like the function that confirms', () => {
    const grants = (signature: string) => JSON.parse(migrated.after.privileges.get(`function ${signature}`)!) as { app: boolean; public: boolean; definer: boolean; config: string[]; owner: string };
    const decline = grants(`app_private.decline_subscription_charge${DECLINE}`);
    expect(decline).toMatchObject({ app: true, public: false, definer: true, config: ['search_path=""'] });
    expect(decline.owner).toBe(grants(`app_private.confirm_subscription_charge${CONFIRM}`).owner);
  });
});

describe('what the migration does to the objects of the catalog', () => {
  it('adds the column, the constraint and the body of the new function, and removes nothing', () => {
    expect(addedKeys(migrated.before.structure, migrated.after.structure)).toEqual([
      `body app_private.decline_subscription_charge${DECLINE}`,
      'column public.subscription_charges.declined_at',
      'constraint public.subscription_charges.subscription_charges_declined_check'
    ]);
    expect(removedKeys(migrated.before.structure, migrated.after.structure)).toEqual([]);
  });

  it('changes the text of one function that already existed, the one that confirms a charge, and no column, constraint, index or trigger', () => {
    expect(changedKeys(migrated.before.structure, migrated.after.structure)).toEqual([`body app_private.confirm_subscription_charge${CONFIRM}`]);
  });

  it('adds a column that holds an instant, may be empty and has no default, and a constraint that keeps a confirmed charge from carrying it', () => {
    expect(JSON.parse(migrated.after.structure.get('column public.subscription_charges.declined_at')!)).toBe('timestamp with time zone | nullable YES | default - | generated NEVER');
    const definition = JSON.parse(migrated.after.structure.get('constraint public.subscription_charges.subscription_charges_declined_check')!) as string;
    expect(definition).toContain('CHECK');
    expect(definition).toContain('declined_at IS NULL');
    expect(definition).toContain("status <> 'confirmed'::text");
  });

  it('gives the function that confirms its old body plus one condition, the refusal of a declined charge, and nothing else', () => {
    const key = `body app_private.confirm_subscription_charge${CONFIRM}`;
    const before = JSON.parse(migrated.before.structure.get(key)!) as string;
    const after = JSON.parse(migrated.after.structure.get(key)!) as string;
    expect(after).not.toBe(before);
    expect(after.replace(' or v_charge.declined_at is not null', '')).toBe(before);
    expect(after.split('v_charge.declined_at')).toHaveLength(2);
  });
});
