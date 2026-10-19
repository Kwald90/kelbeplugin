#!/usr/bin/env bash
# Write host facts the API container can't see for itself to $STATE_DIR/status/host-status.json:
# disk use, TLS certificate expiry, load, memory, uptime, pending reboot and security updates.
# /api/hq/health (the HQ developer health page) reads it through the read-only status mount.
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

certs=""
for c in $CERTS; do
  [ -r "$c" ] || continue
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

mkdir -p "$STATE_DIR/status"
tmp="$OUT.tmp"
printf '{"schema":1,"environment":%s,"generatedAt":%s,"host":%s,"disks":[%s],"certificates":[%s],"load":[%s,%s,%s],"cpus":%d,"memory":{"totalBytes":%d,"availableBytes":%d},"uptimeSeconds":%d,"rebootRequired":%s,"pendingSecurityUpdates":%s}\n' \
  "$(jstr "$ENV_NAME")" "$(jstr "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(jstr "$(hostname -s)")" "$disks" "$certs" \
  "$load1" "$load5" "$load15" "$(nproc)" "$mem_total" "$mem_avail" "$uptime_s" "$reboot" "$security_updates" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$OUT"
