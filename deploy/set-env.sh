#!/usr/bin/env bash
# Set one value in a Fishtape .env and restart the app, without the value ever showing on
# screen, in shell history, in logs or in a chat. Run it over SSH with a terminal:
#
#   ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 \
#     "sudo /var/www/tgelectrical/current/deploy/set-env.sh production SENDGRID_API_KEY"
#
# The environment is `production` or `staging`. Only names listed in that environment's
# .env.example can be set. Secrets are read hidden; the confirmation shows the last 4 characters.
set -Eeuo pipefail
umask 077

die() { echo "set-env: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"

ENV_NAME="${1:-}"
NAME="${2:-}"
case "$ENV_NAME" in
  production) DIR=/srv/fishtape/repo/deploy/production; STATE=/var/lib/fishtape-production ;;
  staging)    DIR=/var/www/tgelectrical/current/deploy/staging; STATE=/var/lib/fishtape-staging ;;
  *) die "usage: set-env.sh production|staging NAME" ;;
esac
FILE="$DIR/.env"
[ -f "$FILE" ] || die "$FILE is missing (run init-env.sh first)"
[[ "$NAME" =~ ^[A-Z][A-Z0-9_]{1,63}$ ]] || die "not a setting name: $NAME"
grep -Eq "^#? *$NAME=" "$DIR/.env.example" || die "$NAME is not a known setting (see $DIR/.env.example)"

# Values that are not secret are shown back in full.
case "$NAME" in
  EMAIL_FROM|EMAIL_PROVIDER|HQ_NOTIFY_EMAIL|SUPPORT_EMAIL|PUBLIC_ORIGIN|HQ_PUBLIC_URL|TRIAL_DAYS|MAIL_DOMAIN) PLAIN=1 ;;
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

export FT_NAME="$NAME" FT_VALUE="$VALUE"
TMP="$(mktemp "$DIR/.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
awk 'BEGIN { n = ENVIRON["FT_NAME"]; v = ENVIRON["FT_VALUE"]; done = 0 }
     index($0, n "=") == 1 { print n "=" v; done = 1; next }
     { print }
     END { if (!done) print n "=" v }' "$FILE" > "$TMP"
chown root:root "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$FILE"
trap - EXIT
unset FT_VALUE VALUE

if [ "$PLAIN" -eq 1 ]; then
  echo "Saved $NAME=$(grep "^$NAME=" "$FILE" | cut -d= -f2-)"
else
  echo "Saved $NAME (ends …$(grep "^$NAME=" "$FILE" | cut -d= -f2- | tail -c 5))"
fi

# Restart the running release with the new settings (same image, no rebuild).
TAG="$(cat "$STATE/current-image" 2>/dev/null || echo current)"
echo "Restarting api, hq-api and worker on $TAG…"
( cd "$DIR" && IMAGE_TAG="$TAG" docker compose up -d --no-build --force-recreate api hq-api worker ) </dev/null >/dev/null 2>&1 \
  || die "saved, but the restart failed: run update.sh, or docker compose up -d in $DIR"
echo "Done."
