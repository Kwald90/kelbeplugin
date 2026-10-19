#!/usr/bin/env bash
# SSH forced command for the GitHub Actions production deploy key.
#
# The key can deploy a release tag (checked again by update.sh) or read the public status.
# Install (README.md, "Automatic deploys from CI"):
#   sudo install -o root -g root -m 0755 deploy-gate.sh /usr/local/sbin/fishtape-production-deploy-gate
#   /home/fishtape-deploy/.ssh/authorized_keys:
#     restrict,command="/usr/local/sbin/fishtape-production-deploy-gate" ssh-ed25519 AAAA... github-actions-production
#   /etc/sudoers.d/fishtape-production-deploy (mode 0440, check with visudo -cf):
#     fishtape-deploy ALL=(root) NOPASSWD: /srv/fishtape/repo/deploy/production/update.sh
#
# Allowed commands (from SSH_ORIGINAL_COMMAND):
#   deploy <vX.Y.Z> <40-hex commit> [github run id]
#   status
set -euo pipefail

UPDATE=/srv/fishtape/repo/deploy/production/update.sh
read -r -a ARGS <<< "${SSH_ORIGINAL_COMMAND:-}"

case "${ARGS[0]:-}" in
  deploy)
    tag="${ARGS[1]:-}"
    sha="${ARGS[2]:-}"
    run="${ARGS[3]:-}"
    [ "${#ARGS[@]}" -le 4 ] || { echo "too many arguments" >&2; exit 2; }
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "deploy needs a vX.Y.Z tag" >&2; exit 2; }
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy needs the full 40-character commit SHA" >&2; exit 2; }
    [[ -z "$run" || "$run" =~ ^[0-9]{1,20}$ ]] || { echo "run id must be numeric" >&2; exit 2; }
    logger -t fishtape-deploy-gate "production deploy requested: $tag $sha run=${run:-none} from ${SSH_CLIENT%% *}"
    exec sudo -n "$UPDATE" --tag "$tag" --sha "$sha" --actor "github-actions:${run:-manual}"
    ;;
  status)
    exec curl -fsS -m 10 http://127.0.0.1:3410/api/v1/status
    ;;
  *)
    echo "allowed: 'deploy <tag> <sha> [run-id]' or 'status'" >&2
    exit 2
    ;;
esac
