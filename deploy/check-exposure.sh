#!/usr/bin/env bash
# What does a Fishtape deployment expose? Run after every deploy (the deploy workflows run it too).
#
#   deploy/check-exposure.sh https://tgelectrical.truecollarbuilt.com
#   deploy/check-exposure.sh https://app.fishtapehq.com --production
#   deploy/check-exposure.sh https://hq.fishtapehq.com --hq
#
# Fails (exit 1) when:
#   - any sensitive path (.env, .git, deploy scripts, dumps, keys, repo docs, traversal variants...)
#     answers 2xx, or any probe's body looks like a secret (env lines, private keys, git config,
#     pg_dump or age headers, credentials in a postgres:// URL)
#   - an unknown path answers 2xx (the app uses a hash router; there is no SPA fallback)
#   - a required header is missing (HSTS, CSP with the key directives, nosniff, Referrer-Policy,
#     Permissions-Policy, X-Frame-Options), or a version banner / X-Powered-By is present
#   - /api/ responses lack Cache-Control: no-store, or API answers leak secrets, internal
#     addresses or stack traces, or HQ endpoints answer without auth
#
# Options:
#   --production        also require /api/hq/, /hq/ and the API docs UI to be 404 (app host)
#   --hq                HQ host: skip the PWA checks, require X-Robots-Tag noindex
#   --no-api            skip API checks (staging before server/ exists)
#   --resolve H:P:ADDR  passed to curl, e.g. run on the box itself:
#                       --resolve tgelectrical.truecollarbuilt.com:443:127.0.0.1
set -uo pipefail

BASE="${1:-}"
[[ "$BASE" =~ ^https?://[^/]+$ ]] || { echo "usage: $0 https://host [--production|--hq] [--no-api] [--resolve host:port:addr]" >&2; exit 2; }
shift
MODE=app
API=1
CURL_EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --production) MODE=production; shift ;;
    --hq) MODE=hq; shift ;;
    --no-api) API=0; shift ;;
    --resolve) CURL_EXTRA+=(--resolve "${2:-}"); shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; WARN=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
note() { WARN=$((WARN + 1)); printf 'WARN  %s\n' "$*"; }
# check <pass message> <fail message> <command...>
check() {
  local yes="$1" no="$2"
  shift 2
  if "$@"; then ok "$yes"; else bad "$no"; fi
}

# fetch <path> [extra curl args...]  -> sets CODE, writes $TMP/h (headers) and $TMP/b (body, max 2 MB)
fetch() {
  local path="$1"; shift
  CODE="$(curl -sS --path-as-is -m 20 --max-filesize 2000000 "${CURL_EXTRA[@]}" "$@" \
    -D "$TMP/h" -o "$TMP/b" -w '%{http_code}' "$BASE$path" 2>/dev/null)" || CODE="${CODE:-000}"
  [ -f "$TMP/h" ] || : > "$TMP/h"
  [ -f "$TMP/b" ] || : > "$TMP/b"
}
hdr() { grep -i "^$1:" "$TMP/h" | tail -1 | cut -d: -f2- | sed 's/^ *//; s/\r$//'; }
SECRET_RE='(^|[^A-Z_])(DATABASE_URL|MIGRATE_DATABASE_URL|HQ_DATABASE_URL|SECRETS_MASTER_KEY|POSTGRES_PASSWORD|[A-Z_]*_PASSWORD|[A-Z_]*_SECRET|GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_SECRET)[[:space:]]*=|-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-1|age-encryption\.org/v1|^PGDMP|\[core\]|repositoryformatversion|^ref: refs/|postgres(ql)?://[^:/[:space:]]+:[^@[:space:]]+@'
looks_secret() { grep -aqE "$SECRET_RE" "$TMP/b"; }

echo "== $BASE ($MODE$([ "$API" -eq 0 ] && printf ', no API'))"

