#!/usr/bin/env bash
# Install or refresh the Fishtape nginx config on the production host, test it, and reload.
# On a failed `nginx -t` the previous files are put back and nginx is not reloaded.
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh
#   sudo .../install-nginx.sh --acme-bootstrap   first run only, before the certificate exists
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/lib/fishtape-production/nginx-backups/$STAMP"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }

declare -A FILES
if [ "${1:-}" = "--acme-bootstrap" ]; then
  FILES=(["$HERE/nginx/acme-bootstrap.conf"]=/etc/nginx/sites-available/fishtape-acme.conf)
  LINK_SRC=/etc/nginx/sites-available/fishtape-acme.conf
  LINK_DST=/etc/nginx/sites-enabled/fishtape-acme.conf
else
  FILES=(
    ["$HERE/nginx/fishtape.conf"]=/etc/nginx/sites-available/fishtape.conf
    ["$HERE/nginx/security-headers.conf"]=/etc/nginx/snippets/fishtape-headers.conf
    ["$HERE/nginx/proxy.conf"]=/etc/nginx/snippets/fishtape-proxy.conf
  )
  LINK_SRC=/etc/nginx/sites-available/fishtape.conf
  LINK_DST=/etc/nginx/sites-enabled/fishtape.conf
fi

mkdir -p /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/certbot "$BACKUP_DIR"
for src in "${!FILES[@]}"; do
  dst="${FILES[$src]}"
  if [ -f "$dst" ]; then cp -p "$dst" "$BACKUP_DIR/$(basename "$dst")"; fi
done
had_link=0
[ -L "$LINK_DST" ] && had_link=1
had_acme=0
[ -L /etc/nginx/sites-enabled/fishtape-acme.conf ] && had_acme=1

for src in "${!FILES[@]}"; do
  install -o root -g root -m 0644 "$src" "${FILES[$src]}"
done
ln -sfn "$LINK_SRC" "$LINK_DST"
# The full config serves the ACME path itself, so the bootstrap site goes away.
if [ "${1:-}" != "--acme-bootstrap" ]; then rm -f /etc/nginx/sites-enabled/fishtape-acme.conf; fi

if ! nginx -t; then
  echo "nginx -t failed; restoring the previous files from $BACKUP_DIR" >&2
  for src in "${!FILES[@]}"; do
    dst="${FILES[$src]}"
    if [ -f "$BACKUP_DIR/$(basename "$dst")" ]; then cp -p "$BACKUP_DIR/$(basename "$dst")" "$dst"; else rm -f "$dst"; fi
  done
  [ "$had_link" -eq 1 ] || rm -f "$LINK_DST"
  if [ "$had_acme" -eq 1 ]; then ln -sfn /etc/nginx/sites-available/fishtape-acme.conf /etc/nginx/sites-enabled/fishtape-acme.conf; fi
  nginx -t || true
  exit 1
fi
systemctl reload nginx
echo "nginx config installed and reloaded (previous copies in $BACKUP_DIR)"
