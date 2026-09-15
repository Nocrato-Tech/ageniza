# `@ageniza/worker`

The worker is a UI-free Node/TypeScript process for explicitly submitted asynchronous work. It intentionally has no Redis, BullMQ, polling loop, or durable queue: selecting a durable transport is a separate product/infrastructure decision.

`src/worker.ts` is the single bootstrap composition point. It owns the shared structured logger, Knex database client, readiness, jobs, internal probe listener, and shutdown. Do not recreate those concerns in job handlers. It verifies the database with `SELECT 1` before becoming ready and checks it again for each readiness probe.

The process keeps a loopback-only HTTP listener (`127.0.0.1:3002` by default) for container/runtime probes. `GET /health` is liveness and `GET /ready` is database-gated readiness. `WORKER_HEALTH_HOST` accepts only `127.0.0.1` or `::1`; never publish this port externally.

## Add a job

Define a typed `RegisteredJob<TPayload>` in `src/` and submit it through `runtime.jobs.submit`. Handlers receive a contextual logger and abort signal; set bounded retry options for transient failures.

```ts
const job: RegisteredJob<{ id: string }> = {
  name: 'example.rebuild',
  retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  handler: async ({ payload }, { logger, signal }) => {
    if (!signal.aborted) logger.info({ id: payload.id }, 'Rebuilding');
  }
};
await runtime.jobs.submit({ name: 'example.rebuild', payload: { id } }, job);
```

Shutdown rejects new work, drains handlers, then closes Knex. `SIGINT` and `SIGTERM` trigger that same sequence. `WORKER_SMOKE_JOB=true` explicitly bypasses the normal database readiness check, runs `worker.smoke`, and shuts down; this is the deterministic bootstrap check for environments without a live database.
