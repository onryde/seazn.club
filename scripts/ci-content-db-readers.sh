#!/usr/bin/env bash
# The content readers smoke-db owns, and nothing else.
#
# ci.yml's smoke-db job runs this INSTEAD of its full suite when `changes` says the pull request is
# content-only (help and blog articles and their pictures). Those pull requests change no code, so
# the ~300 DB, Redis, Stripe and placement tests smoke-db normally runs cannot move; what can move is
# a test that READS the changed content and compares it with the database (the help-copy and
# plan-token sweeps), plus the repo-root tests that read the content or the workflow.
#
# The list is scripts/content-db-readers.json. It is not typed by hand: scripts/__tests__/ci-content-lane.test.ts
# derives it from the tree (every test file that reads help or blog content, found by behaviour, that only a
# DB job covers) and fails when the file disagrees. Regenerate it with
#   UPDATE_CONTENT_DB_MANIFEST=1 ./node_modules/.bin/vitest run scripts/__tests__/ci-content-lane.test.ts
#
# A run that tests nothing must not pass, and a SKIPPED test is not a pass: these readers gate their
# database halves on `DATABASE_URL`, so a job that lost that variable would run every file, skip every
# comparison with plan_entitlements, and report green. So the guard is part of the run, in two layers.
#   1. DATABASE_URL must be non-empty before anything starts.
#   2. For each of the two vitest invocations (repo-root files, then apps/web files) the JSON report is
#      read, file by file, and the run fails unless
#        - every file the manifest names ran (a filter that matches too little is a skipped reader),
#        - no other file did (one that matches too much means the manifest no longer says what runs),
#        - every manifest file has at least one PASSED test: a file that collected no tests, or whose
#          tests were all skipped, is dead however green its siblings are.
#      Files are matched by their exact path under this checkout, so a nested file with the same ending
#      cannot stand in for a manifest file. The counts are printed per file, not tested a second time.
# A failing test fails the step as before: the runner's exit code is kept, not replaced.
#
# What this does not catch: a file with a mix of tests, some of which skip for a reason other than the
# database (it still has a passing test). The skip counts are in the log for a reader to see.
#
# Overrides, for scripts/__tests__/ci-content-db-readers.test.ts (which stubs the runners):
#   CONTENT_DB_MANIFEST, CONTENT_DB_ROOT_RUNNER, CONTENT_DB_WEB_RUNNER, CONTENT_DB_ROOT_REPORT, CONTENT_DB_WEB_REPORT
set -euo pipefail

manifest="${CONTENT_DB_MANIFEST:-scripts/content-db-readers.json}"
root_runner="${CONTENT_DB_ROOT_RUNNER:-./node_modules/.bin/vitest run}"
web_runner="${CONTENT_DB_WEB_RUNNER:-npm test --workspace apps/web --}"
root_report="${CONTENT_DB_ROOT_REPORT:-vitest-results-content-scripts.json}"
web_report="${CONTENT_DB_WEB_REPORT:-apps/web/vitest-results-content-web.json}"
here="$(pwd -P)"

fail() {
  printf '::error::content readers: %s\n' "$*" >&2
  exit 1
}

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is empty: the readers' database halves would skip, and a skipped test is not a pass"
[ -f "$manifest" ] || fail "no manifest at $manifest"
if ! files="$(jq -r 'if (.files | type) == "array" and all(.files[]; type == "string") then .files[] else error("files is not an array of strings") end' "$manifest" 2>/dev/null)"; then
  fail "$manifest has no \"files\" array of strings"
fi
[ -n "$files" ] || fail "$manifest lists no files, and a content-only run that tests nothing is not a pass"

