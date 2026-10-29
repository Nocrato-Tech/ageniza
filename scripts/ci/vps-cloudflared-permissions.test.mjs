import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { posix, removeTemporaryDirectories, run, temporaryDirectory } from './vps-bash-harness.mjs';

// The cloudflared image runs as nonroot (65532) and reads the tunnel directory through a read-only mount, so a root-only
// 0750/0600 tree keeps the tunnel from starting (#783). The installers run as root on the VPS and cannot run here, so
// `install`, `chown` and `chmod` are replaced by functions that record the owner, group and mode each path ends with.
afterEach(removeTemporaryDirectories);

const root = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const library = posix(join(root, 'infra/vps/cloudflared-group.sh'));
const devInstaller = posix(join(root, 'infra/vps/install-dev-deploy.sh'));
const preamble = `set -Eeuo pipefail\nIFS=$'\\n\\t'\n`;

const fakeFilesystem = `
declare -A OWNER GROUP MODE
install() {
  local make_directory=false owner= group= mode= paths=() target
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d) make_directory=true ;;
      -o) owner="$2"; shift ;;
      -g) group="$2"; shift ;;
      -m) mode="$2"; shift ;;
      *) paths+=("$1") ;;
    esac
    shift
  done
  if $make_directory; then
    for target in "\${paths[@]}"; do OWNER[$target]=$owner; GROUP[$target]=$group; MODE[$target]=$mode; done
  else
    target="\${paths[-1]}"; OWNER[$target]=$owner; GROUP[$target]=$group; MODE[$target]=$mode
  fi
}
chown() { OWNER[$2]="\${1%%:*}"; GROUP[$2]="\${1#*:}"; }
chmod() { MODE[$2]=$1; }
show() { printf '%s %s %s %s\\n' "$1" "\${OWNER[$1]:-none}" "\${GROUP[$1]:-none}" "\${MODE[$1]:-none}"; }
`;

function tunnelDirectory(existing) {
  const directory = posix(temporaryDirectory());
  mkdirSync(join(directory, 'cloudflared'));
  for (const name of existing) writeFileSync(join(directory, 'cloudflared', name), '{}');
  return `${directory}/cloudflared`;
}

// What the directory was before the installer ran: the owner copied the credentials in as root with 0600, or it is fresh.
const untouched = (directory, files) => files.map((name) => `OWNER[${directory}/${name}]=root GROUP[${directory}/${name}]=root MODE[${directory}/${name}]=0600`).join('\n');

function prepare(directory, files, times = 1) {
  const script = `${preamble}${fakeFilesystem}source "${library}"
${untouched(directory, files)}
for _ in $(seq ${times}); do prepare_cloudflared_directory "${directory}"; done
for path in "${directory}" ${files.map((name) => `"${directory}/${name}"`).join(' ')}; do show "$path"; done`;
  const result = run(script);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const [path, owner, group, mode] = line.split(' ');
    return [path.slice(directory.length + 1) || '.', { owner, group, mode }];
  }));
}

describe('the tunnel directory of both installers', () => {
  it('belongs to root and the cloudflared group, readable by the group and by no one else', () => {
    const directory = tunnelDirectory([]);
    expect(prepare(directory, [])['.']).toEqual({ owner: 'root', group: '65532', mode: '0750' });
  });

  it.each(['credentials.json', 'config.yml'])('gives an existing %s to the group with read only, and nothing to others', (name) => {
    const directory = tunnelDirectory([name]);
    expect(prepare(directory, [name])[name]).toEqual({ owner: 'root', group: '65532', mode: '0640' });
  });

  it('fixes the credentials the owner copied in as root 0600 before the installer ran again, and keeps the result on the next run', () => {
    const directory = tunnelDirectory(['credentials.json', 'config.yml']);
    const result = prepare(directory, ['credentials.json', 'config.yml'], 2);
    expect(result['credentials.json']).toEqual({ owner: 'root', group: '65532', mode: '0640' });
    expect(result['config.yml']).toEqual({ owner: 'root', group: '65532', mode: '0640' });
    expect(result['.']).toEqual({ owner: 'root', group: '65532', mode: '0750' });
  });

  it('does not invent a credentials file that the owner has not copied yet', () => {
    const directory = tunnelDirectory([]);
    expect(prepare(directory, ['credentials.json'])['credentials.json']).toEqual({ owner: 'root', group: 'root', mode: '0600' });
  });

  it.each(['credentials.json', 'config.yml', '.'])('never leaves any permission to others on %s', (name) => {
    const directory = tunnelDirectory(['credentials.json', 'config.yml']);
    const { mode } = prepare(directory, ['credentials.json', 'config.yml'])[name];
    expect(mode.at(-1)).toBe('0');
  });
});

