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
const QUOTE_SQL = 'select period_end, amount_cents, provider, attempt from app_private.renewal_quote(?::uuid)';
const RENEW_SQL = 'select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed';
const RECORD_SQL = 'select app_private.record_renewal_refund(?::uuid, ?, ?, ?::timestamptz, ?::integer, ?)';
const SETTLE_SQL = 'select app_private.settle_renewal_refund(?, ?, ?, ?)';

const AGENCY = '0b1f6c9e-1111-4222-8333-444455556666';
const OTHER_AGENCY = '0b1f6c9e-7777-4888-9999-aaaabbbbcccc';
const PERIOD_END = new Date('2026-11-29T12:00:00.000Z');

interface QuoteRow { period_end: Date; amount_cents: number; provider: string; attempt: number }
const quote = (amountCents: number, provider = 'simulado', periodEnd = PERIOD_END, attempt = 0): QuoteRow =>
  ({ period_end: periodEnd, amount_cents: amountCents, provider, attempt });
const lost = (code: string): Error => Object.assign(new Error('database refused'), { code });

type RenewAnswer = boolean | Error;

// The fake answers as the driver does (`{ rows }`, an error carrying the SQLSTATE in `code`). It is told what the database says at each
// call, never what the job should do with it: the amounts, the references and the order are the job's.
const databaseWith = (script: {
  readonly due: ReadonlyArray<string>;
  readonly quotes: Readonly<Record<string, ReadonlyArray<QuoteRow | undefined>>>;
  readonly renewals?: Readonly<Record<string, ReadonlyArray<RenewAnswer>>>;
  /** What the database answers when the refund is recorded, per agency and in order; a refund recorded when the script has no more. */
  readonly records?: Readonly<Record<string, ReadonlyArray<Error | undefined>>>;
  /** What the database answers when the provider's answer to a refund is written down. */
  readonly settlement?: Error;
}) => {
  const quotes = new Map(Object.entries(script.quotes).map(([agency, rows]) => [agency, [...rows]]));
  const renewals = new Map(Object.entries(script.renewals ?? {}).map(([agency, rows]) => [agency, [...rows]]));
  const records = new Map(Object.entries(script.records ?? {}).map(([agency, rows]) => [agency, [...rows]]));
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
    if (sql === RECORD_SQL) {
      const next = records.get(String(bindings[0]))?.shift();
      if (next instanceof Error) throw next;
      return { rows: [{ record_renewal_refund: '' }] };
    }
    if (sql === SETTLE_SQL) {
      if (script.settlement !== undefined) throw script.settlement;
      return { rows: [{ settle_renewal_refund: true }] };
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
const keyFor = (agency: string, cents: number, attempt = 0, periodEnd = PERIOD_END): string => `renewal:${agency}:${periodEnd.getTime()}:${cents}:${attempt}`;
const callsOf = (raw: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }, sql: string): ReadonlyArray<unknown> =>
  raw.mock.calls.filter(([statement]) => statement === sql).map(([, bindings]) => bindings);

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

  it('charges the amount the database priced under a key made of the agency, the end of the period, the amount and the attempt, then confirms what the provider answered', async () => {
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

  it('makes another key for the next month, for another amount and for another attempt, and the same key for a retry', async () => {
    const keysOf = async (periodEnd: Date, cents: number, attempt = 0): Promise<string> => {
      const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(cents, 'simulado', periodEnd, attempt)] }, renewals: { [AGENCY]: [true] } });
      const { provider, charge } = providerWith();
      await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);
      return charge.mock.calls[0]![0].idempotencyKey;
    };
    const base = await keysOf(PERIOD_END, 9_700);
    expect(await keysOf(PERIOD_END, 9_700)).toBe(base);
    expect(await keysOf(new Date(PERIOD_END.getTime() + 30 * 86_400_000), 9_700)).not.toBe(base);
    expect(await keysOf(PERIOD_END, 9_740)).not.toBe(base);
    // A refund of the period is an attempt: the charge after it is another payment, not the one that was given back.
    expect(await keysOf(PERIOD_END, 9_700, 1)).not.toBe(base);
    expect(await keysOf(PERIOD_END, 9_700, 1)).toBe(await keysOf(PERIOD_END, 9_700, 1));
    expect(await keysOf(PERIOD_END, 9_700, 2)).not.toBe(await keysOf(PERIOD_END, 9_700, 1));
    expect(base).toBe(keyFor(AGENCY, 9_700, 0));
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
      quotes: { [AGENCY]: [quote(9_700), quote(19_700, 'simulado', PERIOD_END, 1)] },
      renewals: { [AGENCY]: [lost('A0114'), true] }
    });
    const { provider, charge, refund } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge.mock.calls.map(([request]) => [request.idempotencyKey, request.amountCents])).toEqual([
      [keyFor(AGENCY, 9_700, 0), 9_700],
      [keyFor(AGENCY, 19_700, 1), 19_700]
    ]);
    expect(refund.mock.calls).toEqual([[{ idempotencyKey: `refund:${keyFor(AGENCY, 9_700)}`, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700 }]]);
    expect(raw.mock.calls.filter(([sql]) => sql === RENEW_SQL).map(([, bindings]) => bindings)).toEqual([
      [AGENCY, 'simulado', `fake:${keyFor(AGENCY, 9_700)}`, 9_700],
      [AGENCY, 'simulado', `fake:${keyFor(AGENCY, 19_700, 1)}`, 19_700]
    ]);
    // The refund is made before the second charge: the money of the first never stays with the provider while the second is asked.
    expect(refund.mock.invocationCallOrder[0]).toBeLessThan(charge.mock.invocationCallOrder[1]!);
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refunded: 1 });
  });

  it('charges the new amount once at most in a run: a second refusal is refunded and the agency waits for the next run', async () => {
    const { database } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700, 'simulado', PERIOD_END, 1), quote(9_700, 'simulado', PERIOD_END, 2)] },
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
    const { database, raw } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700, 'simulado', PERIOD_END, 1)], [OTHER_AGENCY]: [quote(9_700)] },
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
    // The database is told it failed, with the reason the provider gave; the reference stays closed for renewals.
    expect(callsOf(raw, SETTLE_SQL)).toEqual([['simulado', `fake:${keyFor(AGENCY, 9_700)}`, 'failed', 'provider_unavailable']]);
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
    ['a period that is not a date', { period_end: '2026-11-29', amount_cents: 9_700, provider: 'simulado', attempt: 0 }],
    ['an amount that is not a number', { period_end: PERIOD_END, amount_cents: '9700', provider: 'simulado', attempt: 0 }],
    ['a provider that is not a name', { period_end: PERIOD_END, amount_cents: 9_700, provider: 42, attempt: 0 }],
    ['an attempt that is missing', { period_end: PERIOD_END, amount_cents: 9_700, provider: 'simulado' }],
    ['an attempt that is a string', { period_end: PERIOD_END, amount_cents: 9_700, provider: 'simulado', attempt: '1' }],
    ['an attempt that is negative', { period_end: PERIOD_END, amount_cents: 9_700, provider: 'simulado', attempt: -1 }],
    ['an attempt that is not whole', { period_end: PERIOD_END, amount_cents: 9_700, provider: 'simulado', attempt: 0.5 }]
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

