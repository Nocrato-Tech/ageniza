import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ciJob, readCiWorkflow, stepName } from './ci-workflow.mjs';
import { decide, isAllowed } from './decide-database-job.mjs';

const script = join(import.meta.dirname, 'decide-database-job.mjs');
const repos = [];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

// A real repository: the script reads the changed files through git, so a fake would answer what the code should compute.
// `onBase` exists before the branch; `change` then edits the tree in the branch: write, remove or move paths.
const pullRequest = ({ onBase = {}, write = {}, remove = [], move = {}, event = 'pull_request', base = 'develop', head = 'feature' }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'decide-database-job-'));
  repos.push(cwd);
  git(cwd, 'init', '-q', '-b', 'develop');
  const put = (name, content) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), content);
  };
  const commit = (message) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '--allow-empty', '-m', message); };

  put('README.md', 'base\n');
  Object.entries(onBase).forEach(([name, content]) => put(name, content));
  commit('base');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  Object.entries(write).forEach(([name, content]) => put(name, content));
  remove.forEach((name) => rmSync(join(cwd, name)));
  Object.entries(move).forEach(([from, to]) => {
    mkdirSync(dirname(join(cwd, to)), { recursive: true });
    git(cwd, 'mv', from, to);
  });
  commit('feature');

  const github = join(cwd, 'github-output.txt');
  writeFileSync(github, '');
  const result = spawnSync('node', [script, '--event', event, '--base', base, '--head', head], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: github },
  });
  const outputs = Object.fromEntries(readFileSync(github, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
};

afterEach(() => {
  while (repos.length > 0) rmSync(repos.pop(), { recursive: true, force: true });
});

const CONTENT = 'changed\n';
const runs = (result) => {
  expect(result.status).toBe(0);
  expect(result.outputs.run).toBe('true');
};
const skips = (result) => {
  expect(result.status).toBe(0);
  expect(result.outputs.run).toBe('false');
};

describe('a pull request that only touches the allowed list skips the job, with the reason', () => {
  it.each([
    ['the web app', { 'apps/web/src/app.tsx': CONTENT }],
    ['a nested web file', { 'apps/web/public/brand/logo.svg': CONTENT }],
    ['the documentation', { 'docs/ci/README.md': CONTENT }],
    ['a non-Markdown file under docs', { 'docs/api/openapi.json': CONTENT }],
    ['Markdown at the repository root', { 'AGENTS.md': CONTENT }],
    ['all three at once', { 'apps/web/src/app.tsx': CONTENT, 'docs/README.md': CONTENT, 'CONTRIBUTING.md': CONTENT }],
  ])('skips for %s', (_name, write) => {
    const result = pullRequest({ write });
    skips(result);
    expect(result.outputs.reason).toContain('apps/web');
    expect(result.stdout).toContain('Skipping the PostgreSQL local database job');
  });
});

describe('every sensitive path runs the whole job', () => {
  it.each([
    ['packages', 'packages/database/migrations/20261029000000_x.mjs'],
    ['packages (a source file)', 'packages/contracts/src/index.ts'],
    ['apps/api', 'apps/api/src/app.ts'],
    ['apps/worker', 'apps/worker/src/index.ts'],
    ['.github', '.github/workflows/ci.yml'],
    ['.github (not a workflow)', '.github/dependabot.yml'],
    ['scripts', 'scripts/ci/validate-migrations.mjs'],
    ['infra', 'infra/vps/install.sh'],
    ['the lockfile', 'pnpm-lock.yaml'],
    ['the root package.json', 'package.json'],
    ['tsconfig', 'tsconfig.base.json'],
    ['a tsconfig variant', 'tsconfig.json'],
    ['the workspace file', 'pnpm-workspace.yaml'],
    ['the turbo config', 'turbo.json'],
    ['the lint config', 'eslint.config.mjs'],
    ['the compose file', 'compose.yml'],
    ['a root dotfile', '.nvmrc'],
    ['the git hooks', '.githooks/pre-push'],
  ])('runs for %s', (_name, file) => {
    const result = pullRequest({ write: { [file]: CONTENT } });
    runs(result);
    expect(result.outputs.reason).toContain(file);
    expect(result.stdout).toContain('Running the PostgreSQL local database job');
  });
});

describe('a file nobody planned for runs the job, because the list is of what may skip it', () => {
  it.each([
    ['a new top-level folder', 'tools/new-gate.sh'],
    ['a new folder under apps', 'apps/mobile/src/index.ts'],
    ['a sibling that only shares the prefix of apps/web', 'apps/web-api/src/index.ts'],
    ['a sibling that only shares the prefix of docs', 'docs-internal/secret.sh'],
    ['a Markdown file in a code folder', 'packages/database/README.md'],
    ['a Markdown file under apps/api', 'apps/api/src/modules/clients/README.md'],
    ['Markdown under specs, which is not on the list', 'specs/clientes.md'],
    ['a root file that is not Markdown', 'Dockerfile'],
    ['a root file that only contains .md', 'notes.md.sh'],
    ['a different case of an allowed folder', 'Docs/README.md'],
    ['a file named like an allowed folder', 'docs'],
  ])('runs for %s', (_name, file) => {
    const result = pullRequest({ write: { [file]: CONTENT } });
    runs(result);
    expect(result.outputs.reason).toContain(file);
  });

  // Windows cannot hold a newline in a file name; the CI runner can.
  it.skipIf(process.platform === 'win32')('runs when a path with a newline in its name is outside the list, and keeps the output on one line', () => {
    const result = pullRequest({ write: { 'tools/a\nrun=false': CONTENT } });
    runs(result);
    expect(result.outputs.reason).not.toContain('\n');
    expect(result.outputs.reason).toContain(String.raw`tools/a\nrun=false`);
  });
});

describe('a rename counts both of its paths', () => {
  it('runs when a file moves from apps/web into packages', () => {
    const result = pullRequest({ onBase: { 'apps/web/src/shared.ts': CONTENT }, move: { 'apps/web/src/shared.ts': 'packages/core/src/shared.ts' } });
    runs(result);
    expect(result.outputs.reason).toContain('packages/core/src/shared.ts');
  });

  it('runs when a file moves from packages into apps/web, so the database loses it', () => {
    const result = pullRequest({ onBase: { 'packages/core/src/shared.ts': CONTENT }, move: { 'packages/core/src/shared.ts': 'apps/web/src/shared.ts' } });
    runs(result);
    expect(result.outputs.reason).toContain('packages/core/src/shared.ts');
  });

  it('runs when a file is deleted from a sensitive folder', () => {
    const result = pullRequest({ onBase: { 'apps/api/src/old.ts': CONTENT }, remove: ['apps/api/src/old.ts'] });
    runs(result);
  });

  it('skips when a file moves inside the allowed list', () => {
    const result = pullRequest({ onBase: { 'docs/old.md': CONTENT }, move: { 'docs/old.md': 'apps/web/src/new.md' } });
    skips(result);
  });
});

describe('a mixed pull request runs the job', () => {
  it('runs when one allowed file sits next to one sensitive file, however many allowed files there are', () => {
    const result = pullRequest({
      write: { 'apps/web/src/a.tsx': CONTENT, 'apps/web/src/b.tsx': CONTENT, 'docs/a.md': CONTENT, 'README.md': CONTENT, 'packages/ui/src/button.tsx': CONTENT },
    });
    runs(result);
    expect(result.outputs.reason).toContain('packages/ui/src/button.tsx');
  });

  it('runs when the sensitive file is the only one outside the list and sorts first', () => {
    const result = pullRequest({ write: { '.github/workflows/ci.yml': CONTENT, 'docs/a.md': CONTENT } });
    runs(result);
  });
});

describe('when the decision cannot be trusted, the job runs', () => {
  it('runs on an empty diff', () => {
    const result = pullRequest({});
    runs(result);
    expect(result.outputs.reason).toContain('empty');
  });

  it('runs when the diff cannot be computed (unknown base)', () => {
    const result = pullRequest({ write: { 'docs/a.md': CONTENT }, base: '0000000000000000000000000000000000000000' });
    runs(result);
    expect(result.outputs.reason).toContain('could not be computed');
  });

  it('runs when the base and head are not given', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'decide-database-job-'));
    repos.push(cwd);
    const result = spawnSync('node', [script, '--event', 'pull_request'], { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Running the PostgreSQL local database job');
  });

  it.each(['push', 'workflow_dispatch', 'schedule'])('runs for the %s event even when the files are all allowed', (event) => {
    const result = pullRequest({ write: { 'docs/a.md': CONTENT }, event });
    runs(result);
    expect(result.outputs.reason).toContain(event);
  });

  it('runs when no event is given', () => {
    expect(decide({ eventName: undefined, files: ['docs/a.md'] }).run).toBe(true);
  });
});

