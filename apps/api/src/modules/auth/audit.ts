import type { Pool } from 'pg';

/** The only two audit actions this slice writes; the 20B slice adds its own. */
export type AuthAuditAction = 'auth.password_reset' | 'auth.logout_all';

export interface AuthAuditEvent {
  readonly action: AuthAuditAction;
  /** The user who triggered the event, when known. */
  readonly actorUserId?: string;
  readonly requestId: string;
}

export interface AuthAuditRecorder {
  record(event: AuthAuditEvent): Promise<void>;
}

/**
 * Appends to `audit.events`. The pool must use the application role, which the migration grants
 * only `insert` on this table: there is no read, update, or delete path here, by design.
 *
 * Never pass a token, password, cookie, or full e-mail address into `event`: this table is
 * append-only and readable by future tooling, so it only ever carries identifiers.
 */
export const createAuthAuditRecorder = (pool: Pool): AuthAuditRecorder => ({
  async record(event): Promise<void> {
    await pool.query(
      'insert into audit.events (action, actor_user_id, request_id) values ($1, $2, $3)',
      [event.action, event.actorUserId ?? null, event.requestId]
    );
  }
});
