#!/usr/bin/env bash
# Install or refresh the Fishtape nginx files on the staging box, test, and reload.
# It never edits the CloudPanel vhost itself; the one-time include lines are README.md step 5.
# On a failed `nginx -t` the previous files are put back and nginx is not reloaded.
#   sudo /var/www/tgelectrical/current/deploy/staging/install-nginx.sh
#   sudo .../install-nginx.sh --check     exit 0 when the files are installed as in this checkout, 1 when not
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPETS=/etc/nginx/snippets
LOG_DIR=/var/log/fishtape-staging
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR=/var/lib/fishtape-staging/nginx-backups/$STAMP

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }
CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

declare -A FILES=(
  ["$HERE/nginx-http.conf"]="$SNIPPETS/fishtape-staging-http.conf"
  ["$HERE/security-headers.conf"]="$SNIPPETS/fishtape-staging-headers.conf"
  ["$HERE/nginx-proxy.conf"]="$SNIPPETS/fishtape-staging-proxy.conf"
  ["$HERE/nginx-api.conf.snippet"]="$SNIPPETS/fishtape-staging-site.conf"
  ["$HERE/logrotate-nginx"]=/etc/logrotate.d/fishtape-staging-nginx
)

# --check: is every file installed exactly as in this checkout? update.sh installs whenever not,
# so a failed or skipped install is retried by the next deploy.
if [ "$CHECK" -eq 1 ]; then
  for src in "${!FILES[@]}"; do cmp -s "$src" "${FILES[$src]}" || exit 1; done
  exit 0
fi

mkdir -p "$SNIPPETS" "$BACKUP_DIR"
install -d -o root -g adm -m 0750 "$LOG_DIR"
for src in "${!FILES[@]}"; do
  dst="${FILES[$src]}"
  if [ -f "$dst" ]; then cp -p "$dst" "$BACKUP_DIR/$(basename "$dst")"; fi
done

restore() {
  echo "nginx -t failed; restoring the previous files from $BACKUP_DIR" >&2
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
echo "nginx files installed and reloaded (previous copies in $BACKUP_DIR)"
if ! nginx -T 2>/dev/null | grep -q 'include /etc/nginx/snippets/fishtape-staging-site.conf'; then
  echo "note: the vhost doesn't include fishtape-staging-site.conf yet; see README.md step 5"
fi
