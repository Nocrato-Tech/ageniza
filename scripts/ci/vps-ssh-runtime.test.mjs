import { writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bootstrap,
  deployUser,
  extractFunction,
  fakeSshd,
  functionsOf,
  hardened,
  posix,
  removeTemporaryDirectories,
  run,
  temporaryDirectory,
  verify,
  writeSshdFixtures,
} from './vps-bash-harness.mjs';

afterEach(removeTemporaryDirectories);

// Review of #765: under socket activation sshd ignores Port, so the port that listens has to be read from the sockets; and
// `sshd -T | grep -q` under pipefail dies of SIGPIPE when sshd -T writes more than grep read before it exited.
const sshLine = (address, process = 'sshd') => `LISTEN 0 128 ${address} 0.0.0.0:* users:(("${process}",pid=801,fd=3))`;

// ss and systemctl answer the way the real ones do for the calls the scripts make, and refuse any other.
const fakeSockets = `ss() {
  [[ "$*" == "-Htlnp" ]] || { echo "ss: unsupported arguments: $*" >&2; return 255; }
  printf '%s\\n' "\${SS_LINES:-}"
}
systemctl() {
  local IFS=' '
  case "$*" in
    "is-active --quiet ssh.socket") [[ -n "\${SOCKET_LISTEN:-}" ]] ;;
    "show ssh.socket --property=Listen --value") printf '%s\\n' "$SOCKET_LISTEN" ;;
    *) echo "systemctl: unsupported arguments: $*" >&2; return 255 ;;
  esac
}`;

function assertListening(env, port) {
  return run(`set -Eeuo pipefail\nIFS=$'\\n\\t'\n${fakeSockets}\n${functionsOf(bootstrap, 'listening_ssh_ports', 'assert_listening_ssh_port')}\nassert_listening_ssh_port ${port} 1`, env);
}

describe('assert_listening_ssh_port reads where sshd listens, not what the configuration says', () => {
  it('passes when sshd listens on the port, on IPv4 and IPv6', () => {
    const lines = [sshLine('0.0.0.0:22'), sshLine('[::]:22')].join('\n');

    expect(assertListening({ SS_LINES: lines }, 22).status).toBe(0);
  });

  it('fails when sshd is still on the old port after the configuration moved to another (SSH_PORT=2222 with ssh.socket)', () => {
    const result = assertListening({ SS_LINES: [sshLine('0.0.0.0:22'), sshLine('[::]:22')].join('\n') }, 2222);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd listens on "22", expected only "2222"');
  });

  it('fails when the port of a migrated 90 file keeps listening next to the new one', () => {
    const result = assertListening({ SS_LINES: [sshLine('0.0.0.0:22'), sshLine('0.0.0.0:2200')].join('\n') }, 22);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd listens on "22,2200", expected only "22"');
  });

  it('ignores what other programs listen on', () => {
    const lines = [sshLine('0.0.0.0:22'), sshLine('127.0.0.1:5432', 'postgres'), sshLine('[::]:80', 'nginx')].join('\n');

    expect(assertListening({ SS_LINES: lines }, 22).status).toBe(0);
  });

  it('reads the sockets of ssh.socket when sshd itself is not running yet', () => {
    const env = { SS_LINES: '', SOCKET_LISTEN: '[::]:2222 (Stream)\n0.0.0.0:2222 (Stream)' };

    expect(assertListening(env, 2222).status).toBe(0);
    expect(assertListening(env, 22).status).not.toBe(0);
  });

  it('fails on the old port kept by ssh.socket even when no sshd process shows it', () => {
    const result = assertListening({ SS_LINES: '', SOCKET_LISTEN: '0.0.0.0:22 (Stream)' }, 2222);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd listens on "22", expected only "2222"');
  });

  it('fails when nothing listens', () => {
    const result = assertListening({ SS_LINES: '' }, 22);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sshd listens on "nothing"');
  });

  it('keeps trying while the daemon binds, and gives up after the attempts it is given', () => {
    const counter = `${posix(temporaryDirectory())}/calls`;
    const script = `set -Eeuo pipefail\nIFS=$'\\n\\t'\n${fakeSockets}\nsleep() { :; }
ss() { local n; n=$(($(cat "${counter}") + 1)); echo "$n" > "${counter}"; if [[ $n -ge 3 ]]; then printf '%s\\n' "$SS_LINES"; fi; }
${functionsOf(bootstrap, 'listening_ssh_ports', 'assert_listening_ssh_port')}`;
    const env = { SS_LINES: sshLine('0.0.0.0:22') };

    writeFileSync(counter, '0');
    expect(run(`${script}\nassert_listening_ssh_port 22 3`, env).status).toBe(0);
    writeFileSync(counter, '0');
    expect(run(`${script}\nassert_listening_ssh_port 22 2`, env).status).not.toBe(0);
  });
});

