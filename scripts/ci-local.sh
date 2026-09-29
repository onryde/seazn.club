#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Run the PR-gate jobs from .github/workflows/{ci,e2e}.yml on this machine.
#
# Covers six jobs:
#   ci.yml   → smoke-db, smoke-db-usecases, smoke-e2e
#   e2e.yml  → e2e-parallel, e2e-serial, e2e-mobile
#
# `act` CANNOT run either workflow (verified 2026-08-18, act 0.2.89): both use
# `background:`/`wait:` steps and ci.yml uses `services.<id>.command`, none of
# which act's schema knows — it refuses to parse the files at all. So this
# script re-executes the steps natively instead of interpreting the YAML.
#
# Deliberate deviations from CI, all of them printed at runtime:
#   * Postgres and the placement service are native (seazn-env), not the
#     `postgres:16` / `placement-service:ci` containers. The Dockerfile itself
#     therefore stays gated only by CI. --placement-image opts into the image.
#   * GHA `background:`/`wait:` parallelism collapses to sequential.
#   * Playwright runs UNSHARDED (a superset of CI's 4 `parallel` legs — heavy
#     plus rest 1..3/3 — and its 3 mobile legs).
#   * macOS arm64, not ubuntu-latest x64 — wall-clock budget assertions differ.
#   * The server listens on a derived 33xx port, never 3000 (owner rule), and
#     is addressed as `localhost`, never 127.0.0.1 (secure cookies 401 on the
#     bare IP).
#
# The production build is cached BY ENV CLASS, not globally:
# NEXT_PUBLIC_SUPABASE_URL is baked at build time and differs between the smoke
# jobs ("") and the e2e jobs ("https://stub.supabase.co"), so one shared bundle
# cannot honestly serve both.
# ---------------------------------------------------------------------------
set -euo pipefail

SEAZN_ENV_SH="${SEAZN_ENV_SH:-$HOME/.claude/skills/seazn-local-env/scripts/seazn-env.sh}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/ci-local"
# Job bodies run in a SUBSHELL so `set -e` still bites inside them, which means
# every variable they set (label, server pid, redis pidfile) dies with the
# subshell and the parent trap tears down NOTHING. State goes through files.
RUNDIR="$STATE/run-$$"
ALL_JOBS="smoke-db smoke-db-usecases smoke-e2e e2e-parallel e2e-serial e2e-mobile"

DRY=0; KEEP=0; BAIL=0; PLACEMENT_BACKEND="--placement"; STRIPE_LIVE=1
JOBS=""

red()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
grn()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
info() { printf '\033[36m» %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { red "$*"; exit 1; }

usage() {
  cat <<EOF
usage: scripts/ci-local.sh [options] <job>... | all

jobs:   $ALL_JOBS

options:
  --dry-run            print every resolved command, run nothing
  --keep               leave the environment up after the job (debugging)
  --bail               stop at the first red job (default: run all, report at end)
  --placement-image    build+run the CI placement container instead of the venv
  --no-stripe-live     skip the live-Stripe step in smoke-db
  -h, --help           this
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --keep) KEEP=1 ;;
    --bail) BAIL=1 ;;
    --placement-image) PLACEMENT_BACKEND="--placement-image" ;;
    --no-stripe-live) STRIPE_LIVE=0 ;;
    -h|--help) usage; exit 0 ;;
    all) JOBS="$ALL_JOBS" ;;
    -*) die "unknown option $1" ;;
    *) JOBS="$JOBS $1" ;;
  esac
  shift
done
[ -n "${JOBS// /}" ] || { usage; exit 2; }

for j in $JOBS; do
  case " $ALL_JOBS " in *" $j "*) ;; *) die "unknown job '$j' (have: $ALL_JOBS)" ;; esac
done

[ -f "$SEAZN_ENV_SH" ] || die "seazn-env.sh not found at $SEAZN_ENV_SH (machine-local skill; set SEAZN_ENV_SH)"
command -v redis-server >/dev/null || warn "no redis-server — smoke-db's redis-gated step will fail"
mkdir -p "$STATE" "$RUNDIR"

# `seazn-env up` refuses the main checkout by design (a worktree has `.git` as a
# FILE). Running the gate on main is a legitimate baseline, but say so loudly:
# it tests whatever main happens to be, not your branch.
if [ -d "$REPO/.git" ]; then
  warn "running against the MAIN checkout — this gates main, not a branch"
  export SEAZN_ALLOW_MAIN=1
