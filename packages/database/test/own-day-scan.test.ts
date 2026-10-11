import { describe, expect, it } from 'vitest';

import { keepsItsOwnDay, ownDayFindings } from './support/own-day-scan.js';

const found: readonly (readonly [string, string])[] = [
  ['at time zone', "pg_catalog.now() at time zone 'America/Sao_Paulo'"],
  ['at time zone of a column', "created_at at time zone 'UTC'"],
  ['current_date', 'current_date'],
  ['current_time', 'current_time'],
  ['localtimestamp', 'localtimestamp'],
  ['localtime', 'localtime'],
  ['date_trunc of the clock', "pg_catalog.date_trunc('day', pg_catalog.now())"],
  ['timezone() of the clock', "pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())"],
  ['timezone() of a column', "pg_catalog.timezone('UTC', created_at)"],
  ['now()::date', 'pg_catalog.now()::pg_catalog.date'],
  ['(now())::date', '(pg_catalog.now())::pg_catalog.date'],
  ['cast(now() as date)', 'cast(pg_catalog.now() as pg_catalog.date)'],
  ['current_timestamp::date', 'current_timestamp::pg_catalog.date'],
  ['current_timestamp(3)::date', 'current_timestamp(3)::pg_catalog.date'],
  ['clock_timestamp()::date', 'pg_catalog.clock_timestamp()::pg_catalog.date'],
  ['transaction_timestamp()::date', 'pg_catalog.transaction_timestamp()::pg_catalog.date'],
  ['statement_timestamp()::date', 'pg_catalog.statement_timestamp()::pg_catalog.date'],
  ['date(now())', 'pg_catalog.date(pg_catalog.now())'],
  ['extract day from now()', 'extract(day from pg_catalog.now())'],
  ['extract hour from now()', 'extract(HOUR from pg_catalog.now())'],
  ['date_part on now()', "pg_catalog.date_part('day', pg_catalog.now())"],
  ['to_char of now()', "pg_catalog.to_char(pg_catalog.now(), 'YYYY-MM-DD')"],
  ['the clock shifted by hand, then cast', "(pg_catalog.now() - interval '3 hours')::pg_catalog.date"],
  ['the clock shifted by hand inside cast()', "cast(pg_catalog.now() - interval '3 hours' as pg_catalog.date)"],
  ['a chain of casts through timestamp', 'pg_catalog.now()::pg_catalog.timestamp::pg_catalog.date'],
  ['a chain of casts through timestamptz', 'pg_catalog.now()::pg_catalog.timestamptz::pg_catalog.date'],
  ['the clock as text', 'pg_catalog.left(pg_catalog.now()::pg_catalog.text, 10)'],
  ['the clock as naive timestamp', 'pg_catalog.now()::pg_catalog.timestamp'],
  ['date_bin of the clock', "pg_catalog.date_bin('1 day', pg_catalog.now(), timestamptz '2020-01-01 00:00:00+00')"],
  ['a literal that is the day', "'today'::pg_catalog.date"],
  ['a literal that is the instant, then a day', "'now'::pg_catalog.timestamptz::pg_catalog.date"],
  ['the clock inside coalesce, then cast', 'coalesce(closing_date, pg_catalog.now())::pg_catalog.date'],
  ['a day made of the clock and a pure day', 'app_private.sao_paulo_date(pg_catalog.now()) = pg_catalog.now()::pg_catalog.date']
];

const left: readonly (readonly [string, string])[] = [
  ['the pure function of the clock', 'app_private.sao_paulo_date(pg_catalog.now())'],
  ['the pure function of a shifted clock', "app_private.sao_paulo_date(pg_catalog.now() - interval '1 day')"],
  ['the pure function in a comparison', 'closing_date <= app_private.sao_paulo_date(pg_catalog.now())'],
  ['a plain timestamp from the clock', 'pg_catalog.now()'],
  ['a shifted timestamp from the clock', "pg_catalog.now() - interval '1 day'"],
  ['an expiry from the clock', "pg_catalog.now() + interval '30 minutes' > expires_at"],
  ['the clock cast to its own type', 'pg_catalog.now()::pg_catalog.timestamptz'],
  ['a text that only mentions a zone', "'timezone, current and local, at time zone and current_date'"],
  ['a comment that mentions a zone', 'select 1 -- never write current_date here'],
  ['a block comment that mentions a zone', 'select 1 /* now()::date and at time zone */'],
  ['date_trunc of a constant date', "pg_catalog.date_trunc('month', date '2020-01-15')"],
  ['date_trunc of a column', "pg_catalog.date_trunc('month', closing_date)"],
  ['timezone() of constants', "pg_catalog.timezone('UTC', timestamptz '2020-01-01 00:00:00+00')"],
  ['the age of a row in seconds', "extract(epoch from pg_catalog.now() - timestamptz '2020-01-01 00:00:00+00')"],
  ['the age of a column in seconds', 'pg_catalog.date_part(\'epoch\', pg_catalog.now() - created_at)'],
  ['the seconds field of the clock', 'extract(second from pg_catalog.now())'],
  ['a column cast to date', 'created_at::pg_catalog.date'],
  ['a day cast to date', 'closing_date::pg_catalog.date'],
  ['a function whose name only ends in timezone', 'app_private.agency_timezone(agency_id)'],
  ['an identifier that only starts like a keyword', 'current_date_value + localtime_offset'],
  ['a timestamp with time zone cast', 'pg_catalog.now()::timestamp with time zone']
];

describe('the scan of SQL that works out its own day', () => {
  it.each(found)('finds %s', (_form, sql) => {
    expect(keepsItsOwnDay(sql), sql).toBe(true);
  });

  it.each(left)('leaves alone %s', (_form, sql) => {
    expect(ownDayFindings(sql), sql).toEqual([]);
  });

  it('reads the day made of a pure day and the clock as a find only for the clock part', () => {
    expect(ownDayFindings('app_private.sao_paulo_date(pg_catalog.now())::pg_catalog.date')).toEqual([]);
    expect(ownDayFindings('app_private.sao_paulo_date(pg_catalog.now()), pg_catalog.now()::pg_catalog.date')).toHaveLength(1);
  });

  it('keeps the string that a quote escapes inside the literal', () => {
    expect(keepsItsOwnDay("select 'it''s current_date'")).toBe(false);
    expect(keepsItsOwnDay("select 'it''s', current_date")).toBe(true);
  });

  it('does not read a closing parenthesis it never opened', () => {
    expect(() => keepsItsOwnDay('select pg_catalog.now()::pg_catalog.date)')).not.toThrow();
    expect(keepsItsOwnDay('select pg_catalog.now()::pg_catalog.date)')).toBe(true);
    expect(() => keepsItsOwnDay('select pg_catalog.date(')).not.toThrow();
  });
});
