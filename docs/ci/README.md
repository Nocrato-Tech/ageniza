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

The policy guards only `packages/database/migrations`: this is the canonical append-only Knex history for schema and RLS policies. It accepts additions only when the filename is versioned (`8+ digits`, then `_` or `-`, then a `.mjs` name); it rejects edits, deletions, and renames of existing migrations.

## Local PostgreSQL job

`CI / PostgreSQL local database` starts the `postgres` service from `compose.yml` (which creates the `ageniza_app` role), creates its own database `ageniza_ci` (the harnesses have no default and refuse a database named `ageniza`, so the job exports `DATABASE_URL` and `MIGRATION_DATABASE_URL` for it), applies every migration to the empty database with `pnpm db:migrate`, then runs `pnpm db:test:local`. The suite proves Knex transactions and parameter binding, that the application role is neither superuser nor `BYPASSRLS`, and that a user of agency A cannot SELECT, INSERT, UPDATE, or DELETE agency B's rows. It uses no secret, remote URL, or production credential.

The local equivalents are `pnpm db:start`, `pnpm db:migrate`, and `pnpm db:test:local`; Docker must be running, and the two variables must point at a database of your own (see [Ambiente local](../local-environment.md#banco-dos-testes-de-integração)). `pnpm db:reset` removes the whole compose database volume (the owner's `ageniza` and every agent database), then starts the database again and recreates `ageniza` from migrations, so it belongs to the owner only; an agent starts over with `drop database` on its own database, as in [ambiente local](../local-environment.md#banco-dos-testes-de-integração).

## API production closure

`better-auth` declares `vitest` as an optional peer, and pnpm resolves it because vitest exists in this workspace, which would ship vitest and its chain in the production API image (issue #281). The `.pnpmfile.cjs` hook removes that peer before resolution; all four Dockerfiles copy the file because `pnpm install --frozen-lockfile` verifies the `pnpmfileChecksum` recorded in `pnpm-lock.yaml` against it and fails when it is missing. Any edit to the file changes the checksum, so the lockfile must be regenerated in the same change. The hook is a silent no-op once `better-auth` stops declaring the peer, and can be deleted then.

`CI / Quality gates` runs `node scripts/ci/verify-api-production-closure.mjs`, which deploys the API with `--prod` into a temporary directory and fails if the closure contains vitest or its chain. It turns the "no vitest in the production image" acceptance into a check instead of a manual inspection.

## Branch protections and promotion

The organization is on GitHub Free and this repository is private, so GitHub rejects rulesets, branch protection, Environment reviewers, and CODEOWNERS enforcement. Until the plan changes, `main` and `develop` are guarded by:

| Guard | Enforced where | What it does |
| --- | --- | --- |
| `.githooks/pre-push` | Each clone (installed by `pnpm install`) | Refuses `git push` to `main` or `develop`. Bypassable with `--no-verify`; it prevents accidents. |
| `Production release / Release origin guard` | GitHub Actions | A push to `main` publishes, migrates, or deploys only if it is not a force push and is the merge commit of a pull request from this repository's `develop` or `hotfix/*`. |
| `ageniza-deploy` release verification | Production VPS | The host deploys only the manifest of a push-to-`main` run of `production.yml` for a commit on `main`; production secrets never live in GitHub. See the [production deploy runbook](../infra/production-deploy.md). |
| `Branch guard` | GitHub Actions | Any force push, or any commit on `main` or `develop` that is not a merged pull request, fails the run and opens an issue assigned to @PedroV1dal. |
| `Pull request reviewer` | GitHub Actions | Requests review from @PedroV1dal on pull requests to `develop` and `main`. |

Team agreement, not technically enforced: merge only pull requests with an approval and green CI. GitHub itself never merges a pull request with conflicts. A direct push can edit these workflows too, so treat every `Branch guard` issue as an incident.

When the organization moves to GitHub Team, replace this with rulesets on `develop` and `main`: require pull requests with one approval (code owner on `main`), dismiss stale approvals, require conversation resolution and up-to-date branches, block force pushes and deletion, allow only repository admins to bypass for pull requests, and require these checks (plus `Release path validation` on `main`):

- `CI / Branch route`
- `CI / Migration policy`
- `CI / Quality gates`
- `CI / Docker images`
- `CI / PostgreSQL local database`

Feature, fix, and refactor branches merge into `develop`. `develop` is the integration branch only: it has no remote deployment environment. A pull request to `main` is a production-promotion gate and must originate from `develop`; the workflow permits `hotfix/*` only as the documented production exception. Production deployment belongs to a separate main-only workflow using GitHub's `production` Environment, never this CI workflow or a `develop` environment; see the [production deploy runbook](../infra/production-deploy.md).

After a `hotfix/*` branch is merged to `main`, immediately open and merge its reconciliation pull request into `develop` (or merge the resulting `main` delta into `develop` if branch policy requires it). This prevents the next release promotion from losing the production correction.
