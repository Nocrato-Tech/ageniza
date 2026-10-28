#!/usr/bin/env bash
# Secure, repeatable baseline for a clean Ubuntu LTS VPS. Run locally on the VPS as root.
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

readonly SCRIPT_NAME="${0##*/}"
CONFIG_FILE=""

usage() {
  cat <<'USAGE'
Usage: sudo ./bootstrap-ubuntu.sh --config /secure/path/bootstrap.env

The config is a Bash assignment file based on bootstrap.env.example. It must
provide DEPLOY_USER, SSH_PORT, and DEPLOY_PUBLIC_KEY (an OpenSSH public key).
Never put private keys, passwords, API tokens, or production environment values in it.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '==> %s\n' "$*"; }

# Ubuntu 25.10 and newer ship chrony as the time daemon; older releases use systemd-timesyncd.
time_service() {
  if systemctl cat chrony.service >/dev/null 2>&1; then
    printf 'chrony.service\n'
  else
    printf 'systemd-timesyncd.service\n'
  fi
}

# sshd keeps the FIRST value of each option and reads the drop-ins in alphabetical order, so a file from the
# image (Hostinger's 50-cloud-init.conf sets PasswordAuthentication yes) beats a later 90-ageniza.conf.
write_ssh_dropin() {
  local dir="$1" port="$2" dropin legacy backup legacy_backup temp had_dropin=false had_legacy=false
  dropin="$dir/00-ageniza.conf"
  legacy="$dir/90-ageniza.conf"
  backup="${dropin}.pre-ageniza"
  legacy_backup="${legacy}.pre-ageniza"
  if [[ -e "$dropin" ]]; then
    cp -a "$dropin" "$backup"
    had_dropin=true
  fi
  # Port is additive: leaving the old file behind would keep listening on the port it names.
  if [[ -e "$legacy" ]]; then
    mv -f "$legacy" "$legacy_backup"
    had_legacy=true
  fi
  temp="$(mktemp "$dir/.00-ageniza.XXXXXX")"
  cat > "$temp" <<EOF
# Managed by $SCRIPT_NAME. Keep an established root session open until a new key-based login succeeds.
Port $port
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  install -m 0600 "$temp" "$dropin"
  rm -f "$temp"
  if ! sshd -t; then
    note "sshd validation failed; restoring previous SSH drop-ins"
    if [[ "$had_dropin" == "true" ]]; then
      mv -f "$backup" "$dropin"
    else
      rm -f "$dropin"
    fi
    if [[ "$had_legacy" == "true" ]]; then
      mv -f "$legacy_backup" "$legacy"
    fi
    sshd -t || true
    die "SSH configuration was not applied. Existing SSH daemon was not reloaded."
  fi
}

# Logs every other drop-in that sets an option the baseline owns, and whether it wins.
report_ssh_overrides() {
  local dir="$1" ours="$2" file lines
  for file in "$dir"/*.conf; do
    [[ -e "$file" && "$file" != "$ours" ]] || continue
    lines="$(grep -inE '^[[:space:]]*(Port|PermitRootLogin|PasswordAuthentication|KbdInteractiveAuthentication)[[:space:]=]' "$file" || true)"
    [[ -n "$lines" ]] || continue
    if [[ "${file##*/}" < "${ours##*/}" ]]; then
      note "WARNING: $file is read before ${ours##*/} and its first value wins:"
    else
      note "$file is read after ${ours##*/}, so the baseline values win over:"
    fi
    printf '    %s\n' "${lines//$'\n'/$'\n'    }"
  done
}

# Checks the configuration sshd would load, not the file this script wrote: another file can still override it.
assert_effective_sshd() {
  local port="$1" effective ports setting key failed=0
  if ! effective="$(sshd -T)"; then
    printf 'ERROR: sshd -T failed; the effective SSH configuration could not be read.\n' >&2
    return 1
  fi
  for setting in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no'; do
    key="${setting% *}"
    if ! grep -qxF -- "$setting" <<<"$effective"; then
      printf 'ERROR: effective SSH setting is "%s", expected "%s".\n' "$(grep -m1 -- "^$key " <<<"$effective" || printf '%s <unset>' "$key")" "$setting" >&2
      failed=1
    fi
  done
  ports="$(grep -- '^port ' <<<"$effective" || true)"
  if [[ "$ports" != "port $port" ]]; then
    printf 'ERROR: effective SSH ports are "%s", expected only "port %s".\n' "${ports//$'\n'/, }" "$port" >&2
    failed=1
  fi
  return "$failed"
}

