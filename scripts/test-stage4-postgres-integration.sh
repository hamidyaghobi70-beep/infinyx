#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to the isolated CI PostgreSQL service}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_stage4_memory_audit.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f test/integration/stage4-postgres-schema.integration.sql
