import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import type { ChargeRequest, ChargeResult, PaymentProvider, RefundRequest, RefundResult } from '@ageniza/payments';
import { describe, expect, it, vi } from 'vitest';

import {
  CONFIRMATION_ATTEMPTS,
  RENEW_SUBSCRIPTIONS_JOB_NAME,
  RENEW_SUBSCRIPTIONS_PER_RUN,
  RENEW_SUBSCRIPTIONS_SCHEDULE,
  renewSubscriptionsJob
} from './renew-subscriptions-job.js';

const DUE_SQL = 'select app_private.agencies_due_for_renewal(?::integer) as id';
const QUOTE_SQL = 'select period_end, amount_cents, provider from app_private.renewal_quote(?::uuid)';
const RENEW_SQL = 'select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed';

const AGENCY = '0b1f6c9e-1111-4222-8333-444455556666';
const OTHER_AGENCY = '0b1f6c9e-7777-4888-9999-aaaabbbbcccc';
const PERIOD_END = new Date('2026-11-29T12:00:00.000Z');

interface QuoteRow { period_end: Date; amount_cents: number; provider: string }
const quote = (amountCents: number, provider = 'simulado', periodEnd = PERIOD_END): QuoteRow => ({ period_end: periodEnd, amount_cents: amountCents, provider });
const lost = (code: string): Error => Object.assign(new Error('database refused'), { code });

type RenewAnswer = boolean | Error;

// The fake answers as the driver does (`{ rows }`, an error carrying the SQLSTATE in `code`). It is told what the database says at each
// call, never what the job should do with it: the amounts, the references and the order are the job's.
const databaseWith = (script: {
  readonly due: ReadonlyArray<string>;
  readonly quotes: Readonly<Record<string, ReadonlyArray<QuoteRow | undefined>>>;
  readonly renewals?: Readonly<Record<string, ReadonlyArray<RenewAnswer>>>;
}) => {
  const quotes = new Map(Object.entries(script.quotes).map(([agency, rows]) => [agency, [...rows]]));
  const renewals = new Map(Object.entries(script.renewals ?? {}).map(([agency, rows]) => [agency, [...rows]]));
  const raw = vi.fn(async (sql: string, bindings: ReadonlyArray<unknown>) => {
    if (sql === DUE_SQL) return { rows: script.due.map((id) => ({ id })) };
    if (sql === QUOTE_SQL) {
      const next = quotes.get(String(bindings[0]))?.shift();
      return { rows: next === undefined ? [] : [next] };
    }
    if (sql === RENEW_SQL) {
      const next = renewals.get(String(bindings[0]))?.shift();
      if (next === undefined) throw new Error(`unexpected renewal of ${String(bindings[0])}`);
      if (next instanceof Error) throw next;
      return { rows: [{ renewed: next }] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  });
  return { database: { knex: { raw } } as unknown as DatabaseClient, raw };
};

const providerWith = (behavior: {
  readonly charge?: (request: ChargeRequest) => ChargeResult | Promise<ChargeResult>;
  readonly refund?: (request: RefundRequest) => RefundResult | Promise<RefundResult>;
  readonly name?: PaymentProvider['name'];
} = {}) => {
  const charge = vi.fn(async (request: ChargeRequest): Promise<ChargeResult> =>
    behavior.charge?.(request) ?? { status: 'approved', providerRef: `fake:${request.idempotencyKey}`, paidCents: request.amountCents });
  const refund = vi.fn(async (request: RefundRequest): Promise<RefundResult> => behavior.refund?.(request) ?? { status: 'refunded' });
  const provider: PaymentProvider = { name: behavior.name ?? 'simulado', charge, refund };
  return { provider, charge, refund };
};

const captureLogger = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    async records(): Promise<Array<Record<string, unknown>>> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  };
};

const run = async (definition: ReturnType<typeof renewSubscriptionsJob>, logger: ReturnType<typeof createLogger>, signal = new AbortController().signal): Promise<void> => {
  await definition.handler({ id: 'job-1', name: RENEW_SUBSCRIPTIONS_JOB_NAME, payload: {}, attempt: 1 }, { logger, signal });
};

const SUMMARY = 'Renewed the subscriptions that are due';
const summaryOf = async (captured: ReturnType<typeof captureLogger>): Promise<Record<string, unknown>> =>
  (await captured.records()).find((record) => record.msg === SUMMARY)!;
const keyFor = (agency: string, cents: number, periodEnd = PERIOD_END): string => `renewal:${agency}:${periodEnd.getTime()}:${cents}`;