fi

# --- step plumbing ---------------------------------------------------------
STEP_N=0
step() { # step "<ci step name>" <cmd...>
  STEP_N=$((STEP_N + 1))
  printf '\033[35m── [%s] %s\033[0m\n' "$JOB" "$1"
  shift
  if [ "$DRY" = 1 ]; then printf '   $ %s\n' "$*"; return 0; fi
  local src=0
  "$@" || src=$?
  if [ "$src" != 0 ]; then red "step failed (exit $src): $*"; return "$src"; fi
}
nrun() { ( cd "$REPO" && "$@" ); }   # always anchored at the repo root

# --- ports -----------------------------------------------------------------
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pick_port() { # $1=start
  local p="$1" n=0
  while [ $n -lt 60 ]; do
    if port_free "$p"; then echo "$p"; return 0; fi
    p=$((p + 1)); n=$((n + 1))
  done
  die "no free port from $1"
}

# --- vitest judging --------------------------------------------------------
# `numFailedTests: 0` is NOT green: a suite that fails to COLLECT contributes
# no tests and no failures. Judge only from the JSON, and require a nonzero
# total plus every result path inside this repo.
judge_vitest() { # $1=json $2=human label
  [ "$DRY" = 1 ] && return 0
  node -e '
    const fs = require("fs");
    const [file, label, root] = process.argv.slice(1);
    if (!fs.existsSync(file)) { console.error(`::error::${label}: ${file} was never written — vitest died before reporting`); process.exit(1); }
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const total = r.numTotalTests ?? 0, failed = r.numFailedTests ?? 0, passed = r.numPassedTests ?? 0;
    const pending = r.numPendingTests ?? 0, suites = r.numTotalTestSuites ?? 0, failedSuites = r.numFailedTestSuites ?? 0;
    const foreign = (r.testResults || []).map(t => t.name).filter(n => !n.startsWith(root));
    console.log(`${label}: ${passed}/${total} passed, ${failed} failed, ${pending} pending, ${suites} suites (${failedSuites} failed)`);
    if (foreign.length) { console.error(`::error::${label}: ${foreign.length} result files outside ${root} — the run happened in the wrong tree:\n` + foreign.slice(0,5).join("\n")); process.exit(1); }
    if (total === 0) { console.error(`::error::${label}: ZERO tests collected — a collection failure, not a pass`); process.exit(1); }
    if (failed > 0 || failedSuites > 0 || r.success === false) { process.exit(1); }
  ' "$1" "$2" "$REPO"
}

# --- environment lifecycle -------------------------------------------------
LABEL=""; REDIS_PID_FILE=""; SERVER_PID=""; JOB=""

teardown() {
  local rc=$?
  set +e
  local lbl="" spid="" rpf=""
  [ -f "$RUNDIR/label" ]        && lbl=$(cat "$RUNDIR/label")
  [ -f "$RUNDIR/server.pid" ]   && spid=$(cat "$RUNDIR/server.pid")
  [ -f "$RUNDIR/redis.pidfile" ] && rpf=$(cat "$RUNDIR/redis.pidfile")

  if [ -n "$spid" ]; then kill "$spid" 2>/dev/null; fi
  if [ -n "$rpf" ] && [ -f "$rpf" ]; then kill "$(cat "$rpf")" 2>/dev/null; rm -f "$rpf"; fi
  if [ -n "$lbl" ] && [ "$KEEP" = 0 ] && [ "$DRY" = 0 ]; then
    info "tearing down $lbl"
    bash "$SEAZN_ENV_SH" down --label "$lbl" >/dev/null 2>&1
  elif [ -n "$lbl" ] && [ "$KEEP" = 1 ]; then
    warn "--keep: $lbl left UP. \`seazn-env down --label $lbl\` when done."
  fi
  rm -f "$RUNDIR/label" "$RUNDIR/server.pid" "$RUNDIR/redis.pidfile"
  return $rc
}

trap 'teardown' EXIT

