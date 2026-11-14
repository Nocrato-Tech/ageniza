/**
 * The clock of the reads that count by day and by month (the counters of the agency's Início, the progress of the portal's): one instant
 * gives the São Paulo day, the first day of this month, of the month before and of the next, and the time of day there, so every counter
 * of one answer agrees. The common table expressions are `clock_instant`, `clock_day` and `clock`; write them after `with`, and bind one
 * value first, the instant a test injects or `null` for the database's own clock.
 *
 * The database converts days with `app_private.sao_paulo_date` alone, so no time-zone name is written here: the time of day is the time
 * since the start of today, which is the end of yesterday plus the minute `sao_paulo_end_of_day` leaves out. The months are arithmetic on
 * the day as a plain timestamp, so the session's zone never moves them.
 */
export const CLOCK_CTES = `
  clock_instant as (
    select coalesce(?::timestamptz, pg_catalog.now()) as now_at
  ), clock_day as (
    select clock_instant.now_at, app_private.sao_paulo_date(clock_instant.now_at) as today from clock_instant
  ), clock as (
    select clock_day.today,
      date_trunc('month', clock_day.today::timestamp)::date as month_start,
      (date_trunc('month', clock_day.today::timestamp) - interval '1 month')::date as last_month_start,
      (date_trunc('month', clock_day.today::timestamp) + interval '1 month')::date as next_month_start,
      (clock_day.now_at - (app_private.sao_paulo_end_of_day(clock_day.today - 1) + interval '1 minute'))::time as local_time
    from clock_day
  )
`;
