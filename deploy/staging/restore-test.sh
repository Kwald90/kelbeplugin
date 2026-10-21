#!/usr/bin/env bash
# Prove a backup restores. Decrypts a backup, restores it into a throwaway Postgres container
# with no network, runs sanity queries, then deletes the container. Nothing touches the live
# database. Run it at least quarterly (docs/compliance/backup-retention.md) and after any
# change to backup.sh.
#
# Needs the age private key, which lives offline. Two ways to run it:
#
#   On the server, piping the key from your computer (it is never written to the server's disk):
#     ssh ubuntu@<host> 'sudo /path/to/deploy/<env>/restore-test.sh --identity -' < fishtape-<env>-backup.key
#
#   On your own computer (Docker, age and bash; Git Bash works), after copying a backup down:
#     ./restore-test.sh --file fishtape-<env>-20261019T091500Z.dump.age --identity ~/keys/fishtape-<env>-backup.key
#     (a passphrase-protected identity made with `age -p` prompts for the passphrase)
#
# Options:
#   --file <path>       backup to test (default: newest nightly in /var/backups/fishtape-<env>/daily)
#   --identity <file>   age identity file, or - to read it from stdin (required)
#   --keep              leave the container running afterwards (prints how to remove it)
#   --log <file>        also append the JSON result line to <file> (evidence when run on your own
#                       computer; on the server it always goes to /var/lib/fishtape-<env>/restore-tests.jsonl,
#                       and to drills/restore-tests.jsonl there, which HQ health reads)
#   --name <name>       name the throwaway container (offsite-drill.sh uses it with --keep to check
#                       secrets against the restored database before removing it)
#
# The offsite drill (offsite-drill.sh, off the server) fetches the newest offsite copy and runs this.
#
# deploy/production/restore-test.sh is an identical copy; CI fails if they differ.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="$(basename "$HERE")"
BACKUP_DIR="/var/backups/fishtape-$ENV_NAME"
STATE_DIR="/var/lib/fishtape-$ENV_NAME"

FILE=""
IDENTITY=""
KEEP=0
LOG=""
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$IDENTITY" ] || { echo "--identity is required (the offline age key, or - for stdin)" >&2; exit 2; }
if [ -n "$NAME" ] && ! [[ "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]]; then echo "--name: letters, digits, _ . - only" >&2; exit 2; fi
command -v age >/dev/null || { echo "age is not installed" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }

if [ -z "$FILE" ]; then
  FILE="$(find "$BACKUP_DIR/daily" -maxdepth 1 -name 'fishtape-*.dump.age' 2>/dev/null | sort -r | head -1)"
  [ -n "$FILE" ] || { echo "no backups found in $BACKUP_DIR/daily; pass --file" >&2; exit 1; }
fi
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }

# Read a stdin identity once into memory and hand it to age through a pipe, so stdin stays free
# and the key never lands on disk.
IDENTITY_DATA=""
if [ "$IDENTITY" = "-" ] || [ "$IDENTITY" = /dev/stdin ]; then
  IDENTITY_DATA="$(cat)"
  [ -n "$IDENTITY_DATA" ] || { echo "no identity on stdin" >&2; exit 2; }
elif [ ! -r "$IDENTITY" ]; then
  echo "can't read identity file $IDENTITY" >&2; exit 2
fi
decrypt() {
  if [ -n "$IDENTITY_DATA" ]; then
    age -d -i <(printf '%s\n' "$IDENTITY_DATA") "$FILE"
  else
    age -d -i "$IDENTITY" "$FILE"
  fi
}

START="$(date +%s)"
SHA256="$(sha256sum "$FILE" | cut -d' ' -f1)"
if [ -f "$FILE.sha256" ]; then
  expected="$(cut -d' ' -f1 "$FILE.sha256")"
  [ "$expected" = "$SHA256" ] || { echo "checksum mismatch for $FILE" >&2; exit 1; }
  echo "checksum ok"
fi

# Same Postgres image as the live stack.
IMAGE="$(grep -m1 -E '^[[:space:]]*image:[[:space:]]*postgres:' "$HERE/docker-compose.yml" 2>/dev/null | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/[[:space:]]+$//' || true)"
IMAGE="${IMAGE:-postgres:17}"
NAME="${NAME:-fishtape-restore-test-$ENV_NAME-$$}"
PW="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "container left running: docker exec -it $NAME psql -U postgres -d fishtape   (remove: docker rm -f -v $NAME)"
  else
    docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "starting $IMAGE as $NAME (no network)"
docker run -d --name "$NAME" --network none \
  -e POSTGRES_PASSWORD="$PW" \
  -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8" \
  "$IMAGE" >/dev/null

# TCP readiness means the final server (the init-time server listens on the socket only).
for _ in $(seq 1 60); do
  if docker exec -e PGPASSWORD="$PW" "$NAME" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; then break; fi
  sleep 2
done
docker exec -e PGPASSWORD="$PW" "$NAME" pg_isready -h 127.0.0.1 -U postgres -q || { echo "test Postgres did not start" >&2; docker logs "$NAME" | tail -20 >&2; exit 1; }

psql_() { docker exec -e PGPASSWORD="$PW" "$NAME" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -X -At "$@"; }

# Roles the dump refers to (grants and ownership). Attributes don't matter for the test.
psql_ -d postgres -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fishtape_owner') THEN CREATE ROLE fishtape_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fishtape_app') THEN CREATE ROLE fishtape_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fishtape_hq') THEN CREATE ROLE fishtape_hq NOLOGIN BYPASSRLS; END IF;
END \$\$;" >/dev/null