env_up() { # $1=label-suffix  — fresh Postgres + placement, per job (CI services are job-scoped)
  LABEL="cil-$1"
  echo "$LABEL" > "$RUNDIR/label"
  if [ "$DRY" = 1 ]; then
    printf '   $ seazn-env up --label %s %s\n' "$LABEL" "$PLACEMENT_BACKEND"
    export DATABASE_URL="postgresql://postgres@127.0.0.1:54400/${LABEL}_db"
    export PLACEMENT_SERVICE_HOST="localhost:50100" PLACEMENT_SERVICE_SECRET="dry"
    return 0
  fi
  bash "$SEAZN_ENV_SH" down --label "$LABEL" >/dev/null 2>&1 || true
  info "seazn-env up --label $LABEL $PLACEMENT_BACKEND"
  ( cd "$REPO" && bash "$SEAZN_ENV_SH" up --label "$LABEL" "$PLACEMENT_BACKEND" )
  eval "$(bash "$SEAZN_ENV_SH" env --label "$LABEL")"
  export DATABASE_URL PLACEMENT_SERVICE_HOST PLACEMENT_SERVICE_SECRET
  [ -n "${DATABASE_URL:-}" ] || die "seazn-env env gave no DATABASE_URL"
}

# ci.yml runs its Postgres as `postgres -c timezone=Etc/GMT-14` (UTC+14 — the
# far side of the date line, which is what catches date-boundary bugs). The
# e2e.yml services deliberately do NOT, so this is called only for smoke jobs.
db_timezone_utc14() {
  [ "$DRY" = 1 ] && { echo '   $ ALTER DATABASE ... SET timezone = Etc/GMT-14'; return 0; }
  local db="${DATABASE_URL##*/}"; db="${db%%\?*}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qc "ALTER DATABASE \"$db\" SET timezone = 'Etc/GMT-14'" \
    || die "could not set the UTC+14 timezone CI's smoke Postgres runs with"
  grn "database $db pinned to Etc/GMT-14 (matches ci.yml)"
}

redis_up() {
  local port; port=$(pick_port 63790)
  REDIS_PID_FILE="$STATE/redis-$port.pid"
  echo "$REDIS_PID_FILE" > "$RUNDIR/redis.pidfile"
  if [ "$DRY" = 1 ]; then echo "   \$ redis-server --port $port"; export REDIS_URL="redis://localhost:$port"; return 0; fi
  redis-server --port "$port" --save '' --appendonly no --daemonize yes --pidfile "$REDIS_PID_FILE" --dir "$STATE"
  local n=0; until redis-cli -p "$port" ping >/dev/null 2>&1; do
    n=$((n+1)); [ $n -gt 30 ] && die "redis never answered PING on $port"; sleep 0.5
  done
  export REDIS_URL="redis://localhost:$port"
  grn "redis up on $port"
}

