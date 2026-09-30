import { raw, type DatabaseClient } from '@ageniza/database';

type ProfileTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface OwnProfile {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
}

/**
 * Reads the session user's own name and photo reference. `auth."user"` has no RLS -- the schema is
 * Better Auth's and the CI gate only enforces row level security on `public` -- so every statement
 * in this module targets the verified session user id and nothing else. There is no second barrier
 * in the database; the caller passing the session id is the whole of the isolation.
 */
export const loadOwnProfile = async (transaction: ProfileTransaction, userId: string): Promise<OwnProfile | undefined> => {
  const result = await raw<RawRows<OwnProfile>>(transaction, `
    select id, name, image
    from auth."user"
    where id = ?::uuid
  `, [userId]);
  return result.rows[0];
};

/**
 * Updates the session user's display name and returns the new row. The `where` clause carries the
 * session user id, which is the primary key, so this affects exactly one row (or none, if the
 * account vanished between the session check and this write).
 */
export const updateOwnName = async (
  transaction: ProfileTransaction,
  userId: string,
  name: string
): Promise<{ id: string; name: string } | undefined> => {
  const result = await raw<RawRows<{ id: string; name: string }>>(transaction, `
    update auth."user"
    set name = ?, "updatedAt" = now()
    where id = ?::uuid
    returning id, name
  `, [name, userId]);
  return result.rows[0];
};

/**
 * Points the session user's `image` at a new object key. The `where` clause carries the session
 * user id; the returned row count is checked so a write that silently matched nothing cannot pass
 * as success.
 */
export const updateOwnImage = async (transaction: ProfileTransaction, userId: string, image: string): Promise<void> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update auth."user"
    set image = ?, "updatedAt" = now()
    where id = ?::uuid
    returning id
  `, [image, userId]);
  if (result.rows.length !== 1) throw new Error('The authenticated user no longer exists.');
};
