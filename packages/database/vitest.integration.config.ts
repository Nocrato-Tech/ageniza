// The database integration files share one PostgreSQL database, and one of them counts the global
// authorization metadata (`tenancy.integration.test.ts` expects exactly the preset `role_permissions`
// rows). A file that seeds a custom role -- the one-permission BFLA probe in
// `client-lifecycle.integration.test.ts` -- would make that count flaky while the files overlap.
// Running them sequentially also keeps the connection footprint inside the local budget, the same
// reason the API integration suite sets `fileParallelism: false` (issue #167).
export default {
  test: {
    fileParallelism: false
  }
};
