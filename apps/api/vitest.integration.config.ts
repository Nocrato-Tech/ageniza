// The API integration files run against one shared PostgreSQL database, and the local server's
// connection budget is small: `max_connections=100` with three slots reserved for superusers, and
// `ageniza_app` is not a superuser, so only 97 non-superuser connections are ever available
// (`superuser_reserved_connections`). Every test file opens its own pools -- a `pg` Pool for
// Better Auth and auditing, a Knex client for the domain routes, an owner client, and pg-boss's
// producer -- roughly fourteen connections each. Eight files in parallel overshoot the budget and
// new connections are refused with SQLSTATE 53300 ("remaining connection slots are reserved for
// roles with the SUPERUSER attribute"), which surfaces as an intermittent 500 from whichever
// request happens to need a connection at that moment. Running the files sequentially keeps the
// footprint well inside the budget; see issue #167.
export default {
  test: {
    fileParallelism: false
  }
};
