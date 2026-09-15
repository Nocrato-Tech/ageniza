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

The policy guards only `supabase/migrations`: this is the canonical append-only source for schema and RLS policies. It accepts additions only when the filename is a versioned SQL name (`8+ digits`, then `_` or `-`, then a `.sql` name); it rejects edits, deletions, and renames of existing migrations. Do not create a competing Knex migration history.

## Local Supabase job

`CI / Supabase local database` uses the pinned Supabase CLI `2.117.0` to start Docker-backed local services, runs `supabase db reset --local --yes`, then runs the cross-platform `pnpm db:test:local` command. The test hook defaults only to the loopback database URL and proves Knex transactions, parameter binding, lifecycle, and an RLS isolation harness where tenant A cannot read tenant B. It uses no environment secret, cloud URL, or production credential.

The local equivalents are `pnpm db:start`, `pnpm db:reset`, and `pnpm db:test:local`. Those commands use Supabase CLI `2.117.0`; Docker must be running. Stop the stack after local work with `pnpm dlx supabase@2.117.0 stop --no-backup`.

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
- `CI / Supabase local database`

Feature, fix, and refactor branches merge into `develop`. `develop` is the integration branch only: it has no remote deployment environment. A pull request to `main` is a production-promotion gate and must originate from `develop`; the workflow permits `hotfix/*` only as the documented production exception. Production deployment belongs to a separate main-only workflow using GitHub's `production` Environment, never this CI workflow or a `develop` environment; see the [production deploy runbook](../infra/production-deploy.md).

After a `hotfix/*` branch is merged to `main`, immediately open and merge its reconciliation pull request into `develop` (or merge the resulting `main` delta into `develop` if branch policy requires it). This prevents the next release promotion from losing the production correction.
