#!/usr/bin/env bash
# Encrypted Postgres backup for Fishtape.
#
# pg_dump -Fc of the fishtape database, streamed straight into `age` with public-key
# recipients: the server can write backups but can't read them; the private key stays offline
# with Kelvin. Nothing unencrypted touches the disk.
#
#   sudo ./backup.sh                    nightly: daily + weekly rotation (systemd timer)
#   sudo ./backup.sh --kind predeploy   before migrations (update.sh); keeps the last 5
#
# Retention: 14 daily, 8 weekly (Sunday's daily, hard-linked), 5 pre-deploy. Optional copy
# offsite (rsync over SSH or rclone) into daily/, weekly/ and predeploy/ on the far side.
# Writes $STATE_DIR/status/last-backup.json, which the API reads for /api/hq/health, and
# appends the same JSON to $STATE_DIR/backup-log.jsonl. The JSON names the offsite target only
# by provider kind and host or remote name (plus OFFSITE_LABEL), never keys, paths or URLs, and
# keeps the time of the last good offsite copy (lastOffsiteOkAt) across failed runs.
#
# The environment (staging | production) is this script's folder name. Settings: backup.conf
# next to this script (see backup.conf.example). deploy/production/backup.sh is an identical
# copy; CI fails if they differ.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="$(basename "$HERE")"
COMPOSE_FILE="$HERE/docker-compose.yml"
DB_NAME=fishtape

# ---- defaults (override in backup.conf) ----
BACKUP_DIR="/var/backups/fishtape-$ENV_NAME"
STATE_DIR="/var/lib/fishtape-$ENV_NAME"
AGE_RECIPIENTS_FILE="$HERE/backup-recipients.txt"
KEEP_DAILY=14
KEEP_WEEKLY=8
KEEP_PREDEPLOY=5
WEEKLY_DAY=7               # ISO weekday that is copied to weekly/ (7 = Sunday)
OFFSITE_RSYNC_TARGET=""    # user@host:/path   (rsync over SSH)
OFFSITE_SSH_KEY=""         # key for the rsync target; its host key must be in root's known_hosts
OFFSITE_RCLONE_REMOTE=""   # remote:bucket/path (rclone, configured in root's rclone.conf)
OFFSITE_LABEL=""           # shown in HQ health, e.g. "s3 ca-central-1": provider and region, never keys
HEARTBEAT_URL=""           # dead-man's switch, e.g. https://hc-ping.com/<uuid>; /fail on failure

