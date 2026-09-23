#!/usr/bin/env bash
# The realtime gate. Exits non-zero if any realtime-bearing spec fell back to
# the 15-second poll.
#
# WHY THIS EXISTS: `E2E_REQUIRE_REALTIME=1` has always been honoured
# (apps/web/e2e/realtime-propagation-kit.ts) and has never been set by
# anything — `grep -rn E2E_REQUIRE_REALTIME .github/` returns nothing, still
# true 2026-09-23. CI cannot help: it builds against a stub Supabase host
# (`NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co"`, e2e.yml) and mints
# realtime tokens with a "CI-only dummy keypair (kid e2e-ci-dummy-es256) —
# generated for this workflow, never imported into a real Supabase JWKS"
# (e2e.yml, in all three e2e jobs). So without this script nothing anywhere
# can tell a working channel from a 15-second poll, and a realtime regression
# reads as green.
#
# THE ONE THING EVERY HAND-ROLLED VERSION GETS WRONG: the server must be
# started with the ROOT .env.local as well. seazn-env.sh passes only
# apps/web/.env.local, which does NOT carry SUPABASE_JWT_PRIVATE_KEY, so the
# server mints HS256 and live Supabase refuses the join with
# JwtSignatureError. Measured 2026-09-22 and again 2026-09-23: same build,
# same DB, 1 failed without the root env file, 8 passed with it.
#
# THE THREE WAYS A GATE LIES, each of which this script is built to refuse:
#
#   1. It runs nothing. A `--project` that selects zero tests exits 0 and
#      proves nothing, so every spec/project pair must select >= 1 test.
#   2. It runs tests that assert nothing about realtime. The clause is
#      `assertPropagatedUnderPoll()`; a spec that still IMPORTS the symbol, or
#      merely names it in a comment, has not kept it. Only CALL-shaped
#      occurrences count. And the spec list is cross-checked against the tree,
#      so a realtime spec nobody listed cannot sit ungated and a listed spec
#      that lost its clause cannot sit unnoticed.
#   3. It reds for something that is not realtime at all, and the verdict says
#      "sat on the poll" regardless. Measured: a server left running against a
#      since-rebuilt .next serves a page whose chunks 500, the pad never
#      mounts, every spec fails on toBeVisible() — and no realtime assertion
#      is ever reached. Each leg's output is therefore classified, and a
#      failure carrying no realtime verdict exits 4, not 1.
set -uo pipefail

# Exit codes, kept distinct on purpose — "the gate could not be run", "the gate
# ran nothing" and "the gate reds for an unrelated reason" must none of them be
# readable as either a pass or a realtime regression.
#   0  every realtime-bearing spec joined a channel and beat the poll
#   1  realtime regression: at least one pad sat on the poll
#   2  environment: no server, or no DATABASE_URL — nothing was measured
#   3  gate integrity: zero tests selected, or the spec set / clause / switch
#      does not match the tree
#   4  inconclusive: a leg failed carrying no realtime verdict, so whatever
#      broke, it was not measured as a realtime failure

# Resolved before any cd: this script is routinely invoked from a worktree
# while the caller's shell cwd has reset to the main checkout, and a relative
# path would then run the WRONG tree's specs and report a green that belongs
# to somebody else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${SCRIPT_DIR}/../apps/web"

PORT="${REALTIME_GATE_PORT:-3371}"
BASE="http://localhost:${PORT}"   # localhost, never 127.0.0.1 — the e2e suite
                                  # pins cookies to this host.

# Specs that carry a realtime clause. DECLARED here so that dropping one is a
# visible diff, and cross-checked against the tree below so that adding a
# realtime spec without listing it, or listing one that has lost its clause,
# both fail loudly. Listed by behaviour, not by filename pattern: a `-g`
# filter or a `*realtime*` glob selects neither of these.
SPECS=(
  "e2e/device-links.spec.ts"
  "e2e/walkthrough/console-device-live-sync.spec.ts"
)

# The assertion that separates realtime from "eventually". A propagation test
# without it passes on the 15-second poll.
CLAUSE="assertPropagatedUnderPoll"
KIT="e2e/realtime-propagation-kit.ts"
SWITCH="E2E_REQUIRE_REALTIME"

# The verdicts `assertPropagatedUnderPoll` can deliver. A failing leg that
# carries none of these did not fail on realtime — it fell over before the
# clause was ever reached. All four are listed, not just the two about the
# socket: "never asked the door" and "the door refused" are equally realtime
# verdicts (both leave the pad on the poll for the rest of the match), and
# omitting them would misreport a genuine regression as inconclusive.
REALTIME_VERDICT_RE='no websocket ever joined this fixture.s channel|at or above the pad.s own POLL_MS|never asked the realtime-token door|realtime-token door answered'

