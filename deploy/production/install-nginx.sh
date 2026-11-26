#!/usr/bin/env bash
# Install or refresh the Fishtape production nginx config on the shared CloudPanel box, test it,
# and reload only if the test passes. On a failed test every file is put back as it was and
# nginx is not reloaded.
#
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh --acme-bootstrap   first run, before the certificate exists
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh                    full config (needs the "fishtape" certificate)
#   sudo /srv/fishtape/repo/deploy/production/install-nginx.sh --check            exit 0 when the full config is installed as in
#                                                                                 this checkout, 1 when it is not (changes nothing)
#
# It only writes Fishtape's own files (sites-available/fishtape-production.conf and its
# sites-enabled/zz-fishtape-production.conf link, the fishtape-*.conf snippets, the logrotate
# file) and never edits another site's vhost. The link name sorts last so no Fishtape server
# becomes nginx's implicit default for a port. A server name already claimed by another vhost
# counts as a failure (nginx -t only warns about it and then ignores one of the two).
#
# Container mode (NGINX_MODE=container, set in the host profile /etc/fishtape/production.env, see
# README "Hosts where nginx runs in a container"): another web server on the box (Apache on the
# dotmoose VPS) owns :80/:443, terminates TLS and proxies the Fishtape names to a Fishtape-only
# nginx container on 127.0.0.1:8443 (host network). The same repo files are rendered for it: no
# port-80 server, `listen 443 ssl` -> `listen 127.0.0.1:8443`, no TLS/http2 lines, and
# X-Forwarded-Proto fixed to https (the front door only takes HTTPS). The rendered files go to
# NGINX_CONF_DIR (mounted read-only into NGINX_CONTAINER), are tested with `docker exec ... nginx -t`
# and reloaded only if that passes; otherwise the previous files are put back. --check compares the
# rendered files with the installed ones. --acme-bootstrap does not apply (the front door has the
# certificate).
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/lib/fishtape-production/nginx-backups/$STAMP"

# ---- container mode ----
# Render the repo's nginx files for a TLS-terminating front door on :443 that proxies to 8443.
render_container_site() { # src -> stdout
  awk '
    # Drop the top-level port-80 server (ACME + redirect): the front door owns :80.
    /^server \{/ { inblock = 1; buf = $0 "\n"; is80 = 0; next }
    inblock {
      buf = buf $0 "\n"
      if ($0 ~ /^[[:space:]]*listen 80;/) is80 = 1
      if ($0 ~ /^\}/) { inblock = 0; if (!is80) printf "%s", fix(buf); buf = "" }
      next
    }
    { printf "%s", fix($0 "\n") }
    function fix(s) {
      gsub(/listen 443 ssl;/, "listen 127.0.0.1:8443;", s)
      gsub(/[ \t]*listen \[::\]:443 ssl;\n/, "", s)
      gsub(/[ \t]*http2 on;\n/, "", s)
      gsub(/[ \t]*include \/etc\/nginx\/snippets\/fishtape-tls\.conf;\n/, "", s)
      gsub(/X-Forwarded-Proto \$scheme;/, "X-Forwarded-Proto https;", s)
      return s
    }
  ' "$1"
}
render_container_proxy() { sed 's/X-Forwarded-Proto \$scheme;/X-Forwarded-Proto https;/' "$1"; }

