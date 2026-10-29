import { databaseErrorCode, isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';
import type { PaymentProvider } from '@ageniza/payments';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const RENEW_SUBSCRIPTIONS_JOB_NAME = 'subscriptions.renew-due';

/**
 * Every five minutes, and at every start of the worker. The database lists a subscription a day before its period ends, so a renewal
 * is charged in the day before; the five minutes only bound how long a declined card, or a worker that was down, waits to be tried
 * again. The job is idempotent: a subscription already renewed is not listed again.
 */
export const RENEW_SUBSCRIPTIONS_SCHEDULE = { cron: '*/5 * * * *', timeZone: 'America/Sao_Paulo' } as const;

/** Agencies one run takes, the ceiling `agencies_due_for_renewal` accepts. The rest wait for the next run. */
export const RENEW_SUBSCRIPTIONS_PER_RUN = 500;

/** Times one renewal is confirmed again after losing a race with another change of the same agency (40001 or 40P01). */
export const CONFIRMATION_ATTEMPTS = 3;

/** Charges per agency in one run: the second is the one after the amount changed under the first, which was refunded. */
const ROUNDS_PER_AGENCY = 2;

export interface RenewSubscriptionsJobDependencies {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  /** What the simulated provider answers to every renewal; absent, it approves. A real provider ignores it. */
  readonly simulatedOutcome?: 'approved' | 'declined';
}

interface Quote {
  readonly periodEnd: Date;
  readonly amountCents: number;
  readonly provider: string;
}

type Outcome = 'renewed' | 'already_renewed' | 'declined' | 'not_due' | 'other_provider' | 'refunded' | 'refund_failed' | 'left_for_next_run';

const asUuid = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('agencies_due_for_renewal() did not return agency ids.');
  return value;
};

const readQuote = async (database: DatabaseClient, agencyId: string): Promise<Quote | undefined> => {
  const result = await raw<{ rows: ReadonlyArray<{ period_end: unknown; amount_cents: unknown; provider: unknown }> }>(
    database.knex,
    'select period_end, amount_cents, provider from app_private.renewal_quote(?::uuid)',
    [agencyId]
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (!(row.period_end instanceof Date) || typeof row.amount_cents !== 'number' || typeof row.provider !== 'string') {
    throw new Error('renewal_quote() did not return a period, an amount and a provider.');
  }
  return { periodEnd: row.period_end, amountCents: row.amount_cents, provider: row.provider };
};

/**
 * `renew_subscription` answers `true` for a renewal it made and `false` for one it had already made with the same provider reference.
 * A0114 (the confirmation does not match the subscription: an amount that is not the one of the next period, a provider that is not
 * the subscription's) and A0115 (the subscription is not due, because it was canceled or renewed while the card was charged) are the
 * database refusing, and the charge is then money taken for nothing. Anything else is not known to have failed, and is not answered
 * here.
 */
type Confirmation = 'renewed' | 'already_renewed' | 'refused' | 'conflict';

const confirm = async (database: DatabaseClient, agencyId: string, provider: string, providerRef: string, paidCents: number): Promise<Confirmation> => {
  for (let attempt = 1; attempt <= CONFIRMATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await raw<{ rows: ReadonlyArray<{ renewed: unknown }> }>(
        database.knex,
        'select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed',
        [agencyId, provider, providerRef, paidCents]
      );
      const renewed = result.rows[0]?.renewed;
      if (typeof renewed !== 'boolean') throw new Error('renew_subscription() did not return whether it renewed.');
      return renewed ? 'renewed' : 'already_renewed';
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === 'A0114' || code === 'A0115') return 'refused';
      if (!isRetryableConflict(error)) throw error;
    }
  }
  return 'conflict';
};

/**
 * The renewal of the paid plans (issue #772): the worker asks the database who is due, charges the provider for the amount the
 * database prices, and tells the database what the provider answered. The database owns every rule (`renew_subscription` applies the
 * scheduled decrease, starts the period where the old one ended, expires the pending charges, audits); the worker is the one place
 * that moves money for a subscription that already exists.
 *
 * Order, per agency, and why:
 *  1. `renewal_quote` reads the end of the period and the amount in one statement. The idempotency key of the charge is built from the
 *     agency, the end of the period and the amount, so a retry of the same renewal asks for the same charge and the provider answers
 *     the same reference, and the renewal of the next month is another key.
 *  2. A declined card records nothing. The agency stays due, writes during the three days of grace, and the next run tries again.
 *  3. An approved charge is confirmed with `renew_subscription`, with its own short transaction and no person bound. A retry that
 *     finds it already confirmed changes nothing.
 *  4. When the database refuses the confirmation (A0114 or A0115) the money was taken for a renewal that does not apply: usage
 *     outgrew a scheduled decrease between the quote and the confirmation, the Owner changed the subscription, or it was canceled. The
 *     charge is refunded in full and the agency is quoted again: an amount that changed is charged at once, once more at most in the
 *     run, and a subscription that is no longer due is left alone.
 *  5. A failure that does not say whether the confirmation happened (a lost connection, or a race lost three times) is not refunded:
 *     the next run quotes again and, with nothing changed, asks for the same charge and gets the same reference. A lost connection
 *     throws, so the queue retries.
 *
 * One agency never takes the others of the run down: its failure is logged by id and thrown at the end, so the queue retries the run.
 * A refund that failed is logged at error level with the reference of the charge, which is what a person needs to give the money back;
 * the run goes on.
 */
