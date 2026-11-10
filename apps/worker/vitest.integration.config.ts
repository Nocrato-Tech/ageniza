// The worker integration files share one PostgreSQL database and one global notification queue: the job of the e-mails claims every item
// that is due, whoever queued it, and the reminders enqueue for every round of the database. Files that overlap would send each other's
// items (and fail on each other's counts), so they run one at a time, as the database package and the API suite do for their shared
// state (`packages/database/vitest.integration.config.ts`, issue #167). The files are selected by the pattern the script passes
// (`integration.test.ts`), which `scripts/ci/integration-test-lists.test.mjs` checks against every integration file of the worker.
export default {
  test: {
    fileParallelism: false
  }
};
