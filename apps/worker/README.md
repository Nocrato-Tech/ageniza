# `@ageniza/worker`

The worker is a UI-free Node/TypeScript process for asynchronous work. Durable jobs go through a PostgreSQL-backed queue ([pg-boss](https://github.com/timgit/pg-boss)) on the project's own database, so a job survives a restart or a deploy. There is no Redis or other broker.

`src/worker.ts` is the single bootstrap composition point. It owns the shared structured logger, Knex database client, durable queue, readiness, internal probe listener, and shutdown. Do not recreate those concerns in job handlers. It verifies the database with `SELECT 1`, starts the queue, and only then becomes ready; readiness probes check the database again.

The process keeps a loopback-only HTTP listener (`127.0.0.1:3002` by default) for container/runtime probes. `GET /health` is liveness and `GET /ready` is database-gated readiness. `WORKER_HEALTH_HOST` accepts only `127.0.0.1` or `::1`; never publish this port externally.

## Durable jobs

Register a `DurableJobDefinition` on `runtime.queue` before `runtime.start()`:

```ts
const runtime = createWorkerRuntime({ config, logger });
runtime.queue?.register<{ assetId: string }>({
  name: 'media.thumbnail',
  retryLimit: 3,            // retries after the first attempt; at least 1
  retryDelaySeconds: 10,    // first retry; later ones back off exponentially
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,     // an active job still running after this is treated as crashed
  handler: async ({ payload, attempt }, { logger, signal }) => {
    // Revalidate tenant and capability for payload.assetId before touching any data.
  }
});
await runtime.start();
```

The values above are the defaults. `WORKER_CONCURRENCY` (default `1`, at most `2`) sets how many jobs run at once; kept deliberately narrow because video processing (below) runs `ffmpeg`, which saturates CPU on a VPS shared with PostgreSQL and the API.

### Contract every handler must follow

- **Delivery is at least once.** A job is never handed to two workers at the same time: fetching locks it with `FOR UPDATE SKIP LOCKED` and marks it active in the same statement. But a job interrupted by a deploy or a crash runs again, so **handlers must be idempotent**. `attempt` tells you whether this is a repeat.
- **The queue is not an authorization boundary.** Payloads are data. Revalidate tenant and capability for every identifier in a payload before reading or writing tenant data.
- **Never put secrets in a payload.** Payloads are stored in `pgboss.job` and kept after completion. Send identifiers and look the rest up.
- **Honour `signal`.** It aborts when the worker stops; stop promptly and let the job be retried.

Telemetry is automatic: each job logs its queue, job id, attempt, duration, and status. Payloads and error messages are never logged, since either can carry tenant data.

### Retries and failures

A handler that throws is retried with exponential backoff until `retryLimit` is used up. It then ends in state `failed`, and pg-boss copies it into the queue's dead letter queue, `<name>.dead`. Nothing consumes a dead letter queue: the job stays visible there, in state `created`, until pg-boss retention removes it (14 days by default). To inspect failures without reading payloads:

```sql
select id, state, created_on from pgboss.job where name = 'media.thumbnail.dead' order by created_on desc;
```

### Deploys and shutdown

On `SIGTERM` the queue stops fetching, waits up to 45 seconds for running jobs, and then fails whatever is still running back into retry. The container's `stop_grace_period` is 60 seconds so that drain finishes before Docker sends `SIGKILL`. If the process is killed anyway, its active jobs expire after `expireInSeconds` and are retried. Either way the job is not lost, which is why `retryLimit` must be at least 1.

This is the answer to [ADR 0010](../../docs/adr/0010-vps-edge-and-production-deployment.md)'s condition on duplicate consumption during the worker handoff; see its durable-queue amendment.

### Schema and upgrades

The `pgboss` schema is created by a Knex migration in [`packages/database/migrations`](../../packages/database/migrations), owned by the migration role, and holds the frozen pg-boss construction SQL. The worker runs pg-boss with `migrate` and `createSchema` disabled and connects as `ageniza_app`, which has data access to that schema but no `CREATE`. Queues are created without partitions and index maintenance (`REINDEX`) is disabled for the same reason, so the running worker never executes DDL.

If the installed pg-boss expects a different schema version, the worker refuses to start and never becomes ready. To upgrade pg-boss, pin the new exact version and add a new forward-only migration built from `getMigrationPlans('pgboss', <current version>)`. `src/queue.test.ts` fails until the migrations create the schema version the installed package expects.

## Video processing (issue #24)

`src/media-video-job.ts` registers the only durable job the worker currently ships,
`media.process-video` (name shared with the API's producer through `@ageniza/contracts`'s
`MEDIA_VIDEO_PROCESSING_JOB_NAME`), whenever `createWorkerRuntime` is given object storage
(`R2_*`/`config.storage`; see `packages/config/src/server.ts`'s `WorkerStorageConfig` and
`MediaProcessingConfig`). The API's media module (`apps/api/src/modules/media/README.md`) queues
it right after a video upload's `HeadObject` confirms it.

For a confirmed video referenced by the job's `assetId`/`agencyId` (re-validated against the
database and RLS on every run -- see `src/media-repository.ts`), the handler:

1. downloads the original from R2/MinIO to a fresh OS temp directory (`src/media-storage.ts`);
2. probes it with `ffprobe` and fails explicitly if its duration exceeds
   `MEDIA_PROCESSING_MAX_DURATION_SECONDS`;
3. runs `ffmpeg` twice to produce a thumbnail (`MEDIA_THUMBNAIL_WIDTH_PIXELS` wide) and a preview
   capped at `MEDIA_PREVIEW_MAX_HEIGHT_PIXELS` tall and `MEDIA_PREVIEW_MAX_OUTPUT_BYTES` (`src/media-ffmpeg.ts`)
   -- the original itself is never transcoded;
4. uploads both outputs back under the asset's own key prefix and records duration/sizes, or a
   short, non-sensitive failure reason -- never raw ffmpeg output or a signed URL.

Every `ffmpeg`/`ffprobe` invocation is timeout-bounded (`MEDIA_PROCESSING_TIMEOUT_SECONDS`, killed
with `SIGKILL` past it), restricted to the `file`/`pipe` protocols (a crafted input cannot make it
reach the network), and the job's own `expireInSeconds` (`ffmpegTimeoutSeconds * 2 + 120`) bounds
the whole run so pg-boss retries a stuck job within `WORKER_CONCURRENCY`'s limit. The temporary
directory is always removed in a `finally`, including on failure -- no file is left on disk.

## In-process jobs

`runtime.jobs` (`src/jobs.ts`) runs explicitly submitted work in memory, with bounded retries. It is not durable: use it only for work that may be lost on restart. Shutdown rejects new work, drains handlers, then closes Knex.

`WORKER_SMOKE_JOB=true` explicitly bypasses the normal database readiness check, runs `worker.smoke` through the in-process processor, and shuts down. It starts no durable queue; this is the deterministic bootstrap check for environments without a live database.

## Tests

```sh
pnpm --filter @ageniza/worker test               # unit tests, no database
pnpm db:start && pnpm db:migrate && pnpm docker:up
pnpm --filter @ageniza/worker test:integration   # queue + video processing against local PostgreSQL/MinIO
```

The queue integration suite covers a job surviving a worker restart, backoff retries, a permanent failure reaching its dead letter queue, draining on shutdown, and a job that outlives the drain being completed by the next worker.

The video processing suite requires a real `ffmpeg`/`ffprobe` on `PATH` (issue #24) -- there is no
useful way to fake process spawning without losing coverage of real timeouts, exit codes, and the
`-protocol_whitelist` network restriction. `media-ffmpeg.integration.test.ts` exercises the ffmpeg
wrapper directly (probing, thumbnail/preview generation, size cap, timeout, abort, and the crafted
network-reference input); `media-video-job.integration.test.ts` runs the full job against real
PostgreSQL and MinIO (the confirmed-asset lookup and RLS, the ready/failed/no-op-on-retry outcomes,
and the "no temp file survives a failure" acceptance criterion). If `ffmpeg` is unavailable on the
host, run the same suite inside the worker's own image instead, which is where CI and production
get it from: `docker compose build worker && docker compose run --rm worker ffmpeg -version` to
verify, then run the test command inside a container built from `apps/worker/Dockerfile`.
