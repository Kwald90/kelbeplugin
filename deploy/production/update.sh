#!/usr/bin/env bash
# Deploy a release tag to production (the shared CloudPanel box; README.md).
#
#   sudo /srv/fishtape/repo/deploy/production/update.sh --tag v1.4.0 [--sha <commit>] [--actor <name>]
#
# 1. fetch, and check the tag: vX.Y.Z format, on the release branch, pointing at --sha when
#    given (CI passes the commit it tested, so a moved tag is refused)
# 2. build the server image tagged with the commit SHA
# 3. encrypted pre-deploy backup (required; --skip-backup only in an emergency, and it is logged)
# 4. migrations, then switch api/worker and wait for /api/readyz
# 5. publish the static app, HQ console and public site (electrical-app/, hq/, site/) as
#    /srv/fishtape/www/releases/<sha>, flip the `current` symlink atomically, and check
#    app.fishtapehq.com through nginx (a failure here rolls back)
# 6. install the nginx files when the installed ones differ from the release's, check the apex,
#    status. and hq. through nginx, then run deploy/check-exposure.sh on each: warnings only (the
#    API and the app are already live and fine; a failed nginx install is one too). hq. is skipped
#    with a warning while it doesn't resolve or isn't on the certificate yet.
# Any failure in 1-5 rolls back the containers and the symlink. Every run appends one JSON line to
# /var/lib/fishtape-production/deploy-log.jsonl. Migrations are not rolled back: they must be
# expand/contract (docs/compliance/change-management.md). There is no seed in production.
set -Eeuo pipefail
trap '' HUP
umask 022

ENV_NAME=production
REPO_DIR="${REPO_DIR:-/srv/fishtape/repo}"
WWW_DIR="${WWW_DIR:-/srv/fishtape/www}"
RELEASE_BRANCH="${RELEASE_BRANCH:-claude/electrical-concept-app-h4qz12}"
APP_HOST="${APP_HOST:-app.fishtapehq.com}"
APEX_HOST="${APEX_HOST:-fishtapehq.com}"
STATUS_HOST="${STATUS_HOST:-status.fishtapehq.com}"
HQ_HOST="${HQ_HOST:-hq.fishtapehq.com}"
CERT_FILE="${CERT_FILE:-/etc/letsencrypt/live/fishtape/fullchain.pem}"
HERE="$REPO_DIR/deploy/production"
STATE_DIR="/var/lib/fishtape-$ENV_NAME"
DEPLOY_LOG="$STATE_DIR/deploy-log.jsonl"
# Production's host ports on the shared box (staging owns 3410/3411).
API="http://127.0.0.1:3420"
HQ_API="http://127.0.0.1:3421"
IMAGE_REPO=fishtape.invalid/server
READY_TIMEOUT="${READY_TIMEOUT:-150}"
KEEP_IMAGES="${KEEP_IMAGES:-5}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
REQUIRE_SIGNED_TAGS="${REQUIRE_SIGNED_TAGS:-0}"

