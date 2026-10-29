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

The policy guards only `packages/database/migrations`: this is the canonical append-only Knex history for schema and RLS policies. It accepts additions only when the filename is versioned (`8+ digits`, then `_` or `-`, then a `.mjs` name); it rejects edits, deletions, and renames of existing migrations. It also rejects a new migration whose version (the leading digits) is not greater than the newest migration on the base: the version follows merge order, so a fresh database and an existing one apply migrations in the same order. Rename a late migration with `git mv` before it is merged, never after.

## Local PostgreSQL job

`CI / PostgreSQL local database` starts the `postgres` service from `compose.yml` (which creates the `ageniza_app` role), creates its own database `ageniza_ci` (the harnesses have no default and refuse a database named `ageniza`, so the job exports `DATABASE_URL` and `MIGRATION_DATABASE_URL` for it), applies every migration to the empty database with `pnpm db:migrate`, then runs `pnpm db:test:local`. The suite proves Knex transactions and parameter binding, that the application role is neither superuser nor `BYPASSRLS`, and that a user of agency A cannot SELECT, INSERT, UPDATE, or DELETE agency B's rows. It uses no secret, remote URL, or production credential.

### When the job is skipped (issue #789)

The job takes about 14 minutes, so a pull request that cannot reach the database, the API or the worker does not need it. The rule is a fixed **allow list of what may skip it**, never a list of what needs it: a file nobody planned for, in a place nobody planned, is outside the list and runs the whole job (the lesson of issue #511).

The job is skipped only when **every** file the pull request changes is one of:

| Allowed path | Why it cannot matter to the job |
| --- | --- |
| `apps/web/**` | The SPA. The API, the worker and the packages do not import it (they only name `apps/web/public` in comments). |
| `docs/**` | Documentation. The API only *writes* `docs/api` (`pnpm api:docs`), and `Quality gates` checks that it is current. |
| `*.md` at the repository root | `README.md`, `AGENTS.md`, `CONTRIBUTING.md` and the like. A `.md` inside a code folder (`packages/database/README.md`, `specs/`) is **not** on the list. |

Everything else runs the job, with no exception to list: `packages/**`, `apps/api/**`, `apps/worker/**`, `.github/**`, `scripts/**`, `infra/**`, `pnpm-lock.yaml`, `package.json`, `tsconfig*`, the root configs, and any new path. Also always run: a push to `develop` or `main` (what landed is what ships), an empty diff, and a diff that could not be computed.

How it works, in `scripts/ci/decide-database-job.mjs` (the list is the `ALLOWED` constant):

- The changed files come from git itself: `git diff --name-only -z --no-renames <base>...<head>`, with the pull request's base and head SHAs. No third-party action. `--no-renames` makes a rename count as a delete and an add, so moving a file from `apps/web` into `packages` lists the new path and runs the job.
- The `database-local` job stays unconditional, so the check always ends **completed** and never reads as skipped or missing. Its first steps check out the history, decide (step id `area`) and, when skipping, run the step `Say why the database job was skipped`, which prints the reason in the log and in the run summary. Every later step carries `if: steps.area.outputs.run != 'false'`; the test requires `!= 'false'`, never `== 'true'`, so a decision that produced no output runs the job instead of skipping it.
- The reason shows a file name JSON-quoted, because a path may contain a newline and the step output is one line.
- The script and the workflow come from the pull request itself, as does the rest of `ci.yml`: a change to `scripts/**` or `.github/**` always runs the job, and the review of such a change is what protects the list. When branch protection is on (issue #778), keep the review of those two folders mandatory.

To add a path to the list, first check that nothing the job runs reads it (the migrations, `pnpm db:test:local`, the worker and API integration suites, the build of their workspace dependencies), then add a case to `scripts/ci/decide-database-job.test.mjs` for it. To reproduce a decision locally: `node scripts/ci/decide-database-job.mjs --event pull_request --base origin/develop --head HEAD`.

The local equivalents are `pnpm db:start`, `pnpm db:migrate`, and `pnpm db:test:local`; Docker must be running, and the two variables must point at a database of your own (see [Ambiente local](../local-environment.md#banco-dos-testes-de-integração)). `pnpm db:reset` removes the whole compose database volume (the owner's `ageniza` and every agent database), then starts the database again and recreates `ageniza` from migrations, so it belongs to the owner only; an agent starts over with `drop database` on its own database, as in [ambiente local](../local-environment.md#banco-dos-testes-de-integração).

The API integration suite (`Run the authentication suite as the application role`) runs its files in parallel, 4 at a time (issue #792): a globalSetup migrates a model database once, and every file gets its own clone of it and drops it when it ends, so no file reads, writes or locks another's rows. The step, the job and the database `ageniza_ci` are unchanged; `ageniza_ci` only tells the suite which server to use. See [Ambiente local](../local-environment.md#um-banco-por-arquivo-na-suíte-da-api) for `--maxWorkers` and for what a killed run leaves behind.

## API production closure

`better-auth` declares `vitest` as an optional peer, and pnpm resolves it because vitest exists in this workspace, which would ship vitest and its chain in the production API image (issue #281). The `.pnpmfile.cjs` hook removes that peer before resolution; all four Dockerfiles copy the file because `pnpm install --frozen-lockfile` verifies the `pnpmfileChecksum` recorded in `pnpm-lock.yaml` against it and fails when it is missing. Any edit to the file changes the checksum, so the lockfile must be regenerated in the same change. The hook is a silent no-op once `better-auth` stops declaring the peer, and can be deleted then.

`CI / Quality gates` runs `node scripts/ci/verify-api-production-closure.mjs` right after the build, because the deploy ships `dist`; it deploys the API with `--prod` into a temporary directory and fails when any of these is true:

- the closure contains vitest or its chain (`FORBIDDEN_IN_API_PRODUCTION`, pinned by value in the test) or any package the workspace declares as a `devDependency` (the root and every `apps/*` and `packages/*`, read when the gate runs, issue #510). A development tool moved to `dependencies` of the API, such as `tsx`, turns the gate red;
- the API declares a direct dependency (or optional dependency) that is not in `scripts/ci/api-runtime-dependencies.json`, which pins them by value (issue #517). The list derived from the workspace cannot see a package that is a `devDependency` of one project only: moved to `dependencies` it stops being a `devDependency` anywhere, so `@scalar/fastify-api-reference` would have shipped with exit 0. A new runtime dependency of the API is added to that file in the change that adds it, and the test compares the file with `apps/api/package.json`;
- the deploy carries anything the runtime does not read: only `dist`, `node_modules` and `package.json` are expected, and no compiled test or `test-support` under `dist`. `apps/api/package.json` declares this in `files` (issue #305), because without it `pnpm deploy` also ships `src/`, the Dockerfile, the tsconfig and the vitest configs, and the compiled `*.test.js`;
- an `@ageniza/*` package the API declares carries anything but its `dist`, `package.json` and `README.md`, or a compiled test or `test-support` under `dist` (issue #510). Each internal package declares this in `files` (`dist` and the two test exclusions), because without it `pnpm deploy` ships its `src`, `test`, `.turbo` and tsconfig and vitest files. `@ageniza/database` also lists `bin` and `migrations`: `pnpm deploy` honours `files` for the deployed project itself, and the migrations image (`infra/migrations/Dockerfile`) deploys that package to run them, so the API image carries them too (`INTERNAL_RUNTIME_EXTRAS` in the script, pinned by value in the test);
- `dist/app.js`, `dist/server.js` and the two commands of the production runbook (`dist/cli/agency.js`, `dist/cli/email-change.js`) do not load from inside the deploy. A green image build does not prove the boot: when a package leaves the closure, this is the check that turns red.

The closure is read from the directory names of pnpm's virtual store (`node_modules/.pnpm/<name>@<version>…`). When pnpm renames those entries or lays `node_modules` out another way, the gate finds no `better-auth` and fails instead of passing, so a format change shows up as a red check, never as a closure nobody inspected; the script and its test pin that. Read this as the reason to fix `packageNameFromStoreEntry` rather than to loosen the sentinel.

To change what the image carries, edit `files` and compare the deploy by hand once: `pnpm --filter @ageniza/api --prod deploy <dir>` on `develop` and on the branch, the same `node_modules/.pnpm` listing, and `node -e "import('./dist/server.js')"` run inside the new `<dir>`. For an internal package, do the same with the worker (`--filter @ageniza/worker`) and with the migrations image (`--filter @ageniza/database`), which deploy the same packages.

## Branch protections and promotion

This repository is **public, on purpose** (owner decision, 2026-10-29), and the organization is on GitHub Free. Two consequences follow:

- Nothing sensitive may ever be committed: no credential, token, private key, real customer or agency data, or personal data, not even in a test fixture or a deleted commit. Production and dev secrets live on the VPS, not in GitHub (see the [production deploy runbook](../infra/production-deploy.md)). The security lessons, the review checklists and the infrastructure design (VPS baseline, deploy, tunnel) are readable by anyone, so the design must stay safe when known: the controls cannot depend on the layout being secret.
- On a public repository GitHub Free *does* allow rulesets, branch protection and Environment required reviewers (CODEOWNERS enforcement comes with branch protection). None of them is turned on yet; turning them on is proposed in issue #778. If the repository ever turns private on the Free plan, those features stop being available and the guards below are the only protection.

Until they are on, `main` and `develop` are guarded by:

| Guard | Enforced where | What it does |
| --- | --- | --- |
| `.githooks/pre-push` | Each clone (installed by `pnpm install`) | Refuses `git push` to `main` or `develop`. Bypassable with `--no-verify`; it prevents accidents. |
| `Production release / Release origin guard` | GitHub Actions | A push to `main` publishes, migrates, or deploys only if it is not a force push and is the merge commit of a pull request from this repository's `develop` or `hotfix/*`. |
| `ageniza-deploy` release verification | Production VPS | The host deploys only the manifest of a push-to-`main` run of `production.yml` for a commit on `main`; production secrets never live in GitHub. See the [production deploy runbook](../infra/production-deploy.md). |
| `ageniza-deploy-dev` release verification | Production VPS (dev environment) | The host deploys only the manifest of a push-to-`develop` run of `dev.yml` for a commit on `develop`, with the dev account, key and entrypoint that production does not share. See the [dev environment runbook](../infra/dev-environment.md). |
| `Branch guard` | GitHub Actions | Any force push, or any commit on `main` or `develop` that is not a merged pull request, fails the run and opens an issue assigned to @PedroV1dal. |
| `Pull request reviewer` | GitHub Actions | Requests review from @PedroV1dal on pull requests to `develop` and `main`. |

Team agreement, not technically enforced: merge only pull requests with an approval and green CI. GitHub itself never merges a pull request with conflicts. A direct push can edit these workflows too, so treat every `Branch guard` issue as an incident.

When the protections are turned on (or the organization moves to a paid plan), replace this with rulesets on `develop` and `main`: require pull requests with one approval (code owner on `main`), dismiss stale approvals, require conversation resolution and up-to-date branches, block force pushes and deletion, allow only repository admins to bypass for pull requests, and require these checks (plus `Release path validation` on `main`):

- `CI / Branch route`
- `CI / Migration policy`
- `CI / Quality gates`
- `CI / Docker images`
- `CI / PostgreSQL local database`

Feature, fix, and refactor branches merge into `develop`. `develop` is the integration branch: every commit that lands on it is published to the dev environment on the VPS by the `Dev release` workflow ([dev environment runbook](../infra/dev-environment.md), [ADR 0013](../adr/0013-dev-environment-on-the-vps.md)), and nothing else is deployed from it. A pull request to `main` is a production-promotion gate and must originate from `develop`; the workflow permits `hotfix/*` only as the documented production exception. Production deployment belongs to a separate main-only workflow, never this CI workflow or the `Dev release` workflow; see the [production deploy runbook](../infra/production-deploy.md). The `Dev release` workflow runs only for pushes to `develop`, holds only the dev SSH key (GitHub environment `dev`, restricted to `develop`) and calls the dev forced command, which cannot apply a production release.

After a `hotfix/*` branch is merged to `main`, immediately open and merge its reconciliation pull request into `develop` (or merge the resulting `main` delta into `develop` if branch policy requires it). This prevents the next release promotion from losing the production correction.
