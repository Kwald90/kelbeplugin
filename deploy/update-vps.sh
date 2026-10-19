#!/usr/bin/env bash
# Pull the latest app onto the VPS. Run on the VPS:  sudo bash /var/www/tgelectrical/current/deploy/update-vps.sh
set -euo pipefail
DIR="/var/www/tgelectrical/current"
BRANCH="${BRANCH:-$(git -C "$DIR" rev-parse --abbrev-ref HEAD)}"
git -C "$DIR" fetch -q origin "$BRANCH"
git -C "$DIR" reset -q --hard "origin/$BRANCH"
chown -R www-data:www-data "$DIR"
echo "Updated to $(git -C "$DIR" log -1 --format='%h %s')"