describe('restart_ssh_socket_if_enabled follows the port in the configuration', () => {
  const restart = (socketEnabled, failing = null) =>
    run(`set -Eeuo pipefail\nSSH_PORT=2222\n${functionsOf(bootstrap, 'die', 'note', 'restart_ssh_socket_if_enabled')}
systemctl() {
  echo "systemctl $*" >&2
  [[ "$1" != is-enabled ]] || return ${socketEnabled ? 0 : 1}
  if [[ "$1" == "${failing}" || "\${2:-}" == "${failing}" ]]; then echo 'Job for ssh.socket failed.' >&2; return 1; fi
}
restart_ssh_socket_if_enabled`);

  it('reloads the units and restarts ssh.socket, in that order, when it is enabled', () => {
    const calls = restart(true).stderr.trim().split('\n');

    expect(calls).toEqual(['systemctl is-enabled --quiet ssh.socket', 'systemctl daemon-reload', 'systemctl restart ssh.socket']);
  });

  it('touches nothing when ssh.socket is not enabled', () => {
    const result = restart(false);

    expect(result.status).toBe(0);
    expect(result.stderr.trim().split('\n')).toEqual(['systemctl is-enabled --quiet ssh.socket']);
  });

  it('stops with a clear message, not a bare Job failed, when ssh.socket cannot restart', () => {
    const result = restart(true, 'restart');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not restart ssh.socket');
    expect(result.stderr).toContain('TCP 2222');
    expect(result.stderr).toContain('NOT installed successfully');
    expect(result.stderr).toContain('Keep this root session open');
  });

  it('stops with a clear message when daemon-reload fails, and does not restart the socket', () => {
    const result = restart(true, 'daemon-reload');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('systemctl daemon-reload failed');
    expect(result.stderr).toContain('Keep this root session open');
    expect(result.stderr).not.toContain('systemctl restart');
  });
});

describe('assert_ssh_port_free refuses a port that another process holds, before anything is written', () => {
  const portFree = (env, port = 2222) =>
    run(`set -Eeuo pipefail\nIFS=$'\\n\\t'\n${fakeSockets}\n${functionsOf(bootstrap, 'die', 'assert_ssh_port_free')}\nassert_ssh_port_free ${port}`, env);
  const holder = (address, process) => sshLine(address, process);

  it('passes when nothing listens on the port', () => {
    expect(portFree({ SS_LINES: holder('0.0.0.0:22', 'sshd') }).status).toBe(0);
    expect(portFree({ SS_LINES: '' }).status).toBe(0);
  });

  it('passes when sshd itself holds the port (a re-run)', () => {
    expect(portFree({ SS_LINES: [holder('0.0.0.0:22', 'sshd'), holder('[::]:22', 'sshd')].join('\n') }, 22).status).toBe(0);
  });

  it.each([
    ['IPv4', '0.0.0.0:2222'],
    ['IPv6', '[::]:2222'],
  ])('refuses the port when another process listens on it (%s) and says to keep the root session', (_family, address) => {
    const result = portFree({ SS_LINES: holder(address, 'nginx') });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TCP port 2222 is already in use by another process');
    expect(result.stderr).toContain('nginx');
    expect(result.stderr).toContain('Keep this root session open');
  });

  it('refuses the port when sshd and another process both hold it', () => {
    const result = portFree({ SS_LINES: [holder('0.0.0.0:2222', 'sshd'), holder('127.0.0.1:2222', 'postgres')].join('\n') });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('postgres');
  });

  it('ignores what other programs listen on at other ports', () => {
    expect(portFree({ SS_LINES: [holder('[::]:80', 'nginx'), holder('0.0.0.0:22222', 'nginx')].join('\n') }).status).toBe(0);
  });

  it('accepts systemd holding the port for ssh.socket, and refuses systemd holding it for something else', () => {
    const lines = holder('0.0.0.0:22', 'systemd');

    expect(portFree({ SS_LINES: lines, SOCKET_LISTEN: '0.0.0.0:22 (Stream)\n[::]:22 (Stream)' }, 22).status).toBe(0);
    expect(portFree({ SS_LINES: lines, SOCKET_LISTEN: '' }, 22).status).not.toBe(0);
    expect(portFree({ SS_LINES: lines, SOCKET_LISTEN: '0.0.0.0:2200 (Stream)' }, 22).status).not.toBe(0);
  });
});

