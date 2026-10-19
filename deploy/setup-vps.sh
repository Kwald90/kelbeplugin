#!/usr/bin/env bash
# One-time setup of Kelbe Circuit on an Ubuntu/Debian VPS with nginx.
# Run on the VPS as root:  sudo bash setup-vps.sh you@example.com
# It only adds a new nginx site; existing sites are left alone.
set -euo pipefail

DOMAIN="tgelectrical.truecollarbuilt.com"
EMAIL="${1:?usage: setup-vps.sh <email for certificate notices>}"
REPO="https://github.com/Kwald90/kelbeplugin.git"
BRANCH="${BRANCH:-claude/electrical-concept-app-h4qz12}"
DIR="/var/www/tgelectrical"

echo "==> Checking DNS for $DOMAIN points at this server"
SERVER_IP=$(curl -fsS https://api.ipify.org || true)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
echo "    server: ${SERVER_IP:-unknown}   dns: ${DNS_IP:-none}"
if [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "!!  Add an A record: TGelectrical -> ${SERVER_IP:-<this server IP>} in the truecollarbuilt.com DNS, wait for it, then re-run."
  exit 1
fi

echo "==> Installing nginx, git and certbot"
apt-get update -qq
apt-get install -y -qq nginx git certbot python3-certbot-nginx

echo "==> Fetching the app ($BRANCH)"
if [ -d "$DIR/current/.git" ]; then
  git -C "$DIR/current" fetch -q origin "$BRANCH"
  git -C "$DIR/current" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  mkdir -p "$DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR/current"
fi
chown -R www-data:www-data "$DIR"

echo "==> Configuring nginx"
cp "$DIR/current/deploy/nginx-tgelectrical.conf" /etc/nginx/sites-available/tgelectrical
ln -sf /etc/nginx/sites-available/tgelectrical /etc/nginx/sites-enabled/tgelectrical
nginx -t
systemctl reload nginx

echo "==> HTTPS certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo "==> Done: https://$DOMAIN"
