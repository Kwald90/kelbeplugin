#!/bin/sh
# Runs once, when the postgres:17 container initialises an empty data directory.
# Applies server/db/bootstrap.sql exactly the way staging and production do: psql as the
# superuser with the three role passwords as psql variables.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$FISHTAPE_OWNER_PASSWORD" \
  -v app_password="$FISHTAPE_APP_PASSWORD" \
  -v hq_password="$FISHTAPE_HQ_PASSWORD" \
  -f /fishtape/bootstrap.sql
