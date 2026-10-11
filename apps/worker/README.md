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

The values above are the defaults. `WORKER_CONCURRENCY` (default `1`, at most `4`) is the global
worker budget. Video processing below has its own concurrency of `1`, so raising the global ceiling
can increase throughput for lighter queues without running multiple ffmpeg jobs at once.

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

### Scheduled jobs

A definition may carry `schedule: { cron, timeZone }`. The queue registers it at every start as an upsert in `pgboss.schedule` keyed by the job name, so restarting the worker, or running two, never adds a second schedule, and pg-boss's cron monitor (on, in the worker only; the API's producer keeps it off) sends the job when it is due. One worker wins each pass of the monitor and the send is deduplicated per minute, so a due tick makes one job. **A tick missed while no worker runs is not replayed**: the next tick is the next run. A job that cannot wait for it declares `runOnStart: true`, which sends one job each time the queue starts (two workers starting together send two, so the handler must be idempotent), and `clients.archive-due` does both: hourly, and at every start.

### Schema and upgrades

The `pgboss` schema is created by a Knex migration in [`packages/database/migrations`](../../packages/database/migrations), owned by the migration role, and holds the frozen pg-boss construction SQL. The worker runs pg-boss with `migrate` and `createSchema` disabled and connects as `ageniza_app`, which has data access to that schema but no `CREATE`. Queues are created without partitions and index maintenance (`REINDEX`) is disabled for the same reason, so the running worker never executes DDL.

If the installed pg-boss expects a different schema version, the worker refuses to start and never becomes ready. To upgrade pg-boss, pin the new exact version and add a new forward-only migration built from `getMigrationPlans('pgboss', <current version>)`. `src/queue.test.ts` fails until the migrations create the schema version the installed package expects.

## Closing ended contracts (issue #133)

`src/archive-due-clients-job.ts` registers `clients.archive-due`, the first scheduled business job: at ten past every hour in `America/Sao_Paulo` (so also at 00:10), and once at every start of the worker, it runs `select app_private.archive_due_clients()` and logs how many clients it archived, and nothing else. All of the rule is in that function, which archives exactly what the archive route archives (portal closed, pending portal invitations revoked, links kept, audited) for each client whose `closing_date` is already past. The worker calls it as `ageniza_app`, with no user and no wider access: this is the single-purpose `security definer` exception in [`docs/business/structural-changes.md`](../../docs/business/structural-changes.md), safe because the function can do nothing else, whoever calls it.

