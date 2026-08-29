#!/usr/bin/env bash
#
# Runs the whole pilot architecture locally against synthetic data.
#
# No database server, no cloud account, no credentials: Postgres runs
# in-process (PGlite) and objects go to a local directory. Everything else —
# authentication, practice isolation, patient verification, audit, retention —
# is the real pilot code path, not a simulation of it.
#
#   npm run dev:pilot
#
set -euo pipefail
cd "$(dirname "$0")/.."

export AION_RUNTIME_MODE=pilot
# In-process Postgres, named explicitly in the same variable a real pilot
# uses. Config validation accepts the pglite: scheme and pilot:check flags it
# as non-durable, so this cannot be mistaken for a deployment.
export DATABASE_URL="${DATABASE_URL:-pglite:.pglite}"
export AION_OBJECT_STORE=local
export AION_OBJECT_STORE_ROOT="${AION_OBJECT_STORE_ROOT:-.objects}"
# Development-only values. Pilot config rejects anything shorter than 32 chars
# or on its placeholder list, so these are long and specific rather than "dev".
export AION_SESSION_SECRET="${AION_SESSION_SECRET:-local-development-session-secret-do-not-deploy}"
export AION_TOKEN_PEPPER="${AION_TOKEN_PEPPER:-local-development-token-pepper-do-not-deploy}"
export AION_PHOTO_RETENTION_DAYS="${AION_PHOTO_RETENTION_DAYS:-30}"
export AION_INTAKE_RETENTION_DAYS="${AION_INTAKE_RETENTION_DAYS:-90}"
echo "→ migrating"
npx tsx scripts/pilot.ts migrate

echo "→ seeding synthetic pilot data"
npx tsx scripts/pilot.ts seed --confirm

echo "→ readiness"
npx tsx scripts/pilot.ts check || true

echo "→ starting dev server in pilot mode"
exec npx next dev -p "${PORT:-3000}"
