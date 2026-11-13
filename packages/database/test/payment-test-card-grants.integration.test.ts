import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addedKeys, changedKeys, migrateAcross, removedKeys, type MigratedAcross, type Snapshot } from './support/catalog-snapshot.js';

// Scope redesign-igual, subtask W5-S1 (acceptance b). A whole-table grant hides from a per-column reading, so the catalog is read both ways, for the
// application role and for PUBLIC, before and after the migration of the test card: the migration may add its own objects and must change the
// grant, the policy, the RLS flag or the owner of nothing that already existed.
const THIS_MIGRATION = '20261112000300_payment_test_card.mjs';

let migrated: MigratedAcross;
let before: Snapshot;
let after: Snapshot;

beforeAll(async () => {
  migrated = await migrateAcross(THIS_MIGRATION, 'cardgrants', async (scratch) => {
    expect(await scratch.schema.hasTable('agency_test_cards')).toBe(false);
  });
  before = migrated.before.privileges;
  after = migrated.after.privileges;
}, 300_000);

afterAll(async () => {
  await migrated?.cleanUp();
});

describe('what the migration of the test card does to the privileges of the catalog', () => {
  it('has a snapshot worth comparing: the tables and the functions of the schemas, and their defaults', () => {
    expect(before.size).toBeGreaterThan(100);
    expect(before.get('table public.subscription_charges')).toContain('"SELECT":true');
    expect(before.get('function app_private.quote_subscription_change(p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer)')).toContain('"app":true');
  });

  it('adds one table and three functions, and no other object', () => {
    expect(addedKeys(before, after)).toEqual([
      'function app_private.period_days_left(p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_at timestamp with time zone)',
      'function app_private.period_length_days(p_period_start timestamp with time zone, p_period_end timestamp with time zone)',
      'function app_private.save_agency_test_card(p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text)',
      'table public.agency_test_cards'
    ]);
    expect(removedKeys(before, after)).toEqual([]);
  });

  it('changes no grant, no policy, no RLS flag, no owner and no default privilege of what already existed', () => {
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('gives the new table to the application role as a SELECT of five columns and nothing else, and nothing to PUBLIC', () => {
    const table = JSON.parse(after.get('table public.agency_test_cards')!) as {
      rls: boolean[]; app: Record<string, boolean>; public: Record<string, boolean>; columns: Record<string, Record<string, boolean>>; policies: unknown[][];
    };
    expect(table.rls).toEqual([true, true]);
    expect(Object.values(table.app).filter(Boolean)).toEqual([]);
    expect(Object.values(table.public).filter(Boolean)).toEqual([]);
    expect(Object.entries(table.columns).filter(([, privileges]) => privileges.SELECT).map(([name]) => name).sort()).toEqual(['agency_id', 'brand', 'exp_month', 'exp_year', 'last4']);
    expect(Object.entries(table.columns).filter(([, privileges]) => privileges.INSERT || privileges.UPDATE || privileges.REFERENCES)).toEqual([]);
    expect(table.policies.map((policy) => [policy[0], policy[1]])).toEqual([['agency_test_cards_select', 'r']]);
    expect(table.policies[0]![3]).toContain("'assinatura.gerenciar'");
  });

  it('opens the writer to the application role only, and the two helpers to nobody', () => {
    const grants = (signature: string) => JSON.parse(after.get(`function ${signature}`)!) as { app: boolean; public: boolean; definer: boolean; config: string[] | null };
    expect(grants('app_private.save_agency_test_card(p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text)'))
      .toEqual({ app: true, public: false, definer: true, config: ['search_path=""'], owner: expect.any(String) });
    for (const helper of [
      'app_private.period_days_left(p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_at timestamp with time zone)',
      'app_private.period_length_days(p_period_start timestamp with time zone, p_period_end timestamp with time zone)'
    ]) {
      expect(grants(helper)).toMatchObject({ app: false, public: false });
    }
  });
});
