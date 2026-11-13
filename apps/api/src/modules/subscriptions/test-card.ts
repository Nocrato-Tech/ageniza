import type { SaveSubscriptionTestCardRequest, SubscriptionTestCard } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { SubscriptionTransaction } from './service.js';

interface CardRow {
  readonly last4: string;
  readonly exp_month: number;
  readonly exp_year: number;
  readonly brand: 'test';
}

const cardFromRow = (row: CardRow): SubscriptionTestCard => ({ last4: row.last4, expMonth: row.exp_month, expYear: row.exp_year, brand: row.brand });

/** Under the policy of the table: only the Owner of the agency sees the row. */
export const loadTestCard = async (transaction: SubscriptionTransaction, agencyId: string): Promise<SubscriptionTestCard | null> => {
  const result = await raw<{ rows: readonly CardRow[] }>(
    transaction, 'select agency_id, last4, exp_month, exp_year, brand from public.agency_test_cards where agency_id = ?', [agencyId]
  );
  const row = result.rows[0];
  return row === undefined ? null : cardFromRow(row);
};

/** One card per agency: saving replaces it. The database audits the save, without the digits. */
export const saveTestCard = async (transaction: SubscriptionTransaction, agencyId: string, card: SaveSubscriptionTestCardRequest): Promise<SubscriptionTestCard> => {
  const result = await raw<{ rows: readonly CardRow[] }>(
    transaction,
    'select * from app_private.save_agency_test_card(?::uuid, ?, ?::integer, ?::integer, ?)',
    [agencyId, card.last4, card.expMonth, card.expYear, card.brand]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The test card was saved without a row to show.');
  return cardFromRow(row);
};
