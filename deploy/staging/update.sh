#!/usr/bin/env bash
# Deploy Fishtape to staging.
#
# Fetches the staging branch, builds the server image tagged with the commit SHA, takes a
# pre-deploy backup, runs migrations, switches the api/worker containers, waits for
# /api/readyz, and rolls back to the previous image and commit if anything fails. Every run
# appends one JSON line to /var/lib/fishtape-staging/deploy-log.jsonl (change evidence).
#
#   sudo /var/www/tgelectrical/current/deploy/staging/update.sh            newest commit on the branch
#   sudo .../update.sh --sha <commit>     a specific commit (must be on the branch)
#   sudo .../update.sh --seed             also run `npm run seed` (test tenants + TG Electrical)
#   Other options: --force (redeploy the same commit), --skip-backup, --actor <name>
#
# Until server/ exists in the repo, this only updates the static app, like deploy/update-vps.sh.
# Migrations are not rolled back: write them expand/contract so the previous release still works
# against the new schema (docs/compliance/change-management.md).
set -Eeuo pipefail
trap '' HUP   # a dropped SSH session must not kill a half-finished deploy
umask 022

ENV_NAME=staging
REPO_DIR="${REPO_DIR:-/var/www/tgelectrical/current}"
BRANCH="${BRANCH:-claude/electrical-concept-app-h4qz12}"
PUBLIC_HOST="${PUBLIC_HOST:-tgelectrical.truecollarbuilt.com}"
HERE="$REPO_DIR/deploy/staging"
STATE_DIR="/var/lib/fishtape-$ENV_NAME"
DEPLOY_LOG="$STATE_DIR/deploy-log.jsonl"
API="http://127.0.0.1:3410"
HQ_API="http://127.0.0.1:3411"
IMAGE_REPO=fishtape.invalid/server
READY_TIMEOUT="${READY_TIMEOUT:-150}"
KEEP_IMAGES="${KEEP_IMAGES:-5}"
PREDEPLOY_BACKUP="${PREDEPLOY_BACKUP:-optional}"   # required | optional | off

SHA=""
SEED=0
FORCE=0
ACTOR="${SUDO_USER:-$(id -un)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --seed) SEED=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-backup) PREDEPLOY_BACKUP=off; shift ;;
    --actor) ACTOR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$SHA" || "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--sha must be a hex commit id" >&2; exit 2; }