describe('the shell harness gives up on a script that never returns', () => {
  it('fails instead of holding the suite', () => {
    expect(() => run('exec sleep 20', {}, { timeout: 300 })).toThrow(/did not finish within 300 ms/);
  });
});

describe('verify-vps.sh reads sshd -T once, so pipefail cannot turn a correct configuration into FAIL', () => {
  const checkEffective = (answers, padding, port = '22') => {
    const fixtures = writeSshdFixtures(answers, padding);
    return run(`set -Eeuo pipefail\nIFS=$'\\n\\t'\nDEPLOY_USER=${deployUser}\nSSH_PORT=${port}\nFAILURES=0\n${functionsOf(verify, 'pass', 'fail', 'check_effective_ssh')}\n${fakeSshd}
check_effective_ssh
echo "failures=$FAILURES"`, { SSHD_FIXTURES: fixtures });
  };

  it('passes the three settings and the port, globally and for root and the deploy user, with a small output', () => {
    const { stdout } = checkEffective(hardened, 0);

    expect(stdout).toContain('failures=0');
    expect(stdout.match(/PASS/g)).toHaveLength(10);
  });

  it('still passes when sshd -T writes more than 64 KiB after the lines it checks', () => {
    const { stdout, stderr } = checkEffective(hardened, 40000);

    expect(stderr).toBe('');
    expect(stdout).toContain('failures=0');
  });

  it.each([
    ['permitrootlogin yes', "effective SSH setting is not 'permitrootlogin no'"],
    ['passwordauthentication yes', "effective SSH setting is not 'passwordauthentication no'"],
    ['kbdinteractiveauthentication yes', "effective SSH setting is not 'kbdinteractiveauthentication no'"],
  ])('fails %s', (bad, message) => {
    const key = bad.split(' ')[0];
    const { stdout, stderr } = checkEffective(hardened.map((line) => (line.startsWith(`${key} `) ? bad : line)), 40000);

    expect(stderr).toContain(message);
    expect(stdout).toContain('failures=3');
  });

  it('fails a Match block that turns password login back on for root', () => {
    const { stdout, stderr } = checkEffective({ global: hardened, root: hardened.map((line) => (line.startsWith('passwordauthentication') ? 'passwordauthentication yes' : line)), [deployUser]: hardened }, 0);

    expect(stderr).toContain("effective SSH setting is not 'passwordauthentication no' for user root");
    expect(stdout).toContain('failures=1');
  });

  it('fails a Match block that turns it back on for the deploy user', () => {
    const { stdout, stderr } = checkEffective({ global: hardened, root: hardened, [deployUser]: hardened.map((line) => (line.startsWith('permitrootlogin') ? 'permitrootlogin yes' : line)) }, 0);

    expect(stderr).toContain(`effective SSH setting is not 'permitrootlogin no' for user ${deployUser}`);
    expect(stdout).toContain('failures=1');
  });

  it('fails a port other than the one it was given, and a second port', () => {
    expect(checkEffective(hardened, 0, '2222').stdout).toContain('failures=1');
    expect(checkEffective(['port 22', 'port 2222', ...hardened.slice(1)], 0).stdout).toContain('failures=1');
  });

  it('fails when sshd -T fails', () => {
    const { stdout } = run(`set -Eeuo pipefail\nIFS=$'\\n\\t'\nDEPLOY_USER=${deployUser}\nSSH_PORT=22\nFAILURES=0\n${functionsOf(verify, 'pass', 'fail', 'check_effective_ssh')}
sshd() { return 1; }
check_effective_ssh 2>/dev/null
echo "failures=$FAILURES"`);

    expect(stdout).toContain('failures=10');
  });

  const checkListening = (env, port) =>
    run(`set -Eeuo pipefail\nIFS=$'\\n\\t'\nSSH_PORT=${port}\nFAILURES=0\n${fakeSockets}\n${functionsOf(verify, 'pass', 'fail', 'listening_ssh_ports', 'check_listening_ssh')}
check_listening_ssh
echo "failures=$FAILURES"`, env);

  it('requires sshd to listen only on the port it was given', () => {
    const env = { SS_LINES: [sshLine('0.0.0.0:22'), sshLine('[::]:22')].join('\n') };

    expect(checkListening(env, 22).stdout).toContain('failures=0');
    expect(checkListening(env, 2222).stdout).toContain('failures=1');
    expect(checkListening(env, 2222).stderr).toContain("sshd listens on '22', expected only 2222");
  });

  it('reads ssh.socket, and fails the port it keeps after the configuration moved', () => {
    const env = { SS_LINES: '', SOCKET_LISTEN: '0.0.0.0:22 (Stream)' };

    expect(checkListening(env, 22).stdout).toContain('failures=0');
    expect(checkListening(env, 2222).stdout).toContain('failures=1');
  });

  it('fails when nothing listens', () => {
    expect(checkListening({ SS_LINES: '' }, 22).stderr).toContain("sshd listens on 'nothing'");
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

describe('the bootstrap only reports success after the effective SSH configuration and the listening port passed', () => {
  const at = (text) => {
    const index = bootstrap.indexOf(text);
    expect(index, `${text} is missing from bootstrap-ubuntu.sh`).toBeGreaterThan(-1);
    return index;
  };

  it('writes the drop-in, reloads sshd and the socket, checks both, and only then prints the success message', () => {
    const free = at('assert_ssh_port_free "$SSH_PORT"\n');
    const write = at('write_ssh_dropin "$SSH_DROPIN_DIR" "$SSH_PORT"');
    const reload = at('systemctl reload ssh.service');
    const socket = at('restart_ssh_socket_if_enabled\n');
    const check = at('if ! assert_effective_sshd "$SSH_PORT" "$DEPLOY_USER"; then');
    const listening = at('if ! assert_listening_ssh_port "$SSH_PORT"; then');
    const success = at('Baseline installed successfully.');

    expect(free).toBeLessThan(write);
    expect(write).toBeLessThan(reload);
    expect(reload).toBeLessThan(socket);
    expect(socket).toBeLessThan(check);
    expect(check).toBeLessThan(listening);
    expect(listening).toBeLessThan(success);
    expect(bootstrap.slice(check, listening)).toMatch(/NOT installed successfully[\s\S]*die|die "[^"]*NOT installed successfully/);
    expect(bootstrap.slice(listening, success)).toMatch(/die "[^"]*NOT installed successfully/);
  });

  it('is the only place that says it succeeded', () => {
    expect(bootstrap.match(/Baseline installed successfully/g)).toHaveLength(1);
  });

  it('puts the baseline drop-in in the 00 slot', () => {
    expect(extractFunction(bootstrap, 'write_ssh_dropin')).toContain('dropin="$dir/00-ageniza.conf"');
    expect(bootstrap).toContain('report_ssh_overrides "$SSH_DROPIN_DIR" "$SSH_DROPIN_DIR/00-ageniza.conf"');
  });
});

describe('verify-vps.sh runs the SSH checks', () => {
  it('calls the effective-configuration check and the listening-port check', () => {
    expect(verify).toMatch(/^check_effective_ssh$/m);
    expect(verify).toMatch(/^check_listening_ssh$/m);
  });
});
