#!/usr/bin/env bash
# Set one value in a Fishtape .env and restart the app, without the value ever showing on
# screen, in shell history, in logs or in a chat. Run it over SSH with a terminal:
#
#   ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 \
#     "sudo /var/www/tgelectrical/current/deploy/set-env.sh production SENDGRID_API_KEY"
#
# The environment is `production` or `staging`. Only names listed in that environment's
# .env.example can be set, except the database passwords, SECRETS_MASTER_KEY and the PG_* sizing
# (docs/runbooks/rotate-secrets.md). Secrets are read hidden; the confirmation shows the last 4
# characters. The previous .env is kept in <state>/env-backups/; if the app does not become ready
# with the new value, that copy is put back and the app restarted on it.
set -Eeuo pipefail
umask 077

die() { echo "set-env: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"

ENV_NAME="${1:-}"
NAME="${2:-}"
case "$ENV_NAME" in
  production) DIR=/srv/fishtape/repo/deploy/production; STATE=/var/lib/fishtape-production; API=http://127.0.0.1:3420; HQ_API=http://127.0.0.1:3421 ;;
  staging)    DIR=/var/www/tgelectrical/current/deploy/staging; STATE=/var/lib/fishtape-staging; API=http://127.0.0.1:3410; HQ_API=http://127.0.0.1:3411 ;;
  *) die "usage: set-env.sh production|staging NAME" ;;
esac
FILE="$DIR/.env"
[ -f "$FILE" ] || die "$FILE is missing (run init-env.sh first)"
[[ "$NAME" =~ ^[A-Z][A-Z0-9_]{1,63}$ ]] || die "not a setting name: $NAME"
grep -Eq "^#? *$NAME=" "$DIR/.env.example" || die "$NAME is not a known setting (see $DIR/.env.example)"
# A new value in .env alone breaks these: the role passwords also live in Postgres (ALTER ROLE
# first), the master key wraps every tenant secret, and PG_* only apply when Postgres restarts.
case "$NAME" in
  POSTGRES_SUPERUSER_PASSWORD|FISHTAPE_*_PASSWORD|SECRETS_MASTER_KEY|PG_*)
    die "$NAME can't be changed safely with this script; follow docs/runbooks/rotate-secrets.md (PG_*: edit .env, then run update.sh --force)" ;;
esac

# Values that are not secret are shown back in full.
case "$NAME" in
  EMAIL_FROM|EMAIL_PROVIDER|HQ_NOTIFY_EMAIL|SUPPORT_EMAIL|PUBLIC_ORIGIN|HQ_PUBLIC_URL|TRIAL_DAYS|MAIL_DOMAIN) PLAIN=1 ;;
  # QuickBooks: the environment, the app's client id (an identifier, not a secret) and the write switch.
  QBO_ENVIRONMENT|QBO_CLIENT_ID|QBO_WRITES|QBO_READ_BUDGET|QBO_TENANT_READ_BUDGET|QBO_TRIAL_READ_BUDGET|WORKER_QBO_CONCURRENCY) PLAIN=1 ;;
  *) PLAIN=0 ;;
esac

if [ "$PLAIN" -eq 1 ]; then
  read -r -p "Value for $NAME: " VALUE
else
  read -r -s -p "Paste $NAME (hidden), then press Enter: " VALUE
  echo
fi
[ -n "$VALUE" ] || die "empty value; nothing changed"
case "$VALUE" in *$'\n'*|*$'\r'*) die "the value has a line break; nothing changed" ;; esac
# Written single-quoted, so docker compose takes it literally ($, #, " and spaces included).
case "$VALUE" in *"'"*) die "the value has a single quote ('), which .env can't hold literally; nothing changed" ;; esac
if [ "$PLAIN" -eq 1 ]; then SHOWN="$NAME=$VALUE"; else SHOWN="$NAME (ends …${VALUE: -4})"; fi

# Not while a deploy runs: it switches the containers before it records the new current-image.
mkdir -p "$STATE"
exec 9>"$STATE/deploy.lock"
flock -n 9 || die "a deploy is running; nothing changed (try again when it has finished)"

# Keep the previous .env (root-only, the newest 10).
install -d -o root -g root -m 700 "$STATE/env-backups"
BACKUP="$STATE/env-backups/.env.$(date -u +%Y%m%dT%H%M%SZ).$$"
cp -p "$FILE" "$BACKUP"
chmod 600 "$BACKUP"
find "$STATE/env-backups" -maxdepth 1 -type f -name '.env.*' -printf '%T@\t%p\n' | sort -rn | cut -f2- \
  | tail -n +11 | while IFS= read -r old; do rm -f "$old"; done

export FT_NAME="$NAME" FT_VALUE="$VALUE"
TMP="$(mktemp "$DIR/.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
awk 'BEGIN { n = ENVIRON["FT_NAME"]; v = ENVIRON["FT_VALUE"]; line = n "=\047" v "\047"; done = 0 }
     index($0, n "=") == 1 { print line; done = 1; next }
     { print }
     END { if (!done) print line }' "$FILE" > "$TMP"
chown root:root "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$FILE"
trap - EXIT
unset FT_VALUE VALUE
echo "Saved $SHOWN"

# Restart the running release with the new settings (same image, no rebuild), then wait for it.
TAG="$(cat "$STATE/current-image" 2>/dev/null || echo current)"
READY_TIMEOUT="${READY_TIMEOUT:-120}"
restart() { ( cd "$DIR" && IMAGE_TAG="$TAG" docker compose up -d --no-build --force-recreate api hq-api worker ) </dev/null >/dev/null 2>&1; }
ready() { # seconds
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 5 -o /dev/null "$API/api/readyz" && curl -fsS -m 5 -o /dev/null "$HQ_API/api/readyz"; then return 0; fi
    sleep 3
  done
  return 1
}
echo "Restarting api, hq-api and worker on $TAG…"
if restart && ready "$READY_TIMEOUT"; then
  echo "Done."
  exit 0
fi
echo "set-env: the app did not become ready with the new $NAME; putting the previous .env back" >&2
cp -p "$BACKUP" "$FILE"
chmod 600 "$FILE"
if restart && ready "$READY_TIMEOUT"; then
  die "restored the previous .env; the app is back on the old $NAME. Check the value and try again"
fi
die "restored the previous .env, but the app is still not ready: docker compose logs api in $DIR, docs/runbooks/rollback.md"