project_for() {
  case "$1" in
    e2e/walkthrough/*) echo "walkthrough" ;;
    *)                 echo "serial" ;;
  esac
}

# Count CALL-shaped occurrences of the clause, ignoring comment lines.
# `\bNAME(` already excludes the import (`  NAME,`) and prose that names the
# symbol in backticks — both of which a bare substring grep accepts, which is
# how a spec can keep every mention and lose every assertion. The comment
# filter additionally stops a future `// ... NAME(...)` note from standing in
# for a call. It is a heuristic, not a parser, and deliberately errs toward
# refusing.
clause_calls() {
  grep -aE "\b${CLAUSE}\(" "$1" 2>/dev/null \
    | grep -acvE "^[[:space:]]*(//|\*|/\*)" || true
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

WORK="$(mktemp -d)" || exit 2
trap 'rm -rf "$WORK"' EXIT

# --- pre-flight: refuse to report on a run that could not have measured -----
echo "=== realtime gate pre-flight (${BASE}) ==="

if ! grep -qa "process.env.${SWITCH}" "$KIT"; then
  echo "realtime-gate: ${KIT} no longer reads process.env.${SWITCH}." >&2
  echo "  The switch this whole gate turns is gone, so the gate can never go" >&2
  echo "  red — every run would pass on the poll. Refusing." >&2
  exit 3
fi

# Empty-array expansion is an "unbound variable" error under `set -u` on the
# bash 3.2 this ships with, so the count is checked before any expansion.
if [ "${#SPECS[@]}" -eq 0 ]; then
  echo "realtime-gate: SPECS is empty — the gate would run nothing and pass." >&2
  exit 3
fi

# Cross-check the declared list against the tree. Derivation alone would let a
# spec that lost its clause drop silently out of the set; a declared list alone
# lets a new realtime spec sit ungated, and lets someone comment an entry out.
# Requiring the two to AGREE closes both directions at once.
printf '%s\n' "${SPECS[@]}" | sort -u > "${WORK}/declared"
: > "${WORK}/derived"
while IFS= read -r f; do
  if [ "$(clause_calls "$f")" -gt 0 ]; then
    echo "$f" >> "${WORK}/derived"
  fi
done < <(find e2e -name '*.spec.ts' -type f | sort)
sort -u -o "${WORK}/derived" "${WORK}/derived"

missing="$(comm -23 "${WORK}/declared" "${WORK}/derived")"
extra="$(comm -13 "${WORK}/declared" "${WORK}/derived")"

if [ -n "$missing" ]; then
  echo "realtime-gate: declared spec(s) carry no ${CLAUSE}() CALL:" >&2
  printf '  %s\n' $missing >&2
  echo "  Importing the symbol, or naming it in a comment, is not keeping the" >&2
  echo "  clause — such a spec proves convergence, not realtime. Refusing." >&2
  exit 3
fi
if [ -n "$extra" ]; then
  echo "realtime-gate: spec(s) call ${CLAUSE}() but are not gated:" >&2
  printf '  %s\n' $extra >&2
  echo "  A realtime-bearing spec nobody listed is a spec nothing gates. Add" >&2
  echo "  it to SPECS (and give it a project in project_for). Refusing." >&2
  exit 3
fi

SELECTED=0
for spec in "${SPECS[@]}"; do
  project="$(project_for "$spec")"

  if [ ! -f "$spec" ]; then
    echo "realtime-gate: ${spec} does not exist — the gate would run nothing." >&2
    exit 3
  fi

  calls="$(clause_calls "$spec")"

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

  echo "  ${spec} [${project}]: ${n} test(s) selected, ${calls} ${CLAUSE}() call(s)"
  SELECTED=$((SELECTED + n))
done

if [ "$SELECTED" -eq 0 ]; then
  echo "realtime-gate: 0 tests selected in total. Refusing." >&2
  exit 3
fi
echo "  ${SELECTED} realtime-bearing test(s) will run with ${SWITCH}=1"

# --- the gate itself --------------------------------------------------------
FAILED=0
NOT_REALTIME=0
for spec in "${SPECS[@]}"; do
  project="$(project_for "$spec")"
  # `serial` specs are entangled with shared org-level state; apps/web's own
  # test:e2e runs that project with --workers=1 and so does this.
  workers=""
  if [ "$project" = "serial" ]; then
    workers="--workers=1"
  fi
  echo "=== ${spec} (${project}) ==="
  leg="${WORK}/$(echo "$spec" | tr '/.' '__').log"
  E2E_REQUIRE_REALTIME=1 E2E_PROD_TARGET=1 PLAYWRIGHT_BASE="$BASE" \
    npx playwright test "$spec" --project="$project" $workers --reporter=line 2>&1 \
    | tee "$leg"
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    FAILED=1
    if ! grep -qaE "$REALTIME_VERDICT_RE" "$leg"; then
      NOT_REALTIME=1
      echo "realtime-gate: ${spec} failed carrying NO realtime verdict." >&2
      echo "  Nothing in that output came from ${CLAUSE}(), so the run fell" >&2
      echo "  over before realtime was measured at all." >&2
    fi
  fi
done

if [ "$NOT_REALTIME" -ne 0 ]; then
  echo "REALTIME GATE: INCONCLUSIVE — a leg failed for a non-realtime reason." >&2
  echo "  This is NOT evidence of a realtime regression, and must not be read" >&2
  echo "  as one. Most likely the environment: a server left running against a" >&2
  echo "  since-rebuilt .next serves chunks that 500, the pad never mounts, and" >&2
  echo "  every spec fails on toBeVisible() without reaching a single realtime" >&2
  echo "  assertion. Compare the server's start time with the build's." >&2
  exit 4
fi
if [ "$FAILED" -ne 0 ]; then
  echo "REALTIME GATE: FAILED — at least one pad sat on the poll." >&2
  exit 1
fi
echo "REALTIME GATE: PASS — every channel joined and beat the poll (${SELECTED} tests)."