`src/media-purge-job.ts` registers `media.purge-removed`, the retention of a removed media (issue #607, decision of 2026-10-11): every day at 03:40 in `America/Sao_Paulo`, and once at every start, it asks `app_private.media_due_for_purge` which media was removed more than 30 days ago, is not yet purged and is not used by a content waiting for approval, approved or published, deletes from the bucket the original, the staging key and the thumbnail and preview of a video, and only then calls `app_private.mark_media_purged`, which stamps `purged_at` and audits `media.purged`; the row stays and the quota stops counting it. The two functions answer only a caller with no user bound to the transaction, as the worker is. Registered whenever object storage is configured (it uses the same client as video processing). A delete that fails leaves that media unstamped and the run goes on: it is offered again the next day, and the log carries only its id and the name of the error. A run that dies between the delete and the stamp is finished by the next one (the storage answers the repeated delete as done). The module that explains the flow from the media's side is `apps/api/src/modules/media/README.md`.

The handler is idempotent (a run that finds nothing due archives none, which is what lets it run hourly and at every start) and lets a database error through, so a lost race with a concurrent change of the client's invitations is retried by the queue. The log carries the queue, job id, attempt and `archived`, no client, no person. To fire it by hand locally see [`docs/local-environment.md`](../../docs/local-environment.md). Decision: `docs/business/decisions/2026-10-07-o-job-diario-de-encerramento-liga-o-agendamento-do-worker.md`.

## E-mail to the client (issue #260)

`src/client-content-email-job.ts` registers `notifications.send-client-content-emails`: every minute in `America/Sao_Paulo`, and once at every start, it sends the e-mail of "contents to approve" and the daily summary of "published" that the notification queue says are due. It is registered only when `SMTP_URL`, `EMAIL_FROM` and `APP_PUBLIC_URL` are set (production refuses to start without them); otherwise the worker logs that e-mail is off. The queue decides *when* (15 minutes after the last send for approval, the end of the day in Brasília for the summary: `app_private.notification_send_after`); this job only asks.

Each pass is four short transactions of the queue's functions (`src/notification-queue.ts`), because `ageniza_app` has no privilege on the table and the worker binds no actor: `claim_notification_batch` (the lease of 10 minutes, one worker per group), then, per group, `recheck_notifications` (drops what stopped being true, so a client archived after the claim never gets the e-mail; it waits for an archive in flight and refuses an item whose lease ran out), the send, and `mark_notifications_sent` (or `fail_notifications` with a code `smtp_*`, never the text of the provider, which carries the address). One e-mail per person, client and type, listing every content of the group by title and planned date; the link is `APP_PUBLIC_URL/portal/<client>/calendario`, with no token. What comes from the content is escaped in the HTML.

A run claims at most 10 groups at a time and 6 times, and starts no claim after 4 minutes, so the last group is rechecked well inside the lease. Delivery is at least once: an e-mail repeats only if the worker dies between the send and the stamp, which is why the stamp is tried three times. The log carries counts and codes only. Decisions: `docs/business/decisions/2026-10-11-email-ao-cliente-link-texto-e-cadencia-do-worker.md` and `2026-10-11-a-fila-reconfere-o-item-logo-antes-do-envio.md`.

## Video processing (issue #24)

`src/media-video-job.ts` registers the durable video job,
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
reach the network), and the handler has a whole-job abort budget covering ffprobe, both ffmpeg
calls and object-storage I/O. The AWS SDK streams receive the same abort signal. pg-boss expiry is
60 seconds later (`3 * ffmpegTimeoutSeconds + 180`) as a crash-recovery backstop. The temporary
directory is always removed in a `finally`, including on failure -- no file is left on disk.

## In-process jobs

`runtime.jobs` (`src/jobs.ts`) runs explicitly submitted work in memory, with bounded retries. It is not durable: use it only for work that may be lost on restart. Shutdown rejects new work, drains handlers, then closes Knex.

`WORKER_SMOKE_JOB=true` explicitly bypasses the normal database readiness check, runs `worker.smoke` through the in-process processor, and shuts down. It starts no durable queue; this is the deterministic bootstrap check for environments without a live database.

## Tests

```sh
pnpm --filter @ageniza/worker test               # unit tests, no database
pnpm db:start && pnpm db:migrate && pnpm storage:start
pnpm --filter @ageniza/worker test:integration   # queue + video processing against local PostgreSQL/MinIO
```

The queue integration suite covers a job surviving a worker restart, backoff retries, a permanent failure reaching its dead letter queue, draining on shutdown, and a job that outlives the drain being completed by the next worker. `client-content-email-job.integration.test.ts` covers the e-mail to the client against the real queue functions (three sends in a row make one e-mail, nothing for an archived client or a suspended agency, even when it happens after the claim, no token or internal data in the body or the log, two concurrent workers, a provider that fails). `archive-due-clients-job.integration.test.ts` covers the daily job against the real function (yesterday archived, today not, none the second time), its retry after a lost deadlock, the single schedule across restarts, and the cron monitor turning a due schedule into a running job. `media-purge-job.integration.test.ts` covers the retention against the real function and the real local object storage (files of a media removed more than 30 days ago deleted and the row stamped; none of a media removed less, never removed, or used by a content waiting for approval, approved or published; the second run changing nothing; a run that died between the delete and the stamp finished; a media whose delete failed left for the next run).

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
