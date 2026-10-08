// W2a Task 0b: changed-lines Stryker. STRYKER_MUTATE="<src path>:<a>-<b>[,…]" makes stryker.config.mjs mutate exactly those
// ranges (perTest, never incremental, its own report), so an engine task mutates the lines it changed in minutes, not in a
// family leg's hours. With STRYKER_MUTATE unset the config is the one the weekly legs, their floors and fingerprints were
// measured with, for every group. No test here reads git history: CI's engine job is a shallow clone with no origin/main,
// and after the merge the merge base would be HEAD itself, comparing the file with itself (preflight C4).
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMutateRanges, rangesFromDiff, rangesFromUntracked, reportScopeProblems, snapshotForm, verdictsFromReport } from "../scripts/stryker-changed.mjs";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_EXCLUDED, STRYKER_GROUPS, STRYKER_PLACEMENT_OUT_OF_SCOPE, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(import.meta.dirname, "..");
// The group configs as they were BEFORE Task 0b's edit, written once by `node scripts/stryker-changed.mjs --snapshot` from the
// unedited config and committed. It is regenerated only as a reviewed, deliberate config change, and the commit says so.
const SNAPSHOT = JSON.parse(readFileSync(resolve(import.meta.dirname, "stryker-config-groups.snap.json"), "utf8")) as Record<string, string>;
/** A child's env: neither variable leaks in from the shell that runs the suite. */
const childEnv = (env: Record<string, string | undefined>) => ({ ...process.env, STRYKER_GROUP: undefined, STRYKER_MUTATE: undefined, ...env });

