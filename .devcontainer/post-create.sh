#!/usr/bin/env bash
# Runs once after the dev container is created.
set -euo pipefail
cd /workspaces/mekur

# JS dependencies (also builds packages/shared and packages/crypto).
npm ci

# Wait for PostgreSQL, then create the test database the API suite uses.
until pg_isready -q; do sleep 1; done
if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'scheduleapp_test'" | grep -q 1; then
  createdb scheduleapp_test
fi

echo "Dev container ready. Run 'claude' to start Claude Code."
