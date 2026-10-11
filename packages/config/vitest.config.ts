// server.test.ts sets `process.env.TZ` to tell the zone of the process from America/Sao_Paulo (#373). That only
// reaches the clock in a child process: a worker thread keeps its own copy of the environment.
// `forks` is already the vitest 3 default, so this line only keeps a different future default from changing it,
// and `--pool=threads` still overrides it. What turns a run red when the zone cannot be changed is the `expect`
// in `setProcessZone` of server.test.ts.
export default {
  test: {
    pool: 'forks'
  }
};
