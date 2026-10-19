#!/usr/bin/env bash
# Read-only audit of the production host against README.md "Host prerequisites".
# Changes nothing. Prints PASS / WARN / FAIL per check; exits 1 if anything FAILs.
#
#   sudo ./check-host.sh                       human-readable
#   sudo ./check-host.sh --json out.json       also write the results as JSON (evidence, CC6/CC7)
#
# Run it before the first deploy, after any host change, and quarterly with the access review.
set -uo pipefail

JSON_OUT=""
[ "${1:-}" = "--json" ] && JSON_OUT="${2:-}"
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo): some checks read root-only files" >&2; exit 1; }

PASS=0; WARN=0; FAIL=0
RESULTS=()
jesc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; printf '%s' "$s"; }
res() { # level id detail
  case "$1" in PASS) PASS=$((PASS + 1)) ;; WARN) WARN=$((WARN + 1)) ;; FAIL) FAIL=$((FAIL + 1)) ;; esac
  printf '%-5s %-28s %s\n' "$1" "$2" "$3"
  RESULTS+=("{\"level\":\"$1\",\"id\":\"$2\",\"detail\":\"$(jesc "$3")\"}")
}
have() { command -v "$1" >/dev/null 2>&1; }
# check <level-if-false> <id> <message-if-true> <message-if-false> <command...>
check() {
  local level="$1" id="$2" yes="$3" no="$4"
  shift 4
  if "$@"; then res PASS "$id" "$yes"; else res "$level" "$id" "$no"; fi
}

# ---- operating system ----
# shellcheck source=/dev/null
. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" = ubuntu ] && [[ "${VERSION:-}" == *LTS* ]]; then
  res PASS os "$PRETTY_NAME"
else
  res WARN os "${PRETTY_NAME:-unknown}: the runbooks assume Ubuntu LTS"
fi
if [ -f /var/run/reboot-required ]; then res WARN reboot "reboot required for updates"; else res PASS reboot "no reboot pending"; fi

# ---- SSH ----
if have sshd; then
  SSHD="$(sshd -T 2>/dev/null)"
  get() { awk -v k="$1" '$1 == k {print $2; exit}' <<< "$SSHD"; }
  check FAIL ssh-passwords "password logins off" "PasswordAuthentication is $(get passwordauthentication)" [ "$(get passwordauthentication)" = no ]
  check FAIL ssh-kbd-interactive "keyboard-interactive off" "KbdInteractiveAuthentication is $(get kbdinteractiveauthentication)" [ "$(get kbdinteractiveauthentication)" = no ]
  case "$(get permitrootlogin)" in
    no) res PASS ssh-root "root login off" ;;
    prohibit-password|without-password) res WARN ssh-root "root may log in with a key; prefer PermitRootLogin no" ;;
    *) res FAIL ssh-root "PermitRootLogin is $(get permitrootlogin)" ;;
  esac
  check WARN ssh-x11 "X11 forwarding off" "X11Forwarding is on" [ "$(get x11forwarding)" = no ]
  mat="$(get maxauthtries)"
  check WARN ssh-maxauthtries "MaxAuthTries $mat" "MaxAuthTries ${mat:-6}; 3 or 4 is better" [ "${mat:-6}" -le 4 ]
else
  res FAIL ssh "sshd not found"
fi

# ---- firewall ----
if have ufw && ufw status | grep -q "Status: active"; then
  extra="$(ufw status | awk 'NR>4 && $2 ~ /ALLOW/ {print $1}' | sed 's#/.*##; s/ (v6)//' | sort -u | grep -vxE '22|80|443|OpenSSH|Nginx Full|Nginx HTTP|Nginx HTTPS' | tr '\n' ' ')"
  if [ -z "$extra" ]; then res PASS firewall "ufw active; only 22/80/443 allowed"; else res WARN firewall "ufw allows more than 22/80/443: $extra"; fi
else
  res FAIL firewall "ufw is not active"
fi

# Public listeners other than SSH/HTTP(S). Docker-published ports bypass ufw, so check them too.
public="$(ss -H -tlnp 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]|::1)(:|\]:)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vxE '22|80|443' | tr '\n' ' ')"
if [ -z "$public" ]; then res PASS listeners "only 22/80/443 listen publicly"; else res FAIL listeners "other public listeners: $public"; fi
if have docker; then
  dpub="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:|:::' || true)"
  if [ -z "$dpub" ]; then res PASS docker-ports "containers publish on 127.0.0.1 only"; else res FAIL docker-ports "published on all interfaces (bypasses ufw): $dpub"; fi
fi

