// scripts/ci-content-db-readers.sh is what smoke-db runs on a content-only pull request INSTEAD of its suite. Its one job
// beyond running the manifest's files is to refuse a run that proves nothing: zero files, zero tests, a file the manifest names
// that did not run, or a file it does not name that did. This drives the real script with stub runners that write the
// vitest JSON report in each of those shapes, in a scratch checkout, and reads the verdict from the exit status.
//
// The real runners (vitest itself) are not started here: ci-content-lane.test.ts proves WHICH files the manifest names, and
// CI is the arbiter of the vitest runs. What this file proves is that the guard around them cannot be satisfied by an empty run.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const SCRIPT = join(REPO, "scripts/ci-content-db-readers.sh");
const TEST_FILES = ["apps/web/src/lib/__tests__/zq-a.test.ts", "apps/web/src/server/__tests__/zq-b.test.ts", "scripts/__tests__/zq-c.test.ts"];

/**
 * A stub runner: `stub.sh <root|web> --outputFile=… <files>`; STUB_ROOT / STUB_WEB pick what it reports. Each file reports two
 * passed tests unless the mode says otherwise, in the shape of vitest's JSON report (per-file `assertionResults`).
 */
const STUB = `#!/usr/bin/env bash
kind="$1"; shift
out=""; files=()
for a in "$@"; do
  case "$a" in
    --outputFile=*) out="\${a#--outputFile=}" ;;
    --*) ;;
    *) files+=("$a") ;;
  esac
done
echo "$kind" >> "$PWD/stub-calls.log"
var="STUB_$(echo "$kind" | tr a-z A-Z)"
mode="\${!var:-all}"
[ "$mode" = no-report ] && exit 0
prefix=""; [ "$kind" = web ] && prefix="apps/web/"
names=()
for f in "\${files[@]}"; do names+=("$PWD/$prefix$f"); done
[ "$mode" = zero-files ] && names=()
[ "$mode" = drop-one ] && names=("\${names[@]:0:$((\${#names[@]} - 1))}")
rows=()
n=\${#names[@]}
for i in "\${!names[@]}"; do
  nm="\${names[$i]}"; st="passed,passed"
  if [ "$i" -eq $((n - 1)) ]; then
    case "$mode" in
      pending-one) st="pending,pending" ;;
      empty-one) st="" ;;
      failed-one) st="failed,failed" ;;
      partial-pending) st="passed,pending" ;;
      nested) nm="$PWD/vendor/\${nm#$PWD/}" ;;
    esac
  fi
  [ "$mode" = zero-tests ] && st=""
  rows+=("$nm|$st")
done
[ "$mode" = extra ] && rows+=("$PWD/zq-not-in-the-manifest.test.ts|passed,passed")
printf '%s\\n' "\${rows[@]+"\${rows[@]}"}" | jq -R -s '
  split("\\n") | map(select(length > 0) | split("|") | {name: .[0], st: ((.[1] // "") | split(",") | map(select(length > 0)))})
  | {
      numTotalTests: ([.[].st | length] | add // 0),
      numPassedTests: ([.[].st[] | select(. == "passed")] | length),
      numFailedTests: ([.[].st[] | select(. == "failed")] | length),
      numPendingTests: ([.[].st[] | select(. == "pending")] | length),
      testResults: map({name: .name, status: "passed", assertionResults: (.st | map({status: .}))})
    }' > "$out"
[ "$mode" = fail-exit ] && exit 1
exit 0
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch checkout: the manifest's files exist (empty), and the stub is the only runner. */
const checkout = (manifestFiles: string[] | null): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "content-readers-")));
  dirs.push(dir);
  for (const f of TEST_FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  mkdirSync(join(dir, "scripts"), { recursive: true });
  if (manifestFiles) writeFileSync(join(dir, "scripts/content-db-readers.json"), JSON.stringify({ files: manifestFiles }));
  writeFileSync(join(dir, "stub.sh"), STUB);
  chmodSync(join(dir, "stub.sh"), 0o755);
  return dir;
};

/** The step's own environment: DATABASE_URL is set job-wide in ci.yml, so it is set here unless a test takes it away. */
const run = (dir: string, env: Record<string, string> = {}, without: string[] = []) => {
  const full: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    DATABASE_URL: "postgresql://stub:stub@localhost:5432/stub",
    CONTENT_DB_ROOT_RUNNER: "bash stub.sh root",
    CONTENT_DB_WEB_RUNNER: "bash stub.sh web",
    ...env,
  };
  for (const k of without) delete full[k];
  return spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: full });
};
const out = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

describe("scripts/ci-content-db-readers.sh", () => {
  it("passes when every file the manifest names ran, in both groups, and says how many", () => {
    const r = run(checkout(TEST_FILES));
    expect(out(r)).toContain("3 files (2 under apps/web, 1 at the repo root)");
    expect(out(r)).toContain("all 3 files ran");
    expect(r.status).toBe(0);
  });

  it("calls the root runner once and the web runner once, each with only its own files", () => {
    const dir = checkout(TEST_FILES);
    const r = run(dir);
    expect(r.status, out(r)).toBe(0);
    expect(readFileSync(join(dir, "stub-calls.log"), "utf8").trim().split("\n").sort()).toEqual(["root", "web"]);
    // The web runner is handed paths relative to apps/web, as `npm test --workspace apps/web` wants them.
    const web = JSON.parse(readFileSync(join(dir, "apps/web/vitest-results-content-web.json"), "utf8")) as { testResults: { name: string }[] };
    expect(web.testResults.map((t) => t.name.replace(`${dir}/`, "")).sort()).toEqual(["apps/web/src/lib/__tests__/zq-a.test.ts", "apps/web/src/server/__tests__/zq-b.test.ts"]);
  });

  // Every way a run can prove nothing, each of which must fail the step. The count is part of the test: a list that shrinks is a defect.
  const VACUOUS: { name: string; env: Record<string, string>; says: string }[] = [
    { name: "the web runner skips one of its files", env: { STUB_WEB: "drop-one" }, says: "missing: apps/web/src/server/__tests__/zq-b.test.ts" },
    { name: "the root runner skips its file", env: { STUB_ROOT: "drop-one" }, says: "missing: scripts/__tests__/zq-c.test.ts" },
    { name: "the web run collects every file but runs no test", env: { STUB_WEB: "zero-tests" }, says: "no passing test: apps/web/src/lib/__tests__/zq-a.test.ts (collected no tests)" },
    { name: "the root run collects nothing at all", env: { STUB_ROOT: "zero-files" }, says: "files_ran=0" },
    { name: "the web run reports a file the manifest does not name (a filter that matched too much)", env: { STUB_WEB: "extra" }, says: "not in the manifest" },
    { name: "one web file collects no tests while its sibling passes", env: { STUB_WEB: "empty-one" }, says: "no passing test: apps/web/src/server/__tests__/zq-b.test.ts (collected no tests)" },
    { name: "every test of one web file is skipped (its database half did not run) while its sibling passes", env: { STUB_WEB: "pending-one" }, says: "no passing test: apps/web/src/server/__tests__/zq-b.test.ts (every test skipped" },
    { name: "the only root file is skipped end to end", env: { STUB_ROOT: "pending-one" }, says: "no passing test: scripts/__tests__/zq-c.test.ts (every test skipped" },
    { name: "one web file has tests but none passes", env: { STUB_WEB: "failed-one" }, says: "(no test passed)" },
    { name: "a nested file with the same ending stands in for the manifest's file", env: { STUB_WEB: "nested" }, says: "missing: apps/web/src/server/__tests__/zq-b.test.ts" },
    { name: "the root runner writes no report", env: { STUB_ROOT: "no-report" }, says: "no JSON report" },
    { name: "a test fails, so the runner exits 1 with a complete report", env: { STUB_WEB: "fail-exit" }, says: "runner exit 1" },
  ];
  for (const c of VACUOUS) {
    it(`fails when ${c.name}`, () => {
      const r = run(checkout(TEST_FILES), c.env);
      expect(r.status, out(r)).toBe(1);
      expect(out(r)).toContain(c.says);
      expect(out(r)).not.toContain("all 3 files ran");
    });
  }

  it("covers the vacuous shapes it claims to (anti-vacuity)", () => {
    expect(VACUOUS.length).toBe(12);
  });

  it("refuses to start when DATABASE_URL is unset or empty, because a skipped database half is not a pass", () => {
    const cases: { name: string; r: ReturnType<typeof run>; dir: string }[] = [];
    const a = checkout(TEST_FILES);
    cases.push({ name: "unset", r: run(a, {}, ["DATABASE_URL"]), dir: a });
    const b = checkout(TEST_FILES);
    cases.push({ name: "empty", r: run(b, { DATABASE_URL: "" }), dir: b });
    for (const c of cases) {
      expect(c.r.status, `${c.name}: ${out(c.r)}`).toBe(1);
      expect(out(c.r), c.name).toContain("DATABASE_URL is empty");
      expect(existsSync(join(c.dir, "stub-calls.log")), `${c.name}: no runner started`).toBe(false);
    }
    expect(cases.length).toBe(2);
    // The same checkout passes once the variable is there: the one difference between the two runs is the variable.
    expect(run(checkout(TEST_FILES)).status).toBe(0);
  });

  it("does not reject a file for skipping some of its tests, only for passing none of them", () => {
    // A file whose database half runs and whose env-gated half skips is normal; the guard is `passed > 0`, per file.
    const dir = checkout(TEST_FILES);
    const r = run(dir, { STUB_WEB: "partial-pending" });
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toContain("apps/web/src/server/__tests__/zq-b.test.ts: passed=1 skipped=1 failed=0");
  });

  it("does not take a report left by an earlier run for this one's", () => {
    const dir = checkout(TEST_FILES);
    // A complete, passing report is already on disk; the runner then writes nothing.
    expect(run(dir).status).toBe(0);
    expect(existsSync(join(dir, "vitest-results-content-scripts.json"))).toBe(true);
    const r = run(dir, { STUB_ROOT: "no-report" });
    expect(r.status, out(r)).toBe(1);
    expect(out(r)).toContain("no JSON report");
  });

  it("refuses an empty manifest, a missing one, a malformed one and a file that is not there, without starting a runner", () => {
    const cases: { name: string; dir: string; says: string }[] = [
      { name: "empty", dir: checkout([]), says: "lists no files" },
      { name: "missing", dir: checkout(null), says: "no manifest" },
      { name: "names a file that is gone", dir: checkout([...TEST_FILES, "scripts/__tests__/zq-gone.test.ts"]), says: "is not a file in this checkout" },
    ];
    const malformed = checkout(TEST_FILES);
    writeFileSync(join(malformed, "scripts/content-db-readers.json"), JSON.stringify({ files: "scripts/__tests__/zq-c.test.ts" }));
    cases.push({ name: "files is a string", dir: malformed, says: 'no "files" array of strings' });
    for (const c of cases) {
      const r = run(c.dir);
      expect(r.status, `${c.name}: ${out(r)}`).toBe(1);
      expect(out(r), c.name).toContain(c.says);
      expect(existsSync(join(c.dir, "stub-calls.log")), `${c.name}: no runner started`).toBe(false);
    }
    expect(cases.length).toBe(4);
  });

  it("runs only the group a manifest has files for", () => {
    const dir = checkout(["scripts/__tests__/zq-c.test.ts"]);
    const r = run(dir);
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toContain("1 files (0 under apps/web, 1 at the repo root)");
    expect(readFileSync(join(dir, "stub-calls.log"), "utf8").trim()).toBe("root");
  });

  it("runs the same commands smoke-db's full steps do, by default", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    // The root files go through the root vitest binary with the full suite's 30 s timeout; the web files through the workspace script.
    expect(script).toContain('root_runner="${CONTENT_DB_ROOT_RUNNER:-./node_modules/.bin/vitest run}"');
    expect(script).toContain("--testTimeout=30000");
    expect(script).toContain('web_runner="${CONTENT_DB_WEB_RUNNER:-npm test --workspace apps/web --}"');
    expect(ci).toContain("run: ./node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-scripts.json --testTimeout=30000");
    expect(ci).toContain("run: npm test --workspace apps/web -- --reporter=default --reporter=json --outputFile=vitest-results-lib-server.json");
    // Their reports match the upload step's globs, so a red run's timings are kept.
    expect(script).toContain("vitest-results-content-scripts.json");
    expect(script).toContain("apps/web/vitest-results-content-web.json");
  });
});
