import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(block).toMatch(/environment: !override\n(?:\s+[A-Z_]+: .*\n)*?\s+SMTP_URL: smtp:\/\/mailpit:1025\n/);
    expect(block).toMatch(/\n\s+DEPLOY_TARGET: dev\n/);
    expect(block).toMatch(/\n\s+EMAIL_FROM: Ageniza Dev <no-reply@dev\.ageniza\.com\.br>\n/);
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

  it('publishes and deploys only when the owner turned the repository switch on', () => {
    expect(workflow.match(/^ {4}if: vars\.DEV_DEPLOY_ENABLED == 'true'$/gm)).toHaveLength(2);
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