export const renewSubscriptionsJob = (
  dependencies: RenewSubscriptionsJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: RENEW_SUBSCRIPTIONS_JOB_NAME,
  schedule: RENEW_SUBSCRIPTIONS_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    const { database, provider } = dependencies;
    const due = await raw<{ rows: ReadonlyArray<{ id: unknown }> }>(
      database.knex,
      'select app_private.agencies_due_for_renewal(?::integer) as id',
      [RENEW_SUBSCRIPTIONS_PER_RUN]
    );
    const agencyIds = due.rows.map((row) => asUuid(row.id));

    const counts: Record<Outcome, number> = {
      renewed: 0, already_renewed: 0, declined: 0, not_due: 0, other_provider: 0, refunded: 0, refund_failed: 0, left_for_next_run: 0
    };
    const failed: string[] = [];

    const renewAgency = async (agencyId: string): Promise<void> => {
      for (let round = 1; round <= ROUNDS_PER_AGENCY; round += 1) {
        const quote = await readQuote(database, agencyId);
        if (quote === undefined) {
          counts.not_due += 1;
          return;
        }
        if (quote.provider !== provider.name) {
          counts.other_provider += 1;
          return;
        }

        const key = `renewal:${agencyId}:${quote.periodEnd.getTime()}:${quote.amountCents}`;
        const charge = await provider.charge({
          idempotencyKey: key,
          amountCents: quote.amountCents,
          reference: key,
          ...(dependencies.simulatedOutcome === undefined ? {} : { testOutcome: dependencies.simulatedOutcome })
        });
        if (charge.status === 'declined') {
          counts.declined += 1;
          context.logger.warn({ agencyId, reason: charge.reason }, 'The provider declined the renewal; the agency stays due for the next run');
          return;
        }

        const confirmation = await confirm(database, agencyId, provider.name, charge.providerRef, charge.paidCents);
        if (confirmation === 'renewed' || confirmation === 'already_renewed') {
          counts[confirmation] += 1;
          return;
        }

        // Lost the race three times, which says nothing about the renewal: the charge stands, and the next run asks for it again with the
        // same key unless the subscription changed, which the log lets a person follow.
        if (confirmation === 'conflict') {
          counts.left_for_next_run += 1;
          context.logger.warn({ agencyId, providerRef: charge.providerRef }, 'The renewal charge could not be confirmed after losing a race; it is left for the next run');
          return;
        }

        // The charge was taken and the database would not take it as a renewal: give the money back.
        const refund = await provider.refund({ idempotencyKey: `refund:${key}`, providerRef: charge.providerRef, amountCents: charge.paidCents });
        if (refund.status === 'failed') {
          counts.refund_failed += 1;
          context.logger.error(
            { agencyId, providerRef: charge.providerRef, amountCents: charge.paidCents, reason: refund.reason, code: 'RENEWAL_REFUND_FAILED' },
            'A renewal charge was taken and could not be refunded; it has to be given back by hand'
          );
          return;
        }
        counts.refunded += 1;
        context.logger.warn({ agencyId, providerRef: charge.providerRef }, 'The renewal charge was refunded: the database did not take it as a renewal');
        // The loop quotes again: after an amount that changed the quote is what is owed now and it is charged at once; after a
        // cancellation or a renewal that came from elsewhere the agency is no longer due and the quote is empty.
      }
    };

    for (const agencyId of agencyIds) {
      if (context.signal.aborted) break;
      try {
        await renewAgency(agencyId);
      } catch (error) {
        failed.push(agencyId);
        context.logger.error(
          { agencyId, error: { name: error instanceof Error ? error.name : 'UnknownError', code: databaseErrorCode(error) ?? 'RENEWAL_FAILED' } },
          'The renewal of an agency failed; it stays due for the next run'
        );
      }
    }

    context.logger.info(counts, 'Renewed the subscriptions that are due');
    if (failed.length > 0) throw new Error(`The renewal of ${failed.length} agencies failed.`);
  }
});
