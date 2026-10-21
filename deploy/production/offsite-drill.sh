#!/usr/bin/env bash
# Offsite restore drill: prove the newest OFFSITE copy of a backup restores, and with
# --verify-secrets that the encrypted columns in it still decrypt with SECRETS_MASTER_KEY.
#
# Runs OFF the server only: Kelvin's PC (WSL or Linux with Docker, rclone, age and node) or a
# throwaway VM. It refuses to run on a Fishtape server. It reads the bucket with a READ-ONLY key
# from its own rclone config, never the server's write key. docs/runbooks/offsite-backups.md.
#
#   ./offsite-drill.sh --remote drill-ro:fishtape-backups/production --dry-run
#   ./offsite-drill.sh --remote drill-ro:fishtape-backups/production --identity - < ~/keys/fishtape-production-backup.key
#   { cat ~/keys/fishtape-production-backup.key; printf 'SECRETS_MASTER_KEY=%s\n' "$(<password manager>)"; } \
#     | ./offsite-drill.sh --remote drill-ro:fishtape-backups/production --identity - --verify-secrets
#
# Steps: list <remote>/daily/, fetch the newest fishtape-<env>-*.dump.age and its .sha256 into a
# private temp directory, check the checksum, run restore-test.sh --file <tmp> --identity - (the
# key goes through a pipe, never to disk), with --verify-secrets run server/scripts/verify-restore.mjs
# against the restored scratch database (migration version, rows per tenant, one encrypted value
# per kind decrypts), append one JSON line ("source":"offsite","host":"off-box") to the log, and
# delete the temp copy and the scratch database. Then upload that line on the HQ health page
# ("Record a drill result").
#
# Options:
#   --remote <remote:path>  the environment's offsite folder, the one holding daily/ (default: $DRILL_REMOTE)
#   --rclone-config <file>  the rclone config with the read-only key (default: rclone's own)
#   --identity -            the age private key on stdin (required, except with --dry-run)
#   --verify-secrets        also check secrets decrypt: stdin then also carries one line
#                           SECRETS_MASTER_KEY=<base64> (before or after the age key)
#   --keep                  leave the scratch database container running (prints how to remove it)
#   --log <file>            where to append the JSON result (default: ./restore-tests.jsonl)
#   --dry-run               show what would be fetched; fetch and restore nothing
#
# Exit codes: 0 pass, 1 failed restore (download, checksum, restore or check), 2 bad usage or a
# missing tool, 3 no offsite target (or it can't be listed), 4 nothing to fetch, 5 secrets did not
# decrypt.
#
# deploy/production/offsite-drill.sh is an identical copy; CI fails if they differ.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="$(basename "$HERE")"
REPO="$(cd "$HERE/../.." && pwd)"

REMOTE="${DRILL_REMOTE:-}"
RCLONE_CONFIG_FILE=""
IDENTITY=""
VERIFY=0
KEEP=0
LOG="restore-tests.jsonl"
DRY=0

usage() { echo "offsite-drill: $1" >&2; exit 2; }
need() { [ "$2" -ge 2 ] || usage "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) need "$1" $#; REMOTE="$2"; shift 2 ;;
    --rclone-config) need "$1" $#; RCLONE_CONFIG_FILE="$2"; shift 2 ;;
    --identity) need "$1" $#; IDENTITY="$2"; shift 2 ;;
    --verify-secrets) VERIFY=1; shift ;;
    --keep) KEEP=1; shift ;;
    --log) need "$1" $#; LOG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) usage "unknown option: $1" ;;
  esac
done

# Never on a Fishtape server: the drill proves the copy that survives losing the server.
for d in /var/lib/fishtape-staging /var/lib/fishtape-production /var/backups/fishtape-staging /var/backups/fishtape-production; do
  if [ -e "$d" ]; then usage "this looks like a Fishtape server ($d exists). Run the drill on your own computer or a throwaway VM."; fi
done

if [ -z "$REMOTE" ]; then
  echo "offsite-drill: no offsite target: pass --remote <rclone remote>:<path> (the folder that holds daily/), or set DRILL_REMOTE" >&2
  exit 3
fi
# A named remote only: an inline connection string (":s3,access_key_id=...:") would put keys on the command line.
[[ "$REMOTE" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*:[^[:space:],]*$ ]] || usage "--remote must look like name:bucket/path (a remote from your rclone config)"
if [ "$DRY" -eq 0 ] && [ "$IDENTITY" != "-" ]; then usage "--identity - is required: pipe the age private key in on stdin (it is never written to disk)"; fi
if [ -n "$RCLONE_CONFIG_FILE" ] && [ ! -r "$RCLONE_CONFIG_FILE" ]; then usage "can't read rclone config $RCLONE_CONFIG_FILE"; fi

