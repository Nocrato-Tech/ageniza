import type { Knex } from 'knex';

export interface LockBarrierOptions {
  /** `ilike` pattern of the statement the blocked backend runs; any backend blocked by the holder counts when omitted. */
  readonly blockedStatement?: string;
  /** Seconds the holder waits for a backend to block before it gives up and raises. */
  readonly timeoutSeconds?: number;
  /**
   * `deadlock_timeout`, in seconds, of the holder's transaction only (`set_config(..., true)`); 10 when omitted. It has to be
   * longer than the other backend's, and the other backend runs with the server's (1s) or longer. Changing a server
   * setting takes a superuser, which the holder of a race test is (the owner connection).
   */
  readonly holderDeadlockTimeoutSeconds?: number;
}

const ARM_SQL = `select pg_catalog.set_config('ageniza_test.lock_barrier', ?::text, true)`;

const BARRIER_SQL = `
  do $barrier$
  declare
    v_config jsonb := pg_catalog.current_setting('ageniza_test.lock_barrier')::jsonb;
    v_pattern text := v_config ->> 'blockedStatement';
    v_deadline timestamptz := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => (v_config ->> 'timeoutSeconds')::int);
    v_holder_timeout text := (v_config ->> 'holderDeadlockTimeoutSeconds') || 's';
  begin
    loop
      perform pg_catalog.pg_stat_clear_snapshot();
      exit when exists (
        select 1 from pg_catalog.pg_stat_activity activity
        where activity.datname = pg_catalog.current_database()
          and pg_catalog.pg_backend_pid() = any (pg_catalog.pg_blocking_pids(activity.pid))
          and (v_pattern is null or activity.query ilike v_pattern)
      );
      if pg_catalog.clock_timestamp() > v_deadline then
        raise exception 'No backend ever waited on a lock held by this transaction.';
      end if;
      perform pg_catalog.pg_sleep(0.005);
    end loop;
    -- The cycle closes with this statement. Whoever's deadlock_timeout expires first runs the check and is aborted, so the
    -- holder's is made longer than any other backend's: the waiter is the victim by margin, not by a race of milliseconds.
    execute pg_catalog.format(v_config ->> 'statement', variadic array(select pg_catalog.jsonb_array_elements_text(v_config -> 'bindings')));
  end
  $barrier$
`;

/**
 * Makes an open transaction (the holder of a race test) run `statement` from inside the database, the moment another
 * backend is blocked by it, so that the statement closes a lock cycle without a step of the test process in between.
 *
 * The deadlock detector aborts the backend whose `deadlock_timeout` expires first with the cycle already closed. With the
 * same timeout on both sides that is the backend that waited first only by the few milliseconds between the two waits, and
 * a busy machine (several test files at once, GC) delays the waiter by more than that: the database then aborts the holder
 * and the test fails with the holder's own 40P01 (#745, #762, and again on develop after #794). So the holder gets a
 * `deadlock_timeout` of its own, longer than anyone else's, for its transaction only: whatever the load, the other backend
 * checks first and is the victim. Call it BEFORE starting the transaction under test, never after, and wait for the
 * returned promise together with the response; it rejects when no backend blocks within `timeoutSeconds`.
 *
 * `statement` is a `format()` template whose `%L` placeholders take `bindings` as quoted literals, so a value never
 * reaches the SQL text unquoted: `select id from public.clients where id = %L::uuid for share`.
 */
export const requestLockOnceBlocked = async (
  holder: Pick<Knex, 'raw'>,
  statement: string,
  bindings: readonly string[],
  options: LockBarrierOptions = {}
): Promise<void> => {
  await holder.raw(ARM_SQL, [JSON.stringify({
    statement,
    bindings,
    blockedStatement: options.blockedStatement ?? null,
    timeoutSeconds: options.timeoutSeconds ?? 10,
    holderDeadlockTimeoutSeconds: options.holderDeadlockTimeoutSeconds ?? 10
  })]);
  await holder.raw(BARRIER_SQL);
};

export interface WaitForBlockedOptions {
  /** `ilike` pattern of the statement the waiting backend runs; any backend blocked by the blocker counts when omitted. */
  readonly blockedStatement?: string;
  /** How many backends must wait on the blocker before the promise settles; one when omitted. */
  readonly waiters?: number;
  readonly timeoutMs?: number;
}

export const backendPid = async (connection: Pick<Knex, 'raw'>): Promise<number> => {
  const result = await connection.raw<{ rows: Array<{ pid: number }> }>('select pg_catalog.pg_backend_pid() as pid');
  return Number(result.rows[0]?.pid);
};

/**
 * Resolves with the pids of the backends of THIS database that wait on a lock held by `blockerPid`, as soon as there are
 * `waiters` of them, and rejects when they never show up. A test that has to sequence two transactions waits for this
 * instead of sleeping, and it is scoped to the database and to the blocker: the same wait read from `pg_locks` or from
 * `wait_event_type = 'Lock'` alone is satisfied by any other wait on a shared server (#767).
 *
 * `observer` must be a connection outside the transactions under test, autocommit, of a role that sees other backends.
 */
export const waitForBackendsBlockedBy = async (
  observer: Pick<Knex, 'raw'>,
  blockerPid: number,
  options: WaitForBlockedOptions = {}
): Promise<readonly number[]> => {
  const wanted = options.waiters ?? 1;
  const pattern = options.blockedStatement ?? null;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const result = await observer.raw<{ rows: Array<{ pid: number }> }>(`
      select activity.pid
      from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and ?::int = any (pg_catalog.pg_blocking_pids(activity.pid))
        and (?::text is null or activity.query ilike ?::text)
    `, [blockerPid, pattern, pattern]);
    if (result.rows.length >= wanted) return result.rows.map((row) => Number(row.pid));
    if (Date.now() > deadline) throw new Error(`Fewer than ${wanted} backend(s) ever waited on a lock held by backend ${blockerPid}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