while (($#)); do
  case "$1" in
    --config) CONFIG_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$CONFIG_FILE" && -r "$CONFIG_FILE" ]] || die "Pass a readable --config file."
[[ $EUID -eq 0 ]] || die "Run as root (for example: sudo $SCRIPT_NAME ...)."
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || die "The config must be a regular file, not a symlink."
[[ "$(stat -c '%u' "$CONFIG_FILE")" == "0" ]] || die "The config must be owned by root."
CONFIG_MODE="$(stat -c '%a' "$CONFIG_FILE")"
(( (8#$CONFIG_MODE & 8#077) == 0 )) || die "The config must not be accessible by group or others (use chmod 0600)."
# Intentional: config is operator-controlled Bash assignments; do not source untrusted input.
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${SSH_PORT:?SSH_PORT is required}"
: "${DEPLOY_PUBLIC_KEY:?DEPLOY_PUBLIC_KEY is required}"
: "${ADD_DEPLOY_USER_TO_DOCKER_GROUP:=false}"
: "${LOCKDOWN_UFW:=false}"

[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "DEPLOY_USER is not a safe Linux username."
[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || die "SSH_PORT must be 1-65535."
[[ "$ADD_DEPLOY_USER_TO_DOCKER_GROUP" =~ ^(true|false)$ ]] || die "ADD_DEPLOY_USER_TO_DOCKER_GROUP must be true or false."
[[ "$LOCKDOWN_UFW" =~ ^(true|false)$ ]] || die "LOCKDOWN_UFW must be true or false."
[[ "$DEPLOY_PUBLIC_KEY" != *$'\n'* ]] || die "DEPLOY_PUBLIC_KEY must be exactly one line."
[[ "$DEPLOY_PUBLIC_KEY" =~ ^(ssh-|ecdsa-|sk-) ]] || die "DEPLOY_PUBLIC_KEY does not look like an OpenSSH public key."

[[ -r /etc/os-release ]] || die "Cannot determine operating system."
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == "ubuntu" ]] || die "This baseline supports Ubuntu only (detected: ${ID:-unknown})."
[[ ${VERSION_ID:-} =~ ^(22\.04|24\.04|26\.04)$ ]] || die "Use a supported Ubuntu LTS release (22.04, 24.04, or 26.04; detected: ${VERSION_ID:-unknown})."
[[ ${VERSION_CODENAME:-} ]] || die "Ubuntu VERSION_CODENAME is missing."

export DEBIAN_FRONTEND=noninteractive
note "Updating Ubuntu packages and installing baseline dependencies"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssh-server sudo ufw unattended-upgrades

ssh-keygen -l -f <(printf '%s\n' "$DEPLOY_PUBLIC_KEY") >/dev/null 2>&1 || die "DEPLOY_PUBLIC_KEY is not a valid OpenSSH public key."

note "Configuring UTC and time synchronization"
timedatectl set-timezone UTC
TIME_SERVICE="$(time_service)"
systemctl enable --now "$TIME_SERVICE"

note "Creating or updating deploy account: $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG sudo "$DEPLOY_USER"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
AUTH_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTH_KEYS"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 0600 "$AUTH_KEYS"
grep -qxF -- "$DEPLOY_PUBLIC_KEY" "$AUTH_KEYS" || printf '%s\n' "$DEPLOY_PUBLIC_KEY" >> "$AUTH_KEYS"

note "Installing Docker Engine and Compose plugin from Docker's official Ubuntu APT repository"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc
gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg /tmp/docker.asc
rm -f /tmp/docker.asc
chmod a+r /etc/apt/keyrings/docker.gpg
ARCH="$(dpkg --print-architecture)"
printf '%s\n' \
  "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker.service containerd.service

if [[ "$ADD_DEPLOY_USER_TO_DOCKER_GROUP" == "true" ]]; then
  usermod -aG docker "$DEPLOY_USER"
  note "Added $DEPLOY_USER to docker group (this is root-equivalent access)."
else
  note "Did not add $DEPLOY_USER to docker group; use audited sudo access until ADR #10 defines deployment access."
fi

note "Configuring unattended security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52ageniza-unattended-upgrades <<'EOF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable --now unattended-upgrades.service

note "Opening the SSH port before applying SSH configuration"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'Ageniza SSH'
# No inbound 80/443: the Cloudflare Tunnel connects outbound (ADR 0012).
if [[ "$LOCKDOWN_UFW" == "true" ]]; then
  note "LOCKDOWN_UFW=true: resetting UFW to SSH only"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "${SSH_PORT}/tcp" comment 'Ageniza SSH'
else
  note "Preserving existing UFW rules. Review them and rerun with LOCKDOWN_UFW=true only after a second SSH session succeeds."
fi
ufw --force enable

note "Writing a validated SSH hardening drop-in"
SSH_DROPIN_DIR=/etc/ssh/sshd_config.d
write_ssh_dropin "$SSH_DROPIN_DIR" "$SSH_PORT"
report_ssh_overrides "$SSH_DROPIN_DIR" "$SSH_DROPIN_DIR/00-ageniza.conf"
systemctl reload ssh.service

note "Checking the effective SSH configuration"
if ! assert_effective_sshd "$SSH_PORT"; then
  die "The effective SSH configuration does not match the baseline: another sshd option source still wins (see the drop-ins reported above and 'sshd -T'). The baseline was NOT installed successfully. Keep this root session open."
fi

cat <<EOF

Baseline installed successfully.

KEEP THIS ROOT SESSION OPEN. From a second terminal, verify:
  ssh -p $SSH_PORT $DEPLOY_USER@<server-ip>
  sudo bash /path/to/verify-vps.sh --user $DEPLOY_USER --ssh-port $SSH_PORT

Before closing the original session, set and test the deploy user's sudo password:
  passwd $DEPLOY_USER

Only after that second login succeeds may you close this session. UFW is enabled;
run 'sudo ufw status numbered' and remove any pre-existing inbound rules if the
host was not clean. No reverse proxy or deployment tool was installed: ADR #10
must define those integration points. Docker containers must use named/approved
volumes; do not run production PostgreSQL or keep critical data only on this VPS.
EOF
