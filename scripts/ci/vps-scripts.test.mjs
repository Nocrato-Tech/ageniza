import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Hostinger's Ubuntu image ships /etc/ssh/sshd_config.d/50-cloud-init.conf with `PasswordAuthentication yes`. sshd keeps the
// FIRST value of an option and reads the drop-ins in alphabetical order, so the baseline's 90-ageniza.conf lost and the
// password login stayed on while the bootstrap said it had succeeded. The functions are cut out of the real scripts and run
// in bash against a temporary directory, with `sshd` and `systemctl` replaced by shell functions.
const root = join(import.meta.dirname, '..', '..');
const bootstrap = readFileSync(join(root, 'infra', 'vps', 'bootstrap-ubuntu.sh'), 'utf8');
const verify = readFileSync(join(root, 'infra', 'vps', 'verify-vps.sh'), 'utf8');

// The bash on PATH of a Windows machine can be the WSL launcher, which does not see these paths.
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
const posix = (path) => path.replaceAll('\\', '/');

function extractFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start === -1) throw new Error(`function ${name} not found`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start, end + 1).join('\n');
}

function run(script, env = {}) {
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bootstrapFunctions = (...names) => names.map((name) => extractFunction(bootstrap, name)).join('\n');
const preamble = `set -Eeuo pipefail\nIFS=$'\\n\\t'\nSCRIPT_NAME=bootstrap-ubuntu.sh\n`;

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'ageniza-vps-'));
  directories.push(directory);
  return directory;
}

const cloudInit = '# This file is generated from information provided by the datasource.\nPasswordAuthentication yes\n';
const legacyBaseline = '# Managed by bootstrap-ubuntu.sh.\nPort 2222\nPermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n';
const hardened = ['port 22', 'permitrootlogin no', 'passwordauthentication no', 'kbdinteractiveauthentication no', 'pubkeyauthentication yes'];
const sshFiles = (directory) => readdirSync(directory).sort();

function assertEffective(effectiveLines, port = '22') {
  const fixture = join(temporaryDirectory(), 'sshd-T.txt');
  writeFileSync(fixture, `${effectiveLines.join('\n')}\n`);
  const script = `${preamble}${bootstrapFunctions('assert_effective_sshd')}
sshd() { [[ "$1" == -T ]] && cat "$SSHD_FIXTURE"; }
assert_effective_sshd ${port}`;
  return run(script, { SSHD_FIXTURE: posix(fixture) });
}

// What `sshd -T` prints for a directory of drop-ins: the first value wins, except Port, which accumulates.
function effectiveSshd(directory) {
  const effective = { passwordauthentication: 'yes', permitrootlogin: 'prohibit-password', kbdinteractiveauthentication: 'no' };
  const ports = [];
  const seen = new Set();
  const files = readdirSync(directory).filter((name) => name.endsWith('.conf')).sort();
  for (const name of files) {
    for (const line of readFileSync(join(directory, name), 'utf8').split('\n')) {
      const [keyword, value] = line.trim().split(/\s+/);
      const key = keyword?.toLowerCase();
      if (!key || key.startsWith('#') || !value) continue;
      if (key === 'port') ports.push(value);
      else if (!seen.has(key)) {
        seen.add(key);
        effective[key] = value;
      }
    }
  }
  const lines = Object.entries(effective).map(([key, value]) => `${key} ${value}`);
  return [...(ports.length ? ports : ['22']).map((port) => `port ${port}`), ...lines];
}

function writeDropin(directory, port, { sshdTestStatus = 0 } = {}) {
  const script = `${preamble}${bootstrapFunctions('die', 'note', 'write_ssh_dropin')}
sshd() { [[ "$1" == -t ]] && return ${sshdTestStatus}; }
write_ssh_dropin "${posix(directory)}" ${port}`;
  return run(script);
}

