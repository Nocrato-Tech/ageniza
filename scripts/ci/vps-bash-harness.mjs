import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The functions of the VPS scripts are cut out of the real files and run in bash, with `sshd`, `ss` and `systemctl` replaced
// by shell functions. Used by vps-scripts.test.mjs and vps-ssh-runtime.test.mjs.
const root = join(import.meta.dirname, '..', '..');
export const bootstrap = readFileSync(join(root, 'infra', 'vps', 'bootstrap-ubuntu.sh'), 'utf8');
export const verify = readFileSync(join(root, 'infra', 'vps', 'verify-vps.sh'), 'utf8');

// The bash on PATH of a Windows machine can be the WSL launcher, which does not see these paths.
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
export const posix = (path) => path.replaceAll('\\', '/');

export function extractFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start === -1) throw new Error(`function ${name} not found`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start, end + 1).join('\n');
}

// A script that never returns (a mutation that turns a retry loop into an endless one) must fail the test, not hold the suite.
export function run(script, env = {}, { timeout = 60_000 } = {}) {
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env }, timeout, killSignal: 'SIGKILL' });
  if (result.error) throw new Error(`bash did not finish within ${timeout} ms: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const functionsOf = (source, ...names) => names.map((name) => extractFunction(source, name)).join('\n');
export const preamble = `set -Eeuo pipefail\nIFS=$'\\n\\t'\nSCRIPT_NAME=bootstrap-ubuntu.sh\n`;

const directories = [];
export function removeTemporaryDirectories() {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
export function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'ageniza-vps-'));
  directories.push(directory);
  return directory;
}

export const sshFiles = (directory) => readdirSync(directory).sort();

// Answers like sshd: `-T` alone, or `-T -C user=U,host=H,addr=A` (sshd refuses an incomplete -C), from <fixtures>/<user>.txt.
export const fakeSshd = `sshd() {
  local user=global
  if [[ $# -eq 1 && "$1" == -T ]]; then :
  elif [[ $# -eq 3 && "$1" == -T && "$2" == -C && "$3" =~ ^user=[^,]+,host=[^,]+,addr=[^,]+$ ]]; then
    user="\${3#user=}"; user="\${user%%,*}"
  else
    echo "sshd: unsupported arguments: $*" >&2; return 255
  fi
  cat "$SSHD_FIXTURES/$user.txt"
}`;

export const deployUser = 'deploy';

// Writes one sshd -T answer per context (global, root, the deploy user). A plain array answers every context the same.
export function writeSshdFixtures(answers, padding = 0) {
  const directory = temporaryDirectory();
  const byContext = Array.isArray(answers) ? { global: answers, root: answers, [deployUser]: answers } : { ...answers };
  for (const [context, lines] of Object.entries(byContext)) {
    const filler = Array.from({ length: padding }, (_, index) => `zz-filler-${index} value`);
    writeFileSync(join(directory, `${context}.txt`), `${[...lines, ...filler].join('\n')}\n`);
  }
  return posix(directory);
}

// What `sshd -T` (or `sshd -T -C user=<user>`) prints for a directory of drop-ins. The first value wins, except Port, which
// accumulates. A Match block applies only with -C and when it matches; its options beat the global ones whatever the file order.
export function effectiveSshd(directory, user = null) {
  const global = {};
  const matched = {};
  const ports = [];
  const files = readdirSync(directory).filter((name) => name.endsWith('.conf')).sort();
  for (const name of files) {
    let inMatch = false;
    let matches = false;
    for (const line of readFileSync(join(directory, name), 'utf8').split('\n')) {
      const [keyword, value] = line.trim().split(/\s+/);
      const key = keyword?.toLowerCase();
      if (!key || key.startsWith('#') || !value) continue;
      if (key === 'match') {
        inMatch = true;
        const [, criterion, patterns] = line.trim().split(/\s+/);
        matches = user !== null && (criterion.toLowerCase() === 'all' || (criterion.toLowerCase() === 'user' && patterns.split(',').includes(user)));
      } else if (!inMatch && key === 'port') ports.push(value);
      else if (!inMatch) global[key] ??= value;
      else if (matches) matched[key] ??= value;
    }
  }
  const defaults = { passwordauthentication: 'yes', permitrootlogin: 'prohibit-password', kbdinteractiveauthentication: 'no' };
  const effective = { ...defaults, ...global, ...matched };
  return [...(ports.length ? ports : ['22']).map((port) => `port ${port}`), ...Object.entries(effective).map(([key, value]) => `${key} ${value}`)];
}

export const effectiveFor = (directory) => ({
  global: effectiveSshd(directory),
  root: effectiveSshd(directory, 'root'),
  [deployUser]: effectiveSshd(directory, deployUser),
});

export const hardened = ['port 22', 'permitrootlogin no', 'passwordauthentication no', 'kbdinteractiveauthentication no', 'pubkeyauthentication yes'];