echo "restoring $(basename "$FILE")"
st=()
{ decrypt | docker exec -i -e PGPASSWORD="$PW" "$NAME" pg_restore -h 127.0.0.1 -U postgres --create --exit-on-error -d postgres; st=("${PIPESTATUS[@]}"); } || true
[ "${st[0]:-1}" -eq 0 ] || { echo "decryption failed (wrong key?)" >&2; exit 1; }
[ "${st[1]:-1}" -eq 0 ] || { echo "pg_restore failed" >&2; exit 1; }

q() { psql_ -d fishtape -c "$1"; }
FAILURES=()

TABLES="$(q "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
[ "$TABLES" -gt 0 ] || FAILURES+=("no tables restored")

MIGRATIONS=null
if [ "$(q "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" = t ]; then
  MIGRATIONS="$(q "SELECT count(*) FROM schema_migrations")"
  [ "$MIGRATIONS" -gt 0 ] || FAILURES+=("schema_migrations is empty")
fi
TENANTS=null
if [ "$(q "SELECT to_regclass('public.tenants') IS NOT NULL")" = t ]; then
  TENANTS="$(q "SELECT count(*) FROM tenants")"
fi
NEWEST_AUDIT=""
if [ "$(q "SELECT to_regclass('public.audit_events') IS NOT NULL")" = t ]; then
  NEWEST_AUDIT="$(q "SELECT coalesce(to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') FROM audit_events")"
fi

# Tenant data tables (tenant_id + data + change_seq) must keep ENABLE and FORCE row level security.
RLS_GAPS="$(q "SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'data' AND NOT a.attisdropped)
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'change_seq' AND NOT a.attisdropped)
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")"
[ -z "$RLS_GAPS" ] || FAILURES+=("tables without ENABLE+FORCE RLS: $RLS_GAPS")
RLS_TABLES="$(q "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity")"
DB_SIZE="$(q "SELECT pg_size_pretty(pg_database_size('fishtape'))")"

echo
echo "== restore test: $(basename "$FILE")"
echo "database size     $DB_SIZE"
echo "tables            $TABLES (RLS enabled+forced: $RLS_TABLES)"
echo "migrations        $MIGRATIONS"
echo "tenants           $TENANTS"
echo "newest audit row  ${NEWEST_AUDIT:-n/a}"
echo "largest tables:"
q "SELECT format('  %-32s %s', table_name,
         (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text)
   FROM information_schema.tables
   WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'
   ORDER BY pg_total_relation_size(format('%I.%I', table_schema, table_name)) DESC LIMIT 15"

OK=true
if [ "${#FAILURES[@]}" -gt 0 ]; then
  OK=false
  printf 'FAIL: %s\n' "${FAILURES[@]}"
else
  echo "PASS"
fi

# Evidence (A1.3): one JSON line per test, next to the backup log when run on the server, and in
# --log <file> when given.
esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
RESULT_LINE="$(printf '{"ts":"%s","environment":"%s","source":"local","host":"%s","file":"%s","sha256":"%s","ok":%s,"tables":%s,"rlsForcedTables":%s,"migrations":%s,"tenants":%s,"newestAuditEvent":"%s","databaseSize":"%s","durationSeconds":%d,"failures":"%s"}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENV_NAME" "$(hostname)" "$(basename "$FILE")" "$SHA256" "$OK" "$TABLES" "$RLS_TABLES" "$MIGRATIONS" "$TENANTS" \
  "$NEWEST_AUDIT" "$DB_SIZE" "$(( $(date +%s) - START ))" "$(esc "${FAILURES[*]:-}")")"
if [ -d "$STATE_DIR" ] && [ -w "$STATE_DIR" ]; then
  printf '%s\n' "$RESULT_LINE" >> "$STATE_DIR/restore-tests.jsonl"
  # The copy HQ health reads (RESTORE_TESTS_FILE, mounted into hq-api and the worker as uid 1000).
  if [ -d "$STATE_DIR/drills" ]; then
    printf '%s\n' "$RESULT_LINE" >> "$STATE_DIR/drills/restore-tests.jsonl"
    chown 1000:1000 "$STATE_DIR/drills/restore-tests.jsonl" 2>/dev/null || true
    chmod 600 "$STATE_DIR/drills/restore-tests.jsonl"
  fi
fi
if [ -n "$LOG" ]; then
  printf '%s\n' "$RESULT_LINE" >> "$LOG"
  echo "result appended to $LOG"
fi

[ "$OK" = true ]
