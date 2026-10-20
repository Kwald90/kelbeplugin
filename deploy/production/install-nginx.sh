#!/usr/bin/env bash
# Install or refresh the Fishtape production nginx config on the shared CloudPanel box, test it,
# and reload only if the test passes. On a failed test every file is put back as it was and
# nginx is not reloaded.
#
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh --acme-bootstrap   first run, before the certificate exists
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh                    full config (needs the "fishtape" certificate)
#
# It only writes Fishtape's own files (sites-available/fishtape-production.conf and its
# sites-enabled/zz-fishtape-production.conf link, the fishtape-*.conf snippets, the logrotate
# file) and never edits another site's vhost. The link name sorts last so no Fishtape server
# becomes nginx's implicit default for a port. A server name already claimed by another vhost
# counts as a failure (nginx -t only warns about it and then ignores one of the two).
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/lib/fishtape-production/nginx-backups/$STAMP"
AVAIL=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
SITE_LINK="$ENABLED/zz-fishtape-production.conf"
ACME_LINK="$ENABLED/zz-fishtape-acme.conf"
CERT=/etc/letsencrypt/live/fishtape/fullchain.pem

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }

MODE=full
case "${1:-}" in
  --acme-bootstrap) MODE=acme ;;
  "") ;;
  -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

declare -A FILES
if [ "$MODE" = acme ]; then
  FILES=(["$HERE/nginx/acme-bootstrap.conf"]="$AVAIL/fishtape-acme.conf")
  LINK_SRC="$AVAIL/fishtape-acme.conf"
  LINK_DST="$ACME_LINK"
else
  [ -s "$CERT" ] || { echo "no certificate at $CERT yet: run --acme-bootstrap, then issue-cert.sh (README.md)" >&2; exit 1; }
  FILES=(
    ["$HERE/nginx/fishtape.conf"]="$AVAIL/fishtape-production.conf"
    ["$HERE/nginx/security-headers.conf"]=/etc/nginx/snippets/fishtape-headers.conf
    ["$HERE/nginx/proxy.conf"]=/etc/nginx/snippets/fishtape-proxy.conf
    ["$HERE/nginx/deny.conf"]=/etc/nginx/snippets/fishtape-deny.conf
    ["$HERE/nginx/tls.conf"]=/etc/nginx/snippets/fishtape-tls.conf
    ["$HERE/logrotate-nginx"]=/etc/logrotate.d/fishtape-production-nginx
  )
  LINK_SRC="$AVAIL/fishtape-production.conf"
  LINK_DST="$SITE_LINK"
fi

mkdir -p /etc/nginx/snippets "$AVAIL" "$ENABLED" /var/www/certbot "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
install -d -o root -g adm -m 0750 /var/log/fishtape-production
install -d -m 0755 /var/lib/fishtape-production /var/lib/fishtape-production/media

# ---- back up everything this run may change ----
for src in "${!FILES[@]}"; do
  dst="${FILES[$src]}"
  if [ -f "$dst" ]; then cp -p "$dst" "$BACKUP_DIR/$(basename "$dst")"; fi
done
had_link=0; [ -L "$LINK_DST" ] && had_link=1
had_acme=0; [ -L "$ACME_LINK" ] && had_acme=1
# Before the shared-box layout the site was linked as sites-enabled/fishtape.conf.
old_link=""
if [ -L "$ENABLED/fishtape.conf" ] && [ "$(readlink "$ENABLED/fishtape.conf")" = "$AVAIL/fishtape.conf" ]; then old_link="$ENABLED/fishtape.conf"; fi
nginx -T 2>/dev/null > "$BACKUP_DIR/nginx-T.before.txt" || true

restore() {
  echo "restoring the previous files from $BACKUP_DIR" >&2
  for src in "${!FILES[@]}"; do
    dst="${FILES[$src]}"
    if [ -f "$BACKUP_DIR/$(basename "$dst")" ]; then cp -p "$BACKUP_DIR/$(basename "$dst")" "$dst"; else rm -f "$dst"; fi
  done
  [ "$had_link" -eq 1 ] || rm -f "$LINK_DST"
  if [ "$had_acme" -eq 1 ]; then ln -sfn "$AVAIL/fishtape-acme.conf" "$ACME_LINK"; fi
  if [ -n "$old_link" ]; then ln -sfn "$AVAIL/fishtape.conf" "$old_link"; fi
  nginx -t || true
}

# ---- install ----
for src in "${!FILES[@]}"; do
  install -o root -g root -m 0644 "$src" "${FILES[$src]}"
done
ln -sfn "$LINK_SRC" "$LINK_DST"
if [ "$MODE" = full ]; then
  # The full config serves the ACME path itself, so the bootstrap site goes away.
  rm -f "$ACME_LINK"
  if [ -n "$old_link" ]; then rm -f "$old_link"; fi
fi

# ---- test: syntax, and no server name shared with another vhost ----
if ! out="$(nginx -t 2>&1)"; then
  printf '%s\n' "$out" >&2
  echo "nginx -t failed" >&2
  restore
  exit 1
fi
printf '%s\n' "$out"
if printf '%s\n' "$out" | grep -E 'conflicting server name' | grep -qi 'fishtapehq\.com'; then
  echo "another vhost already uses a fishtapehq.com name (see the warning above); nginx would ignore one of them." >&2
  echo "Remove the other site (for example one created in CloudPanel for this domain), then run this again." >&2
  restore
  exit 1
fi
# The site must actually be loaded (the main nginx.conf has to include sites-enabled/).
if ! nginx -T 2>/dev/null | grep -qE 'server_name[[:space:]]+([^;]*[[:space:]])?app\.fishtapehq\.com'; then
  echo "nginx -t passed but the Fishtape server blocks are not in the loaded config: does nginx.conf include $ENABLED/*?" >&2
  restore
  exit 1
fi

systemctl reload nginx
echo "nginx config ($MODE) installed and reloaded; previous copies in $BACKUP_DIR"

# ---- shared-box check: Fishtape must not be what nginx shows for unknown names ----
if [ "$MODE" = full ] && command -v openssl >/dev/null; then
  sleep 1
  subj="$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername unknown-name.invalid </dev/null 2>/dev/null \
    | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null || true)"
  if printf '%s' "$subj" | grep -q 'fishtapehq\.com'; then
    echo "WARNING: an unknown host name on :443 gets the Fishtape certificate, so a Fishtape server is nginx's" >&2
    echo "default there. Harmless for Fishtape, but other sites' defaults should win: check the box's default_server." >&2
  fi
fi
