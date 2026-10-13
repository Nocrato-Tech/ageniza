import type { DatabaseClient } from '@ageniza/database';

/**
 * Takes `INSERT (id)` on `tables` away from `ageniza_app` for the length of a suite, so a statement that still chooses an id
 * is refused by the database (issue #601), and returns what puts each table back as it was found: a database that already
 * revoked the column (#580) stays revoked, and one that did not gets it back. The revocation is checked, so a table-wide
 * grant, which a column `REVOKE` does not remove, fails the suite instead of letting it pass without proving anything.
 * The integration files run one at a time against one database, so no other file sees the gap.
 */
export const revokeInsertId = async (owner: DatabaseClient, tables: readonly string[]): Promise<() => Promise<void>> => {
  const canInsertId = async (table: string): Promise<boolean> => {
    const result = await owner.knex.raw<{ rows: { allowed: boolean }[] }>(
      `select has_column_privilege('ageniza_app', ?::regclass, 'id', 'INSERT') as allowed`,
      [`public.${table}`]
    );
    return result.rows[0]?.allowed === true;
  };

  const before = new Map<string, boolean>();
  for (const table of tables) before.set(table, await canInsertId(table));
  const restore = async (): Promise<void> => {
    for (const table of tables) {
      if (before.get(table) === true) await owner.knex.raw(`grant insert (id) on public.${table} to ageniza_app`);
    }
  };

  try {
    for (const table of tables) {
      await owner.knex.raw(`revoke insert (id) on public.${table} from ageniza_app`);
      if (await canInsertId(table)) throw new Error(`ageniza_app can still insert the id of ${table} after the REVOKE: a table-wide grant stands.`);
    }
  } catch (failure) {
    await restore();
    throw failure;
  }
  return restore;
};