# Two groups: repo-root tests (scripts/…) run by the root vitest, apps/web tests by the workspace script.
# `case` and arrays, not mapfile: this also runs under macOS bash 3.2.
all=()
web=()
root=()
while IFS= read -r f; do
  [ -f "$f" ] || fail "$manifest names $f, which is not a file in this checkout"
  all+=("$f")
  case "$f" in
    apps/web/*) web+=("${f#apps/web/}") ;;
    *) root+=("$f") ;;
  esac
done <<EOF
$files
EOF
printf 'content readers: %s files (%s under apps/web, %s at the repo root)\n' "${#all[@]}" "${#web[@]}" "${#root[@]}"

# A report left from an earlier run must not satisfy the guard below.
rm -f "$root_report" "$web_report"

rc=0
if [ "${#root[@]}" -gt 0 ]; then
  # shellcheck disable=SC2086 # the runner is a command line: word splitting is the point
  $root_runner --reporter=default --reporter=json --outputFile="$here/$root_report" --testTimeout=30000 "${root[@]}" || rc=$?
fi
if [ "${#web[@]}" -gt 0 ]; then
  # shellcheck disable=SC2086
  $web_runner --reporter=default --reporter=json --outputFile="$here/$web_report" "${web[@]}" || rc=$?
fi

# verify REPORT LABEL EXPECTED_PATH... : the anti-vacuity guard.
verify() {
  local report="$1" label="$2"
  shift 2
  [ -s "$report" ] || fail "$label: no JSON report at $report, so nothing shows these tests ran"
  local want
  want="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  local verdict
  verdict="$(jq -r --argjson want "$want" --arg here "$here" '
    def stat: {
      name: (.name | ltrimstr($here + "/")),
      total: (.assertionResults | length),
      passed: ([.assertionResults[] | select(.status == "passed")] | length),
      failed: ([.assertionResults[] | select(.status == "failed")] | length),
      skipped: ([.assertionResults[] | select(.status != "passed" and .status != "failed")] | length)
    };
    [.testResults[] | stat] as $ran
    | ($ran | map(.name)) as $names
    | ($want - $names) as $missing
    | ($names - $want) as $extra
    | ($ran | map(select(.name | IN($want[])) | select(.passed == 0))) as $dead
    | "tests=\(.numTotalTests) passed=\(.numPassedTests) failed=\(.numFailedTests) pending=\(.numPendingTests) files_ran=\($names | length) files_expected=\($want | length) missing=\($missing | length) extra=\($extra | length) dead=\($dead | length)"
      + ($ran | map(select(.name | IN($want[])) | "\n  \(.name): passed=\(.passed) skipped=\(.skipped) failed=\(.failed)") | join(""))
      + (if ($missing | length) > 0 then "\n  missing: \($missing | join(", "))" else "" end)
      + (if ($extra | length) > 0 then "\n  not in the manifest: \($extra | join(", "))" else "" end)
      + ($dead | map("\n  no passing test: \(.name) (" + (if .total == 0 then "collected no tests" elif .skipped == .total then "every test skipped, so its database half did not run" else "no test passed" end) + ")") | join(""))
      + (if ($missing | length) == 0 and ($extra | length) == 0 and ($dead | length) == 0 then "\nOK" else "\nVACUOUS-OR-WRONG" end)
  ' "$report")" || fail "$label: the report at $report is not a vitest JSON report"
  printf '%s: %s\n' "$label" "$verdict"
  case "$verdict" in
    *$'\nOK') ;;
    *) fail "$label: the run did not cover exactly the manifest's files with at least one passing test in each" ;;
  esac
}

if [ "${#root[@]}" -gt 0 ]; then
  verify "$root_report" "repo-root readers" "${root[@]}"
fi
if [ "${#web[@]}" -gt 0 ]; then
  # The runner reports absolute paths under apps/web; the manifest keeps repo-relative ones.
  web_full=()
  for f in "${web[@]}"; do web_full+=("apps/web/$f"); done
  verify "$web_report" "apps/web readers" "${web_full[@]}"
fi

[ "$rc" -eq 0 ] || fail "a content reader failed (runner exit $rc)"
printf 'content readers: all %s files ran\n' "${#all[@]}"
