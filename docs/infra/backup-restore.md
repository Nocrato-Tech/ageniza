# Database backup and restore

The database runs on the VPS ([ADR 0011](../adr/0011-self-hosted-postgres-and-better-auth.md)), so its volume must never be the only copy. A daily job dumps PostgreSQL, encrypts the dump on the host, and uploads it to Cloudflare R2.

| Piece | Where |
| --- | --- |
| [`infra/vps/ageniza-backup.sh`](../../infra/vps/ageniza-backup.sh) | Installed as `/usr/local/sbin/ageniza-backup`; `backup` and `verify-restore` |
| [`infra/vps/systemd`](../../infra/vps/systemd) | `ageniza-backup.timer` (daily 04:10 UTC, jittered, catches up after downtime) and its service |
| `/etc/ageniza/backup.env` (0600) | R2 account, bucket, credentials, optional heartbeat URL |
| `/etc/ageniza/backup-passphrase` (0600) | GPG symmetric passphrase |
| `/var/lib/ageniza/backups` (0700) | Newest encrypted dump only; R2 holds history |

**Recovery point: 24 hours.** Everything written since the last successful backup is lost in a host-loss event. Hostinger snapshots are a complement, never the plan.

## Setup

1. **Bucket:** create a private R2 bucket (for example `ageniza-backups`) and an R2 API token scoped to **that bucket only**, with object read and write.
2. **Retention:** add R2 lifecycle rules on the bucket, for example delete objects older than 90 days. Retention is intentionally the bucket's job, not the script's, so a compromised VPS cannot delete history.
3. **Passphrase:** generate one and store it in the team's password manager **before** using it. A dump cannot be restored without it.

   ```bash
   openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48 | sudo tee /etc/ageniza/backup-passphrase >/dev/null
   sudo chmod 0600 /etc/ageniza/backup-passphrase
   sudo cat /etc/ageniza/backup-passphrase   # copy into the password manager, then clear your scrollback
   ```

4. **Configuration:** copy `infra/vps/backup.env.example` to `/etc/ageniza/backup.env` (0600) and fill it in. `HEARTBEAT_URL` is optional but recommended: create a daily check on a service such as healthchecks.io and paste its ping URL, so a missing or failed backup raises an alert.
5. **Enable the timer:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now ageniza-backup.timer
   sudo systemctl list-timers ageniza-backup.timer
   ```

6. **Prove it works**, in this order:

   ```bash
   sudo ageniza-backup backup           # writes one object to R2
   sudo ageniza-backup verify-restore   # restores it into a throwaway container
   ```

## What each command does

`backup` dumps with `pg_dump --format=custom` through the container socket (no password is handled), encrypts with GPG AES-256, uploads to `ageniza/<year>/<month>/ageniza-<timestamp>.dump.gpg` using SigV4, keeps only the newest local copy, and pings the heartbeat. Credentials pass through a 0600 curl config file, never the process list. A host lock prevents overlapping runs.

`verify-restore` decrypts the newest local dump, starts a disposable PostgreSQL container on an internal network with the same pinned image, runs `pg_restore`, checks that `app_private.current_user_id()` exists, prints the restored table count, and removes the container, volume, and network. It never touches the production database.

## Restoring for real

1. **Stop the application** so nothing writes during the restore: `sudo docker compose -p ageniza stop api worker`.
2. **Fetch the object** from R2 (Cloudflare dashboard or any S3 client) onto the VPS and decrypt it:

   ```bash
   sudo gpg --batch --decrypt --passphrase-file /etc/ageniza/backup-passphrase \
     --output /var/lib/ageniza/backups/restore.dump /path/to/ageniza-<timestamp>.dump.gpg
   ```

3. **Restore into a clean database.** On a rebuilt host the `ageniza_app` role already exists, because the init script runs when the volume is created.

   ```bash
   sudo docker compose -p ageniza exec -T --user postgres postgres \
     psql --username=postgres --dbname=postgres \
     --command='drop database if exists ageniza_restore' --command='create database ageniza_restore'
   sudo docker compose -p ageniza exec -T --user postgres postgres \
     pg_restore --username=postgres --dbname=ageniza_restore --no-owner < /var/lib/ageniza/backups/restore.dump
   ```

   Inspect `ageniza_restore`, then promote it by renaming both databases, or restore straight into `ageniza` once you are sure.
4. **Start the application** and confirm health: `sudo docker compose -p ageniza start api worker`, then `curl https://<domain>/api/health`.
5. **Record the incident**: object restored, data lost since the backup, and how long it took.

## Operating

```bash
sudo systemctl status ageniza-backup.service
sudo journalctl -u ageniza-backup.service --since '7 days ago'
sudo ageniza-backup verify-restore     # rehearse at least quarterly and after any schema-wide change
```

Rotate the R2 token and the passphrase independently, and record each rotation. A new passphrase only applies to new dumps: keep the previous one until every object encrypted with it has aged out of the bucket.