container_mode() { # [--check]
  local conf_dir="${NGINX_CONF_DIR:?NGINX_CONF_DIR is required in container mode}"
  local ctr="${NGINX_CONTAINER:?NGINX_CONTAINER is required in container mode}"
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  render_container_site "$HERE/nginx/fishtape.conf" > "$tmp/site"
  cp "$HERE/nginx/security-headers.conf" "$tmp/headers"
  cp "$HERE/nginx/deny.conf" "$tmp/deny"
  render_container_proxy "$HERE/nginx/proxy.conf" > "$tmp/proxy"
  # Sanity: the rendered site must still serve the app and must not try to do TLS itself.
  grep -q 'server_name app\.fishtapehq\.com' "$tmp/site" || { echo "rendered config has no app.fishtapehq.com server" >&2; exit 1; }
  if grep -qE 'listen[[:space:]]+(\[::\]:)?(80|443)\b|ssl_certificate|fishtape-tls' "$tmp/site"; then
    echo "rendered config still listens on 80/443 or does TLS" >&2; exit 1
  fi
  declare -A CF=(
    ["$tmp/site"]="$conf_dir/run-fishtape.conf"
    ["$tmp/headers"]="$conf_dir/run/snippets/fishtape-headers.conf"
    ["$tmp/deny"]="$conf_dir/run/snippets/fishtape-deny.conf"
    ["$tmp/proxy"]="$conf_dir/run/snippets/fishtape-proxy.conf"
  )
  if [ "${1:-}" = --check ]; then
    for src in "${!CF[@]}"; do cmp -s "$src" "${CF[$src]}" || exit 1; done
    exit 0
  fi
  command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
  docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null | grep -qx true || { echo "nginx container $ctr is not running" >&2; exit 1; }
  mkdir -p "$BACKUP_DIR" "$conf_dir/run/snippets"
  chmod 700 "$BACKUP_DIR"
  for src in "${!CF[@]}"; do dst="${CF[$src]}"; [ -f "$dst" ] && cp -p "$dst" "$BACKUP_DIR/$(basename "$dst")"; done
  docker exec "$ctr" nginx -T > "$BACKUP_DIR/nginx-T.before.txt" 2>/dev/null || true
  restore_c() {
    echo "restoring the previous files from $BACKUP_DIR" >&2
    for src in "${!CF[@]}"; do
      dst="${CF[$src]}"
      if [ -f "$BACKUP_DIR/$(basename "$dst")" ]; then cp -p "$BACKUP_DIR/$(basename "$dst")" "$dst"; else rm -f "$dst"; fi
    done
    docker exec "$ctr" nginx -t || true
  }
  for src in "${!CF[@]}"; do install -o root -g root -m 0644 "$src" "${CF[$src]}"; done
  if ! out="$(docker exec "$ctr" nginx -t 2>&1)"; then
    printf '%s\n' "$out" >&2; echo "nginx -t failed in $ctr" >&2; restore_c; exit 1
  fi
  printf '%s\n' "$out"
  if ! docker exec "$ctr" nginx -T 2>/dev/null | grep -qE 'server_name[[:space:]]+([^;]*[[:space:]])?app\.fishtapehq\.com'; then
    echo "nginx -t passed but $ctr does not load the Fishtape servers (is run-fishtape.conf mounted?)" >&2; restore_c; exit 1
  fi
  docker exec "$ctr" nginx -s reload
  echo "nginx config (container $ctr) installed and reloaded; previous copies in $BACKUP_DIR"
  exit 0
}

if [ "${NGINX_MODE:-host}" = container ]; then
  [ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
  case "${1:-}" in
    --check) container_mode --check ;;
    "") container_mode ;;
    --render) render_container_site "$HERE/nginx/fishtape.conf"; exit 0 ;;
    *) echo "${1} does not apply in container mode" >&2; exit 2 ;;
  esac
fi
AVAIL=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
SITE_LINK="$ENABLED/zz-fishtape-production.conf"
ACME_LINK="$ENABLED/zz-fishtape-acme.conf"
CERT=/etc/letsencrypt/live/fishtape/fullchain.pem

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v nginx >/dev/null || { echo "nginx not found" >&2; exit 1; }

MODE=full
CHECK=0
case "${1:-}" in
  --acme-bootstrap) MODE=acme ;;
  --check) CHECK=1 ;;
  "") ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
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

# --check: is every file installed exactly as in this checkout, and the site linked? update.sh
# installs whenever not, so a failed or skipped install is retried by the next deploy.
if [ "$CHECK" -eq 1 ]; then
  for src in "${!FILES[@]}"; do cmp -s "$src" "${FILES[$src]}" || exit 1; done
  [ "$(readlink "$LINK_DST" 2>/dev/null)" = "$LINK_SRC" ] || exit 1
  exit 0
fi

mkdir -p /etc/nginx/snippets "$AVAIL" "$ENABLED" /var/www/certbot "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
install -d -o root -g adm -m 0750 /var/log/fishtape-production
install -d -m 0755 /var/lib/fishtape-production
# media/ is private (job-site video, streamed by the API for signed URLs); nginx serves media/public only.
install -d -m 0711 /var/lib/fishtape-production/media
install -d -m 0755 /var/lib/fishtape-production/media/public

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
