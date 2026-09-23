#!/usr/bin/env bash
# The realtime gate. Exits non-zero if any realtime-bearing spec fell back to
# the 15-second poll.
#
# WHY THIS EXISTS: `E2E_REQUIRE_REALTIME=1` has always been honoured
# (apps/web/e2e/realtime-propagation-kit.ts) and has never been set by
# anything — `grep -rn E2E_REQUIRE_REALTIME .github/` returns nothing, still
# true 2026-09-23. CI cannot help: all three e2e jobs build against a stub
# Supabase host (`NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co"`, three
# occurrences in e2e.yml) and all three sign with the same "CI-only dummy
# keypair (kid e2e-ci-dummy-es256)" (three occurrences). Only the first spells
# out why it can never work — "generated for this workflow, never imported
# into a real Supabase JWKS" — so that sentence appears ONCE even though the
# condition it describes holds for every job. So without this script nothing
# anywhere can tell a working channel from a 15-second poll, and a realtime
# regression reads as green.
#
# THE ONE THING EVERY HAND-ROLLED VERSION GETS WRONG: the server must be
# started with the ROOT .env.local as well. seazn-env.sh passes only
# apps/web/.env.local, which does NOT carry SUPABASE_JWT_PRIVATE_KEY, so the
# server mints HS256 and live Supabase refuses the join with
# JwtSignatureError. Measured 2026-09-22 and again 2026-09-23: same build,
# same DB, 1 failed without the root env file, 8 passed with it.
#
# THE FOUR WAYS A GATE LIES, each of which this script is built to refuse:
#
#   1. It runs nothing. A `--project` that selects zero tests exits 0 and
#      proves nothing, so every spec/project pair must select >= 1 test.
#      SELECTION IS NOT EXECUTION, though, and that door was open until fix
#      round 1: Playwright exits 0 when every test it ran was skipped at
#      runtime (`test.skip(cond)`, `test.fixme`, a `describe.skip`), so a spec
#      that skips itself under E2E_PROD_TARGET or a missing secret lists as
#      n >= 1, exits 0, and earns a PASS over zero executed assertions. A leg
#      that exits 0 having skipped anything is therefore refused too. A gate
#      whose whole job is to refuse a vacuous green does not get to keep one
#      of its own.
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
#   4. It DENIES a regression it measured. The inverse of 3, and worse: with
#      one leg failing on a flake and the other on a real refused channel, a
#      whole-run "not evidence of a realtime regression" buries the finding
#      and tells the reader to stop looking. Verdicts are therefore tracked
#      per leg, and a measured realtime failure always outranks a sibling
#      leg's unrelated one.
set -uo pipefail

# Exit codes, kept distinct on purpose — "the gate could not be run", "the gate
# ran nothing" and "the gate reds for an unrelated reason" must none of them be
# readable as either a pass or a realtime regression.
#   0  every realtime-bearing spec joined a channel and beat the poll
#   1  realtime regression: at least one pad sat on the poll
#   2  environment: no server, or no DATABASE_URL — nothing was measured
#   3  gate integrity: zero tests selected, a leg that exited 0 without
#      running everything it selected, or the spec set / clause / switch does
#      not match the tree
#   4  inconclusive: EVERY failing leg carried no realtime verdict, so whatever
#      broke, it was not measured as a realtime failure. If any leg DID carry
#      one, the run is a 1 — a measured regression is never downgraded to a 4
#      by a sibling leg's unrelated failure.

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
# for a call.
#
# It is a heuristic, not a parser, and — contrary to what this comment used to
# claim — it does NOT err uniformly toward refusing. A string or template
# literal containing `NAME(` on a non-comment line is counted as a call, so it
# errs toward ACCEPTING in that shape. No such line exists in the gated specs
# (checked), and the declared-vs-derived cross-check is what stops a miscount
# from quietly changing WHICH specs run. The other shape worth knowing: a spec
# that reaches the clause through a shared helper rather than calling it
# directly derives as "no call" and would refuse — see the doc.
clause_calls() {
  grep -aE "\b${CLAUSE}\(" "$1" 2>/dev/null \
    | grep -acvE "^[[:space:]]*(//|\*|/\*)" || true
}