/** The config a child process sees for `env`, as Stryker loads it (a plain node process; the config reads env at import). */
function configUnder(env: Record<string, string | undefined>): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const c = (await import("./stryker.config.mjs")).default; process.stdout.write(JSON.stringify(c));`], {
    cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv(env),
  });
  if (r.status !== 0) throw new Error(r.stderr || `status ${r.status}, signal ${r.signal}`);
  return r.stdout;
}

/** Every group's config in snapshot form NOW, by the same command that wrote the committed snapshot (one child process). */
function groupConfigsNow(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "stryker-changed-"));
  try {
    const out = join(dir, "groups.json");
    const r = spawnSync(process.execPath, ["scripts/stryker-changed.mjs", "--snapshot", out], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv({}) });
    if (r.status !== 0) throw new Error(r.stderr || `status ${r.status}, signal ${r.signal}`);
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("changed-lines Stryker (W2a Task 0b)", () => {
  it("empty case first: STRYKER_MUTATE set but empty is refused, never a run that mutates nothing", () => {
    expect(() => parseMutateRanges("", ENGINE)).toThrow(/names no range/);
    expect(() => parseMutateRanges(" , ,", ENGINE)).toThrow(/names no range/);
    expect(() => configUnder({ STRYKER_MUTATE: "" })).toThrow(/names no range/);
  }, spawnBudget(1));

  it("parses ranges exactly, and refuses a missing file, a reversed range, a path outside src/ and a test file", () => {
    expect(parseMutateRanges("src/core/events.ts:10-20,src/core/types.ts:5-5", ENGINE)).toEqual(["src/core/events.ts:10-20", "src/core/types.ts:5-5"]);
    expect(() => parseMutateRanges("src/core/nope.ts:1-2", ENGINE)).toThrow(/does not exist/);
    expect(() => parseMutateRanges("src/core/events.ts:20-10", ENGINE)).toThrow(/reversed/);
    expect(() => parseMutateRanges("src/core/events.ts:0-3", ENGINE)).toThrow(/before line 1/);
    expect(() => parseMutateRanges("test/rules-reference.ts:1-2", ENGINE)).toThrow(/outside src/);
    expect(() => parseMutateRanges("src/core/events.test.ts:1-2", ENGINE)).toThrow(/test file/);
    expect(() => parseMutateRanges("src/core/events.ts", ENGINE)).toThrow(/is not <src path>:<a>-<b>/);
  });

  // Review I-1: Stryker 10 has no parser for .json ("No parser registered"), and the weekly legs never measure what
  // stryker.groups.mjs excludes, so a changed-lines run must not hand Stryker either.
  it("refuses a file Stryker cannot or must not mutate, by name: non-source, a declaration file, a __tests__ helper, and every exclusion stryker.groups.mjs declares", () => {
    let named = 0;
    for (const [entry, why] of [
      ["src/sports/setbased/badminton.golden.json:1-2", /not mutable source/],
      ["src/sports/setbased/tabletennis.schema.json:1-2", /not mutable source/],
      ["src/sports/hockey/DOMAIN.md:1-2", /not mutable source/],
      ["src/core/events.d.ts:1-2", /not mutable source/],
      ["src/sports/cricket/__tests__/scorecard-ledger.ts:1-2", /a __tests__ helper/],
    ] as const) {
      expect(() => parseMutateRanges(entry, ENGINE), entry).toThrow(why);
      named++;
    }
    expect(named).toBe(5);
    // the exclusions are read from the two maps, never typed here; a glob stands for a file inside it
    const globs = [...Object.keys(STRYKER_EXCLUDED), ...Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE)];
    let checked = 0;
    for (const g of globs) {
      const file = g.replace("**", "x.ts");
      expect(() => parseMutateRanges(`${file}:1-2`, ENGINE), g).toThrow(/excluded from mutation by stryker\.groups\.mjs/);
      checked++;
    }
    expect(checked).toBe(globs.length);
    expect(checked, "both maps contributed").toBeGreaterThan(Math.max(Object.keys(STRYKER_EXCLUDED).length, Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE).length));
    // the positive neighbours: a measured scheduling file and a sport kernel beside them are kept
    expect(parseMutateRanges("src/scheduling/bracket.ts:1-2,src/sports/setbased/kernel.ts:3-4", ENGINE)).toEqual(["src/scheduling/bracket.ts:1-2", "src/sports/setbased/kernel.ts:3-4"]);
  });

  it("with STRYKER_MUTATE the run is 'changed': exactly those ranges, not incremental, its own report — even with STRYKER_GROUP also set", () => {
    let checked = 0;
    for (const env of [{ STRYKER_MUTATE: "src/core/events.ts:10-20" }, { STRYKER_MUTATE: "src/core/events.ts:10-20", STRYKER_GROUP: "core-1" }]) {
      const c = JSON.parse(configUnder(env));
      expect(c.mutate, JSON.stringify(env)).toEqual(["src/core/events.ts:10-20"]);
      expect(c.incremental, JSON.stringify(env)).toBe(false);
      expect(c.jsonReporter, JSON.stringify(env)).toEqual({ fileName: "reports/mutation/changed.json" });
      expect(c.coverageAnalysis, JSON.stringify(env)).toBe("perTest");
      checked++;
    }
    expect(checked).toBe(2);
  }, spawnBudget(2));

  it("with STRYKER_MUTATE unset the config equals the pre-0b snapshot, for EVERY group", () => {
    const groups = Object.keys(STRYKER_GROUPS);
    // A group added or dropped since the snapshot (a recut, a new leg) is a finding, never a silent pass: a deliberate config
    // change regenerates the snapshot with `node scripts/stryker-changed.mjs --snapshot test/stryker-config-groups.snap.json`
    // and its commit says so.
    expect(Object.keys(SNAPSHOT).sort(), "the snapshot's groups are the groups").toEqual([...groups].sort());
    const now = groupConfigsNow();
    let checked = 0;
    for (const g of groups) {
      expect(now[g], `${g}: the config with STRYKER_MUTATE unset is not the snapshot's`).toBe(SNAPSHOT[g]);
      checked++;
    }
    expect(checked).toBe(groups.length);
    expect(checked).toBeGreaterThan(0);
  }, spawnBudget(1));

  it("the snapshot stands in for exactly two values (a split file's line ranges, this machine's concurrency), and only when they equal what produced them", () => {
    // sports-other-1 is boardgame.ts part 1: its `file:a-b` range moves with any edit to boardgame.ts, and the concurrency
    // follows the machine's cores and memory, so neither can be held byte-for-byte across later engine tasks and CI's runner.
    const g = "sports-other-1";
    const resolved = resolveGroup(g);
    expect(resolved.some((e) => /:\d+-\d+$/.test(e)), "the group resolves a split file to a line range").toBe(true);
    const machine = strykerConcurrency({ cores: availableParallelism(), memBytes: totalmem(), workersPerSandbox: STRYKER_VITEST_WORKERS });
    expect(JSON.stringify(snapshotForm({ testRunner: "vitest", mutate: resolved, concurrency: machine, tempDirName: ".stryker-tmp" }, g, ENGINE)))
      .toBe(JSON.stringify({ testRunner: "vitest", mutate: `<resolveGroup(${g})>`, concurrency: "<strykerConcurrency(this machine)>", tempDirName: ".stryker-tmp" }));
    // anything else is kept as it is, so the comparison with the snapshot sees it
    const other = snapshotForm({ mutate: ["src/core/events.ts:10-20"], concurrency: machine + 1 }, g, ENGINE);
    expect(other).toEqual({ mutate: ["src/core/events.ts:10-20"], concurrency: machine + 1 });
    // another group's list is not this group's
    expect(snapshotForm({ mutate: resolveGroup("core-1"), concurrency: machine }, g, ENGINE).mutate).toEqual(resolveGroup("core-1"));
    // and a config with neither key gains neither
    expect(snapshotForm({ testRunner: "vitest" }, g, ENGINE)).toEqual({ testRunner: "vitest" });
  });

  it("rangesFromUntracked: a NEW src file (untracked, so absent from git diff) is mutated whole; test files never", () => {
    expect(rangesFromUntracked([{ path: "src/core/level.ts", lines: 12 }, { path: "src/core/level.test.ts", lines: 40 }])).toEqual(["src/core/level.ts:1-12"]);
    expect(rangesFromUntracked([{ path: "src/core/empty.ts", lines: 0 }])).toEqual([]);
    expect(rangesFromUntracked([])).toEqual([]);
  });

  it("rangesFromDiff: added and changed lines of non-test src files only; a deletion-only hunk adds nothing", () => {
    const diff = [
      "diff --git a/packages/engine/src/core/events.ts b/packages/engine/src/core/events.ts",
      "+++ b/packages/engine/src/core/events.ts",
      "@@ -10,0 +11,3 @@",
      "@@ -40,2 +44 @@",
      "@@ -60,4 +63,0 @@",
      "diff --git a/packages/engine/src/core/events.test.ts b/packages/engine/src/core/events.test.ts",
      "+++ b/packages/engine/src/core/events.test.ts",
      "@@ -1,0 +2,9 @@",
      "diff --git a/packages/engine/src/core/gone.ts b/packages/engine/src/core/gone.ts",
      "+++ /dev/null",
      "@@ -1,7 +0,0 @@",
    ].join("\n");
    expect(rangesFromDiff(diff)).toEqual(["src/core/events.ts:11-13", "src/core/events.ts:44-44"]);
    // a file outside packages/engine/src after an engine one: its hunks are not the engine file's
    expect(rangesFromDiff(["+++ b/packages/engine/src/core/events.ts", "@@ -1,0 +2 @@", "+++ b/apps/web/src/a.ts", "@@ -1,0 +1,2 @@"].join("\n"))).toEqual(["src/core/events.ts:2-2"]);
    expect(rangesFromDiff("")).toEqual([]);
  });

  it("rangesFromDiff and rangesFromUntracked keep only mutable, measured source, and name every file they skip (review I-1)", () => {
    const skippedOnly = [
      "+++ b/packages/engine/src/sports/setbased/badminton.golden.json", "@@ -1,0 +1,4 @@",
      "+++ b/packages/engine/src/sports/hockey/DOMAIN.md", "@@ -3,0 +4,2 @@",
      "+++ b/packages/engine/src/testkit/golden.ts", "@@ -1,0 +1,9 @@",
      "+++ b/packages/engine/src/sports/cricket/__tests__/scorecard-ledger.ts", "@@ -5,0 +6 @@",
      "+++ b/packages/engine/src/scheduling/build.ts", "@@ -5,0 +6 @@",
      "+++ b/packages/engine/src/core/events.d.ts", "@@ -1,0 +1 @@",
    ];
    const SKIPPED = ["src/sports/setbased/badminton.golden.json", "src/sports/hockey/DOMAIN.md", "src/testkit/golden.ts", "src/sports/cricket/__tests__/scorecard-ledger.ts", "src/scheduling/build.ts", "src/core/events.d.ts"];
    // empty case first: a diff of only such files yields no range at all
    expect(rangesFromDiff(skippedOnly.join("\n"))).toEqual([]);
    // beside kept neighbours, before and after them, only the neighbours' lines survive
    const skipped: string[] = [];
    const diff = ["+++ b/packages/engine/src/core/events.ts", "@@ -10,0 +11,2 @@", ...skippedOnly, "+++ b/packages/engine/src/core/types.ts", "@@ -90,0 +91 @@"].join("\n");
    expect(rangesFromDiff(diff, (file, why) => skipped.push(`${file} | ${why}`))).toEqual(["src/core/events.ts:11-12", "src/core/types.ts:91-91"]);
    expect(skipped.map((s) => s.split(" | ")[0])).toEqual(SKIPPED);
    expect(skipped.every((s) => s.split(" | ")[1]!.length > 0), "each skip says why").toBe(true);
    // the same filter for a new untracked file
    const untrackedSkipped: string[] = [];
    expect(rangesFromUntracked([{ path: "src/testkit/new-sweep.ts", lines: 5 }, { path: "src/sports/setbased/new.golden.json", lines: 3 }, { path: "src/core/level.ts", lines: 12 }], (file) => untrackedSkipped.push(file)))
      .toEqual(["src/core/level.ts:1-12"]);
    expect(untrackedSkipped).toEqual(["src/testkit/new-sweep.ts", "src/sports/setbased/new.golden.json"]);
  });

  it("verdictsFromReport names the killers, and counts Survived and NoCoverage as failures", () => {
    const report = {
      testFiles: { "src/x.test.ts": { tests: [{ id: "1", name: "kills it" }] } },
      files: { "src/x.ts": { mutants: [
        { id: "a", mutatorName: "EqualityOperator", replacement: "<=", status: "Killed", killedBy: ["1"], location: { start: { line: 3 } } },
        { id: "b", mutatorName: "BooleanLiteral", replacement: "false", status: "Survived", location: { start: { line: 4 } } },
        { id: "c", mutatorName: "StringLiteral", replacement: '""', status: "NoCoverage", location: { start: { line: 5 } } },
        { id: "d", mutatorName: "BlockStatement", replacement: "{}", status: "Timeout", location: { start: { line: 6 } } },
      ] } },
    };
    const v = verdictsFromReport(report);
    expect(v.rows).toEqual([
      { file: "src/x.ts", line: 3, mutator: "EqualityOperator", status: "Killed", killedBy: ["kills it"] },
      { file: "src/x.ts", line: 4, mutator: "BooleanLiteral", status: "Survived", killedBy: [] },
      { file: "src/x.ts", line: 5, mutator: "StringLiteral", status: "NoCoverage", killedBy: [] },
      { file: "src/x.ts", line: 6, mutator: "BlockStatement", status: "Timeout", killedBy: [] },
    ]);
    expect(v.failures).toBe(2); // a Timeout is a detected mutant (Stryker scores it killed); Survived and NoCoverage are not
    expect(verdictsFromReport({ testFiles: {}, files: {} }).rows).toEqual([]); // and the CLI refuses an empty report
  });

  // Review I-2: Stryker writes changed.json only when a run completes and reports/ is gitignored, so a report left by an
  // EARLIER run sits there until the next one finishes. --report checks the report against the ranges this run was given.
  const mutantAt = (id: string, line: number, status = "Killed") => ({ id, mutatorName: "StringLiteral", replacement: '""', status, killedBy: status === "Killed" ? ["1"] : [], location: { start: { line } } });
  /** A Stryker report: `mutate` is the `config.mutate` the run recorded (Stryker writes its options into the report), null for none. */
  const reportOf = (files: Record<string, ReturnType<typeof mutantAt>[]>, mutate: string[] | null) => ({
    ...(mutate === null ? {} : { config: { mutate } }),
    testFiles: { "src/core/types.test.ts": { tests: [{ id: "1", name: "kills it" }] } },
    files: Object.fromEntries(Object.entries(files).map(([f, mutants]) => [f, { mutants }])),
  });

  it("reportScopeProblems: a report of exactly the expected ranges has none; another file's report, or a mutant past either end of a range, is named", () => {
    const ranges = ["src/core/types.ts:91-101"];
    expect(reportScopeProblems(reportOf({ "src/core/types.ts": [mutantAt("a", 91), mutantAt("b", 101)] }, ranges), ranges)).toEqual([]);
    // a report left by a run of another file: the run's own ranges differ, its mutant lies outside, the expected file is absent
    expect(reportScopeProblems(reportOf({ "src/core/events.ts": [mutantAt("x", 15)] }, ["src/core/events.ts:10-20"]), ranges)).toEqual([
      'the report\'s config.mutate ["src/core/events.ts:10-20"] is not the expected ["src/core/types.ts:91-101"]',
      "mutant x at src/core/events.ts:15 lies outside every expected range",
      "expected range src/core/types.ts:91-101: the report holds no entry for src/core/types.ts",
    ]);
    // the right file, the wrong lines: one below the range, one above it
    expect(reportScopeProblems(reportOf({ "src/core/types.ts": [mutantAt("lo", 90), mutantAt("in", 95), mutantAt("hi", 102)] }, ranges), ranges)).toEqual([
      "mutant lo at src/core/types.ts:90 lies outside every expected range",
      "mutant hi at src/core/types.ts:102 lies outside every expected range",
    ]);
    // the right lines of the wrong file: a line number alone does not put a mutant in scope
    expect(reportScopeProblems(reportOf({ "src/core/types.ts": [mutantAt("a", 95)], "src/core/events.ts": [mutantAt("e", 95)] }, ranges), ranges)).toEqual([
      "mutant e at src/core/events.ts:95 lies outside every expected range",
    ]);
    // two ranges: a mutant inside the second is in scope; a range whose file has an entry but no mutant is not "absent"
    const two = ["src/core/types.ts:91-101", "src/core/events.ts:10-20"];
    expect(reportScopeProblems(reportOf({ "src/core/types.ts": [mutantAt("a", 95)], "src/core/events.ts": [] }, two), two)).toEqual([]);
  });

  // Re-review N-1: an old report over a STRICT SUBSET of this run's ranges (types.ts:91-95, now 91-101) holds only in-range
  // mutants and every expected file, so the two checks above pass it. The run's own config.mutate tells the runs apart.
  it("reportScopeProblems: the report's own config.mutate must be exactly the expected ranges, and a report without one is refused", () => {
    const ranges = ["src/core/types.ts:91-101"];
    const mutants = { "src/core/types.ts": [mutantAt("a", 92), mutantAt("b", 95)] };
    expect(reportScopeProblems(reportOf(mutants, ranges), ranges)).toEqual([]); // the positive pair
    expect(reportScopeProblems(reportOf(mutants, ["src/core/types.ts:91-95"]), ranges)).toEqual([
      'the report\'s config.mutate ["src/core/types.ts:91-95"] is not the expected ["src/core/types.ts:91-101"]',
    ]);
    expect(reportScopeProblems(reportOf(mutants, null), ranges)).toEqual(["the report records no config.mutate, so the run that wrote it cannot be told"]);
  });

  it("the --report CLI requires --expect, refuses a report that is not this run's (exit 2), and judges the one that is (exit 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stryker-changed-report-"));
    try {
      const file = join(dir, "changed.json");
      writeFileSync(file, JSON.stringify(reportOf({ "src/core/types.ts": [mutantAt("a", 95)] }, ["src/core/types.ts:91-101"])));
      const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/stryker-changed.mjs", "--report", file, ...args], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv({}) });
      const bare = run();
      expect([bare.status, bare.stderr]).toEqual([2, expect.stringMatching(/--report needs --expect/)]);
      const other = run("--expect", "src/core/events.ts:10-20");
      expect([other.status, other.stderr]).toEqual([2, expect.stringMatching(/not this run's report/)]);
      // re-review N-3: an empty --expect is a named refusal (exit 2), never an uncaught throw (exit 1, the survivor code)
      const empty = run("--expect", "");
      expect([empty.status, empty.stderr]).toEqual([2, expect.stringMatching(/^--expect: STRYKER_MUTATE is set but names no range/)]);
      const mine = run("--expect", "src/core/types.ts:91-101");
      expect([mine.status, mine.stderr]).toEqual([0, ""]);
      expect(mine.stdout).toContain('{"mutants":1,"killed":1,"timeout":0,"survived":0,"noCoverage":0}');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, spawnBudget(4));

  // Re-review N-2: git's empty tree is a fixed object every git has, so diffing against it reads no history (CI's shallow clone
  // is fine) and names every file under src/ as added: megabytes of diff, past execFileSync's 1 MB default buffer.
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  it("--base against git's empty tree keeps exactly the measured source, past a 1 MB diff, and names every skipped non-source file on stderr", () => {
    // the premise, measured, so the case cannot silently stop witnessing the buffer
    const raw = spawnSync("git", ["diff", "-U0", EMPTY_TREE, "--", "src"], { cwd: ENGINE, timeout: SPAWN_MS, maxBuffer: 1024 ** 3 });
    expect(raw.status).toBe(0);
    expect(raw.stdout.length, "the diff is bigger than execFileSync's 1 MB default").toBeGreaterThan(1024 * 1024);
    const r = spawnSync(process.execPath, ["scripts/stryker-changed.mjs", "--base", EMPTY_TREE], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv({}) });
    expect(r.status, r.stderr.slice(0, 400)).toBe(0);
    // the universe stryker-groups.test.ts sweeps, less what the two maps exclude: derived here, never typed
    const universe = globSync("src/**/*.ts", { cwd: ENGINE }).filter((f) => !/__tests__|\.test\.ts$|\.d\.ts$/.test(f));
    const globs = [...Object.keys(STRYKER_EXCLUDED), ...Object.keys(STRYKER_PLACEMENT_OUT_OF_SCOPE)];
    const expected = universe.filter((f) => !globs.some((g) => matchesGlob(f, g))).sort();
    const kept = [...new Set(r.stdout.split(",").map((e) => e.replace(/:\d+-\d+$/, "")))].sort();
    expect(kept).toEqual(expected);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length, "the maps removed something").toBeLessThan(universe.length);
    // every golden/schema .json and DOMAIN.md under src/ is named as skipped, with its reason
    const nonSource = [...globSync("src/**/*.json", { cwd: ENGINE }), ...globSync("src/**/*.md", { cwd: ENGINE })];
    let named = 0;
    for (const f of nonSource) {
      expect(r.stderr, f).toContain(`skipped ${f}: not mutable source`);
      named++;
    }
    expect(named).toBe(nonSource.length);
    expect(named).toBeGreaterThan(0);
  }, spawnBudget(2));
});
