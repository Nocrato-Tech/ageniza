import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { functionsOf, posix, removeTemporaryDirectories, run, temporaryDirectory } from './vps-bash-harness.mjs';

// The dev environment shares a VPS with production (ADR 0013). What keeps the two apart is a handful of shell scripts
// and files, so each rule below is pinned from both sides: the one that must hold and the one that must not.
afterEach(removeTemporaryDirectories);

const root = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const deploy = read('infra/vps/ageniza-deploy-dev.sh');
const installer = read('infra/vps/install-dev-deploy.sh');
const sshScript = join(root, 'infra/vps/ageniza-deploy-dev-ssh.sh');
const preamble = `set -Eeuo pipefail\nIFS=$'\\n\\t'\n`;
const constant = (name) => deploy.split('\n').find((line) => line.startsWith(`readonly ${name}=`));
const hasJq = spawnSync('jq', ['--version']).status === 0;

const sha = 'a'.repeat(40);
// A drive letter would clash with the colon that separates PATH entries.
const msys = (path) => posix(path).replace(/^([A-Za-z]):/, '/$1');

describe('the forced command of the dev key', () => {
  // A stand-in `sudo` that only prints what it was asked to run: the real one needs root and the real entrypoint.
  const forced = (command) => {
    const bin = temporaryDirectory();
    writeFileSync(join(bin, 'sudo'), '#!/usr/bin/env bash\nprintf "SUDO %s\\n" "$*"\n');
    chmodSync(join(bin, 'sudo'), 0o755);
    return run(`export PATH="${msys(bin)}:$PATH"\nbash "${posix(sshScript)}"`, { SSH_ORIGINAL_COMMAND: command });
  };

  it('runs apply-dev for a commit and a run id, through the dev entrypoint only', () => {
    const result = forced(`apply-dev ${sha} 12345`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`SUDO -n /usr/local/sbin/ageniza-deploy-dev apply-dev ${sha} 12345`);
  });

  it('runs status-dev through the dev entrypoint', () => {
    expect(forced('status-dev').stdout.trim()).toBe('SUDO -n /usr/local/sbin/ageniza-deploy-dev status-dev');
  });

  it.each([
    ['the production apply', `apply ${sha} 12345`],
    ['the production rollback', 'rollback'],
    ['the production status', 'status'],
    ['no command at all', ''],
    ['a shell', 'bash'],
    ['a command chained after apply-dev', `apply-dev ${sha} 12345; id`],
    ['a command substituted into the run id', `apply-dev ${sha} $(id)`],
    ['a short commit', 'apply-dev abc123 12345'],
    ['an uppercase commit', `apply-dev ${'A'.repeat(40)} 12345`],
    ['a run id of zero', `apply-dev ${sha} 0`],
    ['a run id with a sign', `apply-dev ${sha} -1`],
    ['an extra argument', `apply-dev ${sha} 12345 extra`],
    ['a missing run id', `apply-dev ${sha}`],
    ['an argument to status-dev', 'status-dev now']
  ])('refuses %s without calling sudo', (_label, command) => {
    const result = forced(command);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe('');
  });

  it('only ever names the dev entrypoint', () => {
    const code = read('infra/vps/ageniza-deploy-dev-ssh.sh').split('\n').filter((line) => !line.startsWith('#')).join('\n');
    const executed = code.match(/\/usr\/local\/sbin\/[\w-]+/g);
    expect([...new Set(executed)]).toEqual(['/usr/local/sbin/ageniza-deploy-dev']);
  });
});

describe('the sudo rule of the dev account', () => {
  const rules = (text) => text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));

  it('names the dev account and the two dev operations, and nothing else', () => {
    expect(rules(read('infra/vps/ageniza-deploy-dev.sudoers'))).toEqual([
      'ageniza-dev-ci ALL=(root) NOPASSWD: /usr/local/sbin/ageniza-deploy-dev apply-dev *, /usr/local/sbin/ageniza-deploy-dev status-dev'
    ]);
  });

  it('leaves the production rule to the production account, which gets no dev operation', () => {
    const production = rules(read('infra/vps/ageniza-deploy.sudoers')).join('\n');
    expect(production).toMatch(/^ageniza-ci /);
    expect(production).not.toContain('ageniza-deploy-dev');
    expect(production).not.toContain('ageniza-dev-ci');
  });

  it('is installed with the mode sudo requires, under a name of its own', () => {
    expect(installer).toContain('install -o root -g root -m 0440 "$source_dir/ageniza-deploy-dev.sudoers" /etc/sudoers.d/ageniza-deploy-dev');
    expect(installer).toContain('visudo -cf "$source_dir/ageniza-deploy-dev.sudoers"');
  });
});

describe('the dev files never reach a production path', () => {
  const productionPath = /\/(?:etc|opt)\/ageniza(?![-\w])|\/var\/lib\/ageniza(?![-\w])|ageniza-deploy(?!-dev)|ageniza-ci\b|ageniza-production/;

  it.each([
    'infra/vps/ageniza-deploy-dev.sh',
    'infra/vps/ageniza-deploy-dev-ssh.sh',
    'infra/vps/ageniza-deploy-dev.sudoers',
    'infra/vps/install-dev-deploy.sh',
    'infra/vps/compose.dev-tunnel.yml',
    'compose.dev.yml'
  ])('%s names no production directory, account, script or network', (path) => {
    const lines = read(path).split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(lines.filter((line) => productionPath.test(line))).toEqual([]);
  });

  it('keeps the dev lock apart from the production lock, so a dev release never blocks a production one', () => {
    expect(constant('LOCK_FILE')).toBe('readonly LOCK_FILE=/run/lock/ageniza-deploy-dev.lock');
    expect(read('infra/vps/ageniza-deploy.sh')).toContain('readonly LOCK_FILE=/run/lock/ageniza-deploy.lock');
  });

  it('verifies a push to develop of the dev workflow and its own manifest artifact', () => {
    expect(constant('RELEASE_WORKFLOW')).toBe('readonly RELEASE_WORKFLOW=.github/workflows/dev.yml');
    expect(constant('RELEASE_BRANCH')).toBe('readonly RELEASE_BRANCH=develop');
    expect(constant('MANIFEST_ARTIFACT')).toBe('readonly MANIFEST_ARTIFACT=dev-release-manifest');
    expect(read('.github/workflows/dev.yml')).toContain('name: dev-release-manifest');
  });
});

