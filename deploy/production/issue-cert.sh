#!/usr/bin/env bash
# Issue or expand the "fishtape" Let's Encrypt certificate for the Fishtape names that resolve
# to this box, by webroot (/var/www/certbot). Safe to run again: later, when hq. (or any other
# name) starts resolving here, it adds that name; when nothing is new it does nothing.
#
#   sudo ./issue-cert.sh --email you@example.com          first time (registers the ACME account if needed)
#   sudo ./issue-cert.sh                                  later runs: add names that now resolve here
#   sudo ./issue-cert.sh --dry-run                        against Let's Encrypt staging; changes nothing
#
# Options:
#   --email ADDR    ACME account email (needed only when certbot has no account on this box yet)
#   --ip ADDR       this box's public IPv4 (default: the source address of the default route)
#   --ipv6 ADDR     this box's public IPv6, if names have AAAA records pointing here
#   --dry-run       certbot --dry-run (Let's Encrypt staging), nothing saved
#   --allow-drop    let the new certificate leave out names the current one has
#   --force         run certbot even if every resolving name is already on the certificate
#
# Shared box: it only ever touches the lineage named "fishtape" (certonly --webroot, no nginx
# installer, no global hooks, no `certbot renew` of other sites). The nginx reload after renewals
# is stored in this certificate's own renewal config (--deploy-hook).
set -Eeuo pipefail

NAMES=(fishtapehq.com www.fishtapehq.com app.fishtapehq.com status.fishtapehq.com hq.fishtapehq.com)
REQUIRED=app.fishtapehq.com
CERT_NAME=fishtape
WEBROOT=/var/www/certbot
LIVE="/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"

EMAIL=""; IP4=""; IP6=""; DRY=0; ALLOW_DROP=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="${2:-}"; shift 2 ;;
    --ip) IP4="${2:-}"; shift 2 ;;
    --ipv6) IP6="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --allow-drop) ALLOW_DROP=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v certbot >/dev/null || { echo "certbot is not installed (apt install certbot)" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
[ -d "$WEBROOT" ] || { echo "$WEBROOT does not exist: run install-nginx.sh --acme-bootstrap first" >&2; exit 1; }

say() { printf '%s\n' "$*"; }

# ---- this box's public address ----
if [ -z "$IP4" ]; then
  IP4="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -1)"
fi
[[ "$IP4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not work out this box's public IPv4; pass --ip" >&2; exit 1; }
if [[ "$IP4" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.) ]]; then
  echo "$IP4 is a private address (NAT?); pass the public one with --ip" >&2; exit 1
fi
say "this box: $IP4${IP6:+ / $IP6}"

# Public DNS answers (what Let's Encrypt sees), not /etc/hosts.
lookup() { # name type
  if command -v dig >/dev/null; then
    dig +short +time=3 +tries=2 "$1" "$2" | grep -E '^[0-9a-fA-F:.]+$' | sort -u || true
  elif [ "$2" = A ]; then
    getent ahostsv4 "$1" | awk '{print $1}' | sort -u || true
  else
    getent ahostsv6 "$1" | awk '{print $1}' | grep ':' | sort -u || true
  fi
}