CONF="$HERE/backup.conf"
if [ -f "$CONF" ]; then
  # Sourced as root, so it must be root's and not writable by anyone else.
  read -r conf_uid conf_mode < <(stat -c '%u %a' "$CONF")
  if [ "$conf_uid" != 0 ] || (( 8#$conf_mode & 8#022 )); then
    echo "refusing $CONF: must be owned by root and not group/world-writable (uid $conf_uid, mode $conf_mode)" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$CONF"
fi

KIND=nightly
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$KIND" in nightly|predeploy) ;; *) echo "--kind must be nightly or predeploy" >&2; exit 2 ;; esac
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

STATUS_DIR="$STATE_DIR/status"
LOG_FILE="$STATE_DIR/backup-log.jsonl"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/predeploy" "$STATUS_DIR"
chmod 700 "$BACKUP_DIR"
chmod 755 "$STATE_DIR" "$STATUS_DIR"

exec 8>"$STATE_DIR/backup.lock"
flock -w 900 8 || { echo "another backup has held the lock for 15 minutes" >&2; exit 1; }

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START="$(date +%s)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE=""
TMP=""
BYTES=0
SHA256=""
OFFSITE=skipped

dc() { docker compose --project-directory "$HERE" -f "$COMPOSE_FILE" "$@"; }
jstr() { # JSON string or null
  if [ -z "${1:-}" ]; then printf 'null'; return; fi
  local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\r'/ }; s=${s//$'\t'/ }
  printf '"%s"' "$s"
}
count() { find "$BACKUP_DIR/$1" -maxdepth 1 -name 'fishtape-*.dump.age' | wc -l; }

# Where offsite copies go, for the status file: provider kind and host (rsync) or remote name
# (rclone), plus OFFSITE_LABEL. Never the user, path, bucket, keys or an inline rclone connection
# string (everything from the first ',' or ':' is dropped).
offsite_target() {
  local label="${OFFSITE_LABEL//[^A-Za-z0-9 ._-]/}" name
  label="${label:0:60}"
  if [ -n "$OFFSITE_RSYNC_TARGET" ]; then
    name="${OFFSITE_RSYNC_TARGET%%:*}"; name="${name##*@}"
    printf 'rsync %s%s' "${name//[^A-Za-z0-9._-]/}" "${label:+ ($label)}"
  elif [ -n "$OFFSITE_RCLONE_REMOTE" ]; then
    name="${OFFSITE_RCLONE_REMOTE%%:*}"; name="${name%%,*}"
    printf 'rclone %s%s' "${name//[^A-Za-z0-9._-]/}" "${label:+ ($label)}"
  fi
}
OFFSITE_TARGET="$(offsite_target)"

finish() { # status [error]
  local status="$1" err="${2:-}" now dur last_ok last_offsite json
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dur=$(( $(date +%s) - START ))
  if [ "$status" != failed ]; then printf '%s\n' "$now" > "$STATE_DIR/last-backup-success"; fi
  if [ "$OFFSITE" = ok ]; then printf '%s\n' "$now" > "$STATE_DIR/last-offsite-success"; fi
  last_ok="$(cat "$STATE_DIR/last-backup-success" 2>/dev/null || true)"
  last_offsite="$(cat "$STATE_DIR/last-offsite-success" 2>/dev/null || true)"
  json=$(printf '{"schema":1,"environment":%s,"kind":%s,"status":%s,"startedAt":%s,"finishedAt":%s,"durationSeconds":%d,"file":%s,"bytes":%d,"sha256":%s,"encryption":"age","offsite":%s,"offsiteTarget":%s,"lastOffsiteOkAt":%s,"lastSuccessAt":%s,"error":%s,"retention":{"daily":%d,"weekly":%d,"predeploy":%d},"counts":{"daily":%d,"weekly":%d,"predeploy":%d},"host":%s}' \
    "$(jstr "$ENV_NAME")" "$(jstr "$KIND")" "$(jstr "$status")" "$(jstr "$STARTED_AT")" "$(jstr "$now")" "$dur" \
    "$(jstr "${FILE:+$(basename "$FILE")}")" "$BYTES" "$(jstr "$SHA256")" "$(jstr "$OFFSITE")" "$(jstr "$OFFSITE_TARGET")" "$(jstr "$last_offsite")" \
    "$(jstr "$last_ok")" "$(jstr "$err")" \
    "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_PREDEPLOY" "$(count daily)" "$(count weekly)" "$(count predeploy)" "$(jstr "$(hostname -s)")")
  printf '%s\n' "$json" > "$STATUS_DIR/last-backup.json.tmp"
  chmod 644 "$STATUS_DIR/last-backup.json.tmp"
  mv -f "$STATUS_DIR/last-backup.json.tmp" "$STATUS_DIR/last-backup.json"
  printf '%s\n' "$json" >> "$LOG_FILE"
  chmod 640 "$LOG_FILE"
  if [ -n "$HEARTBEAT_URL" ]; then
    local url="$HEARTBEAT_URL"
    [ "$status" = ok ] || url="${HEARTBEAT_URL%/}/fail"
    curl -fsS -m 10 --retry 3 -o /dev/null "$url" || echo "warning: heartbeat ping failed" >&2
  fi
  echo "backup $status: ${FILE:-none} offsite $OFFSITE${OFFSITE_TARGET:+ ($OFFSITE_TARGET)}${last_offsite:+, last offsite copy $last_offsite} ${err:+($err)}"
}

die() {
  trap - ERR
  [ -n "$TMP" ] && rm -f "$TMP"
  finish failed "$1"
  exit 1
}
trap 'die "unexpected error at line $LINENO: $BASH_COMMAND"' ERR
trap '[ -n "$TMP" ] && rm -f "$TMP"' EXIT

# ---- preflight ----
command -v age >/dev/null || die "age is not installed (apt install age)"
command -v docker >/dev/null || die "docker is not installed"
[ -f "$AGE_RECIPIENTS_FILE" ] || die "no recipients file at $AGE_RECIPIENTS_FILE (README: backups)"
grep -qE '^(age1|ssh-ed25519 |ssh-rsa )' "$AGE_RECIPIENTS_FILE" || die "$AGE_RECIPIENTS_FILE has no age1... or ssh- public key"
[ -n "$(dc ps --status running -q postgres 2>/dev/null)" ] || die "the postgres container is not running"

# ---- dump | encrypt ----
case "$KIND" in
  nightly) DEST="$BACKUP_DIR/daily" ;;
  predeploy) DEST="$BACKUP_DIR/predeploy" ;;
