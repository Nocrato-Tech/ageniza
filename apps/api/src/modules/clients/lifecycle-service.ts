import { databaseErrorCode, raw } from '@ageniza/database';

import type { ClientTransaction } from './service.js';

/**
 * The contract's end, seen from the agency (specs/clientes.md sections 4 and 6; issue #131).
 *
 * `status`, `archived_at` and `closing_date` are out of every column grant of `ageniza_app`, so the
 * only writers are the `app_private` functions below. Each checks `cliente.arquivar` on the client's
 * own agency by itself; the route's guard is a second barrier and not the first. The daily job calls
 * `archive_due_clients`, which does what `archive_client` does for every client whose date passed.
 */

/** Codes the lifecycle functions raise (20261006000300): stable, so no message is ever parsed. */
const FUNCTION_REFUSED = 'A0020';
const NAME_IN_USE = 'A0021';
const CLOSING_DATE_IN_THE_PAST = 'A0022';

/** Not found, of another agency, or the caller lacks the permission: one code for all of them. */
export const isLifecycleFunctionRefusal = (error: unknown): boolean => databaseErrorCode(error) === FUNCTION_REFUSED;

export const isReactivationNameConflict = (error: unknown): boolean => databaseErrorCode(error) === NAME_IN_USE;

export const isClosingDateInThePast = (error: unknown): boolean => databaseErrorCode(error) === CLOSING_DATE_IN_THE_PAST;

/** Schedules the closing date, or clears it with `null`. Valid only for an active client. */
export const setClientClosingDate = async (
  transaction: ClientTransaction,
  clientId: string,
  closingDate: string | null
): Promise<void> => {
  await raw(transaction, 'select app_private.set_client_closing_date(?::uuid, ?::date)', [clientId, closingDate]);
};

/** Archives now: portal closed, pending portal invitations revoked, links kept, audited. */
export const archiveClient = async (transaction: ClientTransaction, clientId: string): Promise<void> => {
  await raw(transaction, 'select app_private.archive_client(?::uuid)', [clientId]);
};

/** Brings an archived client back; refused when an active client already uses the name. */
export const reactivateClient = async (transaction: ClientTransaction, clientId: string): Promise<void> => {
  await raw(transaction, 'select app_private.reactivate_client(?::uuid)', [clientId]);
};