# ---- 1. sensitive paths ----
SENSITIVE=(
  /.env /.env.local /.env.production /.env.staging /.env.example /.env.bak /.env.save /env
  /.git/HEAD /.git/config /.gitignore /.github/workflows/ci.yml /.dockerignore /.gitleaks.toml /.DS_Store /.htpasswd
  /deploy/staging/.env /deploy/production/.env /deploy/staging/docker-compose.yml /deploy/staging/update.sh
  /deploy/staging/backup.conf /deploy/staging/backup-recipients.txt /deploy/check-exposure.sh
  /server/.env /server/package.json /server/db/bootstrap.sql /server/Dockerfile /server/src/index.js
  /docs/BUILD-PLAN.md /compliance/controls.yaml /README.md /SECURITY.md /CLAUDE.md /kelbe-project-tracker.php
  /package.json /package-lock.json /docker-compose.yml /Dockerfile /Makefile
  /backup.sql /dump.sql /db.sql /fishtape.sql /fishtape.dump /fishtape.sql.gz /backup.zip /backup.tar.gz /latest.dump.age
  /id_rsa /id_ed25519 /server.key /privkey.pem /fullchain.pem
  /wp-config.php /config.php /phpinfo.php /server-status
  /tests/units.test.mjs /js/app.js.map /electrical-app/index.html
  /%2e%2e/.env /..%2f.env /%2e%2e%2fdeploy/staging/.env /js/../../deploy/staging/.env /js/..%2f..%2fdeploy/staging/.env
  /hq/../.env /hq/../deploy/staging/.env /hq/..%2f..%2fdeploy/staging/.env /api/../.env /vendor/../.env /.well-known/../.env
  /index.html.bak /index.html~ /sw.js.bak
)
exposed=0
for p in "${SENSITIVE[@]}"; do
  fetch "$p"
  if [[ "$CODE" == 2* ]]; then bad "$p answered $CODE (must not be served)"; exposed=1
  elif looks_secret; then bad "$p answered $CODE with secret-looking content"; exposed=1
  fi
done
[ "$exposed" -eq 0 ] && ok "${#SENSITIVE[@]} sensitive paths: none served, no secret-looking content"

fetch "/this-path-does-not-exist-$RANDOM"
if [[ "$CODE" == 2* ]]; then bad "unknown path answered $CODE (SPA fallback still on?)"; else ok "unknown path -> $CODE"; fi
fetch "/js/"
if [[ "$CODE" == 2* ]] && grep -qi '<title>Index of' "$TMP/b"; then bad "directory listing at /js/"; else ok "no directory listing (/js/ -> $CODE)"; fi

# ---- 2. headers on the main page ----
fetch /
if [ "$MODE" = hq ] && [ "$CODE" != 200 ]; then
  note "/ answered $CODE on the HQ host (console not deployed yet?); header checks use it anyway"
elif [ "$CODE" != 200 ]; then
  bad "/ answered $CODE"