tools=(rclone)
[ "$DRY" -eq 1 ] || tools+=(sha256sum docker age)
[ "$DRY" -eq 1 ] || [ "$VERIFY" -eq 0 ] || tools+=(node)
for t in "${tools[@]}"; do command -v "$t" >/dev/null || usage "$t is not installed (docs/runbooks/offsite-backups.md, 'Your computer')"; done
[ "$VERIFY" -eq 0 ] || [ -f "$REPO/server/scripts/verify-restore.mjs" ] || usage "server/scripts/verify-restore.mjs not found: run this from a full checkout"

# ---- the key material: read once, kept in memory, handed on through pipes only ----
IDENTITY_DATA=""
MASTER_LINE=""
if [ "$DRY" -eq 0 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      SECRETS_MASTER_KEY=*) MASTER_LINE="$line" ;;
      *) IDENTITY_DATA+="$line"$'\n' ;;
    esac
  done
  case "$IDENTITY_DATA" in
    *AGE-SECRET-KEY-*|*"PRIVATE KEY"*|*age-encryption.org*) ;;
    *) usage "no age identity on stdin (expected AGE-SECRET-KEY-..., an ssh private key, or a passphrase-protected age identity)" ;;
  esac
  if [ "$VERIFY" -eq 1 ] && [ -z "$MASTER_LINE" ]; then usage "--verify-secrets needs a line SECRETS_MASTER_KEY=<base64> on stdin as well"; fi
fi

RCLONE=(rclone)
[ -z "$RCLONE_CONFIG_FILE" ] || RCLONE+=(--config "$RCLONE_CONFIG_FILE")
SRC="${REMOTE%/}/daily"

if ! listing="$("${RCLONE[@]}" lsf --files-only "$SRC/")"; then
  echo "offsite-drill: can't list $SRC/ (check the remote name, the read-only key and the network)" >&2
  exit 3
fi
NEWEST="$(printf '%s\n' "$listing" | grep -E "^fishtape-$ENV_NAME-[0-9]{8}T[0-9]{6}Z\.dump\.age\$" | sort | tail -n 1 || true)"
if [ -z "$NEWEST" ]; then
  echo "offsite-drill: nothing to fetch: no fishtape-$ENV_NAME-*.dump.age in $SRC/" >&2
  exit 4
fi
HAS_SHA=0
[[ $'\n'"$listing"$'\n' == *$'\n'"$NEWEST.sha256"$'\n'* ]] && HAS_SHA=1
STAMP="${NEWEST#"fishtape-$ENV_NAME-"}"; STAMP="${STAMP%.dump.age}"
AGE_H=""
if made="$(date -u -d "${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2} ${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}" +%s 2>/dev/null)"; then
  AGE_H=$(( ($(date -u +%s) - made) / 3600 ))
fi
echo "newest offsite backup: $SRC/$NEWEST${AGE_H:+ ($AGE_H hours old)}"
if [ -n "$AGE_H" ] && [ "$AGE_H" -gt 26 ]; then echo "warning: the newest offsite copy is over 26 hours old: backups are not reaching the bucket" >&2; fi

if [ "$DRY" -eq 1 ]; then
  echo "would fetch: $SRC/$NEWEST"
  if [ "$HAS_SHA" -eq 1 ]; then echo "would fetch: $SRC/$NEWEST.sha256"; else echo "missing:     $SRC/$NEWEST.sha256 (a real run fails on this)"; fi
  echo "would restore it into a scratch Postgres with restore-test.sh$([ "$VERIFY" -eq 1 ] && printf ' and check secrets with verify-restore.mjs')"
  echo "dry run: nothing fetched"
  exit 0
fi

# ---- the drill ----
START="$(date +%s)"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fishtape-drill.XXXXXX")"
CONTAINER="fishtape-drill-$ENV_NAME-$$"
KEEP_CONTAINER=$(( KEEP || VERIFY ))
SHA256=""
MIGRATIONS=""
MIGRATION=""
TENANTS=""
SECRETS_CHECKED=false
SECRETS_OK=null