describe('assert_effective_sshd reads what sshd would load', () => {
  it('passes when password, keyboard-interactive and root login are off and the port is the only one', () => {
    expect(assertEffective(hardened).status).toBe(0);
  });

  it('checks the port it is given, not a fixed one', () => {
    expect(assertEffective(['port 2222', ...hardened.slice(1)], '2222').status).toBe(0);
    expect(assertEffective(hardened, '2222').status).not.toBe(0);
  });

  it.each([
    ['password login on (the cloud-init file won)', 'passwordauthentication no', 'passwordauthentication yes'],
    ['root login on', 'permitrootlogin no', 'permitrootlogin yes'],
    ['root login by key only', 'permitrootlogin no', 'permitrootlogin prohibit-password'],
    ['keyboard-interactive on', 'kbdinteractiveauthentication no', 'kbdinteractiveauthentication yes'],
  ])('fails with %s', (_label, original, replacement) => {
    const result = assertEffective(hardened.map((line) => (line === original ? replacement : line)));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`effective SSH setting is "${replacement}", expected "${original}"`);
  });

  it('fails with another port', () => {
    const result = assertEffective(['port 2222', ...hardened.slice(1)]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('effective SSH ports are "port 2222", expected only "port 22"');
  });

  it('fails when sshd also listens on a second port', () => {
    const result = assertEffective(['port 22', 'port 2222', ...hardened.slice(1)]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('effective SSH ports are "port 22, port 2222", expected only "port 22"');
  });

  it('fails when the option is missing from the output, instead of assuming it is off', () => {
    const result = assertEffective(['port 22', 'permitrootlogin no', 'passwordauthentication no']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('kbdinteractiveauthentication <unset>');
  });

  it('fails when sshd -T itself fails', () => {
    const result = run(`${preamble}${bootstrapFunctions('assert_effective_sshd')}
sshd() { return 1; }
assert_effective_sshd 22`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd -T failed');
  });
});

describe('write_ssh_dropin puts the baseline before the files of the image', () => {
  it('keeps the baseline winning over 50-cloud-init.conf', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);

    expect(writeDropin(directory, 22).status).toBe(0);

    expect(sshFiles(directory).filter((name) => name.endsWith('.conf'))[0]).toBe('00-ageniza.conf');
    expect(effectiveSshd(directory)).toContain('passwordauthentication no');
    expect(assertEffective(effectiveSshd(directory)).status).toBe(0);
  });

  it('is what the old 90 name was not: with the baseline at 90 the check fails on the same cloud-init file', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);
    writeFileSync(join(directory, '90-ageniza.conf'), legacyBaseline.replace('2222', '22'));

    expect(effectiveSshd(directory)).toContain('passwordauthentication yes');
    const result = assertEffective(effectiveSshd(directory));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('"passwordauthentication yes"');
  });

  it('writes the options of the baseline with the port it was given', () => {
    const directory = temporaryDirectory();

    expect(writeDropin(directory, 2200).status).toBe(0);

    expect(readFileSync(join(directory, '00-ageniza.conf'), 'utf8')).toBe(
      [
        '# Managed by bootstrap-ubuntu.sh. Keep an established root session open until a new key-based login succeeds.',
        'Port 2200',
        'PermitRootLogin no',
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM yes',
        'X11Forwarding no',
        'MaxAuthTries 3',
        'LoginGraceTime 30',
        '',
      ].join('\n'),
    );
  });

  it('moves a 90-ageniza.conf from the previous bootstrap aside, so its Port does not stay open next to the new one', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);
    writeFileSync(join(directory, '90-ageniza.conf'), legacyBaseline);

    expect(writeDropin(directory, 22).status).toBe(0);

    expect(sshFiles(directory)).toEqual(['00-ageniza.conf', '50-cloud-init.conf', '90-ageniza.conf.pre-ageniza']);
    expect(readFileSync(join(directory, '90-ageniza.conf.pre-ageniza'), 'utf8')).toBe(legacyBaseline);
    expect(effectiveSshd(directory)).toContain('port 22');
    expect(effectiveSshd(directory)).not.toContain('port 2222');
  });

  it('never touches the files of the image', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);

    writeDropin(directory, 22);

    expect(readFileSync(join(directory, '50-cloud-init.conf'), 'utf8')).toBe(cloudInit);
  });

  it('keeps a backup of the baseline it replaces on a re-run and leaves no temporary file', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'Port 2200\n');

    expect(writeDropin(directory, 22).status).toBe(0);

    expect(readFileSync(join(directory, '00-ageniza.conf.pre-ageniza'), 'utf8')).toBe('Port 2200\n');
    expect(sshFiles(directory)).toEqual(['00-ageniza.conf', '00-ageniza.conf.pre-ageniza']);
  });

  it('restores the previous 00 and 90 files and fails when sshd rejects the new one', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'Port 2200\n');
    writeFileSync(join(directory, '90-ageniza.conf'), legacyBaseline);

    const result = writeDropin(directory, 22, { sshdTestStatus: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SSH configuration was not applied');
    expect(sshFiles(directory)).toEqual(['00-ageniza.conf', '90-ageniza.conf']);
    expect(readFileSync(join(directory, '00-ageniza.conf'), 'utf8')).toBe('Port 2200\n');
    expect(readFileSync(join(directory, '90-ageniza.conf'), 'utf8')).toBe(legacyBaseline);
  });

  it('removes the new file when sshd rejects it and there was nothing before', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);

    const result = writeDropin(directory, 22, { sshdTestStatus: 1 });

    expect(result.status).not.toBe(0);
    expect(sshFiles(directory)).toEqual(['50-cloud-init.conf']);
  });
});