describe('the config.yml the dev installer renders', () => {
  it('is installed for the cloudflared group, readable by it and by no one else', () => {
    const directory = posix(temporaryDirectory());
    const environment = join(directory, 'dev-deploy.env');
    writeFileSync(environment, `AGENIZA_ACCESS_TEAM_NAME=ageniza\nAGENIZA_ACCESS_AUD_TAG=${'ab'.repeat(32)}\n`);
    const result = run(`${preamble}${fakeFilesystem}source "${devInstaller}"
install_cloudflared_config "${posix(join(root, 'infra/vps'))}" "${posix(environment)}"
show /etc/ageniza-dev/cloudflared/config.yml`);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('/etc/ageniza-dev/cloudflared/config.yml root 65532 0640');
  });
});

describe('what the installers wire up', () => {
  const production = read('infra/vps/install-production-deploy.sh');
  const dev = read('infra/vps/install-dev-deploy.sh');

  it.each([
    ['production', production, '/etc/ageniza/cloudflared'],
    ['dev', dev, '/etc/ageniza-dev/cloudflared']
  ])('the %s installer prepares its tunnel directory with the shared function, and never creates it root-only', (_label, installer, directory) => {
    expect(installer).toContain(`prepare_cloudflared_directory ${directory}\n`);
    expect(installer).not.toMatch(/install -d [^\n]*cloudflared/);
    expect(installer).toContain('source "$(dirname "${BASH_SOURCE[0]}")/cloudflared-group.sh"');
    expect(installer).toMatch(/"\$(?:SOURCE_DIR|source_dir)\/cloudflared-group\.sh"/);
  });

  it('the production installer installs config.yml for the group, readable by it and by no one else', () => {
    expect(production).toContain('install -o root -g "$CLOUDFLARED_GID" -m 0640 "$SOURCE_DIR/cloudflared/config.yml" /etc/ageniza/cloudflared/config.yml');
  });

  it('prepares the directory before the config is installed into it', () => {
    expect(production.indexOf('prepare_cloudflared_directory')).toBeLessThan(production.indexOf('/etc/ageniza/cloudflared/config.yml'));
    expect(dev.indexOf('prepare_cloudflared_directory')).toBeLessThan(dev.indexOf('install_cloudflared_config "$source_dir"'));
  });

  it('uses the uid and gid of the nonroot user the cloudflared image runs as', () => {
    expect(read('infra/vps/cloudflared-group.sh')).toContain('readonly CLOUDFLARED_GID=65532\n');
  });
});

describe('what the containers read from /etc', () => {
  const composeFiles = ['compose.yml', 'compose.dev.yml', 'compose.production.yml', 'infra/vps/compose.tunnel.yml', 'infra/vps/compose.dev-tunnel.yml'];

  it('mounts nothing of /etc/ageniza* into a container except the tunnel directory, so no other nonroot container reads a root-only file', () => {
    const mounts = composeFiles.flatMap((file) => read(file).split('\n').filter((line) => /\/etc\/ageniza/.test(line) && !line.trimStart().startsWith('#')).map((line) => `${file}: ${line.trim()}`));
    expect(mounts).toEqual([
      'infra/vps/compose.tunnel.yml: - /etc/ageniza/cloudflared:/etc/cloudflared:ro',
      'infra/vps/compose.dev-tunnel.yml: - /etc/ageniza-dev/cloudflared:/etc/cloudflared:ro'
    ]);
  });
});