describe('the refund the database is told about', () => {
  it.each(['A0114', 'A0115'] as const)('records the refund of a charge the database refused (%s) before it asks the provider, and writes the answer down after', async (code) => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700), undefined] }, renewals: { [AGENCY]: [lost(code)] } });
    const { provider, refund } = providerWith({ charge: (request) => ({ status: 'approved', providerRef: 'sim:took-less', paidCents: request.amountCents - 100 }) });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);

    // What was taken (9_600), the period and the code the database refused with: the job reads them, it does not compute them.
    expect(callsOf(raw, RECORD_SQL)).toEqual([[AGENCY, 'simulado', 'sim:took-less', PERIOD_END, 9_600, code]]);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([['simulado', 'sim:took-less', 'refunded', null]]);
    const order = raw.mock.invocationCallOrder;
    const recordAt = order[raw.mock.calls.findIndex(([sql]) => sql === RECORD_SQL)]!;
    const settleAt = order[raw.mock.calls.findIndex(([sql]) => sql === SETTLE_SQL)]!;
    expect(recordAt).toBeLessThan(refund.mock.invocationCallOrder[0]!);
    expect(refund.mock.invocationCallOrder[0]!).toBeLessThan(settleAt);
  });

  it('records a refund with the provider of the worker, so the database counts it for that provider', async () => {
    const { database, raw } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700, 'asaas'), undefined] }, renewals: { [AGENCY]: [lost('A0115')] } });
    const { provider } = providerWith({ name: 'asaas' });

    await run(renewSubscriptionsJob({ database, provider }), captureLogger().logger);

    expect(callsOf(raw, RECORD_SQL)).toEqual([[AGENCY, 'asaas', `fake:${keyFor(AGENCY, 9_700)}`, PERIOD_END, 9_700, 'A0115']]);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([['asaas', `fake:${keyFor(AGENCY, 9_700)}`, 'refunded', null]]);
  });

  it('charges a new payment, not the refunded one, when the card is charged again for the same period (cancel, refund, reactivate)', async () => {
    // First run: the Owner canceled while the card was charged. Second run: reactivated, the database counts the refund as an attempt.
    const first = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700), undefined] }, renewals: { [AGENCY]: [lost('A0115')] } });
    const second = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700, 'simulado', PERIOD_END, 1)] }, renewals: { [AGENCY]: [true] } });
    const { provider, charge } = providerWith({ charge: (request) => ({ status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents }) });

    await run(renewSubscriptionsJob({ database: first.database, provider }), captureLogger().logger);
    await run(renewSubscriptionsJob({ database: second.database, provider }), captureLogger().logger);

    const refs = charge.mock.calls.map(([request]) => request.idempotencyKey);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    expect(callsOf(second.raw, RENEW_SQL)).toEqual([[AGENCY, 'simulado', `sim:${keyFor(AGENCY, 9_700, 1)}`, 9_700]]);
    expect(callsOf(first.raw, RECORD_SQL)).toEqual([[AGENCY, 'simulado', `sim:${keyFor(AGENCY, 9_700, 0)}`, PERIOD_END, 9_700, 'A0115']]);
  });

  it('does not ask the provider to refund when the database could not record it, logs what a person needs, and fails the run after the others', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [AGENCY]: [lost('A0114')], [OTHER_AGENCY]: [true] },
      records: { [AGENCY]: [Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' })] }
    });
    const { provider, refund, charge } = providerWith();
    const captured = captureLogger();

    await expect(run(renewSubscriptionsJob({ database, provider }), captured.logger)).rejects.toThrow('The renewal of 1 agencies failed.');

    expect(refund).not.toHaveBeenCalled();
    expect(callsOf(raw, RECORD_SQL)).toHaveLength(1);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([]);
    expect(charge).toHaveBeenCalledTimes(2);
    const records = await captured.records();
    expect(records).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700, code: 'RENEWAL_REFUND_NOT_RECORDED'
    }));
    expect(JSON.stringify(records)).not.toContain('Connection terminated');
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refunded: 0 });
  });

  it('records again after a lost race, and gives up (without a refund) when the race is lost every time', async () => {
    const won = databaseWith({
      due: [AGENCY], quotes: { [AGENCY]: [quote(9_700), undefined] }, renewals: { [AGENCY]: [lost('A0115')] },
      records: { [AGENCY]: [lost('40001'), lost('40P01')] }
    });
    const first = providerWith();
    await run(renewSubscriptionsJob({ database: won.database, provider: first.provider }), captureLogger().logger);
    expect(callsOf(won.raw, RECORD_SQL)).toHaveLength(3);
    expect(first.refund).toHaveBeenCalledTimes(1);

    const never = databaseWith({
      due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [lost('A0115')] },
      records: { [AGENCY]: Array.from({ length: CONFIRMATION_ATTEMPTS + 2 }, () => lost('40001')) }
    });
    const second = providerWith();
    await expect(run(renewSubscriptionsJob({ database: never.database, provider: second.provider }), captureLogger().logger)).rejects.toThrow('The renewal of 1 agencies failed.');
    expect(callsOf(never.raw, RECORD_SQL)).toHaveLength(CONFIRMATION_ATTEMPTS);
    expect(second.refund).not.toHaveBeenCalled();
  });

  it('does not refund a reference that holds a confirmed charge (A0119): it logs it and counts it as a refund that did not happen', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [lost('A0114')] },
      records: { [AGENCY]: [lost('A0119')] }
    });
    const { provider, refund, charge } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(refund).not.toHaveBeenCalled();
    expect(charge).toHaveBeenCalledTimes(1);
    expect(callsOf(raw, RECORD_SQL)).toHaveLength(1);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([]);
    expect(await captured.records()).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700, code: 'RENEWAL_REFUND_REFUSED'
    }));
    expect(await summaryOf(captured)).toMatchObject({ refund_failed: 1, refunded: 0 });
  });

  it('catches a refund that throws as a refund that failed: logs the reference and the amount, leaves the record, goes on with the others', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY, OTHER_AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700, 'simulado', PERIOD_END, 1)], [OTHER_AGENCY]: [quote(19_700)] },
      renewals: { [AGENCY]: [lost('A0114')], [OTHER_AGENCY]: [true] }
    });
    const { provider, refund, charge } = providerWith({ refund: () => { throw new TypeError('socket hang up with the card 4111'); } });
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(refund).toHaveBeenCalledTimes(1);
    // The record was written before, and it is not settled: nobody knows whether the money went back.
    expect(callsOf(raw, RECORD_SQL)).toEqual([[AGENCY, 'simulado', `fake:${keyFor(AGENCY, 9_700)}`, PERIOD_END, 9_700, 'A0114']]);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([]);
    // That agency is not charged again in the run, and the other one is renewed.
    expect(charge.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([keyFor(AGENCY, 9_700), keyFor(OTHER_AGENCY, 19_700)]);
    const records = await captured.records();
    expect(records).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700, reason: 'refund_threw', code: 'RENEWAL_REFUND_FAILED',
      error: { name: 'TypeError' }
    }));
    expect(JSON.stringify(records)).not.toContain('4111');
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refund_failed: 1, refunded: 0 });
  });

  it('logs a refund thrown as something that is not an error, with the name of an unknown one', async () => {
    const { database } = databaseWith({ due: [AGENCY], quotes: { [AGENCY]: [quote(9_700)] }, renewals: { [AGENCY]: [lost('A0114')] } });
    const { provider } = providerWith({ refund: () => Promise.reject('plain text') });
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(await captured.records()).toContainEqual(expect.objectContaining({ code: 'RENEWAL_REFUND_FAILED', reason: 'refund_threw', error: { name: 'UnknownError' } }));
  });

  it('goes on when the answer to a refund cannot be written down: the money went back, and the next charge of the agency is still asked', async () => {
    const { database } = databaseWith({
      due: [AGENCY],
      quotes: { [AGENCY]: [quote(9_700), quote(19_700, 'simulado', PERIOD_END, 1)] },
      renewals: { [AGENCY]: [lost('A0114'), true] },
      settlement: Object.assign(new Error('write failed'), { code: '57P01' })
    });
    const { provider, charge } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(charge).toHaveBeenCalledTimes(2);
    expect(await captured.records()).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, code: 'RENEWAL_REFUND_NOT_SETTLED', error: { code: '57P01' }
    }));
    expect(await summaryOf(captured)).toMatchObject({ renewed: 1, refunded: 1 });
  });

  it('logs a settlement that failed without a SQLSTATE as an unknown one', async () => {
    const { database } = databaseWith({
      due: [AGENCY], quotes: { [AGENCY]: [quote(9_700), undefined] }, renewals: { [AGENCY]: [lost('A0115')] }, settlement: new Error('write failed')
    });
    const { provider } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(await captured.records()).toContainEqual(expect.objectContaining({ code: 'RENEWAL_REFUND_NOT_SETTLED', error: { code: 'UNKNOWN' } }));
  });

  it('refunds nothing for a reference the database recorded as refunded (A0118): it logs it, renews nothing and does not charge again', async () => {
    const { database, raw } = databaseWith({
      due: [AGENCY], quotes: { [AGENCY]: [quote(9_700), quote(9_700, 'simulado', PERIOD_END, 1)] }, renewals: { [AGENCY]: [lost('A0118')] }
    });
    const { provider, refund, charge } = providerWith();
    const captured = captureLogger();

    await run(renewSubscriptionsJob({ database, provider }), captured.logger);

    expect(refund).not.toHaveBeenCalled();
    expect(charge).toHaveBeenCalledTimes(1);
    expect(callsOf(raw, RECORD_SQL)).toEqual([]);
    expect(callsOf(raw, SETTLE_SQL)).toEqual([]);
    expect(callsOf(raw, RENEW_SQL)).toHaveLength(1);
    expect(await captured.records()).toContainEqual(expect.objectContaining({
      level: 50, agencyId: AGENCY, providerRef: `fake:${keyFor(AGENCY, 9_700)}`, amountCents: 9_700, code: 'RENEWAL_REFUNDED_REFERENCE'
    }));
    expect(await summaryOf(captured)).toMatchObject({ refunded_reference: 1, renewed: 0, refunded: 0, left_for_next_run: 0 });
  });
});
