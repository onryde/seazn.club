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

/** A stub runner: `stub.sh <root|web> --outputFile=… <files>`; STUB_ROOT / STUB_WEB pick what it reports. */
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
prefix=""; [ "$kind" = web ] && prefix="apps/web/"
names=()
for f in "\${files[@]}"; do names+=("$PWD/$prefix$f"); done
tests="\${#names[@]}"
case "$mode" in
  all) ;;
  drop-one) unset 'names[\${#names[@]}-1]' ;;
  zero-tests) tests=0 ;;
  zero-files) names=(); tests=0 ;;
  extra) names+=("$PWD/zq-not-in-the-manifest.test.ts") ;;
  no-report) exit 0 ;;
  fail-exit) ;;
esac
printf '%s\\n' "\${names[@]+"\${names[@]}"}" | jq -R . | jq -s --argjson t "$tests" '{numTotalTests: $t, numPassedTests: $t, numFailedTests: 0, numPendingTests: 0, testResults: map({name: .}) | map(select(.name != ""))}' > "$out"
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

const run = (dir: string, env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      CONTENT_DB_ROOT_RUNNER: "bash stub.sh root",
      CONTENT_DB_WEB_RUNNER: "bash stub.sh web",
      ...env,
    },
  });
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
    { name: "the web run collects every file but runs no test", env: { STUB_WEB: "zero-tests" }, says: "tests=0" },
    { name: "the root run collects nothing at all", env: { STUB_ROOT: "zero-files" }, says: "files_ran=0" },
    { name: "the web run reports a file the manifest does not name (a filter that matched too much)", env: { STUB_WEB: "extra" }, says: "not in the manifest" },
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
    expect(VACUOUS.length).toBe(7);
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