describe('report_ssh_overrides logs the other files that set an option of the baseline', () => {
  const report = (directory) =>
    run(`${preamble}${bootstrapFunctions('note', 'report_ssh_overrides')}
report_ssh_overrides "${posix(directory)}" "${posix(directory)}/00-ageniza.conf"`);

  it('names the cloud-init file and says the baseline value wins over it', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'PasswordAuthentication no\n');
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);

    const { status, stdout } = report(directory);

    expect(status).toBe(0);
    expect(stdout).toContain('50-cloud-init.conf is read after 00-ageniza.conf, so the baseline values win over:');
    expect(stdout).toContain('2:PasswordAuthentication yes');
  });

  it('warns when a file read before the baseline would win', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'PasswordAuthentication no\n');
    writeFileSync(join(directory, '00-aaa.conf'), 'PasswordAuthentication yes\n');

    expect(report(directory).stdout).toContain('WARNING');
    expect(report(directory).stdout).toContain('00-aaa.conf is read before 00-ageniza.conf and its first value wins:');
  });

  it('says nothing about a file that sets none of those options', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'PasswordAuthentication no\n');
    writeFileSync(join(directory, '60-other.conf'), 'X11Forwarding no\n');

    expect(report(directory).stdout).toBe('');
  });
});

describe('the time daemon is chrony on Ubuntu 25.10 and newer, systemd-timesyncd before', () => {
  const scripts = [
    ['bootstrap-ubuntu.sh', bootstrap],
    ['verify-vps.sh', verify],
  ];
  const timeService = (source, chronyExists) =>
    run(`set -Eeuo pipefail\n${extractFunction(source, 'time_service')}
systemctl() { [[ "$1 $2" == "cat chrony.service" ]] && return ${chronyExists ? 0 : 1}; return 99; }
time_service`).stdout.trim();

  it.each(scripts)('%s picks chrony.service when systemctl finds it', (_name, source) => {
    expect(timeService(source, true)).toBe('chrony.service');
  });

  it.each(scripts)('%s picks systemd-timesyncd.service when there is no chrony', (_name, source) => {
    expect(timeService(source, false)).toBe('systemd-timesyncd.service');
  });

  it('enables and verifies the chosen service, never a fixed one', () => {
    expect(bootstrap).toContain('TIME_SERVICE="$(time_service)"\nsystemctl enable --now "$TIME_SERVICE"');
    expect(bootstrap).not.toMatch(/systemctl enable --now systemd-timesyncd/);
    expect(verify).toMatch(/for service in docker\.service containerd\.service "\$\(time_service\)" unattended-upgrades\.service; do/);
  });
});

describe('the bootstrap only reports success after the effective SSH configuration passed', () => {
  const at = (text) => {
    const index = bootstrap.indexOf(text);
    expect(index, `${text} is missing from bootstrap-ubuntu.sh`).toBeGreaterThan(-1);
    return index;
  };

  it('writes the drop-in, reloads sshd, checks, and only then prints the success message', () => {
    const write = at('write_ssh_dropin "$SSH_DROPIN_DIR" "$SSH_PORT"');
    const reload = at('systemctl reload ssh.service');
    const check = at('if ! assert_effective_sshd "$SSH_PORT"; then');
    const failure = at('The baseline was NOT installed successfully');
    const success = at('Baseline installed successfully.');

    expect(write).toBeLessThan(reload);
    expect(reload).toBeLessThan(check);
    expect(check).toBeLessThan(failure);
    expect(failure).toBeLessThan(success);
    expect(bootstrap.slice(check, success)).toMatch(/die "/);
  });

  it('is the only place that says it succeeded', () => {
    expect(bootstrap.match(/Baseline installed successfully/g)).toHaveLength(1);
  });

  it('puts the baseline drop-in in the 00 slot', () => {
    expect(extractFunction(bootstrap, 'write_ssh_dropin')).toContain('dropin="$dir/00-ageniza.conf"');
    expect(bootstrap).toContain('report_ssh_overrides "$SSH_DROPIN_DIR" "$SSH_DROPIN_DIR/00-ageniza.conf"');
  });
});

describe('verify-vps.sh checks the same SSH settings as the bootstrap', () => {
  it.each(['permitrootlogin no', 'passwordauthentication no', 'kbdinteractiveauthentication no'])('requires %s', (setting) => {
    expect(verify).toContain(`grep -qx '${setting}'`);
  });

  it('requires the SSH port to be the only one', () => {
    expect(verify).toContain('[[ "$EFFECTIVE_SSH_PORTS" == "port $SSH_PORT" ]]');
  });
});