# --- build (cached by env class, because NEXT_PUBLIC_* is baked at build) ---
build_prod() { # $1=class (smoke|e2e)
  local class="$1"
  local marker="$REPO/apps/web/.next/.ci-local-build-class"
  local server_js="$REPO/apps/web/.next/standalone/apps/web/server.js"
  if [ "$DRY" = 1 ]; then echo "   \$ SKIP_TYPECHECK=1 npx turbo run build   # class=$class"; return 0; fi

  if [ -f "$server_js" ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$class" ]; then
    local newer
    newer=$(find "$REPO/apps/web/src" "$REPO/packages" -name '*.ts' -o -name '*.tsx' 2>/dev/null \
            | xargs -I{} sh -c 'test {} -nt '"$server_js"' && echo {}' 2>/dev/null | head -1 || true)
    if [ -z "$newer" ]; then
      warn "reusing the $class build from $(date -r "$server_js" '+%Y-%m-%d %H:%M') — no source is newer"
      return 0
    fi
    info "source newer than the bundle ($newer) — rebuilding"
  fi
  # The whole .next goes, not just standalone: a kept .next/types fails tsc on
  # pages nobody touched.
  rm -rf "$REPO/apps/web/.next"
  ( cd "$REPO" && SKIP_TYPECHECK=1 npx turbo run build )
  mkdir -p "$(dirname "$marker")"; echo "$class" > "$marker"
  grn "production build ($class class) complete"
}

# --- server ----------------------------------------------------------------
start_server() {
  local port; port=$(pick_port 3300)
  export SMOKE_BASE="http://localhost:$port" PLAYWRIGHT_BASE="http://localhost:$port"
  if [ "$DRY" = 1 ]; then echo "   \$ node .next/standalone/apps/web/server.js  # PORT=$port"; return 0; fi

  local sd="$REPO/apps/web/.next/standalone/apps/web"
  [ -f "$sd/server.js" ] || die "no standalone server.js — the build did not produce one"
  # BSD cp -R copies INTO an existing destination, so the old tree must go first.
  rm -rf "$sd/.next/static"; cp -R "$REPO/apps/web/.next/static" "$sd/.next/static"
  rm -rf "$sd/public"; cp -R "$REPO/apps/web/public" "$sd/public" 2>/dev/null || true

  local log="$STATE/server-$port.log"
  # `exec` matters: without it $! is a wrapper shell, teardown kills the wrapper
  # and the server keeps listening — a stale bundle answering the next run.
  # R5 (Task 14b): server.js is NODE_ENV=production, where an unset RELAY_DRIVERS disables streaming; the smoke and
  # e2e suites stream on the fake drivers, as CI's server steps now say explicitly. An explicit fake is refused on a
  # named deployment (ENV_NAME stg/prod), so ENV_NAME is left to the caller's shell (unset, "local" or "ci").
  ( cd "$sd" && exec env PORT="$port" HOSTNAME=127.0.0.1 RELAY_DRIVERS="${RELAY_DRIVERS:-fake}" node server.js ) > "$log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$RUNDIR/server.pid"

  local up="" i=0
  while [ $i -lt 90 ]; do
    kill -0 "$SERVER_PID" 2>/dev/null || { cat "$log"; die "server process died"; }
    if curl -sf "http://localhost:$port/api/health" >/dev/null 2>&1; then up=1; break; fi
    i=$((i+1)); sleep 1
  done
  [ -n "$up" ] || { cat "$log"; die "server never became healthy on $port"; }

  # 200 on the HTML proves a server, not OUR assets: a missing static copy still
  # renders. Demand a real chunk.
  local chunk asset
  chunk=$(ls "$REPO"/apps/web/.next/static/chunks/*.js 2>/dev/null | head -1)
  [ -n "$chunk" ] || die "no built chunks — build output is not where expected"
  asset="/_next/${chunk#"$REPO"/apps/web/.next/}"
  curl -sf "http://localhost:$port$asset" >/dev/null || { cat "$log"; die "static asset $asset 404s — standalone tree not staged"; }
  grn "server up on http://localhost:$port (assets serve: $asset)"
}

# --- shared job env --------------------------------------------------------
common_env() {
  export DATABASE_SSL=disable
  export AUTH_SECRET=ci-only-insecure-secret-please-change-in-prod-0123456789
  # CI's throwaway device-link envelope key (scorer sheets §4.1), the same value as the workflows. Never a real key:
  # the standalone server never reads .env.local, so without this every mint in a local run fails closed.
  export DEVICE_LINK_KEK=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0
  export NEXT_TELEMETRY_DISABLED=1
  export SCHEDULING_AI_BASE_URL="http://127.0.0.1:4319"
}
smoke_env() {
  common_env
  # `scripts/smoke.ts` signs in by reading `login_url` off the magic-link
  # response, and the standalone server it drives runs as NODE_ENV=production.
  # Production no longer exposes that link on a failed send (it used to, which
  # meant a Resend outage handed out sign-in links), so a production-mode
  # harness has to opt in explicitly. `e2e_env` does NOT set this: those jobs
  # mint login tokens straight in the DB via E2E_PROD_TARGET.
  export AUTH_DEV_LINKS=1
  export NEXT_PUBLIC_SUPABASE_URL=""
  export AI_FIXTURE_PORT=4319
  export ANTHROPIC_API_KEY=sk-ant-ci-smoke-fixture
  export STRIPE_WEBHOOK_SECRET=whsec_ci_smoke
  # CI takes this from a secret. Locally it lives in .env.local — read, never echoed.
  if [ -z "${STRIPE_SECRET_KEY:-}" ] && [ -f "$REPO/apps/web/.env.local" ]; then
    STRIPE_SECRET_KEY=$(grep -aE '^STRIPE_SECRET_KEY=' "$REPO/apps/web/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
    export STRIPE_SECRET_KEY
  fi
}
e2e_env() {
  common_env
  export NEXT_PUBLIC_SUPABASE_URL="https://stub.supabase.co"
  export E2E_PROD_TARGET=1
  export STRIPE_SECRET_KEY=sk_test_ci_e2e_dummy
  export STRIPE_WEBHOOK_SECRET=whsec_e2e_payments
  export ANTHROPIC_API_KEY=sk-ant-e2e-fixture
  # e2e.yml's e2e-parallel job sets this for sitemap.spec.ts (server AND runner).
  export SITEMAP_REVALIDATE_SECONDS=20
}

# ===========================================================================
# jobs
# ===========================================================================
job_smoke_db() {
  smoke_env
  export USECASES_EXCLUDE="**/server/usecases/__tests__/[i-z]*"
  env_up smoke-db
  db_timezone_utc14
  redis_up

  step "Bootstrap database (Flyway migrate)" nrun npm run db:apply
  step "Flyway migration history"            nrun npm run db:info
  step "RLS guard"                           nrun npm run check:rls
  step "Sync sport catalog"                  nrun npm run sync:sports

  step "Repo-root scripts tests (real Postgres)" \
    nrun ./packages/engine/node_modules/.bin/vitest run --reporter=default \
      --reporter=json --outputFile=vitest-results-scripts.json --testTimeout=30000 scripts/__tests__
  judge_vitest "$REPO/vitest-results-scripts.json" "scripts/__tests__"

  step "Engine-db + service-layer + lib integration tests" \
    nrun npm test --workspace apps/web -- --reporter=default --reporter=json \
      --outputFile=vitest-results-lib-server.json --exclude "$USECASES_EXCLUDE" src/server src/lib
  judge_vitest "$REPO/apps/web/vitest-results-lib-server.json" "src/server + src/lib"

  step "Vitest collection reconciliation" \
    nrun node --experimental-strip-types scripts/check-vitest-collection.ts \
      --results apps/web/vitest-results-lib-server.json --exclude "$USECASES_EXCLUDE" -- src/server src/lib

  step "Redis-gated integration tests" \
    nrun npm test --workspace apps/web -- run \
      src/lib/__tests__/rate-limit.redis.test.ts \
      src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts \
      src/lib/__tests__/platform-fee-cache-isolation.redis.test.ts

  if [ "$STRIPE_LIVE" = 1 ] && [ -n "${STRIPE_SECRET_KEY:-}" ]; then
    step "Sync Stripe products/prices" nrun npm run stripe:sync
    step "Live-Stripe integration tests (sk_test)" \
      env BILLING_LIVE=1 sh -c "cd '$REPO' && npm test --workspace apps/web -- src/lib/__tests__/billing-tiers.live.test.ts src/lib/__tests__/billing-proration.live.test.ts"
  else
    warn "live-Stripe step skipped (no STRIPE_SECRET_KEY, or --no-stripe-live) — CI runs it"
  fi
}

job_smoke_db_usecases() {
  smoke_env
  export USECASES_EXCLUDE="**/server/usecases/__tests__/[a-h]*"
  env_up smoke-uc
  db_timezone_utc14

  step "Bootstrap database (Flyway migrate)" nrun npm run db:apply
  step "Sync sport catalog"                  nrun npm run sync:sports

  step "usecases [i-z] integration tests" \
    nrun npm test --workspace apps/web -- --reporter=default --reporter=json \
      --outputFile=vitest-results-usecases.json --exclude "$USECASES_EXCLUDE" src/server/usecases
  judge_vitest "$REPO/apps/web/vitest-results-usecases.json" "src/server/usecases [i-z]"

  step "Assert the solver-dependent telemetry tests actually ran" assert_solver_telemetry

  step "DB-gated suites outside src/server|lib|app" \
    nrun npm test --workspace apps/web -- --reporter=default --reporter=json \
      --outputFile=vitest-results-outliers.json \
      src/components/__tests__/upgrade-gate-pass-features.test.ts \
      src/demo/ai-templates/__capture__/__tests__/seeds.test.ts \
      src/demo/ai-templates/__capture__/capture.test.ts
  judge_vitest "$REPO/apps/web/vitest-results-outliers.json" "DB-gated outliers"

  step "Service-layer integration tests outside src/server" \
    nrun npm test --workspace apps/web -- --reporter=default --reporter=json \
      --outputFile=vitest-results-app.json src/app
  judge_vitest "$REPO/apps/web/vitest-results-app.json" "src/app"
}

# Verbatim from ci.yml. A SKIP in these four means the placement service was
# never reached — silent coverage loss, not an optional test.
assert_solver_telemetry() {
  [ "$DRY" = 1 ] && return 0
  ( cd "$REPO" && node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync("apps/web/vitest-results-usecases.json", "utf8"));
    const f = (r.testResults || []).find(t => t.name.includes("schedule-solver-telemetry.test.ts"));
    if (!f) { console.error("::error::schedule-solver-telemetry.test.ts did not run at all."); process.exit(1); }
    const all = f.assertionResults || [];
    const mustPass = all.filter(a =>
      /already_optimal|without booting the z3 WASM|polish never moves|infeasible proof/.test(a.fullName));
    const notPassed = mustPass.filter(a => a.status !== "passed");
    console.log(`solver-gated telemetry tests: ${mustPass.length} found, ${mustPass.filter(a => a.status === "passed").length} passed`);
    if (mustPass.length < 4) { console.error(`::error::expected 4 solver-gated telemetry tests, found ${mustPass.length}`); process.exit(1); }
    if (notPassed.length) { console.error("::error::gated tests did not pass: " + notPassed.map(a => `${a.fullName} [${a.status}]`).join("; ")); process.exit(1); }
  ' )
}

job_smoke_e2e() {
  smoke_env
  env_up smoke-e2e
  db_timezone_utc14

  step "Build (production)"                  build_prod smoke
  step "Bootstrap database (Flyway migrate)" nrun npm run db:apply
  step "RLS guard"                           nrun npm run check:rls
  step "Sync sport catalog"                  nrun npm run sync:sports
  if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
    step "Sync Stripe products/prices" nrun npm run stripe:sync
  fi
  step "Start server"                        start_server
  step "Run smoke test"                      nrun npm run test:smoke
}

e2e_job() { # $1=label-suffix  $2...=playwright args
  local suffix="$1"; shift
  e2e_env
  env_up "$suffix"
  step "Bootstrap database (Flyway migrate)" nrun npm run db:apply
  step "Sync sport catalog"                  nrun npm run sync:sports
  step "Build (production)"                  build_prod e2e
  step "Install Playwright Chromium" \
    sh -c "cd '$REPO/apps/web' && npx playwright install chromium"
  step "Start server"                        start_server
  step "Run Playwright e2e ($*)" \
    sh -c "cd '$REPO/apps/web' && npx playwright test $*"
}

# CI runs this as a "heavy" leg plus a "rest" slice sharded 1..3/3
# (E2E_PARALLEL_SLICE); locally we run the whole project (a superset).
job_e2e_parallel() { e2e_job e2e-par "--project=parallel"; }
job_e2e_serial()   { e2e_job e2e-ser "--project=serial --workers=1"; }
# CI splits the seven widths across three legs; locally they run in one pass,
# still --workers=1 (the widths race over one org otherwise).
job_e2e_mobile()   {
  e2e_job e2e-mob "--project=mobile-320 --project=mobile-360 --project=mobile-se \
--project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834 --workers=1"
}

# ===========================================================================
RESULTS=""
START_ALL=$(date +%s)
for JOB in $JOBS; do
  printf '\n\033[1m══ %s ══\033[0m\n' "$JOB"
  t0=$(date +%s); rc=0
  # NEVER write `( job ) || rc=$?`: a subshell on the left of `||` has errexit
  # SUPPRESSED for everything inside it, so a failing step midway through the
  # job is ignored and only the LAST step decides the result. Verified
  # 2026-08-18 — an injected `false` as step 1 still reported the job green
  # after running all 960s of it. Disarm errexit around the call instead, and
  # re-arm it explicitly inside the subshell.
  set +e
  case "$JOB" in
    smoke-db)           ( set -e; job_smoke_db ) ;;
    smoke-db-usecases)  ( set -e; job_smoke_db_usecases ) ;;
    smoke-e2e)          ( set -e; job_smoke_e2e ) ;;
    e2e-parallel)       ( set -e; job_e2e_parallel ) ;;
    e2e-serial)         ( set -e; job_e2e_serial ) ;;
    e2e-mobile)         ( set -e; job_e2e_mobile ) ;;
  esac
  rc=$?
  set -e
  teardown || true
  dt=$(( $(date +%s) - t0 ))
  if [ "$rc" = 0 ]; then grn "$JOB passed (${dt}s)"; RESULTS="$RESULTS\n  ✓ $JOB  ${dt}s"
  else red "$JOB FAILED rc=$rc (${dt}s)"; RESULTS="$RESULTS\n  ✗ $JOB  rc=$rc  ${dt}s"
       [ "$BAIL" = 1 ] && break || true
  fi
done

printf '\n\033[1m══ summary (%ss total) ══\033[0m' "$(( $(date +%s) - START_ALL ))"
printf "$RESULTS\n"
rmdir "$RUNDIR" 2>/dev/null || true
case "$RESULTS" in *"✗"*) exit 1 ;; esac
exit 0
