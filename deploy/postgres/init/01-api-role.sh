#!/bin/sh
# Runs once, on the first start of an empty Postgres data directory, before any migration.
# The migration later grants this role its table rights.
set -eu

psql -v ON_ERROR_STOP=1 -v pw="$ZOO_API_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE zoo_api LOGIN PASSWORD :'pw';
EOSQL
