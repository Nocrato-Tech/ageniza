import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bootstrap,
  deployUser,
  effectiveFor,
  fakeSshd,
  functionsOf,
  hardened,
  posix,
  preamble,
  removeTemporaryDirectories,
  run,
  sshFiles,
  temporaryDirectory,
  writeSshdFixtures,
} from './vps-bash-harness.mjs';

// Hostinger's Ubuntu image ships /etc/ssh/sshd_config.d/50-cloud-init.conf with `PasswordAuthentication yes`. sshd keeps the
// FIRST value of an option and reads the drop-ins in alphabetical order, so the baseline's 90-ageniza.conf lost and the
// password login stayed on while the bootstrap said it had succeeded. A Match block in a later drop-in beats the global
// options whatever the order, and plain `sshd -T` does not evaluate it (review of #765).
afterEach(removeTemporaryDirectories);

const cloudInit = '# This file is generated from information provided by the datasource.\nPasswordAuthentication yes\n';
const legacyBaseline = '# Managed by bootstrap-ubuntu.sh.\nPort 2222\nPermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n';
const matchRootPassword = 'Match User root\n  PasswordAuthentication yes\n  PermitRootLogin yes\n';

function assertEffective(answers, port = '22') {
  const fixtures = writeSshdFixtures(answers);
  return run(`${preamble}${functionsOf(bootstrap, 'assert_effective_sshd')}\n${fakeSshd}\nassert_effective_sshd ${port} ${deployUser}`, { SSHD_FIXTURES: fixtures });
}

function writeDropin(directory, port, { sshdTestStatus = 0, installStatus = null } = {}) {
  const installStub = installStatus === null ? '' : `install() { return ${installStatus}; }\n`;
  return run(`${preamble}${functionsOf(bootstrap, 'die', 'note', 'write_ssh_dropin')}
sshd() { [[ "$1" == -t ]] && return ${sshdTestStatus}; }
${installStub}write_ssh_dropin "${posix(directory)}" ${port}`);
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
    expect(result.stderr).toContain(`effective SSH setting globally is "${replacement}", expected "${original}"`);
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
    const result = run(`${preamble}${functionsOf(bootstrap, 'assert_effective_sshd')}
sshd() { return 1; }
assert_effective_sshd 22 ${deployUser}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd -T failed');
  });

  it.each([
    ['root', 'permitrootlogin yes', 'effective SSH setting for user root is "permitrootlogin yes"'],
    ['root', 'passwordauthentication yes', 'effective SSH setting for user root is "passwordauthentication yes"'],
    [deployUser, 'passwordauthentication yes', `effective SSH setting for user ${deployUser} is "passwordauthentication yes"`],
    [deployUser, 'kbdinteractiveauthentication yes', `effective SSH setting for user ${deployUser} is "kbdinteractiveauthentication yes"`],
  ])('fails when a Match block turns it back on for %s (%s), which plain sshd -T does not show', (context, bad, message) => {
    const key = bad.split(' ')[0];
    const result = assertEffective({ global: hardened, root: hardened, [deployUser]: hardened, [context]: hardened.map((line) => (line.startsWith(`${key} `) ? bad : line)) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('reads the deploy user it is given, not a fixed one', () => {
    const fixtures = writeSshdFixtures({ global: hardened, root: hardened, other: hardened });
    const result = run(`${preamble}${functionsOf(bootstrap, 'assert_effective_sshd')}\n${fakeSshd}\nassert_effective_sshd 22 other`, { SSHD_FIXTURES: fixtures });

    expect(result.status).toBe(0);
  });

  it('survives an sshd -T output larger than the pipe buffer', () => {
    const fixtures = writeSshdFixtures(hardened, 40000);
    const result = run(`${preamble}${functionsOf(bootstrap, 'assert_effective_sshd')}\n${fakeSshd}\nassert_effective_sshd 22 ${deployUser}`, { SSHD_FIXTURES: fixtures });

    expect(result.status).toBe(0);
  });
});

describe('write_ssh_dropin puts the baseline before the files of the image', () => {
  it('keeps the baseline winning over 50-cloud-init.conf', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);

    expect(writeDropin(directory, 22).status).toBe(0);

    expect(sshFiles(directory).filter((name) => name.endsWith('.conf'))[0]).toBe('00-ageniza.conf');
    expect(effectiveFor(directory).global).toContain('passwordauthentication no');
    expect(assertEffective(effectiveFor(directory)).status).toBe(0);
  });

  it('is what the old 90 name was not: with the baseline at 90 the check fails on the same cloud-init file', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);
    writeFileSync(join(directory, '90-ageniza.conf'), legacyBaseline.replace('2222', '22'));

    expect(effectiveFor(directory).global).toContain('passwordauthentication yes');
    const result = assertEffective(effectiveFor(directory));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('"passwordauthentication yes"');
  });

  it('keeps root and password off for the users a later Match block names, which only Match all in the 00 file does', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), `${cloudInit}${matchRootPassword}`);

    expect(writeDropin(directory, 22).status).toBe(0);

    expect(effectiveFor(directory).root).toEqual(expect.arrayContaining(['passwordauthentication no', 'permitrootlogin no']));
    expect(assertEffective(effectiveFor(directory)).status).toBe(0);
  });

  it('is caught when the Match block sits in a file read before the baseline, which no file order can beat', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-aaa.conf'), matchRootPassword);

    expect(writeDropin(directory, 22).status).toBe(0);
    const result = assertEffective(effectiveFor(directory));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('effective SSH setting for user root is "permitrootlogin yes"');
  });

  it('ends the file with a Match all block that repeats the three options', () => {
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
        'Match all',
        '  PermitRootLogin no',
        '  PasswordAuthentication no',
        '  KbdInteractiveAuthentication no',
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
    expect(effectiveFor(directory).global).toContain('port 22');
    expect(effectiveFor(directory).global).not.toContain('port 2222');
  });

  it('leaves the old 90 file and creates no 00 when the new file cannot be written (a failure there left the host without a baseline)', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '50-cloud-init.conf'), cloudInit);
    writeFileSync(join(directory, '90-ageniza.conf'), legacyBaseline);

    const result = writeDropin(directory, 22, { installStatus: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not write');
    expect(sshFiles(directory)).toEqual(['50-cloud-init.conf', '90-ageniza.conf']);
    expect(readFileSync(join(directory, '90-ageniza.conf'), 'utf8')).toBe(legacyBaseline);
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
    expect(readdirSync(directory).sort()).toEqual(['00-ageniza.conf', '00-ageniza.conf.pre-ageniza']);
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
    run(`${preamble}${functionsOf(bootstrap, 'note', 'report_ssh_overrides')}
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

  it('warns about a Match block and does not list its options as values the baseline wins over', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'PasswordAuthentication no\n');
    writeFileSync(join(directory, '50-cloud-init.conf'), `# image\nPasswordAuthentication yes\n${matchRootPassword}`);

    const { stdout } = report(directory);

    expect(stdout).toContain('50-cloud-init.conf has a Match block (line 3)');
    expect(stdout).toContain('2:PasswordAuthentication yes');
    expect(stdout).not.toContain('PermitRootLogin');
    expect(stdout).not.toContain('4:');
  });

  it('only warns about a file whose options are all inside a Match block', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '00-ageniza.conf'), 'PasswordAuthentication no\n');
    writeFileSync(join(directory, '50-cloud-init.conf'), matchRootPassword);

    const { stdout } = report(directory);

    expect(stdout).toContain('has a Match block (line 1)');
    expect(stdout).not.toContain('so the baseline values win');
  });
});
