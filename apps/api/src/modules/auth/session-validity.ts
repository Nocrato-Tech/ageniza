/**
 * Which sessions still count, written once and read by every statement that says so: the guard, the list, the end of one session
 * and the count of the ones ended. Each fragment names `"session"`, so it goes in a statement over `auth."session"` (with no alias or
 * the alias `"session"`).
 *
 * A session made at or before the last time the credential of the account was replaced (a reset, Google taking the account over)
 * is not the person's, even if its row survived the deletion that came with the replacement (issue #719). The date is the greater of
 * the user's and the credential's own, because the reset stamps the latter in its own statement.
 */
export const SESSION_AFTER_CREDENTIAL_SQL = `"session"."createdAt" > greatest(
  coalesce((select person."passwordChangedAt" from auth."user" person where person.id = "session"."userId"), '-infinity'::timestamptz),
  coalesce((select max(credential."passwordChangedAt") from auth."account" credential where credential."userId" = "session"."userId"), '-infinity'::timestamptz)
)`;

/** What makes a session active: Better Auth refuses (and deletes) the one past its `expiresAt` on its next use, and the guard the one above. */
export const ACTIVE_SESSION_SQL = `("session"."expiresAt" > now() and ${SESSION_AFTER_CREDENTIAL_SQL})`;