describe('the decision as a function', () => {
  it('skips only a non-empty pull request whose every file is allowed', () => {
    expect(decide({ eventName: 'pull_request', files: ['docs/a.md', 'apps/web/x.ts'] }).run).toBe(false);
    expect(decide({ eventName: 'pull_request', files: ['docs/a.md', 'apps/api/x.ts'] }).run).toBe(true);
    expect(decide({ eventName: 'pull_request', files: [] }).run).toBe(true);
    expect(decide({ eventName: 'pull_request', files: undefined }).run).toBe(true);
  });

  it('does not allow a path that only looks like an allowed one', () => {
    expect(['apps/web', 'docs', 'apps/web-x/a', 'apps/webx', 'x/apps/web/a.ts', 'x/docs/a.md', '../docs/a.md', 'a/b.md', '.md.', ''].filter(isAllowed)).toEqual([]);
  });
});

// The skip has to be a property of the steps, not of the job: a skipped job shows as "skipped", and the check must
// stay "completed" with a step that says why. Two jobs share the decision: the one that holds the database suites and
// the one that holds the API suite (split out of it). Both are checked by the same rules, so the API suite cannot lose
// its gate by living in the newer job (the reviewer of ci-dev-enxuto/3 mutated it eight ways and none was caught).
const gatedJobs = [
  { id: 'database-local', skipNotice: 'Say why the database job was skipped', minimumGated: 16 },
  { id: 'api-integration', skipNotice: 'Say why the API suite was skipped', minimumGated: 11 },
];
const decisionStepName = 'Decide whether the database job is needed';