[[ "$ACTOR" =~ ^[A-Za-z0-9:._@/-]{1,80}$ ]] || { echo "--actor has unexpected characters" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

mkdir -p "$STATE_DIR/status"
chmod 755 "$STATE_DIR" "$STATE_DIR/status"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

git_() { git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" "$@"; }
dc() { docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" "$@"; }
say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
jesc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; s=${s//$'\r'/ }; s=${s//$'\t'/ }; printf '%s' "$s"; }

START="$(date +%s)"
PREV_SHA="$(git_ rev-parse HEAD)"
PREV_TAG="$(cat "$STATE_DIR/current-image" 2>/dev/null || true)"
TARGET=""
SERVER=0
SWITCHED=0
DRIFT=""

record() { # result message
  local now line
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  line=$(printf '{"ts":"%s","environment":"%s","result":"%s","from":"%s","fromImage":"%s","to":"%s","actor":"%s","durationSeconds":%d,"host":"%s","message":"%s"}' \
    "$now" "$ENV_NAME" "$1" "$PREV_SHA" "$PREV_TAG" "$TARGET" "$(jesc "$ACTOR")" "$(( $(date +%s) - START ))" \
    "$(hostname -s)" "$(jesc "$2")")
  printf '%s\n' "$line" >> "$DEPLOY_LOG"
  chmod 644 "$DEPLOY_LOG"
  # Same line, for the HQ developer health page (mounted read-only into the API).
  printf '%s\n' "$line" > "$STATE_DIR/status/last-deploy.json.tmp"
  chmod 644 "$STATE_DIR/status/last-deploy.json.tmp"
  mv -f "$STATE_DIR/status/last-deploy.json.tmp" "$STATE_DIR/status/last-deploy.json"
}

image_exists() { docker image inspect "$IMAGE_REPO:$1" >/dev/null 2>&1; }

# After a successful deploy: is anything sensitive served, is any header missing? Warns only
# (the release is already live); output kept for the evidence bundle.
exposure_check() {
  local args=("https://$PUBLIC_HOST" --resolve "$PUBLIC_HOST:443:127.0.0.1")
  [ "$SERVER" -eq 1 ] || args+=(--no-api)
  if "$REPO_DIR/deploy/check-exposure.sh" "${args[@]}" > "$STATE_DIR/last-exposure-check.txt" 2>&1; then
    say "exposure check passed"
  else
    say "WARNING: exposure check failed: $(tail -n 1 "$STATE_DIR/last-exposure-check.txt"); see $STATE_DIR/last-exposure-check.txt"
  fi
}

wait_ready() { # seconds
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 5 -o /dev/null "$API/api/readyz" && curl -fsS -m 5 -o /dev/null "$HQ_API/api/readyz"; then return 0; fi
    sleep 3
  done
  return 1
}

fail() { # message
  trap - ERR
  local msg="$1"
  say "FAILED: $msg"
  say "restoring commit ${PREV_SHA:0:12}"
  git_ reset -q --hard "$PREV_SHA" || true
  if [ "$SWITCHED" -eq 1 ]; then
    if [ -n "$PREV_TAG" ] && image_exists "$PREV_TAG"; then
      say "rolling containers back to ${PREV_TAG:0:12}"
      IMAGE_TAG="$PREV_TAG" dc up -d --no-build api hq-api worker || true
      if wait_ready 90; then
        record rolled_back "$msg"
        say "rolled back; staging is on ${PREV_TAG:0:12}"
      else
        record rollback_failed "$msg; the previous release did not become ready either"
        say "ROLLBACK FAILED: see docs/runbooks/rollback.md"
      fi
    else
      say "no previous image to roll back to; stopping api and worker"
      dc stop api hq-api worker || true
      record failed "$msg; no previous image, api stopped"
    fi
  else
    record failed "$msg"
  fi
  exit 1
}
trap 'fail "unexpected error at line $LINENO: $BASH_COMMAND"' ERR

# ---- 1. pick the commit ----
say "fetching origin/$BRANCH"
git_ fetch -q origin "$BRANCH" || fail "git fetch failed"
BRANCH_HEAD="$(git_ rev-parse "origin/$BRANCH")"
if [ -n "$SHA" ]; then
  TARGET="$(git_ rev-parse -q --verify "$SHA^{commit}")" || fail "commit $SHA not found"
  git_ merge-base --is-ancestor "$TARGET" "$BRANCH_HEAD" || fail "commit $SHA is not on origin/$BRANCH"
else
  TARGET="$BRANCH_HEAD"
fi
# Server-only files (secrets and root-sourced config) must never come from git: a checkout of a
# commit that tracks them would overwrite the server's copies.
TRACKED_LOCAL="$(git_ ls-tree -r --name-only "$TARGET" -- deploy/staging/.env deploy/staging/backup.conf deploy/staging/backup-recipients.txt | tr '\n' ' ')"
[ -z "$TRACKED_LOCAL" ] || fail "commit ${TARGET:0:12} tracks server-only files ($TRACKED_LOCAL); refusing to check it out"
if git_ cat-file -e "$TARGET:server/package.json" 2>/dev/null; then SERVER=1; fi

if [ "$FORCE" -eq 0 ] && [ "$TARGET" = "$PREV_SHA" ] && { [ "$SERVER" -eq 0 ] || [ "$PREV_TAG" = "$TARGET" ]; }; then
  say "already on ${TARGET:0:12}; nothing to do (--force redeploys)"
  record noop "already deployed"
  exit 0
fi

# ---- 2. check out ----
DRIFT="$(git_ status --porcelain --untracked-files=no | wc -l)"
NOTE=""
if [ "$DRIFT" -gt 0 ]; then
  say "warning: $DRIFT locally modified tracked files will be discarded"
  NOTE="; discarded $DRIFT local edits on the server"
fi
say "checking out ${TARGET:0:12} ($(git_ log -1 --format=%s "$TARGET" | cut -c1-72))"
git_ reset -q --hard "$TARGET"
# Root-owned and not writable by the web server: this tree contains scripts that run as root.
chown -R root:root "$REPO_DIR"
chmod -R go-w "$REPO_DIR"
for f in "$HERE/.env" "$HERE/backup.conf"; do
  if [ -f "$f" ]; then chown root:root "$f"; chmod 600 "$f"; fi
done

if [ "$SERVER" -eq 0 ]; then
  trap - ERR
  record success "static app only (no server/ in this commit)$NOTE"
  say "done: static app at ${TARGET:0:12}"
  exposure_check
  exit 0
fi

[ -f "$HERE/.env" ] || fail ".env is missing: run deploy/staging/init-env.sh (README step 3)"
command -v docker >/dev/null || fail "docker is not installed"

# ---- 3. build ----
say "building $IMAGE_REPO:${TARGET:0:12}"
IMAGE_TAG="$TARGET" dc build api || fail "image build failed"

# ---- 4. database up, pre-deploy backup, migrate ----
IMAGE_TAG="$TARGET" dc up -d --no-build --wait --wait-timeout 120 postgres || fail "postgres did not become healthy"
if [ "$PREDEPLOY_BACKUP" != off ]; then
  if "$HERE/backup.sh" --kind predeploy; then
    say "pre-deploy backup ok"
  elif [ "$PREDEPLOY_BACKUP" = required ]; then
    fail "pre-deploy backup failed"
  else
    say "warning: pre-deploy backup failed; continuing (staging)"
  fi
fi
say "running migrations"
IMAGE_TAG="$TARGET" dc run --rm --no-deps migrate || fail "migrations failed"
if [ "$SEED" -eq 1 ]; then
  say "seeding"
  IMAGE_TAG="$TARGET" dc run --rm --no-deps seed || fail "seed failed"
fi

# ---- 5. switch ----
SWITCHED=1
say "starting api, hq-api and worker"
IMAGE_TAG="$TARGET" dc up -d --no-build --remove-orphans api hq-api worker || fail "containers did not start"
wait_ready "$READY_TIMEOUT" || fail "/api/readyz not ready within ${READY_TIMEOUT}s"

STATUS="$(curl -fsS -m 5 "$API/api/v1/status" || true)"
case "$STATUS" in
  *"$TARGET"* | *"${TARGET:0:7}"*) say "status reports ${TARGET:0:12}" ;;
  *) say "warning: /api/v1/status does not report ${TARGET:0:12}" ;;
esac
# Through nginx too, to catch a broken vhost.
curl -fsS -m 10 -o /dev/null --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/api/healthz" \
  || say "warning: https://$PUBLIC_HOST/api/healthz failed through nginx"

# ---- 6. record ----
# The release is live from here on: nothing below may trigger a rollback.
trap - ERR
docker tag "$IMAGE_REPO:$TARGET" "$IMAGE_REPO:current" || say "warning: could not tag $IMAGE_REPO:current"
printf '%s\n' "$TARGET" > "$STATE_DIR/current-image"
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TARGET" ]; then printf '%s\n' "$PREV_TAG" > "$STATE_DIR/previous-image"; fi
if [ "$SEED" -eq 1 ]; then NOTE=" with seed$NOTE"; fi
record success "deployed$NOTE"

# Keep the newest $KEEP_IMAGES builds, and always the current and previous ones.
{ docker image ls "$IMAGE_REPO" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 \
    | grep -vx current | tail -n +"$(( KEEP_IMAGES + 1 ))" \
    | while IFS= read -r tag; do
        if [ "$tag" != "$TARGET" ] && [ "$tag" != "$PREV_TAG" ]; then docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || true; fi
      done; } || true

say "done: staging is on ${TARGET:0:12} in $(( $(date +%s) - START ))s"
exposure_check
