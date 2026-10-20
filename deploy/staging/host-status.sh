#!/usr/bin/env bash
# Write host facts the API container can't see for itself to $STATE_DIR/status/host-status.json:
# disk use, TLS certificate expiry, load, memory, uptime, pending reboot and security updates,
# and `probes`: the HTTP status code of each public URL as the outside world sees it (0 = no
# answer within 5 s). /api/hq/health (the HQ developer health page) reads it through the
# read-only status mount; the worker's status job folds the probes into the public status page
# (a failing probe marks that component down for that run; docs/runbooks/status-page.md).
# Runs every 15 minutes from fishtape-<env>-host-status.timer. Contains no secrets.
#
# The environment (staging | production) is this script's folder name.
# deploy/production/host-status.sh is an identical copy; CI fails if they differ.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="$(basename "$HERE")"
STATE_DIR="/var/lib/fishtape-$ENV_NAME"
BACKUP_DIR="/var/backups/fishtape-$ENV_NAME"
OUT="$STATE_DIR/status/host-status.json"

# Only this environment's certificates: the staging box hosts other sites.
case "$ENV_NAME" in
  staging) CERTS="${CERTS:-/etc/letsencrypt/live/tgelectrical.truecollarbuilt.com/fullchain.pem}" ;;
  production) CERTS="${CERTS:-/etc/letsencrypt/live/fishtape/fullchain.pem}" ;;
  *) CERTS="${CERTS:-}" ;;
esac

jstr() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

# Disk: the filesystems holding /, Docker's data and the backups (deduplicated).
disks=""
seen=" "
for p in / /var/lib/docker "$BACKUP_DIR"; do
  [ -e "$p" ] || continue
  line="$(df -P -B1 "$p" | awk 'NR==2 {print $6, $2, $3, $5}')"
  read -r mnt size used pct <<< "$line"
  case "$seen" in *" $mnt "*) continue ;; esac
  seen="$seen$mnt "
  disks="$disks${disks:+,}{\"mount\":$(jstr "$mnt"),\"sizeBytes\":$size,\"usedBytes\":$used,\"usedPercent\":${pct%\%}}"
done

mkdir -p "$STATE_DIR/status"
certs=""
first_cert=1
for c in $CERTS; do
  [ -r "$c" ] || continue
  # The API's TLS_CERT_FILE: a copy of the public chain (never privkey.pem), refreshed here so
  # renewals show up without remounting anything.
  if [ "$first_cert" -eq 1 ]; then
    install -m 0644 "$c" "$STATE_DIR/status/tls-cert.pem.tmp" && mv -f "$STATE_DIR/status/tls-cert.pem.tmp" "$STATE_DIR/status/tls-cert.pem"
    first_cert=0
  fi
  end="$(openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2)" || continue
  end_epoch="$(date -d "$end" +%s)"
  days=$(( (end_epoch - $(date +%s)) / 86400 ))
  name="$(basename "$(dirname "$c")")"
  certs="$certs${certs:+,}{\"name\":$(jstr "$name"),\"notAfter\":$(jstr "$(date -u -d "@$end_epoch" +%Y-%m-%dT%H:%M:%SZ)"),\"daysLeft\":$days}"
done

read -r load1 load5 load15 _ < /proc/loadavg
mem_total=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
uptime_s=$(cut -d. -f1 /proc/uptime)
reboot=false
[ -f /var/run/reboot-required ] && reboot=true
security_updates=null
if [ -x /usr/lib/update-notifier/apt-check ]; then
  security_updates="$(/usr/lib/update-notifier/apt-check 2>&1 | cut -d';' -f2 || echo null)"
  [[ "$security_updates" =~ ^[0-9]+$ ]] || security_updates=null
fi

# Public URLs, as "<component>=<url>". app/api/hq are status-page components; site and status
# (the marketing site and the status page itself) are recorded for HQ only. Codes only, no bodies.
case "$ENV_NAME" in
  staging) PROBES="${PROBES:-app=https://tgelectrical.truecollarbuilt.com/ api=https://tgelectrical.truecollarbuilt.com/api/readyz site=https://tgelectrical.truecollarbuilt.com/site/index.html}" ;;
  production) PROBES="${PROBES:-app=https://app.fishtapehq.com/ api=https://app.fishtapehq.com/api/readyz hq=https://hq.fishtapehq.com/api/healthz site=https://fishtapehq.com/ status=https://status.fishtapehq.com/}" ;;
  *) PROBES="${PROBES:-}" ;;
esac
probes=""
for p in $PROBES; do
  id="${p%%=*}"
  url="${p#*=}"
  [[ "$id" =~ ^[a-z]{1,20}$ && "$url" =~ ^https:// ]] || continue
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  probes="$probes${probes:+,}\"$id\":$((10#$code))"
done

mkdir -p "$STATE_DIR/status"
tmp="$OUT.tmp"
printf '{"schema":1,"environment":%s,"generatedAt":%s,"host":%s,"disks":[%s],"certificates":[%s],"load":[%s,%s,%s],"cpus":%d,"memory":{"totalBytes":%d,"availableBytes":%d},"uptimeSeconds":%d,"rebootRequired":%s,"pendingSecurityUpdates":%s,"probes":{%s}}\n' \
  "$(jstr "$ENV_NAME")" "$(jstr "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(jstr "$(hostname -s)")" "$disks" "$certs" \
  "$load1" "$load5" "$load15" "$(nproc)" "$mem_total" "$mem_avail" "$uptime_s" "$reboot" "$security_updates" "$probes" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$OUT"