cleanup() {
  rm -rf "$TMPD"
  if [ "$KEEP_CONTAINER" -eq 1 ]; then
    if [ "$KEEP" -eq 1 ]; then
      echo "scratch database left running: docker exec -it $CONTAINER psql -U postgres -d fishtape   (remove: docker rm -f -v $CONTAINER)"
    else
      docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

jstr() { # JSON string or null
  if [ -z "${1:-}" ]; then printf 'null'; return; fi
  local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\r'/ }; s=${s//$'\t'/ }
  printf '"%s"' "$s"
}
jnum() { if [[ "${1:-}" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi; }

record() { # ok failures
  local line
  line="$(printf '{"ts":"%s","environment":%s,"source":"offsite","host":"off-box","file":%s,"sha256":%s,"ok":%s,"secretsChecked":%s,"secretsOk":%s,"migrations":%s,"migration":%s,"tenants":%s,"durationSeconds":%d,"failures":%s}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(jstr "$ENV_NAME")" "$(jstr "$NEWEST")" "$(jstr "$SHA256")" "$1" "$SECRETS_CHECKED" "$SECRETS_OK" \
    "$(jnum "$MIGRATIONS")" "$(jstr "$MIGRATION")" "$(jnum "$TENANTS")" "$(( $(date +%s) - START ))" "$(jstr "$2")")"
  printf '%s\n' "$line" >> "$LOG"
  echo
  echo "$line"
  echo "result appended to $LOG; record it on the HQ health page (Record a drill result)"
}
fail() { # exit-code message
  echo "FAIL: $2" >&2
  record false "$2"
  exit "$1"
}

echo "fetching into a private temp directory"
"${RCLONE[@]}" copyto "$SRC/$NEWEST" "$TMPD/$NEWEST" || fail 1 "download of $NEWEST failed"
[ "$HAS_SHA" -eq 1 ] || fail 1 "the offsite copy has no $NEWEST.sha256: backup.sh uploads both, so the copy is incomplete"
"${RCLONE[@]}" copyto "$SRC/$NEWEST.sha256" "$TMPD/$NEWEST.sha256" || fail 1 "download of $NEWEST.sha256 failed"

read -r expected expected_name < "$TMPD/$NEWEST.sha256" || true
SHA256="$(sha256sum "$TMPD/$NEWEST" | cut -d' ' -f1)"
if [ "${expected:-}" != "$SHA256" ] || [ "${expected_name:-}" != "$NEWEST" ]; then
  fail 1 "checksum mismatch: the offsite copy is damaged or incomplete"
fi
echo "checksum ok ($SHA256)"

rt_args=(--file "$TMPD/$NEWEST" --identity - --name "$CONTAINER" --log "$TMPD/restore-test.jsonl")
[ "$KEEP_CONTAINER" -eq 0 ] || rt_args+=(--keep)
if printf '%s' "$IDENTITY_DATA" | "$HERE/restore-test.sh" "${rt_args[@]}"; then rt=0; else rt=$?; fi
IDENTITY_DATA=""
rt_line="$(tail -n 1 "$TMPD/restore-test.jsonl" 2>/dev/null || true)"
MIGRATIONS="$(printf '%s' "$rt_line" | sed -n 's/.*"migrations":\([0-9][0-9]*\).*/\1/p')"
TENANTS="$(printf '%s' "$rt_line" | sed -n 's/.*"tenants":\([0-9][0-9]*\).*/\1/p')"
[ "$rt" -eq 0 ] || fail 1 "restore-test.sh failed (exit $rt): see its output above"

if [ "$VERIFY" -eq 1 ]; then
  echo
  echo "checking secrets decrypt with SECRETS_MASTER_KEY"
  if vout="$(printf '%s\n' "$MASTER_LINE" | node "$REPO/server/scripts/verify-restore.mjs" --container "$CONTAINER")"; then vrc=0; else vrc=$?; fi
  MASTER_LINE=""
  MIGRATION="$(printf '%s' "$vout" | sed -n 's/.*"migration":"\([0-9][0-9]*\)".*/\1/p' | tail -n 1)"
  decrypted="$(printf '%s' "$vout" | sed -n 's/.*"decrypted":\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  # The key was only proven if at least one value decrypted with it.
  if [ "${decrypted:-0}" -gt 0 ] || [ "$vrc" -eq 5 ]; then SECRETS_CHECKED=true; fi
  case "$vrc" in
    0) SECRETS_OK=true
       [ "$SECRETS_CHECKED" = true ] || echo "warning: this backup holds no encrypted values, so SECRETS_MASTER_KEY could not be checked" >&2 ;;
    5) SECRETS_OK=false; fail 5 "secrets did not decrypt with this SECRETS_MASTER_KEY (wrong key, or the values are damaged)" ;;
    *) fail 1 "verify-restore.mjs failed (exit $vrc)" ;;
  esac
fi

echo
echo "PASS: $NEWEST restored from offsite${AGE_H:+ ($AGE_H hours old)}$([ "$VERIFY" -eq 1 ] && printf ', secrets decrypt')"
record true ""