esac
FILE="$DEST/fishtape-$ENV_NAME-$STAMP.dump.age"
TMP="$FILE.partial"

# Superuser dump: tenant tables use FORCE ROW LEVEL SECURITY, which would stop the owner role.
st=()
{ dc exec -T postgres pg_dump -U postgres -d "$DB_NAME" -Fc -Z 6 \
    | age -R "$AGE_RECIPIENTS_FILE" -o "$TMP"; st=("${PIPESTATUS[@]}"); } || true
[ "${st[0]:-1}" -eq 0 ] || die "pg_dump failed (exit ${st[0]:-?})"
[ "${st[1]:-1}" -eq 0 ] || die "age failed (exit ${st[1]:-?})"
[ "$(head -c 21 "$TMP")" = "age-encryption.org/v1" ] || die "output is not an age file"
BYTES="$(stat -c %s "$TMP")"
[ "$BYTES" -gt 512 ] || die "backup is suspiciously small ($BYTES bytes)"
mv -f "$TMP" "$FILE"
TMP=""
SHA256="$(sha256sum "$FILE" | cut -d' ' -f1)"
printf '%s  %s\n' "$SHA256" "$(basename "$FILE")" > "$FILE.sha256"

# ---- weekly copy (hard link: no extra space) ----
WEEKLY=0
if [ "$KIND" = nightly ]; then
  recent_weekly="$(find "$BACKUP_DIR/weekly" -maxdepth 1 -name 'fishtape-*.dump.age' -mtime -6 | head -1)"
  if [ "$(date -u +%u)" = "$WEEKLY_DAY" ] || [ -z "$recent_weekly" ]; then
    ln -f "$FILE" "$BACKUP_DIR/weekly/"
    ln -f "$FILE.sha256" "$BACKUP_DIR/weekly/"
    WEEKLY=1
  fi
fi

# ---- retention ----
prune() { # dir keep
  find "$BACKUP_DIR/$1" -maxdepth 1 -name 'fishtape-*.dump.age' -printf '%f\n' | sort -r | tail -n +"$(( $2 + 1 ))" \
    | while IFS= read -r f; do rm -f "$BACKUP_DIR/$1/$f" "$BACKUP_DIR/$1/$f.sha256"; done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
prune predeploy "$KEEP_PREDEPLOY"

# ---- offsite (encrypted files only; the far side keeps its own retention and object lock) ----
# daily/ and predeploy/ get every backup; weekly/ gets the nightly that was linked into weekly/
# here, so the bucket's lifecycle rules can keep weeklies longer than dailies.
ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes${OFFSITE_SSH_KEY:+ -i $OFFSITE_SSH_KEY}"
copy_offsite() { # subdir: the backup and its .sha256 into <target>/<subdir>/
  if [ -n "$OFFSITE_RSYNC_TARGET" ]; then
    rsync -a --mkpath -e "$ssh_cmd" "$FILE" "$FILE.sha256" "${OFFSITE_RSYNC_TARGET%/}/$1/"
  else
    rclone copy --no-traverse "$FILE" "${OFFSITE_RCLONE_REMOTE%/}/$1/" \
      && rclone copy --no-traverse "$FILE.sha256" "${OFFSITE_RCLONE_REMOTE%/}/$1/"
  fi
}
if [ -n "$OFFSITE_RSYNC_TARGET" ] || [ -n "$OFFSITE_RCLONE_REMOTE" ]; then
  OFFSITE=ok
  copy_offsite "$(basename "$DEST")" || OFFSITE=failed
  if [ "$OFFSITE" = ok ] && [ "$WEEKLY" -eq 1 ]; then copy_offsite weekly || OFFSITE=failed; fi
fi

trap - ERR
if [ "$OFFSITE" = failed ]; then
  finish degraded "local backup ok, offsite copy failed"
elif [ "$ENV_NAME" = production ] && [ "$OFFSITE" = skipped ]; then
  # Production policy: an offsite copy is required (docs/compliance/backup-retention.md).
  finish degraded "local backup ok, but no offsite target is configured (OFFSITE_* in backup.conf)"
elif [ "$ENV_NAME" = production ] && [ -z "$HEARTBEAT_URL" ]; then
  finish degraded "backup ok, but HEARTBEAT_URL is not set, so a missed backup would go unnoticed"
else
  finish ok
fi
