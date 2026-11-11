import type { Knex } from 'knex';

export const QUIET_SECONDS = 60;

export interface QuietClockWindow {
  /** Seconds after São Paulo midnight that a run must not start in. */
  readonly afterMidnightSeconds?: number;
  /** Seconds before São Paulo midnight that a run must not start in. */
  readonly beforeMidnightSeconds?: number;
}

/** How long a suite waits before it starts, so that its run does not cross São Paulo midnight (the database reads its own clock). */
export const secondsUntilClockIsQuiet = (secondsSinceMidnight: number, secondsToMidnight: number, window: QuietClockWindow = {}): number => {
  const after = window.afterMidnightSeconds ?? QUIET_SECONDS;
  const before = window.beforeMidnightSeconds ?? QUIET_SECONDS;
  if (secondsSinceMidnight < after) return after - secondsSinceMidnight;
  if (secondsToMidnight < before) return secondsToMidnight + after;
  return 0;
};

/**
 * Waits until the database clock is away from São Paulo midnight. A day computed by the test and the day a database function computes
 * would otherwise differ. The clock is the database's, never the machine's.
 */
export const waitForQuietClock = async (knex: Knex, window?: QuietClockWindow): Promise<void> => {
  const { rows } = await knex.raw<{ rows: Array<{ since: number; until: number }> }>(`
    select extract(epoch from now() - app_private.sao_paulo_date(now())::timestamp at time zone 'America/Sao_Paulo')::float8 as since,
           extract(epoch from (app_private.sao_paulo_date(now()) + 1)::timestamp at time zone 'America/Sao_Paulo' - now())::float8 as until
  `);
  const wait = secondsUntilClockIsQuiet(rows[0]!.since, rows[0]!.until, window);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
};
