import { describe, expect, it } from 'vitest';

import { evaluate, recordsDecision, structuralReasons } from './verify-structural-decisions.mjs';

const NEW_TABLE_MIGRATION = `
  create table public.widgets (id uuid primary key, agency_id uuid not null);
  alter table public.widgets enable row level security;
  create policy widgets_select on public.widgets for select to ageniza_app using (true);
  grant select on public.widgets to ageniza_app;
`;

describe('structural migration detection', () => {
  it('does not flag a migration that only creates new objects', () => {
    // A new table enables RLS on itself, which must not be mistaken for touching what exists.
    expect(structuralReasons('create table public.widgets (id uuid primary key);')).toEqual([]);
    expect(structuralReasons('create policy p on public.widgets for select to ageniza_app using (true);')).toEqual([]);
    expect(structuralReasons('grant select on public.widgets to ageniza_app;')).toEqual([]);
  });

  it('flags SQL that reaches something already deployed', () => {
    expect(structuralReasons('alter table public.agencies add constraint c check (true);')).toContain('alters an existing table');
    expect(structuralReasons('drop policy invitations_update on public.invitations;')).toContain('replaces an existing RLS policy');
    expect(structuralReasons('revoke update on public.invitations from ageniza_app;')).toContain('revokes a privilege');
    expect(structuralReasons('drop function app_private.is_agency_member(uuid);')).toContain('replaces an existing function');
  });

  it('ignores the keywords when they appear only in a comment', () => {
    expect(structuralReasons('-- alter table public.agencies would be structural\ncreate table public.widgets (id uuid);')).toEqual([]);
  });
});

describe('gate', () => {
  const migration = (sql) => [{ file: 'packages/database/migrations/20260926000000_change.mjs', sql }];

  it('passes a change with no structural migration', () => {
    expect(evaluate(migration(NEW_TABLE_MIGRATION), ['apps/api/src/modules/widgets/routes.ts'])).toMatchObject({
      structural: [], satisfied: true
    });
  });

  it('fails a structural migration that records no decision', () => {
    const result = evaluate(migration('alter table public.agencies add column nickname text;'), ['packages/database/migrations/20260926000000_change.mjs']);
    expect(result.satisfied).toBe(false);
    expect(result.structural[0]?.reasons).toContain('alters an existing table');
  });

  it('passes a structural migration recorded alongside it', () => {
    expect(evaluate(
      migration('alter table public.agencies add column nickname text;'),
      ['packages/database/migrations/20260926000000_change.mjs', 'docs/business/decisions.md']
    )).toMatchObject({ satisfied: true });
  });

  it('recognises the decisions file by its exact path', () => {
    expect(recordsDecision(['docs/business/decisions.md'])).toBe(true);
    expect(recordsDecision(['docs/business/structural-changes.md'])).toBe(false);
  });

  it('recognises a decision recorded in a file of its own, and nothing else under that name', () => {
    expect(recordsDecision(['docs/business/decisions/2026-10-07-autor-do-comentario.md'])).toBe(true);
    expect(recordsDecision(['docs/business/decisions/notes.txt'])).toBe(false);
    expect(recordsDecision(['docs/business/decisions-old/2026-10-07-x.md'])).toBe(false);
    expect(evaluate(
      migration('revoke all on function app_private.x() from public;'),
      ['packages/database/migrations/20261007000800_change.mjs', 'docs/business/decisions/2026-10-07-x.md']
    )).toMatchObject({ satisfied: true });
    expect(evaluate(
      migration('revoke all on function app_private.x() from public;'),
      ['packages/database/migrations/20261007000800_change.mjs']
    )).toMatchObject({ satisfied: false });
  });
});

describe('new table that alters only itself', () => {
  it('does not count enabling RLS on a table the same migration creates', () => {
    expect(structuralReasons(NEW_TABLE_MIGRATION)).toEqual([]);
  });

  it('still counts altering a table created elsewhere', () => {
    expect(structuralReasons(`${NEW_TABLE_MIGRATION}\nalter table public.agencies add column nickname text;`))
      .toContain('alters an existing table');
  });
});