fi
hsts="$(hdr strict-transport-security)"
if [[ "$BASE" == https://* ]]; then
  if [[ "$hsts" =~ max-age=([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -ge 15552000 ]; then ok "HSTS: $hsts"; else bad "HSTS missing or under 180 days: '${hsts}'"; fi
fi
csp="$(hdr content-security-policy)"
if [ -z "$csp" ]; then bad "Content-Security-Policy missing"
else
  missing=""
  for d in "default-src 'self'" "object-src 'none'" "frame-ancestors" "base-uri" "form-action"; do
    [[ "$csp" == *"$d"* ]] || missing="$missing [$d]"
  done
  [[ "$csp" == *"'unsafe-eval'"* ]] && missing="$missing ['unsafe-eval' present]"
  script_src="$(printf '%s' "$csp" | tr ';' '\n' | grep -E '^[[:space:]]*script-src[[:space:]]' || true)"
  [[ "$script_src" == *"'unsafe-inline'"* ]] && missing="$missing [script-src 'unsafe-inline' present]"
  if [ -z "$missing" ]; then ok "CSP present with the key directives"; else bad "CSP problems:$missing"; fi
  # The live CSP must be the one in the repo: header files only change on the server when
  # install-nginx.sh runs, so a deploy can ship code that needs a CSP the server doesn't send yet.
  repo_headers="$(dirname "${BASH_SOURCE[0]}")/staging/security-headers.conf"
  if [ -f "$repo_headers" ]; then
    want="$(sed -n 's/^add_header Content-Security-Policy "\(.*\)" always;$/\1/p' "$repo_headers")"
    if [ "$csp" = "$want" ]; then ok "live CSP matches the repo"
    else bad "live CSP differs from deploy/*/security-headers.conf: run install-nginx.sh on the server"; fi
  fi
fi
check "X-Content-Type-Options: nosniff" "X-Content-Type-Options: nosniff missing" [ "$(hdr x-content-type-options | tr '[:upper:]' '[:lower:]')" = nosniff ]
check "Referrer-Policy: $(hdr referrer-policy)" "Referrer-Policy missing" [ -n "$(hdr referrer-policy)" ]
check "Permissions-Policy present" "Permissions-Policy missing" [ -n "$(hdr permissions-policy)" ]
check "X-Frame-Options: $(hdr x-frame-options)" "X-Frame-Options missing" [ -n "$(hdr x-frame-options)" ]
server="$(hdr server)"
if [[ "$server" =~ [0-9] ]]; then bad "Server header shows a version: $server (server_tokens off)"; else ok "Server header without version: '${server}'"; fi
check "no X-Powered-By" "X-Powered-By present: $(hdr x-powered-by)" [ -z "$(hdr x-powered-by)" ]
if [ "$MODE" = hq ]; then
  check "X-Robots-Tag noindex" "X-Robots-Tag noindex missing on HQ" grep -qi '^x-robots-tag:.*noindex' "$TMP/h"
fi

# ---- 3. PWA files and caching ----
if [ "$MODE" != hq ]; then
  check "/ is revalidated (Cache-Control: $(hdr cache-control))" "/ should be Cache-Control: no-cache, got '$(hdr cache-control)'" grep -qi '^cache-control:.*no-cache' "$TMP/h"
  fetch /sw.js
  if [ "$CODE" = 200 ] && [[ "$(hdr cache-control)" == *no-cache* ]] && [ -n "$(hdr content-security-policy)" ]; then
    ok "/sw.js 200, no-cache, CSP"
  else
    bad "/sw.js: status $CODE, Cache-Control '$(hdr cache-control)', CSP $([ -n "$(hdr content-security-policy)" ] && echo present || echo missing)"
  fi
  fetch /manifest.webmanifest
  check "/manifest.webmanifest 200" "/manifest.webmanifest answered $CODE" [ "$CODE" = 200 ]
  fetch /.well-known/security.txt
  if [ "$CODE" = 200 ] && grep -q '^Contact:' "$TMP/b"; then
    exp="$(grep '^Expires:' "$TMP/b" | cut -d' ' -f2)"
    if [ -n "$exp" ] && [ "$(date -u -d "$exp" +%s 2>/dev/null || echo 0)" -lt "$(( $(date +%s) + 30 * 86400 ))" ]; then
      note "security.txt Expires $exp is within 30 days: renew it in the nginx config"
    else
      ok "security.txt (expires ${exp:-?})"
    fi
  else
    bad "/.well-known/security.txt answered $CODE or has no Contact"
  fi
fi

# ---- 4. HTTP -> HTTPS ----
if [[ "$BASE" == https://* ]]; then
  host="${BASE#https://}"
  loc="$(curl -sS -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/" 2>/dev/null || true)"
  if [[ "$loc" =~ ^30[178]\ https:// ]]; then ok "http:// redirects to https:// ($loc)"; else note "http:// did not redirect to https:// ('$loc'); fine if run against a local --resolve"; fi
fi

# ---- 5. API ----
if [ "$API" -eq 1 ]; then
  api_leak() { grep -aqiE "$SECRET_RE|\"(password|secret|token|apiKey|privateKey)\"[[:space:]]*:|\"stack\"[[:space:]]*:|node_modules/|/app/server/|[[:space:]]at [A-Za-z_.<>]+ \(|\b(10\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]+\.[0-9]+\b" "$TMP/b"; }
  for p in /api/healthz /api/v1/status; do
    fetch "$p"
    if [ "$CODE" != 200 ]; then bad "$p answered $CODE"; continue; fi
    problems=""
    [[ "$(hdr cache-control)" == *no-store* ]] || problems="$problems [Cache-Control '$(hdr cache-control)', want no-store]"
    [ "$(hdr x-content-type-options | tr '[:upper:]' '[:lower:]')" = nosniff ] || problems="$problems [no nosniff]"
    [[ "$BASE" != https://* || -n "$(hdr strict-transport-security)" ]] || problems="$problems [no HSTS]"
    [ -z "$(hdr x-powered-by)" ] || problems="$problems [X-Powered-By]"
    api_leak && problems="$problems [body leaks secrets, internal addresses or a stack trace]"
    if [ -z "$problems" ]; then ok "$p 200, no-store, nothing sensitive in the body"; else bad "$p:$problems"; fi
  done
  fetch "/api/v1/no-such-route-$RANDOM"
  if [[ "$CODE" == 2* ]]; then bad "unknown API route answered $CODE"
  elif api_leak; then bad "unknown API route error body leaks a stack trace or internals"
  else ok "unknown API route -> $CODE without internals"; fi
  fetch "/api/v1/clients"
  if [[ "$CODE" == 2* ]]; then bad "/api/v1/clients answered $CODE without credentials"; else ok "/api/v1/clients without credentials -> $CODE"; fi
  fetch "/api/hq/health"
  if [[ "$CODE" == 2* ]]; then bad "/api/hq/health answered $CODE without credentials"; else ok "/api/hq/health without credentials -> $CODE"; fi
fi
if [ "$MODE" = production ]; then
  for p in /api/hq/health /api/hq/tenants /hq/ /api/docs /api/documentation; do
    fetch "$p"
    check "$p is 404 on the app host" "$p answered $CODE on the app host (want 404)" [ "$CODE" = 404 ]
  done
fi

echo
echo "summary: $PASS pass, $WARN warn, $FAIL fail"
[ "$FAIL" -eq 0 ]
