#!/usr/bin/env bash
# Turn Postgres durability off on the job's `services: postgres` container, then
# PROVE it took. Every DB job in ci.yml calls this before `db:apply`; the four
# DB smoke jobs and smoke-e2e are database-bound (~1.3x effective parallelism),
# and the database is a throwaway one, so a crash-safe commit buys nothing.
#
# Why a step and not the service: a GitHub Actions service container cannot take
# server args (the `command:` key beside the image is not a supported service
# field), so the settings are applied with ALTER SYSTEM + pg_reload_conf().
# fsync, full_page_writes and synchronous_commit are all SIGHUP-reloadable;
# wal_level needs a restart and is deliberately left alone.
#
# Fails the step unless `SHOW fsync` reads `off` afterwards, so it cannot
# silently not apply. CI only: never run this against a database you keep.
set -euo pipefail

cid="$(docker ps -q --filter ancestor=postgres:16 | head -n1)"
if [ -z "$cid" ]; then
  echo "ci-pg-fast: no postgres:16 service container found" >&2
  exit 1
fi
psql_in() { docker exec "$cid" psql -U postgres -tA -v ON_ERROR_STOP=1 -c "$1"; }

psql_in "ALTER SYSTEM SET fsync = off" >/dev/null
psql_in "ALTER SYSTEM SET full_page_writes = off" >/dev/null
psql_in "ALTER SYSTEM SET synchronous_commit = off" >/dev/null
psql_in "SELECT pg_reload_conf()" >/dev/null

# The reload is a signal, not a call: poll a fresh session until it lands.
for _ in $(seq 1 20); do
  [ "$(psql_in 'SHOW fsync')" = "off" ] && break
  sleep 0.5
done
for s in fsync full_page_writes synchronous_commit; do
  v="$(psql_in "SHOW $s")"
  echo "ci-pg-fast: $s = $v"
  if [ "$v" != "off" ]; then
    echo "ci-pg-fast: $s did not turn off; the tuning did not apply" >&2
    exit 1
  fi
done