TAG=""
SHA=""
FORCE=0
SKIP_BACKUP=0
ACTOR="${SUDO_USER:-$(id -un)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --actor) ACTOR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "--tag vX.Y.Z is required" >&2; exit 2; }
[[ -z "$SHA" || "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "--sha must be a full 40-character commit SHA" >&2; exit 2; }
[[ "$ACTOR" =~ ^[A-Za-z0-9:._@/-]{1,80}$ ]] || { echo "--actor has unexpected characters" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

mkdir -p "$STATE_DIR/status" "$WWW_DIR/releases"
# Hero videos and posters: uploaded by hq-api (uid 1000), served read-only by nginx.
install -d -o 1000 -g 1000 -m 755 "$STATE_DIR/media"
# HQ Mail files: only the containers' user (uid 1000) may read them.
install -d -o 1000 -g 1000 -m 700 "$STATE_DIR/mail"
# Restore tests and offsite drill results (RESTORE_TESTS_FILE): hq-api appends uploaded drills,
# restore-test.sh appends local tests, the worker reads them for the hourly backup alerts.
install -d -o 1000 -g 1000 -m 700 "$STATE_DIR/drills"
chmod 755 "$STATE_DIR" "$STATE_DIR/status" "$WWW_DIR" "$WWW_DIR/releases"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

git_() { git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" "$@"; }
dc() { docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" "$@"; }
say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
jesc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\r'/ }; s=${s//$'\t'/ }; printf '%s' "$s"; }

START="$(date +%s)"
PREV_SHA="$(git_ rev-parse HEAD)"
PREV_TAG="$(cat "$STATE_DIR/current-image" 2>/dev/null || true)"
PREV_RELEASE="$(readlink "$WWW_DIR/current" 2>/dev/null || true)"
TARGET=""
SWITCHED=0
STATIC_SWITCHED=0

record() { # result message
  local now line
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  line=$(printf '{"ts":"%s","environment":"%s","result":"%s","tag":"%s","from":"%s","fromImage":"%s","to":"%s","actor":"%s","durationSeconds":%d,"host":"%s","message":"%s"}' \
    "$now" "$ENV_NAME" "$1" "$TAG" "$PREV_SHA" "$PREV_TAG" "$TARGET" "$(jesc "$ACTOR")" "$(( $(date +%s) - START ))" \
    "$(hostname -s)" "$(jesc "$2")")
  printf '%s\n' "$line" >> "$DEPLOY_LOG"
  chmod 644 "$DEPLOY_LOG"
  printf '%s\n' "$line" > "$STATE_DIR/status/last-deploy.json.tmp"
  chmod 644 "$STATE_DIR/status/last-deploy.json.tmp"
  mv -f "$STATE_DIR/status/last-deploy.json.tmp" "$STATE_DIR/status/last-deploy.json"
  # The last 50 deploys, for the HQ "recent deploys" list (DEPLOY_LOG_FILE in the containers).
  tail -n 50 "$DEPLOY_LOG" > "$STATE_DIR/status/recent-deploys.jsonl.tmp"
  chmod 644 "$STATE_DIR/status/recent-deploys.jsonl.tmp"
  mv -f "$STATE_DIR/status/recent-deploys.jsonl.tmp" "$STATE_DIR/status/recent-deploys.jsonl"
}

image_exists() { docker image inspect "$IMAGE_REPO:$1" >/dev/null 2>&1; }

wait_ready() { # seconds
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 5 -o /dev/null "$API/api/readyz" && curl -fsS -m 5 -o /dev/null "$HQ_API/api/readyz"; then return 0; fi
    sleep 3
  done
  return 1
}

flip_current() { # release-relative-path
  ln -sfn "$1" "$WWW_DIR/current.next"
  mv -Tf "$WWW_DIR/current.next" "$WWW_DIR/current"
}

fail() { # message
  trap - ERR
  local msg="$1" result=failed
  say "FAILED: $msg"
  if [ "$STATIC_SWITCHED" -eq 1 ] && [ -n "$PREV_RELEASE" ]; then
    say "pointing the web root back at $PREV_RELEASE"
    flip_current "$PREV_RELEASE" || true
  fi
  if [ "$SWITCHED" -eq 1 ]; then
    if [ -n "$PREV_TAG" ] && image_exists "$PREV_TAG"; then
      say "rolling containers back to ${PREV_TAG:0:12}"
      IMAGE_TAG="$PREV_TAG" dc up -d --no-build api hq-api worker || true
      if wait_ready 90; then
        result=rolled_back
      else
        result=rollback_failed
        msg="$msg; the previous release did not become ready either"
      fi
    else
      dc stop api hq-api worker || true
      msg="$msg; no previous image, api stopped"
    fi
  fi
  git_ checkout -q --force --detach "$PREV_SHA" || true
  record "$result" "$msg"
  if [ "$result" = rolled_back ]; then say "rolled back to ${PREV_TAG:0:12}"; else say "see docs/runbooks/rollback.md"; fi
  exit 1
}
trap 'fail "unexpected error at line $LINENO: $BASH_COMMAND"' ERR

# ---- 1. resolve and check the tag ----
say "fetching $TAG and origin/$RELEASE_BRANCH"
git_ fetch -q --force origin "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH" "+refs/tags/$TAG:refs/tags/$TAG" \
  || fail "git fetch failed (does tag $TAG exist on GitHub?)"
TARGET="$(git_ rev-parse -q --verify "refs/tags/$TAG^{commit}")" || fail "tag $TAG not found"
if [ -n "$SHA" ] && [ "$SHA" != "$TARGET" ]; then fail "tag $TAG points at $TARGET, not the tested commit $SHA"; fi
git_ merge-base --is-ancestor "$TARGET" "origin/$RELEASE_BRANCH" || fail "$TAG is not on $RELEASE_BRANCH"
# Server-only files (secrets and root-sourced config) must never come from git.
TRACKED_LOCAL="$(git_ ls-tree -r --name-only "$TARGET" -- deploy/production/.env deploy/production/backup.conf deploy/production/backup-recipients.txt | tr '\n' ' ')"
[ -z "$TRACKED_LOCAL" ] || fail "$TAG tracks server-only files ($TRACKED_LOCAL); refusing to check it out"
if [ "$REQUIRE_SIGNED_TAGS" = 1 ]; then git_ verify-tag "$TAG" >/dev/null 2>&1 || fail "tag $TAG has no valid signature"; fi
git_ cat-file -e "$TARGET:server/package.json" 2>/dev/null || fail "$TAG has no server/; production needs the API"

if [ "$FORCE" -eq 0 ] && [ "$PREV_TAG" = "$TARGET" ]; then
  say "already running $TAG (${TARGET:0:12}); --force redeploys"
  record noop "already deployed"
  exit 0
fi

# ---- 2. check out and build ----
say "checking out $TAG (${TARGET:0:12})"
git_ checkout -q --force --detach "$TARGET"
chown -R root:root "$REPO_DIR"
chmod -R go-w "$REPO_DIR"
[ -f "$HERE/.env" ] || fail ".env is missing: run deploy/production/init-env.sh (README)"
chown root:root "$HERE/.env"
chmod 600 "$HERE/.env"
if [ -f "$HERE/backup.conf" ]; then chown root:root "$HERE/backup.conf"; chmod 600 "$HERE/backup.conf"; fi

say "building $IMAGE_REPO:${TARGET:0:12}"
IMAGE_TAG="$TARGET" dc build api || fail "image build failed"

# ---- 3. database, backup, migrations ----
IMAGE_TAG="$TARGET" dc up -d --no-build --wait --wait-timeout 120 postgres || fail "postgres did not become healthy"
if [ "$SKIP_BACKUP" -eq 1 ]; then
  say "WARNING: pre-deploy backup skipped on request"
  ACTOR="$ACTOR(skip-backup)"
else
  "$HERE/backup.sh" --kind predeploy || fail "pre-deploy backup failed; nothing was changed"
fi
say "running migrations"
IMAGE_TAG="$TARGET" dc run --rm --no-deps migrate || fail "migrations failed"

# ---- 4. switch the API ----
SWITCHED=1
say "starting api, hq-api and worker"
IMAGE_TAG="$TARGET" dc up -d --no-build --remove-orphans api hq-api worker || fail "containers did not start"
wait_ready "$READY_TIMEOUT" || fail "/api/readyz not ready within ${READY_TIMEOUT}s"
STATUS="$(curl -fsS -m 5 "$API/api/v1/status" || true)"
case "$STATUS" in
  *"$TARGET"* | *"${TARGET:0:7}"*) say "status reports ${TARGET:0:12}" ;;
  *) say "warning: /api/v1/status does not report ${TARGET:0:12}" ;;
esac

# ---- 5. publish static files and flip the web root ----
REL="releases/$TARGET"
rm -rf "${WWW_DIR:?}/$REL.tmp"
mkdir -p "$WWW_DIR/$REL.tmp"
cp -a "$REPO_DIR/electrical-app" "$WWW_DIR/$REL.tmp/"
if [ -d "$REPO_DIR/hq" ]; then cp -a "$REPO_DIR/hq" "$WWW_DIR/$REL.tmp/"; fi
if [ -d "$REPO_DIR/site" ]; then cp -a "$REPO_DIR/site" "$WWW_DIR/$REL.tmp/"; fi
chown -R root:root "$WWW_DIR/$REL.tmp"
chmod -R a+rX,go-w "$WWW_DIR/$REL.tmp"
rm -rf "${WWW_DIR:?}/$REL"
mv "$WWW_DIR/$REL.tmp" "$WWW_DIR/$REL"
STATIC_SWITCHED=1
flip_current "$REL"
say "web root is now $REL"

curl -fsS -m 10 -o /dev/null --resolve "$APP_HOST:443:127.0.0.1" "https://$APP_HOST/" || fail "https://$APP_HOST/ failed through nginx"
curl -fsS -m 10 -o /dev/null --resolve "$APP_HOST:443:127.0.0.1" "https://$APP_HOST/api/readyz" || fail "https://$APP_HOST/api/readyz failed through nginx"

# ---- 6. the other public hosts (warnings only) ----
trap - ERR
WARNINGS=()
warn() { say "WARNING: $*"; WARNINGS+=("$*"); }
cert_has() { openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName 2>/dev/null | grep -oE 'DNS:[^, ]+' | cut -d: -f2 | grep -qx "$1"; }
site_check() { # host path... -> 0 when every path answers 2xx through nginx
  local h="$1" p
  shift
  if ! cert_has "$h"; then warn "$h is not on the fishtape certificate yet (run issue-cert.sh); not checked"; return 1; fi
  for p in "$@"; do
    curl -fsS -m 10 -o /dev/null --resolve "$h:443:127.0.0.1" "https://$h$p" || { warn "https://$h$p failed through nginx"; return 1; }
  done
  return 0
}
# nginx: whenever the installed files differ from this release's (install-nginx.sh --check), install
# them (nginx -t, then reload; the installer restores the previous files if that fails), so the
# checks below test the new config. Deciding on what is installed, not on the git diff, means a
# failed install (a missing certificate, a server-name conflict) is retried by the next deploy.
if ! "$HERE/install-nginx.sh" --check >/dev/null 2>&1; then
  say "nginx files differ from the installed ones: installing them"
  if ! "$HERE/install-nginx.sh" > "$STATE_DIR/last-nginx-install.txt" 2>&1; then
    warn "install-nginx.sh failed, the previous nginx config is still live; see $STATE_DIR/last-nginx-install.txt"
  fi
fi
APEX_OK=0; STATUS_OK=0; HQ_OK=0
if site_check "$APEX_HOST" / /pricing /api/v1/status; then APEX_OK=1; fi
if site_check "$STATUS_HOST" / /api/v1/status /api/readyz; then STATUS_OK=1; fi
if ! getent ahosts "$HQ_HOST" >/dev/null 2>&1; then
  warn "$HQ_HOST does not resolve yet; HQ checks skipped (they run once it does: issue-cert.sh, then the next deploy)"
elif site_check "$HQ_HOST" / /api/v1/status; then
  HQ_OK=1
fi

# ---- 7. record and tidy ----
docker tag "$IMAGE_REPO:$TARGET" "$IMAGE_REPO:current" || say "warning: could not tag $IMAGE_REPO:current"
printf '%s\n' "$TARGET" > "$STATE_DIR/current-image"
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TARGET" ]; then printf '%s\n' "$PREV_TAG" > "$STATE_DIR/previous-image"; fi
if [ "${#WARNINGS[@]}" -eq 0 ]; then
  record success "deployed $TAG"
else
  record success "deployed $TAG; warnings: $(IFS=';'; printf '%s' "${WARNINGS[*]}")"
fi

{ docker image ls "$IMAGE_REPO" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 \
    | grep -vx current | tail -n +"$(( KEEP_IMAGES + 1 ))" \
    | while IFS= read -r tag; do
        if [ "$tag" != "$TARGET" ] && [ "$tag" != "$PREV_TAG" ]; then docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || true; fi
      done; } || true
{ find "$WWW_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%f\n' | sort -rn | cut -f2 \
    | tail -n +"$(( KEEP_RELEASES + 1 ))" \
    | while IFS= read -r rel; do
        if [ "releases/$rel" != "$REL" ] && [ "releases/$rel" != "$PREV_RELEASE" ]; then rm -rf "${WWW_DIR:?}/releases/$rel"; fi
      done; } || true

say "done: production is on $TAG (${TARGET:0:12}) in $(( $(date +%s) - START ))s"

# ---- 8. exposure checks ----
# Is anything sensitive served, is any header missing? Warns only (the release is live); the
# output is kept for the evidence bundle. The deploy workflow runs the same checks from outside.
EXPOSURE_OUT="$STATE_DIR/last-exposure-check.txt"
: > "$EXPOSURE_OUT"
expo_failed=""
expo() { # label base-url mode-args...
  local label="$1" base="$2" host="${2#https://}"
  shift 2
  if ! "$REPO_DIR/deploy/check-exposure.sh" "$base" "$@" --resolve "$host:443:127.0.0.1" >> "$EXPOSURE_OUT" 2>&1; then
    expo_failed="$expo_failed $label"
  fi
}
expo app "https://$APP_HOST" --production
if [ "$APEX_OK" -eq 1 ]; then expo apex "https://$APEX_HOST" --marketing; fi
if [ "$STATUS_OK" -eq 1 ]; then expo status "https://$STATUS_HOST" --status; fi
if [ "$HQ_OK" -eq 1 ]; then expo hq "https://$HQ_HOST" --hq; fi
if [ -z "$expo_failed" ]; then
  say "exposure checks passed"
else
  say "WARNING: exposure check failed for:$expo_failed; see $EXPOSURE_OUT"
fi
