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
systemctl enable --now systemd-timesyncd.service

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
SSH_DROPIN=/etc/ssh/sshd_config.d/90-ageniza.conf
SSH_BACKUP="${SSH_DROPIN}.pre-ageniza"
[[ -e "$SSH_DROPIN" ]] && cp -a "$SSH_DROPIN" "$SSH_BACKUP"
TEMP_SSH_CONFIG="$(mktemp /etc/ssh/sshd_config.d/.90-ageniza.XXXXXX)"
cat > "$TEMP_SSH_CONFIG" <<EOF
# Managed by $SCRIPT_NAME. Keep an established root session open until a new key-based login succeeds.
Port $SSH_PORT
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
install -m 0600 "$TEMP_SSH_CONFIG" "$SSH_DROPIN"
rm -f "$TEMP_SSH_CONFIG"
if ! sshd -t; then
  note "sshd validation failed; restoring previous SSH drop-in"
  if [[ -e "$SSH_BACKUP" ]]; then
    mv -f "$SSH_BACKUP" "$SSH_DROPIN"
  else
    rm -f "$SSH_DROPIN"
  fi
  sshd -t || true
  die "SSH configuration was not applied. Existing SSH daemon was not reloaded."
fi
systemctl reload ssh.service

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
