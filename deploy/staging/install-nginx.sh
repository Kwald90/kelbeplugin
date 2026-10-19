#!/usr/bin/env bash
# Install or refresh the Fishtape nginx snippets on the staging box, test, and reload.
# It never edits the CloudPanel vhost itself; that one-time include line is README.md step 5.
# On a failed `nginx -t` the previous snippets are put back and nginx is not reloaded.
#   sudo /var/www/tgelectrical/current/deploy/staging/install-nginx.sh
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPETS=/etc/nginx/snippets
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR=/var/lib/fishtape-staging/nginx-backups/$STAMP

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }

declare -A FILES=(
  ["$HERE/security-headers.conf"]="$SNIPPETS/fishtape-staging-headers.conf"
  ["$HERE/nginx-api.conf.snippet"]="$SNIPPETS/fishtape-staging-site.conf"
)

mkdir -p "$SNIPPETS" "$BACKUP_DIR"
for src in "${!FILES[@]}"; do
  dst="${FILES[$src]}"
  if [ -f "$dst" ]; then cp -p "$dst" "$BACKUP_DIR/"; fi
done

restore() {
  echo "nginx -t failed; restoring the previous snippets from $BACKUP_DIR" >&2
  for src in "${!FILES[@]}"; do
    dst="${FILES[$src]}"
    if [ -f "$BACKUP_DIR/$(basename "$dst")" ]; then
      cp -p "$BACKUP_DIR/$(basename "$dst")" "$dst"
    else
      rm -f "$dst"
    fi
  done
  nginx -t || true
}

for src in "${!FILES[@]}"; do
  install -o root -g root -m 0644 "$src" "${FILES[$src]}"
done

if ! nginx -t; then
  restore
  exit 1
fi
systemctl reload nginx
echo "nginx snippets installed and reloaded (previous copies in $BACKUP_DIR)"
