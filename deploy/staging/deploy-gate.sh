#!/usr/bin/env bash
# SSH forced command for the GitHub Actions deploy key (staging).
#
# The CI key can do exactly two things: deploy a commit that is on the staging branch, or read
# the public status. Install (README.md, "Automatic deploys from CI"):
#   sudo install -o root -g root -m 0755 deploy-gate.sh /usr/local/sbin/fishtape-staging-deploy-gate
#   /home/fishtape-deploy/.ssh/authorized_keys:
#     restrict,command="/usr/local/sbin/fishtape-staging-deploy-gate" ssh-ed25519 AAAA... github-actions-staging
#   /etc/sudoers.d/fishtape-staging-deploy (mode 0440, check with visudo -cf):
#     fishtape-deploy ALL=(root) NOPASSWD: /var/www/tgelectrical/current/deploy/staging/update.sh
#
# Allowed commands (from SSH_ORIGINAL_COMMAND):
#   deploy <40-hex commit> [github run id]
#   status
set -euo pipefail

UPDATE=/var/www/tgelectrical/current/deploy/staging/update.sh
read -r -a ARGS <<< "${SSH_ORIGINAL_COMMAND:-}"

case "${ARGS[0]:-}" in
  deploy)
    sha="${ARGS[1]:-}"
    run="${ARGS[2]:-}"
    [ "${#ARGS[@]}" -le 3 ] || { echo "too many arguments" >&2; exit 2; }
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy needs a full 40-character commit SHA" >&2; exit 2; }
    [[ -z "$run" || "$run" =~ ^[0-9]{1,20}$ ]] || { echo "run id must be numeric" >&2; exit 2; }
    logger -t fishtape-deploy-gate "staging deploy requested: $sha run=${run:-none} from ${SSH_CLIENT%% *}"
    exec sudo -n "$UPDATE" --sha "$sha" --actor "github-actions:${run:-manual}"
    ;;
  status)
    exec curl -fsS -m 10 http://127.0.0.1:3410/api/v1/status
    ;;
  *)
    echo "allowed: 'deploy <sha> [run-id]' or 'status'" >&2
    exit 2
    ;;
esac