describe.each(gatedJobs)('the workflow gates every heavy step of $id on the decision, and fails towards running', ({ id, skipNotice, minimumGated }) => {
  const { header, steps } = ciJob(id);
  const ungated = ['Check out the repository with its history', decisionStepName, skipNotice];
  const nameOf = stepName;

  it('keeps the job unconditional, so the check is completed and not skipped', () => {
    expect(header).not.toMatch(/^ {4}if:/m);
  });

  it('decides in a step named area, from the pull request base and head, before anything heavy', () => {
    const decideStep = steps.find((step) => nameOf(step) === decisionStepName);
    expect(decideStep).toMatch(/^ {8}id: area$/m);
    expect(decideStep).toContain('node scripts/ci/decide-database-job.mjs');
    expect(decideStep).toContain('github.event.pull_request.base.sha');
    expect(decideStep).toContain('github.event.pull_request.head.sha');
    expect(decideStep).toContain('github.event_name');
    expect(steps.indexOf(decideStep)).toBeLessThan(steps.findIndex((step) => step.includes('pnpm install')));
  });

  it('checks out the whole history so the base and the head both exist', () => {
    expect(steps[0]).toMatch(/actions\/checkout@/);
    expect(steps[0]).toMatch(/fetch-depth: 0/);
  });

  it('gates every step after the decision with != false, never == true: a missing output runs the job', () => {
    const afterDecision = steps.slice(steps.findIndex((step) => nameOf(step) === decisionStepName) + 1);
    const gated = afterDecision.filter((step) => !ungated.includes(nameOf(step)));
    expect(gated.length).toBeGreaterThanOrEqual(minimumGated);
    for (const step of gated) {
      expect(step, nameOf(step)).toMatch(/^ {8}if: .*steps\.area\.outputs\.run != 'false'/m);
      expect(step, nameOf(step)).not.toMatch(/outputs\.run == 'true'/);
    }
  });

  it('keeps the cleanup running on failure, still behind the gate', () => {
    const cleanup = steps.find((step) => nameOf(step) === 'Remove the local database');
    expect(cleanup).toMatch(/^ {8}if: always\(\) && steps\.area\.outputs\.run != 'false'$/m);
  });

  it('has a step that runs only when the job is skipped and prints the reason without interpolating it into the shell', () => {
    const say = steps.find((step) => nameOf(step) === skipNotice);
    expect(say).toMatch(/^ {8}if: steps\.area\.outputs\.run == 'false'$/m);
    expect(say).toMatch(/env:\n\s+REASON: \$\{\{ steps\.area\.outputs\.reason \}\}/);
    expect(say).toContain('echo "Skipped: $REASON."');
    expect(say).not.toMatch(/run: .*\$\{\{/);
  });

  it('did not gate the decision itself or the skip notice', () => {
    for (const name of ungated) {
      const step = steps.find((candidate) => nameOf(candidate) === name);
      expect(step, name).toBeDefined();
      expect(step, name).not.toMatch(/^ {8}if: .*outputs\.run != 'false'/m);
    }
  });
});

describe('the two jobs that hold the database suites take one decision', () => {
  const decisionOf = (id) => ciJob(id).steps.find((step) => stepName(step) === decisionStepName);

  it('runs the same step, word for word, in both: they run or skip together', () => {
    const database = decisionOf('database-local');
    expect(database).toBeDefined();
    expect(decisionOf('api-integration')).toBe(database);
  });

  it('runs the API suite in its own job, as the application role, after the migrations and the storage', () => {
    const { steps } = ciJob('api-integration');
    const index = (needle) => steps.findIndex((step) => step.includes(needle));
    const suite = index('pnpm --filter @ageniza/api test:integration');
    expect(suite).toBeGreaterThan(-1);
    expect(steps[suite]).toMatch(/^ {8}if: steps\.area\.outputs\.run != 'false'$/m);
    expect(index('pnpm db:migrate')).toBeGreaterThan(-1);
    expect(index('pnpm db:migrate')).toBeLessThan(suite);
    expect(index('pnpm storage:start')).toBeGreaterThan(-1);
    expect(index('pnpm storage:start')).toBeLessThan(suite);
  });

  // Counted over the whole file, not over a recorded job: a suite moved to a job with another spelling of its key
  // (api_suite, apiSuite, a trailing comment) would otherwise leave the job tests looking at an empty job.
  it.each([
    ['pnpm --filter @ageniza/api test:integration', 'api-integration'],
    ['pnpm db:test:local', 'database-local'],
    ['pnpm --filter @ageniza/worker test:integration', 'database-local'],
  ])('runs "%s" exactly once in ci.yml, inside %s', (command, id) => {
    const workflow = readCiWorkflow();
    expect(workflow.split(command).length - 1).toBe(1);
    expect(ciJob(id).text).toContain(command);
  });
});

describe('the reason stays on one line whatever the file is called', () => {
  it('escapes a newline in the name of the file that is outside the list', () => {
    const { reason } = decide({ eventName: 'pull_request', files: ['docs/a.md', 'tools/a\nrun=false'] });
    expect(reason).not.toContain('\n');
    expect(reason).toContain(String.raw`tools/a\nrun=false`);
  });
});