describe('validate_runtime_env of the dev entrypoint', () => {
  const fromExample = () => read('infra/vps/dev-runtime.env.example').split('\n').filter((line) => line !== '' && !line.startsWith('#'));

  const validate = (lines) => {
    const directory = temporaryDirectory();
    const file = join(directory, 'runtime.env');
    writeFileSync(file, `${lines.join('\n')}\n`);
    return run(`${preamble}${constant('DEV_DOMAIN')}\nRUNTIME_ENV="${posix(file)}"\nrequire_root_file() { :; }\n${functionsOf(deploy, 'die', 'read_value', 'validate_runtime_env')}\nvalidate_runtime_env`);
  };
  const without = (key) => fromExample().filter((line) => !line.startsWith(`${key}=`));
  const replacing = (key, value) => fromExample().map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line));

  it('accepts the committed example, so the example and the validator cannot drift apart', () => {
    expect(validate(fromExample()).status).toBe(0);
  });

  it('accepts the deep-link schemes of the native app, which the example leaves empty', () => {
    expect(fromExample()).toContain('MOBILE_APP_ORIGINS=');
    expect(validate(replacing('MOBILE_APP_ORIGINS', 'ageniza://')).status).toBe(0);
  });

  it.each([
    ['a real SMTP provider', 'SMTP_URL=smtps://user:key@smtp.example.com:465'],
    ['the Mailpit address itself (it is fixed by the compose file)', 'SMTP_URL=smtp://mailpit:1025'],
    ['a sender', 'EMAIL_FROM=Ageniza <no-reply@example.com>'],
    ['the deploy target', 'DEPLOY_TARGET=dev'],
    ['the trusted proxy network', 'API_TRUSTED_PROXY_CIDRS=0.0.0.0/0'],
    ['a key nobody declared', 'SOME_NEW_SETTING=1']
  ])('refuses a file that names %s', (_label, line) => {
    const result = validate([...fromExample(), line]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(_label === 'a key nobody declared' ? /not allowed/ : /is fixed by compose\.dev\.yml and must not appear/);
  });

  describe('the optional real-mail opt-in (issue #835)', () => {
    const optIn = ['DEV_REAL_EMAIL=1', 'DEV_SMTP_URL=smtps://user:s3cret%21@smtp.provider.example:465', 'DEV_EMAIL_FROM=Ageniza Dev <no-reply@dev.ageniza.com.br>'];
    const withOptIn = (replace = {}) => [...fromExample(), ...optIn.map((line) => { const key = line.split('=')[0]; return key in replace ? `${key}=${replace[key]}` : line; })];

    it('accepts smtps and smtp on 587, with the sender', () => {
      expect(validate(withOptIn()).status).toBe(0);
      expect(validate(withOptIn({ DEV_SMTP_URL: 'smtp://user:key@smtp.provider.example:587' })).status).toBe(0);
      expect(validate(withOptIn({ DEV_EMAIL_FROM: 'no-reply@dev.ageniza.com.br' })).status).toBe(0);
    });

    it.each([
      ['plaintext smtp on 25', 'smtp://user:key@smtp.provider.example:25'],
      ['smtp with no port', 'smtp://user:key@smtp.provider.example'],
      ['no credentials', 'smtps://smtp.provider.example:465'],
      ['the sink', 'smtp://mailpit:1025'],
      ['localhost', 'smtps://user:key@localhost:465'],
      ['a single-label host', 'smtps://user:key@postgres:465'],
      ['an IP literal', 'smtps://user:key@10.0.0.5:465'],
      ['an internal suffix', 'smtps://user:key@smtp.corp.internal:465'],
      ['another scheme', 'https://user:key@smtp.provider.example:465'],
      ['a query that overrides TLS', 'smtp://user:key@smtp.provider.example:587?requireTLS=false'],
      ['a query that hides the host behind an @', 'smtp://user:key@smtp.provider.example:587?requireTLS=false&x=@smtp.provider.example:587'],
      ['a fragment', 'smtps://user:key@smtp.provider.example:465#x'],
      ['a question mark inside the password', 'smtps://user:ke?y@smtp.provider.example:465'],
      ['an upper-case internal suffix', 'smtps://user:key@SMTP.CORP.INTERNAL:465']
    ])('refuses DEV_SMTP_URL with %s without printing it', (_label, value) => {
      const result = validate(withOptIn({ DEV_SMTP_URL: value }));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('DEV_SMTP_URL');
      expect(result.stderr + result.stdout).not.toMatch(/key@|user:|10\.0\.0\.5|provider\.example/);
    });

    it.each(['0', 'true', ''])('refuses DEV_REAL_EMAIL=%j', (value) => {
      expect(validate(withOptIn({ DEV_REAL_EMAIL: value })).status).toBe(1);
    });

    it('refuses a sender that is not an address', () => {
      const result = validate(withOptIn({ DEV_EMAIL_FROM: 'Ageniza Dev' }));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('DEV_EMAIL_FROM');
    });

    it.each(optIn.map((line) => line.split('=')[0]))('refuses the opt-in without %s', (key) => {
      const result = validate(withOptIn().filter((line) => !line.startsWith(`${key}=`)));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('set together');
    });

    it('hands the three values to compose from the vetted snapshot, and nothing else', () => {
      const body = functionsOf(deploy, 'compose_app');
      for (const key of ['DEV_REAL_EMAIL', 'DEV_SMTP_URL', 'DEV_EMAIL_FROM']) expect(body).toContain(`read_value "$RUNTIME_SNAPSHOT" ${key}`);
      expect(body).not.toMatch(/\bSMTP_URL=|\bEMAIL_FROM=/);
    });

    it('never prints the credential on any refusal', () => {
      const result = validate([...withOptIn(), 'SMTP_URL=smtps://user:s3cret@smtp.provider.example:465']);
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).not.toContain('s3cret');
    });
  });

  it.each([
    ['PAYMENTS_PROVIDER', 'asaas'],
    ['PAYMENTS_PROVIDER', ''],
    ['APP_ENV', 'local'],
    ['APP_PUBLIC_URL', 'https://app.ageniza.com.br'],
    ['APP_PUBLIC_URL', 'http://dev.ageniza.com.br'],
    ['API_CORS_ORIGINS', 'https://app.ageniza.com.br'],
    ['R2_BUCKET', 'ageniza-media'],
    ['IDENTITY_STORAGE_BUCKET', 'ageniza-identity-production'],
    ['WORKER_SMOKE_JOB', 'true'],
    ['WORKER_CONCURRENCY', '4'],
    ['AUTH_TERMS_VERSION', '1/1/2026']
  ])('refuses %s=%s', (key, value) => {
    expect(validate(replacing(key, value)).status).toBe(1);
  });

  // The worker of the dev environment can decline the renewals of the simulated provider, to exercise the three days of grace (issue #772).
  it.each(['approved', 'declined'])('accepts PAYMENTS_SIMULATED_RENEWAL=%s', (value) => {
    expect(validate([...fromExample(), `PAYMENTS_SIMULATED_RENEWAL=${value}`]).status).toBe(0);
  });

  it.each(['', 'Declined', 'maybe', 'true'])('refuses PAYMENTS_SIMULATED_RENEWAL=%j', (value) => {
    const result = validate([...fromExample(), `PAYMENTS_SIMULATED_RENEWAL=${value}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENTS_SIMULATED_RENEWAL must be approved or declined');
  });

  it.each(['PAYMENTS_PROVIDER', 'BETTER_AUTH_SECRET', 'DATABASE_URL', 'R2_BUCKET', 'IDENTITY_STORAGE_SECRET_ACCESS_KEY', 'APP_PUBLIC_URL'])('requires %s', (key) => {
    const result = validate(without(key));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`is missing ${key}`);
  });

  it('refuses the same bucket or the same access key for media and identity', () => {
    expect(validate(replacing('IDENTITY_STORAGE_BUCKET', 'ageniza-media-dev')).stderr).toContain('must differ from R2_BUCKET');
    expect(validate(replacing('IDENTITY_STORAGE_ACCESS_KEY_ID', 'REPLACE_WITH_DEV_R2_ACCESS_KEY_ID')).stderr).toContain('must differ from R2_ACCESS_KEY_ID');
  });

  it('refuses a repeated key and a comment line', () => {
    expect(validate([...fromExample(), 'APP_ENV=production']).stderr).toContain('repeats APP_ENV');
    expect(validate(['# a comment', ...fromExample()]).stderr).toContain('KEY=value lines only');
  });

  it('refuses a copy of the production file', () => {
    const production = read('infra/vps/runtime.env.example').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    expect(validate(production).status).toBe(1);
  });
});

describe('fetch_verified_release of the dev entrypoint', () => {
  const images = { api: 'a', web: 'b', worker: 'c', migrations: 'd' };
  const image = (name, char, namespace = 'ghcr.io/nocrato-tech') => `${namespace}/ageniza-${name}@sha256:${char.repeat(64)}`;
  const runFor = (overrides = {}) => ({
    head_sha: sha,
    head_branch: 'develop',
    event: 'push',
    path: '.github/workflows/dev.yml@refs/heads/develop',
    repository: { full_name: 'Nocrato-Tech/ageniza' },
    head_repository: { full_name: 'Nocrato-Tech/ageniza' },
    ...overrides
  });
  // The entrypoint reads the first line of a key, so an override must replace the line, not follow it.
  const manifestLines = (overrides = {}) => Object.entries({
    TARGET: 'dev',
    RELEASE: sha,
    RUN_ID: '77',
    ...Object.fromEntries(Object.entries(images).map(([name, char]) => [`${name.toUpperCase()}_IMAGE`, image(name, char)])),
    ...overrides
  }).map(([key, value]) => `${key}=${value}`);

  // `github_api` is replaced by a function that copies a fixture; the real one needs the network and a token.
  const fetchRelease = ({ runJson = runFor(), compare = { status: 'identical' }, artifacts, manifest = manifestLines() } = {}) => {
    const directory = temporaryDirectory();
    const work = join(directory, 'work');
    const fixtures = join(directory, 'fixtures');
    mkdirSync(work);
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, 'run.json'), JSON.stringify(runJson));
    writeFileSync(join(fixtures, 'compare.json'), JSON.stringify(compare));
    writeFileSync(join(fixtures, 'artifacts.json'), JSON.stringify(artifacts ?? { artifacts: [{ name: 'dev-release-manifest', expired: false, archive_download_url: 'https://api.github.com/repos/nocrato-tech/ageniza/actions/artifacts/9/zip' }] }));
    writeFileSync(join(fixtures, 'release.env'), `${manifest.join('\n')}\n`);
    const script = `${preamble}
${constant('GITHUB_API')}
${constant('RELEASE_WORKFLOW')}
${constant('RELEASE_BRANCH')}
${constant('MANIFEST_ARTIFACT')}
WORK_DIR="${posix(work)}"
REPOSITORY=Nocrato-Tech/ageniza IMAGE_NAMESPACE=ghcr.io/nocrato-tech
API_IMAGE='' WEB_IMAGE='' WORKER_IMAGE='' MIGRATIONS_IMAGE=''
github_api() {
  case "$1" in
    */compare/*) cp "${posix(fixtures)}/compare.json" "$2" ;;
    */artifacts\\?name=*) cp "${posix(fixtures)}/artifacts.json" "$2" ;;
    */zip) cp "${posix(fixtures)}/release.zip" "$2" ;;
    */actions/runs/*) cp "${posix(fixtures)}/run.json" "$2" ;;
    *) echo "unexpected request: $1" >&2; return 1 ;;
  esac
}
unzip() { cat "${posix(fixtures)}/release.env"; }
${functionsOf(deploy, 'die', 'read_value', 'valid_app_image', 'fetch_verified_release')}
fetch_verified_release ${sha} 77
printf 'API=%s\\nMIGRATIONS=%s\\n' "$API_IMAGE" "$MIGRATIONS_IMAGE"`;
    writeFileSync(join(fixtures, 'release.zip'), 'zip');
    return run(script);
  };

  describe.skipIf(!hasJq)('with jq, as on the VPS', () => {
    it('accepts a push to develop of the dev workflow that is on develop, and reads the digests from the manifest', () => {
      const result = fetchRelease();
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(`API=${image('api', 'a')}\nMIGRATIONS=${image('migrations', 'd')}\n`);
    });

    it('accepts a commit that develop has moved past', () => {
      expect(fetchRelease({ compare: { status: 'ahead' } }).status).toBe(0);
    });

    it.each([
      ['a run of another commit', { head_sha: 'b'.repeat(40) }],
      ['a run of the main branch', { head_branch: 'main' }],
      ['a run of a feature branch', { head_branch: 'fix/anything' }],
      ['a pull request run', { event: 'pull_request' }],
      ['a manual dispatch', { event: 'workflow_dispatch' }],
      ['the production workflow', { path: '.github/workflows/production.yml@refs/heads/main' }],
      ['the CI workflow', { path: '.github/workflows/ci.yml@refs/heads/develop' }],
      ['a run of another repository', { repository: { full_name: 'someone/ageniza' } }],
      ['a run whose code came from a fork', { head_repository: { full_name: 'someone/ageniza' } }]
    ])('refuses %s', (_label, change) => {
      const result = fetchRelease({ runJson: runFor(change) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not a push-to-develop run of .github/workflows/dev.yml');
    });

    it.each([['diverged'], ['behind']])('refuses a commit whose compare status with develop is %s', (status) => {
      const result = fetchRelease({ compare: { status } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not on develop');
    });

    it('refuses a run without the dev manifest artifact, or with an expired or foreign one', () => {
      const url = 'https://api.github.com/repos/nocrato-tech/ageniza/actions/artifacts/9/zip';
      for (const artifacts of [
        { artifacts: [] },
        { artifacts: [{ name: 'release-manifest', expired: false, archive_download_url: url }] },
        { artifacts: [{ name: 'dev-release-manifest', expired: true, archive_download_url: url }] },
        { artifacts: [{ name: 'dev-release-manifest', expired: false, archive_download_url: 'https://api.github.com/repos/someone/else/actions/artifacts/9/zip' }] }
      ]) {
        const result = fetchRelease({ artifacts });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('has no dev-release-manifest artifact');
      }
    });

    it('refuses a manifest that is not a dev manifest, or is for another commit', () => {
      expect(fetchRelease({ manifest: manifestLines().filter((line) => !line.startsWith('TARGET=')) }).stderr).toContain('not a dev manifest');
      expect(fetchRelease({ manifest: manifestLines({ TARGET: 'production' }) }).stderr).toContain('not a dev manifest');
      expect(fetchRelease({ manifest: manifestLines().map((line) => (line.startsWith('RELEASE=') ? `RELEASE=${'b'.repeat(40)}` : line)) }).stderr).toContain('does not match the requested commit');
    });

    it.each(['API', 'WEB', 'WORKER', 'MIGRATIONS'])('refuses a %s image that is a tag, from another namespace, or from another service', (name) => {
      const lower = name.toLowerCase();
      for (const bad of [
        `ghcr.io/nocrato-tech/ageniza-${lower}:develop-${sha}`,
        image(lower, 'a', 'ghcr.io/someone-else'),
        image(lower === 'api' ? 'web' : 'api', 'a'),
        `ghcr.io/nocrato-tech/ageniza-${lower}@sha256:${'a'.repeat(63)}`,
        `ghcr.io/nocrato-tech/ageniza-${lower}@sha256:${'a'.repeat(65)}`,
        `ghcr.io/nocrato-tech/ageniza-${lower}@sha256:${'A'.repeat(64)}`
      ]) {
        const result = fetchRelease({ manifest: manifestLines({ [`${name}_IMAGE`]: bad }) });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`manifest ${name === 'API' ? 'API' : lower} image is not an ghcr.io/nocrato-tech digest`);
      }
    });
  });
});

describe('the migration job of the dev entrypoint', () => {
  const migrate = (limits) => {
    const directory = temporaryDirectory();
    const limitsFile = join(directory, 'dev-limits.env');
    writeFileSync(limitsFile, `${limits}\n`);
    return run(`${preamble}${constant('APP_PROJECT')}\nLIMITS_ENV="${posix(limitsFile)}"\nMIGRATIONS_ENV=/etc/ageniza-dev/migrations.env\nMIGRATIONS_IMAGE=ghcr.io/nocrato-tech/ageniza-migrations@sha256:${'d'.repeat(64)}\ndocker() { printf '%s ' "$@"; printf '\\n'; }\n${functionsOf(deploy, 'die', 'read_value', 'run_migrations')}\nrun_migrations`);
  };
  const committed = read('infra/vps/dev-limits.env');

  it('runs inside the budget of dev-limits.env, on the private network of the dev project', () => {
    const result = migrate(committed);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `run --rm --pull never --network ageniza-dev_dev-private --env-file /etc/ageniza-dev/migrations.env --cpus 0.15 --memory 384m --memory-swap 384m --pids-limit 128 ghcr.io/nocrato-tech/ageniza-migrations@sha256:${'d'.repeat(64)}`
    );
  });

  it('takes the values from the limits file, not from the script', () => {
    const result = migrate(committed.replace('DEV_MIGRATIONS_CPUS=0.15', 'DEV_MIGRATIONS_CPUS=0.5').replace('DEV_MIGRATIONS_MEM=384m', 'DEV_MIGRATIONS_MEM=1g'));
    expect(result.stdout).toContain('--cpus 0.5 --memory 1g --memory-swap 1g');
  });

  it.each(['DEV_MIGRATIONS_CPUS', 'DEV_MIGRATIONS_MEM', 'DEV_MIGRATIONS_PIDS'])('refuses to run without %s, instead of running unbounded', (key) => {
    const result = migrate(committed.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must set DEV_MIGRATIONS_CPUS, DEV_MIGRATIONS_MEM and DEV_MIGRATIONS_PIDS');
    expect(result.stdout).toBe('');
  });

  it('is the network the compose file creates for the project', () => {
    expect(constant('APP_PROJECT')).toBe('readonly APP_PROJECT=ageniza-dev');
    expect(read('compose.dev.yml')).toMatch(/^name: ageniza-dev$/m);
    expect(read('compose.dev.yml')).toMatch(/^ {2}dev-private:$/m);
  });

  it('pulls the Mailpit image together with the application images, because the release starts with --pull never', () => {
    expect(deploy).toMatch(/for image in [^;]*"\$AGENIZA_MAILPIT_IMAGE"[^;]*; do pull_verified_image/);
    expect(deploy).toContain('up -d --pull never --no-deps --wait --wait-timeout 180 mailpit api web worker');
  });

  it('is replaced by the live release when the new one fails to start', () => {
    expect(deploy).toMatch(/RESTORE_ARMED=true\n\s+note "replacing containers with release \$sha"\n\s+start_release/);
  });
});

describe('render_access_config of the dev installer', () => {
  const team = 'ageniza';
  const aud = 'ab'.repeat(32);
  const render = (teamName, audTag) => {
    const template = join(root, 'infra/vps/cloudflared/dev-config.yml');
    return run(`${preamble}source "${posix(join(root, 'infra/vps/install-dev-deploy.sh'))}"\nrender_access_config "${posix(template)}" '${teamName}' '${audTag}'`);
  };

  it('fills the team name and the audience tag, and leaves no placeholder', () => {
    const result = render(team, aud);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`teamName: ${team}`);
    expect(result.stdout).toContain(`- ${aud}`);
    expect(result.stdout).not.toContain('REPLACE_WITH');
  });

  it.each([
    ['an empty team', '', aud],
    ['a team with an uppercase letter', 'Ageniza', aud],
    ['a team that tries to close the sed expression', 'a/b', aud],
    ['an empty audience tag', team, ''],
    ['a short audience tag', team, 'ab'.repeat(31)],
    ['an audience tag that is not hex', team, 'zz'.repeat(32)],
    ['the placeholder itself', 'REPLACE_WITH_THE_ZERO_TRUST_TEAM_NAME', 'REPLACE_WITH_THE_MAILPIT_APPLICATION_AUD_TAG']
  ])('refuses %s', (_label, teamName, audTag) => {
    const result = render(teamName, audTag);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});

describe('the mail path fixed by compose.dev.yml', () => {
  const compose = read('compose.dev.yml');
  // The text of one service: from its line to the next service at the same indent.
  const serviceBlock = (name) => {
    const rest = compose.slice(compose.indexOf(`\n  ${name}:\n`) + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it.each(['api', 'worker'])('fixes the sink, the sender and the dev target in the %s, above the runtime file', (name) => {
    const block = serviceBlock(name);
    // The sink and the dev sender are the defaults; only the three opt-in variables of issue #835 can replace them.
    expect(block).toMatch(/environment: !override\n(?:\s+[A-Z_]+: .*\n)*?\s+SMTP_URL: \$\{DEV_SMTP_URL:-smtp:\/\/mailpit:1025\}\n/);
    expect(block).toMatch(/\n\s+DEPLOY_TARGET: dev\n/);
    expect(block).toMatch(/\n\s+DEV_REAL_EMAIL: \$\{DEV_REAL_EMAIL:-\}\n/);
    expect(block).toMatch(/\n\s+EMAIL_FROM: \$\{DEV_EMAIL_FROM:-Ageniza Dev <no-reply@dev\.ageniza\.com\.br>\}\n/);
    expect(block).toMatch(/env_file:\n\s+- path: \$\{AGENIZA_RUNTIME_ENV_FILE/);
  });

  it('keeps Mailpit off the host and reachable only from the private network and the tunnel network', () => {
    const block = serviceBlock('mailpit');
    expect(block).toContain('ports: !reset []');
    expect(block).toContain('networks: !override [dev-private, dev-proxy]');
  });
});

describe('the dev tunnel and its hostnames', () => {
  const config = read('infra/vps/cloudflared/dev-config.yml');
  const ingress = config.slice(config.indexOf('ingress:'));

  it('routes the app hostname to the web container and the inbox hostname to Mailpit, and nothing else', () => {
    expect(ingress).toMatch(/- hostname: dev\.ageniza\.com\.br\n\s+service: http:\/\/web:8080\n/);
    expect(ingress).toMatch(/- hostname: mail-dev\.ageniza\.com\.br\n\s+service: http:\/\/mailpit:8025\n/);
    expect(ingress.match(/service:/g)).toHaveLength(3);
    expect(ingress.trimEnd().split('\n').at(-1)).toBe('  - service: http_status:404');
  });

  it('makes cloudflared itself require Cloudflare Access on the inbox hostname, and only there', () => {
    const inbox = ingress.slice(ingress.indexOf('mail-dev'), ingress.indexOf('http_status'));
    expect(inbox).toMatch(/access:\n\s+required: true\n\s+teamName: REPLACE_WITH_ACCESS_TEAM_NAME\n\s+audTag:\n\s+- REPLACE_WITH_ACCESS_AUD_TAG/);
    expect(ingress.slice(0, ingress.indexOf('mail-dev'))).not.toContain('access:');
  });

  it('serves the same domain the entrypoint, the workflow and the sender address use', () => {
    const domain = /DEV_DOMAIN=(\S+)/.exec(constant('DEV_DOMAIN'))[1];
    expect(domain).toBe('dev.ageniza.com.br');
    expect(config).toContain(`hostname: ${domain}`);
    expect(read('compose.dev.yml')).toContain(`no-reply@${domain}`);
    expect(read('.github/workflows/dev.yml')).toContain(`https://${domain}/api`);
  });

  it('is the only thing mounted into the tunnel, read-only, from the dev directory', () => {
    expect(read('infra/vps/compose.dev-tunnel.yml')).toMatch(/volumes:\n\s+- \/etc\/ageniza-dev\/cloudflared:\/etc\/cloudflared:ro/);
  });

  it('is installed only after the Access values are valid, so a placeholder never reaches cloudflared', () => {
    expect(installer).toContain("grep -q 'REPLACE_WITH' <<< \"$rendered\" && die");
    expect(installer).not.toMatch(/install[^\n]*cloudflared\/dev-config\.yml/);
  });
});

describe('the dev workflow', () => {
  const workflow = read('.github/workflows/dev.yml');

  it('runs for pushes to develop only, one at a time', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[develop\]\n\npermissions:/m);
    expect(workflow).not.toContain('pull_request');
    expect(workflow).not.toMatch(/branches:.*main/);
    expect(workflow).toMatch(/concurrency:\n {2}group: dev-develop\n {2}cancel-in-progress: false/);
  });

  it('reads its secrets and variables from the dev environment, in both jobs that need them', () => {
    expect(workflow.match(/^ {4}environment: dev$/gm)).toHaveLength(2);
  });

  it('waits, and publishes and deploys, only when the owner turned the repository switch on', () => {
    expect(workflow.match(/^ {4}if: vars\.DEV_DEPLOY_ENABLED == 'true'( && .*)?$/gm)).toHaveLength(3);
  });

  describe('the gate on the CI of the same commit', () => {
    const job = (name) => workflow.split(/^ {2}(?=[a-z-]+:\n)/m).find((block) => block.startsWith(`${name}:`)) ?? '';
    const gate = job('ci-gate');

    it('is a job of its own with a read-only token, no environment and no secret, because it runs before CI is green', () => {
      expect(gate).not.toBe('');
      expect(gate).toMatch(/permissions:\n {6}actions: read\n {6}contents: read\n/);
      expect(gate).not.toMatch(/environment:|secrets\.|DEV_SSH|packages: write|dev-ssh/);
    });

    it('waits for the push run of the CI workflow of this very commit, not for a pull request run', () => {
      expect(gate).toContain('actions/runs?head_sha=$GITHUB_SHA&event=push');
      expect(gate).toContain('.name == "CI" and .head_branch == "develop"');
      expect(gate).toContain('[[ "$conclusion" == success ]]');
    });

    it('fails when CI did not succeed and when it did not finish in time', () => {
      expect(gate).toMatch(/echo "::error::CI ended as '\$conclusion'[^\n]*\n\s+exit 1/);
      expect(gate).toMatch(/\(\( SECONDS >= deadline \)\)[^\n]*\n[^\n]*\n\s+exit 1/);
      expect(gate).toContain("WAIT_SECONDS: '2400'");
    });

    it('lets the newer push win: an older commit stops waiting and releases nothing', () => {
      expect(gate).toMatch(/while true; do\n[^\n]*\n\s+\[\[ "\$\(develop_tip\)" == "\$GITHUB_SHA" \]\] \|\| skip_release/);
      expect(gate.match(/\[\[ "\$\(develop_tip\)" == "\$GITHUB_SHA" \]\] \|\| skip_release/g)).toHaveLength(2);
      expect(gate).toContain('echo "release=false" >> "$GITHUB_OUTPUT"');
    });

    describe('runs the step as written, against a stand-in for gh', () => {
      const step = gate.split('        run: |\n')[1].split('\n').filter((line) => line === '' || line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
      const waitFor = ({ tip = sha, ci, wait = '0' }) => {
        const directory = temporaryDirectory();
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *git/ref/heads/develop*) printf "%s\\n" "$FAKE_TIP" ;;\n  *actions/runs\\?head_sha=*) printf "%s\\n" "$FAKE_CI" ;;\n  *) exit 1 ;;\nesac\n');
        chmodSync(join(bin, 'gh'), 0o755);
        const output = join(directory, 'output');
        writeFileSync(output, '');
        const result = run(`export PATH="${msys(bin)}:$PATH"\n${step}`, {
          GH_TOKEN: 'x', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: sha, GITHUB_OUTPUT: posix(output), WAIT_SECONDS: wait, FAKE_TIP: tip, FAKE_CI: ci
        });
        return { ...result, output: readFileSync(output, 'utf8').trim() };
      };
      const url = 'https://github.com/owner/repo/actions/runs/1';

      it('releases when CI of this commit succeeded', () => {
        const result = waitFor({ ci: `completed success ${url}` });
        expect(result.status).toBe(0);
        expect(result.output).toBe('release=true');
      });

      it.each(['failure', 'cancelled', 'timed_out', 'skipped'])('fails, releasing nothing, when CI ended as %s', (conclusion) => {
        const result = waitFor({ ci: `completed ${conclusion} ${url}` });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(`::error::CI ended as '${conclusion}'`);
        expect(result.output).toBe('');
      });

      it('fails when CI is still running, or never appeared, once the wait is over', () => {
        for (const ci of [`in_progress none ${url}`, `queued none ${url}`, '']) {
          const result = waitFor({ ci });
          expect(result.status).toBe(1);
          expect(result.stdout).toContain('did not finish');
          expect(result.output).toBe('');
        }
      });

      it('steps aside, without failing, when a newer commit is already the tip of develop', () => {
        for (const ci of [`in_progress none ${url}`, `completed cancelled ${url}`, `completed failure ${url}`]) {
          const result = waitFor({ tip: 'b'.repeat(40), ci });
          expect(result.status).toBe(0);
          expect(result.output).toBe('release=false');
        }
      });
    });

    it('is required by both jobs that build or reach the VPS', () => {
      expect(job('publish')).toMatch(/needs: ci-gate\n/);
      expect(job('publish')).toContain("needs.ci-gate.outputs.release == 'true'");
      expect(job('deploy')).toMatch(/needs: \[ci-gate, publish\]\n/);
      expect(job('deploy')).toContain("needs.ci-gate.outputs.release == 'true'");
    });

    it('does not use workflow_run, which only fires from the default branch', () => {
      expect(workflow).not.toMatch(/^ {2}workflow_run:/m);
    });
  });

  it('caches the Docker layers of each image under a scope of its own, without changing what is built', () => {
    for (const name of ['api', 'worker', 'web', 'migrations']) {
      expect(workflow).toContain(`cache-from: type=gha,scope=dev-${name}\n`);
      expect(workflow).toContain(`cache-to: type=gha,mode=max,scope=dev-${name}\n`);
    }
    expect(workflow.match(/cache-from:/g)).toHaveLength(4);
  });

  it('holds no production secret, variable, host alias or entrypoint', () => {
    expect(workflow).not.toMatch(/PRODUCTION_|production-ssh|ssh production|(?<!dev-)release-manifest/);
    expect(workflow).toContain('ssh dev "apply-dev $GITHUB_SHA $GITHUB_RUN_ID"');
    expect(workflow).toContain('uses: ./.github/actions/dev-ssh');
  });

  it('tags the four images develop-<sha> and records TARGET=dev with digests the VPS can check', () => {
    for (const name of ['api', 'worker', 'web', 'migrations']) {
      expect(workflow).toContain(`/ageniza-${name}:develop-\${{ github.sha }}`);
    }
    expect(workflow).toContain('echo "TARGET=dev"');
    expect(workflow).toContain('node scripts/deploy/validate-image-ref.mjs');
  });

  it('builds the web image for the dev address', () => {
    expect(workflow).toContain('VITE_API_BASE_URL=${{ vars.DEV_VITE_API_BASE_URL }}');
    expect(workflow).toContain('[[ "$VITE_API_BASE_URL" == https://dev.ageniza.com.br/api ]]');
  });

  it('skips the deploy when develop moved on, and smoke-tests the version it served', () => {
    expect(workflow).toContain('git/ref/heads/develop');
    expect(workflow).toContain('"$DEV_PUBLIC_URL/version.txt?run=$GITHUB_RUN_ID"');
    expect(workflow).toContain('"$DEV_PUBLIC_URL/api/health"');
  });

  it('uses an SSH action that accepts only the dev account', () => {
    const action = read('.github/actions/dev-ssh/action.yml');
    expect(action).toContain('Host dev');
    expect(action).toContain('[[ "$SSH_USER" == ageniza-dev-ci ]]');
    expect(action).not.toMatch(/PRODUCTION_|ssh production/);
  });
});

describe('the image cleanup of the dev entrypoint', () => {
  const namespace = 'ghcr.io/nocrato-tech';
  const keys = { api: 'API_IMAGE', web: 'WEB_IMAGE', worker: 'WORKER_IMAGE', migrations: 'MIGRATIONS_IMAGE' };
  const image = (name, fill) => `${namespace}/ageniza-${name}@sha256:${fill.repeat(64)}`;
  const release = (fill) => Object.keys(keys).map((name) => image(name, fill));
  const manifest = (fill) => `${Object.entries(keys).map(([name, key]) => `${key}=${image(name, fill)}`).join('\n')}\n`;
  const lines = (text) => text.split('\n').filter(Boolean);
  const sorted = (list) => [...list].sort();

  // `docker` is a shell function over three files: the images on the host, the ones a container uses, and the calls it got.
  const fakeDocker = `docker() {
  printf '%s ' "$@" >> "$CALLS"; printf '\\n' >> "$CALLS"
  if [[ "$1 $2" == 'image rm' ]]; then
    grep -Fxq -- "$3" "$IMAGES" || { echo "Error response from daemon: No such image: $3" >&2; return 1; }
    if grep -Fxq -- "$3" "$USED" || [[ -n "\${RM_FAILS:-}" ]]; then echo "Error response from daemon: conflict: unable to delete (image is being used by a running container)" >&2; return 1; fi
    grep -Fxv -- "$3" "$IMAGES" > "$IMAGES.new" || true; mv "$IMAGES.new" "$IMAGES"; echo "Untagged: $3"
  elif [[ "$1 $2" == 'image ls' ]]; then cat "$IMAGES"
  elif [[ "$1 $2" == 'image inspect' ]]; then echo "$3"
  fi
}
install() { cp -- "\${@: -2:1}" "\${@: -1}"; }`;

  const setup = ({ pulled, hostImages = [], used = [], withPrevious = true }) => {
    const directory = temporaryDirectory();
    const releaseDir = join(directory, 'releases');
    mkdirSync(releaseDir);
    writeFileSync(join(releaseDir, 'current.env'), manifest('c'));
    if (withPrevious) writeFileSync(join(releaseDir, 'previous.env'), manifest('b'));
    const files = { calls: join(directory, 'calls'), images: join(directory, 'images'), used: join(directory, 'used') };
    writeFileSync(files.calls, '');
    writeFileSync(files.images, `${[...new Set([...release('c'), ...release('b'), ...(pulled ?? []), ...hostImages])].join('\n')}\n`);
    writeFileSync(files.used, `${used.join('\n')}\n`);
    if (pulled) writeFileSync(join(releaseDir, 'pulled-images.list'), `${pulled.join('\n')}\n`);
    const call = (body, env = {}) =>
      run(`${preamble}IMAGE_NAMESPACE=${namespace}\nRELEASE_DIR="${posix(releaseDir)}"\nPULLED_IMAGES="${posix(releaseDir)}/pulled-images.list"\nCALLS="${posix(files.calls)}"\nIMAGES="${posix(files.images)}"\nUSED="${posix(files.used)}"\n${fakeDocker}\n${body}`, env);
    const state = () => ({
      calls: lines(readFileSync(files.calls, 'utf8')).map((line) => line.trim()),
      images: lines(readFileSync(files.images, 'utf8')),
      list: lines(readFileSync(join(releaseDir, 'pulled-images.list'), 'utf8')),
      previous: existsSync(join(releaseDir, 'previous.env')) ? readFileSync(join(releaseDir, 'previous.env'), 'utf8') : null
    });
    return { call, state, releaseDir, files };
  };
  const cleanup = functionsOf(deploy, 'die', 'note', 'read_value', 'remove_unreferenced_images');
  const old = release('a');
  const everything = [...old, ...release('b'), ...release('c')];

  it('removes the images that neither the live nor the previous release uses, by digest, and nothing else', () => {
    const { call, state } = setup({ pulled: everything });
    expect(call(`${cleanup}\nremove_unreferenced_images`).status).toBe(0);
    const { calls, images, list } = state();
    expect(sorted(calls)).toEqual(sorted(old.map((ref) => `image rm ${ref}`)));
    expect(sorted(images)).toEqual(sorted([...release('b'), ...release('c')]));
    expect(sorted(list)).toEqual(sorted([...release('b'), ...release('c')]));
  });

  it('keeps the previous release, so the image of the release before the live one stays on the host', () => {
    const { call, state } = setup({ pulled: everything });
    call(`${cleanup}\nremove_unreferenced_images`);
    const { calls, images } = state();
    for (const ref of release('b')) {
      expect(images).toContain(ref);
      expect(calls.join('\n')).not.toContain(ref);
    }
  });

  it('keeps everything the live manifest names even when no previous release exists yet', () => {
    const { call, state } = setup({ pulled: [...old, ...release('c')], withPrevious: false });
    expect(call(`${cleanup}\nremove_unreferenced_images`).status).toBe(0);
    expect(sorted(state().images)).toEqual(sorted(release('b').concat(release('c'))));
    expect(state().calls.map((line) => line.replace('image rm ', ''))).toEqual(expect.arrayContaining(old));
  });

  it('never touches an image it did not pull: another project, another registry, the database or the mail sink', () => {
    const foreign = [
      `ghcr.io/other-org/ageniza-api@sha256:${'e'.repeat(64)}`,
      `${namespace}/some-other-project@sha256:${'e'.repeat(64)}`,
      `${namespace}/ageniza-api@sha256:${'f'.repeat(64)}`,
      `docker.io/library/postgres@sha256:${'e'.repeat(64)}`,
      `axllent/mailpit@sha256:${'e'.repeat(64)}`
    ];
    const { call, state } = setup({ pulled: everything, hostImages: foreign });
    expect(call(`${cleanup}\nremove_unreferenced_images`).status).toBe(0);
    expect(state().images).toEqual(expect.arrayContaining(foreign));
    expect(state().calls.join('\n')).not.toMatch(/other-org|some-other-project|f{64}|postgres|mailpit/);
  });

  it('never forces the removal and never prunes, here or anywhere else in the script', () => {
    const { call, state } = setup({ pulled: everything });
    call(`${cleanup}\nremove_unreferenced_images`);
    expect(state().calls.length).toBeGreaterThan(0);
    for (const line of state().calls) expect(line).toMatch(/^image rm \S+$/);
    const code = deploy.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/docker\s+(?:system|image|container|volume|builder)\s+prune|\bprune\s+-a/);
    expect(code).not.toMatch(/docker\s+(?:image\s+)?rm\s+(?:-\w*f|--force)/);
  });

  it('keeps an image a container still uses listed for the next release, and still succeeds', () => {
    const { call, state } = setup({ pulled: everything, used: [old[0]] });
    const result = call(`${cleanup}\nremove_unreferenced_images`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`could not remove image ${old[0]}`);
    expect(state().images).toContain(old[0]);
    expect(state().list).toContain(old[0]);
    expect(state().images).not.toContain(old[1]);
  });

  it('survives every removal failing, and drops from the record an image that is already gone', () => {
    const { call, state } = setup({ pulled: everything });
    const result = call(`${cleanup}\nremove_unreferenced_images`, { RM_FAILS: '1' });
    expect(result.status).toBe(0);
    expect(sorted(state().list)).toEqual(sorted(everything));
    const gone = setup({ pulled: [...old, ...release('c')] });
    writeFileSync(gone.files.images, `${release('c').join('\n')}\n`);
    expect(gone.call(`${cleanup}\nremove_unreferenced_images`).status).toBe(0);
    expect(sorted(gone.state().list)).toEqual(sorted(release('c')));
  });

  it('is run after the release is live and recorded, and a failure there is only logged', () => {
    expect(deploy).toMatch(/write_current_manifest\n\s+RESTORE_ARMED=false\n\s+prune_runtime_snapshots\n[^\n]*\n\s+remove_unreferenced_images \|\| note '[^']+'\n\s+note "release \$sha is active"/);
  });

  describe('the record of what this script pulled', () => {
    it('gains every application image the script pulls, once, and never the database or the sink', () => {
      const { call, state } = setup({ pulled: [] });
      const pull = functionsOf(deploy, 'die', 'pull_verified_image');
      const result = call(`REGISTRY_CONFIG=/nonexistent\n${pull}\npull_verified_image ${image('api', 'c')}\npull_verified_image ${image('api', 'c')}\npull_verified_image axllent/mailpit@sha256:${'e'.repeat(64)}\npull_verified_image ${image('web', 'c')}`);
      expect(result.status).toBe(0);
      expect(state().list).toEqual([image('api', 'c'), image('web', 'c')]);
    });

    it('is seeded once with the application images of this namespace already on the host, and never again', () => {
      const seed = functionsOf(deploy, 'seed_pulled_images');
      const foreign = [`ghcr.io/other-org/ageniza-api@sha256:${'e'.repeat(64)}`, `docker.io/library/postgres@sha256:${'e'.repeat(64)}`, `${namespace}/ageniza-api:develop-abc@<none>`];
      const first = setup({ hostImages: foreign });
      expect(first.call(`${seed}\nseed_pulled_images`).status).toBe(0);
      expect(sorted(first.state().list)).toEqual(sorted([...release('b'), ...release('c')]));
      const again = setup({ pulled: [image('api', 'd')] });
      expect(again.call(`${seed}\nseed_pulled_images`).status).toBe(0);
      expect(again.state().list).toEqual([image('api', 'd')]);
    });
  });

  it('records the manifest that was live as the previous release, and the pruning of snapshots leaves it alone', () => {
    const { call, state, releaseDir } = setup({ pulled: [] });
    const snapshot = (fill) => join(releaseDir, `${fill.repeat(40)}.env`);
    writeFileSync(snapshot('c'), 'x\n');
    writeFileSync(snapshot('d'), 'x\n');
    const script = `${functionsOf(deploy, 'read_value', 'write_current_manifest', 'prune_runtime_snapshots')}
RELEASE=${'d'.repeat(40)} RUN_ID=2 RUNTIME_SNAPSHOT="${posix(snapshot('d'))}"
API_IMAGE=${image('api', 'd')} WEB_IMAGE=${image('web', 'd')} WORKER_IMAGE=${image('worker', 'd')} MIGRATIONS_IMAGE=${image('migrations', 'd')}
write_current_manifest
prune_runtime_snapshots`;
    expect(call(script).status).toBe(0);
    expect(state().previous).toBe(manifest('c'));
    expect(readFileSync(join(releaseDir, 'current.env'), 'utf8')).toContain(`API_IMAGE=${image('api', 'd')}`);
    expect(existsSync(snapshot('d'))).toBe(true);
    expect(existsSync(snapshot('c'))).toBe(false);
  });
});