# Did this leg's log carry a bucket of tests that did not execute?
#
# Read off the reporter's own summary tokens, which are emitted by
# `generateSummaryMessage` (playwright/lib/runner/index.js) as `  N skipped`
# and `  N did not run` — a separate line each, uncoloured because stdout is a
# pipe here, and printed only when the bucket is non-empty. A run in which
# EVERY test skipped prints no `N passed` line at all and exits 0.
#
# Deliberately NOT the positive form the obvious reading suggests ("N passed
# >= the N we selected"). The `passed` tally counts the whole run, including
# the `setup` project's two auth tests, while the pre-flight count excludes
# them — so for the walkthrough leg, which selects ONE test, setup alone
# supplies a passing 2 and the comparison is satisfied with the spec's only
# test skipped. A check that its own arithmetic makes vacuous is worse than no
# check, because it reads as cover.
#
# A heuristic, like `clause_calls` above, and unlike that one it errs toward
# REFUSING: a digit followed by exactly `skipped` or `did not run` anywhere in
# the log trips it. Line anchors would be more precise and would break the
# moment anything colours the output, and for this gate a false refusal is the
# cheap direction. Verified no such phrase occurs in the gated specs, the kit
# or auth.setup.ts.
leg_has_unrun_tests() {
  grep -qaE "[0-9]+ (skipped|did not run)" "$1"
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

# Existence BEFORE the cross-check, so the diagnostic matches the fault. A
# renamed or deleted spec cannot be derived either, so the cross-check below
# would also refuse it — but it would say "carries no CLAUSE() call", sending
# the reader to look for a deleted assertion inside a file that is not there.
for spec in "${SPECS[@]}"; do
  if [ ! -f "$spec" ]; then
    echo "realtime-gate: ${spec} does not exist — the gate would run nothing." >&2
    echo "  Renamed or deleted? Update SPECS. Refusing." >&2
    exit 3
  fi
done

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

# No total-is-zero check here on purpose: SPECS is non-empty by the check
# above and every spec already exits 3 at n == 0, so a total of zero is
# unreachable. A guard nothing can trip is decoration, and this script does not
# get to keep decoration while refusing it everywhere else.
echo "  ${SELECTED} realtime-bearing test(s) will run with ${SWITCH}=1"

# --- the gate itself --------------------------------------------------------
FAILED=0
NOT_REALTIME=0
REALTIME_RED=0
UNRUN=0
VERDICT_LEGS=""
SILENT_LEGS=""
UNRUN_LEGS=""
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
    # Classified PER LEG and remembered per leg. An earlier version tracked
    # only "something failed without a verdict", which let one leg's unrelated
    # failure print "this is NOT evidence of a realtime regression" over a
    # sibling leg that had measured exactly that.
    if grep -qaE "$REALTIME_VERDICT_RE" "$leg"; then
      REALTIME_RED=1
      VERDICT_LEGS="${VERDICT_LEGS} ${spec}"
      echo "realtime-gate: ${spec} failed WITH a realtime verdict." >&2
    else
      NOT_REALTIME=1
      SILENT_LEGS="${SILENT_LEGS} ${spec}"
      echo "realtime-gate: ${spec} failed carrying NO realtime verdict." >&2
      echo "  Nothing in that output came from ${CLAUSE}(), so that leg fell" >&2
      echo "  over before realtime was measured at all." >&2
    fi
  elif leg_has_unrun_tests "$leg"; then
    # Only on a leg that EXITED 0, and that restriction is the whole design.
    # A leg that FAILED routinely leaves a `did not run` bucket behind — the
    # serial project aborts its remaining tests after the first red — so
    # applying this to a failing leg would re-report a measured regression as
    # a gate-integrity fault, which is failure mode 4 wearing a new hat. A leg
    # that exits 0 while skipping is the one shape nothing else here catches.
    UNRUN=1
    UNRUN_LEGS="${UNRUN_LEGS} ${spec}"
    echo "realtime-gate: ${spec} exited 0 with test(s) that never ran." >&2
  fi
done

# Order matters, and this order is the whole point. A measured realtime
# verdict OUTRANKS a sibling leg's unrelated failure: the alternative prints
# "not evidence of a realtime regression" while another leg's log says "no
# websocket ever joined this fixture's channel", which is the one thing a gate
# must never do — deny a regression it actually measured, and tell the reader
# to stop looking.
if [ "$REALTIME_RED" -ne 0 ] && [ "$NOT_REALTIME" -ne 0 ]; then
  echo "REALTIME GATE: FAILED (MIXED) — a realtime regression WAS measured." >&2
  echo "  realtime verdict:   ${VERDICT_LEGS# }" >&2
  echo "  failed without one: ${SILENT_LEGS# }" >&2
  echo "  The regression is the finding. The other leg is a SECOND problem —" >&2
  echo "  investigate it too, but it is not a reason to discount the first." >&2
  echo "  Exit 1, not 4, deliberately." >&2
  exit 1
fi
if [ "$NOT_REALTIME" -ne 0 ]; then
  echo "REALTIME GATE: INCONCLUSIVE — every failing leg failed for a" >&2
  echo "  non-realtime reason." >&2
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
# Last, and after every failure verdict above, on purpose. `UNRUN` is only ever
# set on a leg that exited 0, so reaching here means nothing failed anywhere —
# which is exactly when a skipped test is indistinguishable from a pass unless
# something says so. Placing it above would let a skip in one leg downgrade a
# measured regression in another, which is the one thing this script's
# precedence block exists to prevent.
if [ "$UNRUN" -ne 0 ]; then
  echo "REALTIME GATE: REFUSED — a leg passed without running what it selected." >&2
  echo "  legs: ${UNRUN_LEGS# }" >&2
  echo "  Playwright exits 0 when every test it ran was skipped, so a spec" >&2
  echo "  that skips itself under E2E_PROD_TARGET or a missing secret earns a" >&2
  echo "  green over zero executed assertions. Read the leg's own summary:" >&2
  echo "  a 'skipped' or 'did not run' bucket says how many." >&2
  echo "  Either remove the skip condition or drop the spec from SPECS — a" >&2
  echo "  gated spec that does not run is not gated." >&2
  exit 3
fi
echo "REALTIME GATE: PASS — every channel joined and beat the poll (${SELECTED} tests)."
