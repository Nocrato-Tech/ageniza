import { captureUnexpectedError } from '@ageniza/core';
import type { Pool } from 'pg';

/** The minimal logger shape `recordAuthAuditEventSafely` needs: satisfied by both `CoreLogger`
 * (pino) and Fastify's own per-request `FastifyBaseLogger`, which are not otherwise assignable
 * to each other. */
export interface AuditFailureLogger {
  error(payload: Record<string, unknown>, message: string): void;
}

/** The only two audit actions this slice writes; the 20B slice adds its own. */
export type AuthAuditAction = 'auth.password_reset' | 'auth.logout_all';

export interface AuthAuditEvent {
  readonly action: AuthAuditAction;
  /** The user who triggered the event, when known. */
  readonly actorUserId?: string;
  /**
   * Null when no request id is available for this event (e.g. no Fastify request is in scope).
   * The event is still recorded with a null `request_id` rather than silently skipped (B9).
   */
  readonly requestId: string | null;
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

/**
 * The single auditing policy for the auth module (B9): auditing never undoes or blocks an action
 * that already completed. A write failure here is logged (`error`, no sensitive data) and
 * captured in Sentry; the caller always proceeds as if the audit call had succeeded.
 */
export const recordAuthAuditEventSafely = async (
  recorder: AuthAuditRecorder,
  event: AuthAuditEvent,
  logger: AuditFailureLogger
): Promise<void> => {
  try {
    await recorder.record(event);
  } catch (error) {
    logger.error({
      operation: 'auth.audit_write',
      status: 'failed',
      action: event.action,
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'AUDIT_WRITE_FAILED' }
    }, `Failed to record the ${event.action} audit event`);
    captureUnexpectedError(error, { operation: 'auth.audit_write', action: event.action });
  }
};
