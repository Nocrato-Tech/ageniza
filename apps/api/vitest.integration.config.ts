// Every integration file runs against a database of its own, cloned from a model that is migrated once per run
// (`integration-setup/`, issue #792), so the files run in parallel and none can read or lock another's rows. Each
// file opens roughly a dozen connections, and the server allows 97 non-superuser ones (`max_connections=100` minus
// three reserved, #167): `maxWorkers` is the knob. CI uses 4; a developer machine that shares its Postgres with
// other agents passes `--maxWorkers=2`.
export default {
  test: {
    globalSetup: ['./integration-setup/global-setup.ts'],
    setupFiles: ['./integration-setup/per-file-database.ts'],
    fileParallelism: true,
    maxWorkers: 4,
    // Files share the machine now and a race test waits out the deadlock_timeout of its waiter (1s on the server): the 5s and 10s defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
};
