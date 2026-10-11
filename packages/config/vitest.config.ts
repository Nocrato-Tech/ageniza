// server.test.ts sets `process.env.TZ` to tell the zone of the process from America/Sao_Paulo (#373).
// That only reaches the clock in a child process: a worker thread keeps its own copy of the environment.
export default {
  test: {
    pool: 'forks'
  }
};