describe('subscriptions.renew-due', () => {
  it('is named and scheduled as decided: every five minutes in Brasília, and once at every start', () => {
    const { provider } = providerWith();
    const definition = renewSubscriptionsJob({ database: databaseWith({ due: [], quotes: {} }).database, provider });
    expect(definition.name).toBe('subscriptions.renew-due');
    expect(definition.schedule).toEqual({ cron: '*/5 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(RENEW_SUBSCRIPTIONS_SCHEDULE).toEqual({ cron: '*/5 * * * *', timeZone: 'America/Sao_Paulo' });
    expect(definition.runOnStart).toBe(true);
  });

  it('asks for as many agencies as the database gives in one call, and no more', () => {
    expect(RENEW_SUBSCRIPTIONS_PER_RUN).toBe(500);
  });

  it('charges the amount the database priced under a key made of the agency, the end of the period and the amount, then confirms what the provider answered', async () => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(19_700)] }, renewals: { [AGENCY]: [true] } });
    const { provider, charge, refund } = providerWith({ charge: (request) => ({ status: 'approved', providerRef: 'sim:from-the-provider', paidCents: request.amountCents }) });
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(raw.mock.calls[0]).toEqual([DUE_SQL, [RENEW_SUBSCRIPTIONS_PER_RUN]]);
    expect(charge.mock.calls).toEqual([[{ idempotencyKey: keyFor(AGENCY, 19_700), amountCents: 19_700, reference: keyFor(AGENCY, 19_700) }]]);
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL)).toEqual([[RENEW_SQL, [AGENCY, 'simulado', 'sim:from-the-provider', 19_700]]]);
    expect(refund).not.toHaveBeenCalled();
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, already_renewed: 0, declined: 0, refunded: 0 });
  });

  it('confirms with the amount the provider says it took, which the database compares with the one it priced', async () => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [true] } });
    const { provider } = providerWith({ charge: (request) => ({ status: 'approved', providerRef: 'sim:x', paidCents: request.amountCents - 100 }) });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);

    expect(raw.mock.calls.find(([sql]) => sql === RENEW_SQL)).toEqual([RENEW_SQL, [AGENCY, 'simulado', 'sim:x', 9_600]]);
  });

  it('makes another key for the next month and for another amount, and the same key for a retry', async () => {
    const keysOf = async (periodEnd: Date, cents: number): Promise<string> => {
      const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(cents, 'simulado', periodEnd)] }, renewals: { [AGENCY]: [true] } });
      const { provider, charge } = providerWith();
      await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);
      return charge.mock.calls[0]![0].idempotencyKey;
    };
    const base = await keysOf(PERIOD_END, 9_700);
    expect(await keysOf(PERIOD_END, 9_700)).toBe(base);
    expect(await keysOf(new Date(PERIOD_END.getTime() + 30 * 86_400_000), 9_700)).not.toBe(base);
    expect(await keysOf(PERIOD_END, 9_740)).not.toBe(base);
  });

  it('records nothing for a declined card, logs the reason with the id of the agency, and goes on to the next agency', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [OTHER_AGENCY]: [true] }
    });
    const { provider, refund } = providerWith({ charge: (request) => request.amountCents === 9_700 ? { status: 'declined', reason: 'card_declined' } : { status: 'approved', providerRef: 'sim:ok', paidCents: request.amountCents } });
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL)).toEqual([[RENEW_SQL, [OTHER_AGENCY, 'simulado', 'sim:ok', 19_700]]]);
    expect(refund).not.toHaveBeenCalled();
    const records = await captured.records();
    expect(records).toContainEqual(expect.objectContaining({ level: 40, agencyId: AGENCY, reason: 'card_declined' }));
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, declined: 1 });
  });

  it('tells the simulated provider to decline only when the worker was told to, and never otherwise', async () => {
    for (const simulatedOutcome of ['declined', 'approved', undefined] as const) {
      const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [true] } });
      const { provider, charge } = providerWith({ charge: (request) => request.testOutcome === 'declined' ? { status: 'declined', reason: 'card_declined' } : { status: 'approved', providerRef: 'sim:r', paidCents: request.amountCents } });

      await run(renewSubscriptionsJob({ database, provider, ...(simulatedOutcome === undefined ? {} : { simulatedOutcome }) }), captureLogger().logger);

      const request = charge.mock.calls[0]![0];
      if (simulatedOutcome === undefined) expect(request).not.toHaveProperty('testOutcome');
      else expect(request.testOutcome).toBe(simulatedOutcome);
    }
  });

  it('counts a renewal the database already had (same reference) as done, without a refund', async () => {
    const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [false] } });
    const { provider, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(refund).not.toHaveBeenCalled();
    expect(await summaryOf(captured)).toMatchObject({ renewed: 0, already_renewed: 1, refunded: 0 });
  });

  it('charges nothing for an agency that is no longer due when it is quoted', async () => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [undefined] } });
    const { provider, charge } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).not.toHaveBeenCalled();
    expect(raw.mock.calls.some(([sql]) => sql === RENEW_SQL)).toBe(false);
    expect(await summaryOf(captured)).toMatchObject({ not_due: 1 });
  });

  it('charges nothing for a subscription of another provider than the one this worker charges with', async () => {
    const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700, 'asaas')] } });
    const { provider, charge } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).not.toHaveBeenCalled();
    expect(await summaryOf(captured)).toMatchObject({ other_provider: 1 });
  });

  it('refunds the whole charge when the database refuses the amount (A0114), quotes again and charges the new amount at once', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700)] },
      renewals: { [AGENCY]: [lost('A0114'), true] }
    });
    const { provider, charge, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge.mock.calls.map(([request]) => [request.idempotencyKey, request.amountCents])).toEqual([
      [keyFor(AGENCY, 9_700), 9_700],
      [keyFor(AGENCY, 19_700), 19_700]
    ]);
    expect(refund.mock.calls).toEqual([[{ idempotencyKey: `refund:${keyFor(AGENCY, 9_700)}`, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700 }]]);
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL).map(([, bindings]) => bindings)).toEqual([
      [AGENCY, 'simulado', `fake:${keyFor(AGENCY, 9_700)}`, 9_700],
      [AGENCY, 'simulado', `fake:${keyFor(AGENCY, 19_700)}`, 19_700]
    ]);
    // The refund is made before the second charge: the money of the first never stays with the provider while the second is asked.
    expect(refund.mock.invocationCallOrder[0]).toBeLessThan(charge.mock.invocationCallOrder[1]!);
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refunded: 1 });
  });

  it('charges the new amount once at most in a run: a second refusal is refunded and the agency waits for the next run', async () => {
    const { database } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700), quote(29_700)] },
      renewals: { [AGENCY]: [lost('A0114'), lost('A0114')] }
    });
    const { provider, charge, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).toHaveBeenCalledTimes(2);
    expect(refund).toHaveBeenCalledTimes(2);
    expect(await summaryOf(captured)).toMatchObject({ renewed: 0, refunded: 2 });
  });

  it('refunds when the subscription is no longer due (A0115), and does not charge again once the quote is empty', async () => {
    const { database } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700), undefined] },
      renewals: { [AGENCY]: [lost('A0115')] }
    });
    const { provider, charge, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(await summaryOf(captured)).toMatchObject({ refunded: 1, not_due: 1 });
  });

  it('logs at error level, with the reference of the charge, a refund that failed, and does not charge that agency again nor stop the run', async () => {
    const { database } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700)], [OTHER_AGENCY]: [quote(9_700)] },
      renewals: { [AGENCY]: [lost('A0114')], [OTHER_AGENCY]: [true] }
    });
    const { provider, charge } = providerWith({ refund: () => ({ status: 'failed', reason: 'provider_unavailable' }) });
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([keyFor(AGENCY, 9_700), keyFor(OTHER_AGENCY, 9_700)]);
    const records = await captured.records();
    expect(records).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700, reason: 'provider_unavailable', code: 'RENEWAL_REFUND_FAILED'
    }));
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refund_failed: 1, refunded: 0 });
  });

  it('confirms again after a lost race and renews when the second try wins', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700)] },
      renewals: { [AGENCY]: [lost('40P01'), lost('40001'), true] }
    });
    const { provider, charge, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL)).toHaveLength(3);
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1 });
  });

  it('leaves the charge standing, without a refund, when the race is lost every time, and logs the reference to follow it', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700)] },
      renewals: { [AGENCY]: Array.from({ length: CONFIRMATION_ATTEMPTS + 2 }, () => lost('40001')) }
    });
    const { provider, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(CONFIRMATION_ATTEMPTS).toBe(3);
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL)).toHaveLength(CONFIRMATION_ATTEMPTS);
    expect(refund).not.toHaveBeenCalled();
    expect(await captured.records()).toContainEqual(expect.objectContaining({ level: 40, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}` }));
    expect(await summaryOf(captured)).toMatchObject({ left_for_next_run: 1, renewed: 0, refunded: 0 });
  });

  it('does not refund a confirmation that failed in a way that does not say whether it happened, finishes the other agencies, and throws so the queue retries', async () => {
    const { database } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [AGENCY]: [Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' })], [OTHER_AGENCY]: [true] }
    });
    const { provider, refund, charge } = providerWith();
    const captured = captureLogger();

    await expect(run(renewSubscriptionsJob({ database, provider }), captured.logger)).rejects.toThrow('The renewal of 1 agencies failed.');

    expect(refund).not.toHaveBeenCalled();
    expect(charge).toHaveBeenCalledTimes(2);
    const records = await captured.records();
    expect(records).toContainEqual(expect.objectContaining({ level: 50, agencyId: AGENCY, error: { name: 'Error', code: '57P01' } }));
    expect(JSON.stringify(records)).not.toContain('Connection terminated');
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1 });
  });

  it('fails the run, after the others, when the provider itself throws for an agency', async () => {
    const { database } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [OTHER_AGENCY]: [true] }
    });
    const { provider } = providerWith({ charge: (request) => { if (request.amountCents === 9_700) throw new Error('socket hang up'); return { status: 'approved', providerRef: 'sim:ok', paidCents: request.amountCents }; } });

    await expect(run(renewSubscriptionsJob({ database, provider }), captureLogger().logger)).rejects.toThrow('The renewal of 1 agencies failed.');
  });

  it('stops between agencies when the worker is stopping, and never between a charge and its confirmation', async () => {
    const controller = new AbortController();
    const { database, raw } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [AGENCY]: [true] }
    });
    const { provider, charge } = providerWith({ charge: (request) => { controller.abort(); return { status: 'approved', providerRef: 'sim:last', paidCents: request.amountCents }; } });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger, controller.signal);

    expect(charge).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL)).toEqual([[RENEW_SQL, [AGENCY, 'simulado', 'sim:last', 9_700]]]);
  });

  // The quote is refused by its own check, before anything is charged: a TypeError further on (`getTime` of a string) would also stop the
  // agency, so the test reads the name of the logged error, which is `Error` only for the guard.
  it.each([
    ['a period that is not a date', { period_end: '2026-11-29', amount_cents: 9_700, provider: 'simulado' }],
    ['an amount that is not a number', { period_end: PERIOD_END, amount_cents: '9700', provider: 'simulado' }],
    ['a provider that is not a name', { period_end: PERIOD_END, amount_cents: 9_700, provider: 42 }]
  ])('refuses a quote with %s, charges nothing and fails the run after the others', async (_label, row) => {
    const { provider, charge } = providerWith();
    const database = { knex: { raw: vi.fn(async (sql: string) => (sql === DUE_SQL ? { rows: [{ id: AGENCY }] } : { rows: [row] })) } } as unknown as DatabaseClient;
    const captured = captureLogger();

    await expect(run(renewSubscriptionsJob({ database, provider }), captured.logger)).rejects.toThrow('The renewal of 1 agencies failed.');

    expect(charge).not.toHaveBeenCalled();
    const failure = (await captured.records()).find((record) => record.msg === 'The renewal of an agency failed; it stays due for the next run');
    expect(failure).toMatchObject({ agencyId: AGENCY, error: { name: 'Error', code: 'RENEWAL_FAILED' } });
  });

  it('refuses a listing that is not ids', async () => {
    const { provider } = providerWith();
    const listing = { knex: { raw: vi.fn(async () => ({ rows: [{ id: 42 }] })) } } as unknown as DatabaseClient;
    await expect(run(renewSubscriptionsJob({ database: listing, provider }), captureLogger().logger)).rejects.toThrow('agencies_due_for_renewal() did not return agency ids.');
  });

  it('does not take a confirmation that does not say whether it renewed for a renewal, and does not refund it', async () => {
    const { provider, refund } = providerWith();
    const database = {
      knex: {
        raw: vi.fn(async (sql: string) => {
          if (sql === DUE_SQL) return { rows: [{ id: AGENCY }] };
          if (sql === QUOTE_SQL) return { rows: [quote(9_700)] };
          return { rows: [{ renewed: null }] };
        })
      }
    } as unknown as DatabaseClient;
    const captured = captureLogger();

    await expect(run(renewSubscriptionsJob({ database, provider }), captured.logger)).rejects.toThrow('The renewal of 1 agencies failed.');

    expect(refund).not.toHaveBeenCalled();
    const failure = (await captured.records()).find((record) => record.msg === 'The renewal of an agency failed; it stays due for the next run');
    expect(failure).toMatchObject({ error: { name: 'Error', code: 'RENEWAL_FAILED' } });
  });

  it('charges and confirms with the provider the subscription has, which is the one this worker was given', async () => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700, 'asaas')] }, renewals: { [AGENCY]: [true] } });
    const { provider } = providerWith({ name: 'asaas' });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);

    expect(raw.mock.calls.find(([sql]) => sql === RENEW_SQL)).toEqual([RENEW_SQL, [AGENCY, 'asaas', `fake:${keyFor(AGENCY, 9_700)}`, 9_700]]);
  });

  it('refunds what the provider says it took, not what the quote said', async () => {
    const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [lost('A0114')] } });
    const { provider, refund } = providerWith({ charge: (request) => ({ status: 'approved', providerRef: 'sim:took-less', paidCents: request.amountCents - 100 }) });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);

    expect(refund.mock.calls).toEqual([[{ idempotencyKey: `refund:${keyFor(AGENCY, 9_700)}`, providerRef: 'sim:took-less', amountCents: 9_600 }]]);
  });
});