# ---- which names resolve here (every A record = this box; AAAA absent or = --ipv6) ----
WANT=()
for n in "${NAMES[@]}"; do
  a="$(lookup "$n" A | tr '\n' ' ')"
  aaaa="$(lookup "$n" AAAA | tr '\n' ' ')"
  if [ -z "${a// /}" ]; then say "  skip $n: no A record yet"; continue; fi
  if [ "${a% }" != "$IP4" ]; then say "  skip $n: A is ${a% }, not $IP4"; continue; fi
  if [ -n "${aaaa// /}" ] && [ "${aaaa% }" != "$IP6" ]; then
    say "  skip $n: AAAA ${aaaa% } does not point here (Let's Encrypt would try it first); remove it or pass --ipv6"
    continue
  fi
  # The challenge path must reach this nginx for the name (port 80, webroot).
  probe="fishtape-probe-$RANDOM$RANDOM"
  mkdir -p "$WEBROOT/.well-known/acme-challenge"
  printf '%s\n' "$probe" > "$WEBROOT/.well-known/acme-challenge/$probe"
  chmod 644 "$WEBROOT/.well-known/acme-challenge/$probe"
  got="$(curl -fsS -m 10 --resolve "$n:80:127.0.0.1" "http://$n/.well-known/acme-challenge/$probe" 2>/dev/null || true)"
  rm -f "$WEBROOT/.well-known/acme-challenge/$probe"
  if [ "$got" != "$probe" ]; then
    say "  skip $n: nginx here does not serve $WEBROOT for it on port 80 (install-nginx.sh --acme-bootstrap?)"
    continue
  fi
  say "  ok   $n"
  WANT+=("$n")
done

printf '%s\n' "${WANT[@]}" | grep -qx "$REQUIRED" || { echo "$REQUIRED must resolve here before a certificate is worth issuing" >&2; exit 1; }

# ---- compare with the current certificate ----
HAVE=()
if [ -s "$LIVE" ]; then
  mapfile -t HAVE < <(openssl x509 -in "$LIVE" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^, ]+' | cut -d: -f2 | sort -u)
  say "current certificate: ${HAVE[*]:-none} (expires $(openssl x509 -in "$LIVE" -noout -enddate | cut -d= -f2))"
fi
NEW=(); DROP=()
for n in "${WANT[@]}"; do printf '%s\n' "${HAVE[@]}" | grep -qx "$n" || NEW+=("$n"); done
for n in "${HAVE[@]}"; do printf '%s\n' "${WANT[@]}" | grep -qx "$n" || DROP+=("$n"); done
if [ "${#DROP[@]}" -gt 0 ] && [ "$ALLOW_DROP" -eq 0 ]; then
  # Keep names that are on the certificate but don't check out right now (a DNS blip must not
  # shrink the certificate). Let's Encrypt still validates every name, so a name that really
  # moved away makes certbot fail; then rerun with --allow-drop.
  say "keeping ${DROP[*]} (on the current certificate; --allow-drop removes them)"
  WANT+=("${DROP[@]}")
fi
if [ "${#NEW[@]}" -eq 0 ] && [ "$FORCE" -eq 0 ] && { [ "${#DROP[@]}" -eq 0 ] || [ "$ALLOW_DROP" -eq 0 ]; }; then
  say "nothing to add: every name that resolves here is already on the certificate"
  exit 0
fi

# ---- certbot (this lineage only) ----
args=(certonly --webroot -w "$WEBROOT" --cert-name "$CERT_NAME" --expand --non-interactive
      --agree-tos --no-eff-email --deploy-hook "nginx -t && systemctl reload nginx")
[ "$FORCE" -eq 1 ] && args+=(--force-renewal)
[ "$DRY" -eq 1 ] && args+=(--dry-run)
if [ -n "$EMAIL" ]; then
  args+=(--email "$EMAIL")
elif [ "$DRY" -eq 1 ]; then
  args+=(--register-unsafely-without-email)    # a throwaway account on Let's Encrypt staging
elif ! compgen -G "/etc/letsencrypt/accounts/*/directory/*" >/dev/null; then
  echo "certbot has no ACME account on this box yet: pass --email" >&2; exit 1
fi
for n in "${WANT[@]}"; do args+=(-d "$n"); done

say "certbot ${args[*]}"
certbot "${args[@]}"

if [ "$DRY" -eq 0 ] && [ -L /etc/nginx/sites-enabled/zz-fishtape-production.conf ]; then
  nginx -t && systemctl reload nginx
  say "nginx reloaded with the new certificate"
fi
say "done. Names on the certificate: $(openssl x509 -in "$LIVE" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^, ]+' | cut -d: -f2 | tr '\n' ' ')"
