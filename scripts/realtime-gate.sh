#!/usr/bin/env bash
# The realtime gate. Exits non-zero if any realtime-bearing spec fell back to
# the 15-second poll.
#
# WHY THIS EXISTS: `E2E_REQUIRE_REALTIME=1` has always been honoured
# (apps/web/e2e/realtime-propagation-kit.ts:73) and has never been set by
# anything — `grep -rn E2E_REQUIRE_REALTIME .github/` returns nothing, still
# true 2026-09-23. CI cannot help: it builds against a stub Supabase host
# (`NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co"`, e2e.yml) and mints
# realtime tokens with a "CI-only dummy keypair (kid e2e-ci-dummy-es256) —
# generated for this workflow, never imported into a real Supabase JWKS"
# (e2e.yml). So without this script nothing anywhere can tell a working
# channel from a 15-second poll, and a realtime regression reads as green.
#
# THE ONE THING EVERY HAND-ROLLED VERSION GETS WRONG: the server must be
# started with the ROOT .env.local as well. seazn-env.sh passes only
# apps/web/.env.local, which does NOT carry SUPABASE_JWT_PRIVATE_KEY, so the
# server mints HS256 and live Supabase refuses the join with
# JwtSignatureError. Measured 2026-09-22: same build, 1 failed without the
# root env file, 8 passed with it.
#
# THE ONE THING A GATE GETS WRONG: passing vacuously. A `--project` that
# selects zero tests, a spec that has quietly lost its
# `assertPropagatedUnderPoll` clause, or a kit that no longer reads the switch
# — each exits 0 and proves nothing, which is precisely the failure mode this
# script exists to end. So every run states, BEFORE it runs anything, how many
# tests each spec/project pair selected and that the clause and the switch are
# still there. Zero selected is exit 3, never a pass.
set -uo pipefail

# Exit codes, kept distinct on purpose — "the gate could not be run" must never
# read as "the gate passed", and neither must "the gate ran nothing".
#   0  every realtime-bearing spec joined a channel and beat the poll
#   1  realtime regression: at least one pad sat on the poll
#   2  environment: no server, or no DATABASE_URL — nothing was measured
#   3  gate integrity: a spec selected zero tests, or lost its realtime clause

# Resolved before any cd: this script is routinely invoked from a worktree
# while the caller's shell cwd has reset to the main checkout, and a relative
# path would then run the WRONG tree's specs and report a green that belongs
# to somebody else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${SCRIPT_DIR}/../apps/web"

PORT="${REALTIME_GATE_PORT:-3371}"
BASE="http://localhost:${PORT}"   # localhost, never 127.0.0.1 — the e2e suite
                                  # pins cookies to this host.

# Specs that carry a realtime CLAUSE. Listed by behaviour, not by filename
# pattern: a `-g` filter or a `*realtime*` glob selects neither of these.
SPECS=(
  "e2e/device-links.spec.ts"
  "e2e/walkthrough/console-device-live-sync.spec.ts"
)

# The assertion that separates realtime from "eventually". A propagation test
# without it passes on the 15-second poll.
CLAUSE="assertPropagatedUnderPoll"
KIT="e2e/realtime-propagation-kit.ts"
SWITCH="E2E_REQUIRE_REALTIME"

project_for() {
  case "$1" in
    e2e/walkthrough/*) echo "walkthrough" ;;
    *)                 echo "serial" ;;
  esac
}

if [ -z "${DATABASE_URL:-}" ]; then
  echo "realtime-gate: DATABASE_URL is unset." >&2
  echo "  A prod-target run needs it: the app never dev-exposes login_url, so" >&2
  echo "  the auth helpers mint login tokens straight in the DB. Export the" >&2
  echo "  database this server was started against, plus DATABASE_SSL=disable." >&2
  exit 2
fi

if ! curl -fsS -o /dev/null "${BASE}/api/health"; then
  echo "realtime-gate: no server on ${PORT}. Start one with BOTH env files:" >&2
  echo "  cd apps/web/.next/standalone/apps/web && PORT=${PORT} HOSTNAME=127.0.0.1 \\" >&2
  echo "    node --env-file=<repo>/.env.local --env-file=<repo>/apps/web/.env.local server.js" >&2
  echo "  Only apps/web/.env.local => HS256 => live Supabase refuses every join." >&2
  exit 2
fi

cd "$WEB_DIR" || exit 2

# --- pre-flight: refuse to report on a run that could not have measured -----
echo "=== realtime gate pre-flight (${BASE}) ==="

if ! grep -qa "process.env.${SWITCH}" "$KIT"; then
  echo "realtime-gate: ${KIT} no longer reads process.env.${SWITCH}." >&2
  echo "  The switch this whole gate turns is gone, so the gate can never go" >&2
  echo "  red — every run would pass on the poll. Refusing." >&2
  exit 3
fi

SELECTED=0
for spec in "${SPECS[@]}"; do
  project="$(project_for "$spec")"

  if [ ! -f "$spec" ]; then
    echo "realtime-gate: ${spec} does not exist — the gate would run nothing." >&2
    exit 3
  fi

  if ! grep -qa "${CLAUSE}" "$spec"; then
    echo "realtime-gate: ${spec} no longer calls ${CLAUSE}()." >&2
    echo "  Without that clause a propagation test passes on the 15-second poll," >&2
    echo "  so running it would prove convergence, not realtime. Refusing." >&2
    exit 3
  fi

  # Playwright prints the listing with paths relative to testDir (`e2e`).
  rel="${spec#e2e/}"
  esc="${rel//./\\.}"
  listing="$(E2E_PROD_TARGET=1 PLAYWRIGHT_BASE="$BASE" \
    npx playwright test "$spec" --project="$project" --list --reporter=list 2>&1)"
  # Count only lines belonging to BOTH this project and this spec: the listing
  # also carries the `setup` dependency's two tests, and counting Playwright's
  # own `Total:` line would let a spec that selects nothing hide behind them.
  n="$(printf '%s\n' "$listing" | grep -caE "^[[:space:]]*\[${project}\].*${esc}:[0-9]+:" || true)"

  if [ "$n" -eq 0 ]; then
    echo "realtime-gate: --project=${project} selected ZERO tests from ${spec}." >&2
    echo "  A zero-selection run exits 0 and proves nothing — that is the one" >&2
    echo "  outcome this gate must never report as a pass. Refusing." >&2
    printf '%s\n' "$listing" >&2
    exit 3
  fi

  echo "  ${spec} [${project}]: ${n} test(s) selected, ${CLAUSE}() present"
  SELECTED=$((SELECTED + n))
done
echo "  ${SELECTED} realtime-bearing test(s) will run with ${SWITCH}=1"

# --- the gate itself --------------------------------------------------------
FAILED=0
for spec in "${SPECS[@]}"; do
  project="$(project_for "$spec")"
  echo "=== ${spec} (${project}) ==="
  E2E_REQUIRE_REALTIME=1 E2E_PROD_TARGET=1 PLAYWRIGHT_BASE="$BASE" \
    npx playwright test "$spec" --project="$project" --reporter=line
  rc=$?
  if [ $rc -ne 0 ]; then
    FAILED=1
  fi
done

if [ $FAILED -ne 0 ]; then
  echo "REALTIME GATE: FAILED — at least one pad sat on the poll." >&2
  exit 1
fi
echo "REALTIME GATE: PASS — every channel joined and beat the poll (${SELECTED} tests)."