# ---- intrusion prevention and patching ----
if systemctl is-active --quiet fail2ban; then
  if fail2ban-client status sshd >/dev/null 2>&1; then res PASS fail2ban "active with the sshd jail"; else res WARN fail2ban "active, but no sshd jail"; fi
else
  res FAIL fail2ban "fail2ban is not running"
fi
if grep -qs 'APT::Periodic::Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/*; then
  res PASS unattended-upgrades "enabled"
else
  res FAIL unattended-upgrades "not enabled (dpkg-reconfigure -plow unattended-upgrades)"
fi
if [ -x /usr/lib/update-notifier/apt-check ]; then
  sec="$(/usr/lib/update-notifier/apt-check 2>&1 | cut -d';' -f2)"
  if [ "${sec:-0}" = 0 ]; then res PASS security-updates "none pending"; else res WARN security-updates "$sec security updates pending"; fi
fi

# ---- time ----
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then res PASS time-sync "clock synchronised"; else res FAIL time-sync "clock not NTP-synchronised"; fi

# ---- storage ----
if lsblk -rno TYPE 2>/dev/null | grep -qx crypt; then
  res PASS disk-encryption "a dm-crypt volume is present"
else
  res WARN disk-encryption "no encrypted volume found; record the provider's at-rest encryption in docs/compliance/encryption.md"
fi
for p in / /var/lib/docker /var/backups; do
  [ -e "$p" ] || continue
  used="$(df -P "$p" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ "$used" -lt 70 ]; then res PASS "disk:$p" "${used}% used"; elif [ "$used" -lt 85 ]; then res WARN "disk:$p" "${used}% used"; else res FAIL "disk:$p" "${used}% used"; fi
done

# ---- software ----
if have docker && docker compose version >/dev/null 2>&1; then res PASS docker "$(docker --version | cut -d, -f1); compose $(docker compose version --short)"; else res FAIL docker "docker or the compose plugin is missing"; fi
if have nginx; then
  if nginx -t >/dev/null 2>&1; then res PASS nginx "$(nginx -v 2>&1 | cut -d/ -f2), config ok"; else res FAIL nginx "nginx -t fails"; fi
else
  res FAIL nginx "nginx not installed"
fi
if systemctl list-timers --all 2>/dev/null | grep -qE 'certbot|snap\.certbot'; then res PASS certbot "renewal timer present"; else res FAIL certbot "no certbot renewal timer"; fi
check FAIL age "age $(age --version 2>/dev/null)" "age not installed (backups need it)" have age

# ---- Fishtape ----
if systemctl is-enabled --quiet fishtape-production-backup.timer 2>/dev/null; then res PASS backup-timer "enabled"; else res FAIL backup-timer "fishtape-production-backup.timer not enabled"; fi
LB=/var/lib/fishtape-production/status/last-backup.json
if [ -f "$LB" ]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$LB")) / 3600 ))
  if grep -q '"status":"ok"' "$LB" && [ "$age_h" -le 26 ]; then res PASS last-backup "ok, ${age_h}h ago"; else res FAIL last-backup "not ok or older than 26h ($(grep -o '"status":"[a-z]*"' "$LB"), ${age_h}h)"; fi
else
  res WARN last-backup "no backup has run yet"
fi
ENVF=/srv/fishtape/repo/deploy/production/.env
if [ -f "$ENVF" ]; then
  perm="$(stat -c '%U %a' "$ENVF")"
  check FAIL env-file "root 600" "$ENVF is $perm (want root 600)" [ "$perm" = "root 600" ]
fi

# ---- accounts ----
uid0="$(awk -F: '$3 == 0 && $1 != "root" {print $1}' /etc/passwd | tr '\n' ' ')"
check FAIL uid0 "only root has uid 0" "extra uid-0 accounts: $uid0" [ -z "$uid0" ]
shells="$(awk -F: '$7 !~ /(nologin|false|sync|halt|shutdown)$/ {print $1}' /etc/passwd | tr '\n' ' ')"
res PASS login-accounts "accounts with a login shell: $shells(review in the quarterly access review)"

res WARN data-residency "confirm with the host where the data centre is (Canada preferred) and record it in docs/compliance/vendor-management.md"

echo
echo "summary: $PASS pass, $WARN warn, $FAIL fail"
if [ -n "$JSON_OUT" ]; then
  { printf '{"ts":"%s","host":"%s","pass":%d,"warn":%d,"fail":%d,"results":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -s)" "$PASS" "$WARN" "$FAIL"
    (IFS=,; printf '%s' "${RESULTS[*]}")
    printf ']}\n'; } > "$JSON_OUT"
  echo "wrote $JSON_OUT"
fi
[ "$FAIL" -eq 0 ]
