# Sourced by both root installers (production and dev); defines functions only.
# The cloudflared image runs as nonroot (uid and gid 65532) and the tunnel directory is mounted read-only into it, so the
# directory and the files in it belong to that group: readable by it, by no one else.
readonly CLOUDFLARED_GID=65532

# Safe to re-run: it also fixes the credentials file the owner copied in before the installer ran again.
prepare_cloudflared_directory() {
  local directory="$1" file
  install -d -o root -g "$CLOUDFLARED_GID" -m 0750 "$directory"
  for file in "$directory/config.yml" "$directory/credentials.json"; do
    [[ -f "$file" ]] || continue
    chown "root:$CLOUDFLARED_GID" "$file"
    chmod 0640 "$file"
  done
}
