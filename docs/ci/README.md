# Continuous integration

The `CI` workflow runs on pull requests whose target is `develop` or `main`. It has read-only repository token access, cancels superseded runs for the same pull request, uses the Node version in `.nvmrc`, enables the pnpm version declared by the root `packageManager` field through Corepack, caches pnpm's store, and installs only from `pnpm-lock.yaml` with `--frozen-lockfile`.

## Local equivalent

Run the normal quality gates from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

To check a branch's migration policy locally, supply the commit range that the pull request will compare:

```sh
node scripts/ci/validate-migrations.mjs --base origin/develop --head HEAD
```

The policy guards `supabase/migrations` and `packages/database/migrations`. It accepts additions only when the filename is a versioned SQL name (`8+ digits`, then `_` or `-`, then a `.sql` name); it rejects edits, deletions, and renames of existing migrations. With no guarded migration directory in the repository yet, it succeeds after reporting that no guarded migration change exists, so it is a real diff check without pretending that a database foundation exists.

## Local Supabase job

`CI / Supabase local eligibility` always reports whether both `supabase/config.toml` and `supabase/migrations` exist. Only then does `CI / Supabase local database` start the Supabase CLI's Docker-backed local stack and run `supabase db reset --local --yes`; it uses no environment, secret, URL, or production credential.

There is deliberately no fictional integration or tenant test command. Once a database-backed suite is created, add an executable `scripts/ci/test-supabase-local.sh`; the local job will run that hook after the reset. Until then, the job emits an explicit notice that no integration or tenant suite ran. Do not make `CI / Supabase local database` a required check while it is conditional.

## Branch protections and promotion

Configure protection/rulesets for both `develop` and `main` to require pull requests, require current approvals as appropriate for the repository, dismiss stale approvals, and require these checks:

- `CI / Branch route`
- `CI / Migration policy`
- `CI / Quality gates`
- `CI / Supabase local eligibility`

Feature, fix, and refactor branches merge into `develop`. `develop` is the integration branch only: it has no remote deployment environment. A pull request to `main` is a production-promotion gate and must originate from `develop`; the workflow permits `hotfix/*` only as the documented production exception. Production deployment belongs to a separate main-only workflow using GitHub's `production` Environment, never this CI workflow or a `develop` environment.

After a `hotfix/*` branch is merged to `main`, immediately open and merge its reconciliation pull request into `develop` (or merge the resulting `main` delta into `develop` if branch policy requires it). This prevents the next release promotion from losing the production correction.
