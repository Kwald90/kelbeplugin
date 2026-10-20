#!/usr/bin/env bash
# Create .env next to this script from .env.example, filling every secret with a fresh random
# value. Refuses to overwrite an existing .env (rotate with docs/runbooks/rotate-secrets.md).
#   sudo ./init-env.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/.env"

if [ -e "$TARGET" ]; then
  echo "$TARGET already exists; not overwriting. To rotate secrets see docs/runbooks/rotate-secrets.md." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
tmp="$(mktemp "$HERE/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    POSTGRES_SUPERUSER_PASSWORD= | FISHTAPE_OWNER_PASSWORD= | FISHTAPE_APP_PASSWORD= | FISHTAPE_HQ_PASSWORD=)
      printf '%s%s\n' "$line" "$(openssl rand -hex 32)" ;;
    SENDGRID_INBOUND_TOKEN=)
      printf '%s%s\n' "$line" "$(openssl rand -hex 32)" ;;
    SECRETS_MASTER_KEY=)
      printf '%s%s\n' "$line" "$(openssl rand -base64 32)" ;;
    *)
      printf '%s\n' "$line" ;;
  esac
done < "$HERE/.env.example" > "$tmp"

mv "$tmp" "$TARGET"
trap - EXIT
if [ "$(id -u)" -eq 0 ]; then chown root:root "$TARGET"; fi
chmod 600 "$TARGET"

echo "Wrote $TARGET (mode 600)."
echo "Next: review PUBLIC_ORIGIN, CORS_ORIGINS and the sign-in provider keys."
echo "Copy SECRETS_MASTER_KEY into the password manager now. Without it, stored tenant secrets can't be decrypted."
