#!/usr/bin/env bash
# First start only: the postgres image runs this when the data volume is empty.
# Creates the fishtape_owner / fishtape_app / fishtape_hq roles and the fishtape database by
# running server/db/bootstrap.sql (mounted at /fishtape-db) as the superuser.
#
# No `set -u`: if this file is ever sourced instead of executed, the image's entrypoint
# shell would inherit it.
set -eo pipefail

if [ ! -f /fishtape-db/bootstrap.sql ]; then
  echo "fishtape: /fishtape-db/bootstrap.sql not found; is server/db/ in the checkout?" >&2
  exit 1
fi
for v in FISHTAPE_OWNER_PASSWORD FISHTAPE_APP_PASSWORD FISHTAPE_HQ_PASSWORD; do
  if [ -z "${!v}" ]; then
    echo "fishtape: $v is empty; set it in deploy/<env>/.env" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --no-psqlrc \
  --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v owner_password="$FISHTAPE_OWNER_PASSWORD" \
  -v app_password="$FISHTAPE_APP_PASSWORD" \
  -v hq_password="$FISHTAPE_HQ_PASSWORD" \
  -f /fishtape-db/bootstrap.sql

echo "fishtape: bootstrap.sql applied"

# The superuser may connect only through the container's own Unix socket (docker compose exec,
# which is what backup.sh uses). Over TCP it is rejected: on staging the published port
# 127.0.0.1:5433 is reachable by every process on the shared host. Takes effect when the
# entrypoint restarts the server after these scripts.
sed -i '1i host all postgres all reject' "$PGDATA/pg_hba.conf"
echo "fishtape: superuser login over TCP disabled"
